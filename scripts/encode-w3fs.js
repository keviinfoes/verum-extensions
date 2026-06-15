#!/usr/bin/env node
// Encodes a file into W3FS calldata format and prints the hex to stdout.
// Usage:  node scripts/encode-w3fs.js <file> [content-type] [compression]
//
// Examples:
//   node scripts/encode-w3fs.js scripts/hello-sepolia.html
//   node scripts/encode-w3fs.js scripts/hello-sepolia.html text/html gzip

import { readFileSync } from 'fs'
import { createGzip } from 'zlib'
import { promisify } from 'util'
import { Readable } from 'stream'

const MAGIC = Buffer.from([0x57, 0x33, 0x46, 0x53]) // "W3FS"
const VERSION = 0x01

const COMPRESSION = { none: 0, gzip: 1, deflate: 2, brotli: 3 }

const filePath    = process.argv[2]
const contentType = process.argv[3] ?? sniffType(filePath)
const compression = process.argv[4] ?? 'gzip'

if (!filePath) {
  console.error('Usage: node encode-w3fs.js <file> [content-type] [gzip|none]')
  process.exit(1)
}

const raw = readFileSync(filePath)

const payload = compression === 'gzip'
  ? await gzipBuffer(raw)
  : raw

const ctBuf = Buffer.from(contentType, 'utf8')
const ctLen = Buffer.alloc(2)
ctLen.writeUInt16BE(ctBuf.length)

const header = Buffer.concat([
  MAGIC,
  Buffer.from([VERSION]),
  ctLen,
  ctBuf,
  Buffer.from([COMPRESSION[compression] ?? 0]),
  Buffer.alloc(4),   // chunk index 0
  Buffer.from([0, 0, 0, 1]), // total chunks 1
])

const calldata = Buffer.concat([header, payload])
const hex = '0x' + calldata.toString('hex')

process.stdout.write(hex + '\n')
console.error(`✓ encoded  ${raw.length} bytes → ${payload.length} bytes (${compression})`)
console.error(`✓ calldata ${calldata.length} bytes  (${(calldata.length / 1024).toFixed(1)} KB)`)
console.error(`  content-type: ${contentType}`)

// ---------------------------------------------------------------------------

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
  if (path.endsWith('.js'))   return 'application/javascript'
  if (path.endsWith('.json')) return 'application/json'
  if (path.endsWith('.css'))  return 'text/css'
  if (path.endsWith('.svg'))  return 'image/svg+xml'
  if (path.endsWith('.png'))  return 'image/png'
  return 'application/octet-stream'
}
