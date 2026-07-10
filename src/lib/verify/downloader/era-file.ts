// Era block_roots via .era files (nimbus.team era servers): two targeted HTTP
// range requests extract just the block_roots vector from a compressed
// BeaconState, without downloading the full multi-hundred-MB file. Includes a
// hand-rolled snappy decompressor (raw block + framing format) since era files
// use raw-snappy-compressed SSZ, which no browser API or small dependency covers.

import { computeEraBlockSummaryRoot, readU32LE, fetchWithTimeout } from '../beacon-primitives.js'

// Era file servers — serve .era files with HTTP range support.
// Format: {network}-{era:05d}-{hash:8hex}.era, directory listing at server root.
const ERA_SERVERS: Record<number, { baseUrl: string; network: string }[]> = {
  1:        [{ baseUrl: 'https://mainnet.era.nimbus.team', network: 'mainnet' }],
  11155111: [{ baseUrl: 'https://sepolia.era.nimbus.team', network: 'sepolia' }],
  17000:    [{ baseUrl: 'https://holesky.era.nimbus.team', network: 'holesky' }],
}

const CHAIN_NETWORK: Record<number, string> = {
  1: 'mainnet', 11155111: 'sepolia', 17000: 'holesky',
}
// Tail fetch: covers the full BlockIndex record (≤8192*8+24 = 65,560 B) + state entry header (8 B).
const ERA_TAIL_FETCH  = 70_000
// State fetch: last block (~≤200 KB compressed) + state header (8 B) + first N bytes of state data.
// block_roots start at SSZ byte 176, end at byte 262320 — snappy ratio ~1.5–2× → need ~400–500 KB compressed.
const ERA_STATE_FETCH = 700_000

// Raw snappy block decompressor (no framing). maxOut limits allocation — avoids OOM
// when the full uncompressed size (encoded in preamble varint) is hundreds of MB.
function snappyDecompressBlock(src: Uint8Array, maxOut?: number): Uint8Array {
  let s = 0
  let uLen = 0, shift = 0
  while (s < src.length) {
    const b = src[s++]
    uLen |= (b & 0x7f) << shift
    if (!(b & 0x80)) break
    shift += 7
  }
  const limit = maxOut !== undefined ? Math.min(uLen, maxOut) : uLen
  const dst = new Uint8Array(limit)
  let d = 0
  while (s < src.length && d < limit) {
    const tag = src[s++]
    switch (tag & 0x3) {
      case 0: { // literal
        const f = tag >> 2
        let len: number
        if (f < 60)        { len = f + 1 }
        else if (f === 60) { len = src[s++] + 1 }
        else if (f === 61) { len = (src[s] | (src[s + 1] << 8)) + 1; s += 2 }
        else if (f === 62) { len = (src[s] | (src[s + 1] << 8) | (src[s + 2] << 16)) + 1; s += 3 }
        else               { len = (src[s] | (src[s + 1] << 8) | (src[s + 2] << 16) | (src[s + 3] << 24)) + 1; s += 4 }
        const copy = Math.min(len, limit - d)
        dst.set(src.subarray(s, s + copy), d)
        s += len; d += copy; break
      }
      case 1: { // copy 1-byte offset  (len in [4,11], offset 11-bit)
        const len = ((tag >> 2) & 0x7) + 4
        const off = ((tag >> 5) << 8) | src[s++]
        const n = Math.min(len, limit - d)
        for (let i = 0; i < n; i++) dst[d + i] = dst[d - off + i]
        d += n; break
      }
      case 2: { // copy 2-byte offset
        const len = ((tag >> 2) & 0x3f) + 1
        const off = src[s] | (src[s + 1] << 8); s += 2
        const n = Math.min(len, limit - d)
        for (let i = 0; i < n; i++) dst[d + i] = dst[d - off + i]
        d += n; break
      }
      case 3: { // copy 4-byte offset
        const len = ((tag >> 2) & 0x3f) + 1
        const off = src[s] | (src[s + 1] << 8) | (src[s + 2] << 16) | (src[s + 3] << 24); s += 4
        const n = Math.min(len, limit - d)
        for (let i = 0; i < n; i++) dst[d + i] = dst[d - off + i]
        d += n; break
      }
    }
  }
  return dst
}

// Snappy framing-format decompressor. Stops once `need` uncompressed bytes are produced.
// Frame format: type(1) + length(3 LE) + [crc32c(4) +] payload
function snappyFramedDecompress(data: Uint8Array, need: number): Uint8Array {
  const out = new Uint8Array(need)
  let pos = 0, s = 0
  while (s + 4 <= data.length && pos < need) {
    const chunkType = data[s]
    const chunkLen  = readU24LE(data, s + 1)
    s += 4
    if (s + chunkLen > data.length) break  // incomplete chunk — stop here
    if (chunkType === 0xff) {
      // stream identifier — skip ("sNaPpY")
    } else if (chunkType === 0x00 && chunkLen > 4) {
      // compressed data: skip 4-byte masked CRC, then raw snappy block
      const block = snappyDecompressBlock(data.subarray(s + 4, s + chunkLen))
      const n = Math.min(block.length, need - pos)
      out.set(block.subarray(0, n), pos); pos += n
    } else if (chunkType === 0x01 && chunkLen > 4) {
      // uncompressed data: skip 4-byte masked CRC
      const n = Math.min(chunkLen - 4, need - pos)
      out.set(data.subarray(s + 4, s + 4 + n), pos); pos += n
    }
    // 0xfe = padding, 0x80-0xfd = skippable — just skip
    s += chunkLen
  }
  return out
}

function readU24LE(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16)
}

// Era filename convention: {network}-{era:05d}-{hash:8hex}.era
// The 8-char hash comes from a server-specific derivation we don't fully control, so we
// first try the directory listing to find the exact filename, then fall back to the
// block_summary_root-derived guess (first 4 bytes of the root).
async function findEraFileUrls(era: number, chainId: number, blockSummaryRoot: string, customEraUrls?: string[]): Promise<string[]> {
  const network = CHAIN_NETWORK[chainId] ?? 'mainnet'
  // Use configured URLs when provided; fall back to built-in defaults only when undefined.
  const servers = customEraUrls !== undefined
    ? customEraUrls.map(baseUrl => ({ baseUrl: baseUrl.replace(/\/$/, ''), network }))
    : (ERA_SERVERS[chainId] ?? [])
  const eraStr = era.toString().padStart(5, '0')
  const urls: string[] = []

  for (const { baseUrl, network } of servers) {
    // Primary: directory listing gives the exact filename
    try {
      const res = await fetchWithTimeout(baseUrl + '/', {}, 8000)
      if (res.ok) {
        const html = await res.text()
        const m = html.match(new RegExp(`${network}-${eraStr}-[0-9a-f]{8}\\.era`, 'i'))
        if (m) { urls.push(`${baseUrl}/${m[0]}`); continue }
      }
    } catch { /* fall through to guess */ }
    // Fallback: derive hash from block_summary_root (first 4 bytes)
    urls.push(`${baseUrl}/${network}-${eraStr}-${blockSummaryRoot.slice(2, 10)}.era`)
  }

  return urls
}

// e2store entry type code used in era files
const E2S_STATE = 0x0002  // bytes [0x02,0x00] → LE uint16 = 0x0002

// SSZ layout of BeaconState (fixed fields before block_roots):
//   genesis_time(8) + genesis_validators_root(32) + slot(8) + fork(16) +
//   latest_block_header(112) = 176 bytes, then block_roots Vector[Root,8192] = 262144 bytes
const BLOCK_ROOTS_SSZ_OFFSET = 176
const BLOCK_ROOTS_SSZ_LEN    = 8192 * 32  // 262144

// Signed int64 LE → JS number. Safe for any value < 2^53 (i.e. any file ≤ 8 PB).
function readI64LE(buf: Uint8Array, off: number): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return Number(dv.getBigInt64(off, true))
}

// Single era HTTP range fetch. Returns buf + file size (from Content-Range); null on failure.
async function eraFetch(
  url: string, range: string, ms: number,
): Promise<{ buf: Uint8Array; fileSize: number } | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const r = await fetch(url, { headers: { Range: range }, signal: ctrl.signal })
    if (!r.ok && r.status !== 206) return null
    const m = r.headers.get('Content-Range')?.match(/bytes \d+-\d+\/(\d+)/)
    const fileSize = m ? parseInt(m[1]) : 0
    const buf = new Uint8Array(await r.arrayBuffer())
    return { buf, fileSize }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchEraBlockRootsFromEraFile(
  era: number,
  chainId: number,
  expectedBlockSummaryRoot: string,
  customEraUrls?: string[],
): Promise<Uint8Array[] | null> {
  const urls = await findEraFileUrls(era, chainId, expectedBlockSummaryRoot, customEraUrls)
  if (!urls.length) return null

  for (const url of urls) {
    try {
      const roots = await tryEraUrl(url, era, expectedBlockSummaryRoot)
      if (roots) return roots
    } catch (e) {
      console.warn(`[w3] Era ${era}: ${url} → ${(e as Error).message}`)
    }
  }
  return null
}

// Uses two targeted range requests to extract block_roots from an era file:
//   1. Tail (≤70 KB) → read BlockIndex → locate last block's absolute file offset
//   2. From last block header (≤700 KB) → skip block data → read state entry → decompress
async function tryEraUrl(
  url: string, era: number, expectedBlockSummaryRoot: string,
): Promise<Uint8Array[] | null> {
  // ── Step 1: tail fetch to locate state entry ────────────────────────────────
  // Era file layout: [Version][Blocks era N-1][BeaconState][BlockIndex era N-1][StateRef era N]
  // The LAST record is a 1-entry index (type 0x3269, count=1) whose single offset points
  // to the BeaconState.  All offsets use the convention:
  //   offset[j] = (dataAbsPos + 8) − offsetFieldAbsPos   (signed, relative to field)
  // So:  stateDataAbsPos  = offsetFieldAbsPos + offsetVal − 8
  //      stateHeaderAbsPos = stateDataAbsPos − 8  (the 8-byte e2store header)
  console.log(`[w3] Era ${era}: tail fetch (${ERA_TAIL_FETCH >> 10}KB) from ${url}`)
  const tail = await eraFetch(url, `bytes=-${ERA_TAIL_FETCH}`, 30_000)
  if (!tail) { console.warn(`[w3] Era ${era}: tail fetch failed`); return null }
  const { buf: tailBuf, fileSize } = tail
  if (!fileSize) { console.warn(`[w3] Era ${era}: no Content-Range, cannot locate state`); return null }

  // The last 8 bytes of the file = count field of the trailing StateRef record (always 1 per era)
  const count = readU32LE(tailBuf, tailBuf.length - 8)
  if (count === 0 || count > 8192) {
    console.warn(`[w3] Era ${era}: invalid tail count ${count}`); return null
  }
  // StateRef record = 8 (e2store header) + 8 (start_slot) + count×8 (offsets) + 8 (count)
  const stateRefRecordSize = count * 8 + 24
  const srTailStart = tailBuf.length - stateRefRecordSize

  // Parse offset[0] — points to (stateDataAbsPos + 8), relative to its own file position
  const srDataStart   = srTailStart + 8              // past e2store header
  const offsetInTail  = srDataStart + 8              // past start_slot
  const offsetVal     = readI64LE(tailBuf, offsetInTail)
  const offsetAbsPos  = (fileSize - tailBuf.length) + offsetInTail
  const stateHeaderAbsPos = offsetAbsPos + offsetVal - 16  // = dataAbsPos + 8 − 8 − 8

  if (stateHeaderAbsPos <= 0 || stateHeaderAbsPos >= fileSize) {
    console.warn(`[w3] Era ${era}: bad stateHeaderAbsPos=${stateHeaderAbsPos}`); return null
  }
  console.log(`[w3] Era ${era}: count=${count} stateHeaderAbsPos=${stateHeaderAbsPos}`)

  // ── Step 2: fetch state entry (header + compressed data) ─────────────────────
  const fetchEnd = Math.min(stateHeaderAbsPos + ERA_STATE_FETCH - 1, fileSize - 1)
  console.log(`[w3] Era ${era}: state fetch bytes ${stateHeaderAbsPos}–${fetchEnd}`)
  const sf = await eraFetch(url, `bytes=${stateHeaderAbsPos}-${fetchEnd}`, 120_000)
  if (!sf) { console.warn(`[w3] Era ${era}: state fetch failed`); return null }
  const stateBuf = sf.buf

  // Parse state e2store header (8 bytes: type(2) + length(6))
  if (stateBuf.length < 8) { console.warn(`[w3] Era ${era}: state fetch too small`); return null }
  const stateType = stateBuf[0] | (stateBuf[1] << 8)
  if (stateType !== E2S_STATE) {
    const hex16 = Array.from(stateBuf.subarray(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')
    console.warn(`[w3] Era ${era}: expected state (0x${E2S_STATE.toString(16)}), got 0x${stateType.toString(16)} — first 16B: ${hex16}`)
    return null
  }
  const stateDataLen = readU32LE(stateBuf, 2)
  const stateData    = stateBuf.subarray(8)
  console.log(`[w3] Era ${era}: state compressed=${stateDataLen}B fetched ${stateData.length}B`)

  // ── Step 3: decompress and extract block_roots ───────────────────────────────
  const need = BLOCK_ROOTS_SSZ_OFFSET + BLOCK_ROOTS_SSZ_LEN  // 262320 bytes

  const isFramed = stateData.length >= 6 &&
    stateData[0] === 0xff && stateData[1] === 0x06 &&
    stateData[2] === 0x00 && stateData[3] === 0x00 &&
    stateData[4] === 0x73 && stateData[5] === 0x4e

  const stateSSZ = isFramed
    ? snappyFramedDecompress(stateData, need)
    : snappyDecompressBlock(stateData, need)

  if (stateSSZ.length < need) {
    console.warn(`[w3] Era ${era}: decompressed ${stateSSZ.length}/${need}B — increase ERA_STATE_FETCH?`); return null
  }

  const roots: Uint8Array[] = []
  for (let i = 0; i < 8192; i++) {
    const off = BLOCK_ROOTS_SSZ_OFFSET + i * 32
    roots.push(stateSSZ.slice(off, off + 32))
  }

  const computed = computeEraBlockSummaryRoot(roots)
  if (computed.toLowerCase() !== expectedBlockSummaryRoot.toLowerCase()) {
    console.warn(`[w3] Era ${era}: block_summary_root mismatch: computed=${computed} expected=${expectedBlockSummaryRoot}`); return null
  }

  console.log(`[w3] Era ${era}: block_roots verified via era file ✓ (stateCompressed=${stateDataLen}B)`)
  return roots
}
