import { parseWeb3URL } from './lib/url-parser.js'
import { RpcClient, createVerifiedRpc } from './lib/light-client.js'
import { getVerifiedCalldata } from './lib/tx-verifier.js'
import { parseCalldata, assembleContent } from './lib/content.js'
import { resolveEns } from './lib/ens-resolver.js'
import { verifyViaBeacon, isEip2935Error } from './lib/beacon-verifier.js'
import { DEFAULT_CHAINS } from './types.js'
import type { BgMessage, BgResponse, VerificationUpdate, ChainConfig } from './types.js'
import type { IVerifiedRpc } from './lib/light-client.js'

const rpcCache = new Map<number, IVerifiedRpc>()
const tabVerGen = new Map<number, number>()

async function getOrCreateRpc(chain: ChainConfig): Promise<IVerifiedRpc> {
  if (rpcCache.has(chain.chainId)) return rpcCache.get(chain.chainId)!
  const rpc = await createVerifiedRpc(chain)
  rpcCache.set(chain.chainId, rpc)
  return rpc
}

function rendererFor(web3Url: string): string {
  return chrome.runtime.getURL('renderer.html') + '#' + web3Url
}

// ---------------------------------------------------------------------------
// URL interception
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url ?? tab.pendingUrl ?? tab.url ?? ''
  if (url.startsWith('web3://')) {
    chrome.tabs.update(tabId, { url: rendererFor(url) })
  }
})

// ---------------------------------------------------------------------------
// Omnibox
// ---------------------------------------------------------------------------

chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  const trimmed = text.trim()
  const url = trimmed.startsWith('web3://') ? trimmed : `web3://${trimmed}`
  if (disposition === 'currentTab') {
    chrome.tabs.update({ url: rendererFor(url) })
  } else {
    chrome.tabs.create({ url: rendererFor(url) })
  }
})

chrome.omnibox.onInputChanged.addListener((_text, suggest) => {
  suggest([{ content: 'web3://', description: 'Enter a contract address or tx:0x… hash' }])
})

// ---------------------------------------------------------------------------
// Port-based handler — two-phase: show content fast, verify with Helios after.
// Ports keep the service worker alive; one-shot sendMessage gets killed mid-fetch.
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'web3-resolve') return
  port.onMessage.addListener((message: BgMessage) => {
    if (message.type === 'resolve') {
      const tabId = port.sender?.tab?.id
      twoPhaseResolve(message.url, tabId, port)
    }
  })
})

async function twoPhaseResolve(
  rawUrl: string,
  tabId: number | undefined,
  port: chrome.runtime.Port,
) {
  console.log('[web3] twoPhaseResolve start', rawUrl)
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
  console.log('[web3] parsed chainId:', parsed.chainId, 'target:', parsed.target)
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

  try {
    const fastRpc = new RpcClient(chain.rpcs)
    const target = parsed.target

    if (target.type === 'ens') {
      const resolution = await resolveEns(target.name, fastRpc)
      const results = await Promise.all(resolution.txHashes.map((h) => getVerifiedCalldata(h, fastRpc)))
      const last = results[results.length - 1]
      txHash = last.txHash
      phase1BlockHash = last.blockHash
      phase1BlockTimestamp = last.blockTimestamp
      phase1BlockNumber = last.blockNumber
      phase1TxIndex = last.txIndex
      const chunks = results.map((r) => parseCalldata(r.calldata))
      ;({ data: assembled, contentType } = await assembleContent(chunks))
    } else {
      txHash = target.hash
      const result = await getVerifiedCalldata(txHash, fastRpc)
      phase1BlockHash = result.blockHash
      phase1BlockTimestamp = result.blockTimestamp
      phase1BlockNumber = result.blockNumber
      phase1TxIndex = result.txIndex
      const chunk = parseCalldata(result.calldata)
      ;({ data: assembled, contentType } = await assembleContent([chunk]))
    }
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
  // Portal verifies canonicity internally via sync committee BLS — instant for
  // all blocks (recent and historical). Falls back to Helios/beacon on failure.
  if (chain.portalRpc) {
    console.log('[web3] Trying Portal node:', chain.portalRpc)
    try {
      const portalClient = new RpcClient([chain.portalRpc])
      const result = await getVerifiedCalldata(txHash, portalClient)
      console.log('[web3] Portal verification succeeded')
      const update: VerificationUpdate = {
        type: 'verification-update',
        heliosBacked: false,
        trieVerified: result.trieVerified,
        portalVerified: true,
        proof: {
          url: rawUrl, blockNumber: result.blockNumber, blockHash: result.blockHash,
          txHash: result.txHash, txIndex: result.txIndex,
          contentType, payloadSize: formatBytes(assembled.length),
        },
      }
      if (isSuperseded()) { port.disconnect(); return }
      await updateBadge(tabId, update)
      send(update)
      port.disconnect()
      return
    } catch (err) {
      console.warn('[web3] Portal node unavailable, falling back:', (err as Error).message)
    }
  }

  // Historical blocks (> ~27h old) are outside the EIP-2935 ring buffer — Helios
  // would only throw EIP-2935 for them anyway. Skip the expensive multi-combo
  // Helios init (up to 6 min with 12 combinations × 30s timeout) and go straight
  // to beacon verification.
  const EIP_2935_BUFFER_SECONDS = 8191 * 12
  const blockIsHistorical = (Date.now() / 1000) - phase1BlockTimestamp > EIP_2935_BUFFER_SECONDS

  if (blockIsHistorical && chain.consensusRpcs.length > 0) {
    console.log('[web3] Historical block — starting Helios in parallel with beacon verification')
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
      console.log('[web3] Beacon verification succeeded, heliosAnchored:', beacon.heliosAnchored, 'eraVerified:', beacon.eraVerified)
      update = {
        type: 'verification-update',
        heliosBacked: false,
        trieVerified: true,
        beaconVerified: true,
        beaconRpcs: beacon.agreedRpcs,
        beaconHeliosAnchored: beacon.heliosAnchored,
        beaconEraVerified: beacon.eraVerified,
        beaconStateHashVerified: beacon.stateHashVerified,
        proof: {
          url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txHash,
          txIndex: phase1TxIndex, contentType, payloadSize: formatBytes(assembled.length),
        },
      }
    } catch (beaconErr) {
      console.error('[web3] Beacon verification failed:', beaconErr)
      update = {
        type: 'verification-update',
        heliosBacked: false, trieVerified: false,
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

  console.log('[web3] phase 2 start — creating Helios RPC for chain', chain.chainId)
  let update: VerificationUpdate
  // Hoist so the EIP-2935 fallback can pass heliosRpc as an EIP-4788 anchor
  let heliosRpc: Awaited<ReturnType<typeof getOrCreateRpc>> | undefined

  try {
    heliosRpc = await getOrCreateRpc(chain)
    console.log('[web3] got RPC, heliosBacked:', heliosRpc.isHeliosBacked())
    const result = await getVerifiedCalldata(txHash, heliosRpc)

    update = {
      type: 'verification-update',
      heliosBacked: heliosRpc.isHeliosBacked(),
      trieVerified: result.trieVerified,
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
    console.warn('[web3] Helios phase 2 failed:', (err as Error).message)

    if (isEip2935Error(err) && chain.consensusRpcs.length > 0) {
      console.log('[web3] Falling back to beacon chain verification for historical block')
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
          '[web3] Beacon verification succeeded, agreed RPCs:', beacon.agreedRpcs,
          'heliosAnchored:', beacon.heliosAnchored,
          'eraVerified:', beacon.eraVerified,
        )
        update = {
          type: 'verification-update',
          heliosBacked: false,
          trieVerified: true,
          beaconVerified: true,
          beaconRpcs: beacon.agreedRpcs,
          beaconHeliosAnchored: beacon.heliosAnchored,
          beaconEraVerified: beacon.eraVerified,
          beaconStateHashVerified: beacon.stateHashVerified,
          proof: {
            url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txHash,
            txIndex: phase1TxIndex, contentType, payloadSize: formatBytes(assembled.length),
          },
        }
      } catch (beaconErr) {
        console.error('[web3] Beacon verification also failed:', beaconErr)
        update = {
          type: 'verification-update',
          heliosBacked: false, trieVerified: false,
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
  const beaconTrusted = update.beaconVerified && update.beaconHeliosAnchored
  const color = (heliosVerified || update.portalVerified || beaconTrusted) ? '#3fb950' : '#d29922'
  // Tab may have been closed before verification finished — swallow the rejection.
  await Promise.allSettled([
    chrome.action.setBadgeText({ text: '✓', tabId }),
    chrome.action.setBadgeBackgroundColor({ color, tabId }),
  ])
  // Store flat object with all fields so popup.ts can read everything directly
  await chrome.storage.session.set({
    [`proof_${tabId}`]: {
      heliosBacked: update.heliosBacked,
      trieVerified: update.trieVerified,
      portalVerified: update.portalVerified ?? false,
      beaconVerified: update.beaconVerified ?? false,
      beaconRpcs: update.beaconRpcs ?? 0,
      beaconHeliosAnchored: update.beaconHeliosAnchored ?? false,
      beaconEraVerified: update.beaconEraVerified ?? false,
      beaconStateHashVerified: update.beaconStateHashVerified ?? false,
      pending: false,
      ...update.proof,
    },
  })
}

function clearBadge(tabId: number) {
  chrome.action.setBadgeText({ text: '', tabId })
  chrome.storage.session.remove(`proof_${tabId}`)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(2)} MB`
}
