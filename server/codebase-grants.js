// Pholama Codebase: which folders the agent may touch. The user grants a folder as READ or READ+WRITE; nothing else is reachable.
// Everything here is path logic only. A path is resolved to its REAL location (symlinks followed) before it is compared,
// so a link, "..", a drive root or a trick spelling cannot reach outside a granted folder. Zero dependencies.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');

const DIR = process.env.PHOLAMA_HOME || path.join(os.homedir(), '.pholama');
const FILE = () => path.join(process.env.PHOLAMA_HOME || DIR, 'codebase-grants.json');
const DOWNLOADS = 'downloads';       // the one folder the agent may always write to: files it installed for the user
const MAX_GRANTS = 20;
const MAX_FILE_BYTES = 1024 * 1024;  // the agent reads/edits files up to 1 MB; bigger files are not source code

// Names that are never readable or writable, even inside a granted folder: they hold keys and logins.
const SECRET_NAMES = /^(\.env(\..*)?|\.npmrc|\.netrc|\.pgpass|id_rsa|id_ed25519|id_ecdsa|id_dsa|.*\.pem|.*\.key|.*\.pfx|.*\.p12|.*\.kdbx|credentials(\.json)?|secrets?\.(json|ya?ml|txt)|\.git-credentials|known_hosts|authorized_keys|providers\.json|codebase-grants\.json)$/i;
const SECRET_DIRS = /(^|[\\/])(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.config[\\/]gh|AppData[\\/]Roaming[\\/](Microsoft[\\/]Credentials|Mozilla|Google)|Library[\\/]Keychains)([\\/]|$)/i;

const norm = p => path.resolve(String(p));
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (child, parent) => { if (same(child, parent)) return true; const rel = path.relative(parent, child); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

// The real location of a path that may not exist yet: resolve the nearest existing parent, then re-attach the rest.
function realish(p) {
  let cur = norm(p); const rest = [];
  for (let i = 0; i < 64; i++) {
    try { const real = fs.realpathSync(cur); return rest.length ? path.join(real, ...rest.reverse()) : real; }
    catch { const up = path.dirname(cur); if (up === cur) return norm(p); rest.push(path.basename(cur)); cur = up; }
  }
  return norm(p);
}

// Folders that can never be granted: the whole disk, the home folder itself, the system, and the folder that holds Pholama's own data.
function refuseRoot(dir) {
  const real = realish(dir), home = realish(os.homedir()), data = realish(process.env.PHOLAMA_HOME || DIR);
  if (path.parse(real).root === real) return 'That is a whole drive. Grant a project folder instead.';
  if (same(real, home)) return 'That is your whole home folder. Grant a project folder inside it instead.';
  if (inside(data, real)) return 'That folder contains Pholama\'s own data (your keys and accounts). Choose another one.';
  if (inside(real, data)) return 'That is inside Pholama\'s own data folder. Choose another one.';
  const win = process.platform === 'win32';
  const sys = win ? [process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', process.env.ProgramData || 'C:\\ProgramData']
    : ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/dev', '/proc', '/sys', '/var', '/opt', '/root', '/System', '/Library', '/Applications'];
  for (const s of sys) if (s && (inside(real, realish(s)) || inside(realish(s), real))) return 'That is a system folder. Grant a project folder instead.';
  if (SECRET_DIRS.test(real)) return 'That folder holds keys or logins. Choose another one.';
  return null;
}

const read = () => { try { const j = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return Array.isArray(j.grants) ? j.grants.filter(g => g && typeof g.dir === 'string') : []; } catch { return []; } };
const write = grants => { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify({ v: 1, grants }, null, 1), { mode: 0o600 }); };

// The folder where installed files go. Always writable, created on demand, inside Pholama's own data folder.
const downloadsDir = () => path.join(process.env.PHOLAMA_HOME || DIR, DOWNLOADS);
function ensureDownloads() { const d = downloadsDir(); fs.mkdirSync(d, { recursive: true }); return d; }

function list() { return read().map(g => ({ dir: g.dir, mode: g.mode === 'write' ? 'write' : 'read', added: g.added || null })); }
function grant(dir, mode = 'read') {
  if (!dir || typeof dir !== 'string') throw new Error('Choose a folder.');
  if (!path.isAbsolute(dir)) throw new Error('Give the full path of the folder.');
  mode = mode === 'write' ? 'write' : 'read';
  let real; try { real = fs.realpathSync(norm(dir)); } catch { throw new Error('That folder does not exist.'); }
  if (!fs.statSync(real).isDirectory()) throw new Error('That is a file. Choose a folder.');
  const bad = refuseRoot(real); if (bad) throw new Error(bad);
  const all = read().filter(g => !same(g.dir, real));
  if (all.length >= MAX_GRANTS) throw new Error('You can grant up to ' + MAX_GRANTS + ' folders. Remove one first.');
  all.push({ dir: real, mode, added: new Date().toISOString() }); write(all);
  return { dir: real, mode };
}
function revoke(dir) { const real = realish(dir), all = read(), left = all.filter(g => !same(g.dir, real)); if (left.length === all.length) return false; write(left); return true; }

// Is this path reachable, and how? Returns { ok, real, mode, grant } or { ok:false, why }.
// `need` is 'read' or 'write'. The installed-files folder is always readable and writable.
function check(p, need = 'read') {
  if (p == null || typeof p !== 'string' || !p.trim()) return { ok: false, why: 'No path was given.' };
  if (/\u0000/.test(p)) return { ok: false, why: 'The path has invalid characters.' };
  const real = realish(p);
  if (SECRET_DIRS.test(real) || SECRET_NAMES.test(path.basename(real))) return { ok: false, why: 'That file holds keys or logins, so the agent cannot touch it.' };
  const dl = realish(downloadsDir());
  if (inside(real, dl)) return { ok: true, real, mode: 'write', grant: dl };
  let best = null;
  for (const g of read()) { const gd = realish(g.dir); if (inside(real, gd) && (!best || gd.length > best.dir.length)) best = { dir: gd, mode: g.mode === 'write' ? 'write' : 'read' }; }
  if (!best) return { ok: false, why: 'That is outside the folders you allowed. Grant its folder first.' };
  if (need === 'write' && best.mode !== 'write') return { ok: false, why: 'That folder is read-only for the agent. Grant it as read and write to change files in it.' };
  return { ok: true, real, mode: best.mode, grant: best.dir };
}

module.exports = { list, grant, revoke, check, realish, inside, refuseRoot, downloadsDir, ensureDownloads, MAX_GRANTS, MAX_FILE_BYTES, SECRET_NAMES, DOWNLOADS };
