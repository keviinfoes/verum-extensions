import type { Web3URL } from '../types.js'

// Supported formats:
//   web3://tx:0x<hash>            mainnet tx
//   web3://<chainId>:tx:0x<hash>  explicit chain tx
//   web3://myapp.eth              ENS name (resolved at fetch time)
//   web3://<chainId>:myapp.eth    ENS on specific chain
//   ...with optional /path suffix

export function parseWeb3URL(raw: string, defaultChainId = 1): Web3URL {
  const stripped = raw.replace(/^web3:\/\//i, '')

  let rest = stripped
  let chainId = defaultChainId
  let path = '/'

  // Extract trailing path
  const slashIdx = rest.indexOf('/')
  if (slashIdx !== -1) {
    path = rest.slice(slashIdx)
    rest = rest.slice(0, slashIdx)
  }

  // Extract leading chainId  (digits before first colon that isn't part of tx:)
  const colonIdx = rest.indexOf(':')
  if (colonIdx !== -1) {
    const maybeChain = rest.slice(0, colonIdx)
    if (/^\d+$/.test(maybeChain)) {
      chainId = parseInt(maybeChain, 10)
      rest = rest.slice(colonIdx + 1)
    }
  }

  // tx:0x<hash>
  if (rest.toLowerCase().startsWith('tx:')) {
    const hash = rest.slice(3)
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new Error(`Invalid tx hash in web3 URL: ${hash}`)
    }
    return { raw, chainId, target: { type: 'tx', hash }, path }
  }

  // ENS name — anything with a dot
  if (rest.includes('.')) {
    return { raw, chainId, target: { type: 'ens', name: rest.toLowerCase() }, path }
  }

  throw new Error(`Invalid web3 URL target: ${rest}`)
}

export function formatWeb3URL(parsed: Web3URL): string {
  const chain = parsed.chainId !== 1 ? `${parsed.chainId}:` : ''
  const target =
    parsed.target.type === 'tx'  ? `tx:${parsed.target.hash}` :
    parsed.target.name
  const path = parsed.path === '/' ? '' : parsed.path
  return `web3://${chain}${target}${path}`
}
