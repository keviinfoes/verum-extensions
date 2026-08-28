import { createHeliosProvider } from '@a16z/helios'
setTimeout(() => { console.log('WATCHDOG 120s'); process.exit(2) }, 120_000)

const EXEC = 'https://ethereum-rpc.publicnode.com'
const CONS_LIST = ['https://ethereum-beacon-api.publicnode.com','https://www.lightclientdata.org','https://lodestar-mainnet.chainsafe.io']
const SPE = 32
async function finalizedRoot(cons) {
  const res = await fetch(`${cons}/eth/v1/beacon/headers/finalized`)
  if (!res.ok) throw new Error('hdr '+res.status)
  const j = await res.json()
  const root = j?.data?.root, slot = Number(j?.data?.header?.message?.slot)
  if (!root) throw new Error('no root')
  if (!Number.isFinite(slot) || slot % SPE === 0) return root
  let b = slot - (slot % SPE)
  for (let i=0;i<8 && b>0;i++, b-=SPE){ const r=await fetch(`${cons}/eth/v1/beacon/headers/${b}`); if(!r.ok)continue; const jj=await r.json(); if(jj?.data?.root) return jj.data.root }
  return root
}
async function getCheckpoint() {
  for (const c of CONS_LIST) { try { const root = await finalizedRoot(c); return { cons:c, root } } catch(e){ console.log('cp err',c,e.message) } }
  throw new Error('no checkpoint from any consensus rpc')
}
try {
  const { cons, root } = await getCheckpoint()
  console.log('checkpoint', root, 'via', cons)
  const t0 = Date.now()
  const provider = await createHeliosProvider({ network:'mainnet', executionRpc:EXEC, consensusRpc:cons, dbType:'config', checkpoint:root }, 'ethereum')
  console.log('provider created, waiting synced…')
  await provider.waitSynced()
  console.log('SYNCED in', ((Date.now()-t0)/1000).toFixed(1),'s')
  const bn = await provider.request({ method:'eth_blockNumber', params:[] })
  console.log('blockNumber', parseInt(bn,16))
  const r = await provider.request({ method:'eth_call', params:[{ to:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', data:'0x18160ddd' }, 'latest'] })
  console.log('USDC totalSupply eth_call OK, result', r.slice(0,20)+'…')
  process.exit(0)
} catch (e) { console.log('ERROR', e?.stack || e?.message || e); process.exit(1) }
