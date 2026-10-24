'use strict';
// "Always allow" for one KIND of request (for example pc_browse or user_pc). The person turns it on with a button and can turn it off again at any time.
// Only the normal "ask" tier can be always-allowed. The dangerous "strict" tier (terminal, PowerShell, delete) is asked every single time, whatever is saved here.
// Saved on this PC only, in a small file. Anything unknown or tampered with is ignored.
const fs = require('fs'), os = require('os'), path = require('path');
const T = require('./codebase-tools');
const FILE = () => path.join(process.env.PHOLAMA_HOME || path.join(os.homedir(), '.pholama'), 'codebase-always.json');
const allowedKind = n => typeof n === 'string' && Object.prototype.hasOwnProperty.call(T.TOOLS, n) && T.TOOLS[n].level === 'ask';

function list() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return [...new Set((Array.isArray(j.tools) ? j.tools : []).filter(allowedKind))].sort();
  } catch { return []; }
}
function save(tools) { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify({ v: 1, tools }, null, 1), { mode: 0o600 }); }
function add(name) { if (!allowedKind(name)) return { ok: false, error: T.TOOLS[name] && T.TOOLS[name].level === 'strict' ? 'That one is dangerous, so it is always asked.' : 'That request cannot be always allowed.' }; const t = list(); if (!t.includes(name)) t.push(name); save(t.sort()); return { ok: true, tools: list() }; }
function remove(name) { save(list().filter(x => x !== name)); return { ok: true, tools: list() }; }
function clear() { save([]); return { ok: true, tools: [] }; }
function has(name) { return allowedKind(name) && list().includes(name); }
module.exports = { list, add, remove, clear, has, allowedKind };
