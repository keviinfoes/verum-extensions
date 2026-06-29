import { parseWeb3URL } from './lib/url-parser.js'
import { RpcClient, createVerifiedRpc } from './lib/light-client.js'
import { getVerifiedCalldata, getVerifiedCalldataByLocation, verifyTxInBlock } from './lib/tx-verifier.js'
import type { RpcBlockFull } from './lib/tx-verifier.js'
import { getCalldataViaPortal } from './lib/portal.js'
import { parseCalldata, assembleContent, BUNDLE_CONTENT_TYPE, parseBundle, bundleFileAt, rewriteHtmlResources } from './lib/content.js'
import { resolveEns } from './lib/ens-resolver.js'
import type { TxRef } from './lib/ens-resolver.js'
import { verifyViaBeacon, isEip2935Error } from './lib/beacon-verifier.js'
import { DEFAULT_CHAINS } from './types.js'
import type { BgMessage, BgResponse, VerificationUpdate, ChainConfig } from './types.js'
import { listWallets, ethRequest as walletRequest } from './lib/metamask-bridge.js'
import { isFrameAvailable, frameRequest } from './lib/frame-bridge.js'
import type { IVerifiedRpc } from './lib/light-client.js'

const rpcCache = new Map<number, Promise<IVerifiedRpc>>()
const tabVerGen = new Map<number, number>()

function getOrCreateRpc(chain: ChainConfig): Promise<IVerifiedRpc> {
  if (!rpcCache.has(chain.chainId)) {
    rpcCache.set(chain.chainId, createVerifiedRpc(chain))
  }
  return rpcCache.get(chain.chainId)!
}

function rendererFor(web3Url: string): string {
  return chrome.runtime.getURL('renderer.html') + '#' + web3Url
}

// Returns true if Helios confirms the same chunks as phase 1, false if it resolves
// to definitively different non-empty chunks (forged), undefined if Helios couldn't
// resolve (error or empty result — unverified, not forged).
function compareEnsChunks(heliosChunks: TxRef[], phase1Chunks: TxRef[]): boolean | undefined {
  if (heliosChunks.length === 0) return undefined
  return heliosChunks.length === phase1Chunks.length
    && heliosChunks.every((c, i) => {
      const p = phase1Chunks[i]
      return c.txHash === p.txHash && c.blockNumber === p.blockNumber && c.txIndex === p.txIndex
    })
}

// Retrieve calldata from a local Portal node when the execution RPC doesn't
// have the historical transaction. Requires blockNumber + txIndex in the ENS record.
async function fetchCalldataFromPortal(
  portalRpc: string,
  chunk: TxRef,
  rpc: IVerifiedRpc,
) {
  const { calldata } = await getCalldataViaPortal(portalRpc, chunk.blockNumber!, chunk.txIndex!)
  // Block headers are available on pruned nodes even when tx data is gone
  interface RpcBlock { hash: string; timestamp: string }
  const block = await rpc.request<RpcBlock>('eth_getBlockByNumber', [
    `0x${chunk.blockNumber!.toString(16)}`, false,
  ])
  return {
    verified: true,
    blockNumber: chunk.blockNumber!,
    blockHash: block.hash,
    blockTimestamp: parseInt(block.timestamp, 16),
    txHash: chunk.txHash,
    txIndex: chunk.txIndex!,
    trieVerified: true,
    headerVerified: false,
    calldata,
  }
}

// ---------------------------------------------------------------------------
// URL interception
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url ?? tab.pendingUrl ?? tab.url ?? ''
  if (url.startsWith('w3://')) {
    chrome.tabs.update(tabId, { url: rendererFor(url) })
  }
})

// ---------------------------------------------------------------------------
// Omnibox
// ---------------------------------------------------------------------------

chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  const trimmed = text.trim()
  const url = trimmed.startsWith('w3://') ? trimmed : `w3://${trimmed}`
  if (disposition === 'currentTab') {
    chrome.tabs.update({ url: rendererFor(url) })
  } else {
    chrome.tabs.create({ url: rendererFor(url) })
  }
})

chrome.omnibox.onInputChanged.addListener((_text, suggest) => {
  suggest([{ content: 'w3://', description: 'Enter an ENS name (e.g. myapp.eth)' }])
})

// ---------------------------------------------------------------------------
// Port-based handler — two-phase: show content fast, verify with Helios after.
// Ports keep the service worker alive; one-shot sendMessage gets killed mid-fetch.
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'web3-resolve') {
    port.onMessage.addListener((message: BgMessage) => {
      if (message.type === 'resolve') {
        const tabId = port.sender?.tab?.id
        twoPhaseResolve(message.url, tabId, port)
      }
    })
    return
  }

  if (port.name === 'eth-request') {
    port.onMessage.addListener(async (msg) => {
      const resp = await handleEthRequest(msg.method, msg.params ?? [], msg.walletId)
      try { port.postMessage(resp) } catch {}
    })
  }
})

async function twoPhaseResolve(
  rawUrl: string,
  tabId: number | undefined,
  port: chrome.runtime.Port,
) {
  console.clear()
  console.log('[w3] twoPhaseResolve start', rawUrl)
  const send = (msg: BgResponse) => { try { port.postMessage(msg) } catch {} }

  // Per-tab generation: if a newer navigation starts for this tab before we finish,
  // discard our stale result rather than overwriting the badge/proof.
  const gen = tabId !== undefined ? (tabVerGen.get(tabId) ?? 0) + 1 : 0
  if (tabId !== undefined) tabVerGen.set(tabId, gen)
  const isSuperseded = () => tabId !== undefined && tabVerGen.get(tabId) !== gen
  const stored = await chrome.storage.sync.get(['chains', 'defaultChain'])
  const chains: Record<number, ChainConfig> = stored.chains ?? DEFAULT_CHAINS
  const defaultChain: number = stored.defaultChain ?? 1
  const parsed = parseWeb3URL(rawUrl, defaultChain)
  console.log('[w3] parsed chainId:', parsed.chainId, 'target:', parsed.target)
  let chain = chains[parsed.chainId]
  if (!chain) {
    send({ type: 'error', message: `Unsupported chainId ${parsed.chainId}.` })
    port.disconnect()
    return
  }

  // ── Phase 1: fetch via plain RPC, show content immediately ───────────────
  if (tabId) setBadgeLoading(tabId)

  let assembled: Uint8Array
  let contentType: string
  let txHash: string
  let phase1BlockHash: string
  let phase1BlockTimestamp: number
  let phase1BlockNumber: number = 0
  let phase1TxIndex: number = 0
  let phase1Block: RpcBlockFull | undefined
  let phase1UsedPortal = false
  let phase1EnsChunks: TxRef[] = []
  let ensVerified: boolean | undefined = undefined

  try {
    const fastRpc = new RpcClient(chain.rpcs)
    const target = parsed.target

    const resolution = await resolveEns(target.name, fastRpc)
    phase1EnsChunks = resolution.chunks
    const results = await Promise.all(resolution.chunks.map(async (chunk) => {
      // New format: blockNumber + txIndex, no txHash — use Portal or direct block fetch
      if (chunk.txHash === undefined) {
        if (chain.portalRpc) {
          try {
            console.log('[w3] Block-indexed record — fetching from Portal')
            const result = await fetchCalldataFromPortal(chain.portalRpc, chunk, fastRpc)
            phase1UsedPortal = true
            return result
          } catch (portalErr) {
            console.warn('[w3] Portal unavailable, falling back to RPC:', portalErr)
          }
        }
        return await getVerifiedCalldataByLocation(chunk.blockNumber!, chunk.txIndex!, fastRpc)
      }
      // Legacy format: txHash — try RPC, fall back to Portal on failure
      try {
        return await getVerifiedCalldata(chunk.txHash, fastRpc)
      } catch (rpcErr) {
        if (chain.portalRpc && chunk.blockNumber !== undefined && chunk.txIndex !== undefined) {
          console.log('[w3] RPC missing tx, falling back to Portal for retrieval')
          const result = await fetchCalldataFromPortal(chain.portalRpc, chunk, fastRpc)
          phase1UsedPortal = true
          return result
        }
        throw rpcErr
      }
    }))
    const last = results[results.length - 1]
    txHash = last.txHash
    phase1BlockHash = last.blockHash
    phase1BlockTimestamp = last.blockTimestamp
    phase1BlockNumber = last.blockNumber
    phase1TxIndex = last.txIndex
    phase1Block = (last as { block?: RpcBlockFull }).block
    const chunks = results.map((r) => parseCalldata(r.calldata))
    ;({ data: assembled, contentType } = await assembleContent(chunks))

    // Bundle: send raw bundle bytes to renderer — it handles file extraction and blob URLs
    // (inline <script> tags are blocked by extension CSP; renderer uses blob: URLs instead)
  } catch (err) {
    if (tabId) clearBadge(tabId)
    send({ type: 'error', message: (err as Error).message })
    port.disconnect()
    return
  }

  // Send content to renderer — page shows NOW
  send({ type: 'content', assembled: Array.from(assembled), contentType })

  // Store partial proof immediately so popup has something during phase 2
  if (tabId) {
    chrome.storage.session.set({
      [`proof_${tabId}`]: {
        url: rawUrl, txHash, contentType,
        payloadSize: formatBytes(assembled.length),
        heliosBacked: false, trieVerified: false, pending: true,
        blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txIndex: phase1TxIndex,
      },
    })
  }

  // ── Phase 2: Helios verification in background ────────────────────────────
  if (!tabId) return

  // ── Portal path: if a local Portal node is configured, use it first ───────
  // Fetches block header + body from the Portal History Network by blockHash.
  // Portal nodes verify content against the beacon chain before serving it.
  // We additionally verify keccak256(header) == blockHash and reconstruct
  // the transactions trie to confirm block body integrity.
  if (chain.portalRpc) {
    console.log('[w3] Trying Portal node:', chain.portalRpc)
    // Start Helios in parallel for ENS re-verification — Portal is fast so the
    // combined wait is dominated by Helios (~30s), not Portal (~instant).
    const portalHeliosPromise = (parsed.target.type === 'ens' && phase1EnsChunks.length > 0 && chain.consensusRpcs.length > 0)
      ? Promise.race([
          getOrCreateRpc(chain),
          new Promise<undefined>(r => setTimeout(() => r(undefined), 35_000)),
        ]).catch(() => undefined)
      : Promise.resolve(undefined)

    try {
      // Skip re-download if Phase 1 already fetched from Portal — same source, no new info.
      if (!phase1UsedPortal) {
        await getCalldataViaPortal(chain.portalRpc, phase1BlockNumber, phase1TxIndex)
      }
      const trieVerified = true  // Portal pre-verifies trie before storing
      console.log('[w3] Portal verification succeeded, trieVerified:', trieVerified, phase1UsedPortal ? '(Phase 1 used Portal)' : '')

      const portalHeliosRpc = await portalHeliosPromise
      console.log('[w3] Portal ENS: helios rpc ready:', !!portalHeliosRpc, 'heliosBacked:', portalHeliosRpc?.isHeliosBacked())
      if (portalHeliosRpc?.isHeliosBacked() && parsed.target.type === 'ens') {
        try {
          const heliosResolution = await resolveEns(parsed.target.name, portalHeliosRpc)
          ensVerified = compareEnsChunks(heliosResolution.chunks, phase1EnsChunks)
          console.log('[w3] Portal ENS verified:', ensVerified)
        } catch (e) {
          console.warn('[w3] Portal ENS error:', (e as Error).message)
          ensVerified = undefined
        }
      }

      const update: VerificationUpdate = {
        type: 'verification-update',
        heliosBacked: false,
        trieVerified,
        portalVerified: true,
        ensVerified,
        proof: {
          url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash,
          txHash, txIndex: phase1TxIndex,
          contentType, payloadSize: formatBytes(assembled.length),
        },
      }
      if (isSuperseded()) { port.disconnect(); return }
      await updateBadge(tabId, update)
      send(update)
      port.disconnect()
      return
    } catch (err) {
      console.warn('[w3] Portal node unavailable, falling back:', (err as Error).message)
    }
  }

  // Historical blocks (> ~27h old) are outside the EIP-2935 ring buffer — Helios
  // would only throw EIP-2935 for them anyway. Skip the expensive multi-combo
  // Helios init (up to 6 min with 12 combinations × 30s timeout) and go straight
  // to beacon verification.
  const EIP_2935_BUFFER_SECONDS = 8191 * 12
  const blockIsHistorical = (Date.now() / 1000) - phase1BlockTimestamp > EIP_2935_BUFFER_SECONDS

  if (blockIsHistorical && chain.consensusRpcs.length > 0) {
    console.log('[w3] Historical block — starting Helios in parallel with beacon verification')
    // Pass Helios promise unawaited — verification runs immediately using fast consensus
    // anchor. Helios runs in parallel; its result is checked at the very end of
    // verifyViaBeacon to confirm the effective state root (heliosAnchored: true/false).
    const heliosPromise = Promise.race([
      getOrCreateRpc(chain),
      new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 35_000)),
    ]).catch(() => undefined)

    let update: VerificationUpdate
    try {
      const beacon = await verifyViaBeacon(
        phase1BlockHash,
        phase1BlockTimestamp,
        chain.chainId,
        chain.consensusRpcs,
        heliosPromise,
        chain.rpcs,
      )
      console.log('[w3] Beacon verification succeeded, heliosAnchored:', beacon.heliosAnchored, 'eraVerified:', beacon.eraVerified)
      let trieVerified = false
      try {
        const { txHash: verifiedTxHash } = await verifyTxInBlock(phase1BlockHash, phase1TxIndex, chain.rpcs, phase1Block)
        if (verifiedTxHash.toLowerCase() !== txHash.toLowerCase())
          throw new Error(`Tx hash mismatch at index ${phase1TxIndex}: block has ${verifiedTxHash}, expected ${txHash}`)
        trieVerified = true
      } catch (trieErr) {
        console.warn('[w3] Tx inclusion verification failed:', (trieErr as Error).message)
      }
      // heliosPromise is already settled — verifyViaBeacon awaited it internally
      const historicalHeliosRpc = await heliosPromise
      if (historicalHeliosRpc?.isHeliosBacked() && parsed.target.type === 'ens' && phase1EnsChunks.length > 0) {
        try {
          const heliosResolution = await resolveEns(parsed.target.name, historicalHeliosRpc)
          ensVerified = compareEnsChunks(heliosResolution.chunks, phase1EnsChunks)
        } catch {
          ensVerified = undefined
        }
      }
      update = {
        type: 'verification-update',
        heliosBacked: false,
        trieVerified,
        beaconVerified: true,
        beaconHeliosAnchored: beacon.heliosAnchored,
        beaconEraVerified: beacon.eraVerified,
        beaconStateHashVerified: beacon.stateHashVerified,
        ensVerified,
        proof: {
          url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txHash,
          txIndex: phase1TxIndex, contentType, payloadSize: formatBytes(assembled.length),
        },
      }
    } catch (beaconErr) {
      console.error('[w3] Beacon verification failed:', beaconErr)
      update = {
        type: 'verification-update',
        heliosBacked: false, trieVerified: false,
        ensVerified,
        proof: {
          url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txHash,
          txIndex: phase1TxIndex, contentType, payloadSize: formatBytes(assembled.length),
        },
      }
    }
    if (isSuperseded()) { port.disconnect(); return }
    await updateBadge(tabId, update)
    send(update)
    port.disconnect()
    return
  }

  console.log('[w3] phase 2 start — creating Helios RPC for chain', chain.chainId)
  let update: VerificationUpdate
  // Hoist so the EIP-2935 fallback can pass heliosRpc as an EIP-4788 anchor
  let heliosRpc: Awaited<ReturnType<typeof getOrCreateRpc>> | undefined

  try {
    heliosRpc = await getOrCreateRpc(chain)
    console.log('[w3] got RPC, heliosBacked:', heliosRpc.isHeliosBacked())
    const result = await getVerifiedCalldata(txHash, heliosRpc)

    if (parsed.target.type === 'ens' && phase1EnsChunks.length > 0) {
      try {
        const heliosResolution = await resolveEns(parsed.target.name, heliosRpc)
        ensVerified = compareEnsChunks(heliosResolution.chunks, phase1EnsChunks)
      } catch {
        ensVerified = undefined
      }
    }

    update = {
      type: 'verification-update',
      heliosBacked: heliosRpc.isHeliosBacked(),
      trieVerified: result.trieVerified,
      ensVerified,
      proof: {
        url: rawUrl,
        blockNumber: result.blockNumber,
        blockHash: result.blockHash,
        txHash: result.txHash,
        txIndex: result.txIndex,
        contentType,
        payloadSize: formatBytes(assembled.length),
      },
    }
  } catch (err) {
    console.warn('[w3] Helios phase 2 failed:', (err as Error).message)

    if (isEip2935Error(err) && chain.consensusRpcs.length > 0) {
      console.log('[w3] Falling back to beacon chain verification for historical block')
      try {
        const beacon = await verifyViaBeacon(
          phase1BlockHash,
          phase1BlockTimestamp,
          chain.chainId,
          chain.consensusRpcs,
          heliosRpc,
          chain.rpcs,
        )
        console.log(
          '[w3] Beacon verification succeeded, heliosAnchored:', beacon.heliosAnchored,
          'eraVerified:', beacon.eraVerified,
        )
        let trieVerified2 = false
        try {
          const { txHash: verifiedTxHash } = await verifyTxInBlock(phase1BlockHash, phase1TxIndex, chain.rpcs, phase1Block)
          if (verifiedTxHash.toLowerCase() !== txHash.toLowerCase())
            throw new Error(`Tx hash mismatch at index ${phase1TxIndex}: block has ${verifiedTxHash}, expected ${txHash}`)
          trieVerified2 = true
        } catch (trieErr) {
          console.warn('[w3] Tx inclusion verification failed:', (trieErr as Error).message)
        }
        // heliosRpc synced but threw EIP-2935 on block lookup; ENS uses 'latest' so it works
        if (heliosRpc?.isHeliosBacked() && parsed.target.type === 'ens' && phase1EnsChunks.length > 0) {
          try {
            const heliosResolution = await resolveEns(parsed.target.name, heliosRpc)
            ensVerified = compareEnsChunks(heliosResolution.chunks, phase1EnsChunks)
          } catch {
            ensVerified = undefined
          }
        }
        update = {
          type: 'verification-update',
          heliosBacked: false,
          trieVerified: trieVerified2,
          beaconVerified: true,
          beaconRpcs: beacon.agreedRpcs,
          beaconHeliosAnchored: beacon.heliosAnchored,
          beaconEraVerified: beacon.eraVerified,
          beaconStateHashVerified: beacon.stateHashVerified,
          ensVerified,
          proof: {
            url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txHash,
            txIndex: phase1TxIndex, contentType, payloadSize: formatBytes(assembled.length),
          },
        }
      } catch (beaconErr) {
        console.error('[w3] Beacon verification also failed:', beaconErr)
        update = {
          type: 'verification-update',
          heliosBacked: false, trieVerified: false,
          ensVerified,
          proof: {
            url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txHash,
            txIndex: phase1TxIndex, contentType, payloadSize: formatBytes(assembled.length),
          },
        }
      }
    } else {
      update = {
        type: 'verification-update',
        heliosBacked: false, trieVerified: false,
        ensVerified,
        proof: {
          url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txHash,
          txIndex: phase1TxIndex, contentType, payloadSize: formatBytes(assembled.length),
        },
      }
    }
  }

  if (isSuperseded()) { port.disconnect(); return }
  await updateBadge(tabId, update)
  send(update)
  port.disconnect()
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

function setBadgeLoading(tabId: number) {
  chrome.action.setBadgeText({ text: '···', tabId })
  chrome.action.setBadgeBackgroundColor({ color: '#8b949e', tabId })
}

async function updateBadge(tabId: number, update: VerificationUpdate) {
  const heliosVerified = update.heliosBacked && update.trieVerified
  const beaconTrusted = update.beaconVerified && update.beaconHeliosAnchored && (update.trieVerified ?? false)
  const portalTrusted = update.portalVerified === true && update.ensVerified === true
  const fullyVerified = heliosVerified || portalTrusted || beaconTrusted
  const color = fullyVerified ? '#3fb950' : '#d29922'
  const text = fullyVerified ? '✓' : '✗'
  // Tab may have been closed before verification finished — swallow the rejection.
  await Promise.allSettled([
    chrome.action.setBadgeText({ text, tabId }),
    chrome.action.setBadgeBackgroundColor({ color, tabId }),
  ])
  // Store flat object with all fields so popup.ts can read everything directly
  await chrome.storage.session.set({
    [`proof_${tabId}`]: {
      heliosBacked: update.heliosBacked,
      trieVerified: update.trieVerified,
      portalVerified: update.portalVerified ?? false,
      beaconVerified: update.beaconVerified ?? false,
      beaconHeliosAnchored: update.beaconHeliosAnchored ?? false,
      beaconEraVerified: update.beaconEraVerified ?? false,
      beaconStateHashVerified: update.beaconStateHashVerified ?? false,
      ensVerified: update.ensVerified ?? null,
      pending: false,
      ...update.proof,
    },
  })
}

function clearBadge(tabId: number) {
  chrome.action.setBadgeText({ text: '', tabId })
  chrome.storage.session.remove(`proof_${tabId}`)
}

// ---------------------------------------------------------------------------
// Wallet bridge — MetaMask (and compatible wallets) via direct background port.
// Other wallets (Rabby, Rainbow, etc.) are handled by WalletConnect embedded
// in the dApp itself; Chrome blocks cross-extension content script injection.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'list-wallets') {
    listAvailableWallets().then(sendResponse)
    return true
  }
})

async function listAvailableWallets(): Promise<Array<{ name: string; id: string }>> {
  const [direct, frame] = await Promise.all([
    listWallets(),
    isFrameAvailable(),
  ])
  return frame ? [...direct, { name: 'Frame', id: '__frame__' }] : direct
}

async function handleEthRequest(method: string, params: unknown[], walletId: string): Promise<unknown> {
  if (walletId === '__frame__') {
    try {
      const result = await frameRequest(method, params)
      return { result }
    } catch (err: any) {
      return { error: err.message ?? String(err) }
    }
  }
  try {
    const result = await walletRequest(walletId, method, params)
    return { result }
  } catch (err: any) {
    return { error: err.message ?? String(err) }
  }
}


function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(2)} MB`
}
