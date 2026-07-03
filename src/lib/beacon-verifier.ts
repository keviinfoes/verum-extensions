// Unified historical block verification.
// Single chain: tx hash → execution block hash → era block roots (EIP-4788) → historical_summaries → Helios state root

import { sha256, getBytes, hexlify } from 'ethers'
import type { IVerifiedRpc } from './light-client.js'
import { computeBeaconStateRoot, computeBeaconBlockBodyRoot, verifyHistoricalSummariesFieldProof } from './ssz-state-verifier.js'
import { parquetRead, asyncBufferFromUrl } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import type { AsyncBuffer } from 'hyparquet/src/types.js'

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
  ],
}

// Era file servers — serve .era files with HTTP range support.
// Format: {network}-{era:05d}-{hash:8hex}.era, directory listing at server root.
const ERA_SERVERS: Record<number, { baseUrl: string; network: string }[]> = {
  1:        [{ baseUrl: 'https://mainnet.era.nimbus.team', network: 'mainnet' }],
  11155111: [{ baseUrl: 'https://sepolia.era.nimbus.team', network: 'sepolia' }],
  17000:    [{ baseUrl: 'https://holesky.era.nimbus.team', network: 'holesky' }],
}

const CHAIN_NETWORK: Record<number, string> = {
  1: 'mainnet', 11155111: 'sepolia', 17000: 'holesky',
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

// Returns the sibling hashes needed to prove leaf at `index` is in the tree.
function merkleProof(leaves: Uint8Array[], index: number): Uint8Array[] {
  let layer = Array.from({ length: 8192 }, (_, i) => leaves[i] ?? new Uint8Array(32))
  const path: Uint8Array[] = []
  let idx = index
  while (layer.length > 1) {
    path.push((idx % 2 === 0 ? layer[idx + 1] ?? new Uint8Array(32) : layer[idx - 1]).slice())
    const next: Uint8Array[] = []
    for (let i = 0; i < layer.length; i += 2) {
      const pair = new Uint8Array(64)
      pair.set(layer[i], 0)
      pair.set(layer[i + 1] ?? new Uint8Array(32), 32)
      next.push(getBytes(sha256(pair)))
    }
    layer = next
    idx = Math.floor(idx / 2)
  }
  return path
}

// Recomputes the Merkle root from a leaf + its proof path. Index determines left/right at each level.
function merkleVerify(leaf: Uint8Array, index: number, path: Uint8Array[]): Uint8Array {
  let node = leaf.slice()
  let idx = index
  for (const sibling of path) {
    const pair = new Uint8Array(64)
    if (idx % 2 === 0) { pair.set(node, 0); pair.set(sibling, 32) }
    else                { pair.set(sibling, 0); pair.set(node, 32) }
    node = getBytes(sha256(pair))
    idx = Math.floor(idx / 2)
  }
  return node
}

function encodeMerklePath(path: Uint8Array[]): string {
  const buf = new Uint8Array(path.length * 32)
  path.forEach((h, i) => buf.set(h, i * 32))
  return btoa(String.fromCharCode(...buf))
}

function decodeMerklePath(b64: string): Uint8Array[] {
  const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  return Array.from({ length: buf.length / 32 }, (_, i) => buf.slice(i * 32, (i + 1) * 32))
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
      console.log(`[w3] Consensus anchor: slot ${msg.slot} via ${rpc}`)
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
          console.log('[w3] EIP-4788 contract beacon root:', beaconRoot)
        }
      } catch (e) {
        console.warn('[w3] EIP-4788 contract call failed:', (e as Error).message)
      }
    }
    if (!beaconRoot) return false

    for (const rpc of consensusRpcs) {
      try {
        const { root: heliosBlockRoot, stateRoot: heliosStateRoot, msg } = await fetchVerifiedBeaconHeader(rpc, beaconRoot)
        const heliosSlot = Number(msg.slot)
        console.log(`[w3] Helios EIP-4788 anchor: slot ${heliosSlot} state_root ${heliosStateRoot}`)

        // Case 1: same slot — direct comparison
        if (heliosStateRoot.toLowerCase() === effectiveStateRoot.toLowerCase()) {
          console.log('[w3] Helios confirmed effective state root ✓')
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
                  console.log(`[w3] Helios confirmed via ${effectiveSlot - heliosSlot}-slot walk (effective→helios) ✓`)
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
                  console.log(`[w3] Helios confirmed via ${heliosSlot - effectiveSlot}-slot walk (helios→effective) ✓`)
                  return true
                }
                break
              }
              if (s < effectiveSlot) break
              parentRoot = pm.parent_root
            }
          } catch { /* try next RPC */ }
        }

        console.warn(`[w3] Helios state root mismatch: helios=${heliosStateRoot} effective=${effectiveStateRoot} (slots: helios=${heliosSlot} effective=${effectiveSlot})`)
        return false
      } catch { /* try next RPC */ }
    }
  } catch (err) {
    console.warn('[w3] Helios confirmation failed:', (err as Error).message)
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
  getHistoricalSummariesBlob: () => string
  computeHistoricalSummariesFieldProof: () => string
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
  customCheckpointUrls?: string[],
): Promise<StateSummary> {
  const ctrl = new AbortController()

  const attempt = async (rpc: string, stateId: number | 'finalized'): Promise<StateSummary> => {
    const label = stateId === 'finalized' ? 'finalized (checkpoint)' : `slot ${stateId}`
    console.log(`[w3] Fetching state (${label}) from ${rpc}…`)
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
      console.log(`[w3] State slot=${stateSlot} anchorSlot=${anchorSlot} diff=${stateSlot - anchorSlot} — Helios will confirm at end`)
    } else {
      console.log(`[w3] State hash_tree_root matches anchor ✓ (slot ${stateSlot}, from ${rpc})`)
    }

    // Fast path: if target slot is within the rolling block_roots window of this state,
    // read block_roots[targetSlot % 8192] directly (authenticated by hash_tree_root(BeaconState)).
    let blockRootAtSlot: string | undefined
    if (stateSlot >= targetSlot && stateSlot - targetSlot < 8192) {
      const root = verifier.getBlockRootAtSlot(targetSlot)
      if (!/^0x0+$/.test(root)) {
        blockRootAtSlot = root
        console.log(`[w3] block_roots[${targetSlot % 8192}] from BeaconState: ${root}`)
      }
    }

    const blockSummaryRoot = verifier.getBlockSummaryRoot(hsIndex)
    if (!blockSummaryRoot && !blockRootAtSlot)
      throw new Error(`historical_summaries[${hsIndex}] (era ${era}) not found and slot not in rolling window`)
    if (blockSummaryRoot)
      console.log(`[w3] historical_summaries[${hsIndex}] (era ${era}) block_summary_root: ${blockSummaryRoot}`)
    return { blockSummaryRoot: blockSummaryRoot ?? '', effectiveStateRoot: verifier.computedRoot, effectiveSlot: stateSlot, blockRootAtSlot, getHistoricalSummariesBlob: () => verifier.getHistoricalSummariesBlob(), computeHistoricalSummariesFieldProof: () => verifier.computeHistoricalSummariesFieldProof() }
  }

  // Use configured URLs when provided; fall back to built-in defaults only when undefined.
  const checkpointRpcs = customCheckpointUrls !== undefined
    ? customCheckpointUrls
    : (CHECKPOINT_SYNC_RPCS[chainId] ?? [])

  // Race checkpoint providers and consensus RPCs — interleaved so both types start early.
  // Stagger 3s between each start: a fast failure triggers the next immediately while
  // a slow download stays solo to avoid parallel bloat.
  // Use the previous epoch boundary (anchorSlot - 32): checkpoint CDNs only index finalized
  // epoch boundaries (not mid-epoch slots), and EIP-4788[timestamp(anchorSlot-31)] =
  // root(anchorSlot-32) is immediately in the finalized ring at write time (no +1 wait).
  const dlSlot = anchorSlot - 32
  const cpAttempts = checkpointRpcs.map(rpc => () => attempt(rpc, dlSlot))
  const cnAttempts = consensusRpcs.map(rpc => () => attempt(rpc, dlSlot))
  const ordered: (() => Promise<StateSummary>)[] = []
  const len = Math.max(cpAttempts.length, cnAttempts.length)
  for (let i = 0; i < len; i++) {
    if (cpAttempts[i]) ordered.push(cpAttempts[i])
    if (cnAttempts[i]) ordered.push(cnAttempts[i])
  }

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
            console.warn('[w3] State fetch failed:', (err as Error).message)
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

// RPCs that deliver HTTP headers quickly but stall the response body.
// Populated at runtime; individual-block fetches skip these and try them last.
const slowBodyRpcs = new Set<string>()

async function execRpcCall(rpcs: string[], body: object): Promise<unknown> {
  let lastErr: unknown
  const fast = rpcs.filter(r => !slowBodyRpcs.has(r))
  const ordered = fast.length > 0 ? [...fast, ...rpcs.filter(r => slowBodyRpcs.has(r))] : rpcs
  for (const rpc of ordered) {
    let gotHeaders = false
    const ctrl = new AbortController()
    const timer = setTimeout(() => { ctrl.abort(); if (gotHeaders) slowBodyRpcs.add(rpc) }, 8000)
    try {
      const res = await fetch(rpc, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ctrl.signal,
      })
      gotHeaders = true
      if (!res.ok) { clearTimeout(timer); throw new Error(`HTTP ${res.status}`) }
      const json = await res.json()
      clearTimeout(timer)
      return json
    } catch (err) { clearTimeout(timer); lastErr = err }
  }
  throw lastErr ?? new Error('All exec RPCs failed')
}

// Fetches a single block by number, trying each RPC until one returns a non-null result.
// Unlike execRpcCall, a null result is treated as "try next RPC" — needed when RPCs
// return null due to rate limiting rather than the block not existing.
async function fetchExecBlock(rpcs: string[], blockNum: number): Promise<ExecBlockHeader | null> {
  const fast = rpcs.filter(r => !slowBodyRpcs.has(r))
  const ordered = fast.length > 0 ? [...fast, ...rpcs.filter(r => slowBodyRpcs.has(r))] : rpcs
  const delays = [0, 800, 1600]
  for (const delay of delays) {
    if (delay > 0) await new Promise(r => setTimeout(r, delay))
    for (const rpc of ordered) {
      let gotHeaders = false
      const ctrl = new AbortController()
      const timer = setTimeout(() => { ctrl.abort(); if (gotHeaders) slowBodyRpcs.add(rpc) }, 8000)
      try {
        const res = await fetch(rpc, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'eth_getBlockByNumber',
            params: ['0x' + blockNum.toString(16), false], id: 0,
          }), signal: ctrl.signal,
        })
        gotHeaders = true
        if (!res.ok) { clearTimeout(timer); continue }
        const json = await res.json() as { result: ExecBlockHeader | null }
        clearTimeout(timer)
        if (json.result != null) return json.result
      } catch { clearTimeout(timer) }
    }
  }
  return null
}

// Returns null if no RPC supports batch (response not an array).
async function execBatch(rpcs: string[], requests: object[]): Promise<{ results: { result?: ExecBlockHeader }[]; rpc: string } | null> {
  for (const rpc of rpcs) {
    let gotHeaders = false
    const ctrl = new AbortController()
    const timer = setTimeout(() => { ctrl.abort(); if (gotHeaders) slowBodyRpcs.add(rpc) }, 25000)
    try {
      const res = await fetch(rpc, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requests), signal: ctrl.signal,
      })
      gotHeaders = true
      if (!res.ok) { clearTimeout(timer); continue }
      const json = await res.json()
      clearTimeout(timer)
      if (Array.isArray(json)) return { results: json as { result?: ExecBlockHeader }[], rpc }
    } catch { clearTimeout(timer) }
  }
  return null
}

async function findBlockAtTimestamp(
  rpcs: string[],
  targetTs: number,
  lo: number,
  hi: number,
): Promise<number> {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const r = await execRpcCall(rpcs, {
      jsonrpc: '2.0', method: 'eth_getBlockByNumber',
      params: ['0x' + mid.toString(16), false], id: 0,
    }) as { result: ExecBlockHeader | null }
    if (!r.result) { lo = mid + 1; continue }
    parseInt(r.result.timestamp, 16) < targetTs ? (lo = mid + 1) : (hi = mid)
  }
  return lo
}

async function findEraBlockRange(
  execRpcs: string[],
  eraStartSlot: number,
  chainId: number,
): Promise<{ startNum: number; endNum: number }> {
  const startTs = slotToTimestamp(eraStartSlot + 1, chainId)
  const endTs   = slotToTimestamp(eraStartSlot + 8193, chainId) // exclusive: one past the last needed slot

  const anchorJson = await execRpcCall(execRpcs, {
    jsonrpc: '2.0', method: 'eth_getBlockByNumber', params: ['latest', false], id: 0,
  }) as { result: ExecBlockHeader }
  const anchorNum = parseInt(anchorJson.result.number, 16)
  const anchorTs  = parseInt(anchorJson.result.timestamp, 16)

  const estimatedOffset = Math.round((anchorTs - startTs) / 12)
  const lo = Math.max(0, anchorNum - estimatedOffset * 2)

  console.log(`[w3] findEraBlockRange: anchorNum=${anchorNum} estimatedOffset=${estimatedOffset} lo=${lo}`)

  const [startNum, endNum] = await Promise.all([
    findBlockAtTimestamp(execRpcs, startTs, lo, anchorNum),
    findBlockAtTimestamp(execRpcs, endTs,   lo, anchorNum),
  ])

  console.log(`[w3] Era block range: [${startNum}, ${endNum}) — ${endNum - startNum} blocks`)
  return { startNum, endNum }
}

async function fetchEraBlockRootsFromExecHeaders(
  execRpcs: string[],
  era: number,
  chainId: number,
  expectedBlockSummaryRoot: string,
  startNum: number,
  endNum: number,
  rpcBatchSizes?: Record<string, number>,
): Promise<Uint8Array[]> {
  const eraStartSlot = era * 8192
  const DEFAULT_BATCH = 200
  const LOG_EVERY = 4

  const rawRoots = new Array<Uint8Array | null>(8192).fill(null)
  let cntInEra = 0

  const processItem = (b: ExecBlockHeader | undefined) => {
    if (!b?.timestamp || !b.parentBeaconBlockRoot) return
    const slot = timestampToSlot(parseInt(b.timestamp, 16), chainId)
    const j = slot - eraStartSlot - 1
    if (j < 0 || j >= 8192) return
    rawRoots[j] = getBytes(b.parentBeaconBlockRoot)
    cntInEra++
  }

  const fetchBlocksIndividually = async (rpcs: string[], nums: number[]): Promise<void> => {
    const inflight = new Set<Promise<void>>()
    for (const n of nums) {
      const p: Promise<void> = (async () => {
        processItem((await fetchExecBlock(rpcs, n)) ?? undefined)
      })().then(() => { inflight.delete(p) })
      inflight.add(p)
      if (inflight.size >= 2) await Promise.race(inflight)
    }
    await Promise.all([...inflight])
  }

  const processSegment = async (segStart: number, segEnd: number, primaryRpc: string): Promise<void> => {
    const allRpcs   = [primaryRpc, ...execRpcs.filter(r => r !== primaryRpc)]
    const otherRpcs = execRpcs.filter(r => r !== primaryRpc)
    const host      = new URL(primaryRpc).hostname
    const BATCH     = rpcBatchSizes?.[primaryRpc] ?? DEFAULT_BATCH
    const total     = Math.ceil((segEnd - segStart) / BATCH)
    let done = 0

    for (let n = segStart; n < segEnd; n += BATCH) {
      const blockNums = Array.from({ length: Math.min(BATCH, segEnd - n) }, (_, i) => n + i)
      const requests  = blockNums.map((bn, i) => ({
        jsonrpc: '2.0', method: 'eth_getBlockByNumber',
        params: ['0x' + bn.toString(16), false], id: i,
      }))
      const batchResult = await execBatch([primaryRpc], requests)
        ?? (otherRpcs.length > 0 ? await execBatch(otherRpcs, requests) : null)

      if (batchResult) {
        const { results } = batchResult
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
          for (let i = 0; i < results.length; i++) {
            if (results[i].result != null) processItem(results[i].result)
            else retryNums.push(blockNums[i])
          }
          for (let i = results.length; i < blockNums.length; i++) retryNums.push(blockNums[i])
        }
        if (retryNums.length > 0) await fetchBlocksIndividually(allRpcs, retryNums)
      } else {
        await fetchBlocksIndividually(allRpcs, blockNums)
      }

      done++
      if (done % LOG_EVERY === 0 || done === total) {
        console.log(`[w3] Era ${era}: ${host} ${done}/${total} batches (${Math.round(done / total * 100)}%) inEra=${cntInEra}`)
      }
    }
  }

  // Split [startNum, endNum) into N parallel segments, one per RPC
  const numSegments = Math.min(execRpcs.length, 4)
  const segmentSize = Math.ceil((endNum - startNum) / numSegments)
  const segments = Array.from({ length: numSegments }, (_, i) => ({
    segStart: startNum + i * segmentSize,
    segEnd:   Math.min(startNum + (i + 1) * segmentSize, endNum),
    rpc:      execRpcs[i % execRpcs.length],
  }))

  console.log(`[w3] Era ${era}: fetching exec headers ${startNum}–${endNum} (${endNum - startNum} blocks, ${numSegments} segments via ${segments.map(s => new URL(s.rpc).hostname).join(', ')})`)

  await Promise.all(segments.map(({ segStart, segEnd, rpc }) => processSegment(segStart, segEnd, rpc)))

  console.log(`[w3] rawRoots[0]=${rawRoots[0] ? hexlify(rawRoots[0]) : 'null'} rawRoots[8191]=${rawRoots[8191] ? hexlify(rawRoots[8191]) : 'null'}`)

  // Backward-fill missed beacon slots: rawRoots[k]=null means slot eraStartSlot+k+1 was missed;
  // correct block_roots[k] = root of last non-missed block at or before that slot = next non-null to the right.
  // Special case: if rawRoots[8191] is null (slot eraStart+8192 missed), we can't recover block_roots[8191]
  // from rawRoots alone — the exec block at endNum has pbbr = block_roots[8191], so fetch it as the seed.
  let seed: Uint8Array
  if (rawRoots[8191] !== null) {
    seed = rawRoots[8191]
  } else {
    const nextBlock = await fetchExecBlock(execRpcs, endNum)
    seed = nextBlock?.parentBeaconBlockRoot
      ? getBytes(nextBlock.parentBeaconBlockRoot)
      : rawRoots.findLast(r => r !== null) ?? new Uint8Array(32)
    console.log(`[w3] rawRoots[8191] null — fetched seed from exec block ${endNum}: ${nextBlock?.parentBeaconBlockRoot ?? 'null'}`)
  }

  const roots: Uint8Array[] = new Array(8192)
  let last = seed
  for (let j = 8191; j >= 0; j--) {
    if (rawRoots[j] !== null) last = rawRoots[j]!
    roots[j] = last
  }

  const filled = rawRoots.filter(r => r === null).length
  console.log(`[w3] Era ${era}: ${cntInEra} headers mapped, ${filled}/8192 backward-filled`)
  console.log(`[w3] roots[0]=${hexlify(roots[0])} roots[8191]=${hexlify(roots[8191])}`)

  const computed = computeEraBlockSummaryRoot(roots)
  if (computed.toLowerCase() !== expectedBlockSummaryRoot.toLowerCase())
    throw new Error(
      `Era ${era}: computed block_summary_root ${computed} ≠ historical_summaries value ${expectedBlockSummaryRoot}`,
    )
  console.log(`[w3] Era ${era}: block_roots Merkle root verified against historical_summaries ✓`)
  return roots
}

// ---------------------------------------------------------------------------
// Parquet: ethpandaops xatu canonical_beacon_block
// ---------------------------------------------------------------------------

const XATU_CHAIN: Record<number, string> = {
  1:        'mainnet',
  11155111: 'sepolia',
  17000:    'holesky',
}
const XATU_BASE = 'https://data.ethpandaops.io/xatu'

function dateKey(unixTs: number): string {
  const d = new Date(unixTs * 1000)
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}

function eraDates(eraStartSlot: number, chainId: number): string[] {
  const keys = new Set<string>()
  for (const slot of [eraStartSlot, eraStartSlot + 4096, eraStartSlot + 8191]) {
    keys.add(dateKey(slotToTimestamp(slot, chainId)))
  }
  return [...keys]
}

interface ParquetRow { slot: bigint; block_root: Uint8Array }

async function fetchParquetDayRoots(
  url: string,
  eraStartSlot: number,
  eraEndSlot: number,
): Promise<ParquetRow[]> {
  let asyncBuffer: AsyncBuffer
  try {
    asyncBuffer = await asyncBufferFromUrl({ url })
  } catch {
    return []
  }
  const rows: ParquetRow[] = []
  await parquetRead({
    file: asyncBuffer,
    compressors,
    columns: ['slot', 'block_root'],
    rowFormat: 'object',
    onComplete(data: Record<string, unknown>[]) {
      for (const row of data) {
        const s = Number(row['slot'] as bigint)
        if (s >= eraStartSlot && s <= eraEndSlot) rows.push(row as unknown as ParquetRow)
      }
    },
  })
  return rows
}

async function fetchEraBlockRootsFromParquet(
  era: number,
  chainId: number,
  expectedBlockSummaryRoot: string,
  customParquetUrls?: string[],
): Promise<Uint8Array[] | null> {
  const network = XATU_CHAIN[chainId]
  // undefined → use built-in default; [] → skip parquet entirely
  if (customParquetUrls !== undefined && customParquetUrls.length === 0) return null
  if (!network && !customParquetUrls?.length) return null

  const eraStartSlot = era * 8192
  const eraEndSlot   = eraStartSlot + 8191
  const defaultBase  = network ? `${XATU_BASE}/${network}/databases/default/canonical_beacon_block` : null
  const bases        = customParquetUrls !== undefined
    ? [...customParquetUrls, ...(defaultBase ? [defaultBase] : [])]
    : (defaultBase ? [defaultBase] : [])

  const slotSet = new Set<number>()
  const allRows: ParquetRow[] = []
  for (const base of bases) {
    for (const d of eraDates(eraStartSlot, chainId)) {
      try {
        const rows = await fetchParquetDayRoots(`${base}/${d}.parquet`, eraStartSlot, eraEndSlot)
        console.log(`[w3] Parquet ${d}: ${rows.length} rows in era range`)
        for (const row of rows) {
          if (!slotSet.has(Number(row.slot))) { slotSet.add(Number(row.slot)); allRows.push(row) }
        }
      } catch (e) {
        console.log(`[w3] Parquet ${d}: ${(e as Error).message}`)
      }
    }
    if (allRows.length > 0) break  // first base that returned data wins
  }

  if (allRows.length === 0) {
    console.log(`[w3] Parquet: no data for era ${era}`)
    return null
  }

  // Build block_roots[8192] — FixedString(66) arrives as Uint8Array of ASCII "0xabcd..."
  const roots: (Uint8Array | null)[] = new Array(8192).fill(null)
  const decoder = new TextDecoder()
  for (const row of allRows) {
    const j = Number(row.slot) - eraStartSlot
    if (j >= 0 && j < 8192) roots[j] = getBytes(decoder.decode(row.block_root))
  }
  // Forward-fill: missed slot inherits the most recent non-null root to its left
  for (let j = 1; j < 8192; j++) {
    if (roots[j] === null) roots[j] = roots[j - 1]
  }
  const ZERO = new Uint8Array(32)
  for (let j = 0; j < 8192; j++) {
    if (roots[j] === null) roots[j] = ZERO
  }
  const finalRoots = roots as Uint8Array[]

  const computed = computeEraBlockSummaryRoot(finalRoots)
  if (computed.toLowerCase() !== expectedBlockSummaryRoot.toLowerCase()) {
    console.warn(`[w3] Parquet: block_summary_root mismatch (era may be incomplete)`)
    return null
  }
  console.log(`[w3] Parquet: era ${era} block_roots verified ✓`)
  return finalRoots
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
async function findEraFileUrls(era: number, chainId: number, blockSummaryRoot: string, customEraUrls?: string[]): Promise<string[]> {
  const network = CHAIN_NETWORK[chainId] ?? 'mainnet'
  // Use configured URLs when provided; fall back to built-in defaults only when undefined.
  const servers = customEraUrls !== undefined
    ? customEraUrls.map(baseUrl => ({ baseUrl: baseUrl.replace(/\/$/, ''), network }))
    : (ERA_SERVERS[chainId] ?? [])
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
  customEraUrls?: string[],
): Promise<Uint8Array[] | null> {
  const urls = await findEraFileUrls(era, chainId, expectedBlockSummaryRoot, customEraUrls)
  if (!urls.length) return null

  for (const url of urls) {
    try {
      const roots = await tryEraUrl(url, era, expectedBlockSummaryRoot)
      if (roots) return roots
    } catch (e) {
      console.warn(`[w3] Era ${era}: ${url} → ${(e as Error).message}`)
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
  console.log(`[w3] Era ${era}: tail fetch (${ERA_TAIL_FETCH >> 10}KB) from ${url}`)
  const tail = await eraFetch(url, `bytes=-${ERA_TAIL_FETCH}`, 30_000)
  if (!tail) { console.warn(`[w3] Era ${era}: tail fetch failed`); return null }
  const { buf: tailBuf, fileSize } = tail
  if (!fileSize) { console.warn(`[w3] Era ${era}: no Content-Range, cannot locate state`); return null }

  // The last 8 bytes of the file = count field of the trailing StateRef record (always 1 per era)
  const count = readU32LE(tailBuf, tailBuf.length - 8)
  if (count === 0 || count > 8192) {
    console.warn(`[w3] Era ${era}: invalid tail count ${count}`); return null
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
    console.warn(`[w3] Era ${era}: bad stateHeaderAbsPos=${stateHeaderAbsPos}`); return null
  }
  console.log(`[w3] Era ${era}: count=${count} stateHeaderAbsPos=${stateHeaderAbsPos}`)

  // ── Step 2: fetch state entry (header + compressed data) ─────────────────────
  const fetchEnd = Math.min(stateHeaderAbsPos + ERA_STATE_FETCH - 1, fileSize - 1)
  console.log(`[w3] Era ${era}: state fetch bytes ${stateHeaderAbsPos}–${fetchEnd}`)
  const sf = await eraFetch(url, `bytes=${stateHeaderAbsPos}-${fetchEnd}`, 120_000)
  if (!sf) { console.warn(`[w3] Era ${era}: state fetch failed`); return null }
  const stateBuf = sf.buf

  // Parse state e2store header (8 bytes: type(2) + length(6))
  if (stateBuf.length < 8) { console.warn(`[w3] Era ${era}: state fetch too small`); return null }
  const stateType = stateBuf[0] | (stateBuf[1] << 8)
  if (stateType !== E2S_STATE) {
    const hex16 = Array.from(stateBuf.subarray(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')
    console.warn(`[w3] Era ${era}: expected state (0x${E2S_STATE.toString(16)}), got 0x${stateType.toString(16)} — first 16B: ${hex16}`)
    return null
  }
  const stateDataLen = readU32LE(stateBuf, 2)
  const stateData    = stateBuf.subarray(8)
  console.log(`[w3] Era ${era}: state compressed=${stateDataLen}B fetched ${stateData.length}B`)

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
    console.warn(`[w3] Era ${era}: decompressed ${stateSSZ.length}/${need}B — increase ERA_STATE_FETCH?`); return null
  }

  const roots: Uint8Array[] = []
  for (let i = 0; i < 8192; i++) {
    const off = BLOCK_ROOTS_SSZ_OFFSET + i * 32
    roots.push(stateSSZ.slice(off, off + 32))
  }

  const computed = computeEraBlockSummaryRoot(roots)
  if (computed.toLowerCase() !== expectedBlockSummaryRoot.toLowerCase()) {
    console.warn(`[w3] Era ${era}: block_summary_root mismatch: computed=${computed} expected=${expectedBlockSummaryRoot}`); return null
  }

  console.log(`[w3] Era ${era}: block_roots verified via era file ✓ (stateCompressed=${stateDataLen}B)`)
  return roots
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Compact per-dapp proof stored in chrome.storage.local.
// merklePath: base64-encoded concatenation of 13 × 32-byte sibling hashes — proves
//   that the beacon block root at slotInEra is in the era's block_roots tree.
export interface DappProofData {
  merklePath: string
}

// Chain-level BSR cache. Stores all historical_summaries raw bytes + a 5-6 hash field proof
// from the list root to stateRoot. Any era's blockSummaryRoot can be extracted from the blob
// and proven by: EIP-4788[timestamp(effectiveSlot+1)] via Helios → effectiveBeaconRoot →
// SSZ field proof (local) → stateRoot → histSummaries[hsIndex].block_summary_root.
export interface EraBsrCache {
  effectiveSlot: number
  effectiveBeaconRoot: string  // beacon block root at effectiveSlot (SSZ-verified at write time)
  stateRoot: string            // hash_tree_root(BeaconState), confirmed by Helios at write time
  fieldProof: string           // base64, 5-6 × 32 bytes: proof from historical_summaries root → stateRoot
  histSummaries: string        // base64, N × 64 bytes: raw historical_summaries bytes
}

export interface BeaconVerifyOptions {
  checkpointUrls?: string[]
  eraFileUrls?: string[]
  parquetUrls?: string[]
  rpcBatchSizes?: Record<string, number>
  cachedProof?: DappProofData
  eraBsrCache?: EraBsrCache
}

export interface BeaconVerification {
  slot: number
  beaconBlockRoot: string
  heliosAnchored: boolean
  eraVerified: boolean
  stateHashVerified: boolean
  proofData?: DappProofData
  newBsrCache?: EraBsrCache  // set when BeaconState was downloaded; replaces chain cache
}

export async function verifyViaBeacon(
  expectedExecutionHash: string,
  blockTimestamp: number,
  chainId: number,
  consensusRpcs: string[],
  heliosRpc?: IVerifiedRpc | Promise<IVerifiedRpc | undefined>,
  executionRpcs?: string[],
  options?: BeaconVerifyOptions,
): Promise<BeaconVerification> {
  const slot      = timestampToSlot(blockTimestamp, chainId)
  const era       = Math.floor(slot / 8192)
  const slotInEra = slot % 8192
  const hsIndex   = historicalSummariesIndex(era, chainId)

  console.log(`[w3] Verifying slot ${slot} (era ${era}, offset ${slotInEra})`)

  const execRpcs = executionRpcs?.length ? executionRpcs : []
  if (!execRpcs.length) throw new Error('No execution RPCs provided for era block root verification')

  // Step 1: Fast consensus anchor (~100 ms). Helios runs in parallel and is checked last.
  const anchor = await getAnchorStateRoot(consensusRpcs)

  // Step 2: Resolve blockSummaryRoot.
  // Cache hit: verify via EIP-4788 + SSZ proof — no BeaconState download.
  // Cold start or ring expiry (~27h): download BeaconState, compute SSZ proofs, cache.
  const currentEra = Math.floor(anchor.slot / 8192)
  const eraBsrCache = options?.eraBsrCache
  let eraBsrHit = false

  let blockSummaryRoot = ''
  let effectiveStateRoot = ''
  let effectiveSlot = 0
  let blockRootAtSlot: string | undefined
  let newBsrCache: EraBsrCache | undefined
  let eraRange: { startNum: number; endNum: number } | undefined

  // Step 2: BSR cache hit — verify via EIP-4788 (Helios) + local SSZ field proof.
  // EIP-4788[timestamp(effectiveSlot+1)] gives the beacon root at effectiveSlot, proven
  // by Helios's verified execution chain. No slot walk needed; 27h ring TTL.
  if (eraBsrCache?.histSummaries && eraBsrCache.fieldProof && eraBsrCache.stateRoot && eraBsrCache.effectiveBeaconRoot) {
    const raw = Uint8Array.from(atob(eraBsrCache.histSummaries), c => c.charCodeAt(0))
    const nEntries = Math.floor(raw.length / 64)
    if (hsIndex < nEntries) {
      const resolvedHelios = heliosRpc instanceof Promise ? await heliosRpc : heliosRpc
      if (!resolvedHelios?.isHeliosBacked()) {
        console.log(`[w3] Era ${era}: Helios not available — skipping BSR cache, re-downloading BeaconState`)
      } else {
        try {
          const ts = slotToTimestamp(eraBsrCache.effectiveSlot + 1, chainId)
          const calldata = '0x' + ts.toString(16).padStart(64, '0')
          const result = await resolvedHelios.request<string>(
            'eth_call', [{ to: EIP4788_CONTRACT, data: calldata }, 'finalized'],
          )
          const rootFromRing = result.length === 66 ? result : '0x' + result.slice(-64)
          if (rootFromRing.toLowerCase() !== eraBsrCache.effectiveBeaconRoot.toLowerCase()) {
            console.log(`[w3] Era ${era}: EIP-4788 root mismatch — cache expired, re-downloading`)
          } else if (!verifyHistoricalSummariesFieldProof(eraBsrCache.histSummaries, eraBsrCache.fieldProof, eraBsrCache.stateRoot)) {
            console.warn(`[w3] Era ${era}: field proof mismatch — re-downloading`)
          } else {
            eraBsrHit = true
            blockSummaryRoot = hexlify(raw.slice(hsIndex * 64, hsIndex * 64 + 32))
            console.log(`[w3] Era ${era}: EIP-4788 + field proof verified — skipping BeaconState download ✓`)
          }
        } catch (e) {
          console.log(`[w3] Era ${era}: EIP-4788 check failed (${(e as Error).message}) — re-downloading`)
        }
      }
    }
  }

  if (!eraBsrHit) {
    const [stateSummary, er] = await Promise.all([
      getBlockSummaryRoot(consensusRpcs, anchor.slot, anchor.stateRoot, hsIndex, era, chainId, slot, options?.checkpointUrls),
      findEraBlockRange(execRpcs, era * 8192, chainId),
    ])
    blockSummaryRoot = stateSummary.blockSummaryRoot
    effectiveStateRoot = stateSummary.effectiveStateRoot
    effectiveSlot = stateSummary.effectiveSlot
    blockRootAtSlot = stateSummary.blockRootAtSlot
    eraRange = er

    // Fetch effectiveBeaconRoot: beacon block root at effectiveSlot, SSZ-verified by
    // requiring header.state_root == effectiveStateRoot (ties root to the verified state).
    let effectiveBeaconRoot: string | undefined
    for (const rpc of consensusRpcs) {
      try {
        const { root, stateRoot } = await fetchVerifiedBeaconHeader(rpc, effectiveSlot)
        if (stateRoot.toLowerCase() === effectiveStateRoot.toLowerCase()) {
          effectiveBeaconRoot = root
          break
        }
      } catch { /* try next */ }
    }
    if (effectiveBeaconRoot) {
      newBsrCache = {
        effectiveSlot,
        effectiveBeaconRoot,
        stateRoot: effectiveStateRoot,
        fieldProof: stateSummary.computeHistoricalSummariesFieldProof(),
        histSummaries: stateSummary.getHistoricalSummariesBlob(),
      }
    }
  }

  // Step 3: Resolve era block roots (beacon block leaf + Merkle proof).
  let expectedBeaconRoot: string
  let proofData: DappProofData | undefined

  if (blockRootAtSlot) {
    console.log(`[w3] Era ${era}: block_roots[${slot % 8192}] from BeaconState — skipping era file ✓`)
    expectedBeaconRoot = blockRootAtSlot
  } else if (options?.cachedProof) {
    expectedBeaconRoot = ''
    console.log(`[w3] Era ${era}: dapp proof cache hit — skipping era file download`)
  } else {
    if (!eraRange) eraRange = await findEraBlockRange(execRpcs, era * 8192, chainId)
    const needExecHeaders = era + 1 >= currentEra
    const useEra     = options?.eraFileUrls === undefined || options.eraFileUrls.length > 0
    const useParquet = options?.parquetUrls === undefined || options.parquetUrls.length > 0
    let eraBlockRoots: Uint8Array[] | null = null
    if (!needExecHeaders && useEra) {
      eraBlockRoots = await fetchEraBlockRootsFromEraFile(era + 1, chainId, blockSummaryRoot, options?.eraFileUrls)
    }
    if (!eraBlockRoots && !needExecHeaders && useParquet) {
      console.log(`[w3] Era ${era}: trying parquet (ethpandaops xatu)`)
      eraBlockRoots = await fetchEraBlockRootsFromParquet(era, chainId, blockSummaryRoot, options?.parquetUrls)
    }
    if (!eraBlockRoots) {
      console.log(`[w3] Era ${era}: falling back to exec headers`)
      eraBlockRoots = await fetchEraBlockRootsFromExecHeaders(
        execRpcs, era, chainId, blockSummaryRoot, eraRange.startNum, eraRange.endNum, options?.rpcBatchSizes,
      )
    }
    expectedBeaconRoot = hexlify(eraBlockRoots[slotInEra])
    proofData = { merklePath: encodeMerklePath(merkleProof(eraBlockRoots, slotInEra)) }
  }

  // Step 4: Fetch beacon block header at target slot.
  // Cache hit: verify beacon block root against cached Merkle proof using the fresh
  //   blockSummaryRoot — proves the leaf is in the canonical era block_roots tree.
  // Normal: verify root matches the era block_roots entry directly.
  let verifiedBodyRoot = ''
  let verifiedBeaconRoot = ''
  for (const rpc of consensusRpcs) {
    try {
      const { root, msg } = await fetchVerifiedBeaconHeader(rpc, slot)
      if (options?.cachedProof && !blockRootAtSlot) {
        const path     = decodeMerklePath(options.cachedProof.merklePath)
        const computed = hexlify(merkleVerify(getBytes(root), slotInEra, path))
        if (computed.toLowerCase() !== blockSummaryRoot.toLowerCase())
          throw new Error(`Merkle proof mismatch: computed ${computed} ≠ blockSummaryRoot ${blockSummaryRoot}`)
        console.log(`[w3] Beacon header at slot ${slot} verified against cached Merkle proof ✓`)
      } else {
        if (root.toLowerCase() !== expectedBeaconRoot.toLowerCase())
          throw new Error(`Beacon header root ${root} ≠ era block_roots[${slotInEra}] ${expectedBeaconRoot}`)
        console.log(`[w3] Beacon header at slot ${slot} verified against era block_roots ✓`)
      }
      verifiedBodyRoot  = msg.body_root
      verifiedBeaconRoot = root
      break
    } catch (err) {
      if ((err as Error).message.includes('≠') || (err as Error).message.includes('mismatch')) throw err
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
      console.warn(`[w3] Body verification failed (${rpc}):`, (err as Error).message)
    }
  }
  if (!executionHash) throw new Error(`Could not verify beacon block body at slot ${slot}`)

  if (executionHash.toLowerCase() !== expectedExecutionHash.toLowerCase())
    throw new Error(
      `Execution hash mismatch: beacon body says ${executionHash}, tx says ${expectedExecutionHash}`,
    )
  console.log('[w3] execution_block_hash verified end-to-end ✓')

  // Step 6: Helios anchor.
  // BSR cache hit: Helios already confirmed stateRoot in step 2 — mark anchored.
  // Normal path: confirm effectiveStateRoot against Helios.
  let heliosAnchored = false
  if (eraBsrHit) {
    heliosAnchored = true
    console.log('[w3] Helios anchor: ✓ confirmed (EIP-4788 cache hit)')
  } else {
    const resolvedHelios = heliosRpc instanceof Promise ? await heliosRpc : heliosRpc
    if (resolvedHelios && effectiveStateRoot) {
      heliosAnchored = await confirmWithHelios(resolvedHelios, consensusRpcs, effectiveStateRoot, effectiveSlot)
    }
    console.log(`[w3] Helios anchor: ${heliosAnchored ? '✓ confirmed' : 'not confirmed (unanchored result)'}`)
  }

  return {
    slot,
    beaconBlockRoot: verifiedBeaconRoot,
    heliosAnchored,
    eraVerified: true,
    stateHashVerified: true,
    proofData,
    newBsrCache,
  }
}

export function isEip2935Error(err: unknown): boolean {
  return String((err as Error)?.message).includes('EIP-2935')
}
