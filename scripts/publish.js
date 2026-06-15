#!/usr/bin/env node
// Publishes W3FS calldata to Sepolia and prints the web3:// URL.
// Usage:
//   node scripts/publish.js <calldata-hex>
//   node scripts/encode-w3fs.js hello-sepolia.html | node scripts/publish.js
//
// Required env:
//   PRIVATE_KEY   — 0x-prefixed private key with Sepolia ETH
//   RPC_URL       — Sepolia JSON-RPC (default: https://rpc.sepolia.org)

import { Wallet, JsonRpcProvider, toUtf8Bytes } from 'ethers'

const RPC_URL    = process.env.RPC_URL    ?? 'https://rpc.sepolia.org'
const PRIVATE_KEY = process.env.PRIVATE_KEY

if (!PRIVATE_KEY) {
  console.error('Error: set PRIVATE_KEY environment variable')
  console.error('  export PRIVATE_KEY=0x<your-sepolia-key>')
  process.exit(1)
}

// Read calldata from argument or stdin
let calldata
if (process.argv[2]) {
  calldata = process.argv[2].trim()
} else {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  calldata = Buffer.concat(chunks).toString().trim()
}

if (!calldata.startsWith('0x')) {
  console.error('Error: calldata must start with 0x')
  process.exit(1)
}

// Validate W3FS magic
const magic = calldata.slice(2, 10)
if (magic.toLowerCase() !== '57334653') {
  console.error(`Warning: magic bytes are 0x${magic}, expected 0x57334653 (W3FS)`)
}

console.error(`Connecting to ${RPC_URL}...`)
const provider = new JsonRpcProvider(RPC_URL)
const wallet   = new Wallet(PRIVATE_KEY, provider)

const { chainId } = await provider.getNetwork()
console.error(`Chain ID: ${chainId}`)
if (chainId !== 11155111n) {
  console.error('Warning: not on Sepolia (chainId 11155111)')
}

const balance = await provider.getBalance(wallet.address)
console.error(`Sender:  ${wallet.address}`)
console.error(`Balance: ${Number(balance) / 1e18} ETH`)

if (balance === 0n) {
  console.error('Error: no ETH — get Sepolia ETH from https://sepoliafaucet.com')
  process.exit(1)
}

console.error(`Sending ${(calldata.length / 2 - 1).toLocaleString()} bytes of calldata...`)

// Send to self — calldata is stored regardless of recipient
const tx = await wallet.sendTransaction({
  to: wallet.address,
  data: calldata,
})

console.error(`Tx hash: ${tx.hash}`)
console.error('Waiting for confirmation...')

const receipt = await tx.wait(1)
console.error(`✓ Confirmed in block ${receipt.blockNumber}`)
console.error('')
console.error('─────────────────────────────────────────')
console.error(`web3://11155111:tx:${tx.hash}`)
console.error('─────────────────────────────────────────')
console.error('')
console.error('Load the extension and enter the URL above in the omnibox:')
console.error(`  web3 11155111:tx:${tx.hash}`)
