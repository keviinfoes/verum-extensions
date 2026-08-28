import { createHeliosProvider } from '@a16z/helios'
import { Interface, getAddress } from 'ethers'
setTimeout(()=>{console.log('WD');process.exit(2)},180000)
const EXEC='https://ethereum-rpc.publicnode.com', CONS='https://ethereum-beacon-api.publicnode.com', SPE=32
async function fr(c){const r=await fetch(`${c}/eth/v1/beacon/headers/finalized`);const j=await r.json();const root=j?.data?.root,s=Number(j?.data?.header?.message?.slot);if(s%SPE===0)return root;let b=s-(s%SPE);for(let i=0;i<8;i++,b-=SPE){const x=await fetch(`${c}/eth/v1/beacon/headers/${b}`);if(!x.ok)continue;const jj=await x.json();if(jj?.data?.root)return jj.data.root}return root}

const CFG={ batchACL:true, deferACL:false }
const BATCH={eth_getProof:{max:30,windowMs:10}, eth_createAccessList:{max:10,windowMs:15}}
const _f=globalThis.fetch.bind(globalThis)
const batches=new Map(); let counts={}
function flush(key){const b=batches.get(key);if(!b||!b.items.length)return;batches.delete(key);if(b.timer)clearTimeout(b.timer);const items=b.items,method=b.method;counts['BATCH_'+method+'['+items.length+']']=(counts['BATCH_'+method+'['+items.length+']']||0)+1;const body=JSON.stringify(items.map((it,i)=>({jsonrpc:'2.0',id:i,method:it.req.method,params:it.req.params})));_f(EXEC,{method:'POST',headers:{'Content-Type':'application/json'},body}).then(async res=>{let arr=null;try{const p=await res.json();if(Array.isArray(p)&&p.length===items.length)arr=p}catch{}const byId=arr?new Map(arr.map(r=>[Number(r.id),r])):null;const defer=method==='eth_createAccessList'&&CFG.deferACL;for(let i=0;i<items.length;i++){const sub=byId?.get(i);const payload=(sub&&'result'in sub&&sub.result!=null&&!sub.error)?{result:sub.result}:{error:sub?.error||{code:-32603,message:'miss'}};const resp=new Response(JSON.stringify({jsonrpc:'2.0',id:items[i].req.id,...payload}),{status:200,headers:{'Content-Type':'application/json'}});try{Object.defineProperty(resp,'url',{value:EXEC,configurable:true})}catch{}if(defer)setTimeout(((it,r)=>()=>it.resolve(r))(items[i],resp),0);else items[i].resolve(resp)}}).catch(e=>{for(const it of items)it.reject(e)})}
function enqueue(method,req){const key=method;return new Promise((resolve,reject)=>{let b=batches.get(key);if(!b){b={method,items:[],timer:null};batches.set(key,b)}b.items.push({req,resolve,reject});const cfg=BATCH[method];if(b.items.length>=cfg.max)flush(key);else if(!b.timer)b.timer=setTimeout(()=>flush(key),cfg.windowMs)})}
globalThis.fetch=async(input,init)=>{
  let url,bodyText
  if(input instanceof Request){url=input.url;try{bodyText=await input.clone().text()}catch{}}
  else{url=typeof input==='string'?input:String(input);bodyText=init?.body}
  if(url===EXEC&&bodyText){try{const j=JSON.parse(bodyText);if(!Array.isArray(j)&&j?.method){counts[j.method]=(counts[j.method]||0)+1;if(j.method==='eth_getProof')return enqueue('eth_getProof',{id:j.id,method:j.method,params:j.params});if(j.method==='eth_createAccessList'&&CFG.batchACL)return enqueue('eth_createAccessList',{id:j.id,method:j.method,params:j.params})}}catch{}}
  return _f(input,init)
}
const MC3='0xcA11bde05977b3631167028862bE2a173976CA11'
const TOK=['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48','0xdAC17F958D2ee523a2206206994597C13D831ec7','0x6B175474E89094C44Da98b954EedeAC495271d0F','0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2','0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599','0x514910771AF9Ca656af840dff83E8264EcF986CA']
const holder='0x28C6c06298d514Db089934071355E5743bf21d60'
const iface=new Interface(['function balanceOf(address) view returns (uint256)','function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool,bytes)[])'])
const calls=[];for(let i=0;i<30;i++)calls.push({target:getAddress(TOK[i%TOK.length]),allowFailure:true,callData:iface.encodeFunctionData('balanceOf',[holder])})
const DATA=iface.encodeFunctionData('aggregate3',[calls])
const isRec=e=>/recursive use of an object/i.test(String(e?.message||e))
try{
  const root=await fr(CONS)
  const p=await createHeliosProvider({network:'mainnet',executionRpc:EXEC,consensusRpc:CONS,dbType:'config',checkpoint:root},'ethereum')
  await p.waitSynced();console.log('SYNCED batchACL=',CFG.batchACL,'deferACL=',CFG.deferACL)
  const heavy=()=>p.request({method:'eth_call',params:[{to:MC3,data:DATA},'latest']})
  for(const K of [8,16,32]){counts={};const res=await Promise.allSettled(Array.from({length:K},heavy));const rec=res.filter(r=>r.status==='rejected'&&isRec(r.reason)).length;const oth=res.filter(r=>r.status==='rejected'&&!isRec(r.reason));console.log(`K=${K}: ok=${res.filter(r=>r.status==='fulfilled').length} RECURSIVE=${rec} otherErr=${oth.length} | fetch:`,JSON.stringify(counts));if(oth.length)console.log('   err:',String(oth[0].reason?.message||oth[0].reason).slice(0,80))}
  process.exit(0)
}catch(e){console.log('FATAL',isRec(e)?'RECURSIVE(top)':'',String(e?.message||e).slice(0,150));process.exit(1)}
