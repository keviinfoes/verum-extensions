export interface Web3URL {
  raw: string
  chainId: number
  target: EnsTarget | TxTarget
  path: string
}

export interface EnsTarget {
  type: 'ens'
  name: string
}

export interface TxTarget {
  type: 'tx'
  refs: Array<{ blockNumber: number; txIndex: number }>
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
  localMode?: boolean                  // use only rpcs[0] at batch 1000, skip era/parquet
  portalRpc?: string       // optional local Portal Network node (e.g. http://localhost:8545)
  checkpointUrls?: string[]           // checkpoint sync providers (prepended before built-in defaults)
  eraFileUrls?: string[]              // era file base URLs (prepended before built-in defaults)
  parquetUrls?: string[]              // xatu parquet base URLs (prepended before built-in defaults)
  rpcBatchSizes?: Record<string, number>  // max JSON-RPC batch size per execution RPC URL
}

export const DEFAULT_CHAINS: Record<number, ChainConfig> = {
  1: {
    chainId: 1,
    name: 'Mainnet',
    consensusRpcs: [
      'https://lodestar-mainnet.chainsafe.io',
      'https://ethereum-beacon-api.publicnode.com',
    ],
    rpcs: [
      'https://ethereum-rpc.publicnode.com',
      'https://cloudflare-eth.com',
      'https://eth.drpc.org',
    ],
    rpcBatchSizes: {
      'https://ethereum-rpc.publicnode.com': 200,
      'https://cloudflare-eth.com': 200,
      'https://eth.drpc.org': 200,
    },
    checkpointUrls: [
      'https://beaconstate-mainnet.chainsafe.io',
      'https://beaconstate.ethstaker.cc',
      'https://mainnet.checkpoint.sigp.io',
    ],
    eraFileUrls: [
      'https://mainnet.era.nimbus.team',
    ],
    parquetUrls: [
      'https://data.ethpandaops.io/xatu/mainnet/databases/default/canonical_beacon_block',
    ],
  },
  11155111: {
    chainId: 11155111,
    name: 'Sepolia',
    consensusRpcs: [
      'https://lodestar-sepolia.chainsafe.io',
      'https://ethereum-sepolia-beacon-api.publicnode.com',
    ],
    rpcs: [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://sepolia.drpc.org',
      'https://gateway.tenderly.co/public/sepolia',
      'https://rpc.sepolia.ethpandaops.io',
    ],
    rpcBatchSizes: {
      'https://ethereum-sepolia-rpc.publicnode.com': 200,
      'https://sepolia.drpc.org': 200,
      'https://gateway.tenderly.co/public/sepolia': 200,
      'https://rpc.sepolia.ethpandaops.io': 200,
    },
    checkpointUrls: [
      'https://checkpoint-sync.sepolia.ethpandaops.io',
      'https://beaconstate-sepolia.chainsafe.io',
    ],
    eraFileUrls: [
      'https://sepolia.era.nimbus.team',
    ],
    parquetUrls: [
      'https://data.ethpandaops.io/xatu/sepolia/databases/default/canonical_beacon_block',
    ],
  },
}

export interface WalletInfo {
  tabId: number
  title: string
  walletName: string
  url: string
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
  localMode?: boolean        // local execution RPC, no beacon proof
  portalVerified?: boolean   // verified via local Portal Network node
  beaconVerified?: boolean
  beaconHeliosAnchored?: boolean    // parentBeaconBlockRoot anchor resolved
  beaconEraVerified?: boolean       // historical_summaries era cross-check passed
  beaconStateHashVerified?: boolean // full hash_tree_root(BeaconState) computed locally
  ensVerified?: boolean | null      // true = confirmed; false = mismatch (possible forgery); null/undefined = unverified
  proof: {
    url: string
    blockNumber: number
    blockHash: string
    txHash: string
    txIndex: number
    contentType: string
    payloadSize: string
    // One entry per chunk (multi-chunk dapps) — the singular fields above describe
    // the last chunk; all chunks listed here were verified.
    chunks?: Array<{ blockNumber: number; txIndex: number; txHash: string }>
  }
}
