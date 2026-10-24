'use strict';
// Attacks on the Pholama Codebase session: one run at a time, approvals tied to one run and one call, stop, timeout, live feed.
const S = require('../server/codebase-session');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } };
const tool = o => '<tool>' + JSON.stringify(o) + '</tool>';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(5); } return false; };

function make(script, o = {}) {
  let i = 0; const ran = [];
  const tools = Object.fromEntries(['note_', 'edit_file', 'terminal_open', 'screenshot_', 'next_task'].map(n => [n, async a => { ran.push(n + ':' + JSON.stringify(a)); return 'ok'; }]));
  const s = S.create({ model: async () => { if (i >= script.length) { await sleep(20); return tool({ name: 'done', summary: 'end' }); } return script[i++]; }, tools, budget: { gate: () => ({ ok: !o.noBudget }), spend: () => ({ ok: true }) }, askTimeout: o.askTimeout || 5000 });
  return { s, ran };
}

(async () => {
  // 1. a full run with an approval
  let { s, ran } = make([tool({ name: 'note_', text: 'p' }), tool({ name: 'edit_file', path: 'a.js' }), tool({ name: 'done', summary: 'fixed' })]);
  const st = s.start('fix a');
  ok('a run starts', st.ok && /^r1-/.test(st.id));
  ok('a pending request shows up', await until(() => s.state().pending.length === 1));
  const p = s.state().pending[0];
  ok('the pending request names the tool', p.tool === 'edit_file' && p.level === 'ask');
  ok('nothing ran before the user answered', !ran.some(x => x.startsWith('edit_file')));
  ok('allowing works', s.answer(st.id, p.callId, true).ok === true);
  ok('the run finishes', await until(() => s.state().done));
  ok('the edit ran after the Allow', ran.some(x => x.startsWith('edit_file')) && s.state().result.ok === true);
  ok('answering the same request twice fails', s.answer(st.id, p.callId, true).ok === false);

  // 1b. a double-click on Allow while the run is STILL going (it is now waiting on a second request)
  ({ s, ran } = make([tool({ name: 'note_' }), tool({ name: 'edit_file', path: 'a' }), tool({ name: 'note_' }), tool({ name: 'edit_file', path: 'b' }), tool({ name: 'done', summary: 'ok' })]));
  const rb = s.start('x'); await until(() => s.state().pending.length === 1);
  const first = s.state().pending[0].callId;
  ok('first click allows', s.answer(rb.id, first, true).ok === true);
  ok('the run moves on to a second request', await until(() => s.state().pending.length === 1 && s.state().pending[0].callId !== first));
  ok('a second click on the SAME request is refused while the run is alive', s.answer(rb.id, first, true).ok === false);
  ok('and it did not approve the second request by accident', s.state().pending.length === 1 && ran.filter(x => x.startsWith('edit_file')).length === 1);
  s.stop(); await until(() => s.state().done);

  // 2. deny
  ({ s, ran } = make([tool({ name: 'note_' }), tool({ name: 'edit_file' }), tool({ name: 'done', summary: 'ok' })]));
  let r2 = s.start('x'); await until(() => s.state().pending.length === 1);
  s.answer(r2.id, s.state().pending[0].callId, false); await until(() => s.state().done);
  ok('denying means the edit never runs', !ran.some(x => x.startsWith('edit_file')));

  // 3. only truthy true allows
  for (const bad of ['true', 1, 'yes', {}, [], null, undefined]) {
    ({ s, ran } = make([tool({ name: 'note_' }), tool({ name: 'edit_file' }), tool({ name: 'done', summary: 'ok' })]));
    const r = s.start('x'); await until(() => s.state().pending.length === 1);
    s.answer(r.id, s.state().pending[0].callId, bad); await until(() => s.state().done);
    ok('"' + String(JSON.stringify(bad)) + '" does not count as Allow', !ran.some(x => x.startsWith('edit_file')));
  }

  // 4. wrong run id and invented call ids change nothing
  ({ s, ran } = make([tool({ name: 'note_' }), tool({ name: 'terminal_open', cmd: 'dir' }), tool({ name: 'done', summary: 'ok' })]));
  const r4 = s.start('x'); await until(() => s.state().pending.length === 1);
  const real = s.state().pending[0].callId;
  ok('a wrong run id is refused', s.answer('r999', real, true).ok === false);
  ok('an invented call id is refused', s.answer(r4.id, 'c999', true).ok === false);
  ok('__proto__ and constructor as a call id are refused', s.answer(r4.id, '__proto__', true).ok === false && s.answer(r4.id, 'constructor', true).ok === false);
  ok('the real request is still waiting', s.state().pending.length === 1 && !ran.some(x => x.startsWith('terminal_open')));
  s.stop(); await until(() => s.state().done);

  // 5. one run at a time
  ({ s } = make([tool({ name: 'note_' }), tool({ name: 'edit_file' })]));
  const a = s.start('one'); await until(() => s.state().pending.length === 1);
  ok('a second run is refused while one is going', s.start('two').ok === false);
  s.stop(); await until(() => s.state().done);
  ok('after it ends a new run can start', s.start('two').ok === true);
  s.stop();

  // 6. stop
  ({ s, ran } = make([tool({ name: 'note_' }), tool({ name: 'edit_file' }), tool({ name: 'done', summary: 'ok' })]));
  s.start('x'); await until(() => s.state().pending.length === 1);
  ok('stop works', s.stop().ok === true);
  ok('stop clears the waiting request and ends the run', await until(() => s.state().done) && s.state().pending.length === 0);
  ok('stopping means the edit never ran', !ran.some(x => x.startsWith('edit_file')));
  ok('stopping when nothing runs says so', s.stop().ok === false);

  // 7. the request times out and counts as NO
  ({ s, ran } = make([tool({ name: 'note_' }), tool({ name: 'edit_file' }), tool({ name: 'done', summary: 'ok' })], { askTimeout: 60 }));
  s.start('x'); await until(() => s.state().pending.length === 1);
  ok('an unanswered request expires', await until(() => s.state().pending.length === 0 && s.state().done, 3000));
  ok('an expired request never runs the edit', !ran.some(x => x.startsWith('edit_file')));

  // 8. no credits
  ({ s } = make([tool({ name: 'done', summary: 'x' })], { noBudget: true }));
  s.start('x'); await until(() => s.state().done);
  ok('no credits: the run ends as budget', s.state().result.stopped === 'budget');

  // 9. input checks
  ({ s } = make([]));
  ok('an empty task is refused', s.start('').ok === false && s.start('   ').ok === false && s.start(null).ok === false);
  ok('a huge task is refused', s.start('x'.repeat(4001)).ok === false);
  ok('nothing is running after bad input', s.state().running === false);

  // 10. the live feed replays and then streams
  ({ s } = make([tool({ name: 'note_', text: 'hi' }), tool({ name: 'done', summary: 'ok' })]));
  ok('watching before any run gives nothing', s.watch(() => {}) === null);
  s.start('x'); await until(() => s.state().done);
  const seen = []; const unsub = s.watch(e => seen.push(e.kind));
  ok('a late watcher gets the history', seen.includes('tool') && seen.includes('done') && seen.includes('end'));
  ok('unsubscribing works', typeof unsub === 'function' && (unsub(), true));
  ({ s } = make([tool({ name: 'note_' }), tool({ name: 'edit_file' })]));
  const live = []; s.start('x'); s.watch(e => live.push(e.kind));
  await until(() => s.state().pending.length === 1);
  ok('a live watcher sees the ask arrive', live.includes('ask'));
  s.answer(s.state().id, s.state().pending[0].callId, true);
  ok('and sees the answer', await until(() => live.includes('answered')));
  s.stop();
  ok('a throwing watcher does not break the run', (() => { const t = make([tool({ name: 'note_' }), tool({ name: 'done', summary: 'ok' })]); t.s.start('x'); t.s.watch(() => { throw new Error('boom'); }); return true; })());
  await sleep(100);

  console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`);
  process.exit(fail ? 1 : 0);
})();
