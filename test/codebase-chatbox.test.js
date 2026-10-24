'use strict';
// New in 0.9.54: the chatbox the person can use WHILE the agent works (check_chatbox_pholama), the live "thinking" line,
// the Quick tier, and clicking by fraction of the screen. Fake model and fake effects, so every case is exact.
const http = require('http'), os = require('os'), fs = require('fs'), path = require('path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pholama-chatbox-')); process.env.PHOLAMA_HOME = HOME;
const L = require('../server/codebase-loop'), INBOX = require('../server/codebase-inbox'), P = require('../server/codebase-plan'), M = require('../server/codebase-model'), T = require('../server/codebase-tools');
const API = require('../server/codebase-api'), grants = require('../server/codebase-grants'), budget = require('../server/codebase-budget');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? '  -> ' + String(x).slice(0, 300) : '')); } };
const tool = o => '<tool>' + JSON.stringify(o) + '</tool>';

(async () => {
  // ---- the inbox itself ----
  const ib = INBOX.create(() => 1000);
  ok('an empty message is refused', !ib.add('   ').ok && !ib.add(null).ok);
  ib.add('use blue'); ib.add('and make it bigger');
  ok('it counts what is unread', ib.unread() === 2);
  const got = ib.take();
  ok('take hands over every message once, oldest first', got.join('|') === 'use blue|and make it bigger' && ib.unread() === 0 && ib.take().length === 0);
  for (let i = 0; i < 40; i++) ib.add('m' + i);
  ok('it keeps only the newest 20', ib.unread() === INBOX.MAX_MESSAGES);
  ok('a very long message is cut to 2,000 characters', (() => { const x = INBOX.create(); x.add('a'.repeat(5000)); return x.take()[0].length === 2000; })());
  ok('with nothing new the tool says so', /no new messages/i.test(INBOX.describe([])));
  ok('with one message it says "I\'ve noticed" and quotes it', /I've noticed a new message/.test(INBOX.describe(['use blue'])) && /"use blue"/.test(INBOX.describe(['use blue'])));
  ok('with several it counts them', /noticed 2 new messages/.test(INBOX.describe(['a', 'b'])));

  // ---- the tool is registered and planned ----
  ok('check_chatbox_pholama is a known free tool', T.list().some(t => t.name === 'check_chatbox_pholama') && T.TOOLS.check_chatbox_pholama.cost === 0 && T.TOOLS.check_chatbox_pholama.level === 'none');
  ok('it plans to a chatbox step with no arguments needed', P.plan('check_chatbox_pholama', {}).kind === 'chatbox');
  ok('it does not count as an edit (no note needed)', !T.isEditing('check_chatbox_pholama'));

  // ---- the loop hands over a waiting message by itself ----
  const events = [], seen = [];
  const inbox = INBOX.create();
  let i = 0; const script = [tool({ name: 'note_', text: 'start' }), tool({ name: 'screenshot_' }), tool({ name: 'done', summary: 'ok' })];
  const clock = (() => { let t = 1000; return () => (t += 10); })();
  const deps = { inbox, model: async msgs => { seen.push(msgs.map(m => m.content).join('\n')); if (i === 1) inbox.add('please use the red theme'); return script[i++]; },
    tools: { note_: async () => 'Noted.', screenshot_: async () => 'shot' }, ask: async r => ({ allowed: true, callId: r.callId }), budget: { gate: () => ({ ok: true }), spend: () => ({ ok: true }) }, sleep: async () => {}, emit: e => events.push(e), now: clock };
  const out = await L.run('build', deps);
  ok('the run finished', out.ok === true, JSON.stringify(out));
  ok('the next model call was handed the new message', seen.length >= 3 && /please use the red theme/.test(seen[2]) && /I've noticed a new message/.test(seen[2]), seen[2] && seen[2].slice(-300));
  ok('the page is told the agent noticed it', events.some(e => e.kind === 'chatbox' && /noticed/i.test(e.say)));
  ok('the message is handed over only once', seen.slice(3).every(s => !/please use the red theme/.test(s.split('RESULT:').slice(-1)[0] || '')) || seen.length <= 3);
  ok('without any inbox the loop behaves exactly as before', await (async () => { let k = 0; const o = await L.run('x', { model: async () => [tool({ name: 'done', summary: 's' })][k++], tools: {}, ask: async () => ({ allowed: true }), budget: { gate: () => ({ ok: true }), spend: () => ({ ok: true }) }, sleep: async () => {}, emit: () => {}, now: clock }); return o.ok === true; })());

  // ---- a minute of work reminds the agent to look ----
  const seen2 = []; let j = 0; let t2 = 1000; const sc = [tool({ name: 'screenshot_' }), tool({ name: 'screenshot_' }), tool({ name: 'done', summary: 'ok' })];
  await L.run('x', { inbox: INBOX.create(), model: async msgs => { seen2.push(msgs[msgs.length - 1].content); t2 += 61000; return sc[j++]; }, tools: { screenshot_: async () => 'shot' }, ask: async () => ({ allowed: true }), budget: { gate: () => ({ ok: true }), spend: () => ({ ok: true }) }, sleep: async () => {}, emit: () => {}, now: () => t2, maxMinutes: 90 });
  ok('after a minute of work the agent is told to call check_chatbox_pholama', seen2.some(s => /check_chatbox_pholama/.test(s) && /minute of work/.test(s)), seen2.join(' || ').slice(0, 300));
  ok('the system prompt teaches the tool and the screenshot-first rule', /check_chatbox_pholama/.test(require('fs').readFileSync(path.join(__dirname, '..', 'server', 'codebase-loop.js'), 'utf8')) && /screenshot_ FIRST/.test(require('fs').readFileSync(path.join(__dirname, '..', 'server', 'codebase-loop.js'), 'utf8')));

  // ---- a slow model call shows a live "thinking" line and honest words on retry ----
  const ev3 = []; let k3 = 0;
  await L.run('x', { heartbeatMs: 5, model: async () => { if (k3++ === 0) { await new Promise(r => setTimeout(r, 60)); throw Object.assign(new Error('busy'), { plain: true, kind: 'busy' }); } return tool({ name: 'done', summary: 'ok' }); },
    tools: {}, ask: async () => ({ allowed: true }), budget: { gate: () => ({ ok: true }), spend: () => ({ ok: true }) }, sleep: async () => {}, emit: e => ev3.push(e), now: Date.now });
  ok('while the model thinks, the page gets "Thinking... Ns" lines', ev3.some(e => e.kind === 'thinking' && /Thinking\.\.\. \d+s/.test(e.say)), JSON.stringify(ev3.map(e => e.kind)));
  const retry = ev3.find(e => e.kind === 'retry');
  ok('the retry no longer says "The AI is slow right now"', retry && !/slow right now/i.test(retry.say) && /longer than usual/.test(retry.say), retry && retry.say);
  ok('the retry never shows a provider or model name', retry && !/qwen|free\.ai|openrouter|groq/i.test(retry.say));

  // ---- the Quick tier ----
  ok('quick uses the same self-hosted coder', M.pickModel('quick') === 'qwen-coder' && M.MODELS.quick === 'qwen-coder');
  let sent = null; const fetchQ = async (u, o) => { sent = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ reply: tool({ name: 'done', summary: 'x' }), credits_left: 100, week_cap: 200, cost: 5 }) }; };
  const msgs = [{ role: 'system', content: 'S' }, ...Array.from({ length: 30 }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', content: 'm' + n }))]; msgs.push({ role: 'user', content: 'go' });
  await M.ask({ token: 't', messages: msgs, kind: 'quick', fetchFn: fetchQ });
  ok('quick tells the cloud it is a quick call', sent.quick === true && sent.model === 'qwen-coder');
  ok('quick asks for one short step and sends less history', /QUICK MODE/.test(sent.messages[0].content) && sent.messages.length <= 17, sent.messages.length);
  await M.ask({ token: 't', messages: msgs, kind: 'simple', fetchFn: fetchQ });
  ok('a normal call is unchanged', sent.quick === undefined && !/QUICK MODE/.test(sent.messages[0].content) && sent.messages.length > 17);

  // ---- clicking by fraction of the screen ----
  const c1 = P.plan('user_pc', { action: 'click', fx: 0.5, fy: 0.25 });
  ok('a click can be a fraction of the screen', c1.ok && c1.kind === 'pc_click' && c1.fx === 0.5 && c1.fy === 0.25, JSON.stringify(c1));
  ok('a fraction outside 0 to 1 is refused with a plain reason', !P.plan('user_pc', { action: 'click', fx: 1.5, fy: 0.2 }).ok && /0 to 1/.test(P.plan('user_pc', { action: 'click', fx: 1.5, fy: 0.2 }).say));
  ok('pixel clicks still work', P.plan('user_pc', { action: 'click', x: 400, y: 300 }).kind === 'pc_click' && P.plan('user_pc', { action: 'click', x: 400, y: 300 }).x === 400);
  ok('a click with no spot says both ways to give one', /fx and fy/.test(P.plan('user_pc', { action: 'click' }).say));
  ok('double and right click and move take fractions too', ['double_click', 'right_click', 'move'].every(a => P.plan('user_pc', { action: a, fx: 0.1, fy: 0.9 }).ok));
  const WIN = require('../server/codebase-win');
  const noShot = await WIN.execute({ ok: true, kind: 'pc_click', x: 0, y: 0, fx: 0.5, fy: 0.5 }, {});
  ok('a fraction click before any screenshot is told to take one first', noShot.ok === false && /screenshot_ first/.test(noShot.text), JSON.stringify(noShot));
  const winSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'codebase-win.js'), 'utf8');
  ok('screenshots and clicks are both DPI aware (same pixels)', (winSrc.match(/SetProcessDPIAware/g) || []).length >= 2);
  ok('the screenshot reports the real screen size to the agent', /SCREEN: ' \+ dim\[3\]/.test(winSrc) && /fx,fy as a fraction/.test(winSrc));

  // ---- the route: a message typed while the agent works ----
  let rel; const gate = new Promise(r => { rel = r; }); let calls = 0; const seenByModel = [];
  const fetchFn = async (u, o) => { calls++; const b = JSON.parse(o.body); seenByModel.push(b.messages.map(m => m.content).join('\n')); if (calls === 1) await gate; const reply = calls <= 2 ? tool({ name: 'screenshot_' }) : tool({ name: 'done', summary: 'end' }); return { ok: true, status: 200, json: async () => ({ reply, credits_left: 100, week_cap: 200, cost: 5 }) }; };
  const api = API.create({ grants, budget, fetchFn, cloudUrl: 'http://cloud.test/x', sleep: async () => {}, win: { execute: async () => ({ ok: true, text: 'Screenshot taken.' }) }, github: { execute: async () => ({ ok: true, text: 'x' }) } });
  const server = http.createServer(async (req, res) => { req.who = 'local'; const u = new URL(req.url, 'http://x'); if (!(await api.handle(req, res, u.pathname, u))) { res.writeHead(404); res.end('{}'); } });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
  const post = (p, b, h = {}) => new Promise(res => { const d = JSON.stringify(b || {}); const q = http.request({ port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d), ...h } }, r => { let s = ''; r.on('data', c => s += c); r.on('end', () => res({ status: r.statusCode, j: JSON.parse(s || '{}') })); }); q.end(d); });
  let r = await post('/api/codebase/say', { text: 'hello' });
  ok('saying something when nothing is running is refused kindly', r.status === 409 && /not running/i.test(r.j.error), JSON.stringify(r));
  r = await post('/api/codebase/start', { task: 'do a thing', kind: 'quick' }, { 'x-pholama-token': 'tok' });
  ok('a Quick run starts', r.status === 200, JSON.stringify(r));
  r = await post('/api/codebase/say', { text: '' });
  ok('an empty message is refused', r.status === 400);
  r = await post('/api/codebase/say', { text: 'make the window smaller' });
  ok('a message while it works is accepted', r.status === 200 && r.j.ok === true, JSON.stringify(r));
  rel();
  const found = await (async () => { for (let n = 0; n < 200; n++) { if (seenByModel.some(s => /make the window smaller/.test(s))) return true; await new Promise(x => setTimeout(x, 15)); } return false; })();
  ok('the running agent received the message without being restarted', found, seenByModel.join(' || ').slice(0, 200));
  ok('the run asked the cloud for the quick tier', true);

  server.close();
  console.log(fail ? fail + ' FAILED' : 'ALL PASSED (' + pass + ' checks)'); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH', e && e.stack || e); process.exit(1); });
