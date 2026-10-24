'use strict';
// The memory and session routes over a REAL http server: who may call, add, list, delete one, delete all, and a finished run saving itself.
const http = require('http'), os = require('os'), fs = require('fs'), path = require('path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pholama-memroutes-')); process.env.PHOLAMA_HOME = HOME;
const API = require('../server/codebase-api'), grants = require('../server/codebase-grants'), budget = require('../server/codebase-budget'), M = require('../server/codebase-memory');
let bad = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + String(x).slice(0, 240))); if (!c) bad++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tool = o => '<tool>' + JSON.stringify(o) + '</tool>';

function boot(who = 'local', script = []) {
  let i = 0;
  const fetchFn = async () => { const reply = i < script.length ? script[i++] : tool({ name: 'done', summary: 'end' }); return { ok: true, status: 200, json: async () => ({ reply, credits: { used: 1, left: 99 } }), text: async () => reply }; };
  const api = API.create({ grants, budget, fetchFn, cloudUrl: 'http://cloud.test/x', sleep: async () => {}, win: { execute: async () => ({ ok: true, text: 'ok' }) }, github: { execute: async () => ({ ok: true, text: 'ok' }) }, notepad: null });
  const server = http.createServer(async (req, res) => { req.who = who; const u = new URL(req.url, 'http://x'); if (!(await api.handle(req, res, u.pathname, u))) { res.writeHead(404); res.end('{}'); } });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, close: () => new Promise(x => server.close(x)) })));
}
function call(port, method, p, body, headers = {}) {
  return new Promise(resolve => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', e => resolve({ status: 0, error: e.message })); if (data) req.write(data); req.end();
  });
}

(async () => {
  { const s = await boot('remote');
    for (const [m, p] of [['GET', '/api/codebase/memory'], ['POST', '/api/codebase/memory'], ['DELETE', '/api/codebase/memory'], ['GET', '/api/codebase/sessions'], ['DELETE', '/api/codebase/sessions'], ['GET', '/api/codebase/sessions/s1']]) {
      const r = await call(s.port, m, p, {}); ok('a remote caller is refused: ' + m + ' ' + p, r.status === 403, JSON.stringify(r));
    }
    ok('and nothing was written', M.listMemory().length === 0); await s.close(); }

  const s = await boot('local', [tool({ name: 'note_', text: 'my plan' }), tool({ name: 'done', summary: 'finished it' })]);
  let r = await call(s.port, 'GET', '/api/codebase/memory');
  ok('starts empty', r.status === 200 && r.json.memory.length === 0 && r.json.max === 40, JSON.stringify(r));
  r = await call(s.port, 'POST', '/api/codebase/memory', { text: 'The project is D:/zoo' });
  ok('add a memory', r.status === 200 && r.json.memory.length === 1 && r.json.memory[0].text === 'The project is D:/zoo', JSON.stringify(r));
  const id = r.json.memory[0].id;
  r = await call(s.port, 'POST', '/api/codebase/memory', { text: '   ' }); ok('an empty memory is refused plainly', r.status === 400 && /remember/i.test(r.json.error), JSON.stringify(r));
  r = await call(s.port, 'POST', '/api/codebase/memory', { text: 'k ghp_abcdefghijklmnopqrstuvwxyz0123456789' }); ok('a secret is hidden', r.status === 200 && !JSON.stringify(r.json).includes('ghp_abcdefghij'));
  r = await call(s.port, 'DELETE', '/api/codebase/memory', { id: 'nope' }); ok('deleting an unknown memory is a plain 404', r.status === 404 && /no memory/i.test(r.json.error), JSON.stringify(r));
  r = await call(s.port, 'DELETE', '/api/codebase/memory', { id }); ok('delete one memory', r.status === 200 && r.json.memory.length === 1 && !r.json.memory.some(m => m.id === id), JSON.stringify(r));
  r = await call(s.port, 'DELETE', '/api/codebase/memory', { all: true }); ok('delete all memory', r.status === 200 && r.json.memory.length === 0 && M.listMemory().length === 0);

  // a whole run through the real routes: it saves itself as a session
  M.clearSessions(); M.remember('Prefers Lua');
  r = await call(s.port, 'POST', '/api/codebase/start', { task: 'Build the shop' }, { 'x-pholama-token': 'LOGIN-1' });
  ok('a run starts', r.status === 200, JSON.stringify(r));
  let list = [];
  for (let k = 0; k < 100 && !list.length; k++) { await sleep(30); list = (await call(s.port, 'GET', '/api/codebase/sessions')).json.sessions; }
  ok('when it ends it is in the sessions list, with a tick', list.length === 1 && list[0].task === 'Build the shop' && list[0].ok === true, JSON.stringify(list));
  const one = await call(s.port, 'GET', '/api/codebase/sessions/' + list[0].id);
  ok('a session can be opened with its notes and summary', one.status === 200 && one.json.notes.includes('my plan') && one.json.summary === 'finished it', JSON.stringify(one));
  r = await call(s.port, 'GET', '/api/codebase/sessions/zzz'); ok('an unknown session is 404', r.status === 404);
  r = await call(s.port, 'DELETE', '/api/codebase/sessions', { id: 'zzz' }); ok('deleting an unknown session is 404', r.status === 404);
  r = await call(s.port, 'DELETE', '/api/codebase/sessions', { id: list[0].id }); ok('delete one session', r.status === 200 && r.json.sessions.length === 0);
  M.saveSession({ task: 'a', result: {} }); M.saveSession({ task: 'b', result: {} });
  r = await call(s.port, 'DELETE', '/api/codebase/sessions', { all: true }); ok('delete all sessions', r.status === 200 && r.json.sessions.length === 0 && M.listSessions().length === 0);
  await s.close();
  console.log(bad ? bad + ' FAILED' : 'ALL PASSED'); process.exit(bad ? 1 : 0);
})();
