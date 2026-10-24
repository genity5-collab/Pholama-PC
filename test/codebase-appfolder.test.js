// The agent can read the Pholama app folder but can never change it (a model that edits the app it runs inside can break it).
const fs = require('fs'), os = require('os'), path = require('path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-'));
process.env.PHOLAMA_HOME = path.join(home, 'data'); fs.mkdirSync(process.env.PHOLAMA_HOME, { recursive: true });
const app = path.join(home, 'AppInstall'); fs.mkdirSync(path.join(app, 'server'), { recursive: true }); fs.writeFileSync(path.join(app, 'server', 'x.js'), 'x');
process.env.PHOLAMA_APP_DIR = app;
const G = require('../server/codebase-grants.js');
let bad = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + String(x).slice(0, 220))); if (!c) bad++; };
const throws = f => { try { f(); return null; } catch (e) { return e.message; } };
const proj = path.join(home, 'work', 'proj'); fs.mkdirSync(proj, { recursive: true }); fs.writeFileSync(path.join(proj, 'a.js'), 'a');

ok('the app folders include where the code runs from', G.appFolders().some(a => G.inside(path.join(__dirname, '..', 'server', 'codebase-loop.js'), a)));
ok('the PHOLAMA_APP_DIR folder is protected', G.appFolders().some(a => G.realish(a) === G.realish(app)));
ok('the app folder cannot be granted', /app folder/.test(throws(() => G.grant(app, 'write')) || ''));
ok('a folder INSIDE the app folder cannot be granted', /app folder/.test(throws(() => G.grant(path.join(app, 'server'), 'write')) || ''));
ok('a folder that CONTAINS the app folder cannot be granted', /app folder/.test(throws(() => G.grant(home, 'write')) || '') || /home|whole|data/.test(throws(() => G.grant(home, 'write')) || ''));
ok('a normal project folder can still be granted read+write', !throws(() => G.grant(proj, 'write')));
ok('and written to', G.check(path.join(proj, 'a.js'), 'write').ok);

// an OLD grant given before the lock existed must not let the agent write into the app
fs.writeFileSync(path.join(process.env.PHOLAMA_HOME, 'codebase-grants.json'), JSON.stringify({ v: 1, grants: [{ dir: fs.realpathSync(proj), mode: 'write' }, { dir: fs.realpathSync(app), mode: 'write' }] }));
const w = G.check(path.join(app, 'server', 'x.js'), 'write');
ok('an older write grant on the app folder does NOT allow writing there', w.ok === false && /app folder/.test(w.why), JSON.stringify(w));
ok('the message says it can read but never change', /read it but never change/.test(w.why));
ok('creating a new file in the app folder is refused too', G.check(path.join(app, 'server', 'new.js'), 'write').ok === false);
ok('reading the app folder is still allowed (so it can study the code)', G.check(path.join(app, 'server', 'x.js'), 'read').ok === true);
ok('the project folder still writes after all this', G.check(path.join(proj, 'a.js'), 'write').ok === true);
ok('a look-alike name is not the app folder', G.check(path.join(home, 'AppInstall-copy', 'f.js'), 'write').ok === false && !/app folder/.test(G.check(path.join(home, 'AppInstall-copy', 'f.js'), 'write').why || ''));
console.log(bad ? bad + ' FAILED' : 'ALL PASSED'); process.exit(bad ? 1 : 0);
