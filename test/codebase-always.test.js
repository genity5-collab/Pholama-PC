'use strict';
// "Always allow": only the normal ask tier, never the dangerous tier; can be turned off; tampering is ignored; the session answers at once; typing, keys and search are planned safely.
const os = require('os'), fs = require('fs'), path = require('path'), http = require('http');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pholama-always-')); process.env.PHOLAMA_HOME = HOME;
const A = require('../server/codebase-always'), P = require('../server/codebase-plan'), T = require('../server/codebase-tools');
const API = require('../server/codebase-api'), grants = require('../server/codebase-grants'), budget = require('../server/codebase-budget');
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? '  -> ' + String(x).slice(0, 200) : '')); } };
const F = path.join(HOME, 'codebase-always.json');

// ---- the store ----
ok('starts empty', A.list().length === 0 && !A.has('pc_browse'));
ok('a normal request kind can be added', A.add('pc_browse').ok && A.has('pc_browse') && A.list().join() === 'pc_browse');
ok('adding twice does not duplicate', (A.add('pc_browse'), A.list().length === 1));
for (const bad of ['terminal_open', 'windows_powershell', 'delete_folder_or_window_or_app']) ok('a dangerous kind is refused: ' + bad, !A.add(bad).ok && !A.has(bad));
for (const bad of ['note_', 'screenshot_', 'nope', '', 'constructor', '__proto__', 'toString', null, undefined, 42]) ok('a not-askable / unknown kind is refused: ' + String(bad), !A.add(bad).ok);
fs.writeFileSync(F, JSON.stringify({ v: 1, tools: ['pc_browse', 'terminal_open', 'windows_powershell', 'delete_folder_or_window_or_app', 'constructor', 7, null] }));
ok('a hand-edited file cannot make a dangerous kind always allowed', A.list().join() === 'pc_browse' && !A.has('terminal_open') && !A.has('windows_powershell'));
fs.writeFileSync(F, '{not json'); ok('a broken file means nothing is always allowed', A.list().length === 0);
A.add('pc_browse'); A.add('user_pc');
ok('turn one off', A.remove('pc_browse').tools.join() === 'user_pc' && !A.has('pc_browse'));
ok('turn all off', A.clear().tools.length === 0 && !A.has('user_pc'));

// ---- typing, keys, search plans ----
const U = a => P.plan('user_pc', a);
let r = U({ action: 'type', text: 'hello' }); ok('typing is planned', r.ok && r.kind === 'pc_type' && r.text === 'hello' && r.enter === false);
r = U({ action: 'Type', text: 'a\nb', enter: true }); ok('typing: any capital letters, new lines and enter:true are kept', r.ok && r.text === 'a\nb' && r.enter === true);
r = U({ action: 'typing', value: 'via value' }); ok('typing: "value" works and the word "typing" means type', r.ok && r.text === 'via value');
ok('typing: empty / huge / missing text refused', !U({ action: 'type', text: '' }).ok && U({ action: 'type', text: 'x'.repeat(20000) }).ok && !U({ action: 'type', text: 'x'.repeat(20001) }).ok && !U({ action: 'type' }).ok && !U({ action: 'type', text: 5 }).ok);
r = U({ action: 'key', key: 'enter' }); ok('key enter -> {ENTER}', r.ok && r.kind === 'pc_key' && r.send === '{ENTER}');
r = U({ action: 'press', key: 'Ctrl + L' }); ok('key: "Ctrl + L" and "press" are understood', r.ok && r.send === '^l');
r = U({ action: 'key', key: 'Return' }); ok('key: Return = enter', r.ok && r.send === '{ENTER}');
for (const bad of ['alt+f4', 'ctrl+alt+delete', 'win+r', '{ENTER}', '%{F4}', '^w', 'f4', '', 'ctrl+shift+esc', '~', 'enter}{ENTER']) ok('key: dangerous or raw SendKeys refused: ' + JSON.stringify(bad), !U({ action: 'key', key: bad }).ok);
r = U({ action: 'search', text: 'best pizza & "cheap" near me' }); ok('search opens a web search with the words encoded', r.ok && r.kind === 'open' && r.web === true && r.target === 'https://www.google.com/search?q=' + encodeURIComponent('best pizza & "cheap" near me'));
r = U({ action: 'google', query: 'cats' }); ok('search: "google" and "query" understood', r.ok && /q=cats$/.test(r.target));
ok('search: empty or huge refused', !U({ action: 'search', text: '  ' }).ok && !U({ action: 'search', text: 'x'.repeat(301) }).ok);
ok('search can only ever open https://www.google.com', ['a" ; calc', '../../x', 'http://evil.com', '\n'].every(q => { const x = U({ action: 'search', text: q }); return !x.ok || x.target.startsWith('https://www.google.com/search?q=') && !/[ "<>]/.test(x.target); }));
ok('click and scroll still work', U({ action: 'click', x: 5, y: 6 }).kind === 'pc_click' && U({ action: 'scroll', amount: 3 }).kind === 'pc_scroll');
ok('an unknown action lists the choices', /search/.test(U({ action: 'fly' }).say || ''));

// ---- the real script text is safe ----
const W = fs.readFileSync(path.join(__dirname, '..', 'server', 'codebase-win.js'), 'utf8');
ok('typing PASTES the text (exact characters, any length), restores the old clipboard, and presses Enter only when asked', /pc_type:[^\n]*Set-Clipboard -Value \$t[^\n]*\^v[^\n]*PH_A -eq '1'[^\n]*Set-Clipboard -Value \$old/.test(W) && !/pc_type:[^\n]*\$t -replace/.test(W));
ok('keys come from the fixed list only (the script just sends what the planner chose)', /pc_key:[^\n]*SendWait\(\$env:PH_A\)/.test(W) && /case 'pc_key': return ps\('pc_key', \{ a: pl\.send \}\)/.test(W));

// ---- the session answers at once for an always-allowed kind, and still asks otherwise ----
const S = require('../server/codebase-session');
const tool = o => '<tool>' + JSON.stringify(o) + '</tool>';
async function runWith(script, setup) {
  setup && setup();
  let i = 0; const ran = [];
  const sess = S.create({ model: async () => script[i++] || tool({ name: 'done', summary: 'x' }), budget: { gate: () => ({ ok: true }), spend() {} }, askTimeout: 150,
    tools: { note_: async () => 'Noted.', pc_browse: async a => { ran.push('pc_browse'); return 'opened'; }, terminal_open: async () => { ran.push('terminal_open'); return 'ran'; }, done: async () => 'ok' } });
  sess.start('t'); const t0 = Date.now(); while (Date.now() - t0 < 3000 && sess.state().running !== false) await new Promise(r => setTimeout(r, 20));
  const ev = []; const stop = sess.watch(e => ev.push(e)); if (stop) stop();
  return { ran, ev };
}
(async () => {
  let o = await runWith([tool({ name: 'pc_browse', url: 'https://a.com' })], () => A.clear());
  ok('not always allowed: it asks, nobody answers, so it does not run', !o.ran.includes('pc_browse'));
  o = await runWith([tool({ name: 'pc_browse', url: 'https://a.com' })], () => A.add('pc_browse'));
  ok('always allowed: it runs without asking', o.ran.includes('pc_browse'));
  ok('and the feed says it was automatic', o.ev.some(e => e.kind === 'answered' && e.auto === true));
  fs.writeFileSync(F, JSON.stringify({ v: 1, tools: ['terminal_open'] }));
  o = await runWith([tool({ name: 'terminal_open', command: 'dir' })], () => {});
  ok('a dangerous kind written into the file still asks (and so does not run)', !o.ran.includes('terminal_open'));
  A.clear();

  // ---- the routes ----
  const boot = who => { const api = API.create({ grants, budget, fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }), cloudUrl: 'http://c.test/x', win: { execute: async () => ({ ok: true, text: 'ok' }) }, github: { execute: async () => ({ ok: true, text: 'ok' }) }, notepad: null });
    const server = http.createServer(async (req, res) => { req.who = who; const u = new URL(req.url, 'http://x'); if (!(await api.handle(req, res, u.pathname, u))) { res.writeHead(404); res.end('{}'); } });
    return new Promise(r => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, close: () => new Promise(x => server.close(x)) }))); };
  const call = (port, method, p, b) => new Promise(r => { const d = b ? JSON.stringify(b) : ''; const q = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } }, res => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => { let j = {}; try { j = JSON.parse(Buffer.concat(c).toString()); } catch {} r({ status: res.statusCode, j }); }); }); q.end(d); });
  let s = await boot('local');
  let x = await call(s.port, 'GET', '/api/codebase/always'); ok('GET lists (empty)', x.status === 200 && x.j.tools.length === 0);
  x = await call(s.port, 'POST', '/api/codebase/always', { tool: 'pc_browse' }); ok('POST turns one on', x.status === 200 && x.j.tools.join() === 'pc_browse');
  x = await call(s.port, 'POST', '/api/codebase/always', { tool: 'windows_powershell' }); ok('POST for a dangerous kind is refused (400)', x.status === 400 && x.j.ok === false);
  x = await call(s.port, 'GET', '/api/codebase/state'); ok('the state carries the list', Array.isArray(x.j.always) && x.j.always.includes('pc_browse'));
  x = await call(s.port, 'DELETE', '/api/codebase/always', { tool: 'pc_browse' }); ok('DELETE turns one off', x.status === 200 && x.j.tools.length === 0);
  await call(s.port, 'POST', '/api/codebase/always', { tool: 'user_pc' }); x = await call(s.port, 'DELETE', '/api/codebase/always', {}); ok('DELETE with no name turns all off', x.j.tools.length === 0);
  await s.close(); s = await boot('remote');
  for (const [m, b] of [['GET'], ['POST', { tool: 'user_pc' }], ['DELETE', {}]]) { x = await call(s.port, m, '/api/codebase/always', b); ok('another device is refused: ' + m, x.status === 403); }
  ok('and nothing was saved by that', A.list().length === 0);
  await s.close();

  // ---- the screen ----
  const { rowHtml, describe } = await import('../web/codebasescreen.js');
  let h = rowHtml(describe({ kind: 'ask', tool: 'pc_browse', callId: 'c1', level: 'ask', args: '{"url":"https://a.com"}' }));
  ok('a normal request card has Allow, Always allow and Deny', /data-allow="1"/.test(h) && /data-always="pc_browse"/.test(h) && /data-allow="0"/.test(h));
  h = rowHtml(describe({ kind: 'ask', tool: 'windows_powershell', callId: 'c2', level: 'strict', args: 'x' }));
  ok('a dangerous request card has NO Always allow button', !/data-always/.test(h) && /data-allow="1"/.test(h));
  h = rowHtml(describe({ kind: 'ask', tool: '"><img src=x onerror=alert(1)>', callId: 'c3', level: 'ask', args: '' }));
  ok('the tool name is escaped', !/<img src=x/.test(h));
  ok('an automatic yes reads clearly', /automatically/.test(describe({ kind: 'answered', allowed: true, auto: true }).text) && describe({ kind: 'answered', allowed: true }).text === 'You said Yes');
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'codebasescreen.js'), 'utf8');
  ok('the screen has the "Always allowed" list with a Turn off button', /id="cbsAlways"/.test(src) && /data-off=/.test(src) && /Turn off/.test(src));

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`); process.exit(fail ? 1 : 0);
})();
