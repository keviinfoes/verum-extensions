const idle    = document.getElementById('idle') as HTMLDivElement
const proof   = document.getElementById('proof') as HTMLDivElement
const verdict = document.getElementById('verdict') as HTMLDivElement
const navInput = document.getElementById('nav-input') as HTMLInputElement
const navGo    = document.getElementById('nav-go') as HTMLButtonElement

function navigate() {
  const raw = navInput.value.trim()
  if (!raw) return
  const url = raw.startsWith('w3://') ? raw : `w3://${raw}`
  const rendererUrl = chrome.runtime.getURL('renderer.html') + '#' + url
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id) chrome.tabs.update(tab.id, { url: rendererUrl })
    window.close()
  })
}

navGo.addEventListener('click', navigate)
navInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate() })

document.getElementById('settings-btn')!.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') })
})

// Re-render when background updates the proof (e.g. Helios finishes verifying)
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab?.id) return
  const watchKey = `proof_${tab.id}`
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && watchKey in changes) {
      const data = changes[watchKey].newValue
      if (data) showProof(data)
      else showIdle()
    }
  })
})

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) { showIdle(); return }

  const key = `proof_${tab.id}`
  const stored = await chrome.storage.session.get(key)
  const data = stored[key]
  if (!data) { showIdle(); return }

  showProof(data)
}

function showIdle() {
  idle.classList.remove('hidden')
  proof.classList.add('hidden')
}

function showProof(d: any) {
  if (d.url) navInput.value = d.url.replace('w3://', '')
  idle.classList.add('hidden')
  proof.classList.remove('hidden')

  const pending = d.pending === true
  const beaconTrusted = d.beaconVerified && d.beaconHeliosAnchored
  const isEns = typeof d.url === 'string' && /(?:w3|portal):\/\/[^/]+\.eth/.test(d.url)
  const ensBlocked = isEns && d.ensVerified !== true && !pending && !d.localMode
  const cls = d.localMode ? 'verified' : ensBlocked ? 'unverified' : d.portalVerified ? 'portal' : d.heliosBacked ? 'verified' : beaconTrusted ? 'beacon' : pending ? 'pending' : 'unverified'
  verdict.className = cls
  document.getElementById('verdict-icon')!.textContent =
    d.localMode       ? '✓' :
    ensBlocked        ? '⚠️' :
    d.portalVerified  ? '⚡' :
    d.heliosBacked    ? '🔒' :
    beaconTrusted     ? '✓' :
    pending           ? '⟳' : '⚠️'
  document.getElementById('verdict-text')!.textContent =
    d.localMode       ? 'Local node — RPC trusted' :
    ensBlocked && d.ensVerified === false ? 'ENS forged — record differs from Helios' :
    ensBlocked        ? 'Unverified — ENS not confirmed by Helios' :
    d.portalVerified  ? 'Portal Network verified' :
    d.heliosBacked    ? 'Verified by Helios sync-committee' :
    beaconTrusted     ? 'Beacon verified — Helios anchor + Merkle proof' :
    d.beaconVerified  ? 'Untrusted — beacon proof without Helios anchor' :
    pending           ? 'Verifying…' :
    'Unverified — RPC trusted without proof'

  const set = (id: string, val: string) => {
    const el = document.getElementById(id); if (el) el.textContent = val
  }
  set('pf-url',        d.url ?? '—')
  set('pf-block',      d.blockNumber ? String(d.blockNumber) : pending ? '…' : '—')
  set('pf-block-hash', d.blockHash || (pending ? '…' : '—'))
  const txHashRow = document.getElementById('pf-tx-hash-row')!
  if (d.txHash) { txHashRow.classList.remove('hidden'); set('pf-tx-hash', d.txHash) }
  else { txHashRow.classList.add('hidden') }
  set('pf-tx-index',   d.txIndex !== undefined && !pending ? String(d.txIndex) : pending ? '…' : '—')
  set('pf-trie',       d.localMode ? 'N/A — local node trusted' : d.trieVerified ? 'YES — cryptographically proven' : pending ? 'Verifying…' : 'NO')
  let headerText = d.localMode ? 'N/A — local node trusted' : 'NO — trusted RPC only'
  if (d.portalVerified) {
    headerText = 'YES — Portal Network (sync committee BLS, local node)'
  } else if (d.heliosBacked) {
    headerText = 'YES — Helios sync-committee (BLS)'
  } else if (beaconTrusted) {
    const stateStep = d.beaconStateHashVerified ? 'hash_tree_root(BeaconState)' : 'SHA-256 Merkle only'
    headerText = 'YES — Helios EIP-4788 anchor → ' + stateStep + ' → historical_summaries[era] → execution cross-check'
  } else if (d.beaconVerified) {
    headerText = 'NO — beacon proof computed but Helios anchor missing (untrusted)'
  } else if (pending) {
    headerText = 'Verifying…'
  }
  set('pf-header', headerText)
  const ensRow = document.getElementById('pf-ens-row')!
  if (isEns && !d.localMode) {
    ensRow.classList.remove('hidden')
    set('pf-ens',
      d.ensVerified === true  ? 'YES — confirmed by Helios' :
      d.ensVerified === false ? 'MISMATCH — record differs from Helios (possible forgery)' :
      pending                 ? 'Verifying…' :
                                'Unverified — Helios could not confirm',
    )
  } else {
    ensRow.classList.add('hidden')
  }

  set('pf-ct',         d.contentType ?? '—')
  set('pf-size',       d.payloadSize ?? '—')
}

load()
