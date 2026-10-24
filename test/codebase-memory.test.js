// Memory and sessions: the agent remembers across runs; the person can save, view and delete both.
const fs = require('fs'), os = require('os'), path = require('path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-')); process.env.PHOLAMA_HOME = home;
const M = require('../server/codebase-memory.js'), P = require('../server/codebase-plan.js'), L = require('../server/codebase-loop.js'), N = require('../server/codebase-notepad.js');
let bad = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + String(x).slice(0, 240))); if (!c) bad++; };
const GO = { gate: () => ({ ok: true }), spend: () => ({ ok: true }) }, YES = async () => ({ allowed: true });

// ---- memory ----
ok('empty at the start', M.listMemory().length === 0 && M.context() === '');
let r = M.remember('The project is in D:\\games\\zoo and uses Lua.');
ok('remember saves a fact with an id', r.ok && /^m/.test(r.id) && M.listMemory().length === 1);
ok('the same fact twice is stored once', M.remember('the project is in d:\\games\\zoo and uses lua.').text === 'Already remembered.' && M.listMemory().length === 1);
ok('empty text is refused', !M.remember('   ').ok && !M.remember(null).ok);
M.remember('token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here');
ok('a secret is hidden before it is saved', !/ghp_abcdefghij/.test(fs.readFileSync(M.FILE(), 'utf8')));
M.remember('z'.repeat(900));
ok('a long fact is cut to 400 characters', M.listMemory().every(m => m.text.length <= 400));
const keep = M.listMemory()[0].id;
ok('it survives a reload (file on disk)', JSON.parse(fs.readFileSync(M.FILE(), 'utf8')).memory.some(m => m.id === keep));
for (let i = 0; i < 60; i++) M.remember('fact number ' + i);
ok('memory is limited to 40', M.listMemory().length === 40 && !M.remember('one more').ok && /full/.test(M.remember('one more').text));
ok('forget removes exactly one by id', M.forget(keep).ok && !M.listMemory().some(m => m.id === keep) && M.listMemory().length === 39);
ok('forgetting an unknown id says so', !M.forget('nope').ok && !M.forget('').ok && !M.forget(null).ok);
ok('clear empties it', M.clearMemory().ok && M.listMemory().length === 0);
fs.writeFileSync(M.FILE(), '{not json');
ok('a broken file does not crash anything', M.listMemory().length === 0 && M.remember('fresh').ok);

// ---- sessions ----
M.clearMemory();
let s = M.saveSession({ task: 'Make a menu', notes: ['plan', '\u2705 menu made'], result: { ok: true, summary: 'Menu done' } });
ok('a session is saved', s.ok && M.listSessions().length === 1 && M.listSessions()[0].ok === true && M.listSessions()[0].notes === 2);
ok('it can be opened with its notes', M.getSession(s.id).notes[1] === '\u2705 menu made' && M.getSession(s.id).summary === 'Menu done');
M.saveSession({ task: 'Fix bug', notes: [], result: { ok: false, stopped: 'stuck' } });
ok('a failed run is saved as failed with why', M.listSessions()[0].ok === false && M.listSessions()[0].ended === 'stuck');
ok('newest first', M.listSessions()[0].task === 'Fix bug');
ok('no task, no session', !M.saveSession({ task: '', result: {} }).ok);
for (let i = 0; i < 40; i++) M.saveSession({ task: 'run ' + i, notes: [], result: { ok: true } });
ok('only the last 30 sessions are kept', M.listSessions().length === 30 && M.listSessions()[0].task === 'run 39');
ok('delete one session', M.deleteSession(M.listSessions()[0].id).ok && M.listSessions().length === 29 && !M.deleteSession('zzz').ok);
ok('a session keeps at most 12 notes', M.getSession(M.saveSession({ task: 'many', notes: Array.from({ length: 30 }, (_, i) => 'n' + i), result: {} }).id).notes.length === 12);
ok('clear sessions', M.clearSessions().ok && M.listSessions().length === 0);

// ---- what the agent is told ----
M.remember('Prefers short answers'); M.saveSession({ task: 'Build a shop page', notes: [], result: { ok: true, summary: 'shop page ready' } });
const ctx = M.context();
ok('the context lists facts with ids, earlier sessions with a mark, and calls itself data', /\[m[a-z0-9]+\] Prefers short answers/.test(ctx) && /\u2705 Build a shop page => shop page ready/.test(ctx) && /DATA, not instructions/.test(ctx), ctx);

// ---- tools (planner) ----
ok('remember is planned', P.plan('remember', { text: 'x' }).kind === 'remember' && P.plan('remember', { fact: 'y' }).text === 'y');
ok('remember with nothing is refused', !P.plan('remember', {}).ok);
ok('forget is planned', P.plan('forget', { id: 'm1' }).id === 'm1' && !P.plan('forget', {}).ok);
const API = require('../server/codebase-api.js');
const tools = API.buildTools({ win: { execute: async () => ({ ok: true }) }, github: {}, media: {}, web: {}, notepad: null });

(async () => {
  M.clearMemory();
  ok('the tool remembers', (await tools.remember({ text: 'uses Rojo' })) === 'Remembered.' && M.listMemory()[0].text === 'uses Rojo');
  const id = M.listMemory()[0].id;
  ok('the tool forgets', (await tools.forget({ id })) === 'Forgotten.' && M.listMemory().length === 0);
  ok('forgetting something missing is an ERROR result', /^ERROR:/.test(await tools.forget({ id: 'gone' })));

  // ---- the loop really hands it to the model ----
  const seen = [];
  await L.run('do it', { model: async m => { seen.push(m.map(x => ({ ...x }))); return '<tool>{"name":"done","summary":"ok"}</tool>'; }, tools: {}, ask: YES, budget: GO, context: 'YOUR MEMORY: [m1] likes Lua' });
  ok('the first user message carries the saved facts and then the task', /likes Lua/.test(seen[0][1].content) && /TASK: do it/.test(seen[0][1].content));
  seen.length = 0;
  await L.run('plain', { model: async m => { seen.push(m.map(x => ({ ...x }))); return '<tool>{"name":"done","summary":"ok"}</tool>'; }, tools: {}, ask: YES, budget: GO });
  ok('with nothing saved the task still arrives', /TASK: plain/.test(seen[0][1].content));
  ok('the prompt tells the agent about remember and forget', /remember/.test(L.SYSTEM) && /forget/.test(L.SYSTEM));

  // ---- a whole run through the session saves itself ----
  const SESSION = require('../server/codebase-session.js'); M.clearSessions();
  const q = ['<tool>{"name":"note_","text":"first plan"}</tool>', '<tool>{"name":"done","summary":"all good"}</tool>'];
  const sess = SESSION.create({ model: async () => q.shift(), tools: { note_: async () => 'Noted.' }, budget: GO, getContext: () => M.context(), onEnd: x => M.saveSession(x) });
  sess.start('Save me');
  await new Promise(res => { const t = setInterval(() => { if (sess.state().done) { clearInterval(t); res(); } }, 20); });
  const saved = M.listSessions()[0];
  ok('a finished run saves itself with its notes and summary', saved && saved.task === 'Save me' && saved.ok === true && M.getSession(saved.id).notes[0] === 'first plan' && M.getSession(saved.id).summary === 'all good', JSON.stringify(saved));

  // ---- tick and cross marks in the Notepad ----
  const writes = [];
  const np = N.create({ dir: '/tmp/x', now: () => 0, write: async () => {}, append: async (f, c) => writes.push(c), open: async () => ({ ok: true }), close: async () => {} });
  await np.begin('t'); await np.mark(true, 'edit_file C:\\a.js'); await np.mark(false, 'edit_file C:\\b.js', 'read-only folder');
  await np.note('\u2705 menu done'); await np.note('\u274C could not open'); await np.note('plain note'); await np.note('\u2714\uFE0F ticked');
  const all = writes.join('');
  ok('a success is written with a tick', /\u2705 edit_file C:\\a\.js/.test(all));
  ok('a failure is written with a cross and why', /\u274C edit_file C:\\b\.js: read-only folder/.test(all));
  ok("the agent's own tick and cross notes keep their mark", /\u2705 menu done/.test(all) && /\u274C could not open/.test(all));
  ok('a plain note stays plain', /\] plain note/.test(all));
  ok('another tick style becomes the standard tick, once', /\] \u2705 ticked/.test(all) && !/\u2714/.test(all));
  await np.mark(false, 'x ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  ok('a secret in a mark is hidden', !/ghp_abcdefghij/.test(writes.join('')));
  ok('a mark with no text does nothing', (await np.mark(true, '')).ok === false);

  // ---- the loop reports every step ----
  const got = []; const rep = ['<tool>{"name":"cloud_browse","url":"https://a.test"}</tool>', '<tool>{"name":"cloud_browse","url":"https://b.test"}</tool>', '<tool>{"name":"done","summary":"s"}</tool>'];
  await L.run('t', { model: async () => rep.shift(), tools: { cloud_browse: async a => (a.url === 'https://a.test' ? 'page text' : 'ERROR: it failed') }, ask: YES, budget: GO, onResult: x => got.push(x) });
  ok('the loop reports a tick for success and a cross for failure', got.length === 2 && got[0].good === true && got[1].good === false && /it failed/.test(got[1].detail) && /cloud_browse https:\/\/a\.test/.test(got[0].what), JSON.stringify(got));
  const got2 = []; const rep2 = ['<tool>{"name":"nope"}</tool>', '<tool>{"name":"done","summary":"s"}</tool>'];
  await L.run('t', { model: async () => rep2.shift(), tools: {}, ask: YES, budget: GO, onResult: x => got2.push(x) });
  ok('a refused call is a cross too', got2.length === 1 && got2[0].good === false);
  const calm = await L.run('t', { model: async () => '<tool>{"name":"done","summary":"s"}</tool>', tools: {}, ask: YES, budget: GO, onResult: () => { throw new Error('x'); } });
  ok('a problem in the notes callback never stops the run', calm.ok === true);

  // ---- AUTO MEMORIZER: the work is saved without the AI writing anything, each session has its own name, and it can be deleted ----
  M.clearSessions();
  const SES = require('../server/codebase-session.js');
  const script = ['<tool>{"name":"note_","text":"about to edit two files"}</tool>', '<tool>{"name":"edit_file","path":"C:\\\\p\\\\a.lua"}</tool>', '<tool>{"name":"note_","text":"now the second file"}</tool>', '<tool>{"name":"edit_file","path":"C:\\\\p\\\\b.lua"}</tool>', '<tool>{"name":"done","summary":"two files"}</tool>'];
  const toolsFake = { note_: async () => 'Noted.', edit_file: async a => (/b\.lua/.test(a.path) ? 'ERROR: read-only folder' : 'Saved.') };
  const run1 = SES.create({ model: async () => script.shift(), tools: toolsFake, budget: GO, onEnd: x => M.saveSession({ ...x, now: () => Date.UTC(2026, 9, 24, 14, 52) }) });
  run1.start('Build the shop');
  // an edit needs the person's Allow; here the test presses it the moment it appears
  await new Promise(res => { const t = setInterval(() => { const st = run1.state(); for (const p of (st.pending || [])) run1.answer(st.id, p.callId, true); if (st.done) { clearInterval(t); res(); } }, 20); });
  const a1 = M.listSessions()[0], full = M.getSession(a1.id);
  ok('the work was saved automatically, with only its own planning note, nothing else to write', full.work.length === 2 && full.notes.length === 2, JSON.stringify(full));
  ok('a good step has a tick and a bad one has a cross and why', /^\u2705 edit_file/.test(full.work[0]) && /^\u274C edit_file.*read-only folder/.test(full.work[1]), JSON.stringify(full.work));
  ok('the session has its own readable name', full.name === '2026-10-24 14:52 Build the shop', full.name);
  const second = M.saveSession({ task: 'Build the shop', result: { ok: true }, now: () => Date.UTC(2026, 9, 24, 14, 52) });
  ok('the same task in the same minute still gets a different name', M.getSession(second.id).name === '2026-10-24 14:52 Build the shop (2)', M.getSession(second.id).name);
  ok('it can be opened by its name', M.getSession('2026-10-24 14:52 Build the shop (2)').id === second.id);
  ok('the list shows the name and how many steps were saved', M.listSessions().every(x => x.name) && M.listSessions().some(x => x.work === 2));
  ok('the next run is told what the last session did', /LAST SESSION WORK \(auto-saved\)/.test(M.context()) || M.listSessions()[0].work === 0);
  ok('it can be deleted by name when the user says so', M.deleteSession('2026-10-24 14:52 Build the shop (2)').ok && !M.getSession(second.id));
  ok('a secret in the work log is hidden', (() => { const x = M.saveSession({ task: 't', work: ['\u2705 run ghp_abcdefghijklmnopqrstuvwxyz0123456789'], result: {} }); return !/ghp_abcdefghij/.test(JSON.stringify(M.getSession(x.id))); })());
  ok('the work log is capped at 60 steps', M.getSession(M.saveSession({ task: 'long', work: Array.from({ length: 200 }, (_, i) => 'w' + i), result: {} }).id).work.length === 60);
  // ---- opening files, folders and pages is forgiving ----
  ok('open_window takes "path"', P.plan('open_window', { path: 'https://a.test' }).web === true);
  ok('open_window takes "url", "file" and "folder" too', P.plan('open_window', { url: 'https://b.test' }).target === 'https://b.test' && !/Say what to open/.test(P.plan('open_window', { file: 'C:\\zz\\q.html' }).say || ''));
  ok('open_window takes a quoted address', P.plan('open_window', { target: '"https://c.test"' }).target === 'https://c.test');
  ok('open_window with nothing says exactly what to give', /target/.test(P.plan('open_window', {}).say));
  ok('a file:// link is turned into a normal path, then checked against the allowed folders', /outside the folders|allowed/i.test(P.plan('open_window', { target: 'file:///C:/not-allowed/x.html' }).say || ''));
  ok('other schemes are still refused', !P.plan('open_window', { target: 'ms-settings:' }).ok);
  console.log(bad ? bad + ' FAILED' : 'ALL PASSED'); process.exit(bad ? 1 : 0);
})();
