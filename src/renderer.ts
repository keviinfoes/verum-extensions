import { formatWeb3URL, parseWeb3URL } from './lib/url-parser.js'
import type { BgMessage, BgResponse, VerificationUpdate } from './types.js'

const splash          = document.getElementById('splash') as HTMLDivElement
const loading         = document.getElementById('loading') as HTMLDivElement
const loadingText     = document.getElementById('loading-text') as HTMLParagraphElement
const errorPanel      = document.getElementById('error-panel') as HTMLDivElement
const errorMessage    = document.getElementById('error-message') as HTMLPreElement
const dappHost        = document.getElementById('dapp-host') as HTMLDivElement
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
  dappHost.classList.toggle('hidden',    phase !== 'ok')
  verifyBadge.classList.toggle('hidden', phase !== 'ok')
  if (phase === 'ok') {
    verifyBadge.className = 'syncing'
    verifyIcon.textContent = '⟳'
    verifyLabel.textContent = 'Verifying…'
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const initialUrl = location.hash.slice(1)
if (initialUrl) {
  history.replaceState(null, '', '/#' + initialUrl)
  navigate(initialUrl)
} else {
  setPhase('idle')
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

async function navigate(web3Url: string) {
  try { document.title = formatWeb3URL(parseWeb3URL(web3Url)) }
  catch (err) { showError(`Invalid URL: ${err}`); return }

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
        renderContent(new Uint8Array(msg.assembled), msg.contentType)
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
  if (msg.portalVerified) {
    verifyBadge.className = 'portal'
    verifyIcon.textContent = '✓'
    verifyLabel.textContent = 'Portal verified'
    setTimeout(() => verifyBadge.classList.add('hidden'), 2000)
  } else if (msg.heliosBacked && msg.trieVerified) {
    verifyBadge.className = 'verified'
    verifyIcon.textContent = '✓'
    verifyLabel.textContent = 'Verified'
    setTimeout(() => verifyBadge.classList.add('hidden'), 2000)
  } else if (msg.beaconVerified) {
    verifyBadge.className = 'beacon'
    verifyIcon.textContent = '✓'
    const anchor = msg.beaconHeliosAnchored ? ' · Helios anchor' : ''
    verifyLabel.textContent = `Beacon verified (SHA-256 Merkle${anchor})`
    setTimeout(() => verifyBadge.classList.add('hidden'), 3000)
  } else {
    verifyBadge.className = 'failed'
    verifyIcon.textContent = '✗'
    verifyLabel.textContent = 'Unverified'
    warningText.textContent = 'Block header unverified — content authenticity is NOT guaranteed. The RPC endpoint is trusted without cryptographic proof.'
    warningBanner.classList.remove('hidden')
    dappHost.classList.add('with-warning')
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderContent(data: Uint8Array, contentType: string) {
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

  let shadow = (dappHost as any)._shadow as ShadowRoot | undefined
  if (!shadow) {
    shadow = dappHost.attachShadow({ mode: 'open' })
    ;(dappHost as any)._shadow = shadow
  }
  shadow.innerHTML = ''
  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'width:100%;height:100%;border:none;background:white;'
  iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals')
  iframe.srcdoc = html
  shadow.appendChild(iframe)

  setPhase('ok')
}

// ---------------------------------------------------------------------------

function showError(msg: string) { errorMessage.textContent = msg; setPhase('error') }
function esc(s: string) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
