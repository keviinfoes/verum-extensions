#!/usr/bin/env node
// Seed a block body into a local Portal node via portal_historyStore.
// Usage: node scripts/portal-seed-block.js <blockNumber>
//   PORTAL_RPC  - Portal node JSON-RPC URL (default: http://127.0.0.1:8565)
//   EL_RPC      - Execution layer RPC URL  (default: https://eth.llamarpc.com)
//
// Example (mainnet block 21000000):
//   node scripts/portal-seed-block.js 21000000
//
// Example (Sepolia block):
//   EL_RPC=https://ethereum-sepolia-rpc.publicnode.com node scripts/portal-seed-block.js 7500000

import { encodeRlp, getBytes, hexlify, toBeArray } from 'ethers'

const PORTAL_RPC = process.env.PORTAL_RPC ?? 'http://127.0.0.1:8565'
const EL_RPC     = process.env.EL_RPC     ?? 'https://eth.llamarpc.com'

const blockNumber = parseInt(process.argv[2])
if (!blockNumber) {
  console.error('Usage: node scripts/portal-seed-block.js <blockNumber>')
  process.exit(1)
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  })
  const json = await res.json()
  if (json.error) throw new Error(`${method}: ${json.error.message}`)
  return json.result
}

function h(hex) {
  if (!hex || hex === '0x' || hex === '0x0') return new Uint8Array(0)
  const s = hex.length % 2 ? '0x0' + hex.slice(2) : hex
  const raw = getBytes(s)
  // strip leading zeros for RLP integers
  let i = 0
  while (i < raw.length - 1 && raw[i] === 0) i++
  return raw.slice(i)
}

function addr(hex) {
  return hex ? getBytes(hex) : new Uint8Array(0)
}

function accessListRlp(list = []) {
  return list.map(item => [getBytes(item.address), item.storageKeys.map(getBytes)])
}

function serializeTx(tx) {
  const type = tx.type ? parseInt(tx.type, 16) : 0
  const yp = h(tx.yParity ?? tx.v)
  const concat = (...parts) => {
    const total = parts.reduce((n, p) => n + p.length, 0)
    const out = new Uint8Array(total)
    let pos = 0; for (const p of parts) { out.set(p, pos); pos += p.length }
    return out
  }
  if (type === 0) return getBytes(encodeRlp([h(tx.nonce), h(tx.gasPrice), h(tx.gas), addr(tx.to), h(tx.value), getBytes(tx.input), h(tx.v), h(tx.r), h(tx.s)]))
  if (type === 1) return concat(new Uint8Array([0x01]), getBytes(encodeRlp([h(tx.chainId), h(tx.nonce), h(tx.gasPrice), h(tx.gas), addr(tx.to), h(tx.value), getBytes(tx.input), accessListRlp(tx.accessList), yp, h(tx.r), h(tx.s)])))
  if (type === 2) return concat(new Uint8Array([0x02]), getBytes(encodeRlp([h(tx.chainId), h(tx.nonce), h(tx.maxPriorityFeePerGas), h(tx.maxFeePerGas), h(tx.gas), addr(tx.to), h(tx.value), getBytes(tx.input), accessListRlp(tx.accessList), yp, h(tx.r), h(tx.s)])))
  if (type === 3) return concat(new Uint8Array([0x03]), getBytes(encodeRlp([h(tx.chainId), h(tx.nonce), h(tx.maxPriorityFeePerGas), h(tx.maxFeePerGas), h(tx.gas), addr(tx.to), h(tx.value), getBytes(tx.input), accessListRlp(tx.accessList), h(tx.maxFeePerBlobGas), (tx.blobVersionedHashes ?? []).map(getBytes), yp, h(tx.r), h(tx.s)])))
  throw new Error(`Unsupported tx type: ${type}`)
}

function blockBodyContentKey(n) {
  const buf = new Uint8Array(9)
  const v = new DataView(buf.buffer)
  v.setUint8(0, 0x00)
  v.setUint32(1, n >>> 0, true)
  v.setUint32(5, Math.floor(n / 0x100000000), true)
  return '0x' + Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------

console.log(`Fetching block ${blockNumber} from ${EL_RPC} ...`)
const block = await rpc(EL_RPC, 'eth_getBlockByNumber', [`0x${blockNumber.toString(16)}`, true])
if (!block) throw new Error(`Block ${blockNumber} not found`)
console.log(`  hash: ${block.hash}  txs: ${block.transactions.length}`)

// Serialize each transaction to raw bytes (same format used in block body)
const txBytes = block.transactions.map(serializeTx)

// RLP-encode block body: [transactions, uncles, [withdrawals]]
// Post-Shanghai includes withdrawals; pre-Shanghai omits the field
const txsRlp = txBytes  // already raw bytes — use as byte strings in RLP
// For RLP we need to pass them as Uint8Arrays (byte strings, not nested lists)
const uncles = []
const withdrawals = block.withdrawals ?? null

let bodyRlp
if (withdrawals !== null) {
  // Post-Shanghai: [txs, uncles, withdrawals]
  const wRlp = withdrawals.map(w => [
    h(w.index), h(w.validatorIndex), getBytes(w.address), h(w.amount),
  ])
  bodyRlp = getBytes(encodeRlp([txBytes, uncles, wRlp]))
} else {
  bodyRlp = getBytes(encodeRlp([txBytes, uncles]))
}

const contentKey = blockBodyContentKey(blockNumber)
const contentValue = hexlify(bodyRlp)

console.log(`\nContent key : ${contentKey}`)
console.log(`Body RLP len: ${bodyRlp.length} bytes`)
console.log(`Storing into Portal node at ${PORTAL_RPC} ...`)

const stored = await rpc(PORTAL_RPC, 'portal_historyStore', [contentKey, contentValue])
console.log(`\nStored: ${stored}`)

// Verify by reading back
console.log('\nVerifying — reading back via portal_historyGetContent ...')
const retrieved = await rpc(PORTAL_RPC, 'portal_historyGetContent', [contentKey])
console.log(`Content retrieved: ${retrieved.content.length} hex chars (${retrieved.content.length / 2 - 1} bytes)`)
console.log(`Match: ${retrieved.content.toLowerCase() === contentValue.toLowerCase()}`)
