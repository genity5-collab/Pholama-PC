'use strict';
// Pholama Codebase: the call to the cloud model. One function, injectable fetch, no hidden state, so every rule is tested without the internet.
// Rules:
//  * only the two self-hosted coder models can be asked for, nothing else, whatever the caller passes
//  * the person's words are billed per word; everything the agent adds itself (tool results, notes, screenshots) goes after the [Studio] marker, where the cloud does not bill it
//  * the cloud's real error text is NEVER shown: the person sees one plain sentence (the model name, HTTP codes and provider names stay in the log only)
//  * stopping the run (abort) stops the request
const FN_DEFAULT = process.env.PHOLAMA_CLOUD_URL || 'https://lyra-09dfabbf.base44.app/functions/pholamaCloud';
const MODELS = Object.freeze({ simple: 'qwen-coder', hard: 'qwen3-coder' });
const MARK = '\n\n[Studio]\n';
const TIMEOUT_MS = 170000;
const KEEP_OTHER = 40;   // the cloud keeps the last 12; sending more is wasted bytes, so the PC trims to a safe number first

const PLAIN = {
  login: 'Sign in to Pholama to use Codebase.',
  limit: 'Not enough credits right now. They come back by themselves as the month moves on.',
  network: 'Could not reach the Pholama cloud. Check your connection.',
  busy: 'The agent could not answer. Try again in a moment.',
  stopped: 'Stopped.',
};
const fail = (kind, code) => { const e = new Error(PLAIN[kind] || PLAIN.busy); e.kind = kind; e.code = code || kind; e.plain = true; return e; };

// Picks the model. 'hard' (debugging, complex work) costs double; anything unknown falls back to the cheap coder, never to an unlisted model.
function pickModel(kind) { return kind === 'hard' ? MODELS.hard : MODELS.simple; }

// The cloud bills the words BEFORE the marker in the last user message. The agent's own text must therefore sit AFTER it.
// A person-typed message (the task) has no marker added; a tool result gets the marker in front, so it is free.
function shape(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const sys = list.find(m => m && m.role === 'system');
  const rest = list.filter(m => m && m !== sys && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
  const out = rest.slice(-KEEP_OTHER).map(m => {
    if (m.role !== 'user') return { role: m.role, content: m.content };
    const own = /^(RESULT:|REFUSED:|EARLIER WORK|Reply with exactly)/.test(m.content);   // written by the loop, not typed by the person
    if (own && !m.content.includes(MARK)) return { role: 'user', content: 'continue' + MARK + m.content };
    return { role: 'user', content: m.content };
  });
  return { sys: sys ? String(sys.content) : '', msgs: out };
}

// The cloud swaps <tool> for <tool_call> on the way out, because Free.ai reserves that tag and Studio expects the swapped form.
// The Codebase loop speaks the plain form, so the swap is undone here, once, on every reply.
const fromCloud = t => String(t || '').replace(/<(\/?)tool_call>/gi, '<$1tool>');

async function ask(opts) {
  const { token, messages, kind = 'simple', signal, fetchFn = fetch, url = FN_DEFAULT, log = () => {} } = opts || {};
  const tk = String(token || '').trim(); if (!tk) throw fail('login');
  const { sys, msgs } = shape(messages);
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw fail('busy', 'empty');
  const sig = signal || AbortSignal.timeout(TIMEOUT_MS);
  if (sig.aborted) throw fail('stopped', 'abort');   // already stopped: never start a request (and never spend credits) for a run that is over
  let r;
  try {
    r = await fetchFn(url, { method: 'POST', signal: sig, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk },
      body: JSON.stringify({ studio: true, codebase: true, model: pickModel(kind), effort: 'normal', localTools: false, messages: [{ role: 'system', content: sys }, ...msgs] }) });
  } catch (e) {
    if (e && e.name === 'AbortError') throw fail('stopped', 'abort');
    log('codebase network error: ' + String(e && e.message || e).slice(0, 120)); throw fail('network');
  }
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok) {
    const code = String(j && j.code || '');
    log('codebase cloud error: HTTP ' + r.status + ' ' + code + ' ' + String(j && j.error || '').slice(0, 160));   // details stay in the log
    if (code === 'login' || r.status === 401) throw fail('login', code);
    if (code === 'limit-month' || code === 'limit-day' || r.status === 429) throw fail('limit', code);
    throw fail('busy', code || 'server');
  }
  const text = fromCloud(j && j.reply);
  if (!text.trim()) { log('codebase empty reply'); throw fail('busy', 'empty'); }
  return { text, credits: j.credits_left != null ? { left: Number(j.credits_left), cap: Number(j.week_cap), cost: Number(j.cost) } : null };
}

// What the agent loop plugs in as `model`: (messages) -> text. The kind can change between turns (the agent can decide a task is hard).
function makeModel({ getToken, getKind = () => 'simple', signal, fetchFn, url, log, onCredits } = {}) {
  return async (messages, callSignal) => {   // the run hands in its own signal on every call, so Stop cancels the request that is in flight
    const r = await ask({ token: typeof getToken === 'function' ? getToken() : getToken, messages, kind: getKind(), signal: callSignal || signal, fetchFn, url, log });
    if (r.credits && typeof onCredits === 'function') { try { onCredits(r.credits); } catch {} }
    return r.text;
  };
}
module.exports = { ask, makeModel, shape, fromCloud, pickModel, MODELS, MARK, PLAIN, FN_DEFAULT, KEEP_OTHER };
