'use strict';
// Pholama Codebase: turns a tool call into the EXACT thing that will run, after checking it is allowed. Pure logic, no side effects, fully tested.
// The Windows runner only executes what this returns. If plan() says no, nothing runs, whatever the model asked.
const path = require('path');
const grants = require('./codebase-grants');

const MAX_TEXT = 20000, MAX_CMD = 2000, MAX_TITLE = 200, MAX_PART = 60000;
const isStr = v => typeof v === 'string';
const no = say => ({ ok: false, say });

// Places the agent must never delete or run commands against, whatever the grants say.
const SYSTEM_PATH = /^(?:[a-z]:\\(?:windows|program files(?: \(x86\))?|programdata|\$recycle\.bin|system volume information|recovery|boot)(?:\\|$)|[a-z]:\\?$|\/(?:etc|usr|bin|sbin|boot|dev|proc|sys|var|lib|root)(?:\/|$)|\/$)/i;
const isSystemPath = p => SYSTEM_PATH.test(String(p).replace(/\//g, '\\')) || SYSTEM_PATH.test(String(p));

// PowerShell and terminal commands that are refused outright, even if the user presses Allow, because they cannot be undone or leak secrets.
const BLOCKED_CMD = [
  [/\bformat-volume\b|\bformat(?:\.com)?\s+[a-z]:|\bclear-disk\b|\binitialize-disk\b|\bremove-partition\b/i, 'formatting or wiping a drive'],
  [/\b(?:remove-item|ri|rm|del|rmdir|rd|erase)\b(?=[^\n]*(?:-recurse|-r\b|\s\/s\b|\s-rf?\b))(?=[^\n]*(?:\b[a-z]:\\?(?:\s|$|\*|"|')|\b[a-z]:\\(?:windows|users|program files|programdata)\b|\s\/(?:\s|$|\*)|\s~(?:\s|$|\/)|\$env:(?:userprofile|systemroot|windir|homepath)))/i, 'deleting a whole drive, user or system folder'],
  [/\bdiskpart\b|\bbcdedit\b|\bcipher\s+\/w\b|\bvssadmin\s+delete\b/i, 'disk or boot tools'],
  [/\bset-executionpolicy\b|\bdisable-windowsoptionalfeature\b|\bset-mppreference\b|\badd-mppreference\b/i, 'weakening Windows security'],
  [/\bnet\s+user\b|\bnet\s+localgroup\b|\bnew-localuser\b/i, 'changing user accounts'],
  [/\breg(?:\.exe)?\s+(?:delete|add)\b[^\n]*hk(?:lm|ey_local_machine)/i, 'editing machine-wide registry'],
  [/\b(?:invoke-webrequest|iwr|curl|wget|invoke-restmethod|irm)\b[^\n|]*\|\s*(?:iex|invoke-expression)\b/i, 'running downloaded code'],
  [/\b(?:iex|invoke-expression)\b[^\n]*\b(?:downloadstring|downloadfile|frombase64string)\b/i, 'running downloaded or hidden code'],
  [/-enc(?:odedcommand)?\s+[a-z0-9+\/=]{20,}/i, 'hidden (encoded) commands'],
  [/\b(?:shutdown|restart-computer|stop-computer)\b/i, 'shutting the PC down'],
  [/\$env:[a-z_]*(?:token|secret|key|password)[a-z_]*/i, 'reading secret environment variables'],
  [/\bget-content\b[^\n]*(?:\.pholama|\.ssh|\.aws|\.npmrc|id_rsa|\.env\b)/i, 'reading secret files'],
];
function blockedReason(cmd) { for (const [re, why] of BLOCKED_CMD) if (re.test(cmd)) return why; return null; }

// Quote a value for PowerShell single-quoted strings: the only special character is the quote itself.
const psq = s => "'" + String(s).replace(/'/g, "''") + "'";

function needPath(args, key, mode) {
  const p = args[key];
  if (!isStr(p) || !p.trim() || p.length > 1000 || /\0/.test(p)) return no('Give a file or folder path.');
  const c = grants.check(p, mode);
  if (!c.ok) return no(c.why || 'That path is outside the folders you allowed.');
  return { ok: true, p: c.real };   // always the RESOLVED path, so a symlink or .. trick cannot point somewhere else than what was checked
}

const PLANNERS = {
  note_(a) { if (!isStr(a.text) || !a.text.trim()) return no('A note needs text.'); return { ok: true, kind: 'note', text: a.text.slice(0, 2000) }; },
  next_task(a) { return { ok: true, kind: 'next_task' }; },
  screenshot_(a) { return { ok: true, kind: 'screenshot', scale: 0.5 }; },
  pull_file(a) { const r = needPath(a, 'path', 'read'); return r.ok ? { ok: true, kind: 'pull', from: r.p } : r; },
  edit_file(a) {
    const r = needPath(a, 'path', 'write'); if (!r.ok) return r;
    if (!isStr(a.content)) return no('edit_file needs the new content.');
    if (a.append !== undefined && typeof a.append !== 'boolean') return no('append must be true or false.');
    // One call carries one part. A file of any size is written as several parts (append:true), so there is no limit on the whole file.
    if (a.content.length > MAX_PART) return no('That part is too long for one step (max ' + MAX_PART + ' characters). Write it in smaller parts with append:true.');
    return { ok: true, kind: 'write', path: r.p, content: a.content, append: a.append === true };
  },
  push_files_to_pc(a) {
    const r = needPath(a, 'to', 'write'); if (!r.ok) return r;
    if (!isStr(a.from) || !a.from.trim()) return no('Say which cloud file to send.');
    return { ok: true, kind: 'push', from: a.from, to: r.p };
  },
  create_item(a) {
    const r = needPath(a, 'path', 'write'); if (!r.ok) return r;
    if (!['file', 'folder'].includes(a.type)) return no('type must be "file" or "folder".');
    return { ok: true, kind: 'create', type: a.type, path: r.p, content: isStr(a.content) ? a.content.slice(0, MAX_TEXT * 5) : '' };
  },
  set_object_parent_or_position(a) {
    const f = needPath(a, 'from', 'write'); if (!f.ok) return f;
    const t = needPath(a, 'to', 'write'); if (!t.ok) return t;
    if (isSystemPath(f.p) || isSystemPath(t.p)) return no('System locations cannot be moved.');
    return { ok: true, kind: 'move', from: f.p, to: t.p };
  },
  delete_folder_or_window_or_app(a) {
    if (a.window) { if (!isStr(a.window) || !a.window.trim() || a.window.length > MAX_TITLE) return no('Give the exact window title.'); return { ok: true, kind: 'close', title: a.window }; }
    if (a.app) return no('Uninstalling an app is not supported. Close it, or ask the user to uninstall it in Windows Settings.');
    const r = needPath(a, 'path', 'write'); if (!r.ok) return r;
    if (isSystemPath(r.p)) return no('System locations cannot be deleted.');
    return { ok: true, kind: 'delete', path: r.p };
  },
  open_window(a) {
    if (!isStr(a.target) || !a.target.trim() || a.target.length > 500) return no('Say what to open.');
    if (/^[a-z][a-z0-9+.-]+:/i.test(a.target) && !/^https?:\/\//i.test(a.target))   // a scheme has 2+ letters; a single letter is a drive (C:\...)
      return no('Only web pages (http or https) and granted files can be opened.');
    if (/^https?:\/\//i.test(a.target)) return { ok: true, kind: 'open', target: a.target, web: true };
    const r = needPath({ p: a.target }, 'p', 'read'); return r.ok ? { ok: true, kind: 'open', target: r.p, web: false } : r;
  },
  close_window(a) { if (!isStr(a.title) || !a.title.trim() || a.title.length > MAX_TITLE) return no('Give the exact window title.'); return { ok: true, kind: 'close', title: a.title }; },
  pc_browse(a) { if (!isStr(a.url) || !/^https?:\/\/[^\s]{1,2000}$/i.test(a.url)) return no('pc_browse needs an http or https address.'); return { ok: true, kind: 'open', target: a.url, web: true }; },
  cloud_browse(a) { if (!isStr(a.url) || !/^https?:\/\/[^\s]{1,2000}$/i.test(a.url)) return no('cloud_browse needs an http or https address.'); return { ok: true, kind: 'cloud_browse', url: a.url }; },
  copy_text(a) { if (!isStr(a.text) || a.text.length > MAX_TEXT) return no('Give the text to copy (up to 20,000 characters).'); return { ok: true, kind: 'clip_set', text: a.text }; },
  paste_text() { return { ok: true, kind: 'paste' }; },
  copy_paste_image(a) { if (a.action === 'copy') { const r = needPath(a, 'path', 'read'); return r.ok ? { ok: true, kind: 'img_copy', path: r.p } : r; } if (a.action === 'paste') return { ok: true, kind: 'paste' }; return no('action must be "copy" or "paste".'); },
  user_pc(a) {
    const acts = ['move', 'click', 'type', 'scroll'];
    if (!acts.includes(a.action)) return no('action must be one of: ' + acts.join(', ') + '.');
    if (a.action === 'type') { if (!isStr(a.text) || a.text.length > 2000) return no('Give the text to type (up to 2,000 characters).'); return { ok: true, kind: 'pc_type', text: a.text }; }
    const x = Math.round(+a.x), y = Math.round(+a.y);
    if (a.action !== 'scroll' && !(Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= 20000 && y <= 20000)) return no('x and y must be screen positions.');
    return { ok: true, kind: 'pc_' + a.action, x: x || 0, y: y || 0, amount: Math.max(-20, Math.min(20, Math.round(+a.amount) || 0)) };
  },
  terminal_open(a) { return shell(a, 'terminal'); },
  windows_powershell(a) { return shell(a, 'powershell'); },
  github_read(a) { return require('./codebase-github').plan('github_read', a); },
  github_write(a) { return require('./codebase-github').plan('github_write', a); },
};
function shell(a, kind) {
  if (!isStr(a.command) || !a.command.trim()) return no('Give the command to run.');
  if (a.command.length > MAX_CMD) return no('That command is too long (limit ' + MAX_CMD + ' characters).');
  if (/\0/.test(a.command)) return no('That command contains an invalid character.');
  const why = blockedReason(a.command); if (why) return no('Refused: ' + why + ' is never allowed, even with your approval.');
  let cwd = null; if (a.cwd != null) { const r = needPath(a, 'cwd', 'write'); if (!r.ok) return r; cwd = r.p; }
  return { ok: true, kind, command: a.command.trim(), cwd };
}

function plan(name, args) {
  if (!Object.prototype.hasOwnProperty.call(PLANNERS, name)) return no('This tool has no safe plan.');
  try { return PLANNERS[name](args && typeof args === 'object' ? args : {}); } catch (e) { return no('That request could not be understood.'); }
}
module.exports = { plan, blockedReason, isSystemPath, psq, MAX_CMD, PLANNERS };
