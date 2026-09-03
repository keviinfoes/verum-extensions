// Flags when our pinned @a16z/helios drifts from the latest published version.
// Helios' WASM is bundled at build time, so a new release (especially around an
// Ethereum fork) means we must bump + rebuild + ship. Run: `npm run check:helios`.
// Exits 1 when out of date so CI fails and notifies.

import { readFile } from 'node:fs/promises'

const PKG = '@a16z/helios'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const current = (pkg.dependencies?.[PKG] ?? '').replace(/^[\^~>=<\s]*/, '')
if (!current) {
  console.error(`✗ ${PKG} not found in package.json dependencies`)
  process.exit(2)
}

let latest
try {
  const res = await fetch(`https://registry.npmjs.org/${PKG}/latest`)
  if (!res.ok) throw new Error(`registry HTTP ${res.status}`)
  latest = (await res.json()).version
} catch (e) {
  console.error(`✗ Could not reach npm registry: ${e.message}`)
  process.exit(2)
}

if (current === latest) {
  console.log(`✓ ${PKG} is up to date (${current})`)
  process.exit(0)
}

console.error(
  `✗ ${PKG} is behind: pinned ${current}, latest ${latest}\n` +
  `  A new Helios release may add fork support or fixes. Bump it:\n` +
  `    npm install ${PKG}@${latest}\n` +
  `  then rebuild and ship a new extension version.\n` +
  `  Release notes: https://github.com/a16z/helios/releases`,
)
process.exit(1)
