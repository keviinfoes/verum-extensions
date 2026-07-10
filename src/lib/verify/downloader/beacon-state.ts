// Downloads the finalized BeaconState from a consensus RPC or checkpoint sync
// provider, verifies its SSZ hash_tree_root, and extracts
// historical_summaries[hsIndex].block_summary_root — plus block_roots[slot % 8192]
// directly for any target slot within the state's rolling 8192-slot window.

import { computeBeaconStateRoot } from '../ssz-state-verifier.js'
import { readU32LE } from '../beacon-primitives.js'

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

export interface StateSummary {
  blockSummaryRoot: string
  effectiveStateRoot: string
  effectiveSlot: number
  blockRootsAtSlots: Record<number, string>  // slot → block_roots[slot % 8192] for slots within the rolling window
  getHistoricalSummariesBlob: () => string
  computeHistoricalSummariesFieldProof: () => string
}

export async function getBlockSummaryRoot(
  consensusRpcs: string[],
  anchorSlot: number,
  anchorStateRoot: string,
  hsIndex: number,
  era: number,
  chainId: number,
  targetSlots: number[],
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

    // Fast path: for every target slot within the rolling block_roots window of this
    // state, read block_roots[slot % 8192] directly (authenticated by hash_tree_root(BeaconState)).
    const blockRootsAtSlots: Record<number, string> = {}
    for (const targetSlot of targetSlots) {
      if (stateSlot >= targetSlot && stateSlot - targetSlot < 8192) {
        const root = verifier.getBlockRootAtSlot(targetSlot)
        if (!/^0x0+$/.test(root)) {
          blockRootsAtSlots[targetSlot] = root
          console.log(`[w3] block_roots[${targetSlot % 8192}] from BeaconState: ${root}`)
        }
      }
    }

    const blockSummaryRoot = verifier.getBlockSummaryRoot(hsIndex)
    if (!blockSummaryRoot && Object.keys(blockRootsAtSlots).length === 0)
      throw new Error(`historical_summaries[${hsIndex}] (era ${era}) not found and no slot in rolling window`)
    if (blockSummaryRoot)
      console.log(`[w3] historical_summaries[${hsIndex}] (era ${era}) block_summary_root: ${blockSummaryRoot}`)
    return { blockSummaryRoot: blockSummaryRoot ?? '', effectiveStateRoot: verifier.computedRoot, effectiveSlot: stateSlot, blockRootsAtSlots, getHistoricalSummariesBlob: () => verifier.getHistoricalSummariesBlob(), computeHistoricalSummariesFieldProof: () => verifier.computeHistoricalSummariesFieldProof() }
  }

  // Use configured URLs when provided; fall back to built-in defaults only when undefined.
  const checkpointRpcs = customCheckpointUrls !== undefined
    ? customCheckpointUrls
    : (CHECKPOINT_SYNC_RPCS[chainId] ?? [])

  // Race checkpoint providers and consensus RPCs — interleaved so both types start early.
  // Stagger 3s between each start: a fast failure triggers the next immediately while
  // a slow download stays solo to avoid parallel bloat.
  // Checkpoint CDNs only retain their current finalized epoch boundary. By the time a 27h
  // cache expires the chain has advanced several epochs and anchorSlot-32 is gone. Query
  // each CDN's live finalized slot first and request that - 32 (the epoch boundary they hold).
  // Consensus RPC nodes serve any recent slot so anchorSlot-32 is fine.
  const dlSlot = anchorSlot - 32

  const fetchLiveDlSlot = async (rpc: string): Promise<number> => {
    try {
      const hRes = await fetch(`${rpc}/eth/v1/beacon/headers/finalized`, {
        headers: { Accept: 'application/json' },
        signal: ctrl.signal,
      })
      if (hRes.ok) {
        const hJson = await hRes.json() as { data: { header: { message: { slot: string } } } }
        const finSlot = parseInt(hJson.data.header.message.slot, 10)
        if (finSlot > 0) return finSlot - 32
      }
    } catch { /* fall back */ }
    return dlSlot
  }

  const cpAttempts = checkpointRpcs.map(rpc => async () => attempt(rpc, await fetchLiveDlSlot(rpc)))
  const cnAttempts = consensusRpcs.map(rpc => async () => attempt(rpc, await fetchLiveDlSlot(rpc)))
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
