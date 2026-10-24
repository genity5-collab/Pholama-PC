'use strict';
// Pholama Codebase agent loop. Everything outside the loop (the model, the real tools, the clock, the user's Allow button) is injected,
// so the loop itself is tested with fakes and the real Windows tools plug in without changing a rule.
//
// One turn: the model writes ONE <tool>{...}</tool> line. The loop then, in this order:
//   1. checks the credit budget  2. checks the tool exists  3. checks the note rule  4. asks the user if the tool needs it
//   5. runs it  6. hides secrets in the result  7. writes the edit log  8. hands the result back to the model.
// A model can never reach step 5 by skipping 1 to 4.
const T = require('./codebase-tools');

const MAX_STEPS = 100000;        // not a real limit: a run ends by credits, the time limit, the stuck detector or the Stop button
const DEFAULT_MAX_MINUTES = 45;  // a long build may run this long; the user can raise it for a run
const HARD_MAX_MINUTES = 240;    // nobody can set it higher than 4 hours
const LOGIN_WAIT_MS = 6000;   // after a login error, wait this long for the page to hand over a fresh one
const RETRY_WAITS = [1000, 3000, 8000];   // pauses before the 2nd, 3rd and 4th try of one model call
const KEEP_RECENT = 14;          // newest messages kept word for word when the history is compacted
const COMPACT_AT_CHARS = 36000;  // about 9k tokens: compact before the model's window fills up
const MAX_RESULT = 6000;         // characters of a tool result given back to the model
const MAX_MISS = 4;              // this many replies in a row with no usable tool stops the run (each one is a paid request)
const MAX_REPEAT_NUDGE = 3, MAX_REPEAT_STOP = 6;   // the SAME call giving the SAME result this many times in a row: first a nudge, then the run stops (each try is a paid request)
const MAX_SAME = 3;              // the same refused call this many times in a row stops the run
const TOOL_RE = /<tool>\s*(\{[\s\S]*?\})\s*<\/tool>/;

const SYSTEM = `You are Pholama Codebase, a coding agent on the user's PC. Reply with EXACTLY ONE line per turn in this format and nothing else:
<tool>{"name":"TOOL","...args"}</tool>
RULES
- Write a note_ (what you will do, what is done, what is next) BEFORE every edit. Start a note with \u2705 when something worked and with \u274C when something failed, so the person sees at a glance. When the first task is finished call next_task, then write a note_ about the new task before editing.
- Take screenshot_ before and after you open or close anything, and whenever you wander the PC or a page seems stuck.
- If a screenshot shows an error page, a frozen window or a site that will not load, close that window yourself, then try one alternative.
- Only close windows you opened. Pick the title exactly from OPEN WINDOWS.
- Prefer pull_file, fix the copy, then push_files_to_pc, over editing the user's file in place.
- There is NO limit on how big a project or file can be. Write big files in parts: edit_file with append:true adds to the end of a file, so write the first part, then append the next parts, each part up to about 300 lines.
- Build the whole thing, not a small demo. Keep going until the task is truly finished and checked, then call done.
- Look at your work: read files back with pull_file and take screenshot_ to check the result before you say done.
- Your memory is shown above the TASK. Use remember to save a lasting fact (the person's project folder, their preferences, what you learned) and forget to remove an old one.
- When everything is finished call {"name":"done","summary":"..."}.
EXAMPLES (copy the shape exactly; one line, double quotes):
<tool>{"name":"note_","text":"Open YouTube, then check it with a screenshot."}</tool>
<tool>{"name":"pc_browse","url":"https://www.youtube.com"}</tool>
<tool>{"name":"screenshot_"}</tool>
<tool>{"name":"open_window","target":"notepad"}</tool>
<tool>{"name":"close_window","title":"exact title from OPEN WINDOWS"}</tool>
<tool>{"name":"pull_file","path":"C:\\folder\\a.js"}</tool>
<tool>{"name":"edit_file","path":"C:\\folder\\a.js","content":"whole new file text"}</tool>
<tool>{"name":"create_item","path":"C:\\folder\\new.txt","content":"text"}</tool>
<tool>{"name":"user_pc","action":"click","x":400,"y":300}</tool>
<tool>{"name":"user_pc","action":"search","text":"best pizza near me"}</tool>
<tool>{"name":"user_pc","action":"type","text":"hello world"}</tool>
<tool>{"name":"user_pc","action":"key","key":"enter"}</tool>
To SEARCH the web use action "search" (it opens the results). To type into a page: click the box, then action "type", then action "key" with "enter". Keys: enter, tab, esc, backspace, delete, up, down, left, right, space, f5, ctrl+l, ctrl+f, ctrl+a, ctrl+c, ctrl+v, ctrl+r, ctrl+t, ctrl+w, alt+left.
More user_pc actions: "double_click" and "right_click" (with x,y), "move" (x,y), "scroll" (amount: negative = down, up to 20), and "wait" (seconds 1 to 20, so a page can load). Take a screenshot after a click or wait to check it worked.
<tool>{"name":"cloud_browse","url":"https://example.com"}</tool>
<tool>{"name":"done","summary":"what you did"}</tool>
To open a website for the user use pc_browse with a full https address. Never answer with plain text, always one <tool> line.
TOOLS: ` + T.list().map(t => t.name).join(', ') + ', done';

// Keeps the system prompt, the task, a running summary and the newest messages. The notes the agent wrote are never dropped: they are its memory.
function compact(msgs, notes, attempt = 0) {
  const size = m => m.reduce((n, x) => n + String(x.content).length, 0);
  const keep = attempt >= 2 ? 5 : attempt === 1 ? 8 : KEEP_RECENT, limit = attempt >= 1 ? Math.floor(COMPACT_AT_CHARS / 2) : COMPACT_AT_CHARS;   // a failing call may be a too-big prompt: shrink on the retries
  if (size(msgs) <= limit || msgs.length <= keep + 3) return msgs;
  const head = msgs.slice(0, 2), tail = msgs.slice(-keep), dropped = msgs.length - head.length - tail.length;
  const memo = 'EARLIER WORK (' + dropped + ' older messages were shortened to save space). Your notes so far:\n' + (notes.length ? notes.slice(-12).map((n, i) => '- ' + n).join('\n') : '(no notes yet)');
  return [...head, { role: 'user', content: memo }, ...tail];
}

function parse(text) {
  const raw = String(text || '');
  // The tag with or without the closing tag, a code fence, or a bare JSON line with a "name".
  let body = null;
  const m = TOOL_RE.exec(raw) || /<tool>\s*(\{[\s\S]*\})/.exec(raw);
  if (m) body = m[1];
  else { const f = /```(?:json|tool)?\s*(\{[\s\S]*?\})\s*```/.exec(raw) || /(\{\s*"name"\s*:[\s\S]*\})/.exec(raw); if (f) body = f[1]; }
  if (!body) return null;
  const tryParse = t => { try { return JSON.parse(t); } catch { return null; } };
  let o = tryParse(body);
  if (!o) { for (let end = body.lastIndexOf('}'); end > 0 && !o; end = body.lastIndexOf('}', end - 1)) o = tryParse(body.slice(0, end + 1)); }   // trailing words after the JSON
  if (!o) o = tryParse(body.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"'));   // trailing commas, single quotes
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (typeof o.name !== 'string') { const n = o.tool || o.function || o.action_name; if (typeof n === 'string') o.name = n; else return null; }
  // The model often writes {"name":"x","args":{...}} or {"name":"x","arguments":{...}}; the real arguments are inside. Flat form still works.
  for (const k of ['args', 'arguments', 'parameters', 'input']) {
    const w = o[k];
    if (w && typeof w === 'object' && !Array.isArray(w)) { const { [k]: _drop, ...rest } = o; return { ...rest, ...w, name: o.name }; }
  }
  return o;
}

// deps: { model(messages) -> text, tools{name:async(args)->string}, ask(req)->{allowed,callId}, budget{gate(),spend(n)}, emit(event), now() }
async function run(task, deps) {
  const { model, tools, ask, budget, emit = () => {}, now = Date.now } = deps;
  const minutes = Math.min(HARD_MAX_MINUTES, Math.max(1, Number(deps.maxMinutes) || DEFAULT_MAX_MINUTES)), startedAt = now(), deadline = startedAt + minutes * 60000;
  const notes = [];
  const memo = typeof deps.context === 'string' && deps.context ? deps.context + '\n\n' : '';   // what the agent remembers from earlier runs
  const msgs = [{ role: 'system', content: SYSTEM }, { role: 'user', content: memo + 'TASK: ' + String(task || '') }];
  const mem = { lastNoteAt: 0, lastEditAt: 0, taskId: 1, noteTaskId: 0 };
  let seq = 0, tick = 0, lastRefused = '', sameCount = 0, spent = 0, misses = 0, badCount = 0, lastBad = '', lastSig = '', repeatCount = 0;
  const log = (kind, data) => emit({ kind, at: now(), ...data });

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (now() >= deadline) { log('stopped', { reason: 'time', say: 'Reached the time limit for this run (' + minutes + ' minutes). Everything done so far is saved. Start another run to continue.' }); return { ok: false, stopped: 'time', steps: step - 1, spent }; }
    if (deps.signal && deps.signal.aborted) { log('stopped', { reason: 'stop', say: 'Stopped.' }); return { ok: false, stopped: 'stop', steps: step - 1, spent }; }
    const g = budget.gate();
    if (g && g.ok === false) { log('stopped', { reason: 'budget', say: g.say || 'Out of credits for now.' }); return { ok: false, stopped: 'budget', steps: step - 1, spent }; }

    let text;
    {
      // A model hiccup (busy server, dropped connection, empty reply) is retried a few times with a short wait, so one bad moment does not end a long job.
      // Login, credits and Stop are NOT retried: they will not fix themselves in seconds. The person is told the real reason in plain words, never a provider or model name.
      let err = null, loginRetried = false;
      for (let attempt = 0; attempt <= RETRY_WAITS.length; attempt++) {
        if (deps.signal && deps.signal.aborted) { log('stopped', { reason: 'stop', say: 'Stopped.' }); return { ok: false, stopped: 'stop', steps: step - 1, spent }; }
        try { msgs.splice(0, msgs.length, ...compact(msgs, notes, attempt)); text = await model(msgs, deps.signal); err = null; break; } catch (e) { err = e; }
        const kind = err && err.plain ? err.kind : 'busy';
        if (kind === 'login' && !loginRetried) {   // the login may just have expired: the page sends a fresh one while we wait, so try once more
          loginRetried = true; log('retry', { step, say: 'Refreshing your sign-in...' });
          await (deps.sleep || (ms => new Promise(r => setTimeout(r, ms))))(LOGIN_WAIT_MS); continue;
        }
        if (kind !== 'busy' && kind !== 'network') break;
        if (attempt < RETRY_WAITS.length) {
          log('retry', { step, say: 'The AI is slow right now. Trying again (' + (attempt + 1) + ' of ' + RETRY_WAITS.length + ')...' });
          await (deps.sleep || (ms => new Promise(r => setTimeout(r, ms))))(RETRY_WAITS[attempt]);
        }
      }
      if (err) {
        const kind = err && err.plain ? err.kind : 'busy';
        if (kind === 'stopped') { log('stopped', { reason: 'stop', say: 'Stopped.' }); return { ok: false, stopped: 'stop', steps: step - 1, spent }; }
        const say = { login: 'Sign in to Pholama to continue.', limit: 'Not enough credits right now. They come back by themselves as the month moves on.', network: 'Could not reach the Pholama cloud. Check your connection, then press Start again.' }[kind] || 'The AI did not answer after a few tries. Press Start again in a moment.';
        log('stopped', { reason: kind === 'login' ? 'login' : kind === 'limit' ? 'credits' : 'model', say });
        return { ok: false, stopped: kind === 'login' ? 'login' : kind === 'limit' ? 'credits' : 'model', steps: step - 1, spent };
      }
    }
    const call = parse(text);
    if (!call) { if (++misses >= MAX_MISS) { log('stopped', { reason: 'stuck', say: 'The agent could not decide what to do. Try rewording the task.' }); return { ok: false, stopped: 'stuck', steps: step, spent }; } log('retry', { step, say: 'The model did not pick a tool; asking again.' }); msgs.push({ role: 'assistant', content: String(text || '').slice(0, 500) }, { role: 'user', content: 'Reply with exactly one tool line, nothing before or after it. Your last reply had no tool. Like this:\n<tool>{"name":"pc_browse","url":"https://www.youtube.com"}</tool>\nPick the tool that does the next step of the task. If the task is finished: <tool>{"name":"done","summary":"what you did"}</tool>' }); continue; }
    misses = 0;
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
      if (typeof deps.onResult === 'function') { try { deps.onResult({ good: false, tool: name, what: name, detail: T.redact(String(say)).slice(0, 160) }); } catch {} }
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
    let shotId = null;
    try { result = await tools[name](args, { signal: deps.signal, shot: id => { shotId = id; } }); } catch (e) { result = 'ERROR: ' + String(e && e.message || e).slice(0, 200); }
    tick = now();
    if (name === 'note_') { mem.lastNoteAt = tick; mem.noteTaskId = mem.taskId; notes.push(String(args.text || '').slice(0, 300)); if (notes.length > 40) notes.shift(); }
    if (name === 'next_task') mem.taskId++;   // the LOOP counts tasks, so the model cannot skip the note by leaving a flag out
    if (T.isEditing(name)) mem.lastEditAt = tick;
    const failedCall = typeof result === 'string' && /^(REFUSED|ERROR):/.test(result);   // a refused or failed call produced nothing, and the cloud refunds failed generators: it is not counted
    if (meta.cost && !failedCall) { const sp = budget.spend(meta.cost); spent += meta.cost; if (sp && sp.ok === false) { log('stopped', { reason: 'budget', say: 'Out of credits for now.' }); return { ok: false, stopped: 'budget', steps: step, spent }; } }
    // A tool that keeps answering REFUSED / ERROR for the same call is stuck just like a refused call: each try is a paid request.
    { const bad = typeof result === 'string' && /^(REFUSED|ERROR):/.test(result), key = name + ':' + (bad ? result.slice(0, 80) : '');
      if (bad) { badCount = key === lastBad ? badCount + 1 : 1; lastBad = key; } else { badCount = 0; lastBad = ''; }
      if (badCount >= MAX_SAME) { log('tool', { step, tool: name, cost: 0, args: T.redact(JSON.stringify(args)).slice(0, 400), result: T.redact(String(result)).slice(0, 300) }); log('stopped', { reason: 'stuck', say: 'The same step kept failing, so the run was stopped. Check the message above or try rewording the task.' }); return { ok: false, stopped: 'stuck', steps: step, spent }; } }
    lastRefused = ''; sameCount = 0;
    // Repeating itself: the same call with the same result again and again is not progress, even though every try "worked".
    { const sig = name + '|' + JSON.stringify(args) + '|' + String(typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 200);
      repeatCount = sig === lastSig ? repeatCount + 1 : 1; lastSig = sig;
      if (repeatCount >= MAX_REPEAT_STOP) { log('stopped', { reason: 'stuck', say: 'The agent kept repeating the same step, so the run was stopped. Try rewording the task.' }); return { ok: false, stopped: 'stuck', steps: step, spent }; }
    }

    // A tick or a cross for this step in the agent's notes (never lets a notes problem stop the work). Notes themselves and the end are not marked.
    if (typeof deps.onResult === 'function' && name !== 'note_' && name !== 'next_task') {
      try {
        const bad = typeof result === 'string' && /^(REFUSED|ERROR):/.test(result);
        const target = args.path || args.url || args.query || args.text || args.target || args.title || args.action || args.repo || args.from || args.command || '';
        const what = name + (target ? ' ' + String(target).replace(/\s+/g, ' ').slice(0, 90) : '');
        deps.onResult({ good: !bad, tool: name, what: T.redact(what), detail: bad ? T.redact(String(result).replace(/^(REFUSED|ERROR):\s*/, '')).slice(0, 160) : '' });
      } catch {}
    }

    // 6 + 7 + 8. hide secrets, write the edit log, hand back to the model
    const clean = T.redact(typeof result === 'string' ? result : JSON.stringify(result)).slice(0, MAX_RESULT);
    log('tool', { step, tool: name, cost: meta.cost, args: T.redact(JSON.stringify(args)).slice(0, 400), result: clean, ...(shotId && /^[a-f0-9]{16}$/.test(shotId) ? { shot: shotId } : {}) });
    msgs.push({ role: 'user', content: 'RESULT: ' + clean + (repeatCount >= MAX_REPEAT_NUDGE ? '\nYOU ARE REPEATING YOURSELF: you already did exactly this and got the same result. Do NOT do it again. Do the NEXT step of the task with a different tool or different arguments, or call done if the task is finished.' : '') });
  }
  log('stopped', { reason: 'steps', say: 'Reached the step limit.' });
  return { ok: false, stopped: 'steps', steps: MAX_STEPS, spent };
}

module.exports = { run, parse, compact, SYSTEM, MAX_STEPS, MAX_SAME, MAX_MISS, DEFAULT_MAX_MINUTES, HARD_MAX_MINUTES, KEEP_RECENT, COMPACT_AT_CHARS };
