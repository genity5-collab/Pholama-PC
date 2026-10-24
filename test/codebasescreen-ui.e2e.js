// Real Chrome + the REAL Codebase routes (codebase-api.js, real SSE stream, real grants, real approvals) + the REAL screen.
// Only the AI is scripted and the Windows runner is a recorder, so no credits are spent and nothing on the PC is touched.
const { spawn, spawnSync } = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path'); const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const chrome = process.env.CHROME_BIN || 'google-chrome';
  if (spawnSync(chrome, ['--version'], { stdio: 'ignore' }).status !== 0) { console.log('SKIPPED: Chrome is not installed here'); process.exit(0); }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-cbs-')); process.env.PHOLAMA_HOME = path.join(home, 'data'); fs.mkdirSync(process.env.PHOLAMA_HOME, { recursive: true });
  const API = require('../server/codebase-api'), grants = require('../server/codebase-grants'), budget = require('../server/codebase-budget');
  const proj = path.join(home, 'proj'); fs.mkdirSync(proj);
  const tool = o => '<tool>' + JSON.stringify(o) + '</tool>';
  let script = [], si = 0; const ranOnPc = [];
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ reply: si < script.length ? script[si++] : tool({ name: 'done', summary: 'All finished.' }), credits_left: 1400, week_cap: 1500, cost: 5 }) });
  const api = API.create({ grants, budget, fetchFn, cloudUrl: 'http://cloud.test/x', win: { execute: async pl => { if (!/Pholama-Agent-Notes/.test(String(pl.path || pl.title || ''))) ranOnPc.push(pl.kind); return { ok: true, text: 'did ' + pl.kind }; } }, github: { execute: async () => ({ ok: false, text: 'no' }) } });
  const web = path.join(__dirname, '..', 'web'), MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' };
  const srv = http.createServer(async (req, res) => { const u = new URL(req.url, 'http://x'); req.who = 'local';
    if (await api.handle(req, res, u.pathname, u)) return;
    const f = path.join(web, u.pathname === '/' ? 'cbs-host.html' : u.pathname); if (!f.startsWith(web) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' }); res.end(fs.readFileSync(f)); }).listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r)); const port = srv.address().port;
  fs.writeFileSync(path.join(web, 'cbs-host.html'), '<!doctype html><html><head><link rel="stylesheet" href="ide-theme.css"><link rel="stylesheet" href="usagebar.css"><link rel="stylesheet" href="codebasescreen.css"></head><body style="margin:0"><div id="cbUsage"></div><div id="codebase"></div><script src="usagebar.js"></script><script src="codebaseusage.js"></script></body></html>');
  const dbg = 9800 + Math.floor(Math.random() * 500);
  const ch = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${dbg}`, `--user-data-dir=${home}/c`, 'about:blank'], { stdio: 'ignore' });
  let bad = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + String(x).slice(0, 300))); if (!c) bad++; };
  const done = () => { try { ch.kill(); } catch {} try { srv.close(); } catch {} try { fs.unlinkSync(path.join(web, 'cbs-host.html')); } catch {} };
  try {
    let tabs; for (let i = 0; i < 40; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${dbg}/json`)).json(); if (tabs.length) break; } catch {} await wait(250); }
    const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    let id = 0; const pend = new Map(), errs = [];
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errs.push(String(m.params.exceptionDetails.text + ' ' + ((m.params.exceptionDetails.exception || {}).description || '')).slice(0, 200)); if (m.id && pend.has(m.id)) pend.get(m.id)(m.result || {}); };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => { const r = await Promise.race([send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }), new Promise(res => setTimeout(() => res({ result: { value: 'EV_TIMEOUT' } }), 8000))]); return r.result ? r.result.value : r; };
    await send('Runtime.enable'); await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await wait(1200);
    // mount the real screen, signed in with a fake login that the scripted model ignores
    await ev(`(async () => { const m = await import('./codebasescreen.js'); window.__s = m.mountCodebase(document.querySelector('#codebase'), { getToken: () => window.__tok === undefined ? 'FAKE-LOGIN' : window.__tok, getGithubToken: () => '' }); await window.__s.open(); return 1; })()`);
    const txt = () => ev("document.querySelector('#codebase').innerText"), q = s => ev(`document.querySelectorAll(${JSON.stringify(s)}).length`);
    const t0 = await txt();
    ok('the screen mounts with a task box, Start and Stop', /Codebase/.test(t0) && (await q('#cbsTask')) === 1 && (await q('#cbsStart')) === 1 && (await q('#cbsStop')) === 1, t0.slice(0, 200));
    ok('the real usage bar is on the page with the 15,000 monthly total', /Current month/.test(await ev("document.querySelector('#cbUsage').innerText")) && /15,000/.test(await ev("document.querySelector('#cbUsage').innerText")));
    ok('Stop starts switched off', (await ev("document.querySelector('#cbsStop').disabled")) === true);
    ok('with no folders it says so', /No folders yet/.test(t0));

    // folders, through the real route
    await ev(`(() => { document.querySelector('#cbsDir').value = ${JSON.stringify(proj)}; document.querySelector('#cbsMode').value = 'write'; document.querySelector('#cbsGrant').click(); })()`); await wait(600);
    const t1 = await txt(); ok('a granted folder is listed with its access', t1.includes(proj) && /read \+ change/.test(t1), t1.slice(0, 300));
    ok('the server really holds that grant', grants.list().some(g => g.dir && g.dir.replace(/\\/g, '/').endsWith('/proj')));
    await ev(`(() => { document.querySelector('#cbsDir').value = '/'; document.querySelector('#cbsGrant').click(); })()`); await wait(500);
    ok('granting the whole drive is refused, with a reason shown', /./.test(await ev("document.querySelector('#cbsMsg').textContent")) && grants.list().length === 1, await ev("document.querySelector('#cbsMsg').textContent"));

    // not signed in
    await ev("window.__tok = ''"); await ev("(() => { document.querySelector('#cbsTask').value = 'make a page'; document.querySelector('#cbsStart').click(); })()"); await wait(400);
    ok('not signed in: asks to sign in and starts nothing', /Sign in/.test(await ev("document.querySelector('#cbsMsg').textContent")) && !api.session.state().running);
    await ev("window.__tok = undefined");

    // a full run with an approval: note, edit (needs Allow), done
    script = [tool({ name: 'note_', args: { text: 'plan: write the menu page' } }), tool({ name: 'edit_file', path: path.join(proj, 'menu.html'), content: '<h1>Menu</h1>' })]; si = 0;
    await ev("(() => { document.querySelector('#cbsTask').value = 'make a menu page'; document.querySelector('#cbsStart').click(); })()"); await wait(1500);
    const t2 = await txt();
    ok('the note appears live in the feed', /write the menu page/.test(t2), t2.slice(0, 400));
    ok('the edit is waiting with Allow and Deny buttons', (await q('.cbs-ask')) === 1 && (await q('.cbs-allow')) === 1 && (await q('.cbs-deny')) === 1, t2.slice(0, 400));
    ok('while running: Start is off, Stop is on', (await ev("document.querySelector('#cbsStart').disabled")) === true && (await ev("document.querySelector('#cbsStop').disabled")) === false);
    ok('NOTHING touched the PC before Allow', ranOnPc.length === 0, ranOnPc.join());
    await ev("document.querySelector('.cbs-deny').click()"); await wait(1200);
    const t3 = await txt();
    ok('Deny removes the card and the edit never ran', (await q('.cbs-ask')) === 0 && !ranOnPc.includes('write') && /You said No/.test(t3), t3.slice(0, 500));
    ok('the run finishes and the buttons come back', await (async () => { for (let i = 0; i < 20; i++) { if ((await ev("document.querySelector('#cbsStart').disabled")) === false) return true; await wait(300); } return false; })());
    ok('the end of the run is stated plainly', /Finished|stopped|Stopped/.test(await ev("document.querySelector('#cbsMsg').textContent")), await ev("document.querySelector('#cbsMsg').textContent"));

    // a second run: Allow this time
    script = [tool({ name: 'note_', args: { text: 'second try: write the menu again' } }), tool({ name: 'edit_file', path: path.join(proj, 'menu.html'), content: '<h1>Menu</h1>' })]; si = 0; ranOnPc.length = 0;   // the agent must note before it edits
    await ev("(() => { document.querySelector('#cbsTask').value = 'again'; document.querySelector('#cbsStart').click(); })()"); await wait(1500);
    ok('second run asks again', (await q('.cbs-ask')) === 1);
    await ev("document.querySelector('.cbs-allow').click()"); await wait(1500);
    ok('Allow runs the edit exactly once', ranOnPc.filter(k => k === 'write').length === 1, ranOnPc.join());

    // Stop mid-run
    script = [tool({ name: 'note_', args: { text: 'third: a second page' } }), tool({ name: 'edit_file', path: path.join(proj, 'b.html'), content: 'x' })]; si = 0; ranOnPc.length = 0;
    await ev("(() => { document.querySelector('#cbsTask').value = 'stop me'; document.querySelector('#cbsStart').click(); })()"); await wait(1200);
    await ev("document.querySelector('#cbsStop').click()"); await wait(1200);
    ok('Stop ends the run and nothing was changed', !api.session.state().running && !ranOnPc.includes('write'), JSON.stringify(api.session.state()));
    ok('after Stop the buttons come back', (await ev("document.querySelector('#cbsStart').disabled")) === false);

    // hostile text from the AI never becomes live HTML
    script = [tool({ name: 'note_', args: { text: '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>' } })]; si = 0;
    await ev("(() => { document.querySelector('#cbsTask').value = 'evil'; document.querySelector('#cbsStart').click(); })()"); await wait(1800);
    ok('hostile AI text is shown as text, never run', (await ev('window.__pwn === undefined')) === true && (await q('#cbsFeed img')) === 0 && (await q('#cbsFeed script')) === 0);

    // nothing names the model or the provider anywhere on the screen
    const all = await ev("document.querySelector('#codebase').innerText + ' ' + document.querySelector('#codebase').innerHTML");
    ok('no model or provider name appears on the screen', !/qwen|free\.ai|mistral|deepseek/i.test(all));
    ok('the login token never appears on the page', !/FAKE-LOGIN/.test(all));
    ok('no script errors happened', errs.length === 0, errs.join(' | '));
    await send('Page.captureScreenshot', {}).then(r => { if (process.env.SHOTS && r.data) fs.writeFileSync(path.join(process.env.SHOTS, 'codebase.png'), Buffer.from(r.data, 'base64')); });
  } catch (e) { ok('the test ran to the end', false, e && e.stack); }
  done(); console.log(bad ? 'FAILED ' + bad : 'ALL PASSED'); process.exit(bad ? 1 : 0);
})();
