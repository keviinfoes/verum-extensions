import { createHeliosProvider } from '@a16z/helios'
import type { HeliosProvider, Network } from '@a16z/helios'
import type { IVerifiedRpc } from './light-client.js'

// EIP-4788 ring buffer — used as a probe to verify eth_getProof works on the exec RPC.
// Infura free tier rejects eth_getProof outside the last ~128 blocks; the probe catches this
// at init time so we can fall back to another exec RPC before committing to it for the session.
const EIP4788_PROBE = '0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02'

export class HeliosWasmClient implements IVerifiedRpc {
  private lastCheckpointSave = 0
  private constructor(
    private readonly provider: HeliosProvider,
    private readonly checkpointKey: string,
    private readonly consensusRpc: string,
  ) {}

  // Races up to 2 execution RPCs with an EIP-4788 proof probe; first to pass wins.
  // Falls back to the first exec RPC unprobed if all probes fail (preserves prior behaviour).
  static async create(
    network: Network,
    consensusRpc: string,
    executionRpcs: string[],
  ): Promise<HeliosWasmClient> {
    const checkpointKey = `helios_checkpoint_${network}`
    const stored = await chrome.storage.session.get(checkpointKey)
    // Legacy entries are bare strings; current format carries savedAt so a stale
    // checkpoint (bootstrap endpoints 404 old roots) can be skipped instead of
    // burning a doomed sync attempt before the live-root retry.
    const raw = stored[checkpointKey] as string | { root: string; savedAt: number } | undefined
    const cached = typeof raw === 'string' ? { root: raw, savedAt: 0 } : raw
    const cachedCheckpoint = cached && Date.now() - cached.savedAt < 20 * 60_000
      ? cached.root : undefined

    const sync = (execRpc: string): Promise<HeliosProvider> =>
      cachedCheckpoint
        ? HeliosWasmClient.syncWithFallback(network, consensusRpc, execRpc, cachedCheckpoint)
        : HeliosWasmClient.syncFresh(network, consensusRpc, execRpc)

    const syncAndProbe = async (execRpc: string): Promise<HeliosProvider> => {
      const host = execRpc.includes('.invalid') ? 'proxy' : new URL(execRpc).hostname
      const provider = await sync(execRpc)
      console.log(`[w3] Helios (exec=${host}) probing EIP-4788…`)
      try {
        const block = await provider.request({
          method: 'eth_getBlockByNumber', params: ['finalized', false],
        }) as { timestamp?: string; number?: string } | null
        if (block?.timestamp) {
          const ts = parseInt(block.timestamp, 16)
          await provider.request({
            method: 'eth_call',
            params: [{ to: EIP4788_PROBE, data: '0x' + ts.toString(16).padStart(64, '0') }, 'finalized'],
          })
        }
      } catch (err) {
        console.warn(`[w3] Helios exec probe (${host}): failed —`, (err as Error).message)
        await provider.shutdown().catch(() => {})
        throw err
      }
      return provider
    }

    const candidates = executionRpcs.slice(0, 2)
    let provider: HeliosProvider

    if (candidates.length === 1) {
      provider = await sync(candidates[0])
    } else {
      const attempts = candidates.map(rpc => syncAndProbe(rpc))
      provider = await Promise.any(attempts).catch(async () => {
        console.warn('[w3] All exec RPC probes failed — using first RPC unprobed')
        return sync(candidates[0])
      })
      // Shut down any extra provider that synced but lost the race.
      for (const p of attempts) {
        p.then(winner => { if (winner !== provider) winner.shutdown().catch(() => {}) }).catch(() => {})
      }
    }

    const finalizedRoot = await HeliosWasmClient.fetchFinalizedRoot(consensusRpc)
    if (finalizedRoot) await chrome.storage.session.set({ [checkpointKey]: { root: finalizedRoot, savedAt: Date.now() } })

    return new HeliosWasmClient(provider, checkpointKey, consensusRpc)
  }

  private static async syncWithFallback(
    network: Network,
    consensusRpc: string,
    executionRpc: string,
    cachedCheckpoint: string,
  ): Promise<HeliosProvider> {
    try {
      return await HeliosWasmClient.trySync(network, consensusRpc, executionRpc, cachedCheckpoint, 'cached checkpoint')
    } catch {
      console.log('[w3] Helios cached checkpoint failed — retrying with live finalized root')
      return HeliosWasmClient.syncFresh(network, consensusRpc, executionRpc)
    }
  }

  private static async syncFresh(
    network: Network,
    consensusRpc: string,
    executionRpc: string,
  ): Promise<HeliosProvider> {
    const hint = await HeliosWasmClient.fetchFinalizedRoot(consensusRpc)
    return HeliosWasmClient.trySync(network, consensusRpc, executionRpc, hint,
      hint ? 'live finalized root' : 'no checkpoint hint')
  }

  // Slots per epoch — light-client bootstrap data is indexed per epoch boundary.
  private static readonly SLOTS_PER_EPOCH = 32

  // Returns a finalized checkpoint root that light_client/bootstrap will actually
  // serve.
  //
  // /headers/finalized returns the finalized checkpoint, whose root is the last
  // block at *or before* the epoch-boundary slot. When that boundary slot is
  // empty (a skipped proposal), the root belongs to a block at a non-boundary
  // slot — and beacon nodes only index bootstrap data for blocks sitting exactly
  // on a boundary. Bootstrapping from it fails with:
  //   404 NOT_FOUND: Sync committee branch for block root 0x… not found. This
  //   typically occurs when the block is not a finalized checkpoint.
  // which kills Helios init outright (and with it the whole verification path).
  // It's intermittent: it only bites when the boundary proposal was skipped.
  //
  // So when the finalized root isn't on a boundary, walk back over earlier
  // boundary slots until one has a block. An older finalized checkpoint is still
  // a valid, still-finalized starting point — Helios syncs forward from it.
  static async fetchFinalizedRoot(consensusRpc: string): Promise<string | undefined> {
    try {
      const res = await fetch(`${consensusRpc}/eth/v1/beacon/headers/finalized`)
      if (!res.ok) return undefined
      const json = await res.json() as {
        data?: { root?: string; header?: { message?: { slot?: string } } }
      }
      const root = json.data?.root
      const slot = Number(json.data?.header?.message?.slot)
      if (!root) return undefined
      if (!Number.isFinite(slot) || slot % HeliosWasmClient.SLOTS_PER_EPOCH === 0) return root

      // Boundary slot was skipped — find the most recent boundary that has a block.
      let boundary = slot - (slot % HeliosWasmClient.SLOTS_PER_EPOCH)
      for (let i = 0; i < 8 && boundary > 0; i++, boundary -= HeliosWasmClient.SLOTS_PER_EPOCH) {
        const r = await fetch(`${consensusRpc}/eth/v1/beacon/headers/${boundary}`)
        if (!r.ok) continue  // no block at this boundary either — step back an epoch
        const j = await r.json() as { data?: { root?: string } }
        if (j.data?.root) {
          console.log(`[w3] Helios: finalized checkpoint at slot ${slot} is off-boundary ` +
            `(skipped proposal) — bootstrapping from boundary slot ${boundary} instead`)
          return j.data.root
        }
      }
      return root  // give up; trySync's fallbacks still get a chance
    } catch {
      return undefined
    }
  }

  private static async trySync(
    network: Network,
    consensusRpc: string,
    executionRpc: string,
    checkpoint: string | undefined,
    checkpointLabel: string,
  ): Promise<HeliosProvider> {
    const execHost = executionRpc.includes('.invalid') ? 'proxy' : new URL(executionRpc).hostname
    const tag = `[w3] Helios (exec=${execHost})`
    console.log(`${tag} creating provider (${checkpointLabel})`)
    // dbType is how Helios persists its own checkpoint between runs. Only
    // "localstorage" and "config" exist. localStorage does not exist in a service
    // worker, so "localstorage" made Helios log
    //   "Helios: localStorage unavailable, falling back to in-memory checkpoint storage"
    // and fall back to a store that dies with the worker — i.e. it never persisted
    // anything anyway.
    //
    // "config" is the honest description of what we actually do: we persist the
    // checkpoint ourselves in chrome.storage.session (see saveCheckpoint /
    // fetchFinalizedRoot) and hand it in via `checkpoint` on every start. Helios
    // then reads the checkpoint from config and stops pretending it has a DB.
    // Same behaviour, minus the misleading warning.
    const provider = await createHeliosProvider(
      { network, consensusRpc, executionRpc, dbType: 'config', checkpoint },
      'ethereum',
    )
    const t1 = Date.now()
    const ticker = setInterval(
      () => console.log(`${tag} still syncing… (${Math.round((Date.now() - t1) / 1000)}s)`),
      5_000,
    )
    try {
      await Promise.race([
        provider.waitSynced(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Helios waitSynced timeout')), 30_000),
        ),
      ])
    } finally {
      clearInterval(ticker)
    }
    return provider
  }

  async request<T>(method: string, params: unknown[], quickFail = false): Promise<T> {
    // Guard against WASM hangs: if provider.request() never resolves (WASM panic,
    // OOM, etc.) the acquireEthCallSlot slot held by the caller is never released.
    // After 4 stuck calls the semaphore fills and the extension freezes until
    // a manual reload. The timeout ensures slots are always released within 20s.
    const call = (): Promise<T> =>
      Promise.race([
        this.provider.request({ method, params: params as unknown[] }) as Promise<T>,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Helios WASM call timeout')), 20_000),
        ),
      ])
    try {
      const result = await call()
      this.saveCheckpoint()
      return result
    } catch (err: any) {
      if ((err?.message ?? '').includes('out of sync')) {
        if (quickFail) throw err
        const lag = (err.message as string).match(/(\d+) seconds? behind/)?.[1] ?? '?'
        console.warn(`[w3] Helios ${method} OOS (${lag}s behind) — retrying in 3s`)
        await new Promise(r => setTimeout(r, 3_000))
        const result = await call()
        this.saveCheckpoint()
        return result
      }
      throw err
    }
  }

  private saveCheckpoint(): void {
    const now = Date.now()
    if (now - this.lastCheckpointSave < 30_000) return
    this.lastCheckpointSave = now
    HeliosWasmClient.fetchFinalizedRoot(this.consensusRpc)
      .then(cp => { if (cp) chrome.storage.session.set({ [this.checkpointKey]: { root: cp, savedAt: Date.now() } }) })
      .catch(() => {})
  }

  isHeliosBacked(): boolean { return true }

  async shutdown(): Promise<void> { await this.provider.shutdown() }
}
