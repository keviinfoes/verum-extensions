// Direct extension bridge for Ambire wallet via chrome.runtime.sendMessage.
// Ambire declares externally_connectable: { ids: ["*"] } which allows any extension
// to send one-shot JSON-RPC messages directly to its background service worker.
// Unlike MetaMask-compatible wallets, Ambire does not expose onConnectExternal
// so the port-based object-multiplex protocol cannot be used.

const AMBIRE_ID = 'ehgjhhccekdedpbkifaojjaefeohnoea'

let nextId = 1
let available: boolean | null = null

function send(method: string, params: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++
    chrome.runtime.sendMessage(
      AMBIRE_ID,
      { jsonrpc: '2.0', id, method, params },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }
        if (!response) { reject(new Error('No response from Ambire')); return }
        if (response.error) reject(new Error(response.error.message ?? JSON.stringify(response.error)))
        else resolve(response.result)
      },
    )
  })
}

export async function isAmbireAvailable(): Promise<boolean> {
  if (available !== null) return available
  try {
    await send('net_version', [])
    available = true
  } catch {
    available = false
  }
  return available
}

// Reset cached availability (called when the user changes wallet selection).
export function resetAmbireCache(): void { available = null }

export async function ambireRequest(method: string, params: unknown[]): Promise<unknown> {
  return send(method, params)
}
