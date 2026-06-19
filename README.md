# web3

Browser extension for browsing `web3://` dapps stored as calldata on Ethereum, verified by Helios light client.

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

In the address bar, type `portal` + Tab, then enter a `portal://` URL or ENS name.

## Deploy a website to Ethereum

```bash
# Single file
node scripts/encode-w3fs.js scripts/hello-sepolia.html | PRIVATE_KEY=0x... node scripts/publish.js

# Set ENS text record after deploy
node scripts/set-ens.js
```
