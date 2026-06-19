#!/usr/bin/env node
// Set ENS text records so portal://<name>.eth resolves to your calldata.
//
// Usage:
//   node scripts/set-ens.js <ens-name> <rpc-url> <private-key> <ref> [<ref2> ...]
//
// Each <ref> is either:
//   - A tx hash  "0x..."          — looked up on-chain to get blockNumber + txIndex
//   - Coordinates "blockNum:idx"  — used directly, no lookup needed
//
// Writes the compact format: [[blockNumber, txIndex], ...]
//
// Prerequisites:
//   - You own the ENS name (or have approval to set text records)
//   - The resolver must support the setText() interface (PublicResolver does)

import { ethers } from 'ethers'

const [,, ensName, rpcUrl, privateKey, ...rest] = process.argv

if (!ensName || !rpcUrl || !privateKey) {
  console.error('Usage:')
  console.error('  node scripts/set-ens.js <name> <rpc> <key> <block>:<idx> [...]')
  console.error('  node scripts/publish.js < bundle.hex | node scripts/set-ens.js <name> <rpc> <key>')
  process.exit(1)
}

// Read refs from args or from stdin (piped from publish.js)
let refs
if (rest.length > 0) {
  refs = rest
  for (const ref of refs) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(ref) && !/^\d+:\d+$/.test(ref)) {
      console.error(`Invalid ref (expected 0x<hash> or <block>:<idx>): ${ref}`); process.exit(1)
    }
  }
} else {
  const stdin = []
  for await (const chunk of process.stdin) stdin.push(chunk)
  const raw = Buffer.concat(stdin).toString().trim()
  if (!raw) { console.error('No refs provided and stdin is empty'); process.exit(1) }
  try {
    const parsed = JSON.parse(raw)
    refs = parsed.map(([b, i]) => `${b}:${i}`)
  } catch {
    console.error(`Could not parse stdin as JSON array: ${raw}`); process.exit(1)
  }
}

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
const REGISTRY_ABI = ['function resolver(bytes32 node) view returns (address)']
const RESOLVER_ABI = ['function setText(bytes32 node, string key, string value) external']

async function main() {
  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const wallet = new ethers.Wallet(privateKey, provider)
  const chainId = (await provider.getNetwork()).chainId

  const chunks = await Promise.all(refs.map(async (ref) => {
    if (/^\d+:\d+$/.test(ref)) {
      const [blockNumber, txIndex] = ref.split(':').map(Number)
      return [blockNumber, txIndex]
    }
    console.log(`Looking up ${ref.slice(0, 18)}...`)
    const tx = await provider.getTransaction(ref)
    if (!tx) throw new Error(`Transaction not found: ${ref}`)
    console.log(`  → block ${tx.blockNumber}, txIndex ${tx.index}`)
    return [tx.blockNumber, tx.index]
  }))

  const registry = new ethers.Contract(ENS_REGISTRY, REGISTRY_ABI, provider)
  const node = ethers.namehash(ensName)

  const resolverAddr = await registry.resolver(node)
  if (resolverAddr === ethers.ZeroAddress) {
    console.error(`No resolver set for ${ensName}. Set one at app.ens.domains first.`)
    process.exit(1)
  }

  const resolver = new ethers.Contract(resolverAddr, RESOLVER_ABI, wallet)
  const value = JSON.stringify(chunks)
  console.log(`\nSetting text record "portal" = ${value}`)
  const tx = await resolver.setText(node, 'portal', value)
  await tx.wait()
  const chainPrefix = chainId.toString() === '1' ? '' : `${chainId}:`
  console.log(`✓ Done. Browse at: portal://${chainPrefix}${ensName}`)
}

main().catch((err) => { console.error(err.message); process.exit(1) })
