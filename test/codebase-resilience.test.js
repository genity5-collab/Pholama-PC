'use strict';
// One bad moment must not end a long job: busy / network / empty replies are retried (with a pause, and a smaller prompt on the later tries).
// Login, credits and Stop are never retried, and each says its REAL reason in plain words (never a provider, model or HTTP code).
const L = require('../server/codebase-loop'), P = require('../server/codebase-plan'), T = require('../server/codebase-tools');
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? '  -> ' + String(x).slice(0, 200) : '')); } };
const tool = o => '<tool>' + JSON.stringify(o) + '</tool>';
const plain = (kind) => { const e = new Error('x ' + kind); e.kind = kind; e.plain = true; return e; };
function rig(script, o = {}) {
  const events = [], sleeps = [], sizes = []; let i = 0;
  const deps = { model: async (m, sig) => { sizes.push(m.reduce((n, x) => n + String(x.content).length, 0)); const s = script[i++]; if (s === undefined) throw new Error('script ended'); if (s instanceof Error) throw s; return s; },
    tools: { note_: async () => 'Noted.', pc_browse: async () => 'opened' }, ask: async r => ({ allowed: true, callId: r.callId }), budget: { gate: () => ({ ok: true }), spend() {} },
    sleep: async ms => { sleeps.push(ms); }, emit: e => events.push(e), now: (() => { let t = 1000; return () => ++t; })(), signal: o.signal };
  return { deps, events, sleeps, sizes, calls: () => i };
}
(async () => {
  let r = rig([plain('busy'), plain('network'), tool({ name: 'done', summary: 'fine' })]); let out = await L.run('t', r.deps);
  ok('two hiccups then an answer: the job carries on and finishes', out.ok === true && r.calls() === 3);
  ok('it waited between the tries (1s then 3s)', r.sleeps.join() === '1000,3000');
  ok('and told the person calmly', r.events.filter(e => e.kind === 'retry').length === 2 && r.events.some(e => /slow right now.*1 of 3/.test(e.say)));
  r = rig([new Error('502 from https://x.internal'), tool({ name: 'done', summary: 'ok' })]); out = await L.run('t', r.deps);
  ok('an unknown error is treated like a hiccup too', out.ok === true && r.calls() === 2);
  r = rig([plain('busy'), plain('busy'), plain('busy'), plain('busy'), tool({ name: 'done', summary: 'x' })]); out = await L.run('t', r.deps);
  ok('four failures in a row: it gives up after 4 tries (1 + 3 retries)', out.ok === false && out.stopped === 'model' && r.calls() === 4);
  ok('and says so plainly, with no provider details', r.events.some(e => e.kind === 'stopped' && /did not answer after a few tries/.test(e.say)) && r.events.every(e => !/502|provider|qwen|http|internal/i.test(JSON.stringify(e))));
  r = rig([plain('login'), tool({ name: 'done', summary: 'x' })]); out = await L.run('t', r.deps);
  ok('login problem: not retried, says to sign in', out.stopped === 'login' && r.calls() === 1 && r.sleeps.length === 0 && r.events.some(e => /Sign in/.test(e.say || '')));
  r = rig([plain('limit'), tool({ name: 'done', summary: 'x' })]); out = await L.run('t', r.deps);
  ok('out of credits: not retried, says credits come back', out.stopped === 'credits' && r.calls() === 1 && r.events.some(e => /credits/i.test(e.say || '')));
  r = rig([plain('stopped'), tool({ name: 'done', summary: 'x' })]); out = await L.run('t', r.deps);
  ok('Stop: not retried, ends as stopped by the user', out.stopped === 'stop' && r.calls() === 1);
  const ac = new AbortController(); ac.abort(); r = rig([tool({ name: 'done', summary: 'x' })], { signal: ac.signal }); out = await L.run('t', r.deps);
  ok('already stopped: no model call at all', out.stopped === 'stop' && r.calls() === 0);
  r = rig([plain('network'), plain('network'), plain('network'), plain('network')]); out = await L.run('t', r.deps);
  ok('no connection: tells the person to check it', r.events.some(e => /Check your connection/.test(e.say || '')) && out.stopped === 'model');

  // a too-big prompt shrinks on the retries
  const big = 'x'.repeat(30000);
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 't' }]; for (let k = 0; k < 14; k++) msgs.push({ role: k % 2 ? 'user' : 'assistant', content: big.slice(0, 2500) });
  const c0 = L.compact(msgs.slice(), [], 0), c1 = L.compact(msgs.slice(), [], 1), c2 = L.compact(msgs.slice(), [], 2);
  const sz = m => m.reduce((n, x) => n + x.content.length, 0);
  ok('retry 1 compacts harder than the first try', sz(c1) < sz(c0) && c0.length >= c1.length);
  ok('retry 2 compacts harder again and keeps the newest few', sz(c2) < sz(c1) && c2.length <= 10 && c2[c2.length - 1].content === msgs[msgs.length - 1].content);
  ok('the first two messages (rules and task) always survive', c2[0].content === 's' && c2[1].content === 't');

  // ---- the new controls ----
  const U = a => P.plan('user_pc', a);
  const cases = [[{ action: 'click', x: 5, y: 6 }, 'pc_click'], [{ action: 'double_click', x: 5, y: 6 }, 'pc_double'], [{ action: 'Double-Click', x: 5, y: 6 }, 'pc_double'], [{ action: 'right click', x: 1, y: 2 }, 'pc_right'], [{ action: 'hover', x: 1, y: 2 }, 'pc_move'], [{ action: 'move', x: 1, y: 2 }, 'pc_move'], [{ action: 'scroll', amount: -3 }, 'pc_scroll']];
  for (const [a, k] of cases) ok('plan ' + JSON.stringify(a) + ' -> ' + k, U(a).ok && U(a).kind === k, JSON.stringify(U(a)));
  ok('scroll with no spot scrolls where the cursor is (-1,-1)', U({ action: 'scroll', amount: -2 }).x === -1 && U({ action: 'scroll', x: 10, y: 10, amount: 2 }).x === 10);
  ok('scroll is limited to 20 notches', U({ action: 'scroll', amount: 999 }).amount === 20 && U({ action: 'scroll', amount: -999 }).amount === -20);
  ok('wait 1..20 seconds', U({ action: 'wait', seconds: 3 }).seconds === 3 && !U({ action: 'wait', seconds: 0 }).ok && !U({ action: 'wait', seconds: 21 }).ok && !U({ action: 'wait' }).ok && !U({ action: 'wait', seconds: 'abc' }).ok);
  ok('click off the screen / negative / not a number is refused', !U({ action: 'click', x: -5, y: 1 }).ok && !U({ action: 'click', x: 1 }).ok && !U({ action: 'click', x: 'a', y: 1 }).ok && !U({ action: 'click', x: 99999, y: 1 }).ok);
  for (const [k, send] of [['f5', '{F5}'], ['ctrl+r', '^r'], ['ctrl+w', '^w'], ['ctrl+shift+t', '^+t'], ['alt+right', '%{RIGHT}'], ['F5', '{F5}']]) ok('key ' + k, U({ action: 'key', key: k }).send === send);
  for (const bad of ['alt+f4', 'alt+tab', 'win+d', 'ctrl+alt+del', 'ctrl+shift+esc', 'f4', '{F5}', '%{F4}']) ok('still refused: ' + bad, !U({ action: 'key', key: bad }).ok);

  // ---- the scripts ----
  const W = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'codebase-win.js'), 'utf8');
  ok('clicking is now a real mouse (not a background message browsers ignore)', /pc_mouse:/.test(W) && /mouse_event/.test(W) && /SetCursorPos/.test(W) && !/PostMessage/.test(W));
  ok('every mouse kind has a runner', ['pc_move', 'pc_click', 'pc_double', 'pc_right', 'pc_scroll', 'pc_wait'].every(k => new RegExp("case '" + k + "'").test(W)));
  ok('the mouse never leaves the real screen', /VirtualScreen/.test(W) && /not on the screen/.test(W));
  ok('the model cannot put its own text into any script (only numbers and fixed words)', /case 'pc_scroll': return ps\('pc_mouse', \{ a: pl\.x, b: pl\.y, n: 'scroll:' \+ pl\.amount \}\)/.test(W));
  ok('tools are shown to the model with the new actions', /double_click|right_click/.test(L.SYSTEM) && /wait/.test(L.SYSTEM));
  console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`); process.exit(fail ? 1 : 0);
})();
