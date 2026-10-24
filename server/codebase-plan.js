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
  note_(a) {
    // The model names the field many ways (text, content, note, summary, message...). The note is the one string it sent; if it sent several, the longest.
    const pref = ['text', 'content', 'note', 'summary', 'message', 'plan', 'description', 'thought', 'notes'];
    let t = ''; for (const k of pref) if (isStr(a[k]) && a[k].trim()) { t = a[k]; break; }
    if (!t) { const strs = Object.entries(a).filter(([k, v]) => k !== 'name' && isStr(v) && v.trim()).map(([, v]) => v); if (strs.length) t = strs.sort((x, y) => y.length - x.length)[0]; }
    if (!t.trim()) return no('A note needs text.');
    return { ok: true, kind: 'note', text: t.slice(0, 2000) };
  },
  check_chatbox_pholama() { return { ok: true, kind: 'chatbox' }; },
  remember(a) {
    const t = ['text', 'fact', 'memory', 'content', 'note', 'value'].map(k => a[k]).find(v => isStr(v) && v.trim());
    if (!t) return no('Give the fact to remember in "text".');
    return { ok: true, kind: 'remember', text: t };
  },
  forget(a) {
    const id = ['id', 'memory_id', 'key'].map(k => a[k]).find(v => isStr(v) && v.trim());
    if (!id) return no('Give the id of the memory to forget in "id".');
    return { ok: true, kind: 'forget', id: id.trim().slice(0, 40) };
  },
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
    // Models name this field many ways. Take the first one that has text, then tidy it: quotes, file:// links, forward slashes.
    let t = ['target', 'path', 'file', 'filename', 'folder', 'directory', 'dir', 'url', 'html', 'html_file', 'page', 'app'].map(k => a[k]).find(v => isStr(v) && v.trim());
    if (!t) return no('Say what to open: give "target" as a full file path, a folder path or a web address.');
    t = t.trim().replace(/^["'`]+|["'`]+$/g, '');
    if (/^file:\/\/\/?/i.test(t)) { try { t = decodeURIComponent(t.replace(/^file:\/\/\/?/i, '')); } catch { t = t.replace(/^file:\/\/\/?/i, ''); } }
    if (/^[a-z]:[\\/]/i.test(t) || /^\\\\/.test(t)) t = t.replace(/\//g, '\\');   // a Windows path: backslashes
    a = { ...a, target: t };
    if (!isStr(a.target) || !a.target.trim() || a.target.length > 500) return no('That is too long. Give a shorter path.');
    if (/^[a-z][a-z0-9+.-]+:/i.test(a.target) && !/^https?:\/\//i.test(a.target))   // a scheme has 2+ letters; a single letter is a drive (C:\...)
      return no('Only web pages (http or https) and granted files can be opened.');
    if (/^https?:\/\//i.test(a.target)) return { ok: true, kind: 'open', target: a.target, web: true };
    const r = needPath({ p: a.target }, 'p', 'read'); return r.ok ? { ok: true, kind: 'open', target: r.p, web: false } : r;
  },
  close_window(a) { if (!isStr(a.title) || !a.title.trim() || a.title.length > MAX_TITLE) return no('Give the exact window title.'); return { ok: true, kind: 'close', title: a.title }; },
  pc_browse(a) { if (!isStr(a.url) || !/^https?:\/\/[^\s]{1,2000}$/i.test(a.url)) return no('pc_browse needs an http or https address.'); return { ok: true, kind: 'open', target: a.url, web: true }; },
  cloud_browse(a) {
    const q = String(a.query || a.search || a.q || '').trim();
    if (q) { if (q.length > 300) return no('A search can be up to 300 characters.'); return { ok: true, kind: 'cloud_browse', query: q }; }
    if (!isStr(a.url) || !/^https?:\/\/[^\s]{1,2000}$/i.test(a.url)) return no('cloud_browse needs a "query" to search or an http or https "url" to read.');
    return { ok: true, kind: 'cloud_browse', url: a.url };
  },
  copy_text(a) { if (!isStr(a.text) || a.text.length > MAX_TEXT) return no('Give the text to copy (up to 20,000 characters).'); return { ok: true, kind: 'clip_set', text: a.text }; },
  paste_text() { return { ok: true, kind: 'paste' }; },
  copy_paste_image(a) { if (a.action === 'copy') { const r = needPath(a, 'path', 'read'); return r.ok ? { ok: true, kind: 'img_copy', path: r.p } : r; } if (a.action === 'paste') return { ok: true, kind: 'paste' }; return no('action must be "copy" or "paste".'); },
  user_pc(a) {
    const acts = ['move', 'click', 'double_click', 'right_click', 'type', 'key', 'scroll', 'search', 'wait'];
    const act = String(a.action || '').toLowerCase().trim().replace(/[\s-]+/g, '_');   // models write "Type", "typing", "press"
    const alias = { typing: 'type', write: 'type', enter_text: 'type', press: 'key', press_key: 'key', keypress: 'key', hotkey: 'key', google: 'search', web_search: 'search', find: 'search', tap: 'click', mouse_click: 'click', doubleclick: 'double_click', double: 'double_click', rightclick: 'right_click', right: 'right_click', context: 'right_click', sleep: 'wait', pause: 'wait', hover: 'move' };
    const action = alias[act] || act;
    if (!acts.includes(action)) return no('action must be one of: ' + acts.join(', ') + '.');
    if (action === 'search') {   // opens a normal web search in the browser: the reliable way to search, no clicking needed
      const q = String(a.text || a.query || a.q || '').trim();
      if (!q || q.length > 300) return no('Give the words to search for (up to 300 characters) in "text".');
      return { ok: true, kind: 'open', target: 'https://www.google.com/search?q=' + encodeURIComponent(q), web: true };
    }
    if (action === 'type') {
      const txt = a.text == null ? a.value : a.text;
      if (typeof txt !== 'string' || !txt.length || txt.length > MAX_TEXT) return no('Give the text to type (up to 20,000 characters) in "text".');
      return { ok: true, kind: 'pc_type', text: txt, enter: a.enter === true || a.submit === true };
    }
    if (action === 'key') {
      const k = String(a.key || a.keys || a.text || '').toLowerCase().replace(/\s+/g, '').replace(/control/g, 'ctrl').replace(/return/g, 'enter').replace(/escape/g, 'esc');
      if (!KEYS[k]) return no('key must be one of: ' + Object.keys(KEYS).join(', ') + '.');
      return { ok: true, kind: 'pc_key', key: k, send: KEYS[k] };
    }
    if (action === 'wait') { const sec = Math.round(+(a.seconds == null ? a.amount : a.seconds)); if (!(sec >= 1 && sec <= 20)) return no('seconds must be from 1 to 20.'); return { ok: true, kind: 'pc_wait', seconds: sec }; }
    // A spot can be given as real pixels (x, y) or as a fraction of the screen (fx, fy: 0 is the left/top edge, 1 the right/bottom edge). A fraction is easier to read off a picture.
    const hasF = a.fx != null && a.fy != null && a.x == null;
    if (hasF) {
      const fx = +a.fx, fy = +a.fy;
      if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return no('fx and fy must be from 0 to 1 (0.5 is the middle).');
      const kindsF = { move: 'pc_move', click: 'pc_click', double_click: 'pc_double', right_click: 'pc_right', scroll: 'pc_scroll' };
      return { ok: true, kind: kindsF[action], x: 0, y: 0, fx, fy, amount: Math.max(-20, Math.min(20, Math.round(+a.amount) || 0)) };
    }
    const x = Math.round(+a.x), y = Math.round(+a.y);
    if (action !== 'scroll' && !(Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= 20000 && y <= 20000)) return no('x and y must be screen positions, or give fx and fy as a fraction from 0 to 1 of the screen.');
    // scroll: amount is in notches, positive = up, negative = down. With no x,y it scrolls where the cursor already is (the plan gives -1,-1 and the runner skips the move).
    const kinds = { move: 'pc_move', click: 'pc_click', double_click: 'pc_double', right_click: 'pc_right', scroll: 'pc_scroll' };
    const here = action === 'scroll' && !(Number.isFinite(x) && Number.isFinite(y));   // no spot given: scroll wherever the cursor is
    return { ok: true, kind: kinds[action], x: here ? -1 : x, y: here ? -1 : y, amount: Math.max(-20, Math.min(20, Math.round(+a.amount) || 0)) };
  },
  terminal_open(a) { return shell(a, 'terminal'); },
  windows_powershell(a) { return shell(a, 'powershell'); },
  // --- generators: the file is saved on the PC, so the destination is checked for WRITE access BEFORE any credit is spent ---
  make_image(a) { return makePlan('image', a); },
  make_speech(a) { return makePlan('speech', a); },
  make_music(a) { return makePlan('music', a); },
  make_3d(a) { return makePlan('3d', a); },
  github_read(a) { return require('./codebase-github').plan('github_read', a); },
  github_write(a) { return require('./codebase-github').plan('github_write', a); },
};
// The only keys the agent may press (SendKeys codes are fixed here, never taken from the model). Win+R / Alt+F4 / Ctrl+Alt+Del style keys are not in the list.
const KEYS = { enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', backspace: '{BACKSPACE}', delete: '{DELETE}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', pagedown: '{PGDN}', pageup: '{PGUP}', home: '{HOME}', end: '{END}', space: ' ',
  'ctrl+l': '^l', 'ctrl+f': '^f', 'ctrl+a': '^a', 'ctrl+c': '^c', 'ctrl+v': '^v', 'ctrl+t': '^t', 'ctrl+s': '^s', 'ctrl+z': '^z', 'ctrl+enter': '^{ENTER}', 'shift+tab': '+{TAB}', 'alt+left': '%{LEFT}', 'alt+right': '%{RIGHT}',
  f5: '{F5}', 'ctrl+r': '^r', 'ctrl+n': '^n', 'ctrl+w': '^w', 'ctrl+d': '^d', 'ctrl+x': '^x', 'ctrl+y': '^y', 'ctrl+home': '^{HOME}', 'ctrl+end': '^{END}', 'ctrl+shift+t': '^+t', 'ctrl+tab': '^{TAB}', f11: '{F11}', 'ctrl+plus': '^{ADD}', 'ctrl+minus': '^{SUBTRACT}', 'ctrl+0': '^0' };
// What each generator may save as. The extension is fixed per kind (never chosen by the model), so a generator can never write a script or program.
const MAKE_EXT = { image: ['.png'], speech: ['.wav'], music: ['.wav', '.mp3'], '3d': ['.glb', '.obj'] };
const MAKE_PROMPT_MAX = 1000;
function makePlan(what, a) {
  const ext = MAKE_EXT[what];
  if (what !== '3d') {
    if (!isStr(a.prompt) || !a.prompt.trim()) return no(what === 'speech' ? 'Give the text to speak in "prompt".' : 'Describe what to make in "prompt".');
    if (a.prompt.length > MAKE_PROMPT_MAX) return no('Keep the description under ' + MAKE_PROMPT_MAX + ' characters.');
  } else if (!isStr(a.image_url) || !/^https:\/\/(?:api\.)?free\.ai\/[^\s]{1,500}$/.test(a.image_url)) return no('make_3d needs "image_url": the link that make_image returned.');
  if (!isStr(a.path) || !a.path.trim()) return no('Give "path": where to save it, for example C:\\project\\' + (what === 'image' ? 'logo.png' : what === 'speech' ? 'voice.wav' : what === 'music' ? 'theme.wav' : 'model.glb') + '.');
  const e = path.extname(a.path).toLowerCase();
  if (!ext.includes(e)) return no('A ' + what + ' file must end in ' + ext.join(' or ') + '.');
  const r = needPath(a, 'path', 'write'); if (!r.ok) return r;
  if (require('fs').existsSync(r.p)) return no('That file already exists. Pick a new name so nothing is overwritten.');
  const out = { ok: true, kind: 'make', what, to: r.p, prompt: what === '3d' ? '' : a.prompt.trim() };
  if (what === '3d') out.image_url = a.image_url;
  if (what === 'music') out.seconds = Math.min(30, Math.max(5, Math.floor(Number(a.seconds)) || 15));
  return out;
}
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
