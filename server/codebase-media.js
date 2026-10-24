'use strict';
// Pholama Codebase: the generators (image, speech, music, 3D) as the PC sees them.
// The PC never holds a generator key. It asks the Pholama cloud, which charges the credits first and gives them back on any failure,
// then it downloads the finished file and saves it where the plan said (a folder the person allowed for writing).
// Rules:
//  * music and 3D wait in a shared queue, so waiting has a hard time limit; when time is up (or Stop is pressed) the cloud is told to give up and refunds
//  * the file may only come from the generator's own https host, is size-capped, never overwrites, and must really look like its type
//  * every message the person can see is plain: no provider, model, address or HTTP code
const fs = require('fs'), path = require('path');
const FN_DEFAULT = process.env.PHOLAMA_MEDIA_URL || 'https://lyra-09dfabbf.base44.app/functions/pholamaMedia';
const HOST = /^https:\/\/(?:api\.)?free\.ai\//;
const LIMITS = { image: { wait: 0, bytes: 15e6 }, speech: { wait: 0, bytes: 20e6 }, music: { wait: 4 * 60e3, bytes: 40e6 }, '3d': { wait: 6 * 60e3, bytes: 60e6 } };
const POLL_MS = 4000;
const PLAIN = {
  login: 'Sign in to Pholama to make files.',
  limit: 'Not enough credits for this. They come back by themselves as the week moves on.',
  network: 'Could not reach the Pholama cloud. Check your connection.',
  busy: 'The generator is busy right now. You were not charged. Try again in a moment.',
  failed: 'It could not be made. You were not charged.',
  timeout: 'It took too long, so it was stopped. You were not charged.',
  stopped: 'Stopped. You were not charged.',
  save: 'The file could not be saved there.',
  big: 'The result was too large, so it was not saved.',
  type: 'The result was not the kind of file expected, so it was not saved.',
  exists: 'That file already exists. Pick a new name so nothing is overwritten.',
};
const bad = (key, extra) => ({ ok: false, text: PLAIN[key] || PLAIN.failed, code: key, ...(extra || {}) });

// The first bytes must match what the file claims to be, so a link to a web page or a program can never be saved as a picture.
function looksLike(what, to, b) {
  if (!b || b.length < 12) return false;
  const ext = path.extname(to).toLowerCase();
  if (what === 'image') return b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG';
  if (what === 'speech') return b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE';
  if (what === 'music') return ext === '.mp3' ? (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) : (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE');
  if (what === '3d') return ext === '.glb' ? b.toString('latin1', 0, 4) === 'glTF' : /^(?:#|v |o |g |mtllib)/.test(b.toString('latin1', 0, 40));
  return false;
}

function create(deps = {}) {
  const { fetchFn = (...a) => fetch(...a), getToken = () => '', url = FN_DEFAULT, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {}, signal: runSignal, onCredits } = deps;

  async function cloud(payload, signal) {
    const tk = String(getToken() || '').trim(); if (!tk) return { fail: bad('login') };
    let r; try { r = await fetchFn(url, { method: 'POST', signal: signal || AbortSignal.timeout(120000), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify(payload) }); }
    catch (e) { if (e && e.name === 'AbortError') return { fail: bad('stopped') }; log('media network error: ' + String(e && e.message || e).slice(0, 120)); return { fail: bad('network') }; }
    let j = {}; try { j = await r.json(); } catch {}
    if (j && j.credits_left != null && typeof onCredits === 'function') { try { onCredits({ left: Number(j.credits_left) }); } catch {} }
    if (r.status === 401 || j.code === 'login') return { fail: bad('login') };
    if (r.status === 429 || /^limit/.test(String(j.code || ''))) return { fail: bad('limit') };
    if (r.status === 503 || j.code === 'busy') return { fail: bad('busy') };
    if (r.status >= 400) { log('media cloud error: HTTP ' + r.status + ' ' + String(j.code || '').slice(0, 40)); return { fail: bad('failed') }; }
    return { j, status: r.status };
  }

  async function download(link, what, to, signal) {
    if (!HOST.test(String(link || ''))) return bad('failed');
    let r; try { r = await fetchFn(link, { signal: signal || AbortSignal.timeout(120000), redirect: 'error' }); } catch (e) { if (e && e.name === 'AbortError') return bad('stopped'); log('media download error: ' + String(e && e.message || e).slice(0, 100)); return bad('network'); }
    if (!r.ok) { log('media download HTTP ' + r.status); return bad('failed'); }
    const cap = LIMITS[what].bytes, len = Number(r.headers && r.headers.get && r.headers.get('content-length')) || 0;
    if (len > cap) return bad('big');
    let buf; try { buf = Buffer.from(await r.arrayBuffer()); } catch { return bad('failed'); }
    if (buf.length > cap) return bad('big');
    if (!looksLike(what, to, buf)) { log('media download wrong type for ' + what); return bad('type'); }
    try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, buf, { flag: 'wx' }); }   // wx: never overwrite
    catch (e) { return e && e.code === 'EEXIST' ? bad('exists') : bad('save'); }
    return { ok: true, bytes: buf.length };
  }

  // pl is what the planner produced: { kind:'make', what, to, prompt, image_url?, seconds? }
  async function execute(pl, ctx = {}) {
    const signal = ctx.signal || runSignal;
    if (!pl || pl.kind !== 'make' || typeof pl.what !== 'string' || !Object.prototype.hasOwnProperty.call(LIMITS, pl.what)) return bad('failed');   // own kinds only: 'constructor' or 'toString' are not generators
    if (signal && signal.aborted) return bad('stopped');   // already stopped: nothing is asked, nothing is spent
    const first = await cloud({ action: 'start', kind: pl.what, prompt: pl.prompt, image_url: pl.image_url, seconds: pl.seconds }, signal);
    if (first.fail) return first.fail;
    let link = '';
    if (first.j.queued === true && first.j.job) {
      const { job, token } = first.j, deadline = now() + LIMITS[pl.what].wait;
      for (;;) {
        if (signal && signal.aborted) { await cloud({ action: 'poll', kind: pl.what, job, token, gaveUp: true }); return bad('stopped'); }
        if (now() >= deadline) { const g = await cloud({ action: 'poll', kind: pl.what, job, token, gaveUp: true }); return g.fail ? g.fail : bad('timeout'); }
        await sleep(POLL_MS);
        const p = await cloud({ action: 'poll', kind: pl.what, job, token }, signal);
        if (p.fail) { if (p.fail.code === 'stopped') { await cloud({ action: 'poll', kind: pl.what, job, token, gaveUp: true }); } return p.fail; }
        if (p.j.done === true) { if (p.j.failed) return bad(p.j.code === 'timeout' ? 'timeout' : 'failed'); link = p.j.url; break; }
      }
    } else link = first.j.url;
    const saved = await download(link, pl.what, pl.to, signal);
    if (!saved.ok) return saved;
    // The link is given back so the next step can use it (a 3D model is made from the picture's link).
    return { ok: true, text: 'Saved ' + pl.what + ' to ' + pl.to + ' (' + saved.bytes + ' bytes).' + (pl.what === 'image' ? ' Picture link for make_3d: ' + link : ''), path: pl.to, link };
  }
  return { execute };
}
module.exports = { create, looksLike, PLAIN, LIMITS, HOST, FN_DEFAULT };
