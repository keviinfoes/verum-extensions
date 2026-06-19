// Unified historical block verification.
// Single chain: tx hash → execution block hash → era block roots (EIP-4788) → historical_summaries → Helios state root

import { sha256, getBytes, hexlify } from 'ethers'
import type { IVerifiedRpc } from './light-client.js'
import { computeBeaconStateRoot, computeBeaconBlockBodyRoot } from './ssz-state-verifier.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GENESIS: Record<number, number> = {
  1:        1606824023,
  11155111: 1655733600,
  17000:    1695902400,
}

const CAPELLA_ERA: Record<number, number> = {
  1:        758,   // mainnet CAPELLA_FORK_EPOCH 194048 / 256
  11155111: 222,   // sepolia CAPELLA_FORK_EPOCH 56832 / 256
  17000:    1,     // holesky CAPELLA_FORK_EPOCH 256 / 256
}

// Checkpoint sync providers serve gzip-compressed BeaconState via the same debug endpoint.
// Mainnet: ~136 MB compressed (vs ~313 MB uncompressed), ~39 s on a typical connection.
// These always serve the latest finalized state, so we request 'finalized' instead of a slot.
const CHECKPOINT_SYNC_RPCS: Record<number, string[]> = {
  1: [
    'https://beaconstate-mainnet.chainsafe.io',
    'https://beaconstate.ethstaker.cc',
    'https://mainnet.checkpoint.sigp.io',
  ],
  11155111: [
    'https://checkpoint-sync.sepolia.ethpandaops.io',
    'https://beaconstate-sepolia.chainsafe.io',
    'https://sepolia.beaconstate.info',
  ],
}

// Era file servers — serve .era files with HTTP range support.
// Format: {network}-{era:05d}-{hash:8hex}.era, directory listing at server root.
const ERA_SERVERS: Record<number, { baseUrl: string; network: string }[]> = {
  1:        [{ baseUrl: 'https://mainnet.era.nimbus.team', network: 'mainnet' }],
  11155111: [{ baseUrl: 'https://sepolia.era.nimbus.team', network: 'sepolia' }],
  17000:    [{ baseUrl: 'https://holesky.era.nimbus.team', network: 'holesky' }],
}
// Tail fetch: covers the full BlockIndex record (≤8192*8+24 = 65,560 B) + state entry header (8 B).
const ERA_TAIL_FETCH  = 70_000
// State fetch: last block (~≤200 KB compressed) + state header (8 B) + first N bytes of state data.
// block_roots start at SSZ byte 176, end at byte 262320 — snappy ratio ~1.5–2× → need ~400–500 KB compressed.
const ERA_STATE_FETCH = 700_000

export function timestampToSlot(timestamp: number, chainId: number): number {
  const genesis = GENESIS[chainId]
  if (!genesis) throw new Error(`No beacon genesis time for chain ${chainId}`)
  return Math.floor((timestamp - genesis) / 12)
}

function slotToTimestamp(slot: number, chainId: number): number {
  return GENESIS[chainId] + slot * 12
}

function historicalSummariesIndex(era: number, chainId: number): number {
  const idx = era - (CAPELLA_ERA[chainId] ?? 0)
  if (idx < 0) throw new Error(`Era ${era} is before Capella on chain ${chainId}`)
  return idx
}

// ---------------------------------------------------------------------------
// SSZ primitives
// ---------------------------------------------------------------------------

function readU32LE(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)
}

function readU24LE(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16)
}

function uint64LeBytes(n: bigint): Uint8Array {
  const b = new Uint8Array(32)
  let v = n
  for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n }
  return b
}

function sszMerkleize(chunks: Uint8Array[]): Uint8Array {
  let layer = chunks.map(c => c)
  while (layer.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < layer.length; i += 2) {
      const pair = new Uint8Array(64)
      pair.set(layer[i], 0)
      pair.set(layer[i + 1] ?? new Uint8Array(32), 32)
      next.push(getBytes(sha256(pair)))
    }
    layer = next
  }
  return layer[0]
}

function computeEraBlockSummaryRoot(roots: Uint8Array[]): string {
  const leaves = Array.from({ length: 8192 }, (_, i) => roots[i] ?? new Uint8Array(32))
  return hexlify(sszMerkleize(leaves))
}

// ---------------------------------------------------------------------------
// Beacon block header helpers
// ---------------------------------------------------------------------------

interface BeaconHeaderMsg {
  slot: string; proposer_index: string
  parent_root: string; state_root: string; body_root: string
}

function beaconHeaderRoot(msg: BeaconHeaderMsg): string {
  const leaves: Uint8Array[] = [
    uint64LeBytes(BigInt(msg.slot)),
    uint64LeBytes(BigInt(msg.proposer_index)),
    getBytes(msg.parent_root),
    getBytes(msg.state_root),
    getBytes(msg.body_root),
    new Uint8Array(32), new Uint8Array(32), new Uint8Array(32),
  ]
  return hexlify(sszMerkleize(leaves))
}

async function fetchVerifiedBeaconHeader(
  rpc: string,
  id: number | string,
): Promise<{ root: string; stateRoot: string; msg: BeaconHeaderMsg }> {
  const res = await fetch(`${rpc}/eth/v1/beacon/headers/${id}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Beacon header ${id} from ${rpc}: HTTP ${res.status}`)
  const json = await res.json() as { data: { root: string; header: { message: BeaconHeaderMsg } } }
  const msg = json.data.header.message
  const computed = beaconHeaderRoot(msg)
  if (computed.toLowerCase() !== json.data.root.toLowerCase())
    throw new Error(`Beacon header ${id}: SSZ root mismatch — tampered response`)
  return { root: json.data.root, stateRoot: msg.state_root, msg }
}

async function fetchVerifyBeaconBodyHash(
  rpc: string,
  slot: number,
  expectedBodyRoot: string,
): Promise<string> {
  // AbortSignal.timeout() is broken in Chrome MV3 service workers; use fetchWithTimeout.
  const res = await fetchWithTimeout(
    `${rpc}/eth/v2/beacon/blocks/${slot}`,
    { headers: { Accept: 'application/octet-stream' } },
    30_000,
  )
  if (!res.ok) throw new Error(`Beacon block SSZ ${slot} from ${rpc}: HTTP ${res.status}`)
  const blob = new Uint8Array(await res.arrayBuffer())
  if (blob.length < 104) throw new Error('SignedBeaconBlock SSZ too short')
  const blockSSZ = blob.slice(readU32LE(blob, 0))
  if (blockSSZ.length < 84) throw new Error('BeaconBlock SSZ too short')
  const bodySSZ = blockSSZ.slice(readU32LE(blockSSZ, 80))
  const { computedRoot, executionBlockHash } = computeBeaconBlockBodyRoot(bodySSZ)
  if (computedRoot.toLowerCase() !== expectedBodyRoot.toLowerCase())
    throw new Error(`Body root mismatch at slot ${slot}: got ${computedRoot} ≠ ${expectedBodyRoot}`)
  return executionBlockHash
}

// ---------------------------------------------------------------------------
// Step 1: Helios anchor — get finalized state root
// ---------------------------------------------------------------------------

// EIP-4788 ring buffer contract — same address on all chains post-Cancun
const EIP4788_CONTRACT = '0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02'

// Fast consensus anchor — does not need Helios. Helios is checked separately at the end
// of verifyViaBeacon so it can run in parallel with the full verification pipeline.
async function getAnchorStateRoot(
  consensusRpcs: string[],
): Promise<{ slot: number; stateRoot: string; blockRoot: string }> {
  for (const rpc of consensusRpcs) {
    try {
      const { root, stateRoot, msg } = await fetchVerifiedBeaconHeader(rpc, 'finalized')
      console.log(`[portal] Consensus anchor: slot ${msg.slot} via ${rpc}`)
      return { slot: Number(msg.slot), stateRoot, blockRoot: root }
    } catch { /* try next */ }
  }
  throw new Error('Could not acquire beacon chain anchor from any consensus RPC')
}

// After all other verification steps complete, confirm the effective state root used
// during verification against the Helios-proven finalized state root. Helios ran in
// parallel; by the time we call this it may already be resolved.
async function confirmWithHelios(
  heliosRpc: IVerifiedRpc,
  consensusRpcs: string[],
  effectiveStateRoot: string,
  effectiveSlot: number,
): Promise<boolean> {
  if (!heliosRpc.isHeliosBacked()) return false
  try {
    // Get Helios-proven finalized beacon root via EIP-4788 (or parentBeaconBlockRoot)
    const block = await heliosRpc.request<{ parentBeaconBlockRoot?: string; timestamp?: string }>(
      'eth_getBlockByNumber', ['finalized', false],
    )
    let beaconRoot = block.parentBeaconBlockRoot
    if (!beaconRoot && block.timestamp) {
      const ts = parseInt(block.timestamp, 16)
      const calldata = '0x' + ts.toString(16).padStart(64, '0')
      try {
        const result = await heliosRpc.request<string>(
          'eth_call', [{ to: EIP4788_CONTRACT, data: calldata }, 'finalized'],
        )
        if (result && result !== '0x' && result !== '0x' + '0'.repeat(64)) {
          beaconRoot = result.length === 66 ? result : ('0x' + result.slice(-64))
          console.log('[portal] EIP-4788 contract beacon root:', beaconRoot)
        }
      } catch (e) {
        console.warn('[portal] EIP-4788 contract call failed:', (e as Error).message)
      }
    }
    if (!beaconRoot) return false

    for (const rpc of consensusRpcs) {
      try {
        const { root: heliosBlockRoot, stateRoot: heliosStateRoot, msg } = await fetchVerifiedBeaconHeader(rpc, beaconRoot)
        const heliosSlot = Number(msg.slot)
        console.log(`[portal] Helios EIP-4788 anchor: slot ${heliosSlot} state_root ${heliosStateRoot}`)

        // Case 1: same slot — direct comparison
        if (heliosStateRoot.toLowerCase() === effectiveStateRoot.toLowerCase()) {
          console.log('[portal] Helios confirmed effective state root ✓')
          return true
        }

        // Case 2: Helios is N slots behind effective state. Walk backward from effectiveSlot
        // via parent_root until we reach heliosBlockRoot, verifying state_root at the top.
        if (heliosSlot < effectiveSlot) {
          try {
            const { msg: effMsg } = await fetchVerifiedBeaconHeader(rpc, effectiveSlot)
            if (effMsg.state_root.toLowerCase() === effectiveStateRoot.toLowerCase()) {
              let parentRoot = effMsg.parent_root
              for (let step = 0; step < 200; step++) {
                if (parentRoot.toLowerCase() === heliosBlockRoot.toLowerCase()) {
                  console.log(`[portal] Helios confirmed via ${effectiveSlot - heliosSlot}-slot walk (effective→helios) ✓`)
                  return true
                }
                const { root: fr, msg: pm } = await fetchVerifiedBeaconHeader(rpc, parentRoot)
                if (fr.toLowerCase() !== parentRoot.toLowerCase()) break
                if (Number(pm.slot) < heliosSlot) break
                parentRoot = pm.parent_root
              }
            }
          } catch { /* try next RPC */ }
        }

        // Case 3: Helios is N slots ahead of effective state. Walk backward from heliosSlot
        // via parent_root until we land on effectiveSlot and confirm its state_root.
        if (heliosSlot > effectiveSlot) {
          try {
            let parentRoot = msg.parent_root
            for (let step = 0; step < 200; step++) {
              const { root: fr, msg: pm } = await fetchVerifiedBeaconHeader(rpc, parentRoot)
              if (fr.toLowerCase() !== parentRoot.toLowerCase()) break
              const s = Number(pm.slot)
              if (s === effectiveSlot) {
                if (pm.state_root.toLowerCase() === effectiveStateRoot.toLowerCase()) {
                  console.log(`[portal] Helios confirmed via ${heliosSlot - effectiveSlot}-slot walk (helios→effective) ✓`)
                  return true
                }
                break
              }
              if (s < effectiveSlot) break
              parentRoot = pm.parent_root
            }
          } catch { /* try next RPC */ }
        }

        console.warn(`[portal] Helios state root mismatch: helios=${heliosStateRoot} effective=${effectiveStateRoot} (slots: helios=${heliosSlot} effective=${effectiveSlot})`)
        return false
      } catch { /* try next RPC */ }
    }
  } catch (err) {
    console.warn('[portal] Helios confirmation failed:', (err as Error).message)
  }
  return false
}

// ---------------------------------------------------------------------------
// Step 2: Download finalized BeaconState → verify hash_tree_root → extract
//         historical_summaries[era].block_summary_root
// ---------------------------------------------------------------------------

interface StateSummary {
  blockSummaryRoot: string
  effectiveStateRoot: string
  effectiveSlot: number
  blockRootAtSlot?: string  // block_roots[targetSlot % 8192] if within the rolling window
}

// Downloads the finalized BeaconState, verifies its SSZ hash, and extracts
// historical_summaries[hsIndex].block_summary_root. Also reads block_roots[targetSlot % 8192]
// directly from the authenticated state when the target slot is within the 8192-slot window.
async function getBlockSummaryRoot(
  consensusRpcs: string[],
  anchorSlot: number,
  anchorStateRoot: string,
  hsIndex: number,
  era: number,
  chainId: number,
  targetSlot: number,
): Promise<StateSummary> {
  const ctrl = new AbortController()

  const attempt = async (rpc: string, stateId: number | 'finalized'): Promise<StateSummary> => {
    const label = stateId === 'finalized' ? 'finalized (checkpoint)' : `slot ${stateId}`
    console.log(`[portal] Fetching state (${label}) from ${rpc}…`)
    const res = await fetch(`${rpc}/eth/v2/debug/beacon/states/${stateId}`, {
      headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'gzip' },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const stateSSZ = new Uint8Array(await res.arrayBuffer())
    const verifier = computeBeaconStateRoot(stateSSZ)

    // slot is at byte 40 of BeaconState SSZ (genesis_time[8] + genesis_validators_root[32])
    const stateSlot = readU32LE(stateSSZ, 40)

    if (verifier.computedRoot.toLowerCase() !== anchorStateRoot.toLowerCase()) {
      console.log(`[portal] State slot=${stateSlot} anchorSlot=${anchorSlot} diff=${stateSlot - anchorSlot} — Helios will confirm at end`)
    } else {
      console.log(`[portal] State hash_tree_root matches anchor ✓ (slot ${stateSlot}, from ${rpc})`)
    }

    // Fast path: if target slot is within the rolling block_roots window of this state,
    // read block_roots[targetSlot % 8192] directly (authenticated by hash_tree_root(BeaconState)).
    let blockRootAtSlot: string | undefined
    if (stateSlot >= targetSlot && stateSlot - targetSlot < 8192) {
      const root = verifier.getBlockRootAtSlot(targetSlot)
      if (!/^0x0+$/.test(root)) {
        blockRootAtSlot = root
        console.log(`[portal] block_roots[${targetSlot % 8192}] from BeaconState: ${root}`)
      }
    }

    const blockSummaryRoot = verifier.getBlockSummaryRoot(hsIndex)
    if (!blockSummaryRoot && !blockRootAtSlot)
      throw new Error(`historical_summaries[${hsIndex}] (era ${era}) not found and slot not in rolling window`)
    if (blockSummaryRoot)
      console.log(`[portal] historical_summaries[${hsIndex}] (era ${era}) block_summary_root: ${blockSummaryRoot}`)
    return { blockSummaryRoot: blockSummaryRoot ?? '', effectiveStateRoot: verifier.computedRoot, effectiveSlot: stateSlot, blockRootAtSlot }
  }

  const checkpointRpcs = CHECKPOINT_SYNC_RPCS[chainId] ?? []

  // Checkpoint providers first (gzip, ~39s mainnet), consensus RPCs as fallback.
  // Stagger 3s between each start: a fast failure (CORS, 404) triggers the next
  // almost immediately while a slow download stays solo to avoid parallel bloat.
  const ordered = [
    ...checkpointRpcs.map(rpc => () => attempt(rpc, 'finalized')),
    ...consensusRpcs.map(rpc => () => attempt(rpc, anchorSlot)),
  ]

  const staggered = ordered.map((fn, i): Promise<StateSummary> => {
    if (i === 0) return fn()
    return new Promise<StateSummary>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (ctrl.signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
        fn().then(resolve, reject)
      }, i * 3000)
      ctrl.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
  })

  try {
    const result = await Promise.any(
      staggered.map(p =>
        p.catch(err => {
          if ((err as DOMException).name !== 'AbortError')
            console.warn('[portal] State fetch failed:', (err as Error).message)
          throw err
        }),
      ),
    )
    ctrl.abort()
    return result
  } catch {
    throw new Error('Could not fetch and verify finalized state from any consensus RPC or checkpoint provider')
  }
}

// ---------------------------------------------------------------------------
// Step 3: Fetch ~8192 execution block headers (EIP-4788 parentBeaconBlockRoot)
//         → build block_roots vector → verify sszMerkleize == block_summary_root
// ---------------------------------------------------------------------------

interface ExecBlockHeader {
  number: string
  timestamp: string
  parentBeaconBlockRoot?: string
}

// AbortSignal.timeout() is broken in Chrome MV3 service workers; use AbortController + setTimeout.
function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController()
  const id = setTimeout(() => ctrl.abort(), ms)
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(id))
}

async function execRpcCall(rpcs: string[], body: object): Promise<unknown> {
  let lastErr: unknown
  for (const rpc of rpcs) {
    try {
      const res = await fetchWithTimeout(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 8000)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) { lastErr = err }
  }
  throw lastErr ?? new Error('All exec RPCs failed')
}

// Fetches a single block by number, trying each RPC until one returns a non-null result.
// Unlike execRpcCall, a null result is treated as "try next RPC" — needed when RPCs
// return null due to rate limiting rather than the block not existing.
async function fetchExecBlock(rpcs: string[], blockNum: number): Promise<ExecBlockHeader | null> {
  const delays = [0, 800, 1600]
  for (const delay of delays) {
    if (delay > 0) await new Promise(r => setTimeout(r, delay))
    for (const rpc of rpcs) {
      try {
        const res = await fetchWithTimeout(rpc, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'eth_getBlockByNumber',
            params: ['0x' + blockNum.toString(16), false], id: 0,
          }),
        }, 8000)
        if (!res.ok) continue
        const json = await res.json() as { result: ExecBlockHeader | null }
        if (json.result != null) return json.result
      } catch { /* try next */ }
    }
  }
  return null
}

// Returns null if no RPC supports batch (response not an array).
async function execBatch(rpcs: string[], requests: object[]): Promise<{ result?: ExecBlockHeader }[] | null> {
  for (const rpc of rpcs) {
    try {
      const res = await fetchWithTimeout(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requests),
      }, 12000)
      if (!res.ok) continue
      const json = await res.json()
      if (Array.isArray(json)) return json as { result?: ExecBlockHeader }[]
    } catch { /* try next */ }
  }
  return null
}

async function findEraFirstBlockNumber(
  execRpcs: string[],
  eraStartSlot: number,
  chainId: number,
): Promise<number> {
  // First exec block we need: slot eraStartSlot+1 (its pbbr = block_roots[0]).
  // process_slot(S) stores hash_tree_root(latest_block_header) — which was updated by
  // process_block(S-1) before this call — so block_roots[S%8192] = root of last non-missed
  // block at or before slot S.  pbbr of exec at slot S = block_roots[(S-1)%8192], hence
  // block_roots[k] = pbbr of exec at slot eraStartSlot+k+1.
  const targetTs = slotToTimestamp(eraStartSlot + 1, chainId)

  const anchorJson = await execRpcCall(execRpcs, {
    jsonrpc: '2.0', method: 'eth_getBlockByNumber', params: ['latest', false], id: 0,
  }) as { result: ExecBlockHeader }
  const anchorNum = parseInt(anchorJson.result.number, 16)
  const anchorTs  = parseInt(anchorJson.result.timestamp, 16)

  const estimatedOffset = Math.round((anchorTs - targetTs) / 12)
  // lo: era cannot start more than 2× slot-count blocks ago (safe at any miss rate < 50%).
  // hi: latest block — guaranteed upper bound, avoids any miss-rate arithmetic that would
  //     under-shoot on testnets with high missed-slot rates.
  let lo = Math.max(0, anchorNum - estimatedOffset * 2)
  let hi = anchorNum

  console.log(`[portal] findEraFirst: anchorNum=${anchorNum} estimatedOffset=${estimatedOffset} lo=${lo}`)

  // Binary search for first block with timestamp >= targetTs (~log2(estimatedOffset*2) ≈ 17 steps)
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const r = await execRpcCall(execRpcs, {
      jsonrpc: '2.0', method: 'eth_getBlockByNumber', params: ['0x' + mid.toString(16), false], id: 0,
    }) as { result: ExecBlockHeader | null }
    if (!r.result) { lo = mid + 1; continue }
    parseInt(r.result.timestamp, 16) < targetTs ? (lo = mid + 1) : (hi = mid)
  }
  return lo
}

async function fetchEraBlockRootsFromExecHeaders(
  execRpcs: string[],
  era: number,
  chainId: number,
  expectedBlockSummaryRoot: string,
  startNum: number,
): Promise<Uint8Array[]> {
  const eraStartSlot = era * 8192
  // block_roots[k] = pbbr of exec block at slot eraStartSlot+k, for k in [0, 8192).
  // eraEndTs is the start of the first slot of the NEXT era; >= excludes it.
  const eraEndTs = slotToTimestamp(eraStartSlot + 8192, chainId)

  // Enough to cover 8192 non-missed slots even at 25% miss rate (8192/0.75 ≈ 10924) + buffer
  const endNum = startNum + 11200

  const startTsCheck = slotToTimestamp(eraStartSlot + 1, chainId)
  console.log(`[portal] Era ${era}: startNum=${startNum} targetTs=${startTsCheck} eraEndTs=${eraEndTs}`)
  console.log(`[portal] Era ${era}: fetching exec headers ${startNum}–${endNum}…`)

  const rawRoots = new Array<Uint8Array | null>(8192).fill(null)
  const BATCH = 50
  const CONCURRENCY = 1  // serial batches avoid burst rate-limits on free-tier RPCs

  const batches: number[] = []
  for (let n = startNum; n <= endNum; n += BATCH) batches.push(n)

  let cntNull = 0, cntPreEra = 0, cntInEra = 0, cntNoRoot = 0, cntPostEra = 0
  let eraCovered = false
  let firstInEraLogged = false

  const processItem = (b: ExecBlockHeader | undefined) => {
    if (!b?.timestamp) { cntNull++; return }
    const ts = parseInt(b.timestamp, 16)
    if (ts > eraEndTs) {
      if (!eraCovered) {
        const postSlot = timestampToSlot(ts, chainId)
        console.log(`[portal] eraCovered: first postEra block execNum=${b.number} ts=${ts} slot=${postSlot} (eraEndTs=${eraEndTs})`)
      }
      cntPostEra++; eraCovered = true; return
    }
    const slot = timestampToSlot(ts, chainId)
    const j = slot - eraStartSlot - 1
    if (j < 0) { cntPreEra++; return }
    if (j >= 8192) return
    cntInEra++
    if (b.parentBeaconBlockRoot) {
      rawRoots[j] = getBytes(b.parentBeaconBlockRoot)
      if (!firstInEraLogged) {
        firstInEraLogged = true
        console.log(`[portal] firstInEra: execNum=${b.number} ts=${ts} slot=${slot} j=${j} pbbr=${b.parentBeaconBlockRoot}`)
      }
    } else cntNoRoot++
  }

  const fetchBlocksIndividually = async (nums: number[], concurrency: number): Promise<void> => {
    const inflight = new Set<Promise<void>>()
    for (const n of nums) {
      const p: Promise<void> = (async () => {
        const block = await fetchExecBlock(execRpcs, n)
        processItem(block ?? undefined)
      })().then(() => { inflight.delete(p) })
      inflight.add(p)
      if (inflight.size >= concurrency) await Promise.race(inflight)
    }
    await Promise.all([...inflight])
  }

  let firstBatch = true
  const runBatch = async (batchStart: number): Promise<void> => {
    if (eraCovered) return
    const blockNums = Array.from({ length: BATCH }, (_, i) => batchStart + i)
    const requests = blockNums.map((n, i) => ({
      jsonrpc: '2.0', method: 'eth_getBlockByNumber',
      params: ['0x' + n.toString(16), false], id: i,
    }))
    const results = await execBatch(execRpcs, requests)
    if (results) {
      if (firstBatch) {
        firstBatch = false
        console.log(`[portal] first batch: array len=${results.length}/${requests.length}, nulls=${results.filter(r => !r.result).length}`)
      }

      const retryNums: number[] = []
      const byId = new Map<number, ExecBlockHeader | null>()
      for (const item of results) {
        const id = (item as { id?: number }).id
        if (typeof id === 'number') byId.set(id, item.result ?? null)
      }
      if (byId.size > 0) {
        for (const [id, result] of byId.entries()) {
          if (result != null) processItem(result)
          else retryNums.push(blockNums[id])
        }
        for (let i = 0; i < blockNums.length; i++) {
          if (!byId.has(i)) retryNums.push(blockNums[i])
        }
      } else {
        // Positional path: null results must be retried, not silently dropped
        for (let i = 0; i < results.length; i++) {
          if (results[i].result != null) processItem(results[i].result)
          else retryNums.push(blockNums[i])
        }
        for (let i = results.length; i < blockNums.length; i++) {
          retryNums.push(blockNums[i])
        }
      }
      if (retryNums.length > 0) {
        console.log(`[portal] Batch ${batchStart}: re-fetching ${retryNums.length}`)
        await fetchBlocksIndividually(retryNums, 2)
      }
    } else {
      if (firstBatch) { firstBatch = false; console.log('[portal] first batch: execBatch returned null (fallback mode)') }
      await fetchBlocksIndividually(blockNums, 2)
    }
  }

  const inFlight = new Set<Promise<void>>()
  for (const batchStart of batches) {
    if (eraCovered) break
    const p: Promise<void> = runBatch(batchStart).then(() => { inFlight.delete(p) })
    inFlight.add(p)
    if (inFlight.size >= CONCURRENCY) await Promise.race(inFlight)
  }
  await Promise.all([...inFlight])

  // Forward-fill missed slots. First non-null value seeds leading nulls — it IS the correct
  // pre-era root because parentBeaconBlockRoot propagates the last non-missed block root.
  // Backward-fill: rawRoots[k]=null means slot eraStartSlot+k+1 was missed; the correct
  // block_roots[k] is the root of the last non-missed block at or before eraStartSlot+k,
  // which equals rawRoots[k+m] (next non-null to the right), NOT rawRoots[k-1].
  const seed = rawRoots.findLast(r => r !== null) ?? new Uint8Array(32)
  const roots: Uint8Array[] = new Array(8192)
  let last = seed
  for (let j = 8191; j >= 0; j--) {
    if (rawRoots[j] !== null) last = rawRoots[j]!
    roots[j] = last
  }

  const filled = rawRoots.filter(r => r === null).length
  const nonNull = 8192 - filled
  console.log(`[portal] Era ${era}: preEra=${cntPreEra} inEra=${cntInEra} noRoot=${cntNoRoot} postEra=${cntPostEra} null=${cntNull}`)
  console.log(`[portal] Era ${era}: ${nonNull} exec headers fetched (rawRoots), ${filled} backward-filled`)
  console.log(`[portal] rawRoots[0]=${rawRoots[0] ? hexlify(rawRoots[0]) : 'null'} rawRoots[8191]=${rawRoots[8191] ? hexlify(rawRoots[8191]) : 'null'}`)
  console.log(`[portal] roots[0]=${hexlify(roots[0])} roots[8191]=${hexlify(roots[8191])}`)

  const computed = computeEraBlockSummaryRoot(roots)
  if (computed.toLowerCase() !== expectedBlockSummaryRoot.toLowerCase())
    throw new Error(
      `Era ${era}: computed block_summary_root ${computed} ≠ historical_summaries value ${expectedBlockSummaryRoot}`,
    )
  console.log(`[portal] Era ${era}: block_roots Merkle root verified against historical_summaries ✓`)
  return roots
}

// ---------------------------------------------------------------------------
// Era file: snappy decompressor + range-request downloader
// ---------------------------------------------------------------------------

// Raw snappy block decompressor (no framing). maxOut limits allocation — avoids OOM
// when the full uncompressed size (encoded in preamble varint) is hundreds of MB.
function snappyDecompressBlock(src: Uint8Array, maxOut?: number): Uint8Array {
  let s = 0
  let uLen = 0, shift = 0
  while (s < src.length) {
    const b = src[s++]
    uLen |= (b & 0x7f) << shift
    if (!(b & 0x80)) break
    shift += 7
  }
  const limit = maxOut !== undefined ? Math.min(uLen, maxOut) : uLen
  const dst = new Uint8Array(limit)
  let d = 0
  while (s < src.length && d < limit) {
    const tag = src[s++]
    switch (tag & 0x3) {
      case 0: { // literal
        const f = tag >> 2
        let len: number
        if (f < 60)        { len = f + 1 }
        else if (f === 60) { len = src[s++] + 1 }
        else if (f === 61) { len = (src[s] | (src[s + 1] << 8)) + 1; s += 2 }
        else if (f === 62) { len = (src[s] | (src[s + 1] << 8) | (src[s + 2] << 16)) + 1; s += 3 }
        else               { len = (src[s] | (src[s + 1] << 8) | (src[s + 2] << 16) | (src[s + 3] << 24)) + 1; s += 4 }
        const copy = Math.min(len, limit - d)
        dst.set(src.subarray(s, s + copy), d)
        s += len; d += copy; break
      }
      case 1: { // copy 1-byte offset  (len in [4,11], offset 11-bit)
        const len = ((tag >> 2) & 0x7) + 4
        const off = ((tag >> 5) << 8) | src[s++]
        const n = Math.min(len, limit - d)
        for (let i = 0; i < n; i++) dst[d + i] = dst[d - off + i]
        d += n; break
      }
      case 2: { // copy 2-byte offset
        const len = ((tag >> 2) & 0x3f) + 1
        const off = src[s] | (src[s + 1] << 8); s += 2
        const n = Math.min(len, limit - d)
        for (let i = 0; i < n; i++) dst[d + i] = dst[d - off + i]
        d += n; break
      }
      case 3: { // copy 4-byte offset
        const len = ((tag >> 2) & 0x3f) + 1
        const off = src[s] | (src[s + 1] << 8) | (src[s + 2] << 16) | (src[s + 3] << 24); s += 4
        const n = Math.min(len, limit - d)
        for (let i = 0; i < n; i++) dst[d + i] = dst[d - off + i]
        d += n; break
      }
    }
  }
  return dst
}

// Snappy framing-format decompressor. Stops once `need` uncompressed bytes are produced.
// Frame format: type(1) + length(3 LE) + [crc32c(4) +] payload
function snappyFramedDecompress(data: Uint8Array, need: number): Uint8Array {
  const out = new Uint8Array(need)
  let pos = 0, s = 0
  while (s + 4 <= data.length && pos < need) {
    const chunkType = data[s]
    const chunkLen  = readU24LE(data, s + 1)
    s += 4
    if (s + chunkLen > data.length) break  // incomplete chunk — stop here
    if (chunkType === 0xff) {
      // stream identifier — skip ("sNaPpY")
    } else if (chunkType === 0x00 && chunkLen > 4) {
      // compressed data: skip 4-byte masked CRC, then raw snappy block
      const block = snappyDecompressBlock(data.subarray(s + 4, s + chunkLen))
      const n = Math.min(block.length, need - pos)
      out.set(block.subarray(0, n), pos); pos += n
    } else if (chunkType === 0x01 && chunkLen > 4) {
      // uncompressed data: skip 4-byte masked CRC
      const n = Math.min(chunkLen - 4, need - pos)
      out.set(data.subarray(s + 4, s + 4 + n), pos); pos += n
    }
    // 0xfe = padding, 0x80-0xfd = skippable — just skip
    s += chunkLen
  }
  return out
}

// Era filename convention: {network}-{era:05d}-{hash:8hex}.era
// The 8-char hash comes from a server-specific derivation we don't fully control, so we
// first try the directory listing to find the exact filename, then fall back to the
// block_summary_root-derived guess (first 4 bytes of the root).
async function findEraFileUrls(era: number, chainId: number, blockSummaryRoot: string): Promise<string[]> {
  const servers = ERA_SERVERS[chainId] ?? []
  const eraStr = era.toString().padStart(5, '0')
  const urls: string[] = []

  for (const { baseUrl, network } of servers) {
    // Primary: directory listing gives the exact filename
    try {
      const res = await fetchWithTimeout(baseUrl + '/', {}, 8000)
      if (res.ok) {
        const html = await res.text()
        const m = html.match(new RegExp(`${network}-${eraStr}-[0-9a-f]{8}\\.era`, 'i'))
        if (m) { urls.push(`${baseUrl}/${m[0]}`); continue }
      }
    } catch { /* fall through to guess */ }
    // Fallback: derive hash from block_summary_root (first 4 bytes)
    urls.push(`${baseUrl}/${network}-${eraStr}-${blockSummaryRoot.slice(2, 10)}.era`)
  }

  return urls
}

// e2store entry type codes used in era files
const E2S_BLOCK = 0x0001  // bytes [0x01,0x00] → LE uint16 = 0x0001
const E2S_STATE = 0x0002  // bytes [0x02,0x00] → LE uint16 = 0x0002

// SSZ layout of BeaconState (fixed fields before block_roots):
//   genesis_time(8) + genesis_validators_root(32) + slot(8) + fork(16) +
//   latest_block_header(112) = 176 bytes, then block_roots Vector[Root,8192] = 262144 bytes
const BLOCK_ROOTS_SSZ_OFFSET = 176
const BLOCK_ROOTS_SSZ_LEN    = 8192 * 32  // 262144

// Signed int64 LE → JS number. Safe for any value < 2^53 (i.e. any file ≤ 8 PB).
function readI64LE(buf: Uint8Array, off: number): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return Number(dv.getBigInt64(off, true))
}

// Single era HTTP range fetch. Returns buf + file size (from Content-Range); null on failure.
async function eraFetch(
  url: string, range: string, ms: number,
): Promise<{ buf: Uint8Array; fileSize: number } | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const r = await fetch(url, { headers: { Range: range }, signal: ctrl.signal })
    if (!r.ok && r.status !== 206) return null
    const m = r.headers.get('Content-Range')?.match(/bytes \d+-\d+\/(\d+)/)
    const fileSize = m ? parseInt(m[1]) : 0
    const buf = new Uint8Array(await r.arrayBuffer())
    return { buf, fileSize }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Uses two targeted range requests to extract block_roots from an era file:
//   1. Tail (≤70 KB) → read BlockIndex → locate last block's absolute file offset
//   2. From last block header (≤700 KB) → skip block data → read state entry → decompress
async function fetchEraBlockRootsFromEraFile(
  era: number,
  chainId: number,
  expectedBlockSummaryRoot: string,
): Promise<Uint8Array[] | null> {
  const urls = await findEraFileUrls(era, chainId, expectedBlockSummaryRoot)
  if (!urls.length) return null

  for (const url of urls) {
    try {
      const roots = await tryEraUrl(url, era, expectedBlockSummaryRoot)
      if (roots) return roots
    } catch (e) {
      console.warn(`[portal] Era ${era}: ${url} → ${(e as Error).message}`)
    }
  }
  return null
}

async function tryEraUrl(
  url: string, era: number, expectedBlockSummaryRoot: string,
): Promise<Uint8Array[] | null> {
  // ── Step 1: tail fetch to locate state entry ────────────────────────────────
  // Era file layout: [Version][Blocks era N-1][BeaconState][BlockIndex era N-1][StateRef era N]
  // The LAST record is a 1-entry index (type 0x3269, count=1) whose single offset points
  // to the BeaconState.  All offsets use the convention:
  //   offset[j] = (dataAbsPos + 8) − offsetFieldAbsPos   (signed, relative to field)
  // So:  stateDataAbsPos  = offsetFieldAbsPos + offsetVal − 8
  //      stateHeaderAbsPos = stateDataAbsPos − 8  (the 8-byte e2store header)
  console.log(`[portal] Era ${era}: tail fetch (${ERA_TAIL_FETCH >> 10}KB) from ${url}`)
  const tail = await eraFetch(url, `bytes=-${ERA_TAIL_FETCH}`, 30_000)
  if (!tail) { console.warn(`[portal] Era ${era}: tail fetch failed`); return null }
  const { buf: tailBuf, fileSize } = tail
  if (!fileSize) { console.warn(`[portal] Era ${era}: no Content-Range, cannot locate state`); return null }

  // The last 8 bytes of the file = count field of the trailing StateRef record (always 1 per era)
  const count = readU32LE(tailBuf, tailBuf.length - 8)
  if (count === 0 || count > 8192) {
    console.warn(`[portal] Era ${era}: invalid tail count ${count}`); return null
  }
  // StateRef record = 8 (e2store header) + 8 (start_slot) + count×8 (offsets) + 8 (count)
  const stateRefRecordSize = count * 8 + 24
  const srTailStart = tailBuf.length - stateRefRecordSize

  // Parse offset[0] — points to (stateDataAbsPos + 8), relative to its own file position
  const srDataStart   = srTailStart + 8              // past e2store header
  const offsetInTail  = srDataStart + 8              // past start_slot
  const offsetVal     = readI64LE(tailBuf, offsetInTail)
  const offsetAbsPos  = (fileSize - tailBuf.length) + offsetInTail
  const stateHeaderAbsPos = offsetAbsPos + offsetVal - 16  // = dataAbsPos + 8 − 8 − 8

  if (stateHeaderAbsPos <= 0 || stateHeaderAbsPos >= fileSize) {
    console.warn(`[portal] Era ${era}: bad stateHeaderAbsPos=${stateHeaderAbsPos}`); return null
  }
  console.log(`[portal] Era ${era}: count=${count} stateHeaderAbsPos=${stateHeaderAbsPos}`)

  // ── Step 2: fetch state entry (header + compressed data) ─────────────────────
  const fetchEnd = Math.min(stateHeaderAbsPos + ERA_STATE_FETCH - 1, fileSize - 1)
  console.log(`[portal] Era ${era}: state fetch bytes ${stateHeaderAbsPos}–${fetchEnd}`)
  const sf = await eraFetch(url, `bytes=${stateHeaderAbsPos}-${fetchEnd}`, 120_000)
  if (!sf) { console.warn(`[portal] Era ${era}: state fetch failed`); return null }
  const stateBuf = sf.buf

  // Parse state e2store header (8 bytes: type(2) + length(6))
  if (stateBuf.length < 8) { console.warn(`[portal] Era ${era}: state fetch too small`); return null }
  const stateType = stateBuf[0] | (stateBuf[1] << 8)
  if (stateType !== E2S_STATE) {
    const hex16 = Array.from(stateBuf.subarray(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')
    console.warn(`[portal] Era ${era}: expected state (0x${E2S_STATE.toString(16)}), got 0x${stateType.toString(16)} — first 16B: ${hex16}`)
    return null
  }
  const stateDataLen = readU32LE(stateBuf, 2)
  const stateData    = stateBuf.subarray(8)
  console.log(`[portal] Era ${era}: state compressed=${stateDataLen}B fetched ${stateData.length}B`)

  // ── Step 3: decompress and extract block_roots ───────────────────────────────
  const need = BLOCK_ROOTS_SSZ_OFFSET + BLOCK_ROOTS_SSZ_LEN  // 262320 bytes

  const isFramed = stateData.length >= 6 &&
    stateData[0] === 0xff && stateData[1] === 0x06 &&
    stateData[2] === 0x00 && stateData[3] === 0x00 &&
    stateData[4] === 0x73 && stateData[5] === 0x4e

  const stateSSZ = isFramed
    ? snappyFramedDecompress(stateData, need)
    : snappyDecompressBlock(stateData, need)

  if (stateSSZ.length < need) {
    console.warn(`[portal] Era ${era}: decompressed ${stateSSZ.length}/${need}B — increase ERA_STATE_FETCH?`); return null
  }

  const roots: Uint8Array[] = []
  for (let i = 0; i < 8192; i++) {
    const off = BLOCK_ROOTS_SSZ_OFFSET + i * 32
    roots.push(stateSSZ.slice(off, off + 32))
  }

  const computed = computeEraBlockSummaryRoot(roots)
  if (computed.toLowerCase() !== expectedBlockSummaryRoot.toLowerCase()) {
    console.warn(`[portal] Era ${era}: block_summary_root mismatch: computed=${computed} expected=${expectedBlockSummaryRoot}`); return null
  }

  console.log(`[portal] Era ${era}: block_roots verified via era file ✓ (stateCompressed=${stateDataLen}B)`)
  return roots
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BeaconVerification {
  slot: number
  beaconBlockRoot: string
  heliosAnchored: boolean
  eraVerified: boolean
  stateHashVerified: boolean
}

export async function verifyViaBeacon(
  expectedExecutionHash: string,
  blockTimestamp: number,
  chainId: number,
  consensusRpcs: string[],
  heliosRpc?: IVerifiedRpc | Promise<IVerifiedRpc | undefined>,
  executionRpcs?: string[],
): Promise<BeaconVerification> {
  const slot      = timestampToSlot(blockTimestamp, chainId)
  const era       = Math.floor(slot / 8192)
  const slotInEra = slot % 8192
  const hsIndex   = historicalSummariesIndex(era, chainId)

  console.log(`[portal] Verifying slot ${slot} (era ${era}, offset ${slotInEra})`)

  const execRpcs = executionRpcs?.length ? executionRpcs : []
  if (!execRpcs.length) throw new Error('No execution RPCs provided for era block root verification')

  // Step 1: Fast consensus anchor (~100 ms). Helios runs in parallel and is checked last.
  const anchor = await getAnchorStateRoot(consensusRpcs)

  // Steps 2 + 3-prep: run state download and era-start block search concurrently.
  // findEraFirstBlockNumber is only needed for the slow exec-headers fallback; start it in
  // parallel so it's ready instantly if the era file path is also needed.
  const currentEra = Math.floor(anchor.slot / 8192)
  const needExecHeaders = era + 1 >= currentEra  // era file won't exist for current/recent eras
  const [{ blockSummaryRoot, effectiveStateRoot, effectiveSlot, blockRootAtSlot }, eraStartNum] = await Promise.all([
    getBlockSummaryRoot(consensusRpcs, anchor.slot, anchor.stateRoot, hsIndex, era, chainId, slot),
    needExecHeaders ? findEraFirstBlockNumber(execRpcs, era * 8192, chainId) : Promise.resolve(0),
  ])

  // Step 3: Determine expected beacon block root using the fastest available method.
  // Fast path: target slot is within BeaconState's rolling block_roots window — the root
  // is already authenticated by hash_tree_root(BeaconState), no era file or exec RPC calls needed.
  // Slow paths: era file (one range request) or sequential exec headers (many RPC calls).
  let expectedBeaconRoot: string
  if (blockRootAtSlot) {
    console.log(`[portal] Era ${era}: block_roots[${slot % 8192}] from BeaconState — skipping era file ✓`)
    expectedBeaconRoot = blockRootAtSlot
  } else {
    let eraBlockRoots: Uint8Array[] | null = null
    if (!needExecHeaders) {
      eraBlockRoots = await fetchEraBlockRootsFromEraFile(era + 1, chainId, blockSummaryRoot)
    }
    if (!eraBlockRoots) {
      console.log(`[portal] Era ${era}: era file unavailable, falling back to sequential exec headers`)
      eraBlockRoots = await fetchEraBlockRootsFromExecHeaders(
        execRpcs, era, chainId, blockSummaryRoot, eraStartNum,
      )
    }
    expectedBeaconRoot = hexlify(eraBlockRoots[slotInEra])
  }

  // Step 4: Fetch beacon block header at target slot → verify root == expectedBeaconRoot
  let verifiedBodyRoot = ''
  let verifiedBeaconRoot = ''
  for (const rpc of consensusRpcs) {
    try {
      const { root, msg } = await fetchVerifiedBeaconHeader(rpc, slot)
      if (root.toLowerCase() !== expectedBeaconRoot.toLowerCase())
        throw new Error(`Beacon header root ${root} ≠ era block_roots[${slotInEra}] ${expectedBeaconRoot}`)
      verifiedBodyRoot  = msg.body_root
      verifiedBeaconRoot = root
      console.log(`[portal] Beacon header at slot ${slot} verified against era block_roots ✓`)
      break
    } catch (err) {
      if ((err as Error).message.includes('≠')) throw err
    }
  }
  if (!verifiedBodyRoot) throw new Error(`Could not fetch beacon header for slot ${slot}`)

  // Step 5: Beacon block body → verify body_root → extract execution_block_hash → match phase 1
  let executionHash: string | undefined
  for (const rpc of consensusRpcs) {
    try {
      executionHash = await fetchVerifyBeaconBodyHash(rpc, slot, verifiedBodyRoot)
      break
    } catch (err) {
      console.warn(`[portal] Body verification failed (${rpc}):`, (err as Error).message)
    }
  }
  if (!executionHash) throw new Error(`Could not verify beacon block body at slot ${slot}`)

  if (executionHash.toLowerCase() !== expectedExecutionHash.toLowerCase())
    throw new Error(
      `Execution hash mismatch: beacon body says ${executionHash}, tx says ${expectedExecutionHash}`,
    )
  console.log('[portal] execution_block_hash verified end-to-end ✓')

  // Step 6: Confirm effective state root against Helios (ran in parallel since step 1).
  // heliosRpc may already be resolved if init was fast, or resolves now after the wait.
  let heliosAnchored = false
  const resolvedHelios = heliosRpc instanceof Promise ? await heliosRpc : heliosRpc
  if (resolvedHelios) {
    heliosAnchored = await confirmWithHelios(resolvedHelios, consensusRpcs, effectiveStateRoot, effectiveSlot)
  }
  console.log(`[portal] Helios anchor: ${heliosAnchored ? '✓ confirmed' : 'not confirmed (unanchored result)'}`)

  return {
    slot,
    beaconBlockRoot: verifiedBeaconRoot,
    heliosAnchored,
    eraVerified: true,
    stateHashVerified: true,
  }
}

export function isEip2935Error(err: unknown): boolean {
  return String((err as Error)?.message).includes('EIP-2935')
}
