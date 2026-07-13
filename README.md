# web3

Browser extension for browsing `w3://` pages stored as calldata on Ethereum, verified by Helios light client.

See [VERIFICATION.md](VERIFICATION.md) for the full verification flow.

## Setup

```bash
npm install
```

## Build

```bash
npm run build       # one-time build
npm run dev         # watch mode
```

## Load extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `dist/` folder

## Usage

In the address bar, type `w3` + Tab, then enter a `ENS/GNS` name or `blockNumber:txIndex[+blockNumber:txIndex+...]`.

## Deploy a website to Ethereum

**From the extension:** click **⬆ Deploy** in the popup — deployment flow and with a live preview.

**From the CLI:**

```bash
# Deploy — <file> or --dir <directory> -> prints [[blockNumber, txIndex], ...] coordinates.
PRIVATE_KEY=0x... [RPC_URL=...] node scripts/encode-w3fs.js <file> | node scripts/publish.js
PRIVATE_KEY=0x... [RPC_URL=...] node scripts/encode-w3fs.js --dir <directory> | node scripts/publish.js

# Point an owned ENS (.eth) name at coordinates
node scripts/set-ens.js <name.eth> <rpc-url> <private-key> <block:idx> [<block:idx> ...]

# Point an owned GNS (.gwei) name at coordinates
node scripts/set-gns.js <name.gwei> <rpc-url> <private-key> <block:idx> [<block:idx> ...]
```
