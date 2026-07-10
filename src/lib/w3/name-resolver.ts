// ENS (.eth) and GNS (.gwei) name resolution for w3:// URLs.
//
// Record layout (set via ENS app / scripts/set-ens.js, or scripts/set-gns.js):
//   text record "w3" = JSON array: [[blockNumber, txIndex], ...]
//
// The chain is determined by the URL prefix, e.g. w3://11155111:myapp.eth
// uses Sepolia ENS. Chain ID is NOT stored in the record.
//
// GNS (https://github.com/lucadonnoh/gwei-names) is a separate, ownerless
// name service for .gwei names. It uses the same EIP-137 namehash algorithm
// and the same ENS-compatible text(bytes32,string) resolver selector as ENS,
// but its NameNFT contract acts as both registry and resolver — there's no
// registry.resolver(node) indirection to do first.

import { keccak256, concat, getBytes, toUtf8Bytes, hexlify, type BytesLike } from 'ethers'
import type { IVerifiedRpc } from '../rpc/light-client.js'

// Same address on mainnet and Sepolia
const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'

// NameNFT contract — same address on mainnet and Sepolia
const GNS_REGISTRY = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6'

export interface TxRef {
  blockNumber: number
  txIndex: number
}

export interface EnsResolution {
  chunks: TxRef[]
}

// ---------------------------------------------------------------------------
// Namehash  (EIP-137)
// ---------------------------------------------------------------------------

function namehash(name: string): Uint8Array {
  let node: Uint8Array = new Uint8Array(32)
  if (!name) return node
  for (const label of name.split('.').reverse()) {
    const labelHash = getBytes(keccak256(toUtf8Bytes(label)))
    node = getBytes(keccak256(concat([node, labelHash])))
  }
  return node
}

// ---------------------------------------------------------------------------
// Low-level ABI helpers
// ---------------------------------------------------------------------------

function pad32(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(32)
  out.set(bytes, 32 - bytes.length)
  return out
}

function encodeUint256(n: number): Uint8Array {
  const hex = n.toString(16).padStart(64, '0')
  return getBytes('0x' + hex)
}

async function ethCall(rpc: IVerifiedRpc, to: string, data: BytesLike): Promise<string> {
  return rpc.request<string>('eth_call', [{ to, data: hexlify(data) }, 'finalized'])
}

// resolver(bytes32 node) → address
async function getResolver(rpc: IVerifiedRpc, node: Uint8Array): Promise<string | null> {
  const selector = getBytes('0x0178b8bf')
  const result = await ethCall(rpc, ENS_REGISTRY, concat([selector, pad32(node)]))
  const addr = '0x' + result.slice(-40)
  if (/^0x0+$/.test(addr)) return null
  return addr
}

// text(bytes32 node, string key) → string
async function getText(rpc: IVerifiedRpc, resolver: string, node: Uint8Array, key: string): Promise<string | null> {
  const selector = getBytes('0x59d1d43c')
  const keyBytes = toUtf8Bytes(key)
  // ABI: node (32) + offset to string (32, value=0x40) + string length (32) + string bytes (padded to 32-boundary)
  const paddedLen = Math.ceil(keyBytes.length / 32) * 32
  const keyPadded = new Uint8Array(paddedLen)
  keyPadded.set(keyBytes)
  const data = concat([selector, pad32(node), encodeUint256(0x40), encodeUint256(keyBytes.length), keyPadded])
  const result = await ethCall(rpc, resolver, data)

  if (!result || result === '0x' || result.length < 130) return null
  const hex = result.slice(2)
  // result is ABI-encoded string: offset(32) + length(32) + bytes
  const strOffset = parseInt(hex.slice(0, 64), 16) * 2
  const strLen = parseInt(hex.slice(strOffset, strOffset + 64), 16)
  if (strLen === 0) return null
  return new TextDecoder().decode(getBytes('0x' + hex.slice(strOffset + 64, strOffset + 64 + strLen * 2)))
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

export async function resolveEns(
  name: string,
  rpc: IVerifiedRpc,
): Promise<EnsResolution> {
  const isGns = name.toLowerCase().endsWith('.gwei')
  const service = isGns ? 'GNS' : 'ENS'
  const node = namehash(name)
  // GNS's NameNFT is itself the resolver — no registry.resolver(node) hop needed.
  const resolver = isGns ? GNS_REGISTRY : await getResolver(rpc, node)
  if (!resolver) throw new Error(`No ENS resolver found for "${name}". Is the name registered on this chain?`)

  const raw = await getText(rpc, resolver, node, 'w3').catch((e: unknown) => {
    console.warn(`[w3] getText failed for "${name}":`, (e as Error).message ?? e)
    return null
  })
  if (!raw) throw new Error(`${service} "${name}" has no "w3" text record at the finalized block.`)

  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    throw new Error(`${service} "w3" record is not valid JSON: "${raw}"`)
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${service} "w3" record must be a JSON array, got: "${raw}"`)
  }

  const chunks = (parsed as unknown[]).map((entry, i): TxRef => {
    if (!Array.isArray(entry))
      throw new Error(`${service} "w3" record: expected [blockNumber, txIndex] at index ${i}`)
    const [blockNumber, txIndex] = entry as unknown[]
    if (typeof blockNumber !== 'number' || typeof txIndex !== 'number')
      throw new Error(`${service} "w3" record: expected [blockNumber, txIndex] at index ${i}`)
    return { blockNumber, txIndex }
  })

  return { chunks }
}
