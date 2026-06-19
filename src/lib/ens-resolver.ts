// ENS resolution for portal:// URLs.
//
// Record layout (set via ENS app or scripts/set-ens.js):
//   text record "portal" = JSON array: [[blockNumber, txIndex], ...]
//
// The chain is determined by the URL prefix, e.g. portal://11155111:myapp.eth
// uses Sepolia ENS. Chain ID is NOT stored in the record.

import { keccak256, concat, getBytes, toUtf8Bytes, hexlify } from 'ethers'
import type { IVerifiedRpc } from './light-client.js'

// Same address on mainnet and Sepolia
const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'

export interface TxRef {
  txHash?: string      // present for legacy records; derived on fetch for new records
  blockNumber?: number
  txIndex?: number
}

export interface EnsResolution {
  chunks: TxRef[]
}

// ---------------------------------------------------------------------------
// Namehash  (EIP-137)
// ---------------------------------------------------------------------------

function namehash(name: string): Uint8Array {
  let node = new Uint8Array(32)
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

async function ethCall(rpc: IVerifiedRpc, to: string, data: Uint8Array): Promise<string> {
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
  const node = namehash(name)
  const resolver = await getResolver(rpc, node)
  if (!resolver) throw new Error(`No ENS resolver found for "${name}". Is the name registered on this chain?`)

  const raw = await getText(rpc, resolver, node, 'portal').catch((e: unknown) => {
    console.warn(`[portal] getText failed for "${name}":`, (e as Error).message ?? e)
    return null
  })
  if (!raw) throw new Error(`ENS "${name}" has no "portal" text record at the finalized block.`)

  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    throw new Error(`ENS "portal" record is not valid JSON: "${raw}"`)
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`ENS "portal" record must be a JSON array, got: "${raw}"`)
  }

  const chunks = (parsed as unknown[]).map((entry, i): TxRef => {
    // New format: [blockNumber, txIndex]
    if (Array.isArray(entry)) {
      const [blockNumber, txIndex] = entry as unknown[]
      if (typeof blockNumber !== 'number' || typeof txIndex !== 'number')
        throw new Error(`ENS "portal" record: expected [blockNumber, txIndex] at index ${i}`)
      return { blockNumber, txIndex }
    }
    // Legacy format: "0xhash"
    if (typeof entry !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(entry))
      throw new Error(`ENS "portal" record: invalid entry at index ${i}: "${entry}"`)
    return { txHash: entry }
  })

  return { chunks }
}
