'use strict';
// Pholama Codebase routes, tested over a REAL http server with fake effects (cloud, Windows, GitHub): who may call, size limits,
// the login never lingering, grants, approvals, Stop, and plain-words errors.
const http = require('http'), os = require('os'), fs = require('fs'), path = require('path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pholama-routes-')); process.env.PHOLAMA_HOME = HOME;
const API = require('../server/codebase-api');
const grants = require('../server/codebase-grants'), budget = require('../server/codebase-budget');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(10); } return false; };
const tool = o => '<tool>' + JSON.stringify(o) + '</tool>';

function boot(o = {}) {
  const { script, cloud, github, win } = o, who = Object.prototype.hasOwnProperty.call(o, 'who') ? o.who : 'local';
  let i = 0; const cloudCalls = [];
  const fetchFn = cloud || (async (url, o) => { cloudCalls.push(JSON.parse(o.body)); const reply = i < script.length ? script[i++] : tool({ name: 'done', summary: 'end' }); return { ok: true, status: 200, json: async () => ({ reply, credits_left: 1400, week_cap: 1500, cost: 5 }) }; });
  const winCalls = [], ghCalls = [];
  const api = API.create({
    grants, budget, fetchFn, cloudUrl: 'http://cloud.test/x',
    win: win || { execute: async pl => { const isNotes = (pl.path && /Pholama-Agent-Notes\.txt$/.test(String(pl.path))) || (pl.kind === 'close' && /Pholama-Agent-Notes/.test(String(pl.title))); if (!isNotes) winCalls.push(pl); return { ok: true, text: 'did ' + pl.kind }; } },   // the notes window is the agent's own and is counted separately
    github: github || { execute: async (pl, o) => { ghCalls.push({ pl, token: o.token }); return { ok: true, text: 'gh ok' }; } },
  });
  const server = http.createServer(async (req, res) => { req.who = who; const u = new URL(req.url, 'http://x'); if (!(await api.handle(req, res, u.pathname, u))) { res.writeHead(404); res.end('{}'); } });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ api, server, port: server.address().port, cloudCalls, winCalls, ghCalls, close: () => new Promise(x => server.close(x)) })));
}
function bootWith(o) {
  let i = 0; const script = o.script;
  const fetchFn = async (url, init) => { if (o.hangAfter && i >= o.hangAfter) return new Promise((_, rej) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); })); const reply = i < script.length ? script[i++] : tool({ name: 'done', summary: 'end' }); return { ok: true, status: 200, json: async () => ({ reply, credits_left: 1400, week_cap: 1500, cost: 5 }) }; };
  const api = API.create({ grants, budget, fetchFn, cloudUrl: 'http://cloud.test/x', win: { execute: async () => ({ ok: true, text: 'ok' }) }, github: { execute: async () => ({ ok: true, text: 'ok' }) }, notepad: o.notepad });
  const server = http.createServer(async (req, res) => { req.who = 'local'; const u = new URL(req.url, 'http://x'); if (!(await api.handle(req, res, u.pathname, u))) { res.writeHead(404); res.end('{}'); } });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ api, server, port: server.address().port, close: () => new Promise(x => server.close(x)) })));
}
function call(port, method, p, body, headers = {}) {
  return new Promise(resolve => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, json: j, text: d }); });
    });
    req.on('error', e => resolve({ status: 0, error: e.message }));
    if (data) req.write(data); req.end();
  });
}
const TOKEN = { 'x-pholama-token': 'LOGIN-TOKEN-123' };

(async () => {
  // ---- who may call ----
  { const s = await boot({ who: 'remote', script: [] });
    for (const [m, p] of [['GET', '/api/codebase/state'], ['GET', '/api/codebase/grants'], ['POST', '/api/codebase/start'], ['POST', '/api/codebase/stop'], ['POST', '/api/codebase/answer'], ['POST', '/api/codebase/grants'], ['DELETE', '/api/codebase/grants']]) {
      const r = await call(s.port, m, p, {}, TOKEN); ok('a remote caller is refused: ' + m + ' ' + p, r.status === 403 && s.cloudCalls.length === 0);
    }
    await s.close(); }
  for (const who of [undefined, null, '', 'LOCAL', 'admin', 'key:abc']) { const s = await boot({ who, script: [] }); const r = await call(s.port, 'GET', '/api/codebase/state'); ok('only exactly "local" is allowed (who=' + JSON.stringify(who) + ')', r.status === 403); await s.close(); }
  { const s = await boot({ script: [] }); const r = await call(s.port, 'GET', '/api/other'); ok('other routes are not touched', r.status === 404); await s.close(); }

  // ---- state ----
  { const s = await boot({ script: [] }); const r = await call(s.port, 'GET', '/api/codebase/state');
    ok('state works for this PC', r.status === 200 && r.json.running === false && Array.isArray(r.json.pending));
    ok('state carries the usage bar (15,000 a month)', r.json.usage && r.json.usage.cap === 15000 && r.json.usage.left === 15000);
    ok('state carries the folder grants', Array.isArray(r.json.grants));
    ok('state never contains the login', !r.text.includes('LOGIN-TOKEN'));
    await s.close(); }

  // ---- start needs a login, a task ----
  { const s = await boot({ script: [] });
    let r = await call(s.port, 'POST', '/api/codebase/start', { task: 'hi' });
    ok('no login: plain sign-in message, nothing started', r.status === 401 && /Sign in/.test(r.json.error) && s.cloudCalls.length === 0);
    r = await call(s.port, 'POST', '/api/codebase/start', { task: '   ' }, TOKEN); ok('blank task refused in plain words', r.status === 409 && /Tell the agent/.test(r.json.error));
    r = await call(s.port, 'POST', '/api/codebase/start', { task: 'x'.repeat(4001) }, TOKEN); ok('a task over 4,000 characters is refused', r.status === 409 && /too long/.test(r.json.error));
    r = await call(s.port, 'POST', '/api/codebase/start', { task: ['a'] }, TOKEN); ok('a task that is not text is refused safely', r.status === 409 || r.status === 200);
    await s.close(); }

  // ---- a full run, end to end ----
  { const s = await boot({ script: [tool({ name: 'note_', text: 'plan: add a menu' }), tool({ name: 'done', summary: 'menu added' })] });
    const r = await call(s.port, 'POST', '/api/codebase/start', { task: 'add a menu' }, TOKEN);
    ok('start returns a run id', r.status === 200 && r.json.ok && /^r\d+-/.test(r.json.id));
    ok('the run finishes', await until(async () => (await call(s.port, 'GET', '/api/codebase/state')).json.done === true));
    const st = (await call(s.port, 'GET', '/api/codebase/state')).json;
    ok('the result says it worked', st.result && st.result.ok === true);
    ok('the login was sent to the cloud as the person\'s own', s.cloudCalls.length >= 2 && s.cloudCalls.every(c => c.codebase === true && c.studio === true));
    ok('the login is wiped once the run is over', await until(async () => s.api.state.token === ''));
    ok('credits from the cloud reach the page', (await call(s.port, 'GET', '/api/codebase/state')).json.credits.left === 1400);
    await s.close(); }

  // ---- model choice: simple vs hard ----
  { const s = await boot({ script: [tool({ name: 'done', summary: 'ok' })] }); await call(s.port, 'POST', '/api/codebase/start', { task: 'a', kind: 'hard' }, TOKEN); await until(() => s.cloudCalls.length >= 1);
    ok('kind "hard" asks for the stronger coder', s.cloudCalls[0].model === 'qwen3-coder'); await s.close(); }
  for (const k of [undefined, 'simple', 'x', 5, null, 'HARD', {}, 'constructor']) { const s = await boot({ script: [tool({ name: 'done', summary: 'ok' })] }); await call(s.port, 'POST', '/api/codebase/start', { task: 'a', kind: k }, TOKEN); await until(() => s.cloudCalls.length >= 1); ok('kind ' + JSON.stringify(k) + ' uses the cheap coder, never an unlisted model', s.cloudCalls[0].model === 'qwen-coder'); await s.close(); }

  // ---- only one run at a time ----
  { const s = await boot({ script: [tool({ name: 'note_', text: 'a' }), tool({ name: 'edit_file', path: 'C:\\x\\a.txt', content: 'x' })] });
    await call(s.port, 'POST', '/api/codebase/start', { task: 'one' }, TOKEN); await until(async () => (await call(s.port, 'GET', '/api/codebase/state')).json.pending.length === 1);
    const r = await call(s.port, 'POST', '/api/codebase/start', { task: 'two' }, TOKEN); ok('a second run is refused while one is going', r.status === 409 && /already going/.test(r.json.error));
    await call(s.port, 'POST', '/api/codebase/stop', {}); await s.close(); }

  // ---- approvals ----
  { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pholama-grant-')); grants.grant(dir, 'write'); const target = path.join(dir, 'menu.txt');
    const s = await boot({ script: [tool({ name: 'note_', text: 'edit menu' }), tool({ name: 'edit_file', path: target, content: 'hello' }), tool({ name: 'done', summary: 'ok' })] });
    await call(s.port, 'POST', '/api/codebase/start', { task: 'edit' }, TOKEN);
    ok('an edit waits for the person', await until(async () => (await call(s.port, 'GET', '/api/codebase/state')).json.pending.length === 1));
    const st = (await call(s.port, 'GET', '/api/codebase/state')).json; ok('nothing touched the PC before the answer', s.winCalls.length === 0);
    let r = await call(s.port, 'POST', '/api/codebase/answer', { run: 'r999', call: st.pending[0].callId, allow: true }); ok('a wrong run id changes nothing', r.status === 409 && s.winCalls.length === 0);
    r = await call(s.port, 'POST', '/api/codebase/answer', { run: st.id, call: 'c999', allow: true }); ok('an invented call id changes nothing', r.status === 409 && s.winCalls.length === 0);
    r = await call(s.port, 'POST', '/api/codebase/answer', { run: st.id, call: st.pending[0].callId, allow: 'yes' }); ok('only a real true allows (the text "yes" is a No)', r.status === 200 && s.winCalls.length === 0);
    ok('the run finishes after the No', await until(async () => (await call(s.port, 'GET', '/api/codebase/state')).json.done === true));
    r = await call(s.port, 'POST', '/api/codebase/answer', { run: st.id, call: st.pending[0].callId, allow: true }); ok('answering twice does nothing', r.status === 409);
    await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pholama-grant-')); grants.grant(dir, 'write'); const target = path.join(dir, 'menu.txt');
    const s = await boot({ script: [tool({ name: 'note_', text: 'edit menu' }), tool({ name: 'edit_file', path: target, content: 'hello' }), tool({ name: 'done', summary: 'ok' })] });
    await call(s.port, 'POST', '/api/codebase/start', { task: 'edit' }, TOKEN); await until(async () => (await call(s.port, 'GET', '/api/codebase/state')).json.pending.length === 1);
    const st = (await call(s.port, 'GET', '/api/codebase/state')).json; await call(s.port, 'POST', '/api/codebase/answer', { run: st.id, call: st.pending[0].callId, allow: true });
    ok('Allow runs the edit once', await until(() => s.winCalls.length === 1) && s.winCalls[0].kind === 'write' && s.winCalls[0].content === 'hello');
    await until(async () => (await call(s.port, 'GET', '/api/codebase/state')).json.done === true); await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }

  // ---- a path outside every grant never reaches the PC, not even with Allow ----
  { const s = await boot({ script: [tool({ name: 'note_', text: 'x' }), tool({ name: 'edit_file', path: path.join(os.tmpdir(), 'not-granted', 'a.txt'), content: 'x' }), tool({ name: 'done', summary: 'ok' })] });
    await call(s.port, 'POST', '/api/codebase/start', { task: 'x' }, TOKEN);
    await until(async () => { const st = (await call(s.port, 'GET', '/api/codebase/state')).json; if (st.pending.length) await call(s.port, 'POST', '/api/codebase/answer', { run: st.id, call: st.pending[0].callId, allow: true }); return st.done; });
    ok('a file outside every granted folder is never written, even if allowed', s.winCalls.length === 0); await s.close(); }

  // ---- GitHub uses only the person's own token ----
  { const s = await boot({ script: [tool({ name: 'note_', text: 'x' }), tool({ name: 'github_read', action: 'repo_info', repo: 'a/b' }), tool({ name: 'done', summary: 'ok' })] });
    await call(s.port, 'POST', '/api/codebase/start', { task: 'x' }, { ...TOKEN, 'x-github-token': 'ghp_PERSONSOWNTOKENPERSONSOWNTOKEN123456' }); await until(async () => (await call(s.port, 'GET', '/api/codebase/state')).json.done === true);
    ok('GitHub gets the token the person sent with this run, nothing else', s.ghCalls.length === 1 && s.ghCalls[0].token === 'ghp_PERSONSOWNTOKENPERSONSOWNTOKEN123456'); await s.close(); }

  { const s = await boot({ script: [tool({ name: 'note_', text: 'x' }), tool({ name: 'github_read', action: 'repo_info', repo: 'a/b' }), tool({ name: 'done', summary: 'ok' })] });
    await call(s.port, 'POST', '/api/codebase/start', { task: 'x' }, TOKEN); await until(async () => (await call(s.port, 'GET', '/api/codebase/state')).json.done === true);
    ok('with no GitHub token sent, GitHub gets an empty token (and refuses)', s.ghCalls.length === 1 && s.ghCalls[0].token === '');
    ok('the GitHub token is wiped when the run ends', await until(async () => s.api.state.gh === '' && s.api.state.token === '')); await s.close(); }
  { const old = process.env.GITHUB_TOKEN_5; process.env.GITHUB_TOKEN_5 = 'github_pat_ENVIRONMENTONLYENVIRONMENTONLY123456789';
    const s = await boot({ script: [tool({ name: 'note_', text: 'x' }), tool({ name: 'github_read', action: 'repo_info', repo: 'a/b' }), tool({ name: 'done', summary: 'ok' })] });
    await call(s.port, 'POST', '/api/codebase/start', { task: 'x' }, TOKEN); await until(async () => (await call(s.port, 'GET', '/api/codebase/state')).json.done === true);
    ok('an environment GitHub token is never used by the routes', s.ghCalls.length === 1 && !String(s.ghCalls[0].token).includes('ENVIRONMENTONLY'));
    if (old === undefined) delete process.env.GITHUB_TOKEN_5; else process.env.GITHUB_TOKEN_5 = old; await s.close(); }
  // ---- live Notepad notes ----
  { const log = { writes: [], appends: [], opens: [], closes: [] };
    const np = require('../server/codebase-notepad').create({ dir: '/tmp/x', write: async (f, c) => { log.writes.push(c); }, append: async (f, c) => { log.appends.push(c); }, open: async f => { log.opens.push(f); return { ok: true }; }, close: async ti => { log.closes.push(ti); } });
    const s = await bootWith({ script: [tool({ name: 'note_', text: 'step one: plan the page' }), tool({ name: 'note_', content: 'step two: write it' }), tool({ name: 'done', summary: 'ok' })], notepad: np });
    await call(s.port, 'POST', '/api/codebase/start', { task: 'make a menu page' }, TOKEN);
    ok('the run finishes', await until(async () => (await call(s.port, 'GET', '/api/codebase/state')).json.done === true));
    ok('a fresh Notepad page was started with the task', log.writes.length === 1 && /make a menu page/.test(log.writes[0]));
    ok('both notes were written live (text and content forms)', log.appends.length === 2 && /plan the page/.test(log.appends[0]) && /write it/.test(log.appends[1]));
    ok('Notepad opened once', log.opens.length === 1);
    ok('the Notepad window is closed when the run ends', await until(() => log.closes.length === 1) && log.closes[0] === 'Pholama-Agent-Notes.txt - Notepad');
    await s.close(); }
  { const log = { closes: [] }; let release;
    const np = require('../server/codebase-notepad').create({ dir: '/tmp/x', write: async () => {}, append: async () => {}, open: async () => ({ ok: true }), close: async ti => { log.closes.push(ti); } });
    const s = await bootWith({ script: [tool({ name: 'note_', text: 'a' }), tool({ name: 'note_', text: 'b' })], notepad: np, hangAfter: 2 });
    await call(s.port, 'POST', '/api/codebase/start', { task: 'x' }, TOKEN); await until(() => np.state().count >= 1);
    await call(s.port, 'POST', '/api/codebase/stop', {});
    ok('Stop also closes the Notepad window', await until(() => log.closes.length >= 1)); await s.close(); }
  { const s = await bootWith({ script: [tool({ name: 'note_', text: 'a' }), tool({ name: 'done', summary: 'ok' })], notepad: null });
    await call(s.port, 'POST', '/api/codebase/start', { task: 'x' }, TOKEN);
    ok('with no Notepad available notes still work', await until(async () => (await call(s.port, 'GET', '/api/codebase/state')).json.done === true) && (await call(s.port, 'GET', '/api/codebase/state')).json.result.ok === true); await s.close(); }

  // ---- Stop ----
  { let release; const slow = (url, o) => new Promise((res, rej) => { o.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); release = () => res({ ok: true, status: 200, json: async () => ({ reply: tool({ name: 'done', summary: 'late' }) }) }); });
    const s = await boot({ cloud: slow }); await call(s.port, 'POST', '/api/codebase/start', { task: 'x' }, TOKEN); await sleep(60);
    let r = await call(s.port, 'POST', '/api/codebase/stop', {}); ok('Stop is accepted', r.status === 200);
    ok('the run ends', await until(async () => (await call(s.port, 'GET', '/api/codebase/state')).json.done === true));
    ok('the login is wiped by Stop', s.api.state.token === '');
    r = await call(s.port, 'POST', '/api/codebase/stop', {}); ok('stopping when nothing runs is a plain message', r.status === 409 && /Nothing is running/.test(r.json.error));
    await s.close(); }

  // ---- errors are plain words ----
  { const s = await boot({ cloud: async () => ({ ok: false, status: 500, json: async () => ({ error: 'Agent Max did not answer. cloud provider HTTP 500 qwen3-coder free.ai', code: 'server' }) }) });
    await call(s.port, 'POST', '/api/codebase/start', { task: 'x' }, TOKEN); await until(async () => (await call(s.port, 'GET', '/api/codebase/state')).json.done === true);
    const ev = []; await new Promise(res => { const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/codebase/stream' }, r => { let d = ''; r.on('data', c => { d += c; if (d.includes('"end"')) { ev.push(d); req.destroy(); res(); } }); }); req.on('error', () => res()); req.end(); setTimeout(res, 1500); });
    const all = ev.join('') + JSON.stringify((await call(s.port, 'GET', '/api/codebase/state')).json);
    ok('a cloud failure shows no model, provider or code to the person', !/qwen|free\.ai|HTTP 5|cloud provider|Agent Max/i.test(all) && /could not answer/i.test(all));
    await s.close(); }
  { const s = await boot({ cloud: async () => { throw new TypeError('fetch failed ENOTFOUND secret.internal.host'); } });
    await call(s.port, 'POST', '/api/codebase/start', { task: 'x' }, TOKEN); await until(async () => (await call(s.port, 'GET', '/api/codebase/state')).json.done === true);
    ok('a network failure leaks no host name', !JSON.stringify((await call(s.port, 'GET', '/api/codebase/state')).json).includes('secret.internal.host')); await s.close(); }

  // ---- live stream ----
  { const s = await boot({ script: [tool({ name: 'note_', text: 'streaming' }), tool({ name: 'done', summary: 'ok' })] });
    let r = await new Promise(res => { const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/codebase/stream' }, x => { res({ status: x.statusCode, type: x.headers['content-type'] }); x.resume(); req.destroy(); }); req.on('error', () => res({ status: 0 })); req.end(); });
    ok('watching before any run gives a clean empty stream', r.status === 200 && /event-stream/.test(r.type));
    await call(s.port, 'POST', '/api/codebase/start', { task: 'x' }, TOKEN); await until(async () => (await call(s.port, 'GET', '/api/codebase/state')).json.done === true);
    let data = ''; await new Promise(res => { const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/codebase/stream' }, x => { x.on('data', c => { data += c; if (data.includes('"end"')) { req.destroy(); res(); } }); }); req.on('error', () => res()); req.end(); setTimeout(res, 1500); });
    ok('a late viewer gets the whole run replayed', data.includes('"note"') || data.includes('streaming')); ok('and sees it end', data.includes('"end"'));
    ok('the stream never carries the login', !data.includes('LOGIN-TOKEN')); await s.close(); }

  // ---- size limits and junk ----
  { const s = await boot({ script: [] });
    let r = await call(s.port, 'POST', '/api/codebase/start', 'x'.repeat(70 * 1024), TOKEN); ok('a body over 64 KB is refused', r.status === 413);
    r = await call(s.port, 'POST', '/api/codebase/start', '{not json', TOKEN); ok('broken JSON is treated as empty, not a crash', r.status === 409 || r.status === 400 || r.status === 401);
    r = await call(s.port, 'POST', '/api/codebase/start', '[1,2,3]', TOKEN); ok('an array body is treated as empty', r.status === 409);
    r = await call(s.port, 'POST', '/api/codebase/start', 'null', TOKEN); ok('a null body is treated as empty', r.status === 409);
    r = await call(s.port, 'PUT', '/api/codebase/start', {}); ok('PUT is not accepted', r.status === 405);
    r = await call(s.port, 'POST', '/api/codebase/nothing', {}); ok('an unknown route is a plain 404', r.status === 404);
    r = await call(s.port, 'GET', '/api/codebase/state'); ok('the server still works after all the junk', r.status === 200);
    await s.close(); }

  // ---- grants ----
  { const s = await boot({ script: [] }); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pholama-g2-'));
    let r = await call(s.port, 'POST', '/api/codebase/grants', { dir, mode: 'read' }); ok('a folder can be granted (read)', r.status === 200 && r.json.grants.some(g => g.mode === 'read'));
    r = await call(s.port, 'POST', '/api/codebase/grants', { dir, mode: 'write' }); ok('and upgraded to write', r.status === 200 && r.json.grants.find(g => g.dir === fs.realpathSync(dir)).mode === 'write');
    r = await call(s.port, 'POST', '/api/codebase/grants', { dir, mode: 'admin' }); ok('an unknown mode falls back to read, never more', r.status === 200 && r.json.grants.find(g => g.dir === fs.realpathSync(dir)).mode === 'read');
    for (const bad of ['', 'relative/path', 'C:\\', '/', 'C:\\Windows', '/etc', path.join(dir, 'nope'), 5, null, ['x'], { a: 1 }]) { r = await call(s.port, 'POST', '/api/codebase/grants', { dir: bad }); ok('a bad folder is refused in plain words: ' + JSON.stringify(bad), r.status === 400 && typeof r.json.error === 'string' && r.json.error.length < 200); }
    r = await call(s.port, 'GET', '/api/codebase/grants'); ok('grants can be listed', r.status === 200 && r.json.grants.length >= 1);
    r = await call(s.port, 'DELETE', '/api/codebase/grants', { dir }); ok('a grant can be removed', r.status === 200 && r.json.ok === true && !r.json.grants.some(g => g.dir === fs.realpathSync(dir)));
    r = await call(s.port, 'DELETE', '/api/codebase/grants', { dir }); ok('removing twice says false, not an error', r.status === 200 && r.json.ok === false);
    await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }

  // ---- a tool that crashes is an ordinary result ----
  { const s = await boot({ script: [tool({ name: 'note_', text: 'x' }), tool({ name: 'github_read', action: 'repo_info', repo: 'a/b' }), tool({ name: 'done', summary: 'ok' })], github: { execute: async () => { throw new Error('boom'); } } });
    await call(s.port, 'POST', '/api/codebase/start', { task: 'x' }, TOKEN); ok('a crashing tool does not crash the run', await until(async () => (await call(s.port, 'GET', '/api/codebase/state')).json.done === true) && (await call(s.port, 'GET', '/api/codebase/state')).json.result.ok === true); await s.close(); }

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`);
  process.exit(fail ? 1 : 0);
})();
