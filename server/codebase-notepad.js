'use strict';
// The agent's notes, written LIVE into Notepad so the person watches the plan appear as it is written.
// One plain text file in the PC's temp folder (the agent never chooses the path), opened in Notepad on the first note,
// each later note appended as a timestamped line. Notepad on Windows 11 reloads a changed file by itself.
// Every effect (write, open, close, clock) is injected, so this is tested without Windows.
const os = require('os'), path = require('path');
const T = require('./codebase-tools');

const OK_MARK = '\u2705', BAD_MARK = '\u274C';   // a green tick for what worked, a red cross for what failed
const FILE_NAME = 'Pholama-Agent-Notes.txt';
const MAX_NOTE = 600;            // one note line
const MAX_FILE_BYTES = 200 * 1024;  // after this the file starts again, so Notepad never gets heavy
const TITLE = FILE_NAME + ' - Notepad';   // the exact window title Windows Notepad shows, because closing matches the title exactly

const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g, '').replace(/\r\n?|\n/g, ' ').replace(/\s+/g, ' ').trim();
const stamp = t => { const d = new Date(t); const p = n => String(n).padStart(2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); };

function create(deps = {}) {
  const { append, write, open, close, now = Date.now, dir = os.tmpdir() } = deps;
  const file = path.join(dir, FILE_NAME);
  let opened = false, opening = null, bytes = 0, count = 0, disabled = false;

  const line = text => '[' + stamp(now()) + '] ' + clean(T.redact(String(text || ''))).slice(0, MAX_NOTE) + '\r\n';

  // Starts a fresh page for a new run, so Notepad does not show an old run's notes.
  async function begin(title) {
    bytes = 0; count = 0; opened = false; opening = null; disabled = false;
    const head = 'Pholama agent notes' + (title ? ' - ' + clean(T.redact(String(title))).slice(0, 120) : '') + '\r\n' + '-'.repeat(40) + '\r\n';
    try { await write(file, head); bytes = Buffer.byteLength(head); return { ok: true, file }; } catch { disabled = true; return { ok: false }; }
  }

  // The mark that leads a note: a note the agent started with a tick or a cross keeps it (once); a plain note stays plain.
  const withMark = t => { const m = /^(?:\u2705|\u2714\uFE0F?|\u2611\uFE0F?|\u274C|\u274E|\u2716\uFE0F?)\s*/.exec(t); if (!m) return t; const good = /^(?:\u2705|\u2714|\u2611)/.test(m[0]); return (good ? OK_MARK : BAD_MARK) + ' ' + t.slice(m[0].length); };

  async function note(text) {
    const t = withMark(clean(T.redact(String(text || ''))));
    if (!t) return { ok: false, text: 'A note needs text.' };
    if (disabled) return { ok: true, text: 'Noted.', live: false };
    const l = line(t);
    try {
      if (bytes + Buffer.byteLength(l) > MAX_FILE_BYTES) { const head = 'Pholama agent notes (continued)\r\n' + '-'.repeat(40) + '\r\n'; await write(file, head); bytes = Buffer.byteLength(head); }
      await append(file, l); bytes += Buffer.byteLength(l); count++;
    } catch { disabled = true; return { ok: true, text: 'Noted.', live: false }; }
    // The first note opens Notepad (once; two notes arriving together share one open).
    if (!opened) {
      opening = opening || (async () => { try { const r = await open(file); opened = !!(r && r.ok !== false); } catch { opened = false; } })();
      await opening;
    }
    return { ok: true, text: 'Noted.', live: opened, file };
  }

  // The result of one tool call, written as its own line: a tick when it worked, a cross when it did not.
  // `what` is the tool and its target (already hidden of secrets by the caller), `detail` is the short reason when it failed.
  async function mark(good, what, detail) {
    const w = clean(T.redact(String(what || ''))).slice(0, 160), d = clean(T.redact(String(detail || ''))).slice(0, 240);
    if (!w) return { ok: false };
    return note((good ? OK_MARK : BAD_MARK) + ' ' + w + (!good && d ? ': ' + d : ''));
  }

  // The run is over: close the Notepad window if (and only if) this module opened it.
  async function finish() {
    if (!opened) return { ok: true, closed: false };
    opened = false; opening = null;
    try { await close(TITLE); return { ok: true, closed: true }; } catch { return { ok: true, closed: false }; }
  }

  return { begin, note, mark, finish, file, TITLE, state: () => ({ count, bytes, opened, disabled }) };
}

module.exports = { create, clean, stamp, OK_MARK, BAD_MARK, FILE_NAME, MAX_NOTE, MAX_FILE_BYTES, TITLE };
