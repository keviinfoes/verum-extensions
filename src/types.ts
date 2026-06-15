export interface Web3URL {
  raw: string
  chainId: number
  target: TxTarget | EnsTarget
  path: string
}

export interface TxTarget {
  type: 'tx'
  hash: string
}

export interface EnsTarget {
  type: 'ens'
  name: string
}

// W3FS calldata encoding
export const W3FS_MAGIC = 0x57334653 // "W3FS"

export type Compression = 'none' | 'gzip' | 'deflate' | 'brotli'

export interface ContentChunk {
  version: number
  contentType: string
  compression: Compression
  chunkIndex: number
  totalChunks: number
  data: Uint8Array
}

export interface VerificationResult {
  verified: boolean
  blockNumber: number
  blockHash: string
  blockTimestamp: number
  txHash: string
  txIndex: number
  trieVerified: boolean
  headerVerified: boolean
  calldata: Uint8Array
}

export interface ChainConfig {
  chainId: number
  consensusRpcs: string[]  // beacon API endpoints tried in order
  rpcs: string[]           // execution RPC endpoints tried in order
  name: string
  portalRpc?: string       // optional local Portal Network node (e.g. http://localhost:8545)
}

export const DEFAULT_CHAINS: Record<number, ChainConfig> = {
  1: {
    chainId: 1,
    consensusRpcs: [
      'https://lighthouse.mainnet.ethpandaops.io',
      'https://teku.mainnet.ethpandaops.io',
      'https://nimbus.mainnet.ethpandaops.io',
      'https://lodestar-mainnet.chainsafe.io',
      'https://www.lightclientdata.org',
    ],
    rpcs: [
      'https://ethereum-rpc.publicnode.com',
      'https://cloudflare-eth.com',
      'https://eth.drpc.org',
    ],
    name: 'Mainnet',
  },
  11155111: {
    chainId: 11155111,
    consensusRpcs: [
      'https://lighthouse.sepolia.ethpandaops.io',
      'https://teku.sepolia.ethpandaops.io',
      'https://lodestar-sepolia.chainsafe.io',
      'https://nimbus.sepolia.ethpandaops.io',
    ],
    rpcs: [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://sepolia.drpc.org',
      'https://rpc.ankr.com/eth_sepolia',
    ],
    name: 'Sepolia',
  },
}

// Messages between background and renderer
export type BgMessage =
  | { type: 'resolve'; url: string }

export type BgResponse =
  | { type: 'content'; assembled: number[]; contentType: string }
  | { type: 'error'; message: string }
  | VerificationUpdate

export interface VerificationUpdate {
  type: 'verification-update'
  heliosBacked: boolean
  trieVerified: boolean
  portalVerified?: boolean   // verified via local Portal Network node
  beaconVerified?: boolean
  beaconRpcs?: number
  beaconHeliosAnchored?: boolean    // parentBeaconBlockRoot anchor resolved
  beaconEraVerified?: boolean       // historical_summaries era cross-check passed
  beaconStateHashVerified?: boolean // full hash_tree_root(BeaconState) computed locally
  proof: {
    url: string
    blockNumber: number
    blockHash: string
    txHash: string
    txIndex: number
    contentType: string
    payloadSize: string
  }
}
