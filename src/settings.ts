import { DEFAULT_CHAINS } from './types.js'
import type { ChainConfig } from './types.js'

const chainsEl        = document.getElementById('chains') as HTMLDivElement
const toast           = document.getElementById('saved-toast') as HTMLDivElement
const addBtn          = document.getElementById('add-chain-btn') as HTMLButtonElement
const newId           = document.getElementById('new-chain-id') as HTMLInputElement
const newName         = document.getElementById('new-chain-name') as HTMLInputElement
const defaultChainSel = document.getElementById('default-chain-select') as HTMLSelectElement

let chains: Record<number, ChainConfig> = {}

async function load() {
  const stored = await chrome.storage.sync.get(['chains', 'defaultChain'])
  chains = stored.chains ?? DEFAULT_CHAINS
  const defaultChain: number = stored.defaultChain ?? 1
  renderDefaultChainSelector(defaultChain)
  render()
}

function renderDefaultChainSelector(selected: number) {
  defaultChainSel.innerHTML = ''
  for (const chain of Object.values(chains)) {
    const opt = document.createElement('option')
    opt.value = String(chain.chainId)
    opt.textContent = `${chain.name} (${chain.chainId})`
    if (chain.chainId === selected) opt.selected = true
    defaultChainSel.appendChild(opt)
  }
}

defaultChainSel.addEventListener('change', () => {
  chrome.storage.sync.set({ defaultChain: parseInt(defaultChainSel.value) }).then(showToast)
})

function render() {
  chainsEl.innerHTML = ''
  for (const chain of Object.values(chains)) {
    chainsEl.appendChild(buildCard(chain))
  }
}

function buildCard(chain: ChainConfig): HTMLElement {
  const card = document.createElement('div')
  card.className = 'chain-card'

  const hasDefaults = !!DEFAULT_CHAINS[chain.chainId]
  card.innerHTML = `
    <div class="chain-header">
      <span class="chain-id">chainId ${chain.chainId}</span>
      <span class="chain-name">${chain.name}</span>
      ${hasDefaults ? '<button class="reset-chain" title="Reset RPCs to defaults">↺ Reset</button>' : ''}
      <button class="delete-chain" title="Remove chain">✕</button>
    </div>
    <div class="rpc-group">
      <div class="rpc-label">Consensus RPCs (beacon API)</div>
      <div class="consensus-list"></div>
      <button class="add-rpc" data-type="consensus">+ Add consensus RPC</button>
    </div>
    <div class="rpc-group">
      <div class="rpc-label">Execution RPCs</div>
      <div class="execution-list"></div>
      <button class="add-rpc" data-type="execution">+ Add execution RPC</button>
    </div>
    <div class="rpc-group">
      <div class="rpc-label">Portal Network node <span class="rpc-hint">(optional — instant verification)</span></div>
      <input class="portal-rpc" type="url" value="${chain.portalRpc ?? ''}" placeholder="http://localhost:8545" />
    </div>
  `

  const consensusList = card.querySelector('.consensus-list') as HTMLDivElement
  const executionList = card.querySelector('.execution-list') as HTMLDivElement

  chain.consensusRpcs.forEach((url) => consensusList.appendChild(rpcRow(url)))
  chain.rpcs.forEach((url) => executionList.appendChild(rpcRow(url)))

  card.querySelector('.reset-chain')?.addEventListener('click', () => {
    const defaults = DEFAULT_CHAINS[chain.chainId]
    if (!defaults) return
    chains[chain.chainId] = {
      ...chains[chain.chainId],
      consensusRpcs: [...defaults.consensusRpcs],
      rpcs: [...defaults.rpcs],
    }
    save()
  })

  card.querySelector('.delete-chain')!.addEventListener('click', () => {
    delete chains[chain.chainId]
    save()
  })

  card.querySelectorAll<HTMLButtonElement>('.add-rpc').forEach((btn) => {
    btn.addEventListener('click', () => {
      const list = btn.dataset.type === 'consensus' ? consensusList : executionList
      list.appendChild(rpcRow(''))
      ;(list.lastElementChild?.querySelector('input') as HTMLInputElement)?.focus()
    })
  })

  // Sync changes back to chains on input
  const portalInput = card.querySelector('.portal-rpc') as HTMLInputElement

  function syncCard() {
    const portalVal = portalInput.value.trim()
    chains[chain.chainId] = {
      ...chain,
      consensusRpcs: rpcValues(consensusList),
      rpcs: rpcValues(executionList),
      ...(portalVal ? { portalRpc: portalVal } : { portalRpc: undefined }),
    }
    saveQuiet()
  }

  enableDragReorder(consensusList, syncCard)
  enableDragReorder(executionList, syncCard)

  card.addEventListener('change', syncCard)
  card.addEventListener('input', debounce(syncCard, 600))

  return card
}

function rpcRow(url: string): HTMLElement {
  const row = document.createElement('div')
  row.className = 'rpc-row'
  row.innerHTML = `
    <span class="drag-handle">⠿</span>
    <input type="url" value="${url}" placeholder="https://…" />
    <button title="Remove">✕</button>
  `
  row.querySelector('button')!.addEventListener('click', () => {
    row.remove()
    row.dispatchEvent(new Event('change', { bubbles: true }))
  })
  // Only allow drag when the handle is the pointer-down target
  row.addEventListener('mousedown', (e) => {
    row.draggable = (row.querySelector('.drag-handle') as HTMLElement).contains(e.target as Node)
  })
  return row
}

function enableDragReorder(list: HTMLElement, onChange: () => void) {
  let dragging: HTMLElement | null = null

  list.addEventListener('dragstart', (e) => {
    dragging = (e.target as HTMLElement).closest('.rpc-row') as HTMLElement | null
    setTimeout(() => dragging?.classList.add('dragging'), 0)
  })

  list.addEventListener('dragend', () => {
    dragging?.classList.remove('dragging')
    dragging = null
    list.querySelectorAll('.drop-above, .drop-below').forEach(el =>
      el.classList.remove('drop-above', 'drop-below'))
  })

  list.addEventListener('dragover', (e) => {
    e.preventDefault()
    if (!dragging) return
    const target = (e.target as HTMLElement).closest<HTMLElement>('.rpc-row')
    list.querySelectorAll('.drop-above, .drop-below').forEach(el =>
      el.classList.remove('drop-above', 'drop-below'))
    if (!target || target === dragging) return
    const { top, height } = target.getBoundingClientRect()
    target.classList.add(e.clientY < top + height / 2 ? 'drop-above' : 'drop-below')
  })

  list.addEventListener('drop', (e) => {
    e.preventDefault()
    if (!dragging) return
    const above = list.querySelector('.drop-above')
    const below = list.querySelector('.drop-below')
    list.querySelectorAll('.drop-above, .drop-below').forEach(el =>
      el.classList.remove('drop-above', 'drop-below'))
    if (above) list.insertBefore(dragging, above)
    else if (below) below.after(dragging)
    onChange()
  })
}

function rpcValues(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input'))
    .map((i) => i.value.trim())
    .filter(Boolean)
}

addBtn.addEventListener('click', () => {
  const id = parseInt(newId.value)
  const name = newName.value.trim()
  if (!id || !name) return
  chains[id] = { chainId: id, name, consensusRpcs: [], rpcs: [] }
  newId.value = ''
  newName.value = ''
  save()
})

// Save + re-render — use for structural changes (add/delete chain, reset, drag-reorder)
function save() {
  chrome.storage.sync.set({ chains }).then(async () => {
    const stored = await chrome.storage.sync.get('defaultChain')
    renderDefaultChainSelector(stored.defaultChain ?? 1)
    render()
    showToast()
  })
}

// Save only — use while the user is typing to avoid destroying the focused input
function saveQuiet() {
  chrome.storage.sync.set({ chains }).then(showToast)
}

let toastTimer: ReturnType<typeof setTimeout>
function showToast() {
  toast.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2000)
}

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout>
  return ((...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }) as T
}

load()
