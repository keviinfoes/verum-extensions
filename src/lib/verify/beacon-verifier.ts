// Unified historical block verification.
// Single chain: tx hash → execution block hash → era block roots (EIP-4788) → historical_summaries → Helios state root
//
// The three strategies for fetching an era's block_roots (exec headers / parquet /
// era file) and the BeaconState download live in ./downloader/ — this file keeps
// the header/body/Helios-anchor fetchers and the verifyViaBeacon orchestrator that
// ties them all together. Primitives shared with the downloaders live in
// ./beacon-primitives.ts, avoiding a circular import between this file and them.

import { sha256, getBytes, hexlify } from 'ethers'
import type { IVerifiedRpc } from '../rpc/light-client.js'
import type { EraSource, StateSource } from '../../types.js'
import { computeBeaconBlockBodyRoot, computeBlindedBeaconBlockBodyRoot, verifyHistoricalSummariesFieldProof } from './ssz-state-verifier.js'
import { timestampToSlot, slotToTimestamp, sszMerkleize, readU32LE, fetchWithTimeout } from './beacon-primitives.js'
import { getBlockSummaryRoot } from './downloader/beacon-state.js'
import { findEraBlockRange, fetchEraBlockRootsFromExecHeaders } from './downloader/era-exec-headers.js'
import { fetchEraBlockRootsFromParquet } from './downloader/era-parquet.js'
import { fetchEraBlockRootsFromEraFile } from './downloader/era-file.js'

export { timestampToSlot, slotToTimestamp, fetchWithTimeout } from './beacon-primitives.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAPELLA_ERA: Record<number, number> = {
  1:        758,   // mainnet CAPELLA_FORK_EPOCH 194048 / 256
  11155111: 222,   // sepolia CAPELLA_FORK_EPOCH 56832 / 256
  17000:    1,     // holesky CAPELLA_FORK_EPOCH 256 / 256
}

function historicalSummariesIndex(era: number, chainId: number): number {
  const idx = era - (CAPELLA_ERA[chainId] ?? 0)
  if (idx < 0) throw new Error(`Era ${era} is before Capella on chain ${chainId}`)
  return idx
}

// ---------------------------------------------------------------------------
// SSZ primitives (beacon-header-specific — the era-root primitives live in
// ./beacon-primitives.ts)
// ---------------------------------------------------------------------------

function uint64LeBytes(n: bigint): Uint8Array {
  const b = new Uint8Array(32)
  let v = n
  for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n }
  return b
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
  let node: Uint8Array = leaf.slice()
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

// Verify the execution block hash committed by the beacon block at `slot`, given
// the authenticated body_root from its header.
//
// Primary: the BLINDED block as JSON. It yields the same body_root (the header's
// transactions_root/withdrawals_root ARE the omitted lists' roots), is ~30x
// smaller than the full block, and — crucially — JSON is what gateways like
// publicnode actually serve (they refuse SSZ). Fallback: the full block as SSZ,
// which works on Sepolia and any endpoint that honours Accept: octet-stream.
//
// A blinded body_root MISMATCH could be either a serialization bug or a forgery;
// either way we fall through to the SSZ path, which is authoritative. If SSZ also
// fails (unavailable, or its own mismatch) we reject — never a false accept.
async function fetchVerifyBeaconBodyHash(
  rpc: string,
  slot: number,
  expectedBodyRoot: string,
): Promise<string> {
  let blindedErr = ''
  try {
    return await fetchVerifyBlindedBody(rpc, slot, expectedBodyRoot)
  } catch (e) {
    blindedErr = (e as Error).message
  }
  try {
    return await fetchVerifyFullBlockSSZ(rpc, slot, expectedBodyRoot)
  } catch (e) {
    throw new Error(`blinded(${blindedErr}); ssz(${(e as Error).message})`)
  }
}

async function fetchVerifyBlindedBody(
  rpc: string,
  slot: number,
  expectedBodyRoot: string,
): Promise<string> {
  const res = await fetchWithTimeout(
    `${rpc}/eth/v1/beacon/blinded_blocks/${slot}`,
    { headers: { Accept: 'application/json' } },
    20_000,
  )
  if (!res.ok) throw new Error(`blinded block ${slot}: HTTP ${res.status}`)
  const json = await res.json() as { data?: { message?: { body?: Record<string, unknown> } } }
  const body = json.data?.message?.body
  if (!body) throw new Error(`blinded block ${slot}: no body in response`)
  const { computedRoot, executionBlockHash } = computeBlindedBeaconBlockBodyRoot(body)
  if (computedRoot.toLowerCase() !== expectedBodyRoot.toLowerCase())
    throw new Error(`blinded body root mismatch at slot ${slot}: ${computedRoot} ≠ ${expectedBodyRoot}`)
  return executionBlockHash
}

async function fetchVerifyFullBlockSSZ(
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
  if (!res.ok) throw new Error(`beacon block SSZ ${slot}: HTTP ${res.status}`)
  // Some gateways ignore Accept and return JSON — reject rather than misparse it.
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('json')) throw new Error(`beacon block SSZ ${slot}: got JSON, not SSZ`)
  const blob = new Uint8Array(await res.arrayBuffer())
  if (blob.length < 104) throw new Error('SignedBeaconBlock SSZ too short')
  const blockSSZ = blob.slice(readU32LE(blob, 0))
  if (blockSSZ.length < 84) throw new Error('BeaconBlock SSZ too short')
  const bodySSZ = blockSSZ.slice(readU32LE(blockSSZ, 80))
  const { computedRoot, executionBlockHash } = computeBeaconBlockBodyRoot(bodySSZ)
  if (computedRoot.toLowerCase() !== expectedBodyRoot.toLowerCase())
    throw new Error(`body root mismatch at slot ${slot}: ${computedRoot} ≠ ${expectedBodyRoot}`)
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

// Confirm the effective beacon root via EIP-4788: scan forward from effectiveSlot+1
// until we find the first non-missed slot, then verify its parentBeaconBlockRoot equals
// effectiveBeaconRoot. Missed beacon slots have no execution block so the ring buffer
// has no entry for their timestamp — the contract reverts, and we skip to the next slot.
// The first non-missed slot's parentBeaconBlockRoot is always effectiveBeaconRoot because
// effectiveSlot itself is not missed (we fetched its beacon header to compute it).
async function confirmWithHelios(
  heliosRpc: IVerifiedRpc,
  effectiveBeaconRoot: string,
  effectiveSlot: number,
  chainId: number,
): Promise<boolean> {
  if (!heliosRpc.isHeliosBacked()) return false
  try {
    for (let probe = effectiveSlot + 1; probe <= effectiveSlot + 64; probe++) {
      const ts = slotToTimestamp(probe, chainId)
      const calldata = '0x' + ts.toString(16).padStart(64, '0')
      let result: string
      try {
        result = await heliosRpc.request<string>(
          'eth_call', [{ to: EIP4788_CONTRACT, data: calldata }, 'finalized'],
        )
      } catch (e: any) {
        if ((e?.message ?? '').includes('out of sync')) return false  // OOS — not a missed slot
        continue // execution reverted = missed slot, no ring buffer entry
      }
      const rootFromRing = result.length === 66 ? result : '0x' + result.slice(-64)
      if (rootFromRing.toLowerCase() !== effectiveBeaconRoot.toLowerCase()) {
        console.warn(`[w3] Helios EIP-4788 mismatch at slot ${probe}: ring=${rootFromRing} expected=${effectiveBeaconRoot}`)
        return false
      }
      console.log('[w3] Helios confirmed via EIP-4788 ✓')
      return true
    }
    console.warn('[w3] Helios EIP-4788: no non-missed slot found within 64 slots')
    return false
  } catch (err) {
    console.warn('[w3] Helios EIP-4788 confirmation failed:', (err as Error).message)
    return false
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Compact per-dapp proof stored in chrome.storage.local.
// merklePaths: one entry per target chunk (same order as the ENS record), each a
//   base64-encoded concatenation of 13 × 32-byte sibling hashes proving that chunk's
//   beacon block root is in its era's block_roots tree. null when the chunk was
//   verified via the BeaconState rolling window (no era proof needed or produced).
export interface DappProofData {
  merklePaths: (string | null)[]
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
  // Dev mode: pin one source instead of the automatic fallback chain.
  eraSource?: EraSource
  stateSource?: StateSource
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

// One verification target: an execution block that must be proven canonical.
// Multi-chunk dapps pass one target per chunk (duplicates by slot are deduped).
export interface BeaconTarget {
  executionHash: string   // execution block hash the beacon body must contain
  blockTimestamp: number  // execution block timestamp → beacon slot
}

export async function verifyViaBeacon(
  targets: BeaconTarget[],
  chainId: number,
  consensusRpcs: string[],
  heliosRpc?: IVerifiedRpc | Promise<IVerifiedRpc | undefined>,
  executionRpcs?: string[],
  options?: BeaconVerifyOptions,
): Promise<BeaconVerification> {
  if (targets.length === 0) throw new Error('verifyViaBeacon: no targets')

  const slots = targets.map(t => {
    const slot = timestampToSlot(t.blockTimestamp, chainId)
    return { slot, era: Math.floor(slot / 8192), slotInEra: slot % 8192, executionHash: t.executionHash }
  })
  const uniqueEras = [...new Set(slots.map(s => s.era))]
  const primary = slots[slots.length - 1]

  console.log(`[w3] Verifying ${slots.length} slot(s): ${[...new Set(slots.map(s => s.slot))].join(', ')} (era${uniqueEras.length > 1 ? 's' : ''} ${uniqueEras.join(', ')})`)

  const execRpcs = executionRpcs?.length ? executionRpcs : []
  if (!execRpcs.length) throw new Error('No execution RPCs provided for era block root verification')

  // Step 1: Fast consensus anchor (~100 ms). Helios runs in parallel and is checked last.
  const anchor = await getAnchorStateRoot(consensusRpcs)
  const currentEra = Math.floor(anchor.slot / 8192)

  // Step 2: Resolve block_summary_root for every target era.
  // Cache hit: verify the histSummaries blob via EIP-4788 (Helios) + local SSZ field
  // proof — no BeaconState download. The blob holds ALL eras, so one verification
  // covers every target era. Cold start or ring expiry (~27h): download BeaconState,
  // compute SSZ proofs, cache.
  const eraBsrCache = options?.eraBsrCache
  let eraBsrHit = false
  const bsrByEra = new Map<number, string>()
  let blockRootsAtSlots: Record<number, string> = {}
  let effectiveStateRoot = ''
  let effectiveSlot = 0
  let effectiveBeaconRoot: string | undefined
  let newBsrCache: EraBsrCache | undefined
  const rangeByEra = new Map<number, { startNum: number; endNum: number }>()

  if (eraBsrCache?.histSummaries && eraBsrCache.fieldProof && eraBsrCache.stateRoot && eraBsrCache.effectiveBeaconRoot) {
    const raw = Uint8Array.from(atob(eraBsrCache.histSummaries), c => c.charCodeAt(0))
    const nEntries = Math.floor(raw.length / 64)
    const allCovered = uniqueEras.every(e => {
      const idx = historicalSummariesIndex(e, chainId)
      return idx >= 0 && idx < nEntries
    })
    if (allCovered) {
      const resolvedHelios = heliosRpc instanceof Promise ? await heliosRpc : heliosRpc
      if (!resolvedHelios?.isHeliosBacked()) {
        console.log('[w3] Helios not available — skipping BSR cache, re-downloading BeaconState')
      } else {
        try {
          const ts = slotToTimestamp(eraBsrCache.effectiveSlot + 1, chainId)
          const calldata = '0x' + ts.toString(16).padStart(64, '0')
          const result = await resolvedHelios.request<string>(
            'eth_call', [{ to: EIP4788_CONTRACT, data: calldata }, 'finalized'],
          )
          const rootFromRing = result.length === 66 ? result : '0x' + result.slice(-64)
          if (rootFromRing.toLowerCase() !== eraBsrCache.effectiveBeaconRoot.toLowerCase()) {
            console.log('[w3] EIP-4788 root mismatch — BSR cache expired, re-downloading')
          } else if (!verifyHistoricalSummariesFieldProof(eraBsrCache.histSummaries, eraBsrCache.fieldProof, eraBsrCache.stateRoot)) {
            console.warn('[w3] BSR cache field proof mismatch — re-downloading')
          } else {
            eraBsrHit = true
            for (const e of uniqueEras) {
              const idx = historicalSummariesIndex(e, chainId)
              bsrByEra.set(e, hexlify(raw.slice(idx * 64, idx * 64 + 32)))
            }
            console.log('[w3] EIP-4788 + field proof verified — skipping BeaconState download ✓')
          }
        } catch (e) {
          console.log(`[w3] EIP-4788 check failed (${(e as Error).message}) — re-downloading`)
        }
      }
    }
  }

  if (!eraBsrHit) {
    const primaryHsIndex = historicalSummariesIndex(primary.era, chainId)
    const [stateSummary, primaryRange] = await Promise.all([
      getBlockSummaryRoot(consensusRpcs, anchor.slot, anchor.stateRoot, primaryHsIndex, primary.era, chainId, slots.map(s => s.slot), options?.checkpointUrls, options?.stateSource),
      findEraBlockRange(execRpcs, primary.era * 8192, chainId),
    ])
    if (stateSummary.blockSummaryRoot) bsrByEra.set(primary.era, stateSummary.blockSummaryRoot)
    blockRootsAtSlots = stateSummary.blockRootsAtSlots
    rangeByEra.set(primary.era, primaryRange)
    effectiveStateRoot = stateSummary.effectiveStateRoot
    effectiveSlot = stateSummary.effectiveSlot

    // Other target eras' block_summary_roots come from the same blob — the getter reads
    // from the state whose full hash_tree_root was just verified, so it's authenticated.
    const blobRaw = Uint8Array.from(atob(stateSummary.getHistoricalSummariesBlob()), c => c.charCodeAt(0))
    for (const e of uniqueEras) {
      if (bsrByEra.has(e)) continue
      const idx = historicalSummariesIndex(e, chainId)
      if (idx >= 0 && (idx + 1) * 64 <= blobRaw.length)
        bsrByEra.set(e, hexlify(blobRaw.slice(idx * 64, idx * 64 + 32)))
    }

    // Fetch effectiveBeaconRoot: beacon block root at effectiveSlot, SSZ-verified by
    // requiring header.state_root == effectiveStateRoot (ties root to the verified state).
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

  // Step 3: Resolve era block roots per era — one download covers every target chunk
  // in that era. Skipped for targets covered by the rolling window or a cached proof.
  const cachedPaths = options?.cachedProof?.merklePaths
  const cachedPathFor = (i: number): string | null =>
    (cachedPaths && cachedPaths.length === slots.length ? cachedPaths[i] : null) ?? null
  const eraRootsByEra = new Map<number, Uint8Array[]>()

  for (const e of uniqueEras) {
    const needed = slots.some((s, i) => s.era === e && !blockRootsAtSlots[s.slot] && !cachedPathFor(i))
    if (!needed) {
      console.log(`[w3] Era ${e}: all targets covered by rolling window / cached proofs — skipping era download`)
      continue
    }
    const bsr = bsrByEra.get(e)
    if (!bsr) throw new Error(`Era ${e}: historical_summaries entry unavailable`)
    const range = rangeByEra.get(e) ?? await findEraBlockRange(execRpcs, e * 8192, chainId)
    rangeByEra.set(e, range)
    const needExecHeaders = e + 1 >= currentEra
    const useEra     = options?.eraFileUrls === undefined || options.eraFileUrls.length > 0
    const useParquet = options?.parquetUrls === undefined || options.parquetUrls.length > 0
    const forced = options?.eraSource && options.eraSource !== 'auto' ? options.eraSource : null
    let eraBlockRoots: Uint8Array[] | null = null

    if (forced) {
      // Dev mode: run exactly the requested source and let it fail if it can't
      // serve this era — falling back would hide the thing being tested.
      console.log(`[w3] Era ${e}: dev mode — forcing ${forced}`)
      if (forced !== 'exec-headers' && needExecHeaders) {
        throw new Error(
          `Dev mode: era ${e} is too recent for ${forced} — era files and parquet are only ` +
          `published once an era is complete (current era ${currentEra}). Use exec-headers, or auto.`,
        )
      }
      if (forced === 'era-file') {
        eraBlockRoots = await fetchEraBlockRootsFromEraFile(e + 1, chainId, bsr, options?.eraFileUrls)
      } else if (forced === 'parquet') {
        eraBlockRoots = await fetchEraBlockRootsFromParquet(e, chainId, bsr, options?.parquetUrls)
      } else {
        eraBlockRoots = await fetchEraBlockRootsFromExecHeaders(
          execRpcs, e, chainId, bsr, range.startNum, range.endNum, options?.rpcBatchSizes,
        )
      }
      if (!eraBlockRoots) throw new Error(`Dev mode: ${forced} could not supply block_roots for era ${e}`)
      eraRootsByEra.set(e, eraBlockRoots)
      continue
    }

    if (!needExecHeaders && useEra) {
      eraBlockRoots = await fetchEraBlockRootsFromEraFile(e + 1, chainId, bsr, options?.eraFileUrls)
    }
    if (!eraBlockRoots && !needExecHeaders && useParquet) {
      console.log(`[w3] Era ${e}: trying parquet (ethpandaops xatu)`)
      eraBlockRoots = await fetchEraBlockRootsFromParquet(e, chainId, bsr, options?.parquetUrls)
    }
    if (!eraBlockRoots) {
      console.log(`[w3] Era ${e}: falling back to exec headers`)
      eraBlockRoots = await fetchEraBlockRootsFromExecHeaders(
        execRpcs, e, chainId, bsr, range.startNum, range.endNum, options?.rpcBatchSizes,
      )
    }
    eraRootsByEra.set(e, eraBlockRoots)
  }

  // Steps 4+5 per target (deduped by slot — chunks in the same block share a beacon block):
  // fetch the beacon header at the slot, verify its root against the era block_roots entry /
  // rolling-window root / cached Merkle proof, then verify the body and match the
  // execution_block_hash against the target's expected hash.
  const merklePaths: (string | null)[] = slots.map((_, i) => cachedPathFor(i))
  const rootBySlot = new Map<number, string>()
  const execHashBySlot = new Map<number, string>()

  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]

    const doneHash = execHashBySlot.get(s.slot)
    if (doneHash !== undefined) {
      if (doneHash.toLowerCase() !== s.executionHash.toLowerCase())
        throw new Error(`Execution hash mismatch: beacon body at slot ${s.slot} says ${doneHash}, tx says ${s.executionHash}`)
      continue
    }

    const eraRoots = eraRootsByEra.get(s.era)
    const windowRoot = blockRootsAtSlots[s.slot]
    const cached = cachedPathFor(i)

    // Step 4: header at target slot, root verified against an authenticated source.
    let verifiedBodyRoot = ''
    let verifiedBeaconRoot = ''
    for (const rpc of consensusRpcs) {
      try {
        const { root, msg } = await fetchVerifiedBeaconHeader(rpc, s.slot)
        if (windowRoot) {
          if (root.toLowerCase() !== windowRoot.toLowerCase())
            throw new Error(`Beacon header root ${root} ≠ BeaconState block_roots[${s.slotInEra}] ${windowRoot}`)
          console.log(`[w3] Beacon header at slot ${s.slot} verified against BeaconState block_roots ✓`)
        } else if (eraRoots) {
          const expected = hexlify(eraRoots[s.slotInEra])
          if (root.toLowerCase() !== expected.toLowerCase())
            throw new Error(`Beacon header root ${root} ≠ era block_roots[${s.slotInEra}] ${expected}`)
          console.log(`[w3] Beacon header at slot ${s.slot} verified against era block_roots ✓`)
          merklePaths[i] = encodeMerklePath(merkleProof(eraRoots, s.slotInEra))
        } else if (cached) {
          const bsr = bsrByEra.get(s.era)
          if (!bsr) throw new Error(`Era ${s.era}: historical_summaries entry unavailable for cached proof`)
          const path     = decodeMerklePath(cached)
          const computed = hexlify(merkleVerify(getBytes(root), s.slotInEra, path))
          if (computed.toLowerCase() !== bsr.toLowerCase())
            throw new Error(`Merkle proof mismatch: computed ${computed} ≠ blockSummaryRoot ${bsr}`)
          console.log(`[w3] Beacon header at slot ${s.slot} verified against cached Merkle proof ✓`)
        } else {
          throw new Error(`No verification source for slot ${s.slot}`)
        }
        verifiedBodyRoot   = msg.body_root
        verifiedBeaconRoot = root
        break
      } catch (err) {
        if ((err as Error).message.includes('≠') || (err as Error).message.includes('mismatch')) throw err
      }
    }
    if (!verifiedBodyRoot) throw new Error(`Could not fetch beacon header for slot ${s.slot}`)

    // Step 5: body → verify body_root → extract execution_block_hash → match target.
    let executionHash: string | undefined
    for (const rpc of consensusRpcs) {
      try {
        executionHash = await fetchVerifyBeaconBodyHash(rpc, s.slot, verifiedBodyRoot)
        break
      } catch (err) {
        console.warn(`[w3] Body verification failed (${rpc}):`, (err as Error).message)
      }
    }
    if (!executionHash) throw new Error(`Could not verify beacon block body at slot ${s.slot}`)
    if (executionHash.toLowerCase() !== s.executionHash.toLowerCase())
      throw new Error(
        `Execution hash mismatch: beacon body says ${executionHash}, tx says ${s.executionHash}`,
      )

    rootBySlot.set(s.slot, verifiedBeaconRoot)
    execHashBySlot.set(s.slot, executionHash)
  }
  console.log(`[w3] execution_block_hash verified end-to-end for ${execHashBySlot.size} block(s) ✓`)

  // Step 6: Helios anchor — once for the whole batch.
  // BSR cache hit: Helios already confirmed stateRoot in step 2 — mark anchored.
  // Normal path: confirm effectiveStateRoot against Helios.
  let heliosAnchored = false
  if (eraBsrHit) {
    heliosAnchored = true
    console.log('[w3] Helios anchor: ✓ confirmed (EIP-4788 cache hit)')
  } else {
    const resolvedHelios = heliosRpc instanceof Promise ? await heliosRpc : heliosRpc
    if (resolvedHelios && effectiveBeaconRoot) {
      heliosAnchored = await confirmWithHelios(resolvedHelios, effectiveBeaconRoot, effectiveSlot, chainId)
    }
    console.log(`[w3] Helios anchor: ${heliosAnchored ? '✓ confirmed' : 'not confirmed (unanchored result)'}`)
  }

  return {
    slot: primary.slot,
    beaconBlockRoot: rootBySlot.get(primary.slot) ?? '',
    heliosAnchored,
    eraVerified: true,
    stateHashVerified: true,
    // Preserve cached paths for chunks that didn't need fresh era data this run.
    proofData: merklePaths.some(p => p !== null) ? { merklePaths } : undefined,
    newBsrCache,
  }
}

export function isEip2935Error(err: unknown): boolean {
  return String((err as Error)?.message).includes('EIP-2935')
}
