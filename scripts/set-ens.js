#!/usr/bin/env node
// Set ENS text records so w3://<name>.eth resolves to your calldata.
//
// Usage:
//   node scripts/set-ens.js <ens-name> <rpc-url> <private-key> <ref> [<ref2> ...]
//
// Each <ref> is coordinates "blockNum:idx", used directly — no lookup needed.
//
// Writes the compact format: [[blockNumber, txIndex], ...]
//
// Prerequisites:
//   - You own the ENS name (or have approval to set text records)
//   - The resolver must support the setText() interface (PublicResolver does)

import { ethers } from 'ethers'

// Optional --resolver <addr> flag: override the resolver used for setText.
// Useful when the auto-detected resolver has an incompatible NameWrapper reference.
let resolverOverride = null
const rawArgs = process.argv.slice(2)
const resolverFlagIdx = rawArgs.indexOf('--resolver')
if (resolverFlagIdx !== -1) {
  resolverOverride = rawArgs[resolverFlagIdx + 1]
  rawArgs.splice(resolverFlagIdx, 2)
}

const [ensName, rpcUrl, privateKey, ...rest] = rawArgs

if (!ensName || !rpcUrl || !privateKey) {
  console.error('Usage:')
  console.error('  node scripts/set-ens.js [--resolver <addr>] <name> <rpc> <key> <block>:<idx> [...]')
  console.error('  node scripts/publish.js < bundle.hex | node scripts/set-ens.js <name> <rpc> <key>')
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

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'

const REGISTRY_ABI = [
  'function resolver(bytes32 node) view returns (address)',
  'function owner(bytes32 node) view returns (address)',
]

const RESOLVER_ABI = [
  'function setText(bytes32 node, string key, string value) external',
  'function nameWrapper() view returns (address)',
]

const NAMEWRAPPER_ABI = [
  'function ownerOf(uint256 id) view returns (address)',
  'function setResolver(bytes32 node, address resolver) external',
]

const BASEREGISTRAR_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function reclaim(uint256 id, address owner) external',
]


async function main() {
  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const wallet = new ethers.Wallet(privateKey, provider)
  const chainId = (await provider.getNetwork()).chainId

  const chunks = refs.map((ref) => ref.split(':').map(Number))

  const registry = new ethers.Contract(ENS_REGISTRY, REGISTRY_ABI, provider)
  const node = ethers.namehash(ensName)

  const [registryOwner, resolverAddr] = await Promise.all([
    registry.owner(node),
    registry.resolver(node),
  ])

  if (resolverAddr === ethers.ZeroAddress) {
    console.error(`No resolver set for ${ensName}. Set one at app.ens.domains first.`)
    process.exit(1)
  }

  const value = JSON.stringify(chunks)
  console.log(`\nSetting text record "w3" = ${value}`)

  // --- Simple case: signer directly owns the name in the registry ---
  if (registryOwner.toLowerCase() === wallet.address.toLowerCase()) {
    const resolver = new ethers.Contract(resolverAddr, RESOLVER_ABI, wallet)
    const tx = await resolver.setText(node, 'w3', value)
    await tx.wait()
    const chainPrefix = chainId.toString() === '1' ? '' : `${chainId}:`
    console.log(`✓ Done. Browse at: w3://${chainPrefix}${ensName}`)
    return
  }

  // --- Registry owner is not the signer (wrapped name or legacy registrar) ---
  // Don't pre-check ownerOf — the NameWrapper may have stale state (e.g. name re-registered
  // after expiry; the ERC-1155 token burns while the registry entry lingers). Instead, simulate
  // setText via staticCall. If the resolver accepts it, proceed. If not, diagnose from the error.
  console.log(`Registry owner is ${registryOwner} — attempting setText simulation...`)

  const resolver = new ethers.Contract(resolverAddr, RESOLVER_ABI, wallet)
  // Simulate first to catch auth failures early.
  const simOk = await resolver.setText.staticCall(node, 'w3', value).then(() => true).catch(() => false)

  if (!simOk) {
    // Gather diagnostics.
    let resolverNW = '(no nameWrapper() getter)'
    try { resolverNW = await resolver.nameWrapper() } catch { /* older resolver */ }

    let nwTokenOwner = '(ownerOf failed)'
    try {
      const nw = new ethers.Contract(registryOwner, ['function ownerOf(uint256) view returns (address)'], provider)
      nwTokenOwner = await nw.ownerOf(BigInt(node))
    } catch { /* not a NameWrapper */ }

    // If caller supplied --resolver, try switching to it via NameWrapper then retry.
    if (resolverOverride) {
      console.log(`Simulation failed — switching resolver to ${resolverOverride} via NameWrapper...`)
      const nwWrite = new ethers.Contract(registryOwner, NAMEWRAPPER_ABI, wallet)
      const setResolverTx = await nwWrite.setResolver(node, resolverOverride)
      await setResolverTx.wait()
      console.log(`Resolver updated. Retrying...`)
      const newResolver = new ethers.Contract(resolverOverride, RESOLVER_ABI, wallet)
      const tx2 = await newResolver.setText(node, 'w3', value)
      await tx2.wait()
      const chainPrefix2 = chainId.toString() === '1' ? '' : `${chainId}:`
      console.log(`✓ Done. Browse at: w3://${chainPrefix2}${ensName}`)
      return
    }

    // BaseRegistrar reclaim path: if the NameWrapper ERC-1155 token is zero/stale (e.g. name
    // re-registered after expiry), the user may still hold the BaseRegistrar ERC-721.
    // reclaim() updates the registry owner to the wallet address so the old resolver accepts setText.
    const ethNode = ethers.namehash('eth')
    const baseRegistrarAddr = await registry.owner(ethNode)
    const label = ensName.split('.')[0]
    const labelhash = BigInt(ethers.keccak256(ethers.toUtf8Bytes(label)))
    const baseRegistrar = new ethers.Contract(baseRegistrarAddr, BASEREGISTRAR_ABI, provider)

    let erc721Owner
    try { erc721Owner = await baseRegistrar.ownerOf(labelhash) } catch { /* not found */ }

    if (erc721Owner?.toLowerCase() === wallet.address.toLowerCase()) {
      console.log(`BaseRegistrar ERC-721 owned by signer — reclaiming registry entry...`)
      const brWrite = new ethers.Contract(baseRegistrarAddr, BASEREGISTRAR_ABI, wallet)
      const reclaimTx = await brWrite.reclaim(labelhash, wallet.address)
      await reclaimTx.wait()
      console.log(`Registry owner updated to ${wallet.address}. Retrying setText...`)
      // Now registry.owner(node) == wallet.address so the old resolver accepts the call.
      const tx2 = await resolver.setText(node, 'w3', value)
      await tx2.wait()
      const chainPrefix2 = chainId.toString() === '1' ? '' : `${chainId}:`
      console.log(`✓ Done. Browse at: w3://${chainPrefix2}${ensName}`)
      return
    }

    throw new Error(
      `setText simulation failed — not authorized.\n\n` +
      `  signer:                 ${wallet.address}\n` +
      `  registry owner:         ${registryOwner}\n` +
      `  resolver:               ${resolverAddr}\n` +
      `  resolver.nameWrapper(): ${resolverNW}\n` +
      `  nameWrapper.ownerOf():  ${nwTokenOwner}\n` +
      `  baseRegistrar:          ${baseRegistrarAddr}\n` +
      `  baseRegistrar.ownerOf(): ${erc721Owner ?? '(failed)'}\n\n` +
      `Fallback: app.ens.domains → ${ensName} → Edit Records.`
    )
  }

  const tx = await resolver.setText(node, 'w3', value)
  await tx.wait()
  const chainPrefix = chainId.toString() === '1' ? '' : `${chainId}:`
  console.log(`✓ Done. Browse at: w3://${chainPrefix}${ensName}`)
}

main().catch((err) => { console.error(err.message); process.exit(1) })
