'use strict';
// Attacks on the Pholama Codebase tool registry: permissions, the note rule, costs, secret hiding.
const T = require('../server/codebase-tools');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } };

// 1. every tool the owner asked for exists
const wanted = ['note_', 'screenshot_', 'cloud_browse', 'pull_file', 'push_files_to_pc', 'edit_file', 'create_item', 'set_object_parent_or_position', 'user_pc', 'open_window', 'close_window', 'pc_browse', 'copy_text', 'paste_text', 'copy_paste_image', 'terminal_open', 'windows_powershell', 'delete_folder_or_window_or_app', 'github_read', 'github_write'];
for (const w of wanted) ok('tool exists: ' + w, !!T.describe(w));
ok('every tool has a valid level', T.list().every(t => T.LEVELS.has(t.level)));

// 2. the owner's permission list: these must NEVER run without approval
const needApproval = ['pull_file', 'push_files_to_pc', 'edit_file', 'create_item', 'set_object_parent_or_position', 'user_pc', 'open_window', 'close_window', 'pc_browse', 'copy_text', 'paste_text', 'copy_paste_image', 'terminal_open', 'windows_powershell', 'delete_folder_or_window_or_app', 'github_write'];
for (const n of needApproval) ok('blocked without approval: ' + n, T.gate(n, {}, null, 'c1').ok === false);
for (const n of ['note_', 'screenshot_', 'cloud_browse', 'github_read']) ok('runs without approval: ' + n, T.gate(n, {}, null, 'c1').ok === true);

// 3. approvals cannot be faked
for (const bad of [{}, { allowed: 'true' }, { allowed: 1 }, { allowed: false }, { callId: 'c1' }, []]) ok('a fake approval does not pass: ' + JSON.stringify(bad), T.gate('edit_file', {}, bad, 'c1').ok === false);
ok('a real approval passes for ask tools', T.gate('edit_file', {}, { allowed: true }, 'c1').ok === true);

// 4. strict tools: one Allow covers ONE exact call only
ok('strict passes for the approved call', T.gate('terminal_open', {}, { allowed: true, callId: 'c1' }, 'c1').ok === true);
ok('strict does NOT pass for a different call', T.gate('terminal_open', {}, { allowed: true, callId: 'c1' }, 'c2').ok === false);
ok('strict does NOT pass with no call id', T.gate('windows_powershell', {}, { allowed: true }, undefined).ok === false);
ok('delete is strict', T.describe('delete_folder_or_window_or_app').level === 'strict');
ok('unknown tools are refused', T.gate('format_disk', {}, { allowed: true }, 'c1').ok === false);
ok('inherited names are refused', ['constructor', '__proto__', 'toString', 'hasOwnProperty'].every(n => T.gate(n, {}, { allowed: true }, 'c1').ok === false));

// 5. costs the owner set
ok('screenshot costs 10', T.describe('screenshot_').cost === 10);
ok('image 45, music 45, 3d 90, speech 25', T.describe('make_image').cost === 45 && T.describe('make_music').cost === 45 && T.describe('make_3d').cost === 90 && T.describe('make_speech').cost === 25);
ok('notes are free', T.describe('note_').cost === 0);

// 6. the note rule
ok('reading is allowed without a note', T.noteRule('screenshot_', {}).ok === true);
ok('first edit with no note is refused', T.noteRule('edit_file', {}).code === 'note-first');
ok('edit after a note is allowed', T.noteRule('edit_file', { lastNoteAt: 5 }).ok === true);
ok('a second edit needs a NEW note', T.noteRule('edit_file', { lastNoteAt: 5, lastEditAt: 6 }).code === 'note-first');
ok('a new note unlocks the next edit', T.noteRule('edit_file', { lastNoteAt: 7, lastEditAt: 6 }).ok === true);
ok('moving to the next task needs a note about it', T.noteRule('edit_file', { lastNoteAt: 7, lastEditAt: 6, taskId: 2, noteTaskId: 1 }).code === 'note-first');
ok('a note about the current task unlocks it', T.noteRule('edit_file', { lastNoteAt: 7, lastEditAt: 6, taskId: 2, noteTaskId: 2 }).ok === true);
for (const n of ['delete_folder_or_window_or_app', 'windows_powershell', 'terminal_open', 'github_write', 'push_files_to_pc']) ok('note rule covers ' + n, T.noteRule(n, {}).code === 'note-first');

// 7. secrets are hidden before the model sees any result
const secrets = ['ghp_' + 'a'.repeat(30), 'github_pat_' + 'B'.repeat(30), 'sk-' + 'c'.repeat(30), 'AKIA' + 'D'.repeat(16), '-----BEGIN RSA PRIVATE KEY-----', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij1234'];
for (const s of secrets) ok('secret hidden: ' + s.slice(0, 12) + '...', !T.redact('token=' + s + ' end').includes(s));
ok('normal text is untouched', T.redact('hello world 123') === 'hello world 123');
ok('null becomes empty text', T.redact(null) === '' && T.redact(undefined) === '');

console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`);
process.exit(fail ? 1 : 0);
