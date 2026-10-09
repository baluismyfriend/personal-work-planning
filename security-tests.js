/*
 * Security + regression tests for "Participant - Spaces & Time".
 *
 * Run (from this folder):   npm i jsdom   &&   node security-tests.js
 * Or point at another copy: APP_DIR=/path/to/app node security-tests.js
 *
 * Notes
 *  - Tests run in jsdom, NOT in real Safari. jsdom does not enforce CSP, so CSP
 *    checks are static (the policy text is inspected), not behavioural.
 *  - boot() waits for the app's init() to run exactly once, so the tests
 *    exercise the real start-up path.
 */
const fs = require('fs'), path = require('path');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) { console.error('jsdom missing. Run: npm i jsdom'); process.exit(2); }

const dir = process.env.APP_DIR || __dirname;
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'script.js'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');
const man = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');

const DK = 'workPlanningFinal.v2.data';
const FK = 'workPlanningFinal.v2.filters';
const WK = 'workPlanningFinal.v2.safeManualColumnWidths';

let pass = 0, fail = 0; const results = [];
function t(name, fn) { try { const r = fn(); if (r === false) throw new Error('assertion false'); pass++; results.push('PASS  ' + name); } catch (e) { fail++; results.push('FAIL  ' + name + ' -> ' + e.message); } }
async function ta(name, fn) { try { await fn(); pass++; results.push('PASS  ' + name); } catch (e) { fail++; results.push('FAIL  ' + name + ' -> ' + e.message); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- harness ---------- */
async function boot(store) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/', pretendToBeVisual: true });
  const w = dom.window;
  w.Element.prototype.scrollIntoView = function () {};
  w.alert = () => {}; w.confirm = () => true;
  w.__errs = []; w.addEventListener('error', e => w.__errs.push(e.message));
  if (store) for (const k in store) w.localStorage.setItem(k, store[k]);
  w.eval(js);
  await new Promise(r => {
    if (w.document.readyState === 'loading') w.document.addEventListener('DOMContentLoaded', () => setTimeout(r, 15));
    else setTimeout(r, 15);
  });
  return w;
}
function doImport(w, text, waitMs) {
  return new Promise(res => {
    const alerts = []; const prev = w.alert; w.alert = m => alerts.push(m);
    const input = w.document.getElementById('fileImport');
    const file = new w.File([text], 'b.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new w.Event('change'));
    setTimeout(() => { w.alert = prev; res(alerts); }, waitMs || 60);
  });
}
const wbOf = w => JSON.parse(w.localStorage.getItem(DK));
const sheetOf = (g, n) => g.find(x => x.name === n);
const navBtns = w => [...w.document.querySelectorAll('.nav-btn')];
const clickNav = (w, re) => { const b = navBtns(w).find(x => re.test(x.textContent.trim())); if (!b) throw new Error('nav not found ' + re); b.click(); return b; };
const protoNames = w => JSON.stringify(w.eval('Object.getOwnPropertyNames(Object.prototype).sort()'));
function captureBlobs(w) { const cap = []; w.Blob = class { constructor(p) { cap.push(p.join('')); } }; w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {}; w.HTMLAnchorElement.prototype.click = function () {}; return cap; }
function defineKey(o, k, v) { Object.defineProperty(o, k, { value: v, enumerable: true, configurable: true, writable: true }); }

/* =====================  STATIC CHECKS  ===================== */
t('CSP meta present', () => /Content-Security-Policy/.test(html));
t("CSP default-src 'self'", () => /default-src 'self'/.test(html));
t("CSP blocks network (connect-src 'none')", () => /connect-src 'none'/.test(html));
t("CSP blocks plugins (object-src 'none')", () => /object-src 'none'/.test(html));
t("CSP blocks nested frames/media/fonts (frame-src, media-src, font-src 'none')", () => /frame-src 'none'/.test(html) && /media-src 'none'/.test(html) && /font-src 'none'/.test(html));
t("CSP base-uri and form-action 'none'", () => /base-uri 'none'/.test(html) && /form-action 'none'/.test(html));
t('CSP script-src has no unsafe-inline/eval', () => { const m = html.match(/script-src([^;]*)/)[1]; return !/unsafe/.test(m); });
t('CSP style-src has no unsafe-inline', () => { const m = html.match(/style-src([^;]*)/)[1]; return !/unsafe/.test(m); });
t('CSP does not rely on frame-ancestors in <meta> (browsers ignore it there)', () => !/frame-ancestors/.test(html.match(/Content-Security-Policy"[^>]*>/)[0]));
t('Referrer policy set to no-referrer', () => /<meta name="referrer" content="no-referrer">/.test(html));
t('Frame-busting code present in script.js', () => /window\.top\s*!==\s*window\.self/.test(js) && /replaceChildren\(\)/.test(js));
t('No inline <script> bodies in HTML', () => !/<script(?![^>]*src)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html));
t('No inline event handlers (onclick=…) in HTML', () => !/\son[a-z]+\s*=/i.test(html));
t('No inline style attributes in HTML', () => !/\sstyle\s*=/i.test(html));
t('No external URLs in HTML/CSS/manifest', () => !/https?:\/\//i.test(html.replace(/<!DOCTYPE[^>]*>/, '')) && !/https?:\/\//i.test(css) && !/https?:\/\//i.test(man));
t('CSS has no url()/@import/expression()', () => !/url\s*\(|@import|expression\s*\(/i.test(css));
t('No remote URLs in JS (network endpoints)', () => !/https?:\/\/(?!localhost)/i.test(js.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
t('JS: no eval/new Function/document.write', () => !/\beval\s*\(|new Function\s*\(|document\.write/.test(js));
t('JS: no innerHTML/outerHTML/insertAdjacentHTML', () => !/innerHTML|outerHTML|insertAdjacentHTML/.test(js));
t('JS: no fetch/XHR/WebSocket/sendBeacon/postMessage', () => !/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|postMessage|EventSource/.test(js));
t('JS: no cookies / window.open / location writes', () => !/document\.cookie|window\.open|location\s*(\.href)?\s*=/.test(js));
t('JS: no setTimeout/setInterval with string code', () => !/set(Timeout|Interval)\s*\(\s*["'`]/.test(js));
t('JS: no dynamic import/importScripts', () => !/importScripts|import\s*\(/.test(js));
t('JS: no inline-style attribute writes (cssText / setAttribute("style"))', () => !/cssText|setAttribute\(\s*["']style["']/.test(js));
t('JS: no plain-object maps keyed by page names (filters/sortState/widths/taskIndex)', () =>
  !/var\s+(filters|manualWidths|sortState|currentTaskIndexBySheet)\s*=\s*\{\}/.test(js));
t('Manifest valid JSON, scope local', () => { const m = JSON.parse(man); return m.start_url.startsWith('./') && m.scope === './'; });
t('Referenced icon files exist', () => ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png'].every(f => fs.existsSync(path.join(dir, f))));
t('Icons are valid PNGs with no metadata chunks (no EXIF/GPS/text leakage)', () => {
  for (const f of ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
    const d = fs.readFileSync(path.join(dir, f)); if (d.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(f + ' not PNG');
    let p = 8; const bad = [];
    while (p < d.length) { const len = d.readUInt32BE(p); const type = d.slice(p + 4, p + 8).toString(); if (['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type)) bad.push(type); p += 12 + len; }
    if (bad.length) throw new Error(f + ' has ' + bad.join(','));
  } return true;
});
t('JS syntax valid (strict-mode wrapper)', () => { new Function(js); });

/* =====================  RUNTIME CHECKS  ===================== */
const XSS = ['<script>window.__x=1</script>', '<img src=x onerror="window.__x=1">', '"><svg onload=window.__x=1>', 'javascript:window.__x=1', '{{constructor.constructor("window.__x=1")()}}'];

(async () => {
  const w0 = await boot();
  await ta('App boots with empty storage, no exceptions', async () => { if (!w0.document.getElementById('nav').children.length) throw new Error('nav empty'); if (w0.__errs.length) throw new Error(w0.__errs[0]); });
  const good = wbOf(w0);
  await ta('Workbook persisted to localStorage only (no other sinks)', async () => { if (!good) throw new Error('nothing saved'); });

  function poisoned() {
    const g = JSON.parse(JSON.stringify(good));
    g.forEach(s => { if (s.rows && s.rows.length && s.columns) { s.rows[0][s.columns[0]] = XSS[1]; s.rows.push(Object.fromEntries(s.columns.map((c, i) => [c, XSS[i % XSS.length]]))); } });
    return JSON.stringify(g);
  }
  const w1 = await boot({ [DK]: poisoned() });
  await ta('XSS payloads in stored data render as inert text (no script/img/svg injected)', async () => {
    for (const b of navBtns(w1)) {
      b.click();
      if (w1.document.querySelector('#tableBody script, #tableBody img, #tableBody svg, #tableBody iframe, #tableBody [onerror], #tableBody [onload]')) throw new Error('injected element on ' + b.textContent);
    }
    if (w1.__x) throw new Error('payload executed');
  });
  await ta('No inline event-handler attributes created anywhere in DOM', async () => {
    if ([...w1.document.querySelectorAll('*')].some(e => [...e.attributes].some(a => /^on/i.test(a.name)))) throw new Error('on* attr found');
  });

  for (const bad of ['{not json', 'null', '[]', '"str"', '123', '{"sheets":"x"}', '[{"name":1}]']) {
    await ta('Corrupt storage tolerated: ' + bad, async () => { const w = await boot({ [DK]: bad }); if (!w.document.getElementById('nav').children.length) throw new Error('app failed to render'); });
  }

  /* ---- import hardening ---- */
  const w2 = await boot();
  const before = w2.localStorage.getItem(DK);
  for (const [n, txt] of [['non-JSON', 'not json {{'], ['JSON null', 'null'], ['JSON number', '42'], ['JSON string', '"x"'], ['JSON object root', '{"sheets":[]}'], ['deep nesting bomb', '['.repeat(50000) + ']'.repeat(50000)]]) {
    await ta('Import rejects/handles ' + n + ' without corrupting data', async () => { await doImport(w2, txt); if (w2.localStorage.getItem(DK) !== before) throw new Error('data changed by bad import'); });
  }
  await ta('Import rejects oversize file (>2MB)', async () => { const a = await doImport(w2, ' '.repeat(2 * 1024 * 1024 + 10)); if (!a.some(m => /too large/i.test(m))) throw new Error('no size rejection'); });
  await ta('Import: >MAX_ROWS and huge cells are truncated', async () => {
    const w = await boot(); const g = wbOf(w); const s = sheetOf(g, 'Quick list');
    s.rows = Array.from({ length: 6000 }, () => ({ 'Small Times': 'x'.repeat(200) }));
    s.rows[0]['Small Times'] = 'y'.repeat(20000);
    await doImport(w, JSON.stringify(g), 250);
    const so = sheetOf(wbOf(w), 'Quick list');
    if (so.rows.length > 5000) throw new Error('rows not capped: ' + so.rows.length);
    if (so.rows.some(r => String(r['Small Times']).length > 5000)) throw new Error('cell not capped');
  });
  await ta('Import: control characters stripped from cells', async () => {
    const w = await boot(); const g = wbOf(w); sheetOf(g, 'Quick list').rows = [{ 'Small Times': 'a\u0000b\u0007c\u001bd' }];
    await doImport(w, JSON.stringify(g));
    if (/[\u0000-\u0008\u001b]/.test(sheetOf(wbOf(w), 'Quick list').rows[0]['Small Times'])) throw new Error('control chars survived');
  });
  await ta('Import: bidi override/isolate characters stripped (text-spoofing)', async () => {
    const w = await boot(); const g = wbOf(w); sheetOf(g, 'Quick list').rows = [{ 'Small Times': 'pay \u202Eevil\u202C \u2066x\u2069' }];
    await doImport(w, JSON.stringify(g));
    const v = sheetOf(wbOf(w), 'Quick list').rows[0]['Small Times'];
    if (/[\u202A-\u202E\u2066-\u2069]/.test(v)) throw new Error('bidi controls survived: ' + JSON.stringify(v));
  });

  /* ---- prototype pollution (real, array-rooted payloads) ---- */
  await ta('Import: __proto__/constructor KEYS inside rows cannot pollute Object.prototype', async () => {
    const w = await boot(); const base = protoNames(w);
    const g = wbOf(w); const q = sheetOf(g, 'Quick list'); q.rows = [{ 'Small Times': 'a' }];
    const evilRow = { 'Small Times': 'a' }; defineKey(evilRow, '__proto__', { polluted3: 'y' }); defineKey(evilRow, 'constructor', { prototype: { polluted4: 'y' } });
    q.rows.push(evilRow);
    const gen = { name: 'Custom', columns: ['A', '__proto__', 'constructor', 'prototype', 'toString', 'ok'], rows: [evilRow] };
    g.push(gen);
    await doImport(w, JSON.stringify(g));
    for (const b of navBtns(w)) b.click();
    if (protoNames(w) !== base) throw new Error('Object.prototype changed');
    if (w.eval('({}).polluted3||({}).polluted4')) throw new Error('polluted');
    const c = sheetOf(wbOf(w), 'Custom');
    if (c.columns.some(x => ['__proto__', 'constructor', 'prototype'].includes(x))) throw new Error('reserved column kept');
    if (/function|native code/.test(JSON.stringify(c.rows))) throw new Error('inherited function leaked into cell');
  });
  for (const nm of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf']) {
    await ta('Page named "' + nm + '": no prototype pollution, no crash, label is the plain name, CSV export works', async () => {
      const w = await boot(); const base = protoNames(w);
      const g = wbOf(w); g.push({ name: nm, columns: ['polluted_col', 'Space'], rows: [{ polluted_col: 'x', Space: 'q' }] });
      await doImport(w, JSON.stringify(g));
      const btn = navBtns(w).find(b => b.textContent === nm);
      if (!btn) throw new Error('nav label is not the page name: ' + JSON.stringify(navBtns(w).map(b => b.textContent)));
      btn.click();
      const th = w.document.querySelector('#tableHead th'); th.click(); th.click();
      const s = w.document.querySelector('.filter-search'); s.value = 'q'; s.dispatchEvent(new w.Event('input'));
      const sel = w.document.querySelector('.filter-select'); sel.dispatchEvent(new w.Event('change'));
      captureBlobs(w); w.document.getElementById('btnExportCsv').click();
      for (const b of navBtns(w)) b.click();
      if (protoNames(w) !== base || w.eval('({}).polluted_col!==undefined')) throw new Error('Object.prototype polluted');
      if (w.__errs.length) throw new Error(w.__errs[0]);
    });
  }
  await ta('Cell values like "__proto__" appear in the filter dropdown (no silent loss)', async () => {
    const w = await boot(); const g = wbOf(w); sheetOf(g, 'Quick list').rows = [{ 'Small Times': '__proto__' }, { 'Small Times': 'constructor' }];
    await doImport(w, JSON.stringify(g)); clickNav(w, /^Stars$/);
    const opts = [...w.document.querySelectorAll('.filter-select option')].map(o => o.value);
    if (!opts.includes('__proto__') || !opts.includes('constructor')) throw new Error(JSON.stringify(opts));
  });

  /* ---- structural limits ---- */
  await ta('Import: page flood capped (3000 extra pages -> bounded nav)', async () => {
    const w = await boot(); const g = wbOf(w); for (let i = 0; i < 3000; i++) g.push({ name: 'S' + i, columns: ['A'], rows: [] });
    await doImport(w, JSON.stringify(g), 150);
    const n = navBtns(w).length; if (n > 20) throw new Error('nav buttons: ' + n);
  });
  await ta('Import: column flood capped (20000 columns -> <=30)', async () => {
    const w = await boot(); const g = wbOf(w); g.push({ name: 'Wide', columns: Array.from({ length: 20000 }, (_, i) => 'c' + i), rows: [] });
    await doImport(w, JSON.stringify(g), 150);
    const c = sheetOf(wbOf(w), 'Wide'); if (!c || c.columns.length > 30) throw new Error('columns: ' + (c && c.columns.length));
  });
  await ta('Import: duplicate page names collapse to one', async () => {
    const w = await boot(); const g = wbOf(w); const q = sheetOf(g, 'Quick list'); g.push(JSON.parse(JSON.stringify(q)), JSON.parse(JSON.stringify(q)));
    await doImport(w, JSON.stringify(g));
    if (wbOf(w).filter(s => s.name === 'Quick list').length !== 1) throw new Error('duplicates kept');
  });
  await ta('Import: Quick list with foreign schema is normalised to ["Small Times"]', async () => {
    const w = await boot(); const g = wbOf(w).filter(s => s.name !== 'Quick list'); g.push({ name: 'Quick list', columns: ['Whatever', 'Else'], rows: [{ Whatever: 'a' }] });
    await doImport(w, JSON.stringify(g));
    const q = sheetOf(wbOf(w), 'Quick list'); if (q.columns.length !== 1 || q.columns[0] !== 'Small Times') throw new Error(JSON.stringify(q.columns));
  });

  /* ---- tampered localStorage (other same-origin pages / corruption) ---- */
  const names = good.map(s => s.name);
  const cols = ['Space', 'Time', 'Key milestones', 'Small Times', 'Date/Day', 'Timeframes', 'Timeframe/Meeting', 'Demand', 'Timing'];
  for (const bad of [{ text: 5, select: {} }, null, 'str', { text: { toString: 1 }, select: 1 }, { text: [], select: [] }, 7]) {
    await ta('Tampered filter value ' + JSON.stringify(bad) + ' does not break rendering on any page', async () => {
      const f = {}; names.forEach(n => { f[n] = {}; cols.forEach(c => { f[n][c] = bad; }); });
      const w = await boot({ [FK]: JSON.stringify(f) });
      for (const b of navBtns(w)) { b.click(); if (!w.document.querySelectorAll('#tableHead th').length) throw new Error('head not rendered on ' + b.textContent); }
      if (w.__errs.length) throw new Error(w.__errs[0]);
    });
  }
  await ta('Tampered filters with non-object roots are ignored', async () => { for (const v of ['[]', '"x"', '5', 'null', '{"__proto__":{"text":"x"}}']) { const w = await boot({ [FK]: v }); if (w.__errs.length) throw new Error(v + ': ' + w.__errs[0]); } });
  await ta('Tampered column widths are clamped to 60..2000px or ignored', async () => {
    const wd = {}; names.forEach(n => ['Space', 'Key milestones', 'Life began', 'Life Ends', 'Life span', '__Actions__', 'Time'].forEach((c, i) => { wd[n + '|' + c] = [99999999, -5, 'url(javascript:1)', '1px; background:red', 1e308, null, 0][i]; }));
    const w = await boot({ [WK]: JSON.stringify(wd) });
    for (const b of navBtns(w)) { b.click(); [...w.document.querySelectorAll('#colgroup col')].forEach(c => { const m = /^(\d+)px$/.exec(c.style.width); if (m && (+m[1] < 60 || +m[1] > 2000)) throw new Error('width out of range ' + c.style.width); }); }
    if (w.__errs.length) throw new Error(w.__errs[0]);
  });
  await ta('Tampered selected-sheet index tolerated', async () => { for (const v of ['-1', '9999', 'abc', '1e9', '__proto__']) { const w = await boot({ 'workPlanningFinal.v2.selectedSheet': v }); if (!w.document.getElementById('nav').children.length || w.__errs.length) throw new Error(v); } });

  /* ---- editing surface ---- */
  await ta('Storage quota failure is surfaced to the user (not silent), once per failure streak', async () => {
    const w = await boot(); const alerts = []; w.alert = m => alerts.push(m);
    const orig = w.Storage.prototype.setItem; w.Storage.prototype.setItem = function (k, v) { if (k === DK) throw new w.DOMException('quota', 'QuotaExceededError'); return orig.call(this, k, v); };
    clickNav(w, /^Stars$/);
    const btn = w.document.getElementById('btnAddRowFloating'); btn.click(); btn.click(); btn.click();
    await sleep(40);
    if (alerts.length !== 1 || !/NOT be saved|could NOT/i.test(alerts[0])) throw new Error('alerts=' + alerts.length);
  });
  await ta('Dropped content (rich HTML) is blocked in editable cells', async () => {
    const w = await boot(); clickNav(w, /^Stars$/);
    const cell = w.document.querySelector('.cell-editable');
    const ev = new w.Event('drop', { cancelable: true, bubbles: true }); ev.dataTransfer = { getData: () => '<img src=x onerror=1>', types: ['text/html'] };
    cell.dispatchEvent(ev); if (!ev.defaultPrevented) throw new Error('drop not prevented');
    for (const it of ['insertFromDrop', 'formatBold', 'formatItalic', 'insertFromPasteAsQuotation']) {
      const be = new w.InputEvent('beforeinput', { inputType: it, cancelable: true, bubbles: true }); cell.dispatchEvent(be);
      if (!be.defaultPrevented) throw new Error(it + ' not prevented');
    }
    const ok = new w.InputEvent('beforeinput', { inputType: 'insertText', data: 'a', cancelable: true, bubbles: true }); cell.dispatchEvent(ok);
    if (ok.defaultPrevented) throw new Error('normal typing blocked');
    const ok2 = new w.InputEvent('beforeinput', { inputType: 'insertReplacementText', data: 'a', cancelable: true, bubbles: true }); cell.dispatchEvent(ok2);
    if (ok2.defaultPrevented) throw new Error('iOS autocorrect/replacement blocked');
  });
  await ta('Paste inserts literal plain text only (no elements created)', async () => {
    const w = await boot(); clickNav(w, /^Stars$/);
    const cell = w.document.querySelector('.cell-editable'); cell.focus();
    const r = w.document.createRange(); r.selectNodeContents(cell); r.collapse(false); const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    const ev = new w.Event('paste', { cancelable: true, bubbles: true }); ev.clipboardData = { getData: () => '<b>bold</b><img src=x onerror=1>' };
    cell.dispatchEvent(ev);
    if (!ev.defaultPrevented) throw new Error('paste default not prevented');
    if (cell.querySelector('b,img')) throw new Error('element created');
    cell.dispatchEvent(new w.Event('blur'));
    const stored = sheetOf(wbOf(w), 'Quick list').rows[0]['Small Times'];
    if (stored !== '<b>bold</b><img src=x onerror=1>') throw new Error('stored=' + JSON.stringify(stored));
  });
  await ta('"+ Add" keyboard helper uses a CSS class, not inline style', async () => {
    const w = await boot(); clickNav(w, /^Stars$/); w.document.getElementById('btnAddRowFloating').click();
    const h = w.document.querySelector('input[aria-hidden="true"]'); if (!h) throw new Error('helper not found'); if (h.getAttribute('style')) throw new Error('inline style present'); if (!h.classList.contains('kb-helper')) throw new Error('no class');
    if (!/\.kb-helper\s*\{/.test(css)) throw new Error('css rule missing');
  });

  /* ---- clickjacking ---- */
  async function bootFramed(framed) {
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/', pretendToBeVisual: true });
    const w = dom.window; w.Element.prototype.scrollIntoView = function () {}; w.alert = () => {}; w.confirm = () => true;
    const fake = new Proxy(w, { get(tg, k) { if (k === 'top' && framed) return {}; const v = tg[k]; return typeof v === 'function' ? v.bind(tg) : v; }, set(tg, k, v) { tg[k] = v; return true; } });
    new w.Function('window', js)(fake);
    await new Promise(r => { if (w.document.readyState === 'loading') w.document.addEventListener('DOMContentLoaded', () => setTimeout(r, 15)); else setTimeout(r, 15); });
    return w;
  }
  await ta('Framed page refuses to render (document emptied, no data written)', async () => {
    const w = await bootFramed(true);
    if (w.document.documentElement.children.length !== 0) throw new Error('document not emptied');
    if (w.localStorage.getItem(DK)) throw new Error('app initialised inside a frame');
  });
  await ta('Control: same harness unframed renders normally', async () => { const w = await bootFramed(false); if (!w.document.getElementById('nav').children.length) throw new Error('nav empty'); });

  /* ---- CSV ---- */
  await ta('CSV export escapes formula injection (=,+,-,@,TAB,CR)', async () => {
    const w = await boot(); const cap = captureBlobs(w);
    const g = wbOf(w); sheetOf(g, 'Quick list').rows = [{ 'Small Times': '=HYPERLINK("http://evil","x")' }, { 'Small Times': '+1+1' }, { 'Small Times': '-2' }, { 'Small Times': '@SUM(A1)' }, { 'Small Times': '\t=1' }];
    await doImport(w, JSON.stringify(g)); clickNav(w, /Stars/); w.document.getElementById('btnExportCsv').click();
    const lines = cap[cap.length - 1].split('\r\n').slice(1);
    if (lines.length < 5 || lines.some(l => /^"?[=+\-@\t]/.test(l))) throw new Error('unescaped formula cell: ' + JSON.stringify(lines));
  });
  await ta('CSV export quotes fields containing quotes, commas, newlines', async () => {
    const w = await boot(); const cap = captureBlobs(w); const g = wbOf(w); sheetOf(g, 'Quick list').rows = [{ 'Small Times': 'a,"b"\nc' }];
    await doImport(w, JSON.stringify(g)); clickNav(w, /Stars/); w.document.getElementById('btnExportCsv').click();
    if (!cap[cap.length - 1].includes('"a,""b""\nc"')) throw new Error(JSON.stringify(cap[cap.length - 1]));
  });

  /* ---- summary & misc (original suite) ---- */
  await ta('Summary page survives Space names like __proto__/constructor/toString', async () => {
    const w = await boot(); const g = wbOf(w); const d = sheetOf(g, 'Daily planning - All tasks');
    d.rows = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'normal'].map(sp => Object.assign(Object.fromEntries(d.columns.map(c => [c, ''])), { Space: sp, 'Timeframe/Meeting': 'task ' + sp }));
    await doImport(w, JSON.stringify(g)); clickNav(w, /Spacetime/);
    if (w.__errs.length) throw new Error(w.__errs.join(';'));
    if (w.document.querySelectorAll('#tableBody tr').length < 5) throw new Error('summary did not render all spaces');
  });
  await ta('Exported/stored data contains no code-bearing content types', async () => { if (/function\s*\(|<script/i.test(w0.localStorage.getItem(DK))) throw new Error('code in data'); });
  await ta('Labels: Times page counter reads "Time N of M"', async () => {
    const w = await boot(); w.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {} });
    const g = wbOf(w); const d = sheetOf(g, 'Daily planning - All tasks'); d.rows = [0, 1].map(i => Object.assign(Object.fromEntries(d.columns.map(c => [c, ''])), { Space: 'S', 'Timeframe/Meeting': 't' + i }));
    await doImport(w, JSON.stringify(g)); clickNav(w, /^Times$/);
    const lbl = w.document.getElementById('taskPositionLabel').textContent; if (!/^Time 1 of 2$/.test(lbl)) throw new Error('got "' + lbl + '"');
  });
  await ta('Milestone splitter is not catastrophically slow on pathological input (ReDoS)', async () => {
    const w = await boot(); const g = wbOf(w); const rm = sheetOf(g, 'Road Map - Pending');
    rm.rows = [{ Space: 'RR', 'Key milestones': ' '.repeat(4990) + '1.x', 'Life began': '', 'Life Ends': '', 'Life span': '' }, { Space: 'RR', 'Key milestones': '1.'.repeat(2500), 'Life began': '', 'Life Ends': '', 'Life span': '' }];
    await doImport(w, JSON.stringify(g)); clickNav(w, /^Spaces$/);
    const t0 = Date.now(); w.document.querySelectorAll('.row-btn.create-tasks').forEach(b => b.click()); if (Date.now() - t0 > 1500) throw new Error('took ' + (Date.now() - t0) + 'ms');
  });

  /* ---- functional regression (hardening must not break real use) ---- */
  await ta('Functional: add row -> exactly one row added; typed text persists', async () => {
    const w = await boot(); clickNav(w, /^Stars$/); const n0 = sheetOf(wbOf(w), 'Quick list').rows.length;
    w.document.getElementById('btnAddRowFloating').click(); await sleep(120);
    const rows = sheetOf(wbOf(w), 'Quick list').rows; if (rows.length !== n0 + 1) throw new Error('rows ' + n0 + ' -> ' + rows.length);
    const cell = w.document.querySelectorAll('.quick-list-row .cell-editable'); const last = cell[cell.length - 1]; last.textContent = 'buy milk'; last.dispatchEvent(new w.Event('blur'));
    if (sheetOf(wbOf(w), 'Quick list').rows.pop()['Small Times'] !== 'buy milk') throw new Error('edit not saved');
  });
  await ta('Functional: Times -> status "Complete" moves row to Completed tasks', async () => {
    const w = await boot(); const g = wbOf(w); const d = sheetOf(g, 'Daily planning - All tasks'); d.rows = [Object.assign(Object.fromEntries(d.columns.map(c => [c, ''])), { Space: 'AA', 'Timeframe/Meeting': 'finish me' })];
    await doImport(w, JSON.stringify(g)); clickNav(w, /^Times$/);
    const sel = w.document.querySelector('select.status-select'); sel.value = 'Complete'; sel.dispatchEvent(new w.Event('change'));
    const g2 = wbOf(w); if (sheetOf(g2, 'Daily planning - All tasks').rows.length !== 0) throw new Error('still on Daily'); const c = sheetOf(g2, 'Completed tasks').rows; if (c.length !== 1 || c[0].Timing !== 'Complete') throw new Error('not completed');
  });
  await ta('Functional: Export JSON -> Import round-trip reproduces identical data', async () => {
    const a = await boot(); const cap = captureBlobs(a); const g = wbOf(a);
    const d = sheetOf(g, 'Daily planning - All tasks'); d.rows = [Object.assign(Object.fromEntries(d.columns.map(c => [c, ''])), { Space: 'ÄÖ', Demand: '2', 'Timeframe/Meeting': 'שלום 😀\nline2', Timing: 'Hold' })];
    sheetOf(g, 'Quick list').rows = [{ 'Small Times': 'x' }, { 'Small Times': 'y' }];
    await doImport(a, JSON.stringify(g)); a.document.getElementById('btnExportJson').click();
    const exported = cap[cap.length - 1]; const b = await boot(); await doImport(b, exported);
    if (JSON.stringify(wbOf(a)) !== JSON.stringify(wbOf(b))) throw new Error('round-trip differs');
  });
  await ta('Functional: legacy-format backup (old column names) migrates without data loss', async () => {
    const w = await boot(); const legacy = [{ name: 'Daily planning - All tasks', columns: ['Date', 'Project', 'Priority', 'Task/Meeting', 'Raised by', 'Work with', 'Next steps', 'Due date', 'Status'], rows: [{ Date: '01/02/2026', Project: 'AA', Priority: '1', 'Task/Meeting': 'Old task', 'Next steps': 'ns', 'Due date': '03/04/2026', Status: 'In-Progress' }] }, { name: 'Quick list', columns: ['Item'], rows: [{ Item: 'milk' }] }];
    await doImport(w, JSON.stringify(legacy)); const g = wbOf(w); const r = sheetOf(g, 'Daily planning - All tasks').rows[0];
    if (r.Space !== 'AA' || r.Demand !== '1' || r['Timeframe/Meeting'] !== 'Old task' || r['Next Timeframes'] !== 'ns' || r['Time Zero on'] !== '03/04/2026' || r.Timing !== 'In-Progress') throw new Error(JSON.stringify(r));
    if (sheetOf(g, 'Quick list').rows[0]['Small Times'] !== 'milk') throw new Error('quick list lost');
  });

  /* ---- TimesX7 page behaviour ---- */
  const mmddyyyy = d => String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear();
  const DAYNAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const now = new Date(), todayStr = mmddyyyy(now), todayName = DAYNAMES[now.getDay()];
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1), tomorrowStr = mmddyyyy(tomorrow), tomorrowName = DAYNAMES[tomorrow.getDay()];
  const blankTask = o => Object.assign({ Date: '', Space: '', Demand: '', 'Timeframe/Meeting': '', 'Next Timeframes': '', 'Time Zero on': '', Timing: '' }, o);
  async function weekBoot(dailyRows, roadRows) {
    const w = await boot(); const g = wbOf(w);
    sheetOf(g, 'Daily planning - All tasks').rows = dailyRows;
    if (roadRows) sheetOf(g, 'Road Map - Pending').rows = roadRows;
    sheetOf(g, 'Week planning').rows = [];
    await doImport(w, JSON.stringify(g)); return w;
  }
  await ta('TimesX7 Refresh: Times rows appear as "Space || Time"; Spaces (Life Ends) rows are NOT shown', async () => {
    const w = await weekBoot([blankTask({ Space: 'AA', 'Timeframe/Meeting': 'Call Bob', 'Time Zero on': todayStr }), blankTask({ 'Timeframe/Meeting': 'Only time', 'Time Zero on': todayStr }), blankTask({ Space: 'OnlySpace', 'Time Zero on': todayStr })],
      [{ Space: 'RR', 'Key milestones': 'k', 'Life began': '', 'Life Ends': todayStr, 'Life span': '' }]);
    clickNav(w, /^TimesX7$/); w.document.getElementById('btnRefreshWeek').click();
    const texts = sheetOf(wbOf(w), 'Week planning').rows.map(r => r.Timeframes).sort();
    const want = ['AA || Call Bob', 'OnlySpace', 'Only time'].sort(); // Spaces row RR must not appear
    if (JSON.stringify(texts) !== JSON.stringify(want)) throw new Error(JSON.stringify(texts));
  });
  await ta('TimesX7 sync: an older row showing only the Time text is upgraded in place (no duplicate)', async () => {
    const w = await weekBoot([blankTask({ Space: 'AA', 'Timeframe/Meeting': 'Call Bob', 'Time Zero on': todayStr })]);
    const g = wbOf(w); sheetOf(g, 'Week planning').rows = [{ 'Date/Day': 'Xxx, ' + todayStr, Timeframes: 'Call Bob' }];
    const dd = sheetOf(g, 'Week planning'); dd.rows[0]['Date/Day'] = (['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()]) + ', ' + todayStr;
    await doImport(w, JSON.stringify(g)); clickNav(w, /^TimesX7$/); w.document.getElementById('btnRefreshWeek').click(); // rebuild path
    const rows1 = sheetOf(wbOf(w), 'Week planning').rows; if (rows1.length !== 1 || rows1[0].Timeframes !== 'AA || Call Bob') throw new Error('refresh: ' + JSON.stringify(rows1));
    // automatic (non-refresh) path: seed an old-style row, then let the sync run
    const g2 = wbOf(w); sheetOf(g2, 'Week planning').rows = [{ 'Date/Day': dd.rows[0]['Date/Day'], Timeframes: 'Call Bob' }];
    const w2 = await boot({ [DK]: JSON.stringify(g2) }); await sleep(30);
    const rows2 = sheetOf(wbOf(w2), 'Week planning').rows; if (rows2.length !== 1 || rows2[0].Timeframes !== 'AA || Call Bob') throw new Error('auto: ' + JSON.stringify(rows2));
  });
  await ta('TimesX7: today\'s group reads "<Day> - Today" with the highlight class; other groups unchanged', async () => {
    const w = await weekBoot([blankTask({ Space: 'A', 'Timeframe/Meeting': 'x', 'Time Zero on': todayStr }), blankTask({ Space: 'B', 'Timeframe/Meeting': 'y', 'Time Zero on': tomorrowStr })]);
    clickNav(w, /^TimesX7$/); w.document.getElementById('btnRefreshWeek').click();
    const hdrs = [...w.document.querySelectorAll('tr.week-day-header-row')];
    const today = hdrs.filter(h => h.classList.contains('week-day-today')); const others = hdrs.filter(h => !h.classList.contains('week-day-today'));
    if (today.length !== 1 || today[0].textContent !== todayName + ' - Today') throw new Error(JSON.stringify(hdrs.map(h => h.textContent)));
    if (!others.length || others.some(h => / - Today/.test(h.textContent))) throw new Error('other header changed');
    if (!others.some(h => h.textContent === tomorrowName)) throw new Error('tomorrow header should be plain day name');
  });
  await ta('TimesX7: no Transforms/actions column, no row buttons', async () => {
    const w = await weekBoot([blankTask({ Space: 'A', 'Timeframe/Meeting': 'x', 'Time Zero on': todayStr })]);
    clickNav(w, /^TimesX7$/); w.document.getElementById('btnRefreshWeek').click();
    if (w.document.querySelectorAll('#tableHead tr:first-child th').length !== 2) throw new Error('header cells != 2');
    if (w.document.querySelector('.col-actions, .row-btn, td[data-col="Transforms"]')) throw new Error('actions still present');
    if (w.document.querySelectorAll('#colgroup col').length !== 2) throw new Error('colgroup != 2');
    const hdr = w.document.querySelector('td.week-day-header'); if (hdr.colSpan !== 2) throw new Error('group header colSpan ' + hdr.colSpan);
  });
  await ta('TimesX7: Defined time on shows only the date (stored value keeps weekday); date col fixed, Times col takes the rest', async () => {
    const w = await weekBoot([blankTask({ Space: 'A', 'Timeframe/Meeting': 'x', 'Time Zero on': todayStr })]);
    clickNav(w, /^TimesX7$/); w.document.getElementById('btnRefreshWeek').click();
    const inp = w.document.querySelector('td[data-col="Date/Day"] input'); if (inp.value !== todayStr) throw new Error('shown "' + inp.value + '"');
    if (!/^[A-Z][a-z]{2}, /.test(sheetOf(wbOf(w), 'Week planning').rows[0]['Date/Day'])) throw new Error('stored format changed');
    const cols = [...w.document.querySelectorAll('#colgroup col')]; if (cols[0].style.width !== '160px' || cols[1].style.width !== '') throw new Error(cols.map(c => c.style.width).join('|'));
    const opt = [...w.document.querySelectorAll('.filter-select')][0].options; if ([...opt].some(o => /^[A-Z][a-z]{2},/.test(o.textContent))) throw new Error('filter dropdown shows day names');
    inp.dispatchEvent(new w.Event('blur')); if (inp.value !== todayStr) throw new Error('after blur: ' + inp.value);
  });
  t('TimesX7 phone layout keeps Date and Times on one line (no-wrap, Times flex-basis 0)', () =>
    /tr\.week-row\{flex-wrap:nowrap/.test(css.replace(/\s+/g, '')) && /td\[data-col="Timeframes"\]\{flex:1 1 0;/.test(css.replace(/\s+/g, ' ')) && !/week-row > td\[data-col="Transforms"\]/.test(css));

  /* ---- Times page: calendar for "time on"; Demand 99 weekday repeat ---- */
  const addDays = n => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
  const dayStrOf = n => mmddyyyy(addDays(n));
  const expectedWeekdays = (fromOff, toOff) => { const out = []; for (let o = Math.max(fromOff, 0); o <= Math.min(toOff, 7); o++) out.push(dayStrOf(o)); return out.sort(); }; // every day, all 7 weekdays
  const weekDates = w => sheetOf(wbOf(w), 'Week planning').rows.map(r => /\d{2}\/\d{2}\/\d{4}/.exec(r['Date/Day'])[0]).sort();
  await ta('Times page: "time on" (Date) is a calendar input; picking a date saves MM/DD/YYYY', async () => {
    const w = await weekBoot([blankTask({ Date: '01/02/2026', Space: 'A', 'Timeframe/Meeting': 'x' })]);
    clickNav(w, /^Times$/);
    const inp = w.document.querySelector('td[data-col="Date"] input.due-date-input'); if (!inp) throw new Error('Date is not a calendar input');
    if (inp.value !== '01/02/2026') throw new Error('shows ' + inp.value);
    inp.dispatchEvent(new w.Event('focus')); if (inp.type !== 'date') throw new Error('did not switch to a date control: ' + inp.type);
    if (inp.value !== '2026-01-02') throw new Error('picker not pre-set: ' + inp.value);
    inp.value = '2026-10-12'; inp.dispatchEvent(new w.Event('change'));
    if (sheetOf(wbOf(w), 'Daily planning - All tasks').rows[0].Date !== '10/12/2026') throw new Error('saved ' + sheetOf(wbOf(w), 'Daily planning - All tasks').rows[0].Date);
    inp.dispatchEvent(new w.Event('blur')); if (inp.type !== 'text' || inp.value !== '10/12/2026') throw new Error('after blur ' + inp.type + ' ' + inp.value);
  });
  await ta('Times page: "+ Add" fills today\'s date and does not pop the calendar (focus goes to a text cell)', async () => {
    const w = await boot(); clickNav(w, /^Times$/); const focused = []; const of = w.HTMLElement.prototype.focus; w.HTMLElement.prototype.focus = function () { focused.push(this.className + '|' + this.type); return of.apply(this, arguments); };
    w.document.getElementById('btnAddRowFloating').click(); await sleep(200);
    const rows = sheetOf(wbOf(w), 'Daily planning - All tasks').rows; if (rows[rows.length - 1].Date !== todayStr) throw new Error('date ' + rows[rows.length - 1].Date);
    const dateInp = w.document.querySelector('tr[data-source-idx="' + (rows.length - 1) + '"] td[data-col="Date"] input'); if (!dateInp || dateInp.type !== 'text') throw new Error('calendar opened on add');
    const last = focused[focused.length - 1]; if (!last || !/cell-editable/.test(last)) throw new Error('focus not on a text cell: ' + JSON.stringify(focused));
  });
  async function repeatCase(demand, startOff, endOff, extra) {
    const w = await weekBoot([blankTask(Object.assign({ Demand: demand, Space: 'AA', 'Timeframe/Meeting': 'Standup', Date: startOff === null ? '' : dayStrOf(startOff), 'Time Zero on': endOff === null ? '' : dayStrOf(endOff) }, extra || {}))]);
    clickNav(w, /^TimesX7$/); w.document.getElementById('btnRefreshWeek').click(); return w;
  }
  await ta('Demand 99: one TimesX7 row per day (all 7 days of the week, weekends included) from time-on to Time Zero on, within the next 7 days', async () => {
    const w = await repeatCase('99', -3, 20); const got = weekDates(w), want = expectedWeekdays(0, 7);
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error('got ' + got + ' want ' + want);
    if (sheetOf(wbOf(w), 'Week planning').rows.some(r => r.Timeframes !== 'AA || Standup')) throw new Error('text not "Space || Time"');
    if (got.length !== 8) throw new Error('expected 8 consecutive days (today..+7), got ' + got.length);
    const wds = new Set(got.map(d => { const [m, dd, y] = d.split('/').map(Number); return new Date(y, m - 1, dd).getDay(); })); if (wds.size !== 7) throw new Error('not every weekday covered: ' + [...wds]);
  });
  await ta('Demand 99: stops at the Time Zero on date (inclusive) and starts at time-on when it is in the future', async () => {
    let w = await repeatCase('99', 0, 3); if (JSON.stringify(weekDates(w)) !== JSON.stringify(expectedWeekdays(0, 3))) throw new Error('end: ' + weekDates(w));
    w = await repeatCase('99', 2, 6); if (JSON.stringify(weekDates(w)) !== JSON.stringify(expectedWeekdays(2, 6))) throw new Error('start: ' + weekDates(w));
  });
  await ta('Demand 99: no past days (even on Refresh), no Time Zero on -> nothing, " 99 " is accepted', async () => {
    let w = await repeatCase('99', -10, -2); if (weekDates(w).length) throw new Error('past days added: ' + weekDates(w));
    w = await repeatCase('99', 0, null); if (weekDates(w).length) throw new Error('added without end date');
    w = await repeatCase(' 99 ', 0, 7); if (JSON.stringify(weekDates(w)) !== JSON.stringify(expectedWeekdays(0, 7))) throw new Error('trim: ' + weekDates(w));
  });
  await ta('Demand 99: blank/invalid time-on falls back to the end date only (any day, weekend too); other Demand values are not repeated', async () => {
    let w = await repeatCase('99', null, 4); const want = expectedWeekdays(4, 4); if (JSON.stringify(weekDates(w)) !== JSON.stringify(want)) throw new Error('blank start: ' + weekDates(w) + ' want ' + want);
    w = await repeatCase('5', -3, 4); if (JSON.stringify(weekDates(w)) !== JSON.stringify([dayStrOf(4)])) throw new Error('normal row changed: ' + weekDates(w));
    w = await repeatCase('990', 0, 5); if (JSON.stringify(weekDates(w)) !== JSON.stringify([dayStrOf(5)])) throw new Error('"990" treated as 99: ' + weekDates(w));
  });
  await ta('Demand 99: repeat rows are not duplicated by a second Refresh or the automatic sync', async () => {
    const w = await repeatCase('99', 0, 7); const n = weekDates(w).length; w.document.getElementById('btnRefreshWeek').click(); clickNav(w, /^Times$/); clickNav(w, /^TimesX7$/); await sleep(30);
    if (weekDates(w).length !== n) throw new Error(n + ' -> ' + weekDates(w).length);
  });

  /* ---- Spaces page: Delete removes the Space and all its tasks ---- */
  const roadRow = sp => ({ Space: sp, 'Key milestones': 'k', 'Life began': '', 'Life Ends': '', 'Life span': '' });
  async function spaceBoot(road) {
    const w = await boot(); const g = wbOf(w);
    sheetOf(g, 'Road Map - Pending').rows = road;
    sheetOf(g, 'Daily planning - All tasks').rows = [blankTask({ Space: 'AA', 'Timeframe/Meeting': 'a1' }), blankTask({ Space: ' AA ', 'Timeframe/Meeting': 'a2' }), blankTask({ Space: 'AAB', 'Timeframe/Meeting': 'keep-AAB' }), blankTask({ Space: 'aa', 'Timeframe/Meeting': 'keep-lower' }), blankTask({ 'Timeframe/Meeting': 'keep-nospace' })];
    sheetOf(g, 'All future Tasks').rows = [blankTask({ Space: 'AA', 'Timeframe/Meeting': 'f1' }), blankTask({ Space: 'BB', 'Timeframe/Meeting': 'keep-f' })];
    sheetOf(g, 'Completed tasks').rows = [blankTask({ Space: 'AA', 'Timeframe/Meeting': 'c1', Timing: 'Complete' }), blankTask({ Space: 'BB', 'Timeframe/Meeting': 'keep-c', Timing: 'Complete' })];
    await doImport(w, JSON.stringify(g)); clickNav(w, /^Spaces$/); return w;
  }
  const spaceDeleteBtn = (w, i) => w.document.querySelectorAll('tr[data-source-idx] .row-btn.delete')[i];
  const texts = (w, n) => sheetOf(wbOf(w), n).rows.map(r => r['Timeframe/Meeting']).sort();
  await ta('Spaces Delete: removes the Space and its tasks on Times, NextIn and NoSpace (exact trimmed name only)', async () => {
    const w = await spaceBoot([roadRow('AA'), roadRow('BB')]); let msg = ''; w.confirm = m => { msg = m; return true; };
    spaceDeleteBtn(w, 0).click();
    const g = wbOf(w);
    if (JSON.stringify(sheetOf(g, 'Road Map - Pending').rows.map(r => r.Space)) !== '["BB"]') throw new Error('space rows: ' + JSON.stringify(sheetOf(g, 'Road Map - Pending').rows));
    if (JSON.stringify(texts(w, 'Daily planning - All tasks')) !== JSON.stringify(['keep-AAB', 'keep-lower', 'keep-nospace'])) throw new Error('Times: ' + texts(w, 'Daily planning - All tasks'));
    if (JSON.stringify(texts(w, 'All future Tasks')) !== '["keep-f"]') throw new Error('NextIn: ' + texts(w, 'All future Tasks'));
    if (JSON.stringify(texts(w, 'Completed tasks')) !== '["keep-c"]') throw new Error('NoSpace: ' + texts(w, 'Completed tasks'));
    const sum = sheetOf(g, 'Summary').rows.map(r => r.Space + ':' + r.Time); if (sum.some(x => /^AA:/.test(x))) throw new Error('Spacetime still has AA: ' + sum);
    if (!/"AA"/.test(msg) || !/2 row\(s\) on Times/.test(msg) || !/1 row\(s\) on NextIn/.test(msg) || !/1 row\(s\) on NoSpace/.test(msg)) throw new Error('confirm text: ' + msg);
    for (const b of navBtns(w)) b.click(); if (w.__errs.length) throw new Error(w.__errs[0]);
  });
  await ta('Spaces Delete: Cancel deletes nothing', async () => {
    const w = await spaceBoot([roadRow('AA')]); const before = w.localStorage.getItem(DK); w.confirm = () => false; spaceDeleteBtn(w, 0).click();
    if (w.localStorage.getItem(DK) !== before) throw new Error('data changed on cancel');
  });
  await ta('Spaces Delete: a Space with no name deletes only its own row (never every task without a Space)', async () => {
    const w = await spaceBoot([roadRow(''), roadRow('AA')]); spaceDeleteBtn(w, 0).click();
    if (sheetOf(wbOf(w), 'Road Map - Pending').rows.length !== 1) throw new Error('row not deleted');
    if (!texts(w, 'Daily planning - All tasks').includes('keep-nospace') || texts(w, 'Daily planning - All tasks').length !== 5) throw new Error('tasks deleted: ' + texts(w, 'Daily planning - All tasks'));
  });
  await ta('Spaces Delete: if another Spaces row has the same name, only the row goes and tasks are kept', async () => {
    const w = await spaceBoot([roadRow('AA'), roadRow('AA')]); let msg = ''; w.confirm = m => { msg = m; return true; }; spaceDeleteBtn(w, 0).click();
    if (sheetOf(wbOf(w), 'Road Map - Pending').rows.length !== 1) throw new Error('row not deleted');
    if (texts(w, 'Daily planning - All tasks').length !== 5 || texts(w, 'All future Tasks').length !== 2) throw new Error('tasks deleted');
    if (!/tasks are kept/.test(msg)) throw new Error('message: ' + msg);
  });
  await ta('Delete on other pages still deletes just that row', async () => {
    const w = await spaceBoot([roadRow('AA')]); clickNav(w, /^NextIn$/); w.document.querySelector('tr[data-source-idx] .row-btn.delete').click();
    if (sheetOf(wbOf(w), 'All future Tasks').rows.length !== 1 || sheetOf(wbOf(w), 'Road Map - Pending').rows.length !== 1 || texts(w, 'Daily planning - All tasks').length !== 5) throw new Error('cascade leaked to another page');
  });


  /* ---- TimesX7: Times-only rows, Life Ends limit, radio delete, date sync ---- */
  const dayStr = n => mmddyyyy(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));
  const isoOf = str => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(str); return m[3] + '-' + m[1] + '-' + m[2]; };
  const dateOnly = v => { const m = /\d{2}\/\d{2}\/\d{4}/.exec(v); return m ? m[0] : ''; };
  const formatDD = n => { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n); return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ', ' + mmddyyyy(d); };
  const lifeRow = (space, ends) => ({ Space: space, 'Key milestones': 'k', 'Life began': '', 'Life Ends': ends, 'Life span': '' });
  function pickDate(w, input, str) { input.dispatchEvent(new w.Event('focus')); input.value = isoOf(str); input.dispatchEvent(new w.Event('change')); }
  await ta('TimesX7: Spaces rows are not shown, also through the automatic sync', async () => {
    const w = await weekBoot([blankTask({ Space: 'AA', 'Timeframe/Meeting': 'T1', 'Time Zero on': todayStr })], [lifeRow('RR', todayStr)]);
    clickNav(w, /^TimesX7$/); await sleep(30); const texts1 = sheetOf(wbOf(w), 'Week planning').rows.map(r => r.Timeframes);
    if (JSON.stringify(texts1) !== '["AA || T1"]') throw new Error(JSON.stringify(texts1));
  });
  await ta("Times: Time Zero on cannot go past the Space's Life Ends (rejected, old value kept, picker max set)", async () => {
    const w = await weekBoot([blankTask({ Space: 'AA', 'Timeframe/Meeting': 'T1', 'Time Zero on': dayStr(1) })], [lifeRow('AA', dayStr(5))]);
    let msg = ''; w.alert = m => { msg = m; };
    clickNav(w, /^Times$/); const inp = w.document.querySelector('td[data-col="Time Zero on"] input');
    pickDate(w, inp, dayStr(9));
    if (sheetOf(wbOf(w), 'Daily planning - All tasks').rows[0]['Time Zero on'] !== dayStr(1)) throw new Error('beyond date was saved');
    if (!/Life Ends/.test(msg)) throw new Error('no warning: ' + msg);
    if (inp.max !== isoOf(dayStr(5))) throw new Error('max attr ' + inp.max);
    pickDate(w, inp, dayStr(5));
    if (sheetOf(wbOf(w), 'Daily planning - All tasks').rows[0]['Time Zero on'] !== dayStr(5)) throw new Error('date on the limit rejected');
  });
  await ta('Times: no limit when the Space is blank, unknown, or has no Life Ends', async () => {
    const w = await weekBoot([blankTask({ 'Timeframe/Meeting': 'a' }), blankTask({ Space: 'Zed', 'Timeframe/Meeting': 'b' }), blankTask({ Space: 'AA', 'Timeframe/Meeting': 'c' })], [lifeRow('AA', '')]);
    clickNav(w, /^Times$/); const inps = [...w.document.querySelectorAll('td[data-col="Time Zero on"] input')];
    inps.forEach(i => pickDate(w, i, dayStr(40)));
    if (sheetOf(wbOf(w), 'Daily planning - All tasks').rows.some(r => r['Time Zero on'] !== dayStr(40))) throw new Error('a limit was wrongly applied');
  });
  await ta("TimesX7: Defined time on cannot go past the Space's Life Ends; a valid date also updates Time Zero on on Times", async () => {
    const w = await weekBoot([blankTask({ Space: 'AA', 'Timeframe/Meeting': 'T1', 'Time Zero on': dayStr(1) })], [lifeRow('AA', dayStr(5))]);
    let msg = ''; w.alert = m => { msg = m; };
    clickNav(w, /^TimesX7$/); w.document.getElementById('btnRefreshWeek').click();
    let inp = w.document.querySelector('td[data-col="Date/Day"] input');
    pickDate(w, inp, dayStr(9));
    if (!/Life Ends/.test(msg)) throw new Error('no warning');
    if (dateOnly(sheetOf(wbOf(w), 'Week planning').rows[0]['Date/Day']) !== dayStr(1) || sheetOf(wbOf(w), 'Daily planning - All tasks').rows[0]['Time Zero on'] !== dayStr(1)) throw new Error('beyond date was saved');
    inp = w.document.querySelector('td[data-col="Date/Day"] input'); pickDate(w, inp, dayStr(3));
    const wr = sheetOf(wbOf(w), 'Week planning').rows; if (wr.length !== 1 || dateOnly(wr[0]['Date/Day']) !== dayStr(3)) throw new Error('week row: ' + JSON.stringify(wr));
    if (sheetOf(wbOf(w), 'Daily planning - All tasks').rows[0]['Time Zero on'] !== dayStr(3)) throw new Error('Times not synced');
    await sleep(30); w.document.dispatchEvent(new w.Event('visibilitychange'));
    if (sheetOf(wbOf(w), 'Week planning').rows.length !== 1) throw new Error('sync duplicated the row');
  });
  await ta('TimesX7: radio sits before the date; clicking it deletes the row here AND its source on Times (Demand not 99)', async () => {
    const w = await weekBoot([blankTask({ Space: 'AA', 'Timeframe/Meeting': 'T1', 'Time Zero on': todayStr }), blankTask({ Space: 'AA', 'Timeframe/Meeting': 'T2', 'Time Zero on': todayStr })]);
    clickNav(w, /^TimesX7$/); w.document.getElementById('btnRefreshWeek').click();
    const cell = w.document.querySelector('td[data-col="Date/Day"]'); if (!cell.firstElementChild.classList.contains('week-date-wrap') || !cell.firstElementChild.firstElementChild.classList.contains('week-radio')) throw new Error('radio not before date');
    const rowEl = [...w.document.querySelectorAll('tr.week-row')].find(r => /T1/.test(r.textContent)); rowEl.querySelector('.week-radio').click();
    const g = wbOf(w);
    if (JSON.stringify(sheetOf(g, 'Week planning').rows.map(r => r.Timeframes)) !== '["AA || T2"]') throw new Error('week: ' + JSON.stringify(sheetOf(g, 'Week planning').rows));
    if (JSON.stringify(sheetOf(g, 'Daily planning - All tasks').rows.map(r => r['Timeframe/Meeting'])) !== '["T2"]') throw new Error('times: ' + JSON.stringify(sheetOf(g, 'Daily planning - All tasks').rows));
    await sleep(30); if (sheetOf(wbOf(w), 'Week planning').rows.length !== 1) throw new Error('deleted row came back');
    for (const b of navBtns(w)) b.click(); if (w.__errs.length) throw new Error(w.__errs[0]);
  });
  await ta('TimesX7: radio on a Demand 99 task deletes only that day here; the Times row stays and the day does not come back', async () => {
    const w = await weekBoot([blankTask({ Space: 'AA', Demand: '99', 'Timeframe/Meeting': 'Daily', Date: todayStr, 'Time Zero on': dayStr(3) })]);
    clickNav(w, /^TimesX7$/); w.document.getElementById('btnRefreshWeek').click();
    if (sheetOf(wbOf(w), 'Week planning').rows.length !== 4) throw new Error('expected 4 days, got ' + sheetOf(wbOf(w), 'Week planning').rows.length);
    let asked = false; w.confirm = () => { asked = true; return true; };
    w.document.querySelector('tr.week-row .week-radio').click();
    const g = wbOf(w); if (sheetOf(g, 'Week planning').rows.length !== 3) throw new Error('day not removed');
    if (sheetOf(g, 'Daily planning - All tasks').rows.length !== 1) throw new Error('Times row was deleted');
    if (asked) throw new Error('should not ask: nothing on Times is deleted');
    await sleep(30); w.document.dispatchEvent(new w.Event('visibilitychange')); if (sheetOf(wbOf(w), 'Week planning').rows.length !== 3) throw new Error('removed day returned');
  });
  await ta('TimesX7: radio -> Cancel deletes nothing', async () => {
    const w = await weekBoot([blankTask({ Space: 'AA', 'Timeframe/Meeting': 'T1', 'Time Zero on': todayStr })]);
    clickNav(w, /^TimesX7$/); w.document.getElementById('btnRefreshWeek').click(); const before = w.localStorage.getItem(DK);
    w.confirm = () => false; w.document.querySelector('.week-radio').click(); if (w.localStorage.getItem(DK) !== before) throw new Error('data changed');
  });
  await ta('TimesX7: a hand-made row with no source on Times is deleted on its own (nothing else touched)', async () => {
    const w = await weekBoot([blankTask({ Space: 'AA', 'Timeframe/Meeting': 'T1' })]);
    const g = wbOf(w); sheetOf(g, 'Week planning').rows = [{ 'Date/Day': formatDD(0), Timeframes: 'manual' }]; await doImport(w, JSON.stringify(g));
    clickNav(w, /^TimesX7$/); w.document.querySelector('.week-radio').click();
    if (sheetOf(wbOf(w), 'Week planning').rows.length !== 0 || sheetOf(wbOf(w), 'Daily planning - All tasks').rows.length !== 1) throw new Error('wrong rows deleted');
  });
  await ta('TimesX7: dates of Demand 99 (recurring) tasks cannot be edited; others stay editable', async () => {
    const w = await weekBoot([blankTask({ Space: 'AA', Demand: '99', 'Timeframe/Meeting': 'Daily', Date: todayStr, 'Time Zero on': dayStr(2) }), blankTask({ Space: 'BB', 'Timeframe/Meeting': 'One', 'Time Zero on': todayStr })]);
    clickNav(w, /^TimesX7$/); w.document.getElementById('btnRefreshWeek').click();
    const rowsEl = [...w.document.querySelectorAll('tr.week-row')]; const rec = rowsEl.find(r => /Daily/.test(r.textContent)), one = rowsEl.find(r => /One/.test(r.textContent));
    const ri = rec.querySelector('td[data-col="Date/Day"] input'); const before = w.localStorage.getItem(DK);
    ri.dispatchEvent(new w.Event('focus')); if (ri.type === 'date') throw new Error('recurring date opened a picker');
    ri.value = isoOf(dayStr(1)); ri.dispatchEvent(new w.Event('change')); if (w.localStorage.getItem(DK) !== before) throw new Error('recurring date changed');
    const oi = one.querySelector('td[data-col="Date/Day"] input'); oi.dispatchEvent(new w.Event('focus')); if (oi.type !== 'date') throw new Error('normal date should open picker');
  });
  await ta('Date sync: changing Time Zero on on Times moves the TimesX7 row on Refresh (one row, new date)', async () => {
    const w = await weekBoot([blankTask({ Space: 'AA', 'Timeframe/Meeting': 'T1', 'Time Zero on': todayStr })]);
    clickNav(w, /^TimesX7$/); w.document.getElementById('btnRefreshWeek').click();
    clickNav(w, /^Times$/); pickDate(w, w.document.querySelector('td[data-col="Time Zero on"] input'), dayStr(2)); await sleep(200);
    clickNav(w, /^TimesX7$/); w.document.getElementById('btnRefreshWeek').click();
    const rr = sheetOf(wbOf(w), 'Week planning').rows; if (rr.length !== 1 || dateOnly(rr[0]['Date/Day']) !== dayStr(2)) throw new Error(JSON.stringify(rr));
  });


  await ta('TimesX7: Times column is display-only (not editable) and tapping it opens that task on Times', async () => {
    const w = await weekBoot([blankTask({ Space: 'AA', 'Timeframe/Meeting': 'T1', 'Time Zero on': todayStr }), blankTask({ Space: 'AA', 'Timeframe/Meeting': 'T2', 'Time Zero on': todayStr })]);
    clickNav(w, /^TimesX7$/); w.document.getElementById('btnRefreshWeek').click();
    if (w.document.querySelector('tr.week-row td[data-col="Timeframes"] [contenteditable]')) throw new Error('Times column still editable');
    const before = w.localStorage.getItem(DK);
    const link = [...w.document.querySelectorAll('tr.week-row td[data-col="Timeframes"] .week-times-link')].find(e => /T2/.test(e.textContent)); link.click();
    if (!/Times$/.test(w.document.getElementById('pageTitle').textContent.trim())) throw new Error('did not open Times: ' + w.document.getElementById('pageTitle').textContent);
    await sleep(150); const hl = w.document.querySelector('#tableBody tr.row-highlight'); if (!hl || !/T2/.test(hl.textContent)) throw new Error('T2 row not highlighted');
    if (w.localStorage.getItem(DK) !== before) throw new Error('data changed by navigation');
  });
  await ta('TimesX7: Times link on a row with no source just opens the Times page', async () => {
    const w = await weekBoot([blankTask({ Space: 'AA', 'Timeframe/Meeting': 'T1' })]);
    const g = wbOf(w); sheetOf(g, 'Week planning').rows = [{ 'Date/Day': formatDD(0), Timeframes: 'manual' }]; await doImport(w, JSON.stringify(g));
    clickNav(w, /^TimesX7$/); w.document.querySelector('.week-times-link').click();
    if (!/Times$/.test(w.document.getElementById('pageTitle').textContent.trim())) throw new Error('not on Times');
  });


  /* ---- Spacetime: date instead of "Time N", Life Ends limit, sync, status groups ---- */
  await ta('Spacetime: shows each task\'s Time Zero on date (blank when empty); tasks grouped per Space by status', async () => {
    const w = await weekBoot([
      blankTask({ Space: 'AA', 'Timeframe/Meeting': 'h1', Timing: 'Hold', 'Time Zero on': dayStr(1) }),
      blankTask({ Space: 'AA', 'Timeframe/Meeting': 'p1', Timing: 'In-Progress' }),
      blankTask({ Space: 'AA', 'Timeframe/Meeting': 'h2', Timing: 'Hold' }),
      blankTask({ Space: 'AA', 'Timeframe/Meeting': 'p2', Timing: 'In-Progress', 'Time Zero on': dayStr(2) })]);
    clickNav(w, /^Spacetime$/);
    const trs = [...w.document.querySelectorAll('#tableBody tr')].map(tr => tr.classList.contains('week-day-header-row') ? '@' + tr.textContent.trim() : tr.classList.contains('summary-status-row') ? '#' + tr.textContent.trim() : (tr.querySelector('.summary-date-input').value || '_') + '|' + tr.querySelector('.summary-task-link').textContent.trim());
    const want = ['@AA', '#In-Progress', '_|p1', dayStr(2) + '|p2', '#Hold', dayStr(1) + '|h1', '_|h2'];
    if (JSON.stringify(trs) !== JSON.stringify(want)) throw new Error(JSON.stringify(trs));
    if (/Time \d+:/.test(w.document.getElementById('tableBody').textContent)) throw new Error('"Time N:" label still shown');
    const heads = [...w.document.querySelectorAll('#tableHead tr:first-child th')].map(th => th.textContent.trim().replace(/[\u25B2\u25BC]/g, '')); if (JSON.stringify(heads) !== '["Defined time on","Times"]') throw new Error('headers: ' + JSON.stringify(heads));
  });
  await ta("Spacetime: date picker saves to the Times row; cannot go past the Space's Life Ends; blank date can be set", async () => {
    const w = await weekBoot([blankTask({ Space: 'AA', 'Timeframe/Meeting': 'T1', Timing: 'Hold' })], [lifeRow('AA', dayStr(5))]);
    let msg = ''; w.alert = m => { msg = m; };
    clickNav(w, /^Spacetime$/); let inp = w.document.querySelector('.summary-date-input');
    pickDate(w, inp, dayStr(9));
    if (!/Life Ends/.test(msg) || sheetOf(wbOf(w), 'Daily planning - All tasks').rows[0]['Time Zero on'] !== '') throw new Error('beyond date accepted');
    if (inp.max !== isoOf(dayStr(5))) throw new Error('max ' + inp.max);
    pickDate(w, inp, dayStr(4));
    if (sheetOf(wbOf(w), 'Daily planning - All tasks').rows[0]['Time Zero on'] !== dayStr(4)) throw new Error('not synced to Times');
    clickNav(w, /^Times$/); if (w.document.querySelector('td[data-col="Time Zero on"] input').value !== dayStr(4)) throw new Error('Times page not showing the date');
    clickNav(w, /^Spacetime$/); inp = w.document.querySelector('.summary-date-input'); inp.dispatchEvent(new w.Event('focus')); inp.value = ''; inp.dispatchEvent(new w.Event('change'));
    if (sheetOf(wbOf(w), 'Daily planning - All tasks').rows[0]['Time Zero on'] !== '') throw new Error('clear not saved');
  });
  await ta('Spacetime: tapping the date does not navigate away; tapping the task text still opens it on Times', async () => {
    const w = await weekBoot([blankTask({ Space: 'AA', 'Timeframe/Meeting': 'T1' })]);
    clickNav(w, /^Spacetime$/); w.document.querySelector('.summary-date-input').click();
    if (!/Spacetime$/.test(w.document.getElementById('pageTitle').textContent.trim())) throw new Error('left Spacetime');
    w.document.querySelector('.summary-task-link').click();
    if (!/Times$/.test(w.document.getElementById('pageTitle').textContent.trim())) throw new Error('did not open Times');
  });


  await ta('Spaces: Key milestones text box is hidden behind a down arrow; tapping expands/collapses it (data untouched)', async () => {
    const w = await weekBoot([], [Object.assign(lifeRow('AA', ''), { 'Key milestones': 'm1\nm2' })]);
    clickNav(w, /^Projects$|^Spaces$/);
    const wrap = w.document.querySelector('td[data-col="Key milestones"] .milestones-wrap'); if (!wrap) throw new Error('no wrapper');
    const btn = wrap.querySelector('.milestones-toggle'); if (!wrap.classList.contains('collapsed') || btn.textContent !== '\u25BC') throw new Error('should start collapsed with a down arrow');
    const before = w.localStorage.getItem(DK);
    btn.click(); if (wrap.classList.contains('collapsed') || btn.textContent !== '\u25B2' || btn.getAttribute('aria-expanded') !== 'true') throw new Error('did not expand');
    btn.click(); if (!wrap.classList.contains('collapsed')) throw new Error('did not collapse');
    if (w.localStorage.getItem(DK) !== before) throw new Error('data changed');
  });


  /* ---- Space colours ---- */
  await ta('Space colours: each Space gets its own colour automatically, saved with the Space (not a column), duplicates share one', async () => {
    const w = await weekBoot([blankTask({ Space: 'AA', 'Timeframe/Meeting': 'a' }), blankTask({ Space: 'BB', 'Timeframe/Meeting': 'b' })], [lifeRow('AA', ''), lifeRow('BB', ''), lifeRow('CC', ''), lifeRow('AA', '')]);
    clickNav(w, /^Times$/);
    const road = sheetOf(wbOf(w), 'Road Map - Pending'); const cols = road.rows.map(r => r.Color);
    if (cols.some(c => !/^\d{1,2}$/.test(c))) throw new Error('missing colours ' + JSON.stringify(cols));
    if (new Set([cols[0], cols[1], cols[2]]).size !== 3) throw new Error('not distinct ' + JSON.stringify(cols));
    if (cols[3] !== cols[0]) throw new Error('duplicate name should share colour');
    if (road.columns.includes('Color')) throw new Error('Color must not be a column');
    const sp = [...w.document.querySelectorAll('td[data-col="Space"] .space-color')]; if (sp.length !== 2 || sp[0].className === sp[1].className) throw new Error('Times page colours: ' + sp.map(e => e.className));
  });
  await ta('Space colours: a new Space gets a different colour; existing colours never change; same colour on Times, TimesX7 and Spacetime', async () => {
    const w = await weekBoot([blankTask({ Space: 'AA', 'Timeframe/Meeting': 'T1', 'Time Zero on': todayStr })], [lifeRow('AA', '')]);
    clickNav(w, /^Times$/); const aaCls = w.document.querySelector('td[data-col="Space"] .space-color').className;
    const g = wbOf(w); sheetOf(g, 'Road Map - Pending').rows.push(lifeRow('ZZ', '')); await doImport(w, JSON.stringify(g));
    const road = sheetOf(wbOf(w), 'Road Map - Pending').rows; if (road[0].Color === road[1].Color || !road[1].Color) throw new Error('new Space colour ' + JSON.stringify(road.map(r => r.Color)));
    clickNav(w, /^Times$/); if (w.document.querySelector('td[data-col="Space"] .space-color').className !== aaCls) throw new Error('AA colour changed');
    const colourOf = el => (/space-color-\d+/.exec(el.className) || [''])[0];
    clickNav(w, /^TimesX7$/); w.document.getElementById('btnRefreshWeek').click();
    const x7 = w.document.querySelector('.week-times-link .space-color'); if (!x7 || colourOf(x7) !== colourOf({ className: aaCls }) || x7.textContent !== 'AA') throw new Error('TimesX7 colour');
    clickNav(w, /^Spacetime$/); const title = w.document.querySelector('tr.summary-space-title td'); if (colourOf(title) !== colourOf({ className: aaCls })) throw new Error('Spacetime title colour');
    clickNav(w, /^Spaces$|^Projects$/); const sc = w.document.querySelector('td[data-col="Space"] .space-color'); if (colourOf(sc) !== colourOf({ className: aaCls })) throw new Error('Spaces page colour');
  });
  await ta('Space colours: tampered/hostile Color values are ignored (no class injection), import keeps valid ones', async () => {
    const w = await weekBoot([], [lifeRow('AA', ''), lifeRow('BB', ''), lifeRow('CC', ''), lifeRow('DD', '')]);
    const g = wbOf(w); const rr = sheetOf(g, 'Road Map - Pending').rows; rr[0].Color = '5'; rr[1].Color = '99'; rr[2].Color = '1 onclick=x'; rr[3].Color = { a: 1 };
    await doImport(w, JSON.stringify(g)); const cols = sheetOf(wbOf(w), 'Road Map - Pending').rows.map(r => r.Color);
    if (cols[0] !== '5') throw new Error('valid colour lost: ' + JSON.stringify(cols));
    if (cols.some(c => !/^\d{1,2}$/.test(c) || Number(c) > 11) || new Set(cols).size !== 4) throw new Error('bad colours ' + JSON.stringify(cols));
    clickNav(w, /^Times$/); if (w.document.querySelector('[onclick]')) throw new Error('injected attribute');
  });

  /* ---- BackIn / NextIn wrap around (Spacetime, Times, NextIn, NoSpace) ---- */
  async function wrapBoot(n) {
    const w = await boot(); w.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {} });
    const g = wbOf(w); const mk = (i, extra) => blankTask(Object.assign({ Space: 'S' + i, 'Timeframe/Meeting': 't' + i }, extra || {}));
    const list = Array.from({ length: n }, (_, i) => mk(i));
    sheetOf(g, 'Daily planning - All tasks').rows = list.map(r => Object.assign({}, r));
    sheetOf(g, 'All future Tasks').rows = list.map(r => Object.assign({}, r));
    sheetOf(g, 'Completed tasks').rows = list.map(r => Object.assign({}, r, { Timing: 'Complete' }));
    await doImport(w, JSON.stringify(g)); return w;
  }
  const lbl = w => w.document.getElementById('taskPositionLabel').textContent;
  const prev = w => w.document.getElementById('taskPrevBtn'), next = w => w.document.getElementById('taskNextBtn');
  for (const [page, re, fmt] of [['Times', /^Times$/, (i, n) => 'Time ' + i + ' of ' + n], ['NextIn', /^NextIn$/, (i, n) => 'Time ' + i + ' of ' + n], ['NoSpace', /^NoSpace$/, (i, n) => i + ' of ' + n], ['Spacetime', /^Spacetime$/, (i, n) => 'Space ' + i + ' of ' + n]]) {
    await ta('BackIn/NextIn wrap on ' + page + ': 1 of 10 -> BackIn = 10 of 10 -> 9 of 10 -> NextIn = 10 of 10 -> NextIn = 1 of 10', async () => {
      const w = await wrapBoot(10); clickNav(w, re);
      const seq = [[null, 1], [prev, 10], [prev, 9], [next, 10], [next, 1], [next, 2], [prev, 1]];
      for (const [btn, want] of seq) {
        if (btn) { if (btn(w).disabled) throw new Error('button disabled before reaching ' + want); btn(w).click(); }
        if (lbl(w) !== fmt(want, 10)) throw new Error('expected "' + fmt(want, 10) + '" got "' + lbl(w) + '"');
      }
      if (w.__errs.length) throw new Error(w.__errs[0]);
    });
  }
  await ta('BackIn/NextIn wrap: the item shown actually changes (last item shown after BackIn from first)', async () => {
    const w = await wrapBoot(10); clickNav(w, /^Times$/); const shown = () => [...w.document.querySelectorAll('#tableBody .cell-editable')].map(e => e.textContent).join('|');
    const first = shown(); prev(w).click(); const last = shown(); if (!/t9/.test(last) || /t0/.test(last)) throw new Error('last page content: ' + last);
    next(w).click(); if (shown() !== first) throw new Error('did not return to first');
  });
  await ta('BackIn/NextIn disabled only when there is nothing to move to (0 or 1 items)', async () => {
    for (const n of [0, 1]) { const w = await wrapBoot(n); clickNav(w, /^Times$/); if (!prev(w).disabled || !next(w).disabled) throw new Error(n + ' items: buttons enabled'); }
    const w = await wrapBoot(2); clickNav(w, /^Times$/); if (prev(w).disabled || next(w).disabled) throw new Error('2 items: buttons disabled');
  });
  await ta('Finger swipes still stop at the ends (no wraparound); only the buttons wrap', async () => {
    const w = await wrapBoot(10); clickNav(w, /^Times$/); const swipe = (dx) => { const target = w.document.querySelector('#tableBody td') || w.document.querySelector('.content'); const a = new w.Event('touchstart', { bubbles: true }); a.touches = [{ clientX: 200, clientY: 100 }]; target.dispatchEvent(a); const b = new w.Event('touchend', { bubbles: true }); b.changedTouches = [{ clientX: 200 + dx, clientY: 100 }]; target.dispatchEvent(b); };
    swipe(120); if (lbl(w) !== 'Time 1 of 10') throw new Error('swipe back from first wrapped: ' + lbl(w));
    swipe(-120); if (lbl(w) !== 'Time 2 of 10') throw new Error('swipe forward failed: ' + lbl(w));
    for (let i = 0; i < 12; i++) swipe(-120); if (lbl(w) !== 'Time 10 of 10') throw new Error('swipe forward past last wrapped: ' + lbl(w));
  });

  /* ---- mutation fuzz of the import path ---- */
  await ta('Fuzz: 150 randomly type-confused/poisoned imports -> no crash, no pollution, storage always reloadable', async () => {
    let seed = 1337; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const pick = a => a[Math.floor(rnd() * a.length)];
    const pool = () => pick([null, 0, -1, 1e308, true, false, '', '__proto__', 'constructor', 'toString', 'a'.repeat(9000), [], {}, [[]], [null], '<img src=x onerror=alert(1)>', '\u0000\u202e', '=cmd|calc', 12.5, { text: 1 }, ['__proto__']]);
    function mutate(node, depth) {
      if (Array.isArray(node)) { node.forEach((v, i) => { if (rnd() < 0.06) node[i] = pool(); else if (v && typeof v === 'object') mutate(v, depth + 1); }); if (rnd() < 0.03) node.push(pool()); return node; }
      if (node && typeof node === 'object') {
        Object.keys(node).forEach(k => {
          if (rnd() < 0.06) node[k] = pool();
          else if (rnd() < 0.03) { const v = node[k]; delete node[k]; defineKey(node, pick(['__proto__', 'constructor', 'prototype', 'toString', 'x']), v); }
          else if (node[k] && typeof node[k] === 'object') mutate(node[k], depth + 1);
        });
        if (rnd() < 0.04) defineKey(node, pick(['__proto__', 'constructor']), { polluted_fuzz: 'y' });
      }
      return node;
    }
    const wk = await boot(); const base = protoNames(wk); const baseSheets = wbOf(wk);
    let accepted = 0, rejected = 0;
    for (let i = 0; i < 150; i++) {
      const doc = mutate(JSON.parse(JSON.stringify(baseSheets)), 0); let text; try { text = JSON.stringify(doc); } catch (e) { continue; }
      const before = wk.localStorage.getItem(DK); wk.__errs.length = 0;
      const alerts = await doImport(wk, text, 12);
      if (wk.__errs.length) throw new Error('iter ' + i + ' uncaught: ' + wk.__errs[0]);
      if (protoNames(wk) !== base || wk.eval('({}).polluted_fuzz!==undefined')) throw new Error('iter ' + i + ' polluted prototype');
      const after = wk.localStorage.getItem(DK); if (after !== before) accepted++; else rejected++;
      for (const b of navBtns(wk)) { b.click(); }
      if (wk.__errs.length) throw new Error('iter ' + i + ' render error: ' + wk.__errs[0]);
      if (i % 10 === 0) { const wr = await boot({ [DK]: after }); if (wr.__errs.length || !wr.document.getElementById('nav').children.length) throw new Error('iter ' + i + ' stored data not reloadable: ' + (wr.__errs[0] || 'nav empty')); if (protoNames(wr) !== base) throw new Error('iter ' + i + ' reload polluted'); }
    }
    results.push('      (fuzz: ' + accepted + ' imports accepted, ' + rejected + ' rejected)');
  });

  console.log(results.join('\n')); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
