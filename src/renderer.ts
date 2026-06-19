import { formatWeb3URL, parseWeb3URL } from './lib/url-parser.js'
import { parseBundle, bundleFileAt } from './lib/content.js'
import type { BgMessage, BgResponse, VerificationUpdate } from './types.js'

const splash          = document.getElementById('splash') as HTMLDivElement
const loading         = document.getElementById('loading') as HTMLDivElement
const loadingText     = document.getElementById('loading-text') as HTMLParagraphElement
const errorPanel      = document.getElementById('error-panel') as HTMLDivElement
const errorMessage    = document.getElementById('error-message') as HTMLPreElement
const dappHost        = document.getElementById('dapp-host') as HTMLDivElement
const dappFrame       = document.getElementById('dapp-frame') as HTMLIFrameElement
const warningBanner   = document.getElementById('warning-banner') as HTMLDivElement
const warningText     = document.getElementById('warning-text') as HTMLSpanElement
const warningDismiss  = document.getElementById('warning-dismiss') as HTMLButtonElement
const verifyBadge     = document.getElementById('verify-badge') as HTMLDivElement
const verifyIcon      = document.getElementById('verify-icon') as HTMLSpanElement
const verifyLabel     = document.getElementById('verify-label') as HTMLSpanElement

warningDismiss.addEventListener('click', () => {
  warningBanner.classList.add('hidden')
  dappHost.classList.remove('with-warning')
})

type Phase = 'idle' | 'loading' | 'ok' | 'error'

function setPhase(phase: Phase) {
  splash.classList.toggle('hidden',      phase !== 'idle')
  loading.classList.toggle('hidden',     phase !== 'loading')
  errorPanel.classList.toggle('hidden',  phase !== 'error')
  dappHost.classList.toggle('dapp-visible', phase === 'ok')
  verifyBadge.classList.toggle('hidden', phase !== 'ok')
  if (phase === 'ok') {
    verifyBadge.className = 'syncing'
    verifyIcon.textContent = '⟳'
    verifyLabel.textContent = 'Verifying…'
    gateVerificationFailed = false
    unverifiedModalMsg.textContent = 'This dApp is still being verified. Content authenticity is not yet confirmed.'
    unverifiedGate.classList.remove('hidden')
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

let gateVerificationFailed = false

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


// ---------------------------------------------------------------------------
// Wallet bridge — eth requests from sandbox → background → chosen wallet
// ---------------------------------------------------------------------------

let selectedWalletId: string | null = null
let selectedWalletName: string = 'wallet'
let connectInProgress = false
let connectSuppressedUntil = 0
let currentChainId = 1
// Queued connect requests that arrived while the picker was open.
// Resolved with the same result as the original to avoid spurious errors.
let connectWaiters: Array<(result: unknown, error?: string) => void> = []

const CONNECT_METHODS = new Set(['eth_requestAccounts', 'wallet_requestPermissions'])

const FRAME_APPROVAL_METHODS = new Set([
  'eth_sendTransaction', 'eth_sendRawTransaction',
  'eth_sign', 'personal_sign',
  'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4',
  'eth_requestAccounts', 'wallet_requestPermissions',
  'wallet_switchEthereumChain', 'wallet_addEthereumChain',
])

window.addEventListener('message', async (e) => {
  if (!e.data || e.data.type !== 'eth-request') return
  if (e.source !== dappFrame.contentWindow) return
  const { id, method, params } = e.data

  const sendBack = (result: unknown, error?: string) =>
    dappFrame.contentWindow?.postMessage({ type: 'eth-response', id, result, error }, '*')

  // eth_chainId can always be answered from the URL — no wallet connection needed.
  // Returning "Not connected" here causes some dApps to reset their connect UI.
  if (method === 'eth_chainId') {
    sendBack('0x' + currentChainId.toString(16))
    return
  }

  if (!selectedWalletId) {
    if (!CONNECT_METHODS.has(method)) {
      // Silent fallback for background checks before the user has connected
      if (method === 'eth_accounts') { sendBack([]); return }
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

const WALLET_ICON_FILES: Record<string, string> = {
  'MetaMask':       'icons/metamask.png',
  'MetaMask Flask': 'icons/metamask.png',
  'Frame':          'icons/frame.png',
}

const WALLET_ICON_STYLE: Record<string, string> = {
  'Frame': 'border-radius:10px;filter:invert(1)',
}

function walletIcon(name: string): string {
  const file = WALLET_ICON_FILES[name]
  if (file) {
    const url = chrome.runtime.getURL(file)
    const style = WALLET_ICON_STYLE[name] ?? 'border-radius:10px'
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

async function navigate(web3Url: string) {
  selectedWalletId = null
  selectedWalletName = 'wallet'
  connectInProgress = false
  connectSuppressedUntil = 0
  for (const w of connectWaiters.splice(0)) w(undefined, 'Navigation cancelled')
  let parsedUrl: ReturnType<typeof parseWeb3URL>
  try {
    parsedUrl = parseWeb3URL(web3Url)
    currentChainId = parsedUrl.chainId
    document.title = formatWeb3URL(parsedUrl)
  } catch (err) {
    showError(`Invalid URL: ${err}`)
    return
  }

  setPhase('loading')
  loadingText.textContent = 'Loading…'

  await new Promise<void>((resolve) => {
    const port = chrome.runtime.connect({ name: 'web3-resolve' })
    port.postMessage({ type: 'resolve', url: web3Url } as BgMessage)

    port.onMessage.addListener((msg: BgResponse) => {
      if (msg.type === 'error') {
        showError(msg.message)
        resolve()
      } else if (msg.type === 'content') {
        if (msg.contentType === 'application/x-w3fs-bundle') {
          renderBundle(new Uint8Array(msg.assembled), web3Url)
        } else {
          renderContent(new Uint8Array(msg.assembled), msg.contentType)
        }
        resolve()  // page shown — keep port open for verification update
      } else if (msg.type === 'verification-update') {
        applyVerification(msg)
      }
    })

    port.onDisconnect.addListener(() => resolve())
  })
}

// ---------------------------------------------------------------------------
// Verification update (arrives via port after Helios syncs)
// ---------------------------------------------------------------------------

function applyVerification(msg: VerificationUpdate) {
  let isEnsTarget = false
  try { isEnsTarget = parseWeb3URL(msg.proof.url).target.type === 'ens' } catch {}

  // ENS targets require Helios to have confirmed the record — without it the
  // execution RPC could point to arbitrary calldata.
  if (isEnsTarget && msg.ensVerified !== true) {
    verifyBadge.className = 'failed'
    verifyIcon.textContent = '✗'
    verifyLabel.textContent = msg.ensVerified === false
      ? 'ENS forged — record differs from Helios'
      : 'Unverified — ENS not confirmed by Helios'
    if (msg.ensVerified === false) {
      warningText.textContent = 'ENS record mismatch — the RPC returned a different record than Helios confirmed. This may indicate a compromised RPC endpoint.'
      warningBanner.classList.remove('hidden')
      dappHost.classList.add('with-warning')
    }
    return
  }

  const ensTag = isEnsTarget ? ' · ENS ✓' : ''
  if (msg.portalVerified) {
    verifyBadge.className = 'portal'
    verifyIcon.textContent = '✓'
    verifyLabel.textContent = `Portal verified${ensTag}`
    setTimeout(() => verifyBadge.classList.add('hidden'), 2000)
    unverifiedGate.classList.add('hidden')
  } else if (msg.heliosBacked && msg.trieVerified) {
    verifyBadge.className = 'verified'
    verifyIcon.textContent = '✓'
    verifyLabel.textContent = `Verified${ensTag}`
    setTimeout(() => verifyBadge.classList.add('hidden'), 2000)
    unverifiedGate.classList.add('hidden')
  } else if (msg.beaconVerified && msg.beaconHeliosAnchored) {
    verifyBadge.className = 'beacon'
    verifyIcon.textContent = '✓'
    verifyLabel.textContent = `Beacon verified (SHA-256 Merkle · Helios anchor)${ensTag}`
    setTimeout(() => verifyBadge.classList.add('hidden'), 3000)
    unverifiedGate.classList.add('hidden')
  } else {
    verifyBadge.className = 'failed'
    verifyIcon.textContent = '✗'
    verifyLabel.textContent = 'Unverified'
    warningText.textContent = 'Block header unverified — content authenticity is NOT guaranteed. The RPC endpoint is trusted without cryptographic proof.'
    warningBanner.classList.remove('hidden')
    dappHost.classList.add('with-warning')
    gateVerificationFailed = true
    unverifiedModalMsg.textContent = 'This dApp could not be verified against the blockchain. Its content may have been tampered with. Continue at your own risk.'
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Sandbox is loaded eagerly (src set in HTML). We wait for its load event before
// posting so dapp-sandbox.ts's message listener is guaranteed to be registered.
const sandboxReady = new Promise<void>(resolve =>
  dappFrame.addEventListener('load', resolve, { once: true })
)
function sendToSandbox(msg: object) {
  sandboxReady.then(() => dappFrame.contentWindow?.postMessage(msg, '*'))
}

// Fake stable origin used as the module resolution base inside srcdoc iframes.
// All bundle file paths are mapped to data: URIs under this origin via importmap.
const DAPP_BASE = 'https://dapp.w3fs/'

// Rewrite relative import/export specifiers in a JS module to absolute DAPP_BASE URLs.
// When we inline a script from e.g. assets/index.js into the HTML root, its relative
// imports like ./chunk.js would resolve against the document root (wrong). Absolutifying
// them to https://dapp.w3fs/assets/chunk.js lets the import map catch them correctly.
function absolutifyImports(code: string, scriptUrl: string): string {
  const dir = scriptUrl.slice(0, scriptUrl.lastIndexOf('/') + 1)
  code = code.replace(/\bimport\((['"])(\.{1,2}\/[^'"]+)\1\)/g,
    (_, q, spec) => `import(${q}${new URL(spec, dir).href}${q})`)
  code = code.replace(/\bfrom\s*(['"])(\.{1,2}\/[^'"]+)\1/g,
    (_, q, spec) => `from ${q}${new URL(spec, dir).href}${q}`)
  return code
}

function toB64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))
}

function renderBundle(data: Uint8Array, web3Url: string) {
  const parsed = parseWeb3URL(web3Url)
  const files = parseBundle(data)
  const file = bundleFileAt(files, parsed.path)
  if (!file) { showError(`Not found in bundle: ${parsed.path}`); return }

  const fileMap = new Map(files.map(f => [f.path, f]))
  function resolve(src: string) {
    if (!src || /^(https?:|data:|blob:)/.test(src)) return null
    return fileMap.get('/' + src.replace(/^\.?\//, '')) ?? null
  }

  let html = new TextDecoder().decode(file.data)

  // Inject <base> so any remaining relative URLs in the document resolve here.
  if (!/<base\b/i.test(html)) {
    const baseTag = `<base href="${DAPP_BASE}">`
    html = /<head>/i.test(html)
      ? html.replace(/<head>/i, `<head>${baseTag}`)
      : baseTag + html
  }

  // Build import map: every JS file → data: URI with its own relative imports
  // already absolutified. This makes dynamic import('./chunk.js') inside any
  // data: module resolve through the map instead of hitting the network.
  const imports: Record<string, string> = {}
  for (const f of files) {
    const mt = f.mimeType.toLowerCase()
    if (mt.includes('javascript') || f.path.endsWith('.js')) {
      const rel = f.path.replace(/^\//, '')
      const scriptUrl = DAPP_BASE + rel
      const code = absolutifyImports(new TextDecoder().decode(f.data), scriptUrl)
      const dataUri = `data:text/javascript;base64,${toB64(new TextEncoder().encode(code))}`
      imports[scriptUrl] = dataUri
      imports['./' + rel] = dataUri
    }
  }

  if (Object.keys(imports).length > 0) {
    const importMapTag = `<script type="importmap">${JSON.stringify({ imports })}</script>`
    html = /<head>/i.test(html)
      ? html.replace(/<head>/i, `<head>${importMapTag}`)
      : importMapTag + html
  }

  // Build asset map for images/fonts dynamically rendered by JS (e.g. React components).
  // Passed to the sandbox so a MutationObserver polyfill can rewrite img.src at runtime.
  const assetMap: Record<string, string> = {}
  for (const f of files) {
    const mt = f.mimeType.toLowerCase()
    if (!mt.includes('javascript') && !mt.includes('html') && !mt.includes('css')) {
      const rel = f.path.replace(/^\//, '')
      assetMap[DAPP_BASE + rel] = `data:${f.mimeType};base64,${toB64(f.data)}`
    }
  }

  // <link href="..."> → <style>
  html = html.replace(/<link([^>]*?)>/gi, (match, attrs) => {
    const href = /\shref="([^"]+)"/i.exec(attrs)?.[1]
    const rel  = /\srel="([^"]+)"/i.exec(attrs)?.[1] ?? 'stylesheet'
    if (!href || !rel.includes('stylesheet')) return match
    const f = resolve(href)
    return f ? `<style>${new TextDecoder().decode(f.data)}</style>` : match
  })

  // All <script src="..."> → inline with imports absolutified to their original path.
  html = html.replace(/<script([^>]*?)\ssrc="([^"]+)"([^>]*?)>/gi, (match, pre, src, post) => {
    const f = resolve(src)
    if (!f) return match
    const scriptUrl = new URL(src.replace(/^\.\//, ''), DAPP_BASE).href
    const code = absolutifyImports(new TextDecoder().decode(f.data), scriptUrl)
    return `<script${pre}${post}>${code}`
  })

  // Static <img src="..."> in HTML → data URI
  html = html.replace(/(<img[^>]*?\ssrc=")([^"]+)(")/gi, (match, pre, src, post) => {
    const f = resolve(src)
    if (!f) return match
    return `${pre}data:${f.mimeType};base64,${toB64(f.data)}${post}`
  })

  renderContent(new TextEncoder().encode(html), 'text/html', assetMap)
}

function renderContent(data: Uint8Array, contentType: string, assetMap: Record<string, string> = {}) {
  // No warning banner shown yet — wait for verification result
  warningBanner.classList.add('hidden')
  dappHost.classList.remove('with-warning')

  const ct = contentType.toLowerCase()
  let html: string
  if (ct.includes('html')) {
    html = new TextDecoder().decode(data)
  } else if (ct.includes('javascript')) {
    const code = new TextDecoder().decode(data)
    html = `<!DOCTYPE html><html><body><div id="root"></div><script type="module">${code}<\/script></body></html>`
  } else if (ct.includes('json')) {
    html = `<!DOCTYPE html><html><body><pre style="font-family:monospace;padding:16px">${esc(new TextDecoder().decode(data))}</pre></body></html>`
  } else if (ct.startsWith('image/')) {
    const url = URL.createObjectURL(new Blob([data], { type: contentType }))
    html = `<!DOCTYPE html><html><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh"><img src="${url}" style="max-width:100%;max-height:100vh"/></body></html>`
  } else {
    html = `<!DOCTYPE html><html><body><pre style="font-family:monospace;padding:16px;white-space:pre-wrap">${esc(new TextDecoder().decode(data))}</pre></body></html>`
  }

  sendToSandbox({ type: 'render', html, assetMap })
  setPhase('ok')
}

// ---------------------------------------------------------------------------

function showError(msg: string) { errorMessage.textContent = msg; setPhase('error') }
function esc(s: string) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
