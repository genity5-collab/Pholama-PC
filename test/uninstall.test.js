'use strict';
// "pholama remove-all" run for real on a fake install: it removes everything of Pholama's, never anything else, never errors, never lies.
const fs = require('fs'), os = require('os'), path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'un-'));
const HOME = path.join(root, 'home'); fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
os.homedir = () => HOME;
delete process.env.PHOLAMA_HOME;
const U = require('../server/uninstall');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } };
const w = (p, t = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
const C = { red: s => s, green: s => s, dim: s => s, yellow: s => s, bold: s => s };

function build() {
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const app = path.join(HOME, 'Pholama'), data = path.join(HOME, '.pholama');
  for (const f of ['server/cli.js', 'server/server.js', 'models.pc.json', 'web/app.js']) w(path.join(app, f));
  for (const f of ['state.json', 'models/qwen.gguf', 'node/node', 'llama/llama-server', 'codebase-grants.json', 'codebase-downloads/a.zip', 'edit-log.jsonl', 'studio/p1/x.js', 'workspace/w.txt', 'server.pid', 'helper.pid']) w(path.join(data, f));
  w(path.join(HOME, '.local/bin/pholama')); w(path.join(HOME, '.local/bin/phollama')); w(path.join(HOME, '.local/share/applications/pholama.desktop')); w(path.join(HOME, 'Desktop/Pholama.desktop'));
  // things that must NEVER be touched
  w(path.join(HOME, 'Documents/thesis.docx')); w(path.join(HOME, 'Pholama-backup/keep.txt')); w(path.join(HOME, 'my-project/Pholama/notes.txt')); w(path.join(HOME, '.pholama2/keep.txt'));
  w(path.join(HOME, '.local/bin/othertool')); w(path.join(HOME, 'Desktop/Other.desktop')); w(path.join(HOME, '.ssh/id_rsa'), 'KEY');
  return { app, data };
}
const keep = () => ['Documents/thesis.docx', 'Pholama-backup/keep.txt', 'my-project/Pholama/notes.txt', '.pholama2/keep.txt', '.local/bin/othertool', 'Desktop/Other.desktop', '.ssh/id_rsa'].map(f => path.join(HOME, f));
const mkdeps = (extra = {}) => { const lines = []; return { lines, log: s => lines.push(String(s)), color: C, appRoot: path.join(HOME, 'Pholama'), stopServer: async () => {}, ...extra }; };

(async () => {
  // 1. the plan lists everything of Pholama's, and only that
  let { app, data } = build();
  let items = U.plan(app);
  const paths = items.map(i => i.path);
  ok('plan includes the app folder', paths.includes(app));
  ok('plan includes the data folder (models, AIs, Codebase settings)', paths.includes(data));
  ok('plan includes the pholama command and the launcher entries', paths.some(p => p.endsWith('bin/pholama')) && paths.some(p => p.endsWith('bin/phollama')) && paths.some(p => p.endsWith('pholama.desktop')));
  ok('plan never lists a lookalike or a user file', !paths.some(p => /Pholama-backup|my-project|\.pholama2|Documents|\.ssh|othertool|Other\.desktop/.test(p)));
  ok('plan lists nothing twice', new Set(paths).size === paths.length);

  // 2. a dry run deletes nothing
  let d = mkdeps(); let code = await U.run(['--dry-run'], d);
  ok('dry run exits 0', code === 0);
  ok('dry run deleted nothing', fs.existsSync(app) && fs.existsSync(data) && fs.existsSync(path.join(data, 'models/qwen.gguf')));
  ok('dry run says so', d.lines.some(l => /Dry run/.test(l)));

  // 3. no keyboard and no --yes: refuses, deletes nothing
  d = mkdeps(); const tty = process.stdin.isTTY; process.stdin.isTTY = false;
  code = await U.run([], d); process.stdin.isTTY = tty;
  ok('without --yes and without a keyboard it refuses', code === 1 && fs.existsSync(app) && fs.existsSync(data));

  // 4. the real removal
  ({ app, data } = build()); d = mkdeps();
  code = await U.run(['--yes'], d);
  ok('removal exits 0', code === 0);
  ok('the app folder is gone', !fs.existsSync(app));
  ok('the data folder is gone with the models, AIs and Codebase settings', !fs.existsSync(data) && !fs.existsSync(path.join(data, 'models')) && !fs.existsSync(path.join(data, 'codebase-grants.json')) && !fs.existsSync(path.join(data, 'codebase-downloads')));
  ok('the pholama and phollama commands are gone', !fs.existsSync(path.join(HOME, '.local/bin/pholama')) && !fs.existsSync(path.join(HOME, '.local/bin/phollama')));
  ok('the launcher entry and Desktop icon are gone', !fs.existsSync(path.join(HOME, '.local/share/applications/pholama.desktop')) && !fs.existsSync(path.join(HOME, 'Desktop/Pholama.desktop')));
  ok('every file the user owns is untouched', keep().every(f => fs.existsSync(f)));
  ok('the secret key file is untouched', fs.readFileSync(path.join(HOME, '.ssh/id_rsa'), 'utf8') === 'KEY');
  ok('it says Pholama is removed', d.lines.some(l => /Pholama is removed/.test(l)));
  ok('it never says it could not remove something that was removed', !d.lines.some(l => /could not remove /.test(l)));

  // 5. running it again is not an error
  d = mkdeps(); code = await U.run(['--yes'], d);
  ok('running it twice is fine (nothing to remove, exit 0)', code === 0 && d.lines.some(l => /Nothing to remove/.test(l)));

  // 6. it must not crash when the server is hung or the stop step throws
  ({ app, data } = build()); d = mkdeps({ stopServer: async () => { throw new Error('server hung'); } });
  code = await U.run(['--yes'], d);
  ok('a hung server does not stop the removal', code === 0 && !fs.existsSync(app) && !fs.existsSync(data));

  // 7. a folder that cannot be deleted is reported honestly, not hidden
  ({ app, data } = build()); const realRm = fs.rmSync; let blocked = 0;
  fs.rmSync = (p, o) => { if (String(p) === data) { blocked++; return; } return realRm(p, o); };   // pretend the data folder is locked
  d = mkdeps(); code = await U.run(['--yes'], d); fs.rmSync = realRm;
  ok('a locked folder is reported as not removed', d.lines.some(l => /could not remove /.test(l) && l.includes(data)));
  ok('it retried the locked folder before giving up', blocked >= 2);
  ok('everything else was still removed', !fs.existsSync(app) && !fs.existsSync(path.join(HOME, '.local/bin/pholama')));
  ok('user files are still untouched after a failure', keep().every(f => fs.existsSync(f)));
  await new Promise(r => setTimeout(r, 1800));   // let the detached cleanup finish
  ok('the leftover is cleaned up a moment later', !fs.existsSync(data));

  // 7b. the processes: removal must call the stopper, wait for it, report stragglers, and exit non-zero when one would not stop
  ({ app, data } = build()); let called = null;
  d = mkdeps({ stopAll: async (roots, o) => { called = { roots, o }; return { stopped: [{ pid: 11, name: 'llama-server' }, { pid: 12, name: 'node' }], failed: [], left: [], unreadable: false }; } });
  code = await U.run(['--yes'], d);
  ok('removal calls the process stopper', !!called);
  ok('the stopper is told about the app and data folders', called && called.roots.includes(app) && called.roots.includes(data));
  ok('the stopper is given the pid files to read', called && called.o.pidFiles.some(f => f.endsWith('server.pid')) && called.o.pidFiles.some(f => f.endsWith('helper.pid')) && called.o.pidFiles.every(f => f.startsWith(data)));
  ok('the stopper gets the polite shutdown first', called && typeof called.o.polite === 'function');
  ok('each stopped program is shown to the user', d.lines.some(l => /stopped llama-server/.test(l)) && d.lines.some(l => /stopped node/.test(l)));
  ok('after stopping, the files are removed', !fs.existsSync(app) && !fs.existsSync(data) && code === 0);

  ({ app, data } = build());
  d = mkdeps({ stopAll: async () => ({ stopped: [], failed: [{ pid: 77, name: 'llama-server' }], left: [77], unreadable: false }) });
  code = await U.run(['--yes'], d);
  ok('a program that would not stop is named', d.lines.some(l => /could not stop llama-server/.test(l) && /77/.test(l)));
  ok('removal then exits non-zero (it does not pretend all is fine)', code === 2);
  ok('it tells the user what to do', d.lines.some(l => /Task Manager/.test(l)));

  ({ app, data } = build());
  d = mkdeps({ stopAll: async () => ({ stopped: [], failed: [], left: [], unreadable: true }) });
  code = await U.run(['--yes'], d);
  ok('an unreadable process list is warned about', d.lines.some(l => /could not list running programs/.test(l)));
  ok('and removal still goes ahead', !fs.existsSync(app));

  ({ app, data } = build());
  d = mkdeps({ stopAll: async () => { throw new Error('boom'); } });
  code = await U.run(['--yes'], d);
  ok('a crashing stopper does not abort the removal', !fs.existsSync(app) && !fs.existsSync(data));
  ok('and the user is told', d.lines.some(l => /could not check running programs/.test(l)));

  // 7c. the leftover path (a locked folder AND a program that would not stop) also exits non-zero; and the polite step is the caller's stopServer, whose failure must not matter
  ({ app, data } = build()); const rm2 = fs.rmSync; fs.rmSync = (p, o) => { if (String(p) === data) return; return rm2(p, o); };
  d = mkdeps({ stopAll: async () => ({ stopped: [], failed: [{ pid: 5, name: 'node' }], left: [5], unreadable: false }) });
  code = await U.run(['--yes'], d); fs.rmSync = rm2; await new Promise(r => setTimeout(r, 1800));
  ok('locked folder plus a program that would not stop: exits non-zero', code === 2);
  ({ app, data } = build()); let politeRan = false, politeThrew = false;
  d = mkdeps({ stopServer: async () => { politeRan = true; politeThrew = true; throw new Error('hung'); }, stopAll: async (r, o) => { try { await o.polite(); } catch {} return { stopped: [], failed: [], left: [], unreadable: false }; } });
  code = await U.run(['--yes'], d);
  ok('the polite shutdown given to the stopper is the real stopServer', politeRan);
  ok('a hung polite shutdown still ends in a full removal', code === 0 && !fs.existsSync(app) && !fs.existsSync(data));

  // 8. the data-folder safety: it never treats the home folder, a drive root or a random folder as Pholama's
  ok('home folder is not Pholama data', U.isPholamaDataDir(HOME) === false);
  // only the "never the home folder / a drive root" guard stands between these and deletion: a custom PHOLAMA_HOME that equals them and carries Pholama-looking markers
  { // the home folder, with Pholama-looking files inside the FAKE home (never the real filesystem root)
    const marks = []; for (const m of ['state.json', 'models']) { const f = path.join(HOME, m); if (!fs.existsSync(f)) { m === 'models' ? fs.mkdirSync(f) : fs.writeFileSync(f, '{}'); marks.push(f); } }
    process.env.PHOLAMA_HOME = HOME;
    ok('PHOLAMA_HOME set to the home folder, with Pholama-looking files in it, is still refused', U.isPholamaDataDir(HOME) === false);
    process.env.PHOLAMA_HOME = path.parse(HOME).root;
    ok('PHOLAMA_HOME set to a drive root is still refused', U.isPholamaDataDir(path.parse(HOME).root) === false);
    delete process.env.PHOLAMA_HOME;
    for (const f of marks) fs.rmSync(f, { recursive: true, force: true });
  }
  ok('a drive or filesystem root is not Pholama data', U.isPholamaDataDir(path.parse(HOME).root) === false);
  ok('a folder named .pholama is', U.isPholamaDataDir(path.join(HOME, '.pholama')) === true);
  ok('a lookalike name is not', U.isPholamaDataDir(path.join(HOME, '.pholama2')) === false && U.isPholamaDataDir(path.join(HOME, 'pholama')) === false && U.isPholamaDataDir(path.join(HOME, 'Documents')) === false);
  const proj = path.join(HOME, 'real-project'); w(path.join(proj, 'state.json')); w(path.join(proj, 'src/app.js'));
  process.env.PHOLAMA_HOME = proj;
  ok('PHOLAMA_HOME pointing at a normal project (even with a state.json) is NOT treated as Pholama data', U.isPholamaDataDir(proj) === false);
  const custom = path.join(HOME, 'custom-ph'); w(path.join(custom, 'state.json')); w(path.join(custom, 'models/a.gguf')); process.env.PHOLAMA_HOME = custom;
  ok('PHOLAMA_HOME with Pholama\'s own markers is accepted', U.isPholamaDataDir(custom) === true);
  process.env.PHOLAMA_HOME = proj; ({ app } = build()); w(path.join(proj, 'state.json')); w(path.join(proj, 'src/app.js'));
  d = mkdeps(); await U.run(['--yes'], d);
  ok('a removal with PHOLAMA_HOME on a normal project leaves the project alone', fs.existsSync(path.join(proj, 'src/app.js')));
  delete process.env.PHOLAMA_HOME;

  console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
