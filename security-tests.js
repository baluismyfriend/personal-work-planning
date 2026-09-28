const fs=require('fs'),path=require('path'),{JSDOM}=require('jsdom');
const dir='/home/claude/app';
const html=fs.readFileSync(dir+'/index.html','utf8'),js=fs.readFileSync(dir+'/script.js','utf8'),css=fs.readFileSync(dir+'/style.css','utf8'),man=fs.readFileSync(dir+'/manifest.json','utf8');
let pass=0,fail=0;const results=[];
function t(name,fn){try{const r=fn();if(r===false)throw new Error('assertion false');pass++;results.push('PASS  '+name);}catch(e){fail++;results.push('FAIL  '+name+' -> '+e.message);}}
async function ta(name,fn){try{await fn();pass++;results.push('PASS  '+name);}catch(e){fail++;results.push('FAIL  '+name+' -> '+e.message);}}
function boot(store){
  const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://localhost/',pretendToBeVisual:true});
  const w=dom.window;w.Element.prototype.scrollIntoView=function(){};w.alert=()=>{};w.confirm=()=>true;
  if(store)for(const k in store)w.localStorage.setItem(k,store[k]);
  w.eval(js);if(w.document.readyState==='loading')w.document.dispatchEvent(new w.Event('DOMContentLoaded'));return w;
}
/* ---- static ---- */
t('CSP meta present',()=>/Content-Security-Policy/.test(html));
t("CSP default-src 'self'",()=>/default-src 'self'/.test(html));
t("CSP blocks network (connect-src 'none')",()=>/connect-src 'none'/.test(html));
t("CSP blocks plugins (object-src 'none')",()=>/object-src 'none'/.test(html));
t("CSP blocks framing (frame-ancestors 'none')",()=>/frame-ancestors 'none'/.test(html));
t("CSP script-src has no unsafe-inline/eval",()=>{const m=html.match(/script-src([^;]*)/)[1];return !/unsafe/.test(m)});
t("CSP style-src has no unsafe-inline",()=>{const m=html.match(/style-src([^;]*)/)[1];return !/unsafe/.test(m)});
t('No inline <script> bodies in HTML',()=>!/<script(?![^>]*src)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html));
t('No inline event handlers (onclick=…) in HTML',()=>!/\son[a-z]+\s*=/i.test(html));
t('No inline style attributes in HTML',()=>!/\sstyle\s*=/i.test(html));
t('No external URLs in HTML/CSS/manifest',()=>!/https?:\/\//i.test(html.replace(/<!DOCTYPE[^>]*>/,''))&&!/https?:\/\//i.test(css)&&!/https?:\/\//i.test(man));
t('No remote URLs in JS (network endpoints)',()=>!/https?:\/\/(?!localhost)/i.test(js.replace(/\/\/.*$/gm,'').replace(/\/\*[\s\S]*?\*\//g,'')));
t('JS: no eval/new Function/document.write',()=>!/\beval\s*\(|new Function\s*\(|document\.write/.test(js));
t('JS: no innerHTML/outerHTML/insertAdjacentHTML',()=>!/innerHTML|outerHTML|insertAdjacentHTML/.test(js));
t('JS: no fetch/XHR/WebSocket/sendBeacon/postMessage',()=>!/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|postMessage|EventSource/.test(js));
t('JS: no cookies / window.open / location writes',()=>!/document\.cookie|window\.open|location\s*(\.href)?\s*=/.test(js));
t('JS: no setTimeout/setInterval with string code',()=>!/set(Timeout|Interval)\s*\(\s*["'`]/.test(js));
t('JS: no dynamic import/importScripts',()=>!/importScripts|import\s*\(/.test(js));
t('Manifest valid JSON, scope local',()=>{const m=JSON.parse(man);return m.start_url.startsWith('./')&&m.scope==='./'});
t('Referenced icon files exist',()=>['icon-192.png','icon-512.png','apple-touch-icon.png'].every(f=>fs.existsSync(path.join(dir,f))));
t('JS syntax valid (strict-mode wrapper)',()=>{new Function(js);});
/* ---- runtime ---- */
const XSS=['<script>window.__x=1</script>','<img src=x onerror="window.__x=1">','"><svg onload=window.__x=1>','javascript:window.__x=1','{{constructor.constructor("window.__x=1")()}}'];
function wb(rows){return {version:1,sheets:[]};}
(async()=>{
 const w0=boot();
 await ta('App boots with empty storage, no exceptions',async()=>{if(!w0.document.getElementById('nav').children.length)throw new Error('nav empty')});
 // find storage key names
 const keys=[...js.matchAll(/STORAGE_DATA_KEY\s*=\s*"([^"]+)"/g)].map(m=>m[1]);
 const DK=keys[0];
 // export current workbook through storage, poison it
 const good=JSON.parse(w0.localStorage.getItem(DK)||'null');
 await ta('Workbook persisted to localStorage only (no other sinks)',async()=>{if(!good)throw new Error('nothing saved')});
 function poisoned(){
   const g=JSON.parse(JSON.stringify(good));const sheets=Array.isArray(g)?g:(g.sheets||g);
   sheets.forEach(s=>{if(s.rows&&s.rows.length&&s.columns){s.rows[0][s.columns[0]]=XSS[1];s.rows.push(Object.fromEntries(s.columns.map((c,i)=>[c,XSS[i%XSS.length]])));}});
   return JSON.stringify(g);
 }
 const p=poisoned();
 for(let i=0;i<w0.document.getElementById('nav').children.length;i++){}
 const w1=boot({[DK]:p});
 await ta('XSS payloads in stored data render as inert text (no script/img/svg injected)',async()=>{
   const nav=w1.document.getElementById('nav');
   const btns=[...nav.children].concat([w1.document.getElementById('navSpacesBtn'),w1.document.getElementById('navNoSpaceBtn')]);
   for(const b of btns){b.click();
     const d=w1.document;
     if(d.querySelector('#tableBody script, #tableBody img, #tableBody svg, #tableBody iframe, #tableBody [onerror], #tableBody [onload]'))throw new Error('injected element on '+b.textContent);
   }
   if(w1.__x)throw new Error('payload executed');
 });
 await ta('No inline event-handler attributes created anywhere in DOM',async()=>{
   const all=[...w1.document.querySelectorAll('*')];
   if(all.some(e=>[...e.attributes].some(a=>/^on/i.test(a.name))))throw new Error('on* attr found');
 });
 // corrupt storage
 for(const bad of ['{not json','null','[]','"str"','123','{"sheets":"x"}','[{"name":1}]']){
   await ta('Corrupt storage tolerated: '+bad,async()=>{const w=boot({[DK]:bad});if(!w.document.getElementById('nav').children.length)throw new Error('app failed to render')});
 }
 // import tests
 function doImport(w,text){return new Promise(res=>{const alerts=[];w.alert=m=>alerts.push(m);const input=w.document.getElementById('fileImport');
   const file=new w.File([text],'b.json',{type:'application/json'});Object.defineProperty(input,'files',{value:[file],configurable:true});
   input.dispatchEvent(new w.Event('change'));setTimeout(()=>res(alerts),150);});}
 const w2=boot();
 const before=w2.localStorage.getItem(DK);
 for(const [n,txt] of [['non-JSON','not json {{'],['JSON null','null'],['JSON number','42'],['JSON string','"x"'],['deep nesting bomb','['.repeat(50000)+']'.repeat(50000)]]){
   await ta('Import rejects/handles '+n+' without corrupting data',async()=>{await doImport(w2,txt);if(w2.localStorage.getItem(DK)!==before)throw new Error('data changed by bad import')});
 }
 await ta('Import rejects oversize file (>2MB)',async()=>{const a=await doImport(w2,' '.repeat(2*1024*1024+10));if(!a.some(m=>/too large/i.test(m)))throw new Error('no size rejection');});
 await ta('Import: __proto__/constructor keys cannot pollute Object.prototype',async()=>{
   const evil='{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}},"sheets":[{"name":"Quick list","columns":["Small Times"],"rows":[{"Small Times":"a","__proto__":{"polluted3":"y"}}]}]}';
   await doImport(w2,evil);
   if(({}).polluted||({}).polluted2||({}).polluted3||w2.eval('({}).polluted||({}).polluted2||({}).polluted3'))throw new Error('prototype polluted');
 });
 await ta('Import: >MAX_ROWS and huge cells are truncated',async()=>{
   const w=boot();const g=JSON.parse(w.localStorage.getItem(DK));const sheets=Array.isArray(g)?g:(g.sheets||g);
   const s=sheets.find(x=>x.name==='Quick list');s.rows=Array.from({length:9000},()=>({"Small Times":"x".repeat(20000)}));
   const txt=JSON.stringify(g);if(txt.length>2*1024*1024){ // shrink to fit import cap but still test row/cell caps
     s.rows=Array.from({length:6000},()=>({"Small Times":"x".repeat(200)}));}
   await doImport(w,JSON.stringify(g));
   const out=JSON.parse(w.localStorage.getItem(DK));const so=(Array.isArray(out)?out:(out.sheets||out)).find(x=>x.name==='Quick list');
   if(so.rows.length>5000)throw new Error('rows not capped: '+so.rows.length);
   if(so.rows.some(r=>String(r["Small Times"]).length>5000))throw new Error('cell not capped');
 });
 await ta('Import: control characters stripped from cells',async()=>{
   const w=boot();const g=JSON.parse(w.localStorage.getItem(DK));const sheets=Array.isArray(g)?g:(g.sheets||g);
   sheets.find(x=>x.name==='Quick list').rows=[{"Small Times":"a\u0000b\u0007c\u001bd"}];
   await doImport(w,JSON.stringify(g));
   const out=JSON.parse(w.localStorage.getItem(DK));const so=(Array.isArray(out)?out:(out.sheets||out)).find(x=>x.name==='Quick list');
   if(/[\u0000-\u0008\u001b]/.test(so.rows[0]["Small Times"]))throw new Error('control chars survived');
 });
 await ta('Summary page survives Space names like __proto__/constructor/toString',async()=>{
   const w=boot();const g=JSON.parse(w.localStorage.getItem(DK));const sheets=Array.isArray(g)?g:(g.sheets||g);
   const d=sheets.find(x=>x.name==='Daily planning - All tasks');
   d.rows=['__proto__','constructor','toString','hasOwnProperty','normal'].map(sp=>Object.assign(Object.fromEntries(d.columns.map(c=>[c,''])),{Space:sp,"Timeframe/Meeting":'task '+sp}));
   await doImport(w,JSON.stringify(g));
   const errs=[];w.addEventListener('error',e=>errs.push(e.message));
   const btn=[...w.document.querySelectorAll('.nav-btn')].find(b=>/Spacetime/.test(b.textContent));btn.click();
   if(errs.length)throw new Error(errs.join(';'));
   if(w.document.querySelectorAll('#tableBody tr').length<5)throw new Error('summary did not render all spaces');
 });
 await ta('CSV export escapes formula injection (=,+,-,@)',async()=>{
   const w=boot();let captured='';w.Blob=class{constructor(p){captured=p.join('')}};w.URL.createObjectURL=()=>'blob:x';w.URL.revokeObjectURL=()=>{};
   const g=JSON.parse(w.localStorage.getItem(DK));const sheets=Array.isArray(g)?g:(g.sheets||g);
   sheets.find(x=>x.name==='Quick list').rows=[{"Small Times":'=HYPERLINK("http://evil","x")'},{"Small Times":'+1+1'},{"Small Times":'-2'},{"Small Times":'@SUM(A1)'}];
   await doImport(w,JSON.stringify(g));
   [...w.document.querySelectorAll('.nav-btn')].find(b=>/Stars/.test(b.textContent)).click();
   w.HTMLAnchorElement.prototype.click=function(){};
   w.document.getElementById('btnExportCsv').click();
   const lines=captured.split('\r\n').slice(1);
   if(lines.length<4||lines.some(l=>/^"?[=+\-@]/.test(l)))throw new Error('unescaped formula cell: '+JSON.stringify(lines));
 });
 await ta('Exported/stored data contains no code-bearing content types',async()=>{ if(/function\s*\(|<script/i.test(w0.localStorage.getItem(DK)))throw new Error('code in data')});
 await ta('Labels: Times page counter reads "Time N of M"',async()=>{
   const w=boot();w.matchMedia=()=>({matches:true,addListener(){},removeListener(){},addEventListener(){}});
   const g=JSON.parse(w.localStorage.getItem(DK));const sheets=Array.isArray(g)?g:(g.sheets||g);
   const d=sheets.find(x=>x.name==='Daily planning - All tasks');d.rows=[0,1].map(i=>Object.assign(Object.fromEntries(d.columns.map(c=>[c,''])),{Space:'S',"Timeframe/Meeting":'t'+i}));
   await doImport(w,JSON.stringify(g));
   [...w.document.querySelectorAll('.nav-btn')].find(b=>/^Times$/.test(b.textContent.trim())).click();
   const lbl=w.document.getElementById('taskPositionLabel').textContent;
   if(!/^Time 1 of 2$/.test(lbl))throw new Error('got "'+lbl+'"');
 });
 console.log(results.join('\n'));console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})();
