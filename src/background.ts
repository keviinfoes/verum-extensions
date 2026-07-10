import { parseWeb3URL } from './lib/w3/url-parser.js'
import { RpcClient, createVerifiedRpc } from './lib/rpc/light-client.js'
import { getVerifiedCalldataByLocation, verifyTxInBlock } from './lib/verify/tx-verifier.js'
import type { RpcBlockFull } from './lib/verify/tx-verifier.js'
import { getCalldataViaPortal } from './lib/rpc/portal.js'
import { parseCalldata, assembleContent } from './lib/w3/content.js'
import { resolveEns } from './lib/w3/name-resolver.js'
import type { TxRef } from './lib/w3/name-resolver.js'
import { verifyViaBeacon, isEip2935Error } from './lib/verify/beacon-verifier.js'
import type { DappProofData, EraBsrCache } from './lib/verify/beacon-verifier.js'
import { DEFAULT_CHAINS } from './types.js'
import type { BgMessage, BgResponse, VerificationUpdate, ChainConfig, VerificationResult } from './types.js'
import { listWallets, ethRequest as walletRequest } from './lib/wallets/metamask-bridge.js'
import { isFrameAvailable, frameRequest } from './lib/wallets/frame-bridge.js'
import type { IVerifiedRpc } from './lib/rpc/light-client.js'

const BUILD_ID = 'trim-exec-proxy-logs-2026-07-10T51'

console.log(`[w3] background build ${BUILD_ID}`)

const rpcCache = new Map<number, Promise<IVerifiedRpc>>()

// Removes a chain's WASM instance from the cache AND shuts it down. Deleting
// the cache entry alone leaks the instance: its internal polling loops keep
// running with no JS reference, and accumulated zombies starve the SW event
// loop (the original cause of chrome.storage hangs / stuck page loads).
function evictChainRpc(chainId: number) {
  const old = rpcCache.get(chainId)
  rpcCache.delete(chainId)
  old?.then(rpc => (rpc as { shutdown?: () => Promise<void> }).shutdown?.().catch(() => {})).catch(() => {})
}
const freshRpcCache = new Map<number, Promise<IVerifiedRpc>>()
// Stores the already-resolved Helios instance once freshRpcCache settles.
// ethRpcCall can check this synchronously and skip the 100ms race entirely.
const freshRpcReady = new Map<number, IVerifiedRpc>()
// Tracks chains for which we've already sent a helios-syncing signal so we
// don't broadcast it on every read call while Helios is warming up.
const heliosSyncingSignaled = new Set<number>()
// Counts consecutive OOS probe exhaustions per chain. After 2 the WASM
// instance is considered stuck and rpcCache is cleared to force a full restart.
const oosExhaustionCount = new Map<number, number>()

// Reads that arrived while Helios wasn't ready. Flushed as a batch once
// freshRpcReady is set. The probe restarts on OOS exhaustion so reads wait
// across multiple probe cycles until Helios recovers — no timeout.
type PendingRead = (rpc: IVerifiedRpc) => void
const pendingReads = new Map<number, PendingRead[]>()

// In-flight dedup: identical reads (same chainId:method:params) share one promise.
// Covers both queued reads (Helios not ready) and live reads (Helios ready).
// Checked synchronously before any async work so there is no race window.
const heliosInflight = new Map<string, Promise<{ result?: unknown; error?: string }>>()

// Stale-while-revalidate cache for small primitive reads only.
// eth_call and similar can return megabytes of ABI-encoded data — caching those
// inflates the SW heap unboundedly under a polling dapp and triggers OOM.
// Only cache methods whose results are always small (< ~100 bytes).
const CACHEABLE_METHODS = new Set([
  'eth_blockNumber', 'eth_getBalance', 'eth_getTransactionCount',
  'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
])
const heliosReadCache = new Map<string, unknown>()
const MAX_READ_CACHE = 200

// Concurrency limit for non-cacheable Helios reads (eth_call, eth_getLogs, …).
// Each concurrent call holds a large ABI-encoded result in memory while the IPC
// clone travels to the renderer. 20+ simultaneous clones exhaust the renderer
// heap and Chrome kills the process (error 5). Cap at 4 concurrent slots so at
// most 4 large results exist in memory at once.
let ethCallSlots = 0
const ETH_CALL_MAX_SLOTS = 4
const ethCallWaiters: Array<() => void> = []
function acquireEthCallSlot(): Promise<() => void> {
  const release = () => { ethCallSlots--; ethCallWaiters.shift()?.() }
  if (ethCallSlots < ETH_CALL_MAX_SLOTS) { ethCallSlots++; return Promise.resolve(release) }
  return new Promise(resolve => ethCallWaiters.push(() => { ethCallSlots++; resolve(release) }))
}
const tabVerGen = new Map<number, number>()

// Track when the portal last failed so subsequent loads don't spend 15s on a
// TCP-connected-but-silent portal node. Resets when the SW is killed.
let portalLastFailedAt = 0
const PORTAL_FAIL_COOLDOWN = 120_000
function isPortalLikelyDown(): boolean {
  return portalLastFailedAt > 0 && Date.now() - portalLastFailedAt < PORTAL_FAIL_COOLDOWN
}

// ---------------------------------------------------------------------------
// Per-dapp proof cache (chrome.storage.local)
// Key: raw w3:// URL. Value: txHash (for ENS staleness) + 13-hash Merkle proof.
// Skips era file / parquet / exec-header download on re-visit.
// ---------------------------------------------------------------------------
interface StoredProof { txHash: string; merklePaths: (string | null)[]; chainId?: number }

async function readProofCache(): Promise<Record<string, StoredProof>> {
  const { dapp_proof_cache } = await chrome.storage.local.get('dapp_proof_cache')
  return (dapp_proof_cache as Record<string, StoredProof>) ?? {}
}

function writeProofCache(cache: Record<string, StoredProof>): void {
  chrome.storage.local.set({ dapp_proof_cache: cache }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Era BSR cache (chrome.storage.local)
// Key: chainId → EraBsrCache { stateRoot, fieldProof, histSummaries }.
// Stores all historical_summaries + a 5-6 hash field proof → stateRoot → Helios.
// Covers all eras; no per-era proof needed. Re-downloaded when Helios can no longer confirm stateRoot.
// ---------------------------------------------------------------------------
async function readEraBsrCache(): Promise<Record<number, EraBsrCache>> {
  const { era_bsr_cache } = await chrome.storage.local.get('era_bsr_cache')
  return (era_bsr_cache as Record<number, EraBsrCache>) ?? {}
}

function writeEraBsrCache(cache: Record<number, EraBsrCache>): void {
  chrome.storage.local.set({ era_bsr_cache: cache }).catch(() => {})
}

// Base Helios cache — resolves after eth_getBalance warmup (~30-60s total).
// Used by beacon verification which needs Helios quickly within its 35s timeout.
function getOrCreateRpc(chain: ChainConfig): Promise<IVerifiedRpc> {
  if (!rpcCache.has(chain.chainId)) {
    const p = createVerifiedRpc(chain)
    p.catch(() => {
      // Both consensus RPCs failed (likely rate-limited). Wait 60s before
      // allowing a retry — clearing immediately causes a tight hammering loop
      // that worsens 429s and keeps the page stuck on loading.
      setTimeout(() => {
        rpcCache.delete(chain.chainId)
        freshRpcCache.delete(chain.chainId)
        freshRpcReady.delete(chain.chainId)
      }, 60_000)
    })
    rpcCache.set(chain.chainId, p)
    // Kick off the fresh cache so it starts waiting for a new block in parallel.
    // Deferred: getOrCreateFreshRpc sets freshRpcCache synchronously before calling
    // getOrCreateRpc, so a direct call here would be re-entrant and find freshRpcCache
    // empty — creating a second orphaned probe that runs in parallel with the real one.
    setTimeout(() => getOrCreateFreshRpc(chain), 0)
  }
  return rpcCache.get(chain.chainId)!
}

// Fresh Helios cache — resolves after the base is ready AND a new block has
// been observed, resetting drift to near-zero. Used by ethRpcCall so dapp
// eth_call reads land on Helios well within the out-of-sync threshold.
function getOrCreateFreshRpc(chain: ChainConfig): Promise<IVerifiedRpc> {
  if (!freshRpcCache.has(chain.chainId)) {
    const p = getOrCreateRpc(chain).then(async rpc => {
      // Retry eth_blockNumber until execution state is past the out-of-sync guard.
      // waitSynced() confirms consensus but execution may be briefly behind — once
      // eth_blockNumber succeeds, the head is within the OOS threshold and Helios
      // can serve all calls. Fast 500ms retries (vs old 1s new-block wait).
      const t0 = Date.now()
      let lastLag = '?'
      for (let i = 0; i < 120; i++) {
        try {
          await rpc.request<string>('eth_blockNumber', [], true)  // quickFail — skip internal 3s retry
          if (i > 0) console.log(`[w3] Helios OOS probe resolved in ${Math.round((Date.now() - t0) / 1000)}s`)
          return rpc  // execution head confirmed live
        } catch (err: any) {
          if (!(err?.message ?? '').includes('out of sync')) return rpc  // non-OOS error, proceed
          lastLag = (err.message as string).match(/(\d+) seconds? behind/)?.[1] ?? '?'
        }
        if (i > 0 && i % 10 === 0) {
          console.log(`[w3] Helios OOS probe still waiting (${Math.round((Date.now() - t0) / 1000)}s, ${lastLag}s behind)…`)
        }
        await new Promise(r => setTimeout(r, 500))
      }
      // Probe exhausted — Helios execution head still stale. Clear self from the
      // cache so the next ethRpcCall or ping creates a fresh probe rather than
      // returning this rejected promise. Do NOT set freshRpcReady with an OOS instance.
      freshRpcCache.delete(chain.chainId)
      throw new Error('Helios OOS probe exhausted')
    })
    p.then(
      (rpc) => {
        freshRpcReady.set(chain.chainId, rpc)
        heliosSyncingSignaled.delete(chain.chainId)
        oosExhaustionCount.delete(chain.chainId)
        chrome.runtime.sendMessage({ type: 'helios-ready', chainId: chain.chainId }).catch(() => {})
        flushPendingReads(chain.chainId, rpc)
      },
      (err: any) => {
        heliosSyncingSignaled.delete(chain.chainId)
        if ((err?.message ?? '').includes('OOS probe exhausted')) {
          const n = (oosExhaustionCount.get(chain.chainId) ?? 0) + 1
          oosExhaustionCount.set(chain.chainId, n)
          if (n >= 2) {
            // Execution head stuck across 2 full probe cycles (2 × 60s) —
            // the WASM instance is not recovering. Clear rpcCache to force a
            // fresh createVerifiedRpc on the next getOrCreateFreshRpc call.
            console.warn(`[w3] Helios OOS stuck (${n} exhaustions) — restarting WASM instance`)
            oosExhaustionCount.set(chain.chainId, 0)
            evictChainRpc(chain.chainId)
          }
          getOrCreateFreshRpc(chain)
        }
      },
    )
    freshRpcCache.set(chain.chainId, p)
  }
  return freshRpcCache.get(chain.chainId)!
}

function flushPendingReads(chainId: number, rpc: IVerifiedRpc) {
  const queue = pendingReads.get(chainId) ?? []
  pendingReads.delete(chainId)
  for (const fn of queue) fn(rpc)
}


function rendererFor(web3Url: string): string {
  return chrome.runtime.getURL('renderer.html') + '#' + web3Url
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// Returns true if Helios confirms the same chunks as phase 1, false if it resolves
// to definitively different non-empty chunks (forged), undefined if Helios couldn't
// resolve (error or empty result — unverified, not forged).
function compareEnsChunks(heliosChunks: TxRef[], phase1Chunks: TxRef[]): boolean | undefined {
  if (heliosChunks.length === 0) return undefined
  return heliosChunks.length === phase1Chunks.length
    && heliosChunks.every((c, i) => {
      const p = phase1Chunks[i]
      return c.blockNumber === p.blockNumber && c.txIndex === p.txIndex
    })
}

// Retrieve calldata from a local Portal node when the execution RPC doesn't
// have the historical transaction. Requires blockNumber + txIndex in the ENS record.
async function fetchCalldataFromPortal(
  portalRpc: string,
  chunk: TxRef,
  rpc: IVerifiedRpc,
) {
  const { calldata } = await getCalldataViaPortal(portalRpc, chunk.blockNumber, chunk.txIndex)
  // Block headers are available on pruned nodes even when tx data is gone.
  // transactions is a hash-string array since we request with fullTx=false.
  interface RpcBlock { hash: string; timestamp: string; transactions: string[] }
  const block = await rpc.request<RpcBlock>('eth_getBlockByNumber', [
    `0x${chunk.blockNumber.toString(16)}`, false,
  ])
  return {
    verified: true,
    blockNumber: chunk.blockNumber,
    blockHash: block.hash,
    blockTimestamp: parseInt(block.timestamp, 16),
    txHash: block.transactions[chunk.txIndex],
    txIndex: chunk.txIndex,
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
  suggest([{ content: 'w3://', description: 'Enter an ENS/GNS name (e.g. myapp.eth or myapp.gwei) or block:txIndex' }])
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

  if (port.name === 'helios-keepalive') {
    // Ping arrives every 20s from the renderer. Use it to health-check Helios:
    // one WASM eth_blockNumber call (no public RPC — Helios serves from its
    // internal cached head). If OOS, re-probe early before the dapp reads.
    port.onMessage.addListener(async () => {
      const stored = await chrome.storage.sync.get('chains')
      const chains = (stored.chains as Record<number, ChainConfig> | undefined) ?? DEFAULT_CHAINS
      for (const chain of Object.values(chains)) {
        if (chain.localMode) continue
        const rpc = freshRpcReady.get(chain.chainId)
        if (rpc) {
          // Health-check the live instance — cheap WASM call, no public RPC.
          try {
            await rpc.request<string>('eth_blockNumber', [], true)
          } catch (err: any) {
            if ((err?.message ?? '').includes('out of sync')) {
              if (freshRpcReady.get(chain.chainId) === rpc) {
                const lagStr = (err.message as string).match(/(\d+) seconds? behind/)?.[1] ?? '?'
                const lag = Number(lagStr)
                // If execution head is already far behind when keepalive detects OOS,
                // the WASM is in internal backoff — re-probing the same instance won't
                // help since it won't make execution fetch calls during backoff.
                // Force a full WASM restart so a fresh instance starts immediately.
                const forceRestart = lag >= 30
                console.warn(`[w3] Helios keepalive OOS (${lagStr}s behind)${forceRestart ? ' — lag too large, forcing WASM restart' : ' — starting re-probe'}`)
                freshRpcReady.delete(chain.chainId)
                freshRpcCache.delete(chain.chainId)
                heliosSyncingSignaled.delete(chain.chainId)
                if (forceRestart) evictChainRpc(chain.chainId)
                getOrCreateFreshRpc(chain)
                chrome.runtime.sendMessage({ type: 'helios-oos', chainId: chain.chainId }).catch(() => {})
              }
            }
          }
        } else if (rpcCache.has(chain.chainId) && !freshRpcCache.has(chain.chainId)) {
          // Probe exhausted and cleared itself — restart it now rather than waiting
          // for the next ethRpcCall.
          getOrCreateFreshRpc(chain)
        }
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
  console.log(`[w3] background build ${BUILD_ID}`)
  console.log('[w3] twoPhaseResolve start', rawUrl)
  const send = (msg: BgResponse) => { try { port.postMessage(msg) } catch {} }

  // Per-tab generation: if a newer navigation starts for this tab before we finish,
  // discard our stale result rather than overwriting the badge/proof.
  const gen = tabId !== undefined ? (tabVerGen.get(tabId) ?? 0) + 1 : 0
  if (tabId !== undefined) tabVerGen.set(tabId, gen)
  const isSuperseded = () => tabId !== undefined && tabVerGen.get(tabId) !== gen
  const stored = await chrome.storage.sync.get(['chains', 'defaultChain'])
  const chains = (stored.chains as Record<number, ChainConfig> | undefined) ?? DEFAULT_CHAINS
  const defaultChain = (stored.defaultChain as number | undefined) ?? 1
  const parsed = parseWeb3URL(rawUrl, defaultChain)
  console.log('[w3] parsed chainId:', parsed.chainId, 'target:', parsed.target)
  let chain = chains[parsed.chainId]
  if (!chain) {
    send({ type: 'error', message: `Unsupported chainId ${parsed.chainId}.` })
    port.disconnect()
    return
  }

  // Local mode: use only the first exec RPC at batch 1000, skip era/parquet
  const execRpcs = chain.localMode ? chain.rpcs.slice(0, 1) : chain.rpcs
  const execBatchSizes = chain.localMode
    ? (chain.rpcs[0] ? { [chain.rpcs[0]]: 1000 } : undefined)
    : chain.rpcBatchSizes

  // ── Phase 1: fetch via plain RPC, show content immediately ───────────────
  // Common to all 4 modes (see VERIFICATION.md) — name resolution, calldata parsing,
  // and the tx-trie rebuild that binds calldata to the block it's rendered from.
  console.log('[w3] Phase 1 — content fetch & assembly (plain RPC, not yet trusted)')
  if (tabId) setBadgeLoading(tabId)

  let assembled: Uint8Array
  let contentType: string
  let txHash: string
  let phase1BlockHash: string
  let phase1BlockNumber: number = 0
  let phase1TxIndex: number = 0
  // All chunk results — phase 2 verifies and binds every chunk, not just the last.
  let phase1Results: Array<VerificationResult & { block?: RpcBlockFull }> = []
  let phase1UsedPortal = false
  let phase1PortalFailed = false
  let phase1EnsChunks: TxRef[] = []
  let ensVerified: boolean | undefined = undefined

  try {
    const fastRpc = new RpcClient(execRpcs)
    const target = parsed.target

    const txRefs: TxRef[] = target.type === 'tx'
      ? target.refs.map(r => ({ blockNumber: r.blockNumber, txIndex: r.txIndex }))
      : (await resolveEns(target.name, fastRpc)).chunks
    phase1EnsChunks = txRefs
    const results = await Promise.all(txRefs.map(async (chunk) => {
      // Block-indexed record — use Portal or direct block fetch
      if (chain.portalRpc && !isPortalLikelyDown()) {
        try {
          console.log('[w3] Block-indexed record — fetching from Portal')
          const result = await fetchCalldataFromPortal(chain.portalRpc, chunk, fastRpc)
          phase1UsedPortal = true
          return result
        } catch (portalErr) {
          console.warn('[w3] Portal unavailable, falling back to RPC:', portalErr)
          phase1PortalFailed = true
          portalLastFailedAt = Date.now()
        }
      }
      return await getVerifiedCalldataByLocation(chunk.blockNumber, chunk.txIndex, fastRpc)
    }))
    phase1Results = results
    const last = results[results.length - 1]
    txHash = last.txHash
    phase1BlockHash = last.blockHash
    phase1BlockNumber = last.blockNumber
    phase1TxIndex = last.txIndex
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

  // Per-chunk refs for the proof panel — the singular proof fields describe the
  // last chunk; this lists every chunk that phase 2 verifies.
  const proofChunks = phase1Results.map(r => ({ blockNumber: r.blockNumber, txIndex: r.txIndex, txHash: r.txHash }))

  // Store partial proof immediately so popup has something during phase 2
  if (tabId) {
    chrome.storage.session.set({
      [`proof_${tabId}`]: {
        url: rawUrl, txHash, contentType,
        payloadSize: formatBytes(assembled.length),
        heliosBacked: false, trieVerified: false, pending: true,
        blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txIndex: phase1TxIndex,
        chunks: proofChunks,
      },
    })
  }

  // ── Phase 2: Helios verification in background ────────────────────────────
  if (!tabId) return

  // ── Portal path: if a local Portal node is configured, use it first ───────
  // Portal nodes verify calldata ∈ tx ∈ block ∈ canonical chain before storing,
  // so a successful fetch from the user's own node needs no re-verification —
  // the beacon pipeline below is skipped entirely (portalVerified: true).
  if (chain.portalRpc && !phase1PortalFailed && !isPortalLikelyDown()) {
    console.log('[w3] Mode 3 — Portal-trusted: trying', chain.portalRpc)
    // Start Helios in parallel for ENS re-verification — skipped in local mode (no external calls).
    const portalHeliosPromise = (!chain.localMode && parsed.target.type === 'ens' && phase1EnsChunks.length > 0 && chain.consensusRpcs.length > 0)
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
      console.log('[w3] Mode 3 — Portal-trusted: calldata ∈ tx ∈ block ∈ canonical chain delegated to Portal node', phase1UsedPortal ? '(Phase 1 already used Portal)' : '')

      const portalHeliosRpc = await portalHeliosPromise
      console.log('[w3] Mode 3 — ENS/GNS re-verification: helios rpc ready:', !!portalHeliosRpc, 'heliosBacked:', portalHeliosRpc?.isHeliosBacked())
      if (portalHeliosRpc?.isHeliosBacked() && parsed.target.type === 'ens') {
        try {
          const heliosResolution = await resolveEns(parsed.target.name, portalHeliosRpc)
          ensVerified = compareEnsChunks(heliosResolution.chunks, phase1EnsChunks)
          console.log('[w3] Mode 3 — ENS/GNS re-verification result:', ensVerified)
        } catch (e) {
          console.warn('[w3] Mode 3 — ENS/GNS re-verification error:', (e as Error).message)
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
          chunks: proofChunks,
        },
      }
      console.log('[w3] Mode 3 — Portal-trusted: done, ensOk:', parsed.target.type !== 'ens' || ensVerified === true)
      if (isSuperseded()) { port.disconnect(); return }
      await updateBadge(tabId, update)
      send(update)
      port.disconnect()
      return
    } catch (err) {
      console.warn('[w3] Mode 3 — Portal-trusted: node unavailable, falling back —', (err as Error).message)
      portalLastFailedAt = Date.now()
    }
  }

  // ── Local mode: trie-verify via local exec RPC only — no external calls ──
  if (chain.localMode) {
    console.log('[w3] Mode 4 — Local mode: trusted to local execution RPC, no Helios/beacon/ENS check')
    const update: VerificationUpdate = {
      type: 'verification-update',
      heliosBacked: false,
      trieVerified: false,
      localMode: true,
      proof: {
        url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txHash,
        txIndex: phase1TxIndex, contentType, payloadSize: formatBytes(assembled.length),
        chunks: proofChunks,
      },
    }
    if (isSuperseded()) { port.disconnect(); return }
    await updateBadge(tabId, update)
    send(update)
    port.disconnect()
    return
  }

  // Historical blocks (> ~27h old) are outside the EIP-2935 ring buffer — Helios
  // would only throw EIP-2935 for them anyway. Skip the expensive multi-combo
  // Helios init (up to 6 min with 12 combinations × 30s timeout) and go straight
  // to beacon verification.
  const EIP_2935_BUFFER_SECONDS = 8191 * 12
  // Gate on the OLDEST chunk: if any chunk is outside the ring, Helios would throw
  // EIP-2935 for it — go straight to beacon verification, which covers recent chunks
  // too (via the BeaconState rolling window).
  const oldestTimestamp = Math.min(...phase1Results.map(r => r.blockTimestamp))
  const blockIsHistorical = (Date.now() / 1000) - oldestTimestamp > EIP_2935_BUFFER_SECONDS

  // Look up per-dapp proof cache (era Merkle proofs, one per chunk) and chain-level
  // era BSR cache. Old single-merklePath entries lack merklePaths — treated as a miss.
  const [proofCache, eraBsrCache] = await Promise.all([readProofCache(), readEraBsrCache()])
  const cachedEntry = proofCache[rawUrl]
  const cachedProof: DappProofData | undefined = cachedEntry
    && Array.isArray(cachedEntry.merklePaths)
    && cachedEntry.merklePaths.length === phase1Results.length
    && (parsed.target.type === 'tx' || cachedEntry.txHash.toLowerCase() === txHash.toLowerCase())
    ? { merklePaths: cachedEntry.merklePaths } : undefined
  if (cachedProof) console.log('[w3] Dapp proof cache hit — skipping era file download')

  const beaconOptions = {
    checkpointUrls: chain.checkpointUrls,
    eraFileUrls: chain.localMode ? [] : chain.eraFileUrls,
    parquetUrls: chain.localMode ? [] : chain.parquetUrls,
    rpcBatchSizes: execBatchSizes,
    cachedProof,
    eraBsrCache: eraBsrCache[chain.chainId],
  }

  if (blockIsHistorical && chain.consensusRpcs.length > 0) {
    console.log('[w3] Mode 2 — Historical block, beacon-verified: oldest chunk outside Helios\'s EIP-2935 ring, starting Helios in parallel for the anchor')
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
        phase1Results.map(r => ({ executionHash: r.blockHash, blockTimestamp: r.blockTimestamp })),
        chain.chainId,
        chain.consensusRpcs,
        heliosPromise,
        execRpcs,
        beaconOptions,
      )
      console.log('[w3] Mode 2 — beacon pipeline done: heliosAnchored:', beacon.heliosAnchored, 'eraVerified:', beacon.eraVerified, `(${phase1Results.length} chunk(s))`)
      if (beacon.proofData) {
        proofCache[rawUrl] = { txHash, chainId: chain.chainId, ...beacon.proofData }
        writeProofCache(proofCache)
      }
      if (beacon.newBsrCache) {
        eraBsrCache[chain.chainId] = beacon.newBsrCache
        writeEraBsrCache(eraBsrCache)
      }
      // Every chunk's block object (the one whose calldata was rendered) is verified
      // end-to-end: trie root, header keccak → blockhash (beacon-pinned above), tx hash.
      let trieVerified = false
      try {
        for (const r of phase1Results) {
          const { txHash: verifiedTxHash } = await verifyTxInBlock(r.blockHash, r.txIndex, execRpcs, r.block)
          if (verifiedTxHash.toLowerCase() !== r.txHash.toLowerCase())
            throw new Error(`Tx hash mismatch at index ${r.txIndex}: block has ${verifiedTxHash}, expected ${r.txHash}`)
        }
        trieVerified = true
        console.log('[w3] Mode 2 — tx trie → header → blockhash verified for all chunks ✓')
      } catch (trieErr) {
        console.warn('[w3] Mode 2 — tx inclusion verification failed:', (trieErr as Error).message)
      }
      // heliosPromise is already settled — verifyViaBeacon awaited it internally
      const historicalHeliosRpc = await heliosPromise
      if (historicalHeliosRpc?.isHeliosBacked() && parsed.target.type === 'ens' && phase1EnsChunks.length > 0) {
        try {
          const heliosResolution = await resolveEns(parsed.target.name, historicalHeliosRpc)
          ensVerified = compareEnsChunks(heliosResolution.chunks, phase1EnsChunks)
          console.log('[w3] Mode 2 — ENS/GNS re-verification result:', ensVerified)
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
          chunks: proofChunks,
        },
      }
    } catch (beaconErr) {
      console.error('[w3] Mode 2 — beacon pipeline failed:', beaconErr)
      update = {
        type: 'verification-update',
        heliosBacked: false, trieVerified: false,
        ensVerified,
        proof: {
          url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txHash,
          txIndex: phase1TxIndex, contentType, payloadSize: formatBytes(assembled.length),
          chunks: proofChunks,
        },
      }
    }
    if (isSuperseded()) { port.disconnect(); return }
    await updateBadge(tabId, update)
    send(update)
    port.disconnect()
    return
  }

  console.log('[w3] Mode 1 — Recent block, Helios-verified: creating Helios RPC for chain', chain.chainId)
  let update: VerificationUpdate
  // Hoist so the EIP-2935 fallback can pass heliosRpc as an EIP-4788 anchor
  let heliosRpc: Awaited<ReturnType<typeof getOrCreateRpc>> | undefined

  try {
    heliosRpc = await Promise.race([
      getOrCreateRpc(chain),
      new Promise<undefined>(r => setTimeout(() => r(undefined), 35_000)),
    ]).catch(() => undefined)
    if (!heliosRpc) throw new Error('Helios not available (timeout or consensus RPC failure)')
    console.log('[w3] Mode 1 — got RPC, heliosBacked:', heliosRpc.isHeliosBacked())
    // Verify EVERY chunk through Helios and bind the phase-1 rendered bytes to the
    // Helios-verified calldata. Without the byte comparison, a fast RPC serving a
    // self-consistent forgery in phase 1 would render forged content while phase 2
    // green-lights the canonical tx at the same coordinates.
    let result!: Awaited<ReturnType<typeof getVerifiedCalldataByLocation>>
    for (let i = 0; i < phase1Results.length; i++) {
      const p1 = phase1Results[i]
      result = await getVerifiedCalldataByLocation(p1.blockNumber, p1.txIndex, heliosRpc)
      if (!bytesEqual(result.calldata, p1.calldata))
        throw new Error(`Rendered calldata mismatch: chunk ${i} (block ${p1.blockNumber}, tx ${p1.txIndex}) does not match Helios-verified calldata`)
    }
    console.log(`[w3] Mode 1 — render binding: ${phase1Results.length} chunk(s) verified, rendered bytes match Helios ✓`)

    if (parsed.target.type === 'ens' && phase1EnsChunks.length > 0) {
      try {
        const heliosResolution = await resolveEns(parsed.target.name, heliosRpc)
        ensVerified = compareEnsChunks(heliosResolution.chunks, phase1EnsChunks)
        console.log('[w3] Mode 1 — ENS/GNS re-verification result:', ensVerified)
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
        chunks: proofChunks,
      },
    }
  } catch (err) {
    console.warn('[w3] Mode 1 — Recent block, Helios-verified: failed —', (err as Error).message)

    if (isEip2935Error(err) && chain.consensusRpcs.length > 0) {
      console.log('[w3] Mode 1 failed (EIP-2935, block outside Helios\'s ring) — falling back to Mode 2 — Historical block, beacon-verified')
      try {
        const beacon = await verifyViaBeacon(
          phase1Results.map(r => ({ executionHash: r.blockHash, blockTimestamp: r.blockTimestamp })),
          chain.chainId,
          chain.consensusRpcs,
          heliosRpc,
          execRpcs,
          beaconOptions,
        )
        console.log(
          '[w3] Mode 2 — beacon pipeline done: heliosAnchored:', beacon.heliosAnchored,
          'eraVerified:', beacon.eraVerified,
        )
        if (beacon.proofData) {
          proofCache[rawUrl] = { txHash, chainId: chain.chainId, ...beacon.proofData }
          writeProofCache(proofCache)
        }
        if (beacon.newBsrCache) {
          eraBsrCache[chain.chainId] = beacon.newBsrCache
          writeEraBsrCache(eraBsrCache)
        }
        let trieVerified2 = false
        try {
          for (const r of phase1Results) {
            const { txHash: verifiedTxHash } = await verifyTxInBlock(r.blockHash, r.txIndex, execRpcs, r.block)
            if (verifiedTxHash.toLowerCase() !== r.txHash.toLowerCase())
              throw new Error(`Tx hash mismatch at index ${r.txIndex}: block has ${verifiedTxHash}, expected ${r.txHash}`)
          }
          trieVerified2 = true
          console.log('[w3] Mode 2 — tx trie → header → blockhash verified for all chunks ✓')
        } catch (trieErr) {
          console.warn('[w3] Mode 2 — tx inclusion verification failed:', (trieErr as Error).message)
        }
        // heliosRpc synced but threw EIP-2935 on block lookup; ENS uses 'latest' so it works
        if (heliosRpc?.isHeliosBacked() && parsed.target.type === 'ens' && phase1EnsChunks.length > 0) {
          try {
            const heliosResolution = await resolveEns(parsed.target.name, heliosRpc)
            ensVerified = compareEnsChunks(heliosResolution.chunks, phase1EnsChunks)
            console.log('[w3] Mode 2 — ENS/GNS re-verification result:', ensVerified)
          } catch {
            ensVerified = undefined
          }
        }
        update = {
          type: 'verification-update',
          heliosBacked: false,
          trieVerified: trieVerified2,
          beaconVerified: true,
          beaconHeliosAnchored: beacon.heliosAnchored,
          beaconEraVerified: beacon.eraVerified,
          beaconStateHashVerified: beacon.stateHashVerified,
          ensVerified,
          proof: {
            url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txHash,
            txIndex: phase1TxIndex, contentType, payloadSize: formatBytes(assembled.length),
            chunks: proofChunks,
          },
        }
      } catch (beaconErr) {
        console.error('[w3] Mode 2 — beacon pipeline also failed:', beaconErr)
        update = {
          type: 'verification-update',
          heliosBacked: false, trieVerified: false,
          ensVerified,
          proof: {
            url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txHash,
            txIndex: phase1TxIndex, contentType, payloadSize: formatBytes(assembled.length),
            chunks: proofChunks,
          },
        }
      }
    } else {
      console.warn('[w3] Mode 1 failed and no fallback applies (not EIP-2935, or no consensus RPCs configured) — unverified')
      update = {
        type: 'verification-update',
        heliosBacked: false, trieVerified: false,
        ensVerified,
        proof: {
          url: rawUrl, blockNumber: phase1BlockNumber, blockHash: phase1BlockHash, txHash,
          txIndex: phase1TxIndex, contentType, payloadSize: formatBytes(assembled.length),
          chunks: proofChunks,
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
  let isEnsTarget = false
  try { isEnsTarget = parseWeb3URL(update.proof.url).target.type === 'ens' } catch {}
  const ensOk = !isEnsTarget || update.ensVerified === true
  const portalTrusted  = update.portalVerified === true && ensOk
  const heliosVerified = update.heliosBacked && update.trieVerified && ensOk
  const beaconTrusted  = update.beaconVerified && update.beaconHeliosAnchored && (update.trieVerified ?? false) && ensOk
  const fullyVerified  = heliosVerified || portalTrusted || beaconTrusted || update.localMode === true
  const color = fullyVerified ? '#3fb950' : '#d29922'
  const text = fullyVerified ? '✓' : '✗'
  // Final verdict, labeled by which VERIFICATION.md mode actually applies —
  // badge conditions match that doc's trust-boundary table exactly.
  const modeLabel = update.localMode ? 'Mode 4 — Local mode'
    : heliosVerified || update.heliosBacked ? 'Mode 1 — Recent block, Helios-verified'
    : portalTrusted || update.portalVerified ? 'Mode 3 — Portal-trusted'
    : update.beaconVerified ? 'Mode 2 — Historical block, beacon-verified'
    : 'no mode succeeded'
  console.log(`[w3] Badge verdict: ${modeLabel} → ${fullyVerified ? '✓ verified' : '✗ unverified'} (ensOk=${ensOk})`)
  // Tab may have been closed before verification finished — swallow the rejection.
  await Promise.allSettled([
    chrome.action.setBadgeText({ text, tabId }),
    chrome.action.setBadgeBackgroundColor({ color, tabId }),
  ])
  // Store flat object with all fields so popup.ts can read everything directly
  await chrome.storage.session.set({
    [`proof_${tabId}`]: {
      heliosBacked: ensOk ? update.heliosBacked : false,
      trieVerified: update.trieVerified,
      localMode: update.localMode ?? false,
      portalVerified: portalTrusted,
      beaconVerified: ensOk ? (update.beaconVerified ?? false) : false,
      beaconHeliosAnchored: ensOk ? (update.beaconHeliosAnchored ?? false) : false,
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
  if (msg.type === 'eth-rpc') {
    ethRpcCall(msg.chainId, msg.method, msg.params ?? []).then(sendResponse)
    return true
  }
  if (msg.type === 'warmup-helios' && msg.chainId) {
    chrome.storage.sync.get('chains').then(stored => {
      const chains = (stored.chains as Record<number, ChainConfig> | undefined) ?? DEFAULT_CHAINS
      const chain = chains[msg.chainId]
      if (chain && !chain.localMode) getOrCreateFreshRpc(chain)
    })
  }
  if (msg.type === 'helios-status' && msg.chainId) {
    sendResponse({
      ready: freshRpcReady.has(msg.chainId),
      syncing: freshRpcCache.has(msg.chainId) && !freshRpcReady.has(msg.chainId),
    })
    return true
  }
})

// Thin shell: deduplicates identical concurrent reads synchronously (before any
// await) so that wagmi's parallel hydration calls don't each spawn a separate
// Helios request. The shared Promise covers both the queued and live-Helios paths.
function ethRpcCall(chainId: number, method: string, params: unknown[]): Promise<{ result?: unknown; error?: string }> {
  if (method === 'eth_chainId') return Promise.resolve({ result: '0x' + chainId.toString(16) })
  if (method === 'net_version') return Promise.resolve({ result: String(chainId) })

  const cacheKey = `${chainId}:${method}:${JSON.stringify(params)}`
  const existing = heliosInflight.get(cacheKey)
  if (existing) return existing

  const p = _ethRpcCall(chainId, cacheKey, method, params)
  heliosInflight.set(cacheKey, p)
  p.finally(() => heliosInflight.delete(cacheKey))
  return p
}

async function _ethRpcCall(chainId: number, cacheKey: string, method: string, params: unknown[]): Promise<{ result?: unknown; error?: string }> {
  const stored = await chrome.storage.sync.get('chains')
  const chains = (stored.chains as Record<number, ChainConfig> | undefined) ?? DEFAULT_CHAINS
  const chain = chains[chainId]
  if (!chain) return { error: `No chain config for chainId ${chainId}` }

  // Local mode: no Helios — forward directly to the user's trusted execution RPC.
  // Also clear heliosSyncingSignaled so that if the user switches back to non-local
  // mode the badge is shown correctly (otherwise the stale flag suppresses it).
  if (chain.localMode) {
    heliosSyncingSignaled.delete(chain.chainId)
    try {
      const result = await new RpcClient(chain.rpcs.slice(0, 1)).request<unknown>(method, params)
      return { result }
    } catch (err: any) {
      return { error: (err as Error).message ?? String(err) }
    }
  }

  // Ensure Helios sync is in flight so freshRpcReady gets populated eventually.
  getOrCreateFreshRpc(chain)
  const rpc = freshRpcReady.get(chain.chainId)
  if (!rpc) {
    if (!heliosSyncingSignaled.has(chain.chainId)) {
      heliosSyncingSignaled.add(chain.chainId)
      chrome.runtime.sendMessage({ type: 'helios-syncing', chainId: chain.chainId }).catch(() => {})
    }
    // Queue this read — flushed as a batch once Helios is ready.
    // Timeout after 45s so message channels don't stay open indefinitely;
    // resolve with stale cache or error so the dapp can handle it gracefully.
    return new Promise<{ result?: unknown; error?: string }>(resolve => {
      const queue = pendingReads.get(chain.chainId) ?? []
      if (!pendingReads.has(chain.chainId)) pendingReads.set(chain.chainId, queue)
      queue.push(async (helios) => {
        const isCacheableQ = CACHEABLE_METHODS.has(method)
        const releaseQ = isCacheableQ ? null : await acquireEthCallSlot()
        try {
          const result = await helios.request<unknown>(method, params)
          if (isCacheableQ) {
            if (heliosReadCache.size >= MAX_READ_CACHE) heliosReadCache.delete(heliosReadCache.keys().next().value!)
            heliosReadCache.set(cacheKey, result)
          }
          resolve({ result })
        } catch (err: any) {
          resolve(heliosReadCache.has(cacheKey)
            ? { result: heliosReadCache.get(cacheKey) }
            : { error: (err as Error).message ?? String(err) })
        } finally {
          releaseQ?.()
        }
      })
    })
  }
  try {
    try {
      const isCacheable = CACHEABLE_METHODS.has(method)
      const release = isCacheable ? null : await acquireEthCallSlot()
      let result: unknown
      try {
        result = await rpc.request<unknown>(method, params)
      } finally {
        release?.()
      }
      if (isCacheable) {
        if (heliosReadCache.size >= MAX_READ_CACHE) heliosReadCache.delete(heliosReadCache.keys().next().value!)
        heliosReadCache.set(cacheKey, result)
      }
      return { result }
    } catch (innerErr: any) {
      if ((innerErr?.message ?? '').includes('out of sync')) {
        // Small lag: re-probe the existing instance — Helios usually self-heals and
        // freshRpcReady gets re-set once eth_blockNumber succeeds. Lag ≥ 30s means
        // the execution sync loop is in internal backoff and won't recover by probing;
        // evict (shutdown + delete, never delete alone — a leaked instance's polling
        // loops starve the SW event loop) so a fresh WASM starts immediately. Only
        // the first concurrent OOS caller does this (the rest see undefined !== rpc
        // once freshRpcReady is cleared).
        if (freshRpcReady.get(chain.chainId) === rpc) {
          const lagStr = (innerErr.message as string).match(/(\d+) seconds? behind/)?.[1] ?? '?'
          const lag = Number(lagStr)
          const forceRestart = lag >= 30
          console.warn(`[w3] Helios OOS (${lagStr}s behind)${forceRestart ? ' — forcing WASM restart' : ' — starting re-probe'}`)
          freshRpcReady.delete(chain.chainId)
          freshRpcCache.delete(chain.chainId)
          heliosSyncingSignaled.delete(chain.chainId)
          if (forceRestart) evictChainRpc(chain.chainId)
          getOrCreateFreshRpc(chain)
          chrome.runtime.sendMessage({ type: 'helios-oos', chainId: chain.chainId }).catch(() => {})
        }
        // Serve stale verified result if available.
        if (heliosReadCache.has(cacheKey)) return { result: heliosReadCache.get(cacheKey) }
        // Re-queue only small primitive reads (eth_blockNumber, eth_getBalance, …).
        // eth_call and similar can return megabytes; accumulating 20+ concurrent
        // callers on the same promise then flushing them all at once sends 20 copies
        // of large data to the renderer simultaneously → structured-clone OOM.
        // For large-result methods, return the OOS error now — wagmi will retry
        // automatically when helios-ready fires after the probe recovers.
        if (CACHEABLE_METHODS.has(method)) {
          return new Promise<{ result?: unknown; error?: string }>(resolve => {
            const queue = pendingReads.get(chain.chainId) ?? []
            if (!pendingReads.has(chain.chainId)) pendingReads.set(chain.chainId, queue)
            queue.push(async (helios) => {
              try {
                const result = await helios.request<unknown>(method, params)
                if (heliosReadCache.size >= MAX_READ_CACHE) heliosReadCache.delete(heliosReadCache.keys().next().value!)
                heliosReadCache.set(cacheKey, result)
                resolve({ result })
              } catch (err: any) {
                resolve(heliosReadCache.has(cacheKey)
                  ? { result: heliosReadCache.get(cacheKey) }
                  : { error: (err as Error).message ?? String(err) })
              }
            })
          })
        }
      }
      throw innerErr
    }
  } catch (err: any) {
    return { error: err.message ?? String(err) }
  }
}

async function listAvailableWallets(): Promise<Array<{ name: string; id: string }>> {
  const [direct, frame] = await Promise.all([
    listWallets(),
    isFrameAvailable(),
  ])
  return frame ? [...direct, { name: 'Frame', id: '__frame__' }] : direct
}

async function handleEthRequest(method: string, params: unknown[], walletId: string): Promise<unknown> {
  try {
    const result = walletId === '__frame__'
      ? await frameRequest(method, params)
      : await walletRequest(walletId, method, params)
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