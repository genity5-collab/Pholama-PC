// Pholama Codebase grants: the agent can only reach folders the user allowed, and cannot escape them.
const fs = require('fs'), os = require('os'), path = require('path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cbg-')); process.env.PHOLAMA_HOME = path.join(home, 'data');
fs.mkdirSync(process.env.PHOLAMA_HOME, { recursive: true });
const G = require('../server/codebase-grants.js');
let bad = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + String(x).slice(0, 220))); if (!c) bad++; };
const mk = (...p) => { const d = path.join(home, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const put = (f, t = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); return f; };
const throws = f => { try { f(); return null; } catch (e) { return e.message; } };

const proj = mk('work', 'proj'), sib = mk('work', 'proj-secret'), other = mk('other');
put(path.join(proj, 'a.js')); put(path.join(sib, 'k.txt')); put(path.join(other, 'o.txt')); put(path.join(proj, '.env'), 'KEY=1'); put(path.join(proj, 'sub', 'b.js'));

ok('nothing is reachable before any grant', !G.check(path.join(proj, 'a.js')).ok && G.list().length === 0);
G.grant(proj, 'read');
ok('a granted folder is listed', G.list().length === 1 && G.list()[0].mode === 'read');
ok('a file inside a granted folder can be read', G.check(path.join(proj, 'a.js'), 'read').ok);
ok('a nested file can be read', G.check(path.join(proj, 'sub', 'b.js')).ok);
ok('a read-only grant cannot be written', !G.check(path.join(proj, 'a.js'), 'write').ok && /read-only/.test(G.check(path.join(proj, 'a.js'), 'write').why));
ok('a folder that merely shares the name prefix is NOT inside the grant', !G.check(path.join(sib, 'k.txt')).ok, JSON.stringify(G.check(path.join(sib, 'k.txt'))));
ok('a different folder is refused', !G.check(path.join(other, 'o.txt')).ok);
ok('.. cannot climb out of the grant', !G.check(path.join(proj, '..', 'proj-secret', 'k.txt')).ok && !G.check(proj + '/../../other/o.txt').ok);
ok('a relative path is resolved against nothing it was not given (no silent cwd)', !G.check('a.js').ok || path.isAbsolute(G.check('a.js').real));
ok('a secret file inside a granted folder is still refused', !G.check(path.join(proj, '.env')).ok && /keys or logins/.test(G.check(path.join(proj, '.env')).why));
for (const n of ['id_rsa', 'cert.pem', 'server.key', '.npmrc', 'credentials.json', '.git-credentials', 'providers.json', 'codebase-grants.json', '.env.local'])
  ok('the secret name "' + n + '" is refused', !G.check(path.join(proj, n), 'read').ok, n);
ok('empty, null and NUL paths are refused', !G.check('').ok && !G.check(null).ok && !G.check(proj + '/a\u0000.js').ok && !G.check(undefined).ok && !G.check(123).ok);
ok('a file that does not exist yet can be checked for writing once the folder is writable', (() => { G.grant(proj, 'write'); return G.check(path.join(proj, 'new', 'deep', 'file.js'), 'write').ok; })());
ok('re-granting replaces the mode instead of duplicating', G.list().length === 1 && G.list()[0].mode === 'write');

// symlinks: a link inside the grant that points outside must not be a way out
let linked = false;
try { fs.symlinkSync(other, path.join(proj, 'linkdir')); fs.symlinkSync(path.join(other, 'o.txt'), path.join(proj, 'linkfile')); linked = true; } catch {}
if (linked) {
  ok('a folder symlink pointing outside is refused', !G.check(path.join(proj, 'linkdir', 'o.txt')).ok, JSON.stringify(G.check(path.join(proj, 'linkdir', 'o.txt'))));
  ok('a file symlink pointing outside is refused', !G.check(path.join(proj, 'linkfile')).ok);
  ok('writing a NEW file through an outside folder link is refused', !G.check(path.join(proj, 'linkdir', 'new.txt'), 'write').ok);
  const lk = mk('lk'); try { fs.symlinkSync(proj, path.join(lk, 'toproj')); ok('reaching a granted folder through a link is allowed (it IS inside)', G.check(path.join(lk, 'toproj', 'a.js')).ok); } catch {}
} else console.log('SKIP symlink tests (not permitted here)');

// folders that can never be granted
const root = path.parse(home).root;
ok('a whole drive / filesystem root cannot be granted', /whole drive/.test(throws(() => G.grant(root)) || ''));
ok('the home folder itself cannot be granted', /home folder/.test(throws(() => G.grant(os.homedir())) || ''));
ok('Pholama\'s own data folder cannot be granted', /own data/.test(throws(() => G.grant(process.env.PHOLAMA_HOME)) || ''));
ok('a parent of the data folder cannot be granted (it would expose keys)', /own data/.test(throws(() => G.grant(home)) || ''));
if (process.platform !== 'win32') { ok('/etc cannot be granted', /system folder/.test(throws(() => G.grant('/etc')) || '')); ok('/usr cannot be granted', /system folder/.test(throws(() => G.grant('/usr')) || '')); }
ok('a path that does not exist cannot be granted', /does not exist/.test(throws(() => G.grant(path.join(home, 'nope'))) || ''));
ok('a file cannot be granted as a folder', /file/.test(throws(() => G.grant(path.join(proj, 'a.js'))) || ''));
ok('a relative folder cannot be granted', /full path/.test(throws(() => G.grant('proj')) || ''));
ok('an ".ssh" folder cannot be granted', (() => { const s = mk('u', '.ssh'); return /keys or logins/.test(throws(() => G.grant(s)) || ''); })());

// the installed-files folder
const dl = G.ensureDownloads();
ok('the installed-files folder exists and is always writable', fs.existsSync(dl) && G.check(path.join(dl, 'tool', 'x.zip'), 'write').ok);
ok('...but it is inside the data folder, which cannot be granted by hand', /own data/.test(throws(() => G.grant(dl)) || ''));
ok('...and the rest of the data folder (keys) stays unreachable', !G.check(path.join(process.env.PHOLAMA_HOME, 'providers.json')).ok && !G.check(path.join(process.env.PHOLAMA_HOME, 'update.json')).ok);
ok('a path that climbs out of the installed-files folder into the data folder is refused', !G.check(path.join(dl, '..', 'providers.json'), 'read').ok);

// revoke + limits
ok('revoking removes access', G.revoke(proj) === true && !G.check(path.join(proj, 'a.js')).ok);
ok('revoking something not granted says so', G.revoke(proj) === false);
const many = []; for (let i = 0; i < G.MAX_GRANTS; i++) { const d = mk('many', 'd' + i); many.push(d); G.grant(d, 'read'); }
ok('the number of granted folders is capped', /up to/.test(throws(() => G.grant(mk('many', 'extra'))) || ''));
ok('a corrupted grants file means no access, not open access', (() => { fs.writeFileSync(path.join(process.env.PHOLAMA_HOME, 'codebase-grants.json'), '{not json'); return G.list().length === 0 && !G.check(path.join(many[0], 'x')).ok; })());
ok('grants are stored with owner-only permissions where supported', process.platform === 'win32' || (G.grant(many[0], 'read') && (fs.statSync(path.join(process.env.PHOLAMA_HOME, 'codebase-grants.json')).mode & 0o077) === 0));
console.log(bad ? 'FAILED ' + bad : 'ALL PASSED');
process.exit(bad ? 1 : 0);
