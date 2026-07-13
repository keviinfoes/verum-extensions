import { formatWeb3URL, parseWeb3URL } from './lib/w3/url-parser.js'
import { parseBundle, bundleFileAt } from './lib/w3/content.js'
import { buildDappHtml } from './lib/w3/dapp-html.js'
import type { BgMessage, BgResponse, VerificationUpdate } from './types.js'

const splash          = document.getElementById('splash') as HTMLDivElement
const loading         = document.getElementById('loading') as HTMLDivElement
const loadingText     = document.getElementById('loading-text') as HTMLParagraphElement
const errorPanel      = document.getElementById('error-panel') as HTMLDivElement
const errorMessage    = document.getElementById('error-message') as HTMLPreElement
const dappHost        = document.getElementById('dapp-host') as HTMLDivElement
const dappFrame       = document.getElementById('dapp-frame') as HTMLIFrameElement
const rawView         = document.getElementById('raw-view') as HTMLDivElement
const warningBanner   = document.getElementById('warning-banner') as HTMLDivElement
const warningText     = document.getElementById('warning-text') as HTMLSpanElement
const warningDismiss  = document.getElementById('warning-dismiss') as HTMLButtonElement
const verifyBadge     = document.getElementById('verify-badge') as HTMLDivElement
const verifyIcon      = document.getElementById('verify-icon') as HTMLSpanElement
const verifyLabel     = document.getElementById('verify-label') as HTMLSpanElement
const heliosBadge     = document.getElementById('helios-badge') as HTMLDivElement

function showWarning() {
  warningBanner.classList.remove('hidden')
  dappHost.classList.add('with-warning')
  rawView.classList.add('with-warning')
}

warningDismiss.addEventListener('click', () => {
  warningBanner.classList.add('hidden')
  dappHost.classList.remove('with-warning')
  rawView.classList.remove('with-warning')
})

type Phase = 'idle' | 'loading' | 'ok' | 'error'

let pageHasScripts = false
let renderMode: 'dapp' | 'raw' = 'dapp'
let rawBlobUrl: string | null = null
let listingBlobUrls: string[] = []
let bundleCache: { key: string; data: Uint8Array } | null = null
let lastVerification: VerificationUpdate | null = null

function bundleCacheKey(parsed: ReturnType<typeof parseWeb3URL>): string {
  if (parsed.target.type === 'tx') {
    return parsed.target.refs.map(r => `${r.blockNumber}:${r.txIndex}`).join('+')
  }
  return `${parsed.chainId}:${parsed.target.name}`
}

function setPhase(phase: Phase) {
  splash.classList.toggle('hidden',      phase !== 'idle')
  loading.classList.toggle('hidden',     phase !== 'loading')
  errorPanel.classList.toggle('hidden',  phase !== 'error')
  dappHost.classList.toggle('dapp-visible', phase === 'ok' && renderMode === 'dapp')
  rawView.classList.toggle('raw-visible', phase === 'ok' && renderMode === 'raw')
  verifyBadge.classList.toggle('hidden', phase !== 'ok')
  if (phase !== 'ok') heliosBadge.classList.add('hidden')
  if (phase === 'ok') {
    verifyBadge.className = 'syncing'
    verifyIcon.textContent = '⟳'
    verifyLabel.textContent = 'Verifying…'
    const contentLabel = renderMode === 'raw' ? 'file' : 'dApp'
    unverifiedModalMsg.textContent = `This ${contentLabel} is still being verified. Content authenticity is not yet confirmed.`
    unverifiedGate.classList.toggle('hidden', !pageHasScripts && renderMode !== 'raw')
    unverifiedModal.classList.add('hidden')
  } else {
    unverifiedGate.classList.add('hidden')
    unverifiedModal.classList.add('hidden')
  }
}

const unverifiedGate         = document.getElementById('unverified-gate') as HTMLDivElement
const unverifiedModal        = document.getElementById('unverified-modal') as HTMLDivElement
const unverifiedModalBackdrop = document.getElementById('unverified-modal-backdrop') as HTMLDivElement
const unverifiedModalMsg     = document.getElementById('unverified-modal-msg') as HTMLParagraphElement
const unverifiedModalCancel  = document.getElementById('unverified-modal-cancel') as HTMLButtonElement
const unverifiedModalAccept  = document.getElementById('unverified-modal-accept') as HTMLButtonElement

unverifiedGate.addEventListener('click', () => unverifiedModal.classList.remove('hidden'))
unverifiedModalBackdrop.addEventListener('click', () => unverifiedModal.classList.add('hidden'))
unverifiedModalCancel.addEventListener('click', () => unverifiedModal.classList.add('hidden'))
unverifiedModalAccept.addEventListener('click', () => {
  unverifiedGate.classList.add('hidden')
  unverifiedModal.classList.add('hidden')
})

const walletPicker         = document.getElementById('wallet-picker') as HTMLDivElement
const walletPickerBackdrop = document.getElementById('wallet-picker-backdrop') as HTMLDivElement
const walletPickerTitle    = document.getElementById('wallet-picker-title') as HTMLHeadingElement
const walletList           = document.getElementById('wallet-list') as HTMLDivElement
const frameToast         = document.getElementById('frame-toast') as HTMLDivElement
const frameToastClose    = document.getElementById('frame-toast-close') as HTMLButtonElement
const toastWalletLabel   = document.getElementById('toast-wallet-label') as HTMLSpanElement

frameToastClose.addEventListener('click', () => frameToast.classList.add('hidden'))


// Keep-alive port: an open port resets Chrome's 30s SW idle timer natively
// without burning any RPC credits. Reconnects if the SW is killed and restarts.
function connectKeepalive() {
  const port = chrome.runtime.connect({ name: 'helios-keepalive' })
  // Ping every 10s — resets Chrome's SW idle timer AND (only for pages that can
  // make eth calls) gives the background a chance to health-check Helios with one
  // cheap WASM call. needsEth is false for plain HTML/image/PDF content, so the
  // background skips the Helios health-check and restart cycle entirely for it.
  const interval = setInterval(() => port.postMessage({ type: 'ping', needsEth: pageHasScripts }), 10_000)
  port.onDisconnect.addListener(() => { clearInterval(interval); setTimeout(connectKeepalive, 1_000) })
}
connectKeepalive()

// Intent-based warmup: signal the SW on user interaction so Helios has time to
// catch up the execution head before the user actually fires a contract read.
// Only for pages with scripts — a static page never reads, so warming the
// live-head instance for it is pure waste.
function warmupHelios() {
  if (currentChainId && pageHasScripts) {
    chrome.runtime.sendMessage({ type: 'warmup-helios', chainId: currentChainId }).catch(() => {})
  }
}
dappHost.addEventListener('mouseenter', warmupHelios)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') warmupHelios()
})

// When Helios finishes syncing, trigger a re-fetch in the dapp so data that
// was served by the plain RpcClient gets replaced with verified Helios reads.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'helios-syncing' && msg.chainId === currentChainId && !currentLocalMode) {
    heliosBadge.classList.remove('hidden')
  }
  if (msg.type === 'helios-ready' && msg.chainId === currentChainId) {
    heliosIsReady = true
    heliosBadge.classList.add('hidden')
    dappFrame.contentWindow?.postMessage({ type: 'wallet-event', method: 'heliosReady' }, '*')
  }
  if (msg.type === 'helios-oos' && msg.chainId === currentChainId && !currentLocalMode) {
    heliosIsReady = false
    heliosBadge.classList.remove('hidden')
  }
})

// ---------------------------------------------------------------------------
// Wallet bridge — eth requests from sandbox → background → chosen wallet
// ---------------------------------------------------------------------------

let selectedWalletId: string | null = null
let selectedWalletName: string = 'wallet'
let connectInProgress = false
let connectSuppressedUntil = 0
let currentChainId = 1
let currentLocalMode = false
let heliosIsReady = false
// Queued connect requests that arrived while the picker was open.
// Resolved with the same result as the original to avoid spurious errors.
let connectWaiters: Array<(result: unknown, error?: string) => void> = []

const CONNECT_METHODS = new Set(['eth_requestAccounts', 'wallet_requestPermissions'])

// Single-flight deduplication for idempotent read calls. When wagmi fires N
// identical eth_call requests simultaneously (one per React Query hook), only
// one message reaches the background — the rest attach to the same promise.
const ethReadInflight = new Map<string, Promise<{ result?: unknown; error?: string }>>()

const FRAME_APPROVAL_METHODS = new Set([
  'eth_sendTransaction', 'eth_sendRawTransaction',
  'eth_sign', 'personal_sign',
  'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4',
  'eth_requestAccounts', 'wallet_requestPermissions',
  'wallet_switchEthereumChain', 'wallet_addEthereumChain',
])

window.addEventListener('message', async (e) => {
  if (!e.data) return
  if (e.source !== dappFrame.contentWindow) return

  if (e.data.type === 'w3-navigate' && typeof e.data.url === 'string') {
    location.hash = e.data.url
    return
  }

  // Polyfill signals it's initialized. Only act if the page has scripts — simple HTML
  // pages get the polyfill too but won't make eth calls so the badge is irrelevant.
  if (e.data.type === 'polyfill-ready') {
    if (!pageHasScripts) return
    if (heliosIsReady) {
      dappFrame.contentWindow?.postMessage({ type: 'wallet-event', method: 'heliosReady' }, '*')
    } else {
      chrome.runtime.sendMessage({ type: 'helios-status', chainId: currentChainId })
        .then((s: { ready: boolean; syncing: boolean } | undefined) => {
          if (!s) return
          if (s.ready) {
            heliosIsReady = true
            dappFrame.contentWindow?.postMessage({ type: 'wallet-event', method: 'heliosReady' }, '*')
          }
        })
        .catch(() => {})
    }
    return
  }

  // wagmi calls provider.disconnect() when the user disconnects. Clear wallet state
  // immediately so subsequent eth_accounts checks return [] and wagmi doesn't reconnect.
  if (e.data.type === 'eth-disconnect') {
    selectedWalletId = null
    selectedWalletName = 'wallet'
    dappFrame.contentWindow?.postMessage(
      { type: 'wallet-event', method: 'accountsChanged', params: [] },
      '*',
    )
    return
  }

  if (e.data.type !== 'eth-request') return
  const { id, method, params } = e.data

  const sendBack = (result: unknown, error?: string) =>
    dappFrame.contentWindow?.postMessage({ type: 'eth-response', id, result, error }, '*')

  // eth_chainId can always be answered from the URL — no wallet connection needed.
  // Returning "Not connected" here causes some dApps to reset their connect UI.
  if (method === 'eth_chainId') {
    sendBack('0x' + currentChainId.toString(16))
    return
  }

  // eth_accounts returns the connected wallet's addresses, not a chain-state query.
  if (method === 'eth_accounts') {
    if (!selectedWalletId) { sendBack([]); return }
    // fall through to wallet path below
  } else if (method.startsWith('wallet_') && !FRAME_APPROVAL_METHODS.has(method)) {
    // wallet_* query methods (e.g. wallet_getPermissions, wallet_getCapabilities) must
    // go to the wallet — Helios has no concept of wallet state. When disconnected,
    // wallet_getPermissions returns [] (no permissions), which tells wagmi to request them.
    if (!selectedWalletId) {
      if (method === 'wallet_getPermissions') { sendBack([]); return }
      sendBack(undefined, 'Not connected'); return
    }
    // fall through to wallet path below
  } else if (!FRAME_APPROVAL_METHODS.has(method)) {
    // All eth_* reads always go through Helios regardless of wallet connection state —
    // ensures reads are verified against the URL's chain, not the wallet's active network.
    const inflightKey = `${currentChainId}:${method}:${JSON.stringify(params)}`
    let p = ethReadInflight.get(inflightKey)
    if (!p) {
      p = new Promise<{ result?: unknown; error?: string }>((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'eth-rpc', chainId: currentChainId, method, params })
          .then(resolve, reject)
      })
      p.finally(() => ethReadInflight.delete(inflightKey))
      ethReadInflight.set(inflightKey, p)
    }
    let resp: { result?: unknown; error?: string } | undefined
    try {
      resp = await p
    } catch (err: any) {
      console.error('[w3] eth-rpc sendMessage failed', method, err?.message)
      sendBack(undefined, err?.message ?? 'eth-rpc unavailable')
      return
    }
    if (resp === undefined) {
      console.error('[w3] eth-rpc no response for', method, params)
      sendBack(undefined, 'eth-rpc no response')
      return
    }
    sendBack(resp.result, resp.error)
    return
  }

  if (!selectedWalletId) {
    if (!CONNECT_METHODS.has(method)) {
      sendBack(undefined, 'Not connected'); return
    }
    // Dapps auto-retry immediately after a wallet rejection. Suppress the picker
    // during a 1-second cooldown so cancelling doesn't reopen it right away.
    if (Date.now() < connectSuppressedUntil) {
      sendBack(undefined, 'User rejected the request.'); return
    }
    // If the picker is already open, queue this request instead of erroring.
    // Erroring concurrent connect calls causes some dApps to reset their UI state.
    if (connectInProgress) {
      await new Promise<void>((resolve) => {
        connectWaiters.push((result, error) => { sendBack(result, error); resolve() })
      })
      return
    }
    connectInProgress = true
    const wallets = await chrome.runtime.sendMessage({ type: 'list-wallets' }) as Array<{ name: string; id: string }>
    if (!wallets || wallets.length === 0) {
      await pickWallet([])
      connectInProgress = false
      connectSuppressedUntil = Date.now() + 1000
      sendBack(undefined, 'No wallet found. Install MetaMask or Frame.')
      return
    }
    // Always show picker even for a single wallet — this requires explicit user
    // intent before we send eth_requestAccounts to MetaMask, preventing the
    // auto-retry loop when the dapp retries after a MetaMask rejection.
    const picked = await pickWallet(wallets)
    connectInProgress = false
    if (!picked) {
      connectSuppressedUntil = Date.now() + 1000
      sendBack(undefined, 'User rejected wallet selection')
      return
    }
    selectedWalletId = picked
    selectedWalletName = wallets.find(w => w.id === picked)?.name ?? 'wallet'
  }

  const needsApprovalToast =
    (selectedWalletId === '__frame__' && FRAME_APPROVAL_METHODS.has(method)) ||
    (selectedWalletId !== '__frame__' && method === 'eth_requestAccounts')

  let frameShowTimer: ReturnType<typeof setTimeout> | undefined
  let frameHideTimer: ReturnType<typeof setTimeout> | undefined
  if (needsApprovalToast) {
    frameShowTimer = setTimeout(() => {
      toastWalletLabel.textContent = `Approve in ${selectedWalletName}`
      frameToast.classList.remove('hidden')
      frameHideTimer = setTimeout(() => frameToast.classList.add('hidden'), 8000)
    }, 400)
  }

  // Use a port (not sendMessage) so the service worker stays alive while
  // waiting for MetaMask's user-approval popup. sendMessage allows the SW to
  // sleep mid-await, clearing the pending-callback map and losing the response.
  const resp = await new Promise<any>((resolve) => {
    const port = chrome.runtime.connect({ name: 'eth-request' })
    port.postMessage({ method, params, walletId: selectedWalletId })
    port.onMessage.addListener((msg) => { port.disconnect(); resolve(msg) })
    port.onDisconnect.addListener(() => resolve({ error: 'Wallet disconnected' }))
  })

  clearTimeout(frameShowTimer)
  clearTimeout(frameHideTimer)
  frameToast.classList.add('hidden')

  if (resp?.error && (resp.error === 'Wallet disconnected' || CONNECT_METHODS.has(method))) {
    selectedWalletId = null
    selectedWalletName = 'wallet'
    if (CONNECT_METHODS.has(method) && resp.error !== 'Wallet disconnected') {
      connectSuppressedUntil = Date.now() + 1000
    }
  }

  // wallet_revokePermissions = disconnect. Clear wallet state and notify the dapp.
  if (!resp?.error && method === 'wallet_revokePermissions') {
    selectedWalletId = null
    selectedWalletName = 'wallet'
    dappFrame.contentWindow?.postMessage(
      { type: 'wallet-event', method: 'accountsChanged', params: [] },
      '*',
    )
  }

  // EIP-1193: emit accountsChanged so dapps that rely on the event update their UI.
  // wallet_requestPermissions is an alternative connect method — extract accounts from
  // the returned caveat so the dApp's accountsChanged listeners fire correctly.
  if (!resp?.error && method === 'eth_requestAccounts' && Array.isArray(resp?.result)) {
    dappFrame.contentWindow?.postMessage(
      { type: 'wallet-event', method: 'accountsChanged', params: resp.result },
      '*',
    )
  }
  if (!resp?.error && method === 'wallet_requestPermissions' && Array.isArray(resp?.result)) {
    type Perm = { parentCapability?: string; caveats?: Array<{ type?: string; value?: unknown }> }
    const perms = resp.result as Perm[]
    const ethPerm = perms.find(p => p.parentCapability === 'eth_accounts')
    const accounts = ethPerm?.caveats?.find(c => c.type === 'restrictReturnedAccounts')?.value
    if (Array.isArray(accounts) && accounts.length > 0) {
      dappFrame.contentWindow?.postMessage(
        { type: 'wallet-event', method: 'accountsChanged', params: accounts },
        '*',
      )
    }
  }

  sendBack(resp?.result, resp?.error)

  // Resolve any connect calls that were queued while the picker was open.
  for (const w of connectWaiters.splice(0)) w(resp?.result, resp?.error)
})

// ---------------------------------------------------------------------------

const WALLET_ICONS: Record<string, { file: string; style?: string }> = {
  'MetaMask':       { file: 'icons/metamask.png' },
  'MetaMask Flask': { file: 'icons/metamask.png' },
  'Frame':          { file: 'icons/frame.png', style: 'filter:invert(1)' },
}

function walletIcon(name: string): string {
  const w = WALLET_ICONS[name]
  if (w) {
    const url = chrome.runtime.getURL(w.file)
    const style = ['border-radius:10px', w.style].filter(Boolean).join(';')
    return `<span class="wallet-icon"><img src="${url}" width="44" height="44" style="${style}" /></span>`
  }
  const label = name.slice(0, 2).toUpperCase()
  return `<span class="wallet-icon" style="background:#30363d;border-radius:10px;color:#fff;font-size:13px;font-weight:700">${label}</span>`
}

const PRIMARY_WALLETS = [
  { name: 'MetaMask', url: 'https://metamask.io/download/' },
  { name: 'Frame',    url: 'https://frame.sh' },
]

function pickWallet(wallets: Array<{ name: string; id: string }>): Promise<string | null> {
  return new Promise((resolve) => {
    const installedNames = new Set(wallets.map(w => w.name))
    const missing = PRIMARY_WALLETS.filter(w => !installedNames.has(w.name))

    walletPickerTitle.textContent = wallets.length === 0 ? 'No wallet found' : 'Select wallet'
    walletList.innerHTML = ''

    for (const w of wallets) {
      const btn = document.createElement('button')
      btn.className = 'wallet-option'
      btn.innerHTML = `${walletIcon(w.name)}<span>${w.name}</span>`
      btn.addEventListener('click', () => { walletPicker.classList.add('hidden'); resolve(w.id) })
      walletList.appendChild(btn)
    }

    for (const w of missing) {
      const btn = document.createElement('button')
      btn.className = 'wallet-option'
      btn.innerHTML = `${walletIcon(w.name)}<span>Get ${w.name}</span>`
      btn.addEventListener('click', () => { chrome.tabs.create({ url: w.url }); walletPicker.classList.add('hidden'); resolve(null) })
      walletList.appendChild(btn)
    }

    walletPickerBackdrop.onclick = () => { walletPicker.classList.add('hidden'); resolve(null) }
    walletPicker.classList.remove('hidden')
  })
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------


const initialUrl = location.hash.slice(1)
if (initialUrl) {
  navigate(initialUrl)
} else {
  setPhase('idle')
}

window.addEventListener('hashchange', () => {
  const url = location.hash.slice(1)
  if (url) navigate(url)
  else setPhase('idle')
})

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

async function navigate(web3Url: string, attempt = 0) {
  // Hide stale dapp content immediately — before any await — so the old dapp
  // never flashes through while storage is read or content arrives fast (local mode).
  dappHost.classList.remove('dapp-visible')
  rawView.classList.remove('raw-visible')

  selectedWalletId = null
  selectedWalletName = 'wallet'
  connectInProgress = false
  connectSuppressedUntil = 0
  for (const w of connectWaiters.splice(0)) w(undefined, 'Navigation cancelled')

  let parsedUrl: ReturnType<typeof parseWeb3URL>
  try {
    const stored = await chrome.storage.sync.get(['defaultChain'])
    const defaultChain = (stored.defaultChain as number | undefined) ?? 1
    parsedUrl = parseWeb3URL(web3Url, defaultChain)
    currentChainId = parsedUrl.chainId
    heliosIsReady = false
    document.title = formatWeb3URL(parsedUrl)
  } catch (err) {
    showError(`Invalid URL: ${err}`)
    return
  }

  renderMode = 'dapp'
  if (rawBlobUrl) { URL.revokeObjectURL(rawBlobUrl); rawBlobUrl = null }
  for (const u of listingBlobUrls) URL.revokeObjectURL(u)
  listingBlobUrls = []
  rawView.innerHTML = ''
  dappFrame.contentWindow?.postMessage({ type: 'render', html: '' }, '*')  // clear stale dapp

  // Same bundle, different path — render from cache without re-fetching or re-verifying.
  const cacheKey = bundleCacheKey(parsedUrl)
  if (bundleCache?.key === cacheKey) {
    renderBundle(bundleCache.data, web3Url)
    if (lastVerification) applyVerification(lastVerification)
    return
  }

  bundleCache = null
  lastVerification = null
  setPhase('loading')
  loadingText.textContent = 'Loading…'

  let contentReceived = false
  await new Promise<void>((resolve) => {
    const port = chrome.runtime.connect({ name: 'web3-resolve' })
    port.postMessage({ type: 'resolve', url: web3Url } as BgMessage)

    port.onMessage.addListener((msg: BgResponse) => {
      if (msg.type === 'error') {
        showError(msg.message)
        resolve()
      } else if (msg.type === 'content') {
        contentReceived = true
        if (msg.contentType === 'application/x-w3fs-bundle') {
          const data = new Uint8Array(msg.assembled)
          bundleCache = { key: cacheKey, data }
          renderBundle(data, web3Url)
        } else {
          renderContent(new Uint8Array(msg.assembled), msg.contentType)
        }
        resolve()  // page shown — keep port open for verification update
      } else if (msg.type === 'verification-update') {
        lastVerification = msg
        applyVerification(msg)
      }
    })

    port.onDisconnect.addListener(() => resolve())
  })

  // SW was killed mid-flight before sending content — retry up to 2 times.
  // Chrome restarts the SW on the next connect(), so the first retry usually succeeds.
  if (!contentReceived) {
    if (attempt < 2) {
      navigate(web3Url, attempt + 1)
    } else {
      showError('Failed to load — service worker did not respond. Try reloading.')
    }
  }
}

// ---------------------------------------------------------------------------
// Verification update (arrives via port after Helios syncs)
// ---------------------------------------------------------------------------

function applyVerification(msg: VerificationUpdate) {
  let isEnsTarget = false
  try { isEnsTarget = parseWeb3URL(msg.proof.url).target.type === 'ens' } catch {}

  const ensTag = isEnsTarget ? ' · ENS ✓' : ''
  const verified = (cls: string, label: string, delay = 2000) => {
    verifyBadge.className = cls
    verifyIcon.textContent = '✓'
    verifyLabel.textContent = label
    setTimeout(() => verifyBadge.classList.add('hidden'), delay)
    unverifiedGate.classList.add('hidden')
  }
  if (msg.localMode) {
    currentLocalMode = true
    heliosBadge.classList.add('hidden')
    verified('verified', 'Local node — RPC trusted')
    return
  }
  currentLocalMode = false

  if (isEnsTarget && msg.ensVerified !== true) {
    verifyBadge.className = 'failed'
    verifyIcon.textContent = '✗'
    verifyLabel.textContent = msg.ensVerified === false
      ? 'ENS forged — record differs from Helios'
      : 'Unverified — ENS not confirmed by Helios'
    if (msg.ensVerified === false) {
      warningText.textContent = 'ENS record mismatch — the RPC returned a different record than Helios confirmed. This may indicate a compromised RPC endpoint.'
      showWarning()
    }
    return
  }

  if (msg.portalVerified) {
    verified('portal', `Portal Network verified${ensTag}`)
  } else if (msg.heliosBacked && msg.trieVerified) {
    verified('verified', `Verified by Helios sync-committee${ensTag}`)
  } else if (msg.beaconVerified && msg.beaconHeliosAnchored) {
    verified('beacon', `Beacon verified — Helios anchor + Merkle proof${ensTag}`, 3000)
  } else if (msg.beaconVerified && msg.beaconEraVerified) {
    verified('beacon', `Beacon verified — era Merkle proof${ensTag}`, 3000)
  } else {
    verifyBadge.className = 'failed'
    verifyIcon.textContent = '✗'
    verifyLabel.textContent = 'Unverified — RPC trusted without proof'
    warningText.textContent = 'Block header unverified — content authenticity is NOT guaranteed. The RPC endpoint is trusted without cryptographic proof.'
    showWarning()
    const contentLabel = renderMode === 'raw' ? 'file' : 'dApp'
    unverifiedModalMsg.textContent = `This ${contentLabel} could not be verified against the blockchain. Its content may have been tampered with. Continue at your own risk.`
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Sandbox is loaded eagerly (src set in HTML). We wait for its load event before
// posting so dapp-sandbox.ts's message listener is guaranteed to be registered.
const sandboxReady = new Promise<void>(resolve =>
  dappFrame.addEventListener('load', () => resolve(), { once: true })
)
function sendToSandbox(msg: object) {
  sandboxReady.then(() => dappFrame.contentWindow?.postMessage(msg, '*'))
}

function renderBundle(data: Uint8Array, web3Url: string) {
  const parsed = parseWeb3URL(web3Url)
  const files = parseBundle(data)
  let file = bundleFileAt(files, parsed.path)

  // No index.html — show a directory listing so non-HTML bundles are navigable.
  // Rendered directly in raw-view (not the sandbox) so links update location.hash
  // and trigger navigate(). DOM construction avoids XSS from untrusted file paths.
  if (!file) {
    const isRoot = !parsed.path || parsed.path === '/'
    if (!isRoot) { showError(`Not found in bundle: ${parsed.path}`); return }

    renderMode = 'raw'
    rawView.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.className = 'raw-listing'
    const h2 = document.createElement('h2')
    h2.textContent = 'Bundle contents'
    wrap.appendChild(h2)
    const table = document.createElement('table')
    for (const f of files) {
      // All files get hash navigation links — renderBundle shows download UI for html/js
      const tr = document.createElement('tr')
      const tdPath = document.createElement('td')
      const a = document.createElement('a')
      a.href = `#${web3Url.replace(/\/$/, '')}${f.path}`
      a.textContent = f.path
      tdPath.appendChild(a)
      const tdMime = document.createElement('td')
      tdMime.textContent = f.mimeType
      const tdSize = document.createElement('td')
      tdSize.textContent = `${f.data.length.toLocaleString()} B`
      tr.append(tdPath, tdMime, tdSize)
      table.appendChild(tr)
    }
    wrap.appendChild(table)
    rawView.appendChild(wrap)
    pageHasScripts = false
    setPhase('ok')
    return
  }

  // Non-HTML entry file in bundle — pass through directly without HTML inlining.
  const entryMime = file.mimeType.toLowerCase().split(';')[0].trim()
  if (!entryMime.includes('html')) {
    renderContent(file.data, file.mimeType)
    return
  }

  // HTML accessed at an explicit path (not root/index entry): show download UI.
  // Avoids running untrusted HTML in the sandbox when navigating a file listing.
  if (parsed.path && parsed.path !== '/') {
    renderMode = 'raw'
    pageHasScripts = false
    rawBlobUrl = URL.createObjectURL(new Blob([file.data as Uint8Array<ArrayBuffer>], { type: file.mimeType }))
    const dlName = file.path.split('/').pop() || file.path
    rawView.innerHTML =
      `<div class="raw-download">` +
      `<p>HTML file &nbsp;·&nbsp; ${file.data.length.toLocaleString()} bytes</p>` +
      `<a href="${rawBlobUrl}" download="${esc(dlName)}">Download ${esc(dlName)}</a>` +
      `</div>`
    setPhase('ok')
    return
  }

  const { html, assetMap } = buildDappHtml(files, file)
  renderContent(new TextEncoder().encode(html), 'text/html', assetMap)
}

function renderContent(data: Uint8Array, contentType: string, assetMap: Record<string, string> = {}) {
  warningBanner.classList.add('hidden')
  dappHost.classList.remove('with-warning')
  rawView.classList.remove('with-warning')

  // Normalise: strip parameters (e.g. "text/plain; charset=utf-8" → "text/plain")
  const ct = contentType.toLowerCase().split(';')[0].trim()

  // SAFETY GATE: text/html and */javascript MUST go through the sandboxed iframe,
  // never raw-view, to prevent extension-origin code execution.
  // Images are safe in rawView via <img> — browsers block script execution in SVGs
  // loaded via <img>. Blob URLs created here can't cross into the sandboxed iframe origin.
  const needsSandbox =
    ct.includes('html') ||
    ct.includes('javascript') ||
    ct.includes('json')

  if (!needsSandbox) {
    renderMode = 'raw'
    pageHasScripts = false

    if (ct === 'application/pdf') {
      rawBlobUrl = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }))
      // Use a plain <iframe> (no sandbox attr) so Chrome's built-in PDF viewer activates.
      rawView.innerHTML = `<iframe src="${rawBlobUrl}"></iframe>`
    } else if (ct.startsWith('text/')) {
      rawView.innerHTML = `<div class="raw-text"><pre>${esc(new TextDecoder().decode(data))}</pre></div>`
    } else if (ct.startsWith('image/')) {
      rawBlobUrl = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: ct }))
      rawView.innerHTML =
        `<div style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100%">` +
        `<img src="${rawBlobUrl}" style="max-width:100%;max-height:100vh"/>` +
        `</div>`
    } else {
      rawBlobUrl = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: ct || 'application/octet-stream' }))
      rawView.innerHTML =
        `<div class="raw-download">` +
        `<p>Content type: <code>${esc(ct || 'unknown')}</code> &nbsp;·&nbsp; ${data.length.toLocaleString()} bytes</p>` +
        `<a href="${rawBlobUrl}" download>Download file</a>` +
        `</div>`
    }

    setPhase('ok')
    return
  }

  renderMode = 'dapp'
  let html: string
  if (ct.includes('html')) {
    html = new TextDecoder().decode(data)
  } else if (ct.includes('javascript')) {
    const code = new TextDecoder().decode(data)
    html = `<!DOCTYPE html><html><body><div id="root"></div><script type="module">${code}<\/script></body></html>`
  } else if (ct.includes('json')) {
    html = `<!DOCTYPE html><html><body><pre style="font-family:monospace;padding:16px">${esc(new TextDecoder().decode(data))}</pre></body></html>`
  } else {
    html = ''
  }

  pageHasScripts = /<script[\s>]/i.test(html)
  sendToSandbox({ type: 'render', html, assetMap, chainId: currentChainId })
  // Now that we know the page can make eth calls, start the live-head Helios
  // instance — it is no longer spawned during verification, so without this the
  // dapp's first read would have to wait for the whole sync.
  if (pageHasScripts) warmupHelios()
  setPhase('ok')
}

// ---------------------------------------------------------------------------

function showError(msg: string) { errorMessage.textContent = msg; setPhase('error') }
function esc(s: string) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
