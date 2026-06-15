# W3FS — Web3 FileSystem Calldata Format

W3FS is a binary encoding for content stored as Ethereum transaction calldata. It gives the web3 browser enough information to decompress and render the payload without any external metadata.

---

## Why calldata

Contract storage (SSTORE) costs ~20,000 gas per 32-byte slot. Calldata costs 16 gas per non-zero byte. For a 1 KB HTML page the difference is roughly **50× cheaper** via calldata.

The trade-off: calldata is write-once and not directly readable by contracts. A URL must reference the transaction hash (or a registry contract that stores it).

---

## Binary layout

```
Offset  Size    Field
──────────────────────────────────────────────────────
0       4       Magic: 0x57334653 ("W3FS")
4       1       Version: 0x01
5       2       Content-Type length N (big-endian uint16)
7       N       Content-Type string (UTF-8, e.g. "text/html; charset=utf-8")
7+N     1       Compression:  0 = none
                              1 = gzip
                              2 = deflate
                              3 = brotli
8+N     4       Chunk index (big-endian uint32, 0-based)
12+N    4       Total chunks (big-endian uint32)
16+N    *       Payload bytes
```

---

## Single-chunk example

A gzip-compressed HTML page in one transaction:

```
57 33 46 53          magic
01                   version 1
00 18                content-type length = 24
74 65 78 74 2f 68    "text/html; charset=utf-8"
74 6d 6c 3b 20 63
68 61 72 73 65 74
3d 75 74 66 2d 38
01                   compression = gzip
00 00 00 00          chunk index 0
00 00 00 01          total chunks 1
1f 8b 08 00 ...      gzipped payload
```

---

## Multi-chunk content

Large files (images, JS bundles) that exceed a practical calldata size can be split across multiple transactions. Each transaction carries one chunk with the same total-chunks value. The chunks are assembled in index order before decompression.

A registry contract or ENS text record holds the ordered list of transaction hashes.

```
tx[0]  → chunk 0 of 3
tx[1]  → chunk 1 of 3
tx[2]  → chunk 2 of 3
```

The extension fetches and verifies each transaction independently, then concatenates the payloads and decompresses once.

---

## URL scheme

```
web3://[chainId:]tx:0x<txhash>
```

| Component  | Example                  | Notes                        |
|------------|--------------------------|------------------------------|
| chainId    | `11155111`               | Optional, defaults to 1      |
| tx:        | literal prefix           | Identifies tx-hash mode      |
| txhash     | `0xabc123...`            | 32-byte transaction hash     |

Examples:
```
web3://tx:0xabc...                    mainnet transaction
web3://11155111:tx:0xabc...           Sepolia transaction
```

---

## Verification

The extension verifies content authenticity before rendering:

1. **Helios** syncs to the Ethereum consensus layer via sync-committee signatures and returns a verified block header containing `transactionsRoot`.
2. **Local MPT** — all transactions in the block are fetched, the Patricia Merkle Trie is reconstructed locally, and its root is compared against the Helios-verified `transactionsRoot`.
3. If the roots match, the calldata in the target transaction is cryptographically proven to be part of that block. No trusted RPC can forge it.

---

## Tooling

| Script | Purpose |
|--------|---------|
| `scripts/encode-w3fs.js` | Encode a file into W3FS calldata hex |
| `scripts/publish.js`     | Send the calldata to a chain and print the web3:// URL |

```bash
# Encode and publish in one command
export PRIVATE_KEY=0x…
node scripts/encode-w3fs.js scripts/hello-sepolia.html | node scripts/publish.js
```
