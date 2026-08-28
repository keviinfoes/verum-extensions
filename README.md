# Verum

Browser extension for browsing `w3://` pages stored on Ethereum, verified by Helios light client.

See [VERIFICATION.md](VERIFICATION.md) for the verification flows.

## Setup

```bash
npm install
```

## Build

```bash
npm run build 
```

## Load extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `dist/` folder

## Usage

### Visit a website
In the address bar, type `w3` + Tab, then enter:
- name: `.eth/.wei/.gwei`
- calldata source: `blockNumber:txIndex[+blockNumber:txIndex+...]`
- contract source: `0x`

### Deploy a website 

**From the extension:** click **⬆ Deploy** in the popup, follow deployment flow. Deploys as calldata.

---

Built with [Claude Code](https://claude.ai/code)