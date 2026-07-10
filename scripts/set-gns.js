#!/usr/bin/env node
// Set GNS (.gwei) text records so w3://<name>.gwei resolves to your calldata.
// GNS: https://github.com/lucadonnoh/gwei-names — an ownerless ENS-compatible
// name service. Unlike ENS there's no registry/resolver split or NameWrapper:
// the NameNFT contract is a plain ERC-721, and setText() just checks ownerOf().
//
// Usage:
//   node scripts/set-gns.js <name.gwei> <rpc-url> <private-key> <ref> [<ref2> ...]
//
// Each <ref> is coordinates "blockNum:idx", used directly — no lookup needed.
//
// Writes the compact format: [[blockNumber, txIndex], ...]
//
// Prerequisites:
//   - You own the .gwei name (registered via https://gwei.domains)

import { ethers } from 'ethers'

const rawArgs = process.argv.slice(2)
const [gnsName, rpcUrl, privateKey, ...rest] = rawArgs

if (!gnsName || !rpcUrl || !privateKey) {
  console.error('Usage:')
  console.error('  node scripts/set-gns.js <name.gwei> <rpc> <key> <block>:<idx> [...]')
  console.error('  node scripts/publish.js < bundle.hex | node scripts/set-gns.js <name.gwei> <rpc> <key>')
  process.exit(1)
}

// Read refs from args or from stdin (piped from publish.js)
let refs
if (rest.length > 0) {
  refs = rest
  for (const ref of refs) {
    if (!/^\d+:\d+$/.test(ref)) {
      console.error(`Invalid ref (expected <block>:<idx>): ${ref}`); process.exit(1)
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

const chunks = refs.map((ref) => ref.split(':').map(Number))

// Same address on mainnet and Sepolia.
const NAME_NFT = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6'

const NAME_NFT_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function isExpired(uint256 tokenId) view returns (bool)',
  'function setText(uint256 tokenId, string key, string value)',
]

async function main() {
  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const wallet = new ethers.Wallet(privateKey, provider)
  const chainId = (await provider.getNetwork()).chainId

  // Token ID = uint256(namehash(name)) — same EIP-137 algorithm ethers.namehash
  // already implements, no GNS-specific hashing needed.
  const tokenId = BigInt(ethers.namehash(gnsName))

  const nameNft = new ethers.Contract(NAME_NFT, NAME_NFT_ABI, provider)

  let owner
  try {
    owner = await nameNft.ownerOf(tokenId)
  } catch {
    console.error(`"${gnsName}" is not registered. Register it first at https://gwei.domains`)
    process.exit(1)
  }
  if (await nameNft.isExpired(tokenId)) {
    console.error(`"${gnsName}" is expired (past its grace period). Register it first at https://gwei.domains`)
    process.exit(1)
  }
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error(`Not authorized: "${gnsName}" is owned by ${owner}, signer is ${wallet.address}`)
    process.exit(1)
  }

  const value = JSON.stringify(chunks)
  console.log(`\nSetting text record "w3" = ${value}`)

  const nameNftWrite = nameNft.connect(wallet)
  const tx = await nameNftWrite.setText(tokenId, 'w3', value)
  await tx.wait()
  const chainPrefix = chainId.toString() === '1' ? '' : `${chainId}:`
  console.log(`✓ Done. Browse at: w3://${chainPrefix}${gnsName}`)
}

main().catch((err) => { console.error(err.message); process.exit(1) })
