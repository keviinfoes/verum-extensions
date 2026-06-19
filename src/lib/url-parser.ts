import type { Web3URL } from '../types.js'

// Supported formats:
//   portal://myapp.eth              ENS name (resolved at fetch time)
//   portal://<chainId>:myapp.eth    ENS on specific chain
//   ...with optional /path suffix

export function parseWeb3URL(raw: string, defaultChainId = 1): Web3URL {
  const stripped = raw.replace(/^portal:\/\//i, '')

  let rest = stripped
  let chainId = defaultChainId
  let path = '/'

  // Extract trailing path
  const slashIdx = rest.indexOf('/')
  if (slashIdx !== -1) {
    path = rest.slice(slashIdx)
    rest = rest.slice(0, slashIdx)
  }

  // Extract leading chainId (digits before the first colon)
  const colonIdx = rest.indexOf(':')
  if (colonIdx !== -1) {
    const maybeChain = rest.slice(0, colonIdx)
    if (/^\d+$/.test(maybeChain)) {
      chainId = parseInt(maybeChain, 10)
      rest = rest.slice(colonIdx + 1)
    }
  }

  // ENS name — anything with a dot
  if (rest.includes('.')) {
    return { raw, chainId, target: { type: 'ens', name: rest.toLowerCase() }, path }
  }

  throw new Error(`Invalid portal URL: expected an ENS name (e.g. myapp.eth)`)
}

export function formatWeb3URL(parsed: Web3URL): string {
  const chain = parsed.chainId !== 1 ? `${parsed.chainId}:` : ''
  const path = parsed.path === '/' ? '' : parsed.path
  return `portal://${chain}${parsed.target.name}${path}`
}
