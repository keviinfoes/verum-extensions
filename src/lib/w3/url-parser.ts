import { ensNormalize } from 'ethers'
import type { Web3URL } from '../../types.js'

// Supported formats:
//   w3://myapp.eth                       ENS name (resolved at fetch time)
//   w3://myapp.gwei                      GNS name (resolved at fetch time)
//   w3://<chainId>:myapp.eth             ENS/GNS on specific chain
//   w3://<blockNumber>:<txIndex>         Direct tx reference (uses default chain)
//   w3://<chainId>:<blockNumber>:<txIndex>  Tx reference on specific chain
//   ...with optional /path suffix

export function parseWeb3URL(raw: string, defaultChainId = 1): Web3URL {
  const stripped = raw.replace(/^w3:\/\//i, '')

  let rest = stripped
  let chainId = defaultChainId
  let path = '/'

  // Extract trailing path
  const slashIdx = rest.indexOf('/')
  if (slashIdx !== -1) {
    path = rest.slice(slashIdx)
    rest = rest.slice(0, slashIdx)
  }

  // Try leading chainId prefix: digits followed by a colon with more content after.
  // If the remainder after stripping the prefix is a tx ref, treat it as chainId:block:txIndex.
  // If the remainder contains a dot, treat it as chainId:ens-name.
  const firstColon = rest.indexOf(':')
  if (firstColon !== -1) {
    const maybeChain = rest.slice(0, firstColon)
    const remainder = rest.slice(firstColon + 1)
    if (/^\d+$/.test(maybeChain) && remainder.length > 0) {
      if (/^(\d+:\d+)(\+\d+:\d+)*$/.test(remainder)) {
        // chainId:block:txIndex (or chainId:block:txIndex+block2:txIndex2)
        chainId = parseInt(maybeChain, 10)
        const refs = remainder.split('+').map(part => {
          const [b, t] = part.split(':')
          return { blockNumber: parseInt(b, 10), txIndex: parseInt(t, 10) }
        })
        return { raw, chainId, target: { type: 'tx', refs }, path }
      }
      if (remainder.includes('.')) {
        // chainId:ens-name
        chainId = parseInt(maybeChain, 10)
        rest = remainder
      }
      // else: treat the whole rest as a plain block:txIndex (no chainId prefix)
    }
  }

  // Direct tx reference(s): one or more blockNumber:txIndex pairs separated by +
  if (/^(\d+:\d+)(\+\d+:\d+)*$/.test(rest)) {
    const refs = rest.split('+').map(part => {
      const [b, t] = part.split(':')
      return { blockNumber: parseInt(b, 10), txIndex: parseInt(t, 10) }
    })
    return { raw, chainId, target: { type: 'tx', refs }, path }
  }

  // ENS or GNS name — anything with a dot (resolveEns picks the registry by TLD)
  if (rest.includes('.')) {
    let name: string
    try {
      name = ensNormalize(rest)
    } catch {
      throw new Error(`Invalid ENS/GNS name: "${rest}"`)
    }
    return { raw, chainId, target: { type: 'ens', name }, path }
  }

  throw new Error(`Invalid w3 URL: expected an ENS/GNS name (e.g. myapp.eth or myapp.gwei) or block:txIndex`)
}

export function formatWeb3URL(parsed: Web3URL): string {
  const path = parsed.path === '/' ? '' : parsed.path
  const chain = parsed.chainId !== 1 ? `${parsed.chainId}:` : ''
  if (parsed.target.type === 'tx') {
    const refs = parsed.target.refs.map(r => `${r.blockNumber}:${r.txIndex}`).join('+')
    return `w3://${chain}${refs}${path}`
  }
  return `w3://${chain}${parsed.target.name}${path}`
}
