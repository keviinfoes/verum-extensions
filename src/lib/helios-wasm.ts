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
    // Reuse a cached checkpoint to skip the slow bootstrap on repeat starts.
    // First sync: 10-20s. Subsequent syncs (same session): 1-3s.
    const checkpointKey = `helios_checkpoint_${network}`
    const stored = await chrome.storage.session.get(checkpointKey)
    const checkpoint = stored[checkpointKey] as string | undefined

    const provider = await createHeliosProvider(
      { network, consensusRpc, executionRpc, dbType: 'config', checkpoint },
      'ethereum',
    )

    // Helios sync timeout — waitSynced can hang; bail after 30s and let caller try next combo
    await Promise.race([
      provider.waitSynced(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Helios waitSynced timeout')), 30_000),
      ),
    ])

    // Persist checkpoint for next init
    try {
      const current = await provider.request({
        method: 'helios_getCurrentCheckpoint', params: [],
      }) as string
      if (current) await chrome.storage.session.set({ [checkpointKey]: current })
    } catch {}

    return new HeliosWasmClient(provider)
  }

  async request<T>(method: string, params: unknown[]): Promise<T> {
    return this.provider.request({ method, params: params as unknown[] }) as Promise<T>
  }

  isHeliosBacked(): boolean { return true }

  async shutdown(): Promise<void> { await this.provider.shutdown() }
}
