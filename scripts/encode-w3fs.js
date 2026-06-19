#!/usr/bin/env node
// Encodes a file or directory into W3FS calldata and prints hex lines to stdout.
// Each line is one transaction's calldata (0x-prefixed hex).
//
// Single file:
//   node scripts/encode-w3fs.js <file> [content-type] [gzip|none]
//
// Multi-file bundle (entire directory):
//   node scripts/encode-w3fs.js --dir <directory>
//
// Bundle format (application/x-w3fs-bundle):
//   [4] file count (uint32 BE)
//   per file: [2] path len + path + [2] mime len + mime + [4] data len + data
//   The bundle is split into 100 KB raw chunks, each independently gzipped.

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import { createGzip } from 'zlib'

process.stdout.on('error', err => { if (err.code === 'EPIPE') process.exit(0) })

const MAGIC   = Buffer.from([0x57, 0x33, 0x46, 0x53]) // "W3FS"
const VERSION = 0x01
const COMPRESSION = { none: 0, gzip: 1, deflate: 2, brotli: 3 }
// Max calldata bytes per tx.
// Public RPCs (publicnode, drpc, etc.) cap raw tx size at 128KB — use 125_000.
// Paid RPCs (Alchemy, Infura) support up to Ethereum's actual limit (~1.8MB).
const MAX_CALLDATA = parseInt(process.env.MAX_CALLDATA ?? '125000')

// Files/dirs to skip when bundling a directory
const SKIP = new Set(['.DS_Store', '.git', '.gitignore', 'node_modules', 'Thumbs.db'])

// ---------------------------------------------------------------------------

if (process.argv[2] === '--dir') {
  const dir = process.argv[3]
  if (!dir) { console.error('Usage: node encode-w3fs.js --dir <path>'); process.exit(1) }
  if (statSync(dir).isDirectory()) {
    await encodeDirectory(dir)
  } else {
    await encodeSingleFile(dir, sniffType(dir), 'gzip')
  }
} else {
  const filePath    = process.argv[2]
  const contentType = process.argv[3] ?? sniffType(filePath)
  const compression = process.argv[4] ?? 'gzip'
  if (!filePath) {
    console.error('Usage: node encode-w3fs.js <file> [content-type] [gzip|none]')
    process.exit(1)
  }
  await encodeSingleFile(filePath, contentType, compression)
}

// ---------------------------------------------------------------------------

async function encodeSingleFile(filePath, contentType, compression) {
  const raw = readFileSync(filePath)
  const payload = compression === 'gzip' ? await gzipBuffer(raw) : raw
  const calldata = buildW3fsChunk(contentType, compression, 0, 1, payload)
  process.stdout.write('0x' + calldata.toString('hex') + '\n')
  console.error(`✓ encoded  ${raw.length} bytes → ${payload.length} bytes (${compression})`)
  console.error(`✓ calldata ${calldata.length} bytes  (${(calldata.length / 1024).toFixed(1)} KB)`)
  console.error(`  content-type: ${contentType}`)
}

async function encodeDirectory(dir) {
  const entries = collectFiles(dir)
  console.error(`Bundling ${entries.length} files from ${dir}:`)
  for (const e of entries) console.error(`  ${e.path}  (${e.data.length} bytes, ${e.mime})`)

  // Gzip the entire bundle in one pass for best compression ratio
  const bundle = buildBundleBinary(entries)
  console.error(`\nBundle size: ${bundle.length} bytes raw`)
  const compressed = await gzipBuffer(bundle)
  console.error(`Compressed:  ${compressed.length} bytes gzip (${(compressed.length / bundle.length * 100).toFixed(1)}%)`)

  // Split compressed output into ≤MAX_CALLDATA chunks (stored without re-compression)
  const totalChunks = Math.ceil(compressed.length / MAX_CALLDATA)
  console.error(`Chunks: ${totalChunks} transaction(s)`)

  for (let i = 0; i < totalChunks; i++) {
    const slice = compressed.slice(i * MAX_CALLDATA, (i + 1) * MAX_CALLDATA)
    // Store pre-compressed slices as 'none' — assembler concatenates then decompresses whole
    const calldata = buildW3fsChunk('application/x-w3fs-bundle', 'none', i, totalChunks, slice)
    process.stdout.write('0x' + calldata.toString('hex') + '\n')
    console.error(`  chunk ${i}: ${slice.length} bytes → ${calldata.length} bytes calldata`)
  }

  console.error(`\n✓ Done. Pipe to publish.js to deploy.`)
}

function buildBundleBinary(entries) {
  const parts = []
  const count = Buffer.alloc(4); count.writeUInt32BE(entries.length); parts.push(count)
  for (const { path, mime, data } of entries) {
    const pathBuf = Buffer.from(path, 'utf8')
    const pLen = Buffer.alloc(2); pLen.writeUInt16BE(pathBuf.length); parts.push(pLen, pathBuf)
    const mimeBuf = Buffer.from(mime, 'utf8')
    const mLen = Buffer.alloc(2); mLen.writeUInt16BE(mimeBuf.length); parts.push(mLen, mimeBuf)
    const dLen = Buffer.alloc(4); dLen.writeUInt32BE(data.length); parts.push(dLen, data)
  }
  return Buffer.concat(parts)
}

function collectFiles(dir, base = dir) {
  const results = []
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name) || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      results.push(...collectFiles(full, base))
    } else {
      const rel = relative(base, full).split(sep).join('/')
      results.push({ path: '/' + rel, mime: sniffType(name), data: readFileSync(full) })
    }
  }
  return results
}

function buildW3fsChunk(contentType, compression, chunkIndex, totalChunks, payload) {
  const ctBuf = Buffer.from(contentType, 'utf8')
  const ctLen = Buffer.alloc(2); ctLen.writeUInt16BE(ctBuf.length)
  const chunkIdx = Buffer.alloc(4); chunkIdx.writeUInt32BE(chunkIndex)
  const totalCh  = Buffer.alloc(4); totalCh.writeUInt32BE(totalChunks)
  return Buffer.concat([
    MAGIC,
    Buffer.from([VERSION]),
    ctLen, ctBuf,
    Buffer.from([COMPRESSION[compression] ?? 0]),
    chunkIdx,
    totalCh,
    payload,
  ])
}

async function gzipBuffer(buf) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const gz = createGzip({ level: 9 })
    gz.on('data', c => chunks.push(c))
    gz.on('end', () => resolve(Buffer.concat(chunks)))
    gz.on('error', reject)
    gz.end(buf)
  })
}

function sniffType(path) {
  if (path.endsWith('.html') || path.endsWith('.htm')) return 'text/html; charset=utf-8'
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'application/javascript'
  if (path.endsWith('.json'))  return 'application/json'
  if (path.endsWith('.css'))   return 'text/css'
  if (path.endsWith('.svg'))   return 'image/svg+xml'
  if (path.endsWith('.png'))   return 'image/png'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  if (path.endsWith('.gif'))   return 'image/gif'
  if (path.endsWith('.woff2')) return 'font/woff2'
  if (path.endsWith('.woff'))  return 'font/woff'
  return 'application/octet-stream'
}
