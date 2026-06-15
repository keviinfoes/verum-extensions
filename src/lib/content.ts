// W3FS calldata content format:
//   [4]  magic: 0x57334653 ("W3FS")
//   [1]  version
//   [2]  content-type length (big-endian)
//   [N]  content-type string (UTF-8)
//   [1]  compression: 0=none 1=gzip 2=deflate 3=brotli
//   [4]  chunk index (big-endian, 0-based)
//   [4]  total chunks (big-endian)
//   [*]  payload bytes

import type { ContentChunk, Compression } from '../types.js'
import { W3FS_MAGIC } from '../types.js'

export function parseCalldata(data: Uint8Array): ContentChunk {
  if (data.length < 16) throw new Error('Calldata too short to be W3FS content')

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const magic = view.getUint32(0, false)
  if (magic !== W3FS_MAGIC) {
    throw new Error(
      `Not a W3FS payload (magic: 0x${magic.toString(16).toUpperCase()}, expected 0x57334653)`,
    )
  }

  let offset = 4
  const version = data[offset++]

  const ctLen = view.getUint16(offset, false)
  offset += 2
  const contentType = new TextDecoder().decode(data.slice(offset, offset + ctLen))
  offset += ctLen

  const compressionByte = data[offset++]
  const compressionMap: Compression[] = ['none', 'gzip', 'deflate', 'brotli']
  const compression: Compression = compressionMap[compressionByte] ?? 'none'

  const chunkIndex = view.getUint32(offset, false)
  offset += 4
  const totalChunks = view.getUint32(offset, false)
  offset += 4

  const payload = data.slice(offset)

  return { version, contentType, compression, chunkIndex, totalChunks, data: payload }
}

export async function decompressChunk(chunk: ContentChunk): Promise<Uint8Array> {
  if (chunk.compression === 'none') return chunk.data

  if (chunk.compression === 'brotli') {
    // Brotli via DecompressionStream is available in Chrome 123+
    // Fall back to error if not available
    if (!('DecompressionStream' in globalThis)) {
      throw new Error('DecompressionStream not available')
    }
    // Try the 'br' format (Chrome ≥ 123)
    try {
      return await runDecompressionStream(chunk.data, 'br' as CompressionFormat)
    } catch {
      throw new Error('Brotli decompression not supported in this browser version')
    }
  }

  const format: CompressionFormat = chunk.compression === 'gzip' ? 'gzip' : 'deflate'
  return runDecompressionStream(chunk.data, format)
}

async function runDecompressionStream(
  data: Uint8Array,
  format: CompressionFormat,
): Promise<Uint8Array> {
  const ds = new DecompressionStream(format)
  const writer = ds.writable.getWriter()
  const reader = ds.readable.getReader()

  writer.write(data)
  writer.close()

  const chunks: Uint8Array[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    chunks.push(value)
  }

  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let pos = 0
  for (const c of chunks) {
    out.set(c, pos)
    pos += c.length
  }
  return out
}

// Assemble multiple chunks (sorted by chunkIndex) into final content bytes
export async function assembleContent(
  chunks: ContentChunk[],
): Promise<{ data: Uint8Array; contentType: string }> {
  if (chunks.length === 0) throw new Error('No chunks to assemble')

  const sorted = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)
  const expected = sorted[0].totalChunks

  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].chunkIndex !== i) {
      throw new Error(`Missing chunk ${i} (have ${sorted.map((c) => c.chunkIndex).join(',')})`)
    }
  }
  if (sorted.length !== expected) {
    throw new Error(`Expected ${expected} chunks, got ${sorted.length}`)
  }

  const decompressed = await Promise.all(sorted.map(decompressChunk))

  const total = decompressed.reduce((n, c) => n + c.length, 0)
  const assembled = new Uint8Array(total)
  let pos = 0
  for (const c of decompressed) {
    assembled.set(c, pos)
    pos += c.length
  }

  return { data: assembled, contentType: sorted[0].contentType }
}

// Sniff the content type from bytes when not specified
export function sniffContentType(data: Uint8Array): string {
  const sig4 = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]

  // HTML
  if (startsWith(data, '<!DO') || startsWith(data, '<htm') || startsWith(data, '<HTM')) {
    return 'text/html'
  }
  // JSON
  if (data[0] === 0x7b || data[0] === 0x5b) return 'application/json'
  // PNG
  if (sig4 === 0x89504e47) return 'image/png'
  // JPEG
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
  // GIF
  if (startsWith(data, 'GIF8')) return 'image/gif'
  // JS
  if (startsWith(data, '(fun') || startsWith(data, '"use') || startsWith(data, "'use")) {
    return 'application/javascript'
  }

  return 'text/plain'
}

function startsWith(data: Uint8Array, prefix: string): boolean {
  for (let i = 0; i < prefix.length; i++) {
    if (data[i] !== prefix.charCodeAt(i)) return false
  }
  return true
}
