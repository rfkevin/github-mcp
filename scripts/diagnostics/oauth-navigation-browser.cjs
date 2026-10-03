// Optional browser regression: PLAYWRIGHT_MODULE may identify an installed package.
// No remote services or user sessions: all four origins are local HTTP servers.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
function load(file) {
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, URL, Response, Headers,
    require: name => load(path.resolve(path.dirname(file), name + '.ts')) });
  return exports;
}
const { consentPage, consentPagePolicy } = load(path.resolve('src/auth/consent.ts'));
const { navigationPage } = load(path.resolve('src/auth/navigation.ts'));
async function start(handler) {
  const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(error => { res.writeHead(500).end(); console.error(error); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: 'http://127.0.0.1:' + server.address().port };
}
(async () => {
  const origins = []; let mode = 'before'; const decisions = [];
  for (let i = 0; i < 4; i++) origins.push(await start(async (req, res) => {
    const redirect = location => { res.writeHead(302, { Location: location }); res.end(); };
    if (i === 0 && req.url === '/authorize' && req.method === 'GET') {
      const details = { scope: ['mcp:read'], clientName: 'Browser fixture', redirectHost: '127.0.0.1', redirectUri: origins[2].origin + '/callback' };
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': consentPagePolicy(details.redirectUri, 'test-nonce').replace('https://github.com', origins[1].origin) });
      res.end(consentPage(details, 'synthetic-handle', 'test-nonce')); return;
    }
    if (i === 0 && req.url === '/authorize') {
      let body = ''; for await (const chunk of req) body += chunk;
      decisions.push(new URLSearchParams(body).getAll('decision'));
      const target = decisions.at(-1)[0] === 'deny' ? origins[2].origin + '/callback' : origins[1].origin + '/upstream';
      if (mode === 'before') { redirect(target); return; }
      const page = navigationPage(target, new Headers());
      res.writeHead(page.status, Object.fromEntries(page.headers)); res.end(await page.text()); return;
    }
    if (i === 1) { redirect(origins[0].origin + '/callback'); return; }
    if (i === 0 && req.url === '/callback') { redirect(origins[2].origin + '/callback'); return; }
    if (i === 2) { redirect(origins[3].origin + '/complete'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>Connection complete</h1>');
  }));
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    for (const scenario of [{ mode: 'before', decision: 'approve' }, { mode: 'after', decision: 'approve' }, { mode: 'after', decision: 'deny' }]) {
      mode = scenario.mode; const page = await browser.newPage(); const errors = [];
      page.on('console', message => { if (/form-action/.test(message.text())) errors.push(message.text()); });
      await page.goto(origins[0].origin + '/authorize'); const initialCount = decisions.length;
      const guard = await page.evaluate(decision => {
        const form = document.querySelector('form'); const button = form.querySelector('[value="' + decision + '"]');
        form.requestSubmit(button); form.requestSubmit(button);
        return { disabled: [...form.querySelectorAll('button')].every(b => b.disabled), busy: form.getAttribute('aria-busy'), status: document.getElementById('connection-status').textContent };
      }, scenario.decision);
      assert.equal(guard.disabled, true); assert.equal(guard.busy, 'true'); assert.ok(guard.status.includes('cours'));
      if (mode === 'after') {
        await page.waitForURL(origins[3].origin + '/complete', { timeout: 10000 });
        assert.equal(await page.locator('h1').textContent(), 'Connection complete'); assert.equal(errors.length, 0);
      } else {
        await page.waitForTimeout(700); assert.ok(errors.length > 0, 'The old redirect chain must reproduce the CSP failure');
        assert.notEqual(page.url(), origins[3].origin + '/complete');
      }
      assert.equal(decisions.length - initialCount, 1, 'Only one POST after repeated submit');
      assert.deepEqual(decisions.at(-1), [scenario.decision]);
      console.log(JSON.stringify({ ...scenario, singlePost: true, decisionPreserved: true, cspBlocked: errors.length > 0, reachedClient: mode === 'after' }));
      await page.close();
    }
  } finally { await browser.close(); await Promise.all(origins.map(({ server }) => new Promise(resolve => server.close(resolve)))); }
})().catch(error => { console.error(error); process.exitCode = 1; });
