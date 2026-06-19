type RenderMessage = {
  type: 'render'
  html: string
  assetMap?: Record<string, string>
}

type BridgeMessage = {
  type: 'eth-request' | 'eth-response'
  [key: string]: unknown
}

const frame = document.getElementById('frame') as HTMLIFrameElement

// Relay eth-request from the dapp iframe up to renderer.html, and eth-response
// back down from renderer.html into the dapp iframe.
window.addEventListener('message', (event: MessageEvent<BridgeMessage | RenderMessage>) => {
  if (!event.data) return

  if (event.data.type === 'eth-request' && event.source === frame.contentWindow) {
    window.parent.postMessage(event.data, '*')
  }

  if (event.data.type === 'eth-response' && event.source === window.parent) {
    frame.contentWindow?.postMessage(event.data, '*')
  }

  if (event.data.type === 'wallet-event' && event.source === window.parent) {
    frame.contentWindow?.postMessage(event.data, '*')
  }
})

// Polyfills injected before any dApp code runs.
// The iframe intentionally has an opaque sandbox origin so the manifest sandbox
// can allow inline dapp scripts. Storage APIs are shimmed before app code runs.
const LS_POLYFILL = '<scr' + 'ipt>(function(){' +
  'function MS(){var s={};return{' +
    'get length(){return Object.keys(s).length},' +
    'key:function(i){return Object.keys(s)[i]||null},' +
    'getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(s,k)?s[k]:null},' +
    'setItem:function(k,v){s[String(k)]=String(v)},' +
    'removeItem:function(k){delete s[String(k)]},' +
    'clear:function(){s={}}' +
  '}}' +
  'try{Object.defineProperty(window,"localStorage",{value:MS(),configurable:true});}catch(e){}' +
  'try{Object.defineProperty(window,"sessionStorage",{value:MS(),configurable:true});}catch(e){}' +
  // URL constructor patch: srcdoc iframes have location.href="about:srcdoc",
  // which is not a valid base for relative URL resolution.
  'var _U=window.URL;' +
  'function PU(u,b){' +
    'if(!b||b==="about:srcdoc"||b===location.href)b="https://dapp.w3fs/";' +
    'return new _U(u,b);' +
  '}' +
  'PU.createObjectURL=_U.createObjectURL.bind(_U);' +
  'PU.revokeObjectURL=_U.revokeObjectURL.bind(_U);' +
  'if(_U.canParse)PU.canParse=_U.canParse.bind(_U);' +
  'try{window.URL=PU;}catch(e){}' +
  // window.ethereum stub: relays EIP-1193 calls to parent.
  'var _cbs={};' +
  'window.ethereum={' +
    'isMetaMask:true,isConnected:function(){return true;},' +
    '_handlers:{},' +
    'request:function(a){' +
      'return new Promise(function(res,rej){' +
        'var id=(Math.random()*1e17).toString(36);' +
        '_cbs[id]={res:res,rej:rej};' +
        'window.parent.postMessage({type:"eth-request",id:id,method:a.method,params:a.params||[]},"*");' +
      '});' +
    '},' +
    'enable:function(){return this.request({method:"eth_requestAccounts",params:[]});},' +
    'send:function(m,p){if(typeof m==="string")return this.request({method:m,params:p||[]});return this.request(m);},' +
    'sendAsync:function(m,cb){this.request(m).then(function(r){cb(null,{id:m.id,jsonrpc:"2.0",result:r})}).catch(function(e){cb(e,null)});},' +
    'on:function(e,fn){this._handlers[e]=this._handlers[e]||[];this._handlers[e].push(fn);},' +
    'removeListener:function(e,fn){var h=this._handlers[e];if(h)this._handlers[e]=h.filter(function(x){return x!==fn;});},' +
    'emit:function(e,d){(this._handlers[e]||[]).forEach(function(fn){fn(d);});}' +
  '};' +
  'window.addEventListener("message",function(e){' +
    'if(!e.data)return;' +
    'if(e.data.type==="eth-response"){' +
      'var cb=_cbs[e.data.id];if(!cb)return;' +
      'delete _cbs[e.data.id];' +
      'if(e.data.error)cb.rej(new Error(e.data.error));else cb.res(e.data.result);' +
      'return;' +
    '}' +
    'if(e.data.type==="wallet-event"){' +
      'var p=e.data.params;' +
      'var d=(Array.isArray(p)&&Array.isArray(p[0]))?p[0]:p;' +
      'window.ethereum.emit(e.data.method,d);' +
    '}' +
  '});' +
  // External link interceptor: open http/https links in a new browser tab.
  'document.addEventListener("click",function(e){' +
    'var a=e.target.closest("a");if(!a||!a.href)return;' +
    'try{var u=new URL(a.href);' +
      'if(u.hostname==="dapp.w3fs")return;' +
      'if(u.protocol==="http:"||u.protocol==="https:"){' +
        'e.preventDefault();window.open(a.href,"_blank");' +
      '}' +
    '}catch(ex){}' +
  '},true);' +
'})();<\/scr' + 'ipt>'

// Asset map polyfill: intercept img.src assignments made by JS and replace
// https://dapp.w3fs/* URLs with pre-built data: URIs from the bundle.
function makeAssetPolyfill(assetMap: Record<string, string>) {
  if (!Object.keys(assetMap).length) return ''
  const mapJson = JSON.stringify(assetMap)
  return '<scr' + 'ipt>(function(m){' +
    'function fix(n){' +
      'if(!n)return;' +
      'if(n.nodeType===1&&n.tagName==="IMG"&&m[n.src])n.src=m[n.src];' +
      'if(n.querySelectorAll){var imgs=n.querySelectorAll("img");for(var i=0;i<imgs.length;i++)fix(imgs[i]);}' +
    '}' +
    'new MutationObserver(function(muts){' +
      'for(var i=0;i<muts.length;i++){' +
        'var mut=muts[i];' +
        'if(mut.type==="childList"){for(var j=0;j<mut.addedNodes.length;j++)fix(mut.addedNodes[j]);}' +
        'else if(mut.type==="attributes"&&mut.target.tagName==="IMG")fix(mut.target);' +
      '}' +
    '}).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:["src"]});' +
  '})(' + mapJson + ');<\/scr' + 'ipt>'
}

window.addEventListener('message', (event: MessageEvent<RenderMessage>) => {
  if (!event.data || event.data.type !== 'render') return

  let html = event.data.html
  const assetPolyfill = makeAssetPolyfill(event.data.assetMap || {})

  // Strip crossorigin attributes: extension-origin CORS requests are rejected by
  // servers that do not allowlist chrome-extension:// origins.
  html = html.replace(/\s+crossorigin(?:=["'][^"']*["'])?/gi, '')

  const inject = LS_POLYFILL + assetPolyfill
  html = html.indexOf('<head>') !== -1
    ? html.replace('<head>', '<head>' + inject)
    : inject + html

  frame.srcdoc = html
})
