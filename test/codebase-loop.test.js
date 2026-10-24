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

  // 8b. only a call that worked is counted: a refused or failed generator costs nothing (the cloud gives failed ones back)
  for (const [label, res] of [['REFUSED', 'REFUSED: That folder is read-only.'], ['ERROR', 'ERROR: It could not be made. You were not charged.']]) {
    r = rig([tool({ name: 'make_image' }), tool({ name: 'done', summary: 'ok' })]);
    r.deps.tools.make_image = async () => { r.ran.push('make_image'); return res; };
    out = await L.run('x', r.deps);
    ok('a ' + label + ' generator is not counted on the usage bar', out.spent === 0 && !(r.deps.budget.spent), JSON.stringify([out.spent, r.deps.budget]));
  }
  r = rig([tool({ name: 'make_image' }), tool({ name: 'done', summary: 'ok' })]);
  r.deps.tools.make_image = async () => 'Saved image to C:\\p\\a.png (1000 bytes).';
  out = await L.run('x', r.deps); ok('a generator that worked is still counted (45)', out.spent === 45);
  r = rig([tool({ name: 'screenshot_' }), tool({ name: 'done', summary: 'ok' })]);
  r.deps.tools.screenshot_ = async () => 'ERROR: no screen';
  out = await L.run('x', r.deps); ok('a failed screenshot is not counted either', out.spent === 0);
  // 8c. Stop reaches the tool, so a long wait can end at once
  { const ac = new AbortController(); let seen = null;
    r = rig([tool({ name: 'make_image' }), tool({ name: 'done', summary: 'ok' })]); r.deps.signal = ac.signal;
    r.deps.tools.make_image = async (args, ctx) => { seen = ctx && ctx.signal; return 'Saved image to x.'; };
    await L.run('x', r.deps); ok('the run\'s Stop signal is handed to the tool', seen === ac.signal); }

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

  // 14. long runs: no small step cap; a run ends by credits, time, being stuck, or Stop
  ok('there is no small step cap (a real build needs hundreds of steps)', L.MAX_STEPS >= 10000);
  {
    const N = 300, script = [tool({ name: 'note_', text: 'plan' })]; for (let i = 0; i < N; i++) script.push(tool({ name: i % 2 ? 'screenshot_' : 'cloud_browse' })); script.push(tool({ name: 'done', summary: 'built it' }));
    r = rig(script); out = await L.run('big build', { ...r.deps, maxMinutes: 240 });
    ok('300 steps then done finishes normally', out.ok === true && out.steps === N + 2 && out.summary === 'built it');
  }
  // time limit: a clock we control
  const clockRig = (script, startMs, tickMs) => { const r2 = rig(script); let t = startMs; r2.deps.now = () => (t += tickMs); return r2; };
  r = clockRig(Array.from({ length: 50 }, () => tool({ name: 'cloud_browse' })), 0, 60000);   // each call takes a minute
  out = await L.run('slow', { ...r.deps, maxMinutes: 5 });
  ok('a run that is too slow stops at its time limit', out.ok === false && out.stopped === 'time');
  ok('the time stop is explained and says work is saved', r.events.some(e => e.kind === 'stopped' && e.reason === 'time' && /saved/.test(e.say) && /5 minutes/.test(e.say)));
  ok('it did real work before stopping (not zero steps)', out.steps >= 1 && out.steps < 50);
  r = clockRig([tool({ name: 'done', summary: 's' })], 0, 1000);
  out = await L.run('quick', { ...r.deps, maxMinutes: 5 }); ok('a quick run is not affected by the limit', out.ok === true);
  r = clockRig(Array.from({ length: 400 }, () => tool({ name: 'cloud_browse' })), 0, 60000);
  out = await L.run('x', { ...r.deps, maxMinutes: 100000 });
  ok('nobody can set the limit above the 4 hour hard maximum', out.stopped === 'time' && /240 minutes/.test(r.events.find(e => e.kind === 'stopped').say) && L.HARD_MAX_MINUTES === 240);
  for (const bad of [0, -5, NaN, 'abc', null, undefined, {}]) { r = clockRig([tool({ name: 'done', summary: 's' })], 0, 1000); out = await L.run('x', { ...r.deps, maxMinutes: bad }); ok('a junk time limit falls back to the default: ' + JSON.stringify(bad), out.ok === true); }
  {
    let clock = 0; r = rig(Array.from({ length: 400 }, () => tool({ name: 'cloud_browse' }))); r.deps.now = () => (clock += 60000);
    out = await L.run('x', r.deps);
    const stopEvent = r.events.find(e => e.kind === 'stopped');
    ok('the default time limit is 45 minutes', out.stopped === 'time' && /45 minutes/.test(stopEvent.say) && L.DEFAULT_MAX_MINUTES === 45);
    ok('it stopped no earlier than 45 minutes and not long after', clock / 60000 >= 45 && clock / 60000 <= 45 + 6);
  }
  // the budget and the stuck detector still end a runaway
  r = rig(Array.from({ length: 10 }, () => tool({ name: 'nonexistent_tool' }))); out = await L.run('x', r.deps);
  ok('a model that keeps calling a missing tool is stopped as stuck', out.stopped === 'stuck');
  r = rig(Array.from({ length: 50 }, () => tool({ name: 'cloud_browse' })), { noBudget: true }); out = await L.run('x', r.deps);
  ok('no credits stops the run before any model call', out.stopped === 'budget' && r.calls() === 0);

  // 14b. compaction keeps the context small and keeps the agent's notes
  const big = n => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i + ' ' + 'x'.repeat(2000) }));
  const base = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'TASK' }, ...big(40)];
  const notes = ['plan the menu', 'menu done, next the cart'];
  let c = L.compact(base, notes);
  ok('a long history is compacted', c.length < base.length && JSON.stringify(c).length < JSON.stringify(base).length / 2);
  ok('compaction keeps the system prompt and the task first', c[0].content === 'SYS' && c[1].content === 'TASK');
  ok('compaction keeps the newest messages word for word', c.slice(-L.KEEP_RECENT).every((m, i) => m.content === base[base.length - L.KEEP_RECENT + i].content));
  ok('compaction keeps the notes', c.some(m => /plan the menu/.test(m.content) && /menu done, next the cart/.test(m.content)));
  ok('compaction says how much it shortened', c.some(m => /older messages were shortened/.test(m.content)));
  const small = [{ role: 'system', content: 'S' }, { role: 'user', content: 'T' }, ...big(3).map(m => ({ ...m, content: 'short' }))];
  ok('a short history is left alone', L.compact(small, notes) === small);
  ok('compaction with no notes still works', L.compact(base, []).some(m => /no notes yet/.test(m.content)));
  ok('only the last 12 notes are carried', L.compact(base, Array.from({ length: 30 }, (_, i) => 'note' + i)).some(m => /note29/.test(m.content) && !/note0\b/.test(m.content)));
  {
    const seen = []; r = rig([tool({ name: 'note_', text: 'first plan' }), ...Array.from({ length: 30 }, () => tool({ name: 'cloud_browse' })), tool({ name: 'done', summary: 'ok' })]);
    r.deps.tools.cloud_browse = async () => 'y'.repeat(5000); const origModel = r.deps.model; r.deps.model = async m => { seen.push(JSON.stringify(m).length); return origModel(m); };
    out = await L.run('long', { ...r.deps, maxMinutes: 240 });
    ok('a long run finishes', out.ok === true);
    ok('the history sent to the model never grows past the limit', Math.max(...seen) < L.COMPACT_AT_CHARS + 3 * 6200 + 4000);
  }

  // 15. parser
  ok('parser: plain', L.parse('<tool>{"name":"a"}</tool>').name === 'a');
  ok('parser: with text around it', L.parse('Sure!\n<tool>{"name":"a","x":1}</tool> thanks').x === 1);
  ok('parser: broken json', L.parse('<tool>{name:a}</tool>') === null);
  ok('parser: no tag', L.parse('{"name":"a"}') === null);
  ok('parser: name must be text', L.parse('<tool>{"name":5}</tool>') === null);
  ok('parser: empty', L.parse('') === null && L.parse(null) === null);

  // ---- wrapped arguments (found in a REAL run: {"name":"note_","args":{"text":..}} was refused as "a note needs text", 115 credits burned) ----
  ok('args wrapper is unwrapped', JSON.stringify(L.parse('<tool>{"name":"note_","args":{"text":"hi"}}</tool>')) === '{"name":"note_","text":"hi"}');
  ok('arguments wrapper is unwrapped', JSON.stringify(L.parse('<tool>{"name":"note_","arguments":{"text":"hi"}}</tool>')) === '{"name":"note_","text":"hi"}');
  ok('flat form still works', JSON.stringify(L.parse('<tool>{"name":"note_","text":"hi"}</tool>')) === '{"name":"note_","text":"hi"}');
  ok('the tool name can never be replaced from inside the wrapper', L.parse('<tool>{"name":"note_","args":{"name":"delete_folder_or_window_or_app","text":"x"}}</tool>').name === 'note_');
  ok('a non-object wrapper is left alone', L.parse('<tool>{"name":"a","args":"text"}</tool>').args === 'text');
  ok('an array wrapper is left alone', Array.isArray(L.parse('<tool>{"name":"a","args":[1]}</tool>').args));
  ok('a null wrapper is left alone', L.parse('<tool>{"name":"a","args":null}</tool>').name === 'a');
  { const rw = rig([tool({ name: 'note_', args: { text: 'plan' } }), tool({ name: 'edit_file', arguments: { path: 'a.js' } }), tool({ name: 'done', summary: 'ok' })]);
    const ow = await L.run('x', rw.deps); ok('a whole run works with wrapped arguments', ow.ok === true && rw.ran.join() === 'note_,edit_file'); }
  { let seen = null; const rw = rig([tool({ name: 'note_', args: { text: 'plan' } }), tool({ name: 'done', summary: 'ok' })]); rw.deps.tools.note_ = async a => { seen = a; return 'ok'; };
    await L.run('x', rw.deps); ok('the tool receives the unwrapped arguments', seen && seen.text === 'plan' && seen.args === undefined); }

  // ---- a tool that keeps failing the same way is stuck too ----
  { const r6 = rig(Array.from({ length: 30 }, () => tool({ name: 'note_', text: 'x' }))); r6.deps.tools.note_ = async () => 'REFUSED: A note needs text.';
    const o6 = await L.run('x', r6.deps); ok('the same REFUSED result ' + L.MAX_SAME + ' times stops the run', o6.ok === false && o6.stopped === 'stuck' && r6.calls() === L.MAX_SAME);
    ok('and the person is told in plain words', r6.events.some(e => e.kind === 'stopped' && /kept failing/.test(e.say))); }
  { const r7 = rig(Array.from({ length: 30 }, () => tool({ name: 'note_', text: 'x' }))); r7.deps.tools.note_ = async () => 'ERROR: disk full';
    const o7 = await L.run('x', r7.deps); ok('the same ERROR result stops the run too', o7.stopped === 'stuck' && r7.calls() === L.MAX_SAME); }
  { let k = 0; const r8 = rig(Array.from({ length: 12 }, () => tool({ name: 'note_', text: 'x' })).concat([tool({ name: 'done', summary: 'ok' })])); r8.deps.tools.note_ = async () => (++k % 3 === 0 ? 'fine' : 'ERROR: try again');
    const o8 = await L.run('x', r8.deps); ok('a failure now and then, with successes between, is not stuck', o8.ok === true); }
  { let k = 0; const r9 = rig(Array.from({ length: 12 }, () => tool({ name: 'note_', text: 'x' })).concat([tool({ name: 'done', summary: 'ok' })])); r9.deps.tools.note_ = async () => 'ERROR: failure number ' + (++k);
    const o9 = await L.run('x', r9.deps); ok('different errors are counted separately', o9.ok === false ? o9.stopped !== 'stuck' || r9.calls() > L.MAX_SAME : true); }

  // ---- a model that never picks a tool must not spend forever (found in a REAL run: it retried until stopped by hand) ----
  { let asks = 0; const r2 = rig([]); r2.deps.model = async () => { asks++; return 'I think I should look at the file first.'; };
    const o2 = await L.run('x', r2.deps);
    ok('endless "no tool" replies stop the run', o2.ok === false && o2.stopped === 'stuck');
    ok('it stops after exactly ' + L.MAX_MISS + ' paid requests, not more', asks === L.MAX_MISS);
    ok('the person is told in plain words', r2.events.some(e => e.kind === 'stopped' && /could not decide/.test(e.say)));
    ok('the message names no model or provider', !r2.events.some(e => /qwen|free\.ai|HTTP/i.test(JSON.stringify(e)))); }
  { let n = 0; const r3 = rig([]); r3.deps.model = async () => { n++; return n % 3 === 0 ? tool({ name: 'note_', text: 'ok' }) : (n > 12 ? tool({ name: 'done', summary: 'fine' }) : 'hmm'); };
    const o3 = await L.run('x', r3.deps);
    ok('a good tool call resets the miss counter (two misses, a tool, two misses, ... still finishes)', o3.ok === true); }
  { let n = 0; const r4 = rig([]); r4.deps.model = async () => { n++; return n <= L.MAX_MISS - 1 ? 'no tool' : tool({ name: 'done', summary: 'recovered' }); };
    const o4 = await L.run('x', r4.deps); ok('one miss fewer than the limit still recovers', o4.ok === true && o4.summary === 'recovered'); }
  { const r5 = rig([tool({ name: 'note_', text: 'a' }), 'no tool', 'no tool', 'no tool', tool({ name: 'note_', text: 'b' }), 'no tool', 'no tool', 'no tool', tool({ name: 'done', summary: 'ok' })]);
    const o5 = await L.run('x', r5.deps); ok('misses are counted in a row, not in total', o5.ok === true); }

  console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`);
  process.exit(fail ? 1 : 0);
})();
