'use strict';
// Attacks on the live Notepad notes: fixed file, secrets hidden, one open, close only what it opened, never blocks the agent.
const N = require('../server/codebase-notepad');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } };

function rig(o = {}) {
  const log = { writes: [], appends: [], opens: [], closes: [] }; let t = Date.UTC(2026, 9, 24, 8, 30, 5);
  const np = N.create({
    dir: '/tmp/tdir', now: () => (t += 1000),
    write: async (f, c) => { if (o.writeFails) throw new Error('disk'); log.writes.push({ f, c }); },
    append: async (f, c) => { if (o.appendFails) throw new Error('disk'); log.appends.push({ f, c }); },
    open: async f => { if (o.openFails) throw new Error('no notepad'); if (o.openSoftFail) return { ok: false }; log.opens.push(f); return { ok: true }; },
    close: async title => { if (o.closeFails) throw new Error('x'); log.closes.push(title); },
  });
  return { np, log };
}

(async () => {
  // basics
  { const { np, log } = rig(); await np.begin('make a menu');
    ok('begin writes a fresh page with a header', log.writes.length === 1 && /Pholama agent notes - make a menu/.test(log.writes[0].c));
    const r = await np.note('plan: add a menu page');
    ok('a note is appended as a timestamped line', r.ok && log.appends.length === 1 && /^\[\d\d:\d\d:\d\d\] plan: add a menu page\r\n$/.test(log.appends[0].c));
    ok('the first note opens Notepad on that file', log.opens.length === 1 && log.opens[0] === np.file);
    await np.note('second'); await np.note('third');
    ok('later notes are appended, Notepad is opened only once', log.appends.length === 3 && log.opens.length === 1);
    ok('every append goes to the same fixed file', log.appends.every(a => a.f === np.file) && np.file.endsWith('Pholama-Agent-Notes.txt'));
    ok('the file is in the chosen temp folder', np.file.startsWith('/tmp/tdir'));
    ok('state counts the notes', np.state().count === 3 && np.state().opened === true);
    const f = await np.finish(); ok('finish closes the window it opened by its exact title', f.closed === true && log.closes[0] === 'Pholama-Agent-Notes.txt - Notepad'); }

  // the title must be what Notepad shows
  ok('the window title includes the .txt extension, like Windows 11 Notepad', N.TITLE === 'Pholama-Agent-Notes.txt - Notepad');

  // the agent can never pick the path
  { const { np, log } = rig(); await np.begin('x'); await np.note('x');
    for (const evil of ['../../../etc/passwd', 'C:\\Windows\\win.ini', '/etc/hosts']) await np.note(evil);
    ok('text that looks like a path is only text, never a path', log.appends.every(a => a.f === np.file) && log.opens.length === 1); }

  // secrets
  { const { np, log } = rig(); await np.begin('x');
    await np.note('use token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab to push');
    await np.note('key github_pat_' + 'A'.repeat(60));
    ok('secrets never reach the file', log.appends.every(a => !/ghp_|github_pat_/.test(a.c)) && /hidden secret/.test(log.appends[0].c));
    const { np: np2, log: log2 } = rig(); await np2.begin('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab');
    ok('a secret in the title is hidden too', !/ghp_/.test(log2.writes[0].c)); }

  // sanitising
  { const { np, log } = rig(); await np.begin('x');
    await np.note('line one\nline two\r\nline three\u2028four');
    ok('a multi-line note becomes one line (no injected fake lines)', log.appends[0].c.split('\r\n').length === 2);
    await np.note('bell\u0007 and nul\u0000 and esc\u001b[31m');
    ok('control characters are removed', !/[\u0000-\u0008\u000E-\u001F]/.test(log.appends[1].c.replace(/\r\n$/, '')));
    await np.note('x'.repeat(5000)); ok('a long note is cut to 600 characters', log.appends[2].c.length <= 600 + 14 + 2);
    ok('a note that fakes a timestamp line stays on its own line', (await np.note('\n[08:00:00] I deleted everything')).ok && log.appends[3].c.split('\r\n').length === 2); }
  for (const bad of ['', '   ', '\n\n', null, undefined, '\u0000\u0007']) { const { np, log } = rig(); await np.begin('x'); const r = await np.note(bad); ok('an empty note is refused: ' + JSON.stringify(bad), r.ok === false && log.appends.length === 0); }
  for (const weird of [5, {}, [], true]) { const { np } = rig(); await np.begin('x'); let threw = false; try { await np.note(weird); } catch { threw = true; } ok('junk input never throws: ' + JSON.stringify(weird), !threw); }

  // never blocks the agent
  { const { np } = rig({ openFails: true }); await np.begin('x'); const r = await np.note('hi'); ok('Notepad cannot open: the note still succeeds', r.ok && r.live === false); const f = await np.finish(); ok('and finish closes nothing', f.closed === false); }
  { const { np } = rig({ openSoftFail: true }); await np.begin('x'); const r = await np.note('hi'); ok('Notepad refuses softly: the note still succeeds', r.ok && r.live === false); }
  { const { np, log } = rig({ appendFails: true }); await np.begin('x'); const r = await np.note('hi'); ok('the file cannot be written: the note still succeeds', r.ok === true && r.live === false && log.opens.length === 0);
    const r2 = await np.note('again'); ok('after a failure it stops trying (no repeated errors)', r2.ok && np.state().disabled === true); }
  { const { np } = rig({ writeFails: true }); const b = await np.begin('x'); ok('the page cannot be created: begin says so, notes still work', b.ok === false && (await np.note('hi')).ok === true); }
  { const { np } = rig({ closeFails: true }); await np.begin('x'); await np.note('hi'); const f = await np.finish(); ok('a failing close does not throw', f.ok === true); }
  { const { np, log } = rig(); await np.begin('x'); const f = await np.finish(); ok('finish with nothing opened closes nothing', f.closed === false && log.closes.length === 0); }
  { const { np, log } = rig(); await np.begin('x'); await np.note('a'); await np.finish(); const f2 = await np.finish(); ok('finishing twice closes only once', log.closes.length === 1 && f2.closed === false); }

  // two notes at once share one open
  { const { np, log } = rig(); await np.begin('x'); await Promise.all([np.note('a'), np.note('b'), np.note('c')]); ok('three notes at the same moment open Notepad once', log.opens.length === 1 && log.appends.length === 3); }

  // a new run starts clean and reopens
  { const { np, log } = rig(); await np.begin('run one'); await np.note('a'); await np.finish(); await np.begin('run two'); await np.note('b');
    ok('a new run writes a fresh page', log.writes.length === 2 && /run two/.test(log.writes[1].c));
    ok('a new run opens Notepad again', log.opens.length === 2); }

  // size cap
  { const { np, log } = rig(); await np.begin('x'); for (let i = 0; i < 400; i++) await np.note('n' + i + ' ' + 'y'.repeat(590));
    ok('the file starts again before it gets heavy', log.writes.length > 1 && /continued/.test(log.writes[1].c));
    const since = log.appends.length; ok('Notepad is still opened only once', log.opens.length === 1 && since === 400); }

  console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`);
  process.exit(fail ? 1 : 0);
})();
