// Pholama Codebase usage budget. 15,000 credits a month. After every 5,000 spent the agent rests for 7 hours;
// when all 15,000 are spent it rests until the 1st of next month. Local to this PC (~/.pholama/codebase-usage.json).
// The clock is passed in, so every rule here is tested with exact dates. Zero dependencies.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');

const MONTH_CREDITS = 15000, STEP = 5000, PAUSE_HOURS = 7;
const PAUSE_MS = PAUSE_HOURS * 3600 * 1000;
const FILE = () => path.join(process.env.PHOLAMA_HOME || path.join(os.homedir(), '.pholama'), 'codebase-usage.json');

// "2026-10" for the month the clock is in (local time, because "next month" means the user's calendar).
const monthKey = (now = Date.now()) => { const d = new Date(now); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
const nextMonthStart = (now = Date.now()) => { const d = new Date(now); return new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0).getTime(); };

const fresh = now => ({ v: 1, month: monthKey(now), used: 0, pauseUntil: 0, pauses: 0 });
function load(now = Date.now()) {
  let s; try { s = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { s = null; }
  if (!s || typeof s !== 'object' || s.v !== 1) return fresh(now);
  const used = Number.isFinite(+s.used) ? Math.min(MONTH_CREDITS, Math.max(0, Math.floor(+s.used))) : 0;
  const pauseUntil = Number.isFinite(+s.pauseUntil) ? Math.max(0, Math.floor(+s.pauseUntil)) : 0;
  if (s.month !== monthKey(now)) return fresh(now);   // a new month: the pool is full again and any pause is over
  return { v: 1, month: s.month, used, pauseUntil, pauses: Math.max(0, Math.floor(+s.pauses || 0)) };
}
function save(s) { try { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(s)); } catch {} }

// Everything the page needs for the bar, from one state. Never NaN.
function view(s, now = Date.now()) {
  const used = Math.min(MONTH_CREDITS, Math.max(0, s.used)), left = MONTH_CREDITS - used;
  const locked = left <= 0, paused = !locked && s.pauseUntil > now;
  const nextStop = used >= MONTH_CREDITS ? MONTH_CREDITS : (Math.floor(used / STEP) + 1) * STEP;   // the next 5,000 line
  return {
    used, left, cap: MONTH_CREDITS, percent: Math.min(100, Math.round(used / MONTH_CREDITS * 100)),
    state: locked ? 'locked' : paused ? 'paused' : 'ok',
    resetsAt: locked ? nextMonthStart(now) : paused ? s.pauseUntil : nextMonthStart(now),   // when it can work again, or when the month refills
    monthResetsAt: nextMonthStart(now),
    pauseUntil: paused ? s.pauseUntil : 0,
    untilPause: locked ? 0 : Math.max(0, nextStop - used),   // credits until the next 7-hour rest
    stepsUsed: Math.min(3, Math.floor(used / STEP)), step: STEP, pauseHours: PAUSE_HOURS
  };
}

// May the agent work right now? { ok } or { ok:false, state, until, message }.
function gate(now = Date.now()) {
  const s = load(now), v = view(s, now);
  if (v.state === 'locked') return { ok: false, state: 'locked', until: v.monthResetsAt, message: 'Pholama Codebase has used all ' + MONTH_CREDITS.toLocaleString('en-US') + ' credits for this month. It works again on the 1st.' };
  if (v.state === 'paused') return { ok: false, state: 'paused', until: v.pauseUntil, message: 'Pholama Codebase is resting after ' + STEP.toLocaleString('en-US') + ' credits. It can work again at ' + new Date(v.pauseUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.' };
  return { ok: true };
}

// Charge for work that already happened. The work is never cut in the middle: if it crosses a 5,000 line the rest comes after.
// Returns the new view plus `crossed` (how many 5,000 lines this charge passed).
function spend(cost, now = Date.now()) {
  const c = Math.floor(+cost); if (!Number.isFinite(c) || c <= 0) return { ...view(load(now), now), crossed: 0 };
  const s = load(now), before = Math.floor(s.used / STEP);
  s.used = Math.min(MONTH_CREDITS, s.used + c);
  const after = Math.floor(s.used / STEP);
  const crossed = Math.min(after, 3) - Math.min(before, 3);
  if (crossed > 0 && s.used < MONTH_CREDITS) { s.pauseUntil = now + PAUSE_MS; s.pauses += 1; }   // one pause per charge, however many lines it passed; at 15,000 the month lock takes over
  save(s);
  return { ...view(s, now), crossed };
}

const status = (now = Date.now()) => view(load(now), now);
module.exports = { gate, spend, status, view, load, monthKey, nextMonthStart, MONTH_CREDITS, STEP, PAUSE_HOURS, PAUSE_MS, FILE };
