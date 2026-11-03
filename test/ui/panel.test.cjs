const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { chromium, webkit } = require('playwright');
const ui = path.resolve(__dirname, '../../ui');
const languages = { en: ['Test all', 'Test enabled'], zh: ['测试全部', '测试已启用'], 'zh-TW': ['測試全部', '測試已啟用'], ja: ['すべてテスト', '有効のみテスト'], de: ['Alle testen', 'Aktivierte testen'] };
const parent = `<!doctype html><style>body{margin:0}iframe{width:100%;height:600px;border:0}</style><iframe sandbox="allow-scripts" src="/ui/panel.html"></iframe><script>
addEventListener('message',async e=>{if(e.source!==document.querySelector('iframe').contentWindow||!e.data?.fixture)return;const m=e.data;const r=await fetch('/tool',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m)});const v=await r.json();e.source.postMessage({fixture:1,id:m.id,...v},'*')});
</script>`;
function bridge(lang) { return `(()=>{let id=0;const pending=new Map();addEventListener('message',e=>{if(e.source!==parent||!e.data?.fixture)return;const p=pending.get(e.data.id);if(!p)return;pending.delete(e.data.id);if(e.data.error)p.reject(new Error(e.data.error));else p.resolve(e.data.result)});window.magpie={context:{provider:{id:'codex',name:'Codex'}},ready:Promise.resolve({lang:${JSON.stringify(lang)},tokens:{}}),onTheme(){},onVisibility(){},tools:{call(name,args){const key=++id;return new Promise((resolve,reject)=>{pending.set(key,{resolve,reject});parent.postMessage({fixture:1,id:key,name,args},'*')})}}}})();`; }

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ['chromium', 'webkit'])) {
  test(`${engine}: manual scope buttons, progress, completion and errors`, async (t) => {
    const browser = await (engine === 'webkit' ? webkit.launch() : chromium.launch());
    t.after(() => browser.close());
    for (const [lang, labels] of Object.entries(languages)) {
      for (const width of [700, 330]) {
        const context = await browser.newContext({ viewport: { width, height: 800 } });
        try {
          const page = await context.newPage(); page.setDefaultTimeout(8000);
          const errors = [], calls = [];
          let running = false, run = null, fail = false, completed = 0, legacy = false;
          page.on('pageerror', e => errors.push(e.message));
          await page.route('http://panel.test/**', async route => {
            const url = new URL(route.request().url());
            if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: parent });
            if (url.pathname === '/tool') {
              const b = route.request().postDataJSON(); calls.push({ name: b.name, args: b.args });
              let result;
              if (b.name === 'codex_route_scan') {
                if (fail) { fail = false; result = { started: false, busy: false, error: 'fixture: spawn failed' }; }
                else { running = true; completed = 0; run = { id: 'manual', scope: b.args.scope, status: 'running', startedAt: '2026-11-03T04:00:00Z', accounts: [] }; result = { started: true, busy: false, scope: b.args.scope }; }
              } else result = { running, active: running ? { scope: run.scope } : null, lastRun: run, progress: { phase: running ? 'probe' : run?.status, completed: legacy ? 0 : completed, total: legacy ? null : run ? 2 : 0, probesCompleted: 1, probesTotal: 3, attempts: 1 } };
              return route.fulfill({ json: { result: { text: JSON.stringify(result) } } });
            }
            if (url.pathname.endsWith('/_magpie/bridge.js')) return route.fulfill({ contentType: 'text/javascript', body: bridge(lang) });
            const file = path.join(ui, path.basename(url.pathname));
            try { return route.fulfill({ contentType: file.endsWith('.html') ? 'text/html' : 'text/javascript', headers: file.endsWith('.html') ? { 'Content-Security-Policy': "sandbox allow-scripts; connect-src 'none'" } : {}, body: await fs.readFile(file) }); }
            catch { return route.fulfill({ status: 404, body: '' }); }
          });
          await page.goto('http://panel.test/');
          const frame = page.frameLocator('iframe');
          const all = frame.locator('#test-all'), enabled = frame.locator('#test-enabled');
          await all.waitFor({ state: 'visible' });
          await page.waitForFunction(() => !!document.querySelector('iframe'));
          await assertEnabled(all);
          assert.equal(await all.textContent(), labels[0]); assert.equal(await enabled.textContent(), labels[1]);
          const scanReply = scope => page.waitForResponse(r => new URL(r.url()).pathname === '/tool' && r.request().postDataJSON()?.name === 'codex_route_scan' && r.request().postDataJSON()?.args?.scope === scope);
          await Promise.all([scanReply('all'), all.click()]);
          await assertDisabled(all); await assertDisabled(enabled);
          assert.deepEqual(calls.filter(c => c.name === 'codex_route_scan').map(c => c.args), [{ scope: 'all', dry_run: false }]);
          await enabled.evaluate(b => b.click());
          assert.equal(calls.filter(c => c.name === 'codex_route_scan').length, 1, 'disabled button cannot dispatch another scan');
          await frame.locator('#progress:not([hidden])').waitFor();
          assert.equal(await all.getAttribute('aria-pressed'), 'true');
          assert.equal(await enabled.getAttribute('aria-pressed'), 'false');
          assert.match(await frame.locator('#details').textContent(), /1.*2/);
          assert.ok(await frame.locator('body').evaluate(b => b.scrollWidth <= innerWidth + 1), `${engine}/${lang}/${width}: panel fits`);
          completed = 2; running = false; run = { ...run, status: 'done', finishedAt: '2026-11-03T04:05:00Z', accounts: [{ verdict: 'ok' }, { verdict: 'risk' }] };
          legacy = true;
          await frame.locator('#refresh').click(); await assertEnabled(all);
          assert.ok((await frame.locator('#status').textContent()).length > 0, 'completed legacy history stays meaningful');
          assert.equal(await frame.locator('#results').getAttribute('data-tone'), 'risk');
          assert.match(await frame.locator('#results').textContent(), /1/);
          assert.ok((await frame.locator('#updated').textContent()).length <= 5, 'date is a tooltip, only time is visible');
          assert.equal(await frame.locator('#note').count(), 0, 'no permanent instruction paragraph');
          assert.equal((await frame.locator('#refresh').textContent()).trim(), '', 'refresh is a quiet icon');
          assert.ok((await frame.locator('#monitor').boundingBox()).height <= 90, 'idle panel is compact');
          legacy = false;
          await Promise.all([scanReply('enabled'), enabled.click()]); await assertDisabled(enabled);
          assert.deepEqual(calls.filter(c => c.name === 'codex_route_scan').at(-1).args, { scope: 'enabled', dry_run: false });
          running = false; run = { ...run, status: 'interrupted' };
          await frame.locator('#refresh').click(); await assertEnabled(all);
          fail = true;
          await Promise.all([scanReply('all'), all.click()]); await assertEnabled(all);
          await frame.locator('#status[data-error="true"]').waitFor();
          assert.match(await frame.locator('#status').textContent(), /fixture: spawn failed/);
          assert.equal(errors.length, 0, `${engine}/${lang}/${width}: ${errors.join('; ')}`);
        } finally { await context.close(); }
      }
    }
  });
}
async function assertEnabled(button) { await button.evaluate(b => new Promise((resolve, reject) => { if (!b.disabled) return resolve(); const timer = setTimeout(() => { observer.disconnect(); reject(Error('button remained disabled')); }, 7000); const observer = new MutationObserver(() => { if (!b.disabled) { clearTimeout(timer); observer.disconnect(); resolve(); } }); observer.observe(b, { attributes: true, attributeFilter: ['disabled'] }); })); }
async function assertDisabled(button) { assert.equal(await button.isDisabled(), true); }
