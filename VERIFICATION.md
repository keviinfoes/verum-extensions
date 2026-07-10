# Verification flow — spec step → code location

How Verum verifies that dapp calldata is part of the canonical Ethereum chain, for
each of the four verification modes. Each mode reaches "trustless" (or its own trust boundary) via a different chain of
custody.

| Mode | Trust boundary | Badge condition |
|---|---|---|
| 1 — Helios (recent) | Trustless (sync committee) | `heliosBacked && trieVerified && ensOk` |
| 2 — Beacon (historical) | Trustless (sync committee via EIP-4788 anchor) | `beaconVerified && beaconHeliosBacked && trieVerified && ensOk` |
| 3 — Portal | Your local Portal node | `portalVerified && ensOk` |
| 4 — Local | Your local execution RPC | `localMode` |

The badge logic at `src/background.ts:786-791` gates green on the *complete* condition for the active
mode; there is no partial-pass green. Anything short — Helios unanchored, trie
mismatch, ENS unverified — shows ✗.

Name-based URLs (`w3://myapp.eth`, `w3://myapp.gwei`) require `ensOk` thourgh helios `ensVerified === true` in modes 1–3.

## Common to all modes (phase 1 — content fetch & assembly)

| Step | Check | Location |
|---|---|---|
| Name → `[[block, txIndex]]` | ENS: `registry.resolver(node)` + `text(node,"w3")`; GNS (.gwei): `text()` directly on NameNFT — via plain RPC at the `finalized` tag. Not yet trusted; re-verified per mode below | `src/lib/w3/name-resolver.ts:107` (registry pick), `:63` (finalized eth_call) |
| Calldata parsing | W3FS magic, version, chunk index/count, decompression — structural validation, not proof (the content *is* the tx data) | `src/lib/w3/content.ts:58` (`parseCalldata`), `:141` (`assembleContent`) |
| Calldata ∈ tx ∈ trie | `serializeTx` re-encodes every tx (incl. `tx.input` = the calldata) as trie leaves; recomputed root must equal `block.transactionsRoot`, else throw. Rendered bytes come from the same tx object | `src/lib/verify/tx-verifier.ts:224-227` (leaves + root), `:238` (rendered bytes) |

Phase 1 renders immediately; the badge stays "···" until one of the four phase-2 modes finishes verification.

## Mode 1 — Recent block, Helios-verified

```
ENS/GNS url name
  ▼  coordinates re-verified through Helios (started in parallel)
verified coordinates

+ 

dapp content (W3FS calldata bytes)
  ▼  calldata is the tx.data field
transaction, fetched fresh via Helios
  ▼  MPT trie reconstruction: RLP(tx) is a leaf, root == transactionsRoot, keccak(header) == blockhash
execution block, served by Helios
  ▼  Helios only serves blocks it already verified against its sync-committee chain
trustless anchor (Helios sync committee)
  ▼  byte-compare Helios-verified calldata against what phase 1 actually rendered
trustless anchor
```

Badge green requires `heliosBacked && trieVerified && ensOk` (`src/background.ts:788`).

| Step | Check | Location |
|---|---|---|
| Header → canonical chain | Helios serves `eth_getBlockByNumber` only after verifying it against its sync-committee-verified chain (EIP-2935 window, ~last 27h); Helios's own consensus verification is the anchor — **run per chunk, all chunks** | `src/background.ts` (Helios phase-2 loop over `phase1Results`), `src/lib/verify/tx-verifier.ts` (`headerVerified: rpc.isHeliosBacked()`) |
| Trie rebuild (again, via Helios data) | Same full-trie reconstruction as phase 1, but over the Helios-served block — per chunk | `src/lib/verify/tx-verifier.ts` (`getVerifiedCalldataByLocation`) |
| **Render binding** | Byte-for-byte comparison of each chunk's Helios-verified calldata against the bytes phase 1 actually rendered — a fast RPC serving a self-consistent forgery in phase 1 fails here (✗) instead of being green-lit by verifying canon at the same coordinates | `src/background.ts` (`bytesEqual` check in the Helios phase-2 loop) |
| ENS/GNS re-verification | Name re-resolved through a Helios-verified `eth_call` at `finalized`; chunk lists must match phase 1 | `src/background.ts` (`compareEnsChunks`) |

## Mode 2 — Historical block, beacon-verified

```
ENS/GNS url name
  ▼  coordinates re-verified through Helios (started in parallel)
verified coordinates

+ 

dapp content (W3FS calldata bytes)
  ▼  calldata is the tx.data field
transaction
  ▼  MPT trie reconstruction: RLP(tx) is a leaf, root == transactionsRoot, keccak(header) == blockhash
execution block hash
  ▼  SSZ: hash_tree_root(BeaconBlockBody) == body_root, body.execution_payload.block_hash == blockhash
beacon block root
  ▼  merkleize(block_roots[0..8192]) == historical_summaries[era].block_summary_root
block_summary_root
  ▼  hash_tree_root(BeaconState) == finalized state root
finalized state root
  ▼  Helios EIP-4788 eth_call proves the finalized beacon root trustlessly
trustless anchor
```

Badge green requires `beaconVerified && beaconHeliosAnchored && trieVerified && ensOk`
(`src/background.ts`, `updateBadge`). 

| Step | Check | Location |
|---|---|---|
| tx trie → header → blockhash | Per chunk: trie root == `transactionsRoot`; `keccak256(RLP(header)) == blockHash`; `tx[txIndex].hash` == phase-1 txHash. Verified on the **same block object whose calldata was rendered**, which is what binds the rendered bytes to the chain | `src/lib/verify/tx-verifier.ts` (`verifyTxInBlock`), per-chunk loops in `src/background.ts` (both beacon entry points) |
| Beacon header authenticity | Local `hash_tree_root(BeaconBlockHeader)` == claimed root (anchor, effectiveSlot, and every target slot) | `src/lib/verify/beacon-verifier.ts` (`fetchVerifiedBeaconHeader`) |
| blockhash → beacon body | Per target slot: local `hash_tree_root(BeaconBlockBody)` == `body_root`; extracted `execution_payload.block_hash` == that chunk's phase-1 blockhash | `src/lib/verify/beacon-verifier.ts` (`fetchVerifyBeaconBodyHash` + per-slot loop in `verifyViaBeacon`) |
| beacon root ∈ era `block_roots` | Full 8192-leaf merkleization == `block_summary_root`, once per era: rolling-window roots direct from verified state; era file; parquet; exec headers; per-chunk cached Merkle proofs | `src/lib/verify/beacon-verifier.ts` (per-era loop in `verifyViaBeacon`) |
| `block_summary_root` ∈ BeaconState | Full local `hash_tree_root(BeaconState)` == anchor state root; every target era's entry extracted from the same authenticated historical_summaries blob | `src/lib/verify/beacon-verifier.ts` (`getBlockSummaryRoot`); fast path: field proof + EIP-4788 ring check |
| State root → trustless anchor | EIP-4788 ring read via Helios-verified `eth_call` at `finalized` == `effectiveBeaconRoot` — once per batch | `src/lib/verify/beacon-verifier.ts` (`confirmWithHelios`) |
| ENS/GNS re-verification | Same Helios re-resolution as Mode 1 | `src/background.ts` (`compareEnsChunks`) |

## Mode 3 — Portal-trusted

```
ENS/GNS url name
  ▼  coordinates re-verified through Helios (started in parallel)
verified coordinates

+ 

dapp content (W3FS calldata bytes)
  ▼  calldata ∈ tx ∈ block ∈ canonical chain — verified by the Portal node before storing
trusted anchor: your own Portal node
```

Badge green requires `portalVerified && ensOk` (`src/background.ts:787`).

| Step | Check | Location |
|---|---|---|
| calldata ∈ tx ∈ block ∈ canonical chain | **Delegated to the user's local Portal node** — it verified the body against the header chain before storing. No local re-verification, by design; the beacon pipeline is skipped entirely | `src/background.ts:463-515` (branch + early return), fetch `src/lib/rpc/portal.ts:89-113` |
| ENS/GNS re-verification | Still done through Helios (started in parallel), even in Portal mode | `src/background.ts:489-490` |

Trust boundary: local portal node. The only cryptographic check the extension itself performs in this mode is the ENS/GNS cross-check.

## Mode 4 — Local mode

```
dapp content (W3FS calldata bytes)
  ▼  calldata is the tx.data field
transaction, from the local RPC
  ▼  MPT trie reconstruction: RLP(tx) is a leaf, root == RPC's own claimed transactionsRoot
trusted anchor: your own execution RPC (no blockhash/canonicality check beyond this)
```

Badge green unconditionally: `localMode === true` (`src/background.ts:790`).

| Step | Check | Location |
|---|---|---|
| Trie rebuild | Phase 1's full trie reconstruction still runs (throws on mismatch) — but against the *local RPC's own claimed* `transactionsRoot`; header→blockhash and canonicality are not checked | `src/lib/verify/tx-verifier.ts:224-227` via `src/background.ts:424` (with `rpcs[0]` only) |
| Everything else | **Trusted to the local execution RPC** — no Helios, no beacon, no ENS re-check (`ensVerified` not required) | `src/background.ts:522-538` |

Trust boundary: whatever node `rpcs[0]` points at — the mode exists for users running
their own full node, where verification against yourself is meaningless.