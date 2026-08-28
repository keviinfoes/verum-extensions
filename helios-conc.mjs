import { createHeliosProvider } from '@a16z/helios'
import { Interface, getAddress } from 'ethers'
setTimeout(() => { console.log('WATCHDOG 180s'); process.exit(2) }, 180_000)

const EXEC='https://ethereum-rpc.publicnode.com', CONS='https://ethereum-beacon-api.publicnode.com', SPE=32
async function finalizedRoot(cons){const res=await fetch(`${cons}/eth/v1/beacon/headers/finalized`);const j=await res.json();const root=j?.data?.root,slot=Number(j?.data?.header?.message?.slot);if(!root)throw new Error('no root');if(!Number.isFinite(slot)||slot%SPE===0)return root;let b=slot-(slot%SPE);for(let i=0;i<8&&b>0;i++,b-=SPE){const r=await fetch(`${cons}/eth/v1/beacon/headers/${b}`);if(!r.ok)continue;const jj=await r.json();if(jj?.data?.root)return jj.data.root}return root}

// heavy multicall: aggregate3 over ~24 ERC20 balanceOf(holder) → many contracts/slots
const MC3='0xcA11bde05977b3631167028862bE2a173976CA11'
const TOKENS=['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48','0xdAC17F958D2ee523a2206206994597C13D831ec7','0x6B175474E89094C44Da98b954EedeAC495271d0F','0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2','0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599','0x514910771AF9Ca656af840dff83E8264EcF986CA','0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984','0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9','0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2','0x4d224452801ACEd8B2F0aebE155379bb5D594381','0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e','0x6f259637dcD74C767781E37Bc6133cd6A68aa161']
const holder='0x28C6c06298d514Db089934071355E5743bf21d60'
const iface=new Interface(['function balanceOf(address) view returns (uint256)','function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])'])
const calls=[]; for(let i=0;i<24;i++){const t=TOKENS[i%TOKENS.length]; calls.push({target:getAddress(t),allowFailure:true,callData:iface.encodeFunctionData('balanceOf',[holder])})}
const DATA=iface.encodeFunctionData('aggregate3',[calls])

function isRecursive(e){return /recursive use of an object/i.test(String(e?.message||e))}

try{
  const root=await finalizedRoot(CONS)
  const provider=await createHeliosProvider({network:'mainnet',executionRpc:EXEC,consensusRpc:CONS,dbType:'config',checkpoint:root},'ethereum')
  await provider.waitSynced(); console.log('SYNCED')
  const heavy=()=>provider.request({method:'eth_call',params:[{to:MC3,data:DATA},'latest']})
  for(const K of [1,4,8,16,32]){
    const t0=Date.now()
    const res=await Promise.allSettled(Array.from({length:K},heavy))
    const rec=res.filter(r=>r.status==='rejected'&&isRecursive(r.reason)).length
    const otherErr=res.filter(r=>r.status==='rejected'&&!isRecursive(r.reason))
    const ok=res.filter(r=>r.status==='fulfilled').length
    console.log(`K=${K}: ok=${ok} recursive=${rec} otherErr=${otherErr.length} in ${((Date.now()-t0)/1000).toFixed(1)}s`)
    if(otherErr.length) console.log('   sample err:', String(otherErr[0].reason?.message||otherErr[0].reason).slice(0,120))
  }
  process.exit(0)
}catch(e){console.log('FATAL',e?.stack||e);process.exit(1)}
