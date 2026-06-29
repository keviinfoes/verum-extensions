import { createHeliosProvider } from '@a16z/helios'
import type { HeliosProvider, Network } from '@a16z/helios'
import type { IVerifiedRpc } from './light-client.js'

export class HeliosWasmClient implements IVerifiedRpc {
  private constructor(private readonly provider: HeliosProvider) {}

  static async create(
    network: Network,
    consensusRpc: string,
    executionRpc: string,
  ): Promise<HeliosWasmClient> {
    const checkpointKey = `helios_checkpoint_${network}`
    const stored = await chrome.storage.session.get(checkpointKey)
    const cachedCheckpoint = stored[checkpointKey] as string | undefined

    const provider = cachedCheckpoint
      ? await HeliosWasmClient.syncWithFallback(network, consensusRpc, executionRpc, cachedCheckpoint, checkpointKey)
      : await HeliosWasmClient.syncFresh(network, consensusRpc, executionRpc)

    try {
      const current = await provider.request({
        method: 'helios_getCurrentCheckpoint', params: [],
      }) as string
      if (current) await chrome.storage.session.set({ [checkpointKey]: current })
    } catch {}

    return new HeliosWasmClient(provider)
  }

  // Try syncing with a cached checkpoint; if it fails (stale), clear cache and sync fresh.
  private static async syncWithFallback(
    network: Network,
    consensusRpc: string,
    executionRpc: string,
    cachedCheckpoint: string,
    checkpointKey: string,
  ): Promise<HeliosProvider> {
    try {
      return await HeliosWasmClient.trySync(network, consensusRpc, executionRpc, cachedCheckpoint)
    } catch {
      console.warn('[w3] Stale Helios checkpoint, clearing and resyncing')
      await chrome.storage.session.remove(checkpointKey)
      return HeliosWasmClient.syncFresh(network, consensusRpc, executionRpc)
    }
  }

  // Sync without a cached checkpoint.
  // Pre-fetches a checkpoint from the consensus RPC as a hint to Helios so it doesn't
  // need to reach its internal fallback services. If the pre-fetch fails Helios still
  // attempts bootstrap via its own mechanism (raw.githubusercontent.com + beaconcha.in
  // are now in host_permissions as the independent fallback path).
  private static async syncFresh(
    network: Network,
    consensusRpc: string,
    executionRpc: string,
  ): Promise<HeliosProvider> {
    const hint = await HeliosWasmClient.fetchFinalizedRoot(consensusRpc)
    return HeliosWasmClient.trySync(network, consensusRpc, executionRpc, hint)
  }

  private static async fetchFinalizedRoot(consensusRpc: string): Promise<string | undefined> {
    try {
      const res = await fetch(`${consensusRpc}/eth/v1/beacon/headers/finalized`)
      if (!res.ok) return undefined
      const json = await res.json() as { data: { root: string } }
      return json.data?.root
    } catch {
      return undefined
    }
  }

  private static async trySync(
    network: Network,
    consensusRpc: string,
    executionRpc: string,
    checkpoint: string | undefined,
  ): Promise<HeliosProvider> {
    const provider = await createHeliosProvider(
      { network, consensusRpc, executionRpc, dbType: 'config', checkpoint },
      'ethereum',
    )
    await Promise.race([
      provider.waitSynced(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Helios waitSynced timeout')), 30_000),
      ),
    ])
    console.log(`[w3] Helios synced (${network}, consensus=${consensusRpc})`)
    return provider
  }

  async request<T>(method: string, params: unknown[]): Promise<T> {
    return this.provider.request({ method, params: params as unknown[] }) as Promise<T>
  }

  isHeliosBacked(): boolean { return true }

  async shutdown(): Promise<void> { await this.provider.shutdown() }
}
