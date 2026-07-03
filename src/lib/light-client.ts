import { HeliosWasmClient } from './helios-wasm.js'
import type { ChainConfig } from '../types.js'

export interface IVerifiedRpc {
  request<T>(method: string, params: unknown[]): Promise<T>
  isHeliosBacked(): boolean
}

// Tries each URL in order, returns first success
export class RpcClient implements IVerifiedRpc {
  constructor(private readonly urls: string[]) {}

  async request<T>(method: string, params: unknown[]): Promise<T> {
    let lastErr: unknown
    for (const url of this.urls) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 10_000)
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: ctrl.signal,
        })
        const json = await res.json() as { result: T; error?: { message: string } }
        if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`)
        if (json.result == null) throw new Error(`RPC ${method} returned null`)
        return json.result
      } catch (err) {
        lastErr = err
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastErr ?? new Error(`All RPCs failed for ${method}`)
  }

  isHeliosBacked(): boolean { return false }
}

// Try Helios WASM — all consensus RPCs raced in parallel against the first execution RPC.
// First to sync wins; losers are abandoned. Falls back to plain RpcClient if all fail.
export async function createVerifiedRpc(chain: ChainConfig): Promise<IVerifiedRpc> {
  const network = heliosNetwork(chain.chainId)
  const execRpc = chain.rpcs[0]

  const attempts = chain.consensusRpcs.map(consensusRpc =>
    HeliosWasmClient.create(network, consensusRpc, execRpc)
      .catch(err => {
        console.warn(`[w3] Helios init failed (consensus=${consensusRpc}):`, (err as Error).message)
        return Promise.reject(err)
      })
  )

  try {
    return await Promise.any(attempts)
  } catch {
    console.warn('[w3] Helios init failed for all consensus RPCs, using plain fallback')
    return new RpcClient(chain.rpcs)
  }
}

function heliosNetwork(chainId: number) {
  const map: Record<number, string> = {
    1:        'mainnet',
    11155111: 'sepolia',
    17000:    'holesky',
  }
  return (map[chainId] ?? 'mainnet') as Parameters<typeof HeliosWasmClient.create>[0]
}
