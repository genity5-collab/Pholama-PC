'use strict';
// Pholama Codebase agent loop. Everything outside the loop (the model, the real tools, the clock, the user's Allow button) is injected,
// so the loop itself is tested with fakes and the real Windows tools plug in without changing a rule.
//
// One turn: the model writes ONE <tool>{...}</tool> line. The loop then, in this order:
//   1. checks the credit budget  2. checks the tool exists  3. checks the note rule  4. asks the user if the tool needs it
//   5. runs it  6. hides secrets in the result  7. writes the edit log  8. hands the result back to the model.
// A model can never reach step 5 by skipping 1 to 4.
const T = require('./codebase-tools');

const MAX_STEPS = 40;            // hard stop so a confused model cannot loop forever
const MAX_RESULT = 6000;         // characters of a tool result given back to the model
const MAX_SAME = 3;              // the same refused call this many times in a row stops the run
const TOOL_RE = /<tool>\s*(\{[\s\S]*?\})\s*<\/tool>/;

const SYSTEM = `You are Pholama Codebase, a coding agent on the user's PC. Reply with EXACTLY ONE line per turn in this format and nothing else:
<tool>{"name":"TOOL","...args"}</tool>
RULES
- Write a note_ (what you will do, what is done, what is next) BEFORE every edit. When the first task is finished call next_task, then write a note_ about the new task before editing.
- Take screenshot_ before and after you open or close anything, and whenever you wander the PC or a page seems stuck.
- If a screenshot shows an error page, a frozen window or a site that will not load, close that window yourself, then try one alternative.
- Only close windows you opened. Pick the title exactly from OPEN WINDOWS.
- Prefer pull_file, fix the copy, then push_files_to_pc, over editing the user's file in place.
- When everything is finished call {"name":"done","summary":"..."}.
TOOLS: ` + T.list().map(t => t.name).join(', ') + ', done';

function parse(text) {
  const m = TOOL_RE.exec(String(text || ''));
  if (!m) return null;
  try { const o = JSON.parse(m[1]); return o && typeof o.name === 'string' ? o : null; } catch { return null; }
}

// deps: { model(messages) -> text, tools{name:async(args)->string}, ask(req)->{allowed,callId}, budget{gate(),spend(n)}, emit(event), now() }
async function run(task, deps) {
  const { model, tools, ask, budget, emit = () => {}, now = Date.now } = deps;
  const msgs = [{ role: 'system', content: SYSTEM }, { role: 'user', content: String(task || '') }];
  const mem = { lastNoteAt: 0, lastEditAt: 0, taskId: 1, noteTaskId: 0 };
  let seq = 0, tick = 0, lastRefused = '', sameCount = 0, spent = 0;
  const log = (kind, data) => emit({ kind, at: now(), ...data });

  for (let step = 1; step <= MAX_STEPS; step++) {
    const g = budget.gate();
    if (g && g.ok === false) { log('stopped', { reason: 'budget', say: g.say || 'Out of credits for now.' }); return { ok: false, stopped: 'budget', steps: step - 1, spent }; }

    let text;
    try { text = await model(msgs); } catch (e) { log('stopped', { reason: 'model', say: 'The model could not answer. Try again in a moment.' }); return { ok: false, stopped: 'model', steps: step - 1, spent }; }   // no provider details to the user
    const call = parse(text);
    if (!call) { log('retry', { step, say: 'The model did not pick a tool; asking again.' }); msgs.push({ role: 'assistant', content: String(text || '').slice(0, 500) }, { role: 'user', content: 'Reply with exactly one <tool>{"name":...}</tool> line.' }); continue; }
    msgs.push({ role: 'assistant', content: '<tool>' + JSON.stringify(call) + '</tool>' });
    const { name, ...args } = call;
    const callId = 'c' + (++seq);

    if (name === 'done') {
      log('done', { say: T.redact(String(args.summary || '')).slice(0, 800) });
      return { ok: true, steps: step, spent, summary: T.redact(String(args.summary || '')) };
    }

    const refuse = (code, say) => {
      const key = name + ':' + code;
      sameCount = key === lastRefused ? sameCount + 1 : 1; lastRefused = key;
      log('refused', { step, tool: name, code, say });
      msgs.push({ role: 'user', content: 'REFUSED: ' + say });
      return sameCount >= MAX_SAME;
    };

    // 2. does the tool exist?
    const meta = T.describe(name);
    if (!meta || typeof tools[name] !== 'function') { if (refuse('unknown-tool', 'There is no tool called that. Use only the listed tools.')) return { ok: false, stopped: 'stuck', steps: step, spent }; continue; }

    // 3. the note rule
    const nr = T.noteRule(name, mem);
    if (!nr.ok) { if (refuse(nr.code, nr.say)) return { ok: false, stopped: 'stuck', steps: step, spent }; continue; }

    // 4. permission: ask the user, show the exact target
    if (meta.level !== 'none') {
      log('ask', { step, tool: name, level: meta.level, callId, args: T.redact(JSON.stringify(args)).slice(0, 400) });
      let approval = null;
      try { approval = await ask({ tool: name, level: meta.level, callId, args }); } catch {}
      const gt = T.gate(name, args, approval, callId);
      if (!gt.ok) { if (refuse('denied', 'The user did not allow this. Do not retry it; pick another way or finish.')) return { ok: false, stopped: 'stuck', steps: step, spent }; continue; }
    }

    // 5. run it (a tool that throws is an ordinary result, not a crash)
    let result;
    try { result = await tools[name](args); } catch (e) { result = 'ERROR: ' + String(e && e.message || e).slice(0, 200); }
    tick = now();
    if (name === 'note_') { mem.lastNoteAt = tick; mem.noteTaskId = mem.taskId; }
    if (name === 'next_task') mem.taskId++;   // the LOOP counts tasks, so the model cannot skip the note by leaving a flag out
    if (T.isEditing(name)) mem.lastEditAt = tick;
    if (meta.cost) { const sp = budget.spend(meta.cost); spent += meta.cost; if (sp && sp.ok === false) { log('stopped', { reason: 'budget', say: 'Out of credits for now.' }); return { ok: false, stopped: 'budget', steps: step, spent }; } }
    lastRefused = ''; sameCount = 0;

    // 6 + 7 + 8. hide secrets, write the edit log, hand back to the model
    const clean = T.redact(typeof result === 'string' ? result : JSON.stringify(result)).slice(0, MAX_RESULT);
    log('tool', { step, tool: name, cost: meta.cost, args: T.redact(JSON.stringify(args)).slice(0, 400), result: clean });
    msgs.push({ role: 'user', content: 'RESULT: ' + clean });
  }
  log('stopped', { reason: 'steps', say: 'Reached the step limit.' });
  return { ok: false, stopped: 'steps', steps: MAX_STEPS, spent };
}

module.exports = { run, parse, SYSTEM, MAX_STEPS, MAX_SAME };
