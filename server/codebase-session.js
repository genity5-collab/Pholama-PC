'use strict';
// One Pholama Codebase run at a time: owns the loop, the live event feed (for the edit log), and the Allow / Deny queue.
// An approval is tied to ONE call id of ONE run. A stale, repeated or invented id changes nothing.
const loop = require('./codebase-loop');
const MAX_EVENTS = 500, ASK_TIMEOUT_MS = 10 * 60 * 1000;

function create(deps) {
  const { model, tools, budget, now = Date.now, askTimeout = ASK_TIMEOUT_MS, sleep, onResult, getContext, onEnd } = deps;
  let run = null;   // { id, events[], waiters:Set, pending:Map(callId -> {resolve,timer,tool,level}), done, result, stop }
  let counter = 0;

  const push = (r, e) => { r.events.push(e); if (r.events.length > MAX_EVENTS) r.events.shift(); for (const w of r.waiters) { try { w(e); } catch {} } };

  function start(task, opts = {}) {
    if (run && !run.done) return { ok: false, error: 'A Codebase run is already going. Stop it first.' };
    const text = String(task || '').trim();
    if (!text) return { ok: false, error: 'Tell the agent what to do.' };
    if (text.length > 4000) return { ok: false, error: 'That task is too long. Keep it under 4,000 characters.' };
    const ac = new AbortController();
    const r = run = { ac, id: 'r' + (++counter) + '-' + now(), events: [], waiters: new Set(), pending: new Map(), done: false, result: null, stopped: false };
    const ask = req => new Promise(resolve => {
      if (r.stopped) return resolve({ allowed: false });
      // A kind the person switched on "Always allow" for (never a strict one) is answered at once; it still shows in the feed.
      try { if (req.level === 'ask' && require('./codebase-always').has(req.tool)) { push(r, { kind: 'answered', callId: String(req.callId), allowed: true, auto: true, at: now() }); return resolve({ allowed: true, callId: String(req.callId) }); } } catch {}
      const timer = setTimeout(() => { if (r.pending.delete(req.callId)) { push(r, { kind: 'expired', callId: req.callId, at: now() }); resolve({ allowed: false }); } }, askTimeout);
      if (timer.unref) timer.unref();
      r.pending.set(req.callId, { resolve, timer, tool: req.tool, level: req.level });
    });
    const workLog = [];   // AUTO MEMORIZER: every step that changed something, saved without the AI having to write it
    const noteLog = [];   // the notes the agent wrote this run, kept for the saved session
    const emit = e => { try { if (e && e.kind === 'refused' && e.tool) workLog.push('\u274C ' + e.tool + ': ' + String(e.say || 'not allowed').slice(0, 100)); } catch {}
      try { if (e && e.kind === 'tool' && e.tool && e.tool !== 'note_' && !/^(screenshot_|remember|forget|next_task)$/.test(e.tool)) { const bad = /^ERROR|refused|blocked/i.test(String(e.result || '')); workLog.push((bad ? '\u274C ' : '\u2705 ') + e.tool + ' ' + String(e.args || '').slice(0, 120) + (bad ? ': ' + String(e.result || '').slice(0, 100) : '')); } } catch {}
      if (e && e.kind === 'tool' && e.tool === 'note_') { try { noteLog.push(String(JSON.parse(e.args).text || e.args)); } catch { noteLog.push(String(e.args || '')); } } push(r, e); };
    const guardedBudget = { gate: () => (r.stopped ? { ok: false, say: 'Stopped.' } : budget.gate()), spend: n => budget.spend(n) };
    loop.run(text, { model, tools, ask, budget: guardedBudget, emit, now, signal: ac.signal, sleep, onResult, context: typeof getContext === 'function' ? (() => { try { return getContext(); } catch { return ''; } })() : '', maxMinutes: Number(opts && opts.maxMinutes) || undefined }).then(res => { r.result = res; }, () => { r.result = { ok: false, stopped: 'error' }; }).then(() => {
      r.done = true; for (const p of r.pending.values()) { clearTimeout(p.timer); p.resolve({ allowed: false }); } r.pending.clear();
      if (typeof onEnd === 'function') { try { onEnd({ task: text, notes: noteLog, work: workLog, result: r.result }); } catch {} }   // save the session; a problem here never changes how the run ended
      push(r, { kind: 'end', at: now(), ok: !!(r.result && r.result.ok) });
    });
    return { ok: true, id: r.id };
  }

  // The user's answer. Only a call that is waiting RIGHT NOW in the current run can be answered, and only once.
  function answer(runId, callId, allowed) {
    if (!run || run.done || run.id !== runId) return { ok: false, error: 'That request is no longer waiting.' };
    const p = run.pending.get(String(callId));
    if (!p) return { ok: false, error: 'That request is no longer waiting.' };
    run.pending.delete(String(callId)); clearTimeout(p.timer);
    push(run, { kind: 'answered', callId: String(callId), allowed: allowed === true, at: now() });
    p.resolve(allowed === true ? { allowed: true, callId: String(callId) } : { allowed: false });
    return { ok: true };
  }

  function stop() {
    if (!run || run.done) return { ok: false, error: 'Nothing is running.' };
    run.stopped = true; try { run.ac.abort(); } catch {}   // Stop also cancels the model request that is in flight, so no more is paid for
    for (const [id, p] of run.pending) { clearTimeout(p.timer); p.resolve({ allowed: false }); run.pending.delete(id); }
    return { ok: true };
  }

  // Live feed: replays what already happened, then sends new events. Returns an unsubscribe function.
  function watch(send) {
    if (!run) return null;
    const r = run;
    for (const e of r.events) { try { send(e); } catch {} }
    r.waiters.add(send);
    return () => r.waiters.delete(send);
  }

  function state() {
    if (!run) return { running: false, pending: [] };
    return { running: !run.done, id: run.id, done: run.done, result: run.result ? { ok: !!run.result.ok, stopped: run.result.stopped || null, steps: run.result.steps || 0, spent: run.result.spent || 0 } : null, pending: [...run.pending].map(([callId, p]) => ({ callId, tool: p.tool, level: p.level })) };
  }

  return { start, answer, stop, watch, state };
}
module.exports = { create, MAX_EVENTS, ASK_TIMEOUT_MS };
