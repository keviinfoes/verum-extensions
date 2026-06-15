#!/usr/bin/env node
// Set ENS text records so web3://<name>.eth resolves to your calldata.
//
// Usage:
//   node scripts/set-ens.js <ens-name> <rpc-url> <private-key> <tx-hash> [<tx-hash2> ...]
//
// Examples:
//   # Single-chunk (one tx hash):
//   node scripts/set-ens.js myapp.eth https://ethereum-sepolia-rpc.publicnode.com 0xPRIVKEY 0xabc123...
//
//   # Multi-chunk (multiple tx hashes in order):
//   node scripts/set-ens.js myapp.eth https://ethereum-sepolia-rpc.publicnode.com 0xPRIVKEY 0xhash0 0xhash1 0xhash2
//
// Prerequisites:
//   - You own the ENS name (or have approval to set text records)
//   - The resolver must support the setText() interface (PublicResolver does)

import { ethers } from 'ethers'

const [,, ensName, rpcUrl, privateKey, ...txHashes] = process.argv

if (!ensName || !rpcUrl || !privateKey || txHashes.length === 0) {
  console.error('Usage: node scripts/set-ens.js <ens-name> <rpc-url> <private-key> <tx-hash> [<tx-hash2> ...]')
  process.exit(1)
}

// Validate tx hashes
for (const h of txHashes) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) {
    console.error(`Invalid tx hash: ${h}`)
    process.exit(1)
  }
}

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
const REGISTRY_ABI = ['function resolver(bytes32 node) view returns (address)']
const RESOLVER_ABI = ['function setText(bytes32 node, string key, string value) external']

async function main() {
  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const wallet = new ethers.Wallet(privateKey, provider)
  const chainId = (await provider.getNetwork()).chainId

  const registry = new ethers.Contract(ENS_REGISTRY, REGISTRY_ABI, provider)
  const node = ethers.namehash(ensName)

  const resolverAddr = await registry.resolver(node)
  if (resolverAddr === ethers.ZeroAddress) {
    console.error(`No resolver set for ${ensName}. Set one at app.ens.domains first.`)
    process.exit(1)
  }

  const resolver = new ethers.Contract(resolverAddr, RESOLVER_ABI, wallet)

  const value = JSON.stringify(txHashes)
  console.log(`Setting text record "web3" = ${value}`)
  const tx = await resolver.setText(node, 'web3', value)
  await tx.wait()
  const chainPrefix = chainId.toString() === '1' ? '' : `${chainId}:`
  console.log(`✓ Done. Browse at: web3://${chainPrefix}${ensName}`)
}

main().catch((err) => { console.error(err.message); process.exit(1) })
