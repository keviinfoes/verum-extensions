// Browser-side W3FS encoding — the in-extension counterpart of
// scripts/encode-w3fs.js, used by the Deploy page. Same layout and chunking
// rules as the CLI (only the gzip level differs — CompressionStream has no
// level knob), so content deployed from either path decodes identically:
//   single file  → gzip whole, one chunk (split into per-chunk-gzipped slices
//                  only when the compressed file exceeds MAX_CALLDATA)
//   directory    → binary bundle, gzipped once, split into 'none' slices that
//                  the assembler concatenates before decompressing
//
// See src/lib/w3/content.ts for the decoding side and the format layout.

import { W3FS_MAGIC } from '../../types.js'

// Fixed calldata deposit address — nobody holds the key to
// 0x…57334653 ("W3FS" magic bytes padded to 20 bytes).
export const W3FS_DEPOSIT = '0x0000000000000000000000000000000057334653'

// Max calldata bytes per tx. Public RPCs (publicnode, drpc, …) cap raw tx
// size at 128 KB — 125 000 payload bytes keeps the full tx under that.
export const MAX_CALLDATA = 125_000

// Raw slice size for oversized single files: gzip of an incompressible
// 110 000-byte slice stays well under MAX_CALLDATA (stored-block overhead
// is ~5 bytes per 64 KB plus an 18-byte gzip header).
const RAW_SLICE = 110_000

const VERSION = 0x01
const COMPRESSION: Record<string, number> = { none: 0, gzip: 1, deflate: 2, brotli: 3 }

export const BUNDLE_MIME = 'application/x-w3fs-bundle'

// Files/dirs skipped when bundling a directory (matches encode-w3fs.js)
const SKIP = new Set(['.DS_Store', '.git', '.gitignore', 'node_modules', 'Thumbs.db'])

export interface DeployFile {
  path: string       // "/index.html" — leading slash, relative to bundle root
  mime: string
  data: Uint8Array
}

// True when any path segment is junk (hidden files, node_modules, …).
export function isSkippedPath(relPath: string): boolean {
  return relPath.split('/').some(seg => SKIP.has(seg) || seg.startsWith('.'))
}

export async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  writer.write(data as Uint8Array<ArrayBuffer>)
  writer.close()
  const reader = cs.readable.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let pos = 0
  for (const c of chunks) { out.set(c, pos); pos += c.length }
  return out
}

export function buildW3fsChunk(
  contentType: string,
  compression: 'none' | 'gzip',
  chunkIndex: number,
  totalChunks: number,
  payload: Uint8Array,
): Uint8Array {
  const ctBuf = new TextEncoder().encode(contentType)
  const out = new Uint8Array(4 + 1 + 2 + ctBuf.length + 1 + 4 + 4 + payload.length)
  const view = new DataView(out.buffer)
  let off = 0
  view.setUint32(off, W3FS_MAGIC, false); off += 4
  out[off++] = VERSION
  view.setUint16(off, ctBuf.length, false); off += 2
  out.set(ctBuf, off); off += ctBuf.length
  out[off++] = COMPRESSION[compression]
  view.setUint32(off, chunkIndex, false); off += 4
  view.setUint32(off, totalChunks, false); off += 4
  out.set(payload, off)
  return out
}

// Binary file table: [4] count, per file [2] path len + path + [2] mime len +
// mime + [4] data len + data. Must match buildBundleBinary in encode-w3fs.js.
export function buildBundleBinary(files: DeployFile[]): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const count = new Uint8Array(4)
  new DataView(count.buffer).setUint32(0, files.length, false)
  parts.push(count)
  for (const f of files) {
    const pathBuf = enc.encode(f.path)
    const mimeBuf = enc.encode(f.mime)
    const head = new Uint8Array(2 + pathBuf.length + 2 + mimeBuf.length + 4)
    const view = new DataView(head.buffer)
    let off = 0
    view.setUint16(off, pathBuf.length, false); off += 2
    head.set(pathBuf, off); off += pathBuf.length
    view.setUint16(off, mimeBuf.length, false); off += 2
    head.set(mimeBuf, off); off += mimeBuf.length
    view.setUint32(off, f.data.length, false)
    parts.push(head, f.data)
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let pos = 0
  for (const p of parts) { out.set(p, pos); pos += p.length }
  return out
}

// Single file → one or more calldata chunks.
export async function encodeSingleFile(mime: string, data: Uint8Array): Promise<Uint8Array[]> {
  const compressed = await gzipBytes(data)
  if (compressed.length <= MAX_CALLDATA) {
    return [buildW3fsChunk(mime, 'gzip', 0, 1, compressed)]
  }
  // Oversized: split the RAW bytes and gzip each slice independently — the
  // assembler decompresses each chunk then concatenates.
  const total = Math.ceil(data.length / RAW_SLICE)
  const chunks: Uint8Array[] = []
  for (let i = 0; i < total; i++) {
    const gz = await gzipBytes(data.slice(i * RAW_SLICE, (i + 1) * RAW_SLICE))
    chunks.push(buildW3fsChunk(mime, 'gzip', i, total, gz))
  }
  return chunks
}

// Directory → bundle binary, gzipped once, split into 'none' slices.
export async function encodeBundle(files: DeployFile[]): Promise<{ chunks: Uint8Array[]; rawSize: number; compressedSize: number }> {
  const bundle = buildBundleBinary(files)
  const compressed = await gzipBytes(bundle)
  const total = Math.ceil(compressed.length / MAX_CALLDATA)
  const chunks: Uint8Array[] = []
  for (let i = 0; i < total; i++) {
    const slice = compressed.slice(i * MAX_CALLDATA, (i + 1) * MAX_CALLDATA)
    chunks.push(buildW3fsChunk(BUNDLE_MIME, 'none', i, total, slice))
  }
  return { chunks, rawSize: bundle.length, compressedSize: compressed.length }
}

// EIP-7623 (Pectra) calldata gas: max(standard, floor) + 21000 base + buffer.
// Same formula as scripts/publish.js — skips eth_estimateGas, which public
// RPCs reject for large request bodies.
export function txGasLimit(calldata: Uint8Array): bigint {
  let zeros = 0n, nonzeros = 0n
  for (const b of calldata) { if (b === 0) zeros++; else nonzeros++ }
  const standardDataGas = zeros * 4n + nonzeros * 16n
  const floorDataGas = (zeros * 1n + nonzeros * 4n) * 10n
  const dataGas = standardDataGas > floorDataGas ? standardDataGas : floorDataGas
  return 21000n + dataGas + 50000n
}

export function toHex(bytes: Uint8Array): string {
  let s = '0x'
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

// Same extension→mime table as encode-w3fs.js sniffType().
export function sniffType(path: string): string {
  const p = path.toLowerCase()
  if (p.endsWith('.html') || p.endsWith('.htm')) return 'text/html; charset=utf-8'
  if (p.endsWith('.js') || p.endsWith('.mjs'))   return 'application/javascript'
  if (p.endsWith('.json'))  return 'application/json'
  if (p.endsWith('.css'))   return 'text/css'
  if (p.endsWith('.pdf'))   return 'application/pdf'
  if (p.endsWith('.txt') || p.endsWith('.md') || p.endsWith('.toml') ||
      p.endsWith('.sh') || p.endsWith('.bash') || p.endsWith('.log') ||
      p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.py') ||
      p.endsWith('.rs') || p.endsWith('.go') || p.endsWith('.java') ||
      p.endsWith('.c') || p.endsWith('.cpp') || p.endsWith('.h') ||
      p.endsWith('.rb') || p.endsWith('.sql')) return 'text/plain; charset=utf-8'
  if (p.endsWith('.csv'))   return 'text/csv; charset=utf-8'
  if (p.endsWith('.xml'))   return 'text/xml; charset=utf-8'
  if (p.endsWith('.yaml') || p.endsWith('.yml')) return 'text/yaml; charset=utf-8'
  if (p.endsWith('.svg'))   return 'image/svg+xml'
  if (p.endsWith('.png'))   return 'image/png'
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg'
  if (p.endsWith('.gif'))   return 'image/gif'
  if (p.endsWith('.webp'))  return 'image/webp'
  if (p.endsWith('.avif'))  return 'image/avif'
  if (p.endsWith('.ico'))   return 'image/x-icon'
  if (p.endsWith('.bmp'))   return 'image/bmp'
  if (p.endsWith('.woff2')) return 'font/woff2'
  if (p.endsWith('.woff'))  return 'font/woff'
  return 'application/octet-stream'
}
