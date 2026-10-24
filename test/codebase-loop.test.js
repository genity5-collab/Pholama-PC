'use strict';
// Attacks on the Pholama Codebase agent loop, with a scripted fake model so every case is exact.
const L = require('../server/codebase-loop');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } };
const tool = (o) => '<tool>' + JSON.stringify(o) + '</tool>';

// Builds a run: the fake model says the scripted lines in order; every tool call is recorded.
function rig(script, o = {}) {
  const events = [], ran = [], asked = [];
  let i = 0;
  const deps = {
    model: async () => { if (i >= script.length) throw new Error('script ended'); const s = script[i++]; if (s instanceof Error) throw s; return s; },
    tools: Object.fromEntries(['note_', 'screenshot_', 'edit_file', 'terminal_open', 'delete_folder_or_window_or_app', 'make_image', 'github_write', 'cloud_browse', 'next_task'].map(n => [n, async a => { ran.push(n); if (o.throwIn === n) throw new Error('disk full ' + 'ghp_' + 'z'.repeat(30)); return (o.out && o.out[n]) || 'ok ' + n; }])),
    ask: async r => { asked.push(r); return o.allow === false ? { allowed: false } : { allowed: true, callId: r.callId }; },
    budget: { gate: () => ({ ok: !(o.noBudget) }), spend: n => { (o.spent = o.spent || []).push(n); return { ok: true }; } },
    emit: e => events.push(e), now: (() => { let t = 1000; return () => ++t; })(),
  };
  return { deps, events, ran, asked, calls: () => i };
}

(async () => {
  // 1. the happy path: note, then edit, then done
  let r = rig([tool({ name: 'note_', text: 'plan' }), tool({ name: 'edit_file', path: 'a.js' }), tool({ name: 'done', summary: 'fixed' })]);
  let out = await L.run('fix a', r.deps);
  ok('happy path finishes', out.ok === true && out.summary === 'fixed');
  ok('tools ran in order', r.ran.join() === 'note_,edit_file');
  ok('the edit asked the user first', r.asked.length === 1 && r.asked[0].tool === 'edit_file');
  ok('the edit log has the tool events', r.events.filter(e => e.kind === 'tool').length === 2);

  // 2. the note rule: an edit with no note never runs
  r = rig([tool({ name: 'edit_file' }), tool({ name: 'edit_file' }), tool({ name: 'edit_file' })]);
  out = await L.run('x', r.deps);
  ok('edit without a note never ran', !r.ran.includes('edit_file'));
  ok('the same refusal 3 times stops the run', out.stopped === 'stuck');
  ok('the user was never asked for an edit that was refused', r.asked.length === 0);

  // 3. a second edit needs a new note
  r = rig([tool({ name: 'note_' }), tool({ name: 'edit_file' }), tool({ name: 'edit_file' }), tool({ name: 'note_' }), tool({ name: 'edit_file' }), tool({ name: 'done', summary: 'ok' })]);
  out = await L.run('x', r.deps);
  ok('a second edit without a new note is refused', r.events.filter(e => e.kind === 'refused' && e.code === 'note-first').length === 1);
  ok('after a new note the edit runs', r.ran.filter(n => n === 'edit_file').length === 2 && out.ok);

  // 4. task switch needs a note about the NEW task
  r = rig([tool({ name: 'note_' }), tool({ name: 'edit_file' }), tool({ name: 'next_task' }), tool({ name: 'edit_file' }), tool({ name: 'note_' }), tool({ name: 'edit_file' }), tool({ name: 'done', summary: 'ok' })]);
  out = await L.run('x', r.deps);
  ok('after next_task an edit without a new note is refused', r.events.filter(e => e.code === 'note-first').length === 1);
  ok('after a note about the new task the edit runs', r.ran.filter(n => n === 'edit_file').length === 2 && out.ok);
  r = rig([tool({ name: 'note_' }), tool({ name: 'next_task' }), tool({ name: 'edit_file' }), tool({ name: 'done', summary: 'ok' })]);
  out = await L.run('x', r.deps);
  ok('a note written BEFORE next_task does not count for the new task', r.events.some(e => e.code === 'note-first') && !r.ran.includes('edit_file'));

  // 5. the user says no
  r = rig([tool({ name: 'note_' }), tool({ name: 'edit_file' }), tool({ name: 'done', summary: 'gave up' })], { allow: false });
  out = await L.run('x', r.deps);
  ok('a denied edit never runs', !r.ran.includes('edit_file'));
  ok('the model is told it was denied', r.events.some(e => e.code === 'denied'));
  ok('denied three times in a row stops the run', (await L.run('x', rig([tool({ name: 'note_' }), tool({ name: 'edit_file' }), tool({ name: 'edit_file' }), tool({ name: 'edit_file' })], { allow: false }).deps)).stopped === 'stuck');

  // 6. strict tools ask every single time
  r = rig([tool({ name: 'note_' }), tool({ name: 'terminal_open', cmd: 'dir' }), tool({ name: 'note_' }), tool({ name: 'terminal_open', cmd: 'cd' }), tool({ name: 'done', summary: 'ok' })]);
  out = await L.run('x', r.deps);
  ok('each terminal command asked separately', r.asked.filter(a => a.tool === 'terminal_open').length === 2 && new Set(r.asked.map(a => a.callId)).size === r.asked.length);

  // 7. budget: stops before the model is even called
  r = rig([tool({ name: 'done', summary: 'x' })], { noBudget: true });
  out = await L.run('x', r.deps);
  ok('no credits: stopped before any model call', out.stopped === 'budget' && r.calls() === 0);

  // 8. costs are charged
  r = rig([tool({ name: 'screenshot_' }), tool({ name: 'make_image' }), tool({ name: 'done', summary: 'ok' })]);
  out = await L.run('x', r.deps);
  ok('screenshot 10 + image 45 charged', (r.deps.budget && out.spent === 55));

  // 9. unknown and inherited tool names
  r = rig([tool({ name: 'constructor' }), tool({ name: 'format_disk' }), tool({ name: 'done', summary: 'ok' })]);
  out = await L.run('x', r.deps);
  ok('unknown tools are refused, not run', r.events.filter(e => e.code === 'unknown-tool').length === 2 && r.ran.length === 0);

  // 10. a model that never picks a tool
  r = rig(['I will help you!', 'Sure thing', tool({ name: 'done', summary: 'ok' })]);
  out = await L.run('x', r.deps);
  ok('prose answers are retried, then it finishes', out.ok && r.events.filter(e => e.kind === 'retry').length === 2);

  // 11. a model that breaks
  r = rig([new Error('502 Bad Gateway from provider https://secret.internal/key=abc')]);
  out = await L.run('x', r.deps);
  ok('a model failure stops the run', out.stopped === 'model');
  ok('the user sees only a generic failure message', r.events.every(e => !/502|provider|secret|key=/.test(JSON.stringify(e))));

  // 12. a tool that throws, with a secret in its error
  r = rig([tool({ name: 'cloud_browse' }), tool({ name: 'done', summary: 'ok' })], { throwIn: 'cloud_browse' });
  out = await L.run('x', r.deps);
  ok('a throwing tool does not crash the run', out.ok === true);
  ok('the secret in the error never reaches the log', r.events.every(e => !JSON.stringify(e).includes('ghp_')));

  // 13. secrets in results and summaries
  r = rig([tool({ name: 'screenshot_' }), tool({ name: 'done', summary: 'token github_pat_' + 'Q'.repeat(30) })], { out: { screenshot_: 'screen shows ghp_' + 'k'.repeat(30) } });
  out = await L.run('x', r.deps);
  ok('secrets in a screenshot reading are hidden', r.events.every(e => !JSON.stringify(e).includes('ghp_')));
  ok('secrets in the final summary are hidden', !out.summary.includes('github_pat_') && !r.events.some(e => JSON.stringify(e).includes('github_pat_')));

  // 14. the step limit
  r = rig(Array.from({ length: 60 }, (_, i) => tool({ name: i % 2 ? 'screenshot_' : 'cloud_browse' })));
  out = await L.run('x', r.deps);
  ok('the step limit stops a run that never finishes', out.stopped === 'steps' && out.steps === L.MAX_STEPS);

  // 15. parser
  ok('parser: plain', L.parse('<tool>{"name":"a"}</tool>').name === 'a');
  ok('parser: with text around it', L.parse('Sure!\n<tool>{"name":"a","x":1}</tool> thanks').x === 1);
  ok('parser: broken json', L.parse('<tool>{name:a}</tool>') === null);
  ok('parser: no tag', L.parse('{"name":"a"}') === null);
  ok('parser: name must be text', L.parse('<tool>{"name":5}</tool>') === null);
  ok('parser: empty', L.parse('') === null && L.parse(null) === null);

  console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`);
  process.exit(fail ? 1 : 0);
})();
