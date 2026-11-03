const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { chromium, webkit } = require('playwright');
const ui = path.resolve(__dirname, '../../ui');
const fixtures = path.join(__dirname, 'fixtures');
const KEY = 'fixture-only-not-a-real-daemon-key';
const NONCE = 'fixture-csp-nonce';
const TOKEN = '0123456789abcdef0123456789abcdef';
const PAGE = `/_magpie/plugin/${TOKEN}/`;
const SERVICE = `${PAGE}_magpie/service/`;

// This server is a bounded fake, never Magpie or a vendor. It reproduces the
// opaque iframe and proxy CORS contract while executing the actual shipped UI.
async function fixtureServer(t) {
  const stockBridge = await fs.readFile(path.join(fixtures, 'stock-pagebridge.js'));
  const provenance = JSON.parse(await fs.readFile(path.join(fixtures, 'stock-pagebridge.provenance.json'), 'utf8'));
  assert.equal(crypto.createHash('sha256').update(stockBridge).digest('hex'), provenance.sha256);
  assert.equal(Object.keys(provenance.versions).length, 2);
  const state = {};
  function reset() {
    Object.assign(state, { running: false, run: null, progress: { phase: 'idle', completed: 0, total: 0, probesCompleted: 0, probesTotal: 3 }, statusFault: null, failScan: false, busyScan: false, starts: [], scanRequests: [], requests: [] });
  }
  reset();
  let origin;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      const json = (code, value, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(value)); };
      const html = async (filename, service = false) => {
        let body = await fs.readFile(path.join(ui, filename), 'utf8');
        if (service) body = body.replaceAll('__CODEX_MONITOR_BOOT__', JSON.stringify({ apiKey: KEY })).replaceAll('__CSP_NONCE__', NONCE);
        // The service's header permits connection schemes, then its actual inline
        // meta narrows them to the explicit current service root (old WebKit).
        const policy = service
          ? `sandbox allow-scripts; default-src 'none'; script-src 'nonce-${NONCE}'; style-src 'nonce-${NONCE}'; connect-src http: https:; frame-ancestors 'self'`
          : `sandbox allow-scripts; default-src 'none'; script-src ${origin}${PAGE}; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; frame-ancestors 'self'`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': policy, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
        res.end(body); // Crucially, boot HTML NEVER has ACAO.
      };
      if (url.pathname === '/parent') {
        const mode = url.searchParams.get('mode') || 'web';
        const lang = url.searchParams.get('lang') || 'en';
        const dark = url.searchParams.get('dark') === '1';
        const frameSrc = mode === 'direct' ? `${SERVICE}?lang=${lang}&dark=${dark ? 1 : 0}` : `${PAGE}page.html`;
        const service = mode === 'native' ? '' : '_magpie/service/';
        const parent = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0}iframe{width:100%;height:900px;display:block;border:0}</style><iframe id="plugin" sandbox="allow-scripts" src="${frameSrc}"></iframe><script>
window.fixtureMessages=[];window.fixtureErrors=[];
window.present=(data)=>document.querySelector('#plugin').contentWindow.postMessage({magpie:1,event:'theme',data},'*');
addEventListener('message',e=>{if(e.source!==document.querySelector('#plugin').contentWindow||e.data?.magpie!==1)return;const m=e.data;
if(m.method==='size')return;if(m.method==='error'){fixtureErrors.push(m.params);return;}fixtureMessages.push(m.method);
let result;if(m.method==='hello')result=${JSON.stringify({ dark, lang, tokens: {}, context: {}, service })};else if(m.method==='options.get')result={uiPort:${new URL(origin).port}};else return e.source.postMessage({magpie:1,id:m.id,error:'Unsupported stock call'},'*');
e.source.postMessage({magpie:1,id:m.id,result},'*');});</script>`;
        // Parent frame-src blocks an accidental real localhost/default-port
        // navigation before any network access, without Playwright interception.
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': `default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${origin}` }); res.end(parent); return;
      }
      if (url.pathname === `${PAGE}page.html`) return await html('page.html');
      if (url.pathname === `${PAGE}_magpie/bridge.js`) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(stockBridge); return; }
      if (url.pathname === `${PAGE}page.js`) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(await fs.readFile(path.join(ui, 'page.js'))); return; }
      const proxied = url.pathname.startsWith(SERVICE);
      const rel = proxied ? url.pathname.slice(SERVICE.length) : url.pathname.slice(1);
      if (rel === '') return await html('service.html', true);
      if (['panel-controller.js', 'service.js'].includes(rel)) { res.writeHead(200, { 'Content-Type': 'text/javascript', 'X-Content-Type-Options': 'nosniff' }); res.end(await fs.readFile(path.join(ui, rel))); return; }
      if (rel === 'api/status' || rel === 'api/scan') {
        const cors = { 'Access-Control-Allow-Origin': 'null', 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Codex-Monitor-Key' };
        state.requests.push({ path: url.pathname, method: req.method, origin: req.headers.origin, key: req.headers['x-codex-monitor-key'] });
        if (req.headers.origin !== 'null') return json(403, { error: 'origin' });
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
        if (req.headers['x-codex-monitor-key'] !== KEY) return json(403, { error: 'key' }, cors);
        if (rel === 'api/status' && req.method === 'GET') {
          if (state.statusFault === 'disconnect') { req.socket.destroy(); return; }
          if (state.statusFault) return json(state.statusFault, { error: 'fixture unavailable' }, cors);
          return json(200, { running: state.running, active: state.running ? { scope: state.run?.scope } : null, lastRun: state.run, progress: state.progress }, cors);
        }
        if (rel === 'api/scan' && req.method === 'POST') {
          let body = ''; for await (const chunk of req) body += chunk;
          const args = JSON.parse(body); state.scanRequests.push(args);
          if (!['all', 'enabled'].includes(args.scope)) return json(400, { error: 'scope' }, cors);
          if (state.failScan) { state.failScan = false; return json(503, { error: 'fixture start failure' }, cors); }
          const busy = state.running || state.busyScan; state.busyScan = false;
          state.running = true;
          state.run = { id: 'fixture-run', scope: args.scope, status: 'running', startedAt: '2026-11-03T04:00:00Z', accounts: [] };
          state.progress = { phase: 'probe', completed: 0, total: 2, probesCompleted: 1, probesTotal: 3 };
          if (!busy) state.starts.push(args.scope);
          return json(200, { started: !busy, busy, scope: args.scope }, cors);
        }
        return json(405, { error: 'method' }, cors);
      }
      res.writeHead(404); res.end('fixture: not found');
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { state, origin, reset };
}
async function open(browser, fixture, options = {}) {
  const context = await browser.newContext({ viewport: { width: options.width || 900, height: 900 }, colorScheme: options.dark ? 'light' : 'dark' });
  const page = await context.newPage(); page.setDefaultTimeout(9000);
  const errors = [], forbidden = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', request => { if (new URL(request.url()).origin !== fixture.origin) forbidden.push(request.url()); });
  // No request interception: exercise genuine browser CORS. The fake parent's
  // frame-src and the actual service's meta connect-src both restrict network
  // access to this ephemeral fixture, never real Magpie/default service ports.
  const params = new URLSearchParams({ mode: options.mode || 'web', lang: options.lang || 'en', dark: options.dark ? '1' : '0' });
  await page.goto(`${fixture.origin}/parent?${params}`);
  const frame = page.frameLocator('#plugin');
  await frame.locator('#all:not([disabled])').waitFor();
  return { context, page, frame, errors, forbidden };
}
async function refresh(page, frame) {
  await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/api/status') && r.request().method() === 'GET'), frame.locator('#refresh').click()]);
}
async function text(locator, value) { await locator.filter({ hasText: value }).waitFor(); }
async function settle(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ['chromium', 'webkit'])) {
  test(`${engine}: official service UI over real HTTP/CORS`, async t => {
    const browser = await (engine === 'webkit' ? webkit : chromium).launch(); t.after(() => browser.close());
    const fixture = await fixtureServer(t), { state } = fixture;
    await t.test('stock bridge web proxy: scopes, duplicate guard, progress, history and presentation-only messages', async () => {
      fixture.reset(); const { context, page, frame, errors, forbidden } = await open(browser, fixture);
      try {
        assert.match(page.frames().find(f => f.url().includes(SERVICE))?.url() || '', /_magpie\/service\/\?lang=en&dark=0$/);
        assert.deepEqual(await page.evaluate(() => fixtureMessages), ['hello'], 'web launcher never asks for options or custom tools');
        assert.equal((await fetch(fixture.origin + SERVICE)).headers.get('access-control-allow-origin'), null, 'HTML bootstrap is not CORS-readable');
        const all = frame.locator('#all'), enabled = frame.locator('#enabled');
        await all.click(); await frame.locator('#progress:not([hidden])').waitFor();
        assert.equal(await all.isDisabled(), true); assert.equal(await enabled.isDisabled(), true);
        await enabled.evaluate(b => b.click()); await all.evaluate(b => b.click());
        assert.deepEqual(state.starts, ['all']); assert.deepEqual(state.scanRequests, [{ scope: 'all', dry_run: false }]);
        assert.equal(await all.getAttribute('aria-pressed'), 'true');
        state.progress.completed = 1; state.progress.probesCompleted = 2; await refresh(page, frame);
        await text(frame.locator('#status'), 'Testing 1/2'); await text(frame.locator('#details'), 'Challenge 2/3');
        assert.equal(await frame.locator('#progress').evaluate(p => p.value), 1);
        state.progress.phase = 'applying'; await refresh(page, frame); await text(frame.locator('#status'), 'Applying results');
        state.running = false; state.progress = { phase: 'done', completed: 2, total: 2 };
        state.run = { ...state.run, status: 'done', finishedAt: '2026-11-03T04:05:00Z', accounts: [{ verdict: 'ok' }, { verdict: 'risk' }] };
        await refresh(page, frame); await frame.locator('#all:not([disabled])').waitFor(); await text(frame.locator('#status'), 'Complete');
        await text(frame.locator('#details'), 'Normal 1'); await text(frame.locator('#details'), 'Held back 1');
        assert.equal(await frame.locator('#progress').isHidden(), true);
        await enabled.click(); await frame.locator('#progress:not([hidden])').waitFor(); assert.deepEqual(state.starts, ['all', 'enabled']);
        state.running = false; state.run = { ...state.run, status: 'interrupted' }; await refresh(page, frame); await text(frame.locator('#status'), 'Interrupted');
        await frame.locator('#all:not([disabled])').waitFor(); state.failScan = true; await all.click(); await frame.locator('#error:not([hidden])').waitFor(); await text(frame.locator('#error'), 'HTTP 503');
        await refresh(page, frame); await frame.locator('#all:not([disabled])').waitFor();
        const count = state.scanRequests.length;
        await page.evaluate(() => { present({ lang: 'zh', dark: true }); const w = document.querySelector('#plugin').contentWindow; w.postMessage({ magpie: 1, event: 'scan', data: { scope: 'all' } }, '*'); w.postMessage({ magpie: 1, method: 'tools.call', params: { name: 'codex_route_scan' } }, '*'); });
        await text(frame.locator('#title'), '路由检测'); assert.equal(await all.textContent(), '测试全部');
        assert.equal(await frame.locator('html').getAttribute('data-dark'), 'true');
        await page.evaluate(() => { const f = document.createElement('iframe'); f.srcdoc = '<script>parent.frames[0].postMessage({magpie:1,event:"theme",data:{lang:"en",dark:false}},"*")<\/script>'; document.body.appendChild(f); });
        await settle(page); assert.equal(await all.textContent(), '测试全部', 'sibling cannot change presentation'); assert.equal(state.scanRequests.length, count, 'messages never start scans');
        assert.ok(state.requests.some(r => r.method === 'OPTIONS'), 'real opaque-origin CORS preflight occurred');
        assert.ok(state.requests.filter(r => r.method !== 'OPTIONS').every(r => r.origin === 'null' && r.key === KEY && r.path.startsWith(SERVICE)));
        assert.deepEqual(forbidden, []); assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => fixtureErrors), []);
      } finally { await context.close(); }
    });
    await t.test('503 and disconnected HTTP automatically resume polling without a new scan', async () => {
      fixture.reset(); const { context, page, frame, errors } = await open(browser, fixture);
      try {
        state.statusFault = 503; await refresh(page, frame); await frame.locator('#error:not([hidden])').waitFor();
        assert.equal(await frame.locator('#all').isDisabled(), true); await text(frame.locator('#status'), 'Reconnecting');
        state.statusFault = null; await frame.locator('#all:not([disabled])').waitFor({ timeout: 8000 }); assert.equal(await frame.locator('#error').isHidden(), true);
        state.statusFault = 'disconnect';
        const failed = page.waitForEvent('requestfailed', { predicate: r => new URL(r.url()).pathname.endsWith('/api/status') });
        await frame.locator('#refresh').click(); await failed; await frame.locator('#error:not([hidden])').waitFor();
        state.statusFault = null; await frame.locator('#all:not([disabled])').waitFor({ timeout: 8000 });
        assert.deepEqual(state.starts, []); assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    await t.test('stock native fallback uses the normalized configured service port', async () => {
      fixture.reset(); const { context, page, frame, errors, forbidden } = await open(browser, fixture, { mode: 'native' });
      try {
        assert.equal(new URL(page.frames().find(f => f.url().startsWith(fixture.origin + '/?'))?.url()).pathname, '/');
        assert.deepEqual(await page.evaluate(() => fixtureMessages), ['hello', 'options.get']);
        await frame.locator('#enabled').click(); await frame.locator('#progress:not([hidden])').waitFor();
        assert.ok(state.requests.filter(r => r.method !== 'OPTIONS').every(r => !r.path.startsWith(PAGE)));
        assert.deepEqual(forbidden, []); assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    for (const width of [1280, 900, 390]) for (const dark of [false, true]) for (const lang of ['en', 'zh']) {
      await t.test(`layout ${width}px ${dark ? 'dark' : 'light'} ${lang}`, async () => {
        fixture.reset(); const { context, frame, errors, forbidden } = await open(browser, fixture, { width, dark, lang });
        try {
          assert.equal(await frame.locator('#title').textContent(), lang === 'en' ? 'Route check' : '路由检测');
          assert.equal(await frame.locator('#enabled').textContent(), lang === 'en' ? 'Test enabled' : '测试已启用');
          assert.equal(await frame.locator('html').getAttribute('data-dark'), String(dark));
          const dimensions = await frame.locator('body').evaluate(b => ({ width: b.scrollWidth, viewport: innerWidth, bg: getComputedStyle(b).backgroundColor }));
          assert.ok(dimensions.width <= dimensions.viewport + 1, JSON.stringify(dimensions));
          assert.equal(dimensions.bg, dark ? 'rgb(30, 29, 27)' : 'rgb(250, 249, 247)');
          for (const id of ['all', 'enabled', 'refresh']) { const box = await frame.locator('#' + id).boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width + 1); }
          assert.deepEqual(forbidden, []); assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });
    }
  });
}
