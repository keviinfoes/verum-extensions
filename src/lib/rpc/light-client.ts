import { HeliosWasmClient } from './helios-wasm.js'
import type { ChainConfig } from '../../types.js'

export interface IVerifiedRpc {
  request<T>(method: string, params: unknown[], quickFail?: boolean): Promise<T>
  isHeliosBacked(): boolean
}

// ---------------------------------------------------------------------------
// Helios RPC fetch proxy — execution AND consensus.
// Helios calls fetch() internally for all RPC requests. We intercept those
// calls via sentinel URLs and round-robin them across all configured providers
// with per-request failover:
//   w3-exec-{chainId}-{idx}.invalid — execution JSON-RPC (POST to base URL)
//   w3-cons-{chainId}-{idx}.invalid — consensus beacon REST (path appended)
// Consensus failover matters most: the OOS "N seconds behind" lag is head
// timestamp vs wall clock, and the head only advances via light-client
// optimistic updates from the consensus RPC. A single stale/rate-limited
// consensus provider freezes the head no matter how healthy the exec RPCs are.
// Light-client updates are sync-committee-signed, so mixing consensus
// providers per-request is safe — Helios verifies every response.
// ---------------------------------------------------------------------------
const _proxyRpcs       = new Map<string, string[]>()  // sentinel key → rpcs
const _proxyIdx        = new Map<string, number>()    // sentinel key → round-robin counter
const _proxyBlacklist  = new Map<string, Set<string>>() // sentinel key → permanently broken RPCs

// Diagnostic: tally exec JSON-RPC sub-requests (method → count, total ms) that Helios's
// WASM fires through the proxy, and flush a compact summary every 2s of activity. Reveals
// whether one eth_call spawns a batched createAccessList+getProof or thousands of serial
// getProofs — the difference between "slow but fixable" and "fundamentally serial".
// Proxy-level cache for deterministic exec reads. Helios re-verifies every proof/code
// against the trusted state root, so caching cannot weaken the trust model — it only
// removes redundant network round-trips. A DEX quoter's mc3-style split/retry re-reads
// the SAME immutable bytecode and SAME-block pool proofs thousands of times; without
// this, that floods (and gets rate-limited by) the public RPCs. Keys:
//   code:<proxyKey>:<address>                      (bytecode is immutable → never expires)
//   proof:<proxyKey>:<block>:<address>:<slots>     (deterministic at a fixed block number)
const _rpcCache = new Map<string, unknown>()
const _RPC_CACHE_CAP = 40_000
function rpcCacheSet(key: string, value: unknown) {
  if (_rpcCache.size >= _RPC_CACHE_CAP) _rpcCache.clear()  // bounded; entries rebuild cheaply
  _rpcCache.set(key, value)
}

// ── JSON-RPC request coalescing (eth_getProof, eth_createAccessList) ─────────
// Helios fires each of these as its own HTTP POST; a DEX quote does hundreds
// concurrently, flooding (and getting rate-limited by) public RPCs — which is
// what balloons createAccessList to 8–32s under load. Buffer the concurrent ones
// per method and send them as ONE JSON-RPC batch POST — same requests, same
// verification (Helios still gets + verifies each result), just far fewer HTTP
// round-trips. Any sub-request that errors/looks malformed falls back to a single
// fetch, so a provider that doesn't batch degrades to the per-request path.
interface Pending { req: { id: unknown; method: string; params: unknown[] }; resolve: (r: Response) => void }
const _batchCfg: Record<string, { max: number; windowMs: number; timeoutMs: number }> = {
  eth_getProof: { max: 30, windowMs: 10, timeoutMs: 10_000 },
  // NB: eth_createAccessList is intentionally NOT batched. Batching clusters its results so
  // many eth-calls enter their next WASM phase at once → concurrent re-entry of the Helios
  // provider object → "recursive use of an object" panic. It's inherent to batching a result
  // that makes the WASM *continue* executing, so no resolve-timing tweak fixes it.
}
const _batches = new Map<string, { method: string; items: Pending[]; rpcs: string[]; startIdx: number; timer: ReturnType<typeof setTimeout> | null }>()

function enqueueBatch(proxyKey: string, method: string, rpcs: string[], startIdx: number, req: Pending['req']): Promise<Response> {
  const cfg = _batchCfg[method]
  const key = `${proxyKey}:${method}`
  return new Promise((resolve) => {
    let b = _batches.get(key)
    if (!b) { b = { method, items: [], rpcs, startIdx, timer: null }; _batches.set(key, b) }
    b.items.push({ req, resolve })
    if (b.items.length >= cfg.max) void flushBatch(key)
    else if (!b.timer) b.timer = setTimeout(() => void flushBatch(key), cfg.windowMs)
  })
}

function jsonRpcResponse(id: unknown, payload: object, url: string): Response {
  const resp = new Response(JSON.stringify({ jsonrpc: '2.0', id, ...payload }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  // A synthesized Response has url="" — Helios parses response.url() and Url::parse("") panics.
  try { Object.defineProperty(resp, 'url', { value: url, configurable: true }) } catch { /* ignore */ }
  return resp
}

async function flushBatch(key: string): Promise<void> {
  const b = _batches.get(key)
  if (!b || b.items.length === 0) return
  _batches.delete(key)
  if (b.timer) clearTimeout(b.timer)
  const { items, rpcs, startIdx, method } = b
  const cfg = _batchCfg[method]
  const body = JSON.stringify(items.map((it, i) => ({ jsonrpc: '2.0', id: i, method: it.req.method, params: it.req.params })))

  const t0 = Date.now()
  let arr: Array<{ id?: unknown; result?: unknown; error?: unknown }> | null = null
  let usedRpc = rpcs[startIdx % rpcs.length]
  for (let attempt = 0; attempt < rpcs.length; attempt++) {
    const rpc = rpcs[(startIdx + attempt) % rpcs.length]
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs)
    try {
      const res = await _nativeFetch(rpc.replace(/\/$/, ''), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ctrl.signal })
      clearTimeout(timer)
      if (!res.ok) continue
      const parsed = await res.json()
      if (!Array.isArray(parsed) || parsed.length !== items.length) continue  // provider didn't batch as expected → next RPC
      arr = parsed as Array<{ id?: unknown }>
      usedRpc = rpc
      break
    } catch { clearTimeout(timer); continue }
  }
  proxyTally([`${method}:batch×${items.length}`], Date.now() - t0)

  // createAccessList results make the WASM CONTINUE executing (fetch proofs next), so
  // resolving several back-to-back synchronously lets a continuation re-enter the WASM
  // mid-borrow → "recursive use of an object". Defer those onto their own macrotask so the
  // stack unwinds first (same reason cache hits defer). getProof results are terminal for
  // that call's fetch phase, so they stay synchronous (no latency on the hot path).
  const deferResolve = method === 'eth_createAccessList'
  const byId = arr ? new Map(arr.map((r) => [Number(r.id), r])) : null
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const sub = byId?.get(i)
    if (sub && 'result' in sub && sub.result != null && !sub.error) {
      const resp = jsonRpcResponse(item.req.id, { result: sub.result }, usedRpc)
      if (deferResolve) setTimeout(() => item.resolve(resp), 0)
      else item.resolve(resp)
    } else {
      // Missing / errored / malformed sub-response → single fetch (its own network I/O is
      // already macrotask-separated). Don't block the loop; on total failure hand back an
      // error response so the promise still settles instead of hanging the WASM.
      void singleFallback(rpcs, startIdx, item.req, cfg.timeoutMs).then(
        (r) => item.resolve(r),
        () => item.resolve(jsonRpcResponse(item.req.id, { error: { code: -32603, message: 'batch fallback failed' } }, usedRpc)),
      )
    }
  }
}

async function singleFallback(rpcs: string[], startIdx: number, req: Pending['req'], timeoutMs: number): Promise<Response> {
  const single = JSON.stringify({ jsonrpc: '2.0', id: req.id, method: req.method, params: req.params })
  for (let attempt = 0; attempt < rpcs.length; attempt++) {
    const rpc = rpcs[(startIdx + attempt) % rpcs.length]
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await _nativeFetch(rpc.replace(/\/$/, ''), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: single, signal: ctrl.signal })
      clearTimeout(timer)
      if (!res.ok) { if (attempt < rpcs.length - 1) continue; return res }
      const clone = res.clone()
      let json: { result?: unknown; error?: unknown } | undefined
      try { json = await clone.json() } catch { /* malformed */ }
      // Never hand malformed input to Helios's WASM (it can trap the instance).
      if (!json || typeof json !== 'object' || (!('result' in json) && !('error' in json))) {
        if (attempt < rpcs.length - 1) continue
        throw new Error('malformed batch-fallback response')
      }
      if (json.error && attempt < rpcs.length - 1) continue  // fetch failed at this provider → next
      return res
    } catch { clearTimeout(timer); if (attempt < rpcs.length - 1) continue; throw new Error('batch fallback exhausted') }
  }
  throw new Error('batch fallback exhausted')
}

const _proxyStats = new Map<string, { n: number; ms: number }>()
let _proxyFlush: ReturnType<typeof setTimeout> | null = null
function proxyTally(methods: string[], ms: number) {
  for (const method of methods) {
    const s = _proxyStats.get(method) ?? { n: 0, ms: 0 }
    s.n++; s.ms += ms / methods.length; _proxyStats.set(method, s)
  }
  if (!_proxyFlush) _proxyFlush = setTimeout(() => {
    const parts = [...(_proxyStats)].map(([m, s]) => `${m}×${s.n} (avg ${Math.round(s.ms / s.n)}ms)`)
    console.log('[w3] proxy exec /2s:', parts.join(', '))
    _proxyStats.clear(); _proxyFlush = null
  }, 2000)
}

const SLOTS_PER_PERIOD = 32 * 256  // 8192 — one sync-committee period

// ---------------------------------------------------------------------------
// light_client/updates repair
//
// Helios walks sync-committee periods in order: it applies the update for its
// store period, then period+1, and so on. It requires the response to
// /eth/v1/beacon/light_client/updates?start_period=P&count=N to be exactly the
// updates for [P, P+N), ascending.
//
// Some providers (ethereum-beacon-api.publicnode.com today — and it is currently
// the only reachable mainnet beacon endpoint) ignore both query parameters and
// return a large, unordered dump instead: e.g. asking for start_period=1801&count=2
// yields 211 updates whose periods run [1801, 1582, 1583, …, 1791]. Helios applies
// 1801, sees 1582 next, and aborts the whole sync with "invalid sync committee
// period" — Helios never initialises, so every verification mode fails.
//
// Rather than trust the provider, select the updates we asked for, deduplicate by
// period, and return them in ascending order. A conformant provider is unaffected:
// its response already satisfies the filter.
// ---------------------------------------------------------------------------
async function repairLightClientUpdates(res: Response, path: string): Promise<Response | null> {
  let updates: unknown
  try {
    updates = await res.clone().json()
  } catch {
    return res  // SSZ or non-JSON body — pass through untouched
  }
  if (!Array.isArray(updates)) return res

  const query = new URLSearchParams(path.split('?')[1] ?? '')
  const start = Number(query.get('start_period'))
  const count = Number(query.get('count'))
  if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0) return res

  const periodOf = (u: unknown): number => {
    const d = (u as { data?: { signature_slot?: string }; signature_slot?: string })
    const slot = Number(d?.data?.signature_slot ?? d?.signature_slot)
    return Number.isFinite(slot) ? Math.floor(slot / SLOTS_PER_PERIOD) : NaN
  }

  const byPeriod = new Map<number, unknown>()
  for (const u of updates) {
    const p = periodOf(u)
    if (!Number.isFinite(p) || p < start || p >= start + count) continue
    if (!byPeriod.has(p)) byPeriod.set(p, u)
  }

  const selected = [...byPeriod.entries()].sort((a, b) => a[0] - b[0]).map(([, u]) => u)
  if (selected.length === 0) return null  // nothing for the requested range — fail over

  if (selected.length !== updates.length) {
    console.log(`[w3] Helios consensus: light_client/updates returned ${updates.length} update(s) ` +
      `for start_period=${start}&count=${count} — using the ${selected.length} in range, in order`)
  }

  const out = new Response(JSON.stringify(selected), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
  // A constructed Response has url === "", and Helios's Rust side parses
  // response.url() — an empty string aborts the sync with "url parse".
  Object.defineProperty(out, 'url', { value: res.url })
  return out
}

const _nativeFetch = globalThis.fetch.bind(globalThis) as typeof fetch
;(globalThis as unknown as { fetch: typeof fetch }).fetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const url = typeof input === 'string' ? input
    : input instanceof Request ? input.url
    : input.toString()
  const m = url.match(/^https:\/\/(w3-(?:exec|cons)-\d+-\d+\.invalid)(\/.*)?$/)
  if (m) {
    const proxyKey = m[1]
    // Consensus REST calls carry meaningful paths (/eth/v1/beacon/…) that must
    // be appended to the target base URL; exec JSON-RPC posts to the base URL.
    const path = m[2] && m[2] !== '/' ? m[2] : ''
    const isCons = proxyKey.startsWith('w3-cons')
    const allRpcs = _proxyRpcs.get(proxyKey)
    const bl = _proxyBlacklist.get(proxyKey)
    const rpcs = allRpcs && bl ? allRpcs.filter(r => !bl.has(r)) : allRpcs

    if (rpcs && rpcs.length > 0) {
      // Round-robin starting position for this call
      const startIdx = _proxyIdx.get(proxyKey) ?? 0
      _proxyIdx.set(proxyKey, startIdx + 1)

      // A Request body is a one-shot ReadableStream — extract it as an ArrayBuffer
      // once before the retry loop so it can be re-sent on each failover attempt.
      let fetchMethod: string | undefined
      let fetchHeaders: HeadersInit | undefined
      let fetchBody: BodyInit | null | undefined
      if (input instanceof Request) {
        fetchMethod = input.method
        fetchHeaders = input.headers
        fetchBody = input.body ? await input.clone().arrayBuffer() : undefined
      }

      // Parse the JSON-RPC method(s), and for a single deterministic read compute a
      // cache key + capture the request id so a hit can be answered without a round-trip.
      let execMethods: string[] = []
      let cache: { key: string; id: unknown; method: string } | null = null
      let singleReq: { id: unknown; method: string; params: unknown[] } | null = null
      if (!isCons) {
        try {
          const raw = fetchBody ?? (init?.body as unknown)
          const text = raw instanceof ArrayBuffer ? new TextDecoder().decode(raw)
            : typeof raw === 'string' ? raw : ''
          if (text) {
            const j = JSON.parse(text)
            if (Array.isArray(j)) {
              execMethods = j.map((x) => x?.method).filter(Boolean)
            } else if (j?.method) {
              execMethods = [j.method]
              singleReq = { id: j.id, method: j.method, params: j.params }
              const p = j.params
              if (j.method === 'eth_getCode' && p?.[0]) {
                cache = { key: `code:${proxyKey}:${String(p[0]).toLowerCase()}`, id: j.id, method: 'eth_getCode' }
              } else if (j.method === 'eth_getBlockByHash' && p?.[0]) {
                // A block addressed by hash is immutable → cache forever, like bytecode.
                cache = { key: `blkhash:${proxyKey}:${String(p[0]).toLowerCase()}:${p[1] ? 1 : 0}`, id: j.id, method: 'eth_getBlockByHash' }
              }
              // NB: eth_createAccessList and eth_getProof are intentionally NOT cached —
              // measured to get zero hits (a quoter's calls are unique per poll), so caching
              // only adds overhead. Only immutable reads (code, block-by-hash) are cached.
              // NB: eth_getProof is deliberately NOT cached — it got zero hits (a quoter's
              // slot-sets are unique) so there's no benefit, and account/state proofs are
              // the most correctness-sensitive thing to cache. Only immutable reads above.
            }
          }
        } catch { /* not JSON-RPC — ignore */ }
      }

      // Cache hit → synthesize the JSON-RPC response (Helios still re-verifies it).
      if (cache && _rpcCache.has(cache.key)) {
        proxyTally([`${cache.method}:cached`], 0)
        // Yield a full macrotask before resolving. A real fetch does network I/O and
        // fully unwinds the WASM stack; resolving synchronously (microtask only) lets the
        // WASM continuation re-enter while the original call still holds its borrow →
        // "recursive use of an object" panic. This defer mimics real async I/O.
        await new Promise((resolve) => setTimeout(resolve, 0))
        const body = JSON.stringify({ jsonrpc: '2.0', id: cache.id, result: _rpcCache.get(cache.key) })
        const resp = new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
        // A synthesized Response has url="" — Helios's WASM HTTP layer parses response.url()
        // and Url::parse("") panics. Give it a real RPC url (shadowing the prototype getter).
        try { Object.defineProperty(resp, 'url', { value: rpcs[startIdx % rpcs.length], configurable: true }) } catch { /* ignore */ }
        return resp
      }

      // Coalesce buffered getProof / createAccessList into batched POSTs (see _batchCfg).
      if (singleReq && _batchCfg[singleReq.method] && Array.isArray(singleReq.params)) {
        return await enqueueBatch(proxyKey, singleReq.method, rpcs, startIdx, singleReq)
      }
      const _t0 = Date.now()

      // Try each RPC in order; on timeout/error failover to the next immediately.
      // Helios never sees a network error — it just perceives a slow response.
      for (let attempt = 0; attempt < rpcs.length; attempt++) {
        const rpc = rpcs[(startIdx + attempt) % rpcs.length]

        const ctrl = new AbortController()
        // Consensus responses (bootstrap, update batches) can be MBs — allow longer.
        const timer = setTimeout(() => ctrl.abort(), isCons ? 15_000 : 5_000)
        const host = new URL(rpc).hostname
        try {
          const fetchInit: RequestInit = input instanceof Request
            ? { method: fetchMethod, headers: fetchHeaders, body: fetchBody, signal: ctrl.signal }
            : { ...init, signal: ctrl.signal }
          const res = await _nativeFetch(rpc.replace(/\/$/, '') + path, fetchInit)
          clearTimeout(timer)
          if (!res.ok) {
            if (attempt < rpcs.length - 1) continue
            return res
          }
          // Consensus REST responses are not JSON-RPC — no error body to inspect,
          // but the light-client updates endpoint needs repairing on some providers.
          if (isCons) {
            if (path.startsWith('/eth/v1/beacon/light_client/updates')) {
              const repaired = await repairLightClientUpdates(res, path)
              if (repaired) return repaired
              // Provider returned nothing usable for the requested periods.
              if (attempt < rpcs.length - 1) continue
            }
            return res
          }
          // Peek at JSON-RPC envelope validity + errors in 200 responses.
          // Malformed/non-JSON bodies and responses missing both result and error
          // (some CDN edges and rate-limiters return HTML or truncated bodies with
          // a 200 status) are never handed to Helios, even as a last resort —
          // feeding its WASM deserializer input it doesn't expect can panic the
          // whole instance instead of throwing a catchable error (confirmed via
          // crash dump: EXC_BREAKPOINT trap inside JIT-compiled WASM on the SW
          // thread). Known error codes below get failed over too — Helios
          // interprets them as "execution RPC broken" and applies backoff for
          // them. Legitimate eth_call reverts (code 3) are returned as-is.
          const clone = res.clone()
          let json: { result?: unknown; error?: { code?: number; message?: string } } | undefined
          try {
            json = await clone.json()
          } catch { /* leave undefined — handled below as malformed */ }
          if (json === undefined || json === null || typeof json !== 'object' ||
              (!('result' in json) && !('error' in json))) {
            if (attempt < rpcs.length - 1) continue
            throw new Error(`[w3] proxy: ${host} returned a malformed response`)
          }
          if (json.error) {
            const msg = json.error.message ?? ''
            const isUnsupported = json.error.code === -32601
            // A genuine contract revert is a real answer — the provider did its
            // job and Helios must see it. Geth-family nodes report reverts as
            // code 3. Everything else (rate limits, -32000 exec failures, -32603
            // internal errors, -32046 "cannot fulfill request" from the retired
            // Cloudflare gateway, and any code we haven't seen yet) means THIS
            // provider could not serve the request — so try the next one.
            //
            // Enumerating broken codes was the wrong default: an unlisted code
            // fell through to Helios, which reads any execution error as "RPC
            // broken" and enters a ~60s backoff, stalling sync entirely.
            // Tenderly's code 3 "intrinsic gas too high" is a validation failure
            // dressed up as a revert, so it's excluded from the revert case.
            const isRevert = json.error.code === 3 && !/intrinsic gas too high/i.test(msg)
            if (isUnsupported) {
              // Provider permanently doesn't support this method — blacklist it
              // so it's never routed to again for this Helios instance.
              if (!_proxyBlacklist.has(proxyKey)) _proxyBlacklist.set(proxyKey, new Set())
              _proxyBlacklist.get(proxyKey)!.add(rpc)
            }
            if (!isRevert && attempt < rpcs.length - 1) continue
          }
          if (cache && !json?.error && json?.result !== undefined && json.result !== null) {
            rpcCacheSet(cache.key, json.result)
          }
          if (execMethods.length) proxyTally(execMethods, Date.now() - _t0)
          return res
        } catch {
          clearTimeout(timer)
          if (attempt < rpcs.length - 1) continue
          throw new Error(`[w3] proxy: all ${rpcs.length} RPCs failed for ${proxyKey}`)
        }
      }
    }
  }
  return _nativeFetch(input, init)
}

// Tries each URL in order, returns first success
export class RpcClient implements IVerifiedRpc {
  constructor(private readonly urls: string[]) {}

  async request<T>(method: string, params: unknown[]): Promise<T> {
    let lastErr: unknown
    for (const url of this.urls) {
      const deadline = Date.now() + 10_000
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 10_000)
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: ctrl.signal,
        })
        // In Chrome MV3 service workers ctrl.abort() sometimes does not cancel
        // an in-progress body read. Race res.json() against the remaining budget
        // from the original 10s window so total per-URL time stays bounded.
        const remaining = Math.max(0, deadline - Date.now())
        const json = await Promise.race([
          res.json() as Promise<{ result: T; error?: { message: string } }>,
          new Promise<never>((_, reject) =>
            setTimeout(() => { ctrl.abort(); reject(new Error('RPC body read timeout')) }, remaining),
          ),
        ])
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

// Try Helios WASM — a single instance whose execution AND consensus traffic
// both go through the failover proxy. No more racing one WASM per consensus
// candidate: per-request consensus failover inside the proxy replaces it and
// halves the startup load. Throws if init fails — callers must not fall back
// to an unverified RPC.
export async function createVerifiedRpc(chain: ChainConfig, forceFresh = false): Promise<IVerifiedRpc> {
  const network = heliosNetwork(chain.chainId)
  console.log(`[w3] Helios proxy: ${chain.rpcs.length} exec + ${chain.consensusRpcs.length} consensus RPCs for chainId ${chain.chainId}`)

  const execKey = `w3-exec-${chain.chainId}-0.invalid`
  const consKey = `w3-cons-${chain.chainId}-0.invalid`
  _proxyRpcs.set(execKey, chain.rpcs)
  _proxyRpcs.set(consKey, chain.consensusRpcs)

  try {
    return await HeliosWasmClient.create(network, `https://${consKey}`, [`https://${execKey}/`], forceFresh)
  } catch (err) {
    _proxyRpcs.delete(execKey)
    _proxyRpcs.delete(consKey)
    console.warn('[w3] Helios init failed:', (err as Error).message)
    throw err
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
