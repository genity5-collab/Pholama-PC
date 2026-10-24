'use strict';
// The screenshot route and the whole path: a scripted model asks for a screenshot -> the Windows runner stores the picture ->
// the stream carries the picture id (and nothing else about it) -> the picture is fetched over real HTTP. Only this PC may fetch it.
const http = require('http'), os = require('os'), fs = require('fs'), path = require('path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pholama-shot-')); process.env.PHOLAMA_HOME = HOME;
const API = require('../server/codebase-api'), SH = require('../server/codebase-shots');
const grants = require('../server/codebase-grants'), budget = require('../server/codebase-budget');
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? '  -> ' + String(x).slice(0, 200) : '')); } };
const tool = o => '<tool>' + JSON.stringify(o) + '</tool>';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]);

function boot(who) {
  const script = [tool({ name: 'note_', text: 'look at the screen' }), tool({ name: 'screenshot_' }), tool({ name: 'done', summary: 'looked' })]; let i = 0;
  const fetchFn = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ reply: script[i++] || tool({ name: 'done', summary: 'x' }), credits_left: 900, week_cap: 1500, cost: 5 }) });
  // the fake Windows runner does what the real one does: stores the picture and returns its id
  const win = { execute: async pl => pl.kind === 'screenshot' ? { ok: true, shot: SH.put(PNG), text: 'A page with a red button.\nOPEN WINDOWS (opened by the agent, closable): []' } : { ok: true, text: 'ok' } };
  const api = API.create({ grants, budget, fetchFn, cloudUrl: 'http://c.test/x', win, github: { execute: async () => ({ ok: true, text: 'ok' }) }, media: { execute: async () => ({ ok: false, text: 'no' }) }, notepad: null });
  const server = http.createServer(async (req, res) => { req.who = who; const u = new URL(req.url, 'http://x'); if (!(await api.handle(req, res, u.pathname, u))) { res.writeHead(404); res.end('{}'); } });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, close: () => new Promise(x => server.close(x)) })));
}
const get = (port, p, h = {}) => new Promise(r => http.get({ host: '127.0.0.1', port, path: p, headers: h }, res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => r({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); }));
const post = (port, p, b, h = {}) => new Promise(r => { const d = JSON.stringify(b); const q = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d), ...h } }, res => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => r({ status: res.statusCode, text: Buffer.concat(c).toString() })); }); q.end(d); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const id = SH.put(PNG);
  let s = await boot('local');
  let r = await get(s.port, '/api/codebase/shot/' + id);
  ok('this PC can fetch a stored picture: image/png, never cached, not sniffed', r.status === 200 && r.headers['content-type'] === 'image/png' && /no-store/.test(r.headers['cache-control']) && r.headers['x-content-type-options'] === 'nosniff' && r.body.equals(PNG));
  for (const bad of ['/api/codebase/shot/', '/api/codebase/shot/abc', '/api/codebase/shot/' + 'f'.repeat(16), '/api/codebase/shot/..%2F..%2Fetc%2Fpasswd', '/api/codebase/shot/constructor', '/api/codebase/shot/' + id + '/x']) {
    r = await get(s.port, bad); ok('a wrong id gives 404, never a file: ' + bad.slice(20, 50), r.status === 404, r.status);
  }
  await s.close();
  s = await boot('remote'); r = await get(s.port, '/api/codebase/shot/' + id); ok('another device is refused (403)', r.status === 403 && !r.body.equals(PNG)); await s.close();

  // whole path
  s = await boot('local');
  const g = await get(s.port, '/api/codebase/state'); ok('state works', g.status === 200);
  const rw = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-rw-')); await post(s.port, '/api/codebase/grants', { path: rw, mode: 'write' });
  const st = await post(s.port, '/api/codebase/start', { task: 'look at my screen', token: 'T', kind: 'simple' }, { 'x-pholama-token': 'T' });
  ok('a run starts', st.status === 200, st.text);
  // read the live stream (server-sent events) until the run ends
  const ev = await new Promise(res => { const out = []; let buf = ''; const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/codebase/stream' }, x => { x.on('data', c => { buf += c; let k; while ((k = buf.indexOf('\n\n')) >= 0) { const m = /^data: (.*)$/m.exec(buf.slice(0, k)); buf = buf.slice(k + 2); if (m) { try { out.push(JSON.parse(m[1])); } catch {} } } if (out.some(e => e.kind === 'end')) { req.destroy(); res(out); } }); }); req.on('error', () => res(out)); setTimeout(() => { req.destroy(); res(out); }, 5000); req.end(); });
  if (false) console.log('ALLEV', JSON.stringify(ev.map(e => [e.kind, e.tool || '', String(e.say || e.result || '').slice(0, 60)])));
  const shotEv = ev.find(e => e.kind === 'tool' && e.tool === 'screenshot_');
  ok('the screenshot event carries the picture id', shotEv && /^[a-f0-9]{16}$/.test(shotEv.shot || ''), JSON.stringify(shotEv));
  if (shotEv) { r = await get(s.port, '/api/codebase/shot/' + shotEv.shot); ok('and that id fetches the very picture the PC took', r.status === 200 && r.body.equals(PNG)); }
  ok('the model is never given the picture id or the bytes (only what the vision reader said)', shotEv && !/shot|png/i.test(String(shotEv.result || '')) , shotEv && shotEv.result);
  await s.close(); fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`); process.exit(fail ? 1 : 0);
})();
