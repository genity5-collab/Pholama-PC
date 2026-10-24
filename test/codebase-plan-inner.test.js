'use strict';
// The planner's INNER safety layers, tested with a grants module that wrongly says yes to everything.
// The outer layer (grants) normally catches these first; if it ever has a bug, these layers must still hold.
const Module = require('module'), path = require('path');
const grantsPath = require.resolve('../server/codebase-grants');
require.cache[grantsPath] = { id: grantsPath, filename: grantsPath, loaded: true, exports: { check: (p) => ({ ok: true, real: (/^[a-z]:\\/i.test(String(p)) || String(p).startsWith('/') ? String(p) : path.resolve(String(p))).replace(/escape/, 'REALTARGET'), mode: 'write', grant: '/' }), downloadsDir: () => '/dl' } };
const P = require('../server/codebase-plan');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } };

// system folders: even if a grant wrongly allowed them, delete and move refuse
for (const sys of ['C:\\Windows\\System32\\x.dll', 'C:\\Program Files\\App\\a.exe', 'C:\\ProgramData\\x', '/etc/passwd', '/usr/bin/node', '/boot/vmlinuz']) {
  ok('delete refuses a system path even with a wrong grant: ' + sys, P.plan('delete_folder_or_window_or_app', { path: sys }).ok === false);
  ok('move refuses a system path even with a wrong grant: ' + sys, P.plan('set_object_parent_or_position', { from: sys, to: '/tmp/x' }).ok === false && P.plan('set_object_parent_or_position', { from: '/tmp/x', to: sys }).ok === false);
}
ok('a normal path is still planned with the permissive stub', P.plan('delete_folder_or_window_or_app', { path: '/tmp/proj/a.js' }).ok === true);

// the planner must hand back the path the grants module RESOLVED, not the one the model typed
ok('the plan uses the resolved path, not the typed one', P.plan('pull_file', { path: '/tmp/proj/escape/n.txt' }).from.includes('REALTARGET'));
ok('edit uses the resolved path', P.plan('edit_file', { path: '/tmp/proj/escape/n.txt', content: 'x' }).path.includes('REALTARGET'));
ok('delete uses the resolved path', P.plan('delete_folder_or_window_or_app', { path: '/tmp/proj/escape/n.txt' }).path.includes('REALTARGET'));

// schemes: even if a path check wrongly said yes, open_window must still refuse non-web schemes
for (const evil of ['javascript:alert(1)', 'ms-settings:privacy', 'file:///C:/Windows/win.ini', 'data:text/html,x', 'vbscript:x', 'ftp://x/y', 'search-ms:query=x', 'ms-msdt:/id x']) ok('open_window refuses scheme with a permissive grant: ' + evil, P.plan('open_window', { target: evil }).ok === false);
ok('http still opens', P.plan('open_window', { target: 'https://example.com' }).web === true);
ok('a Windows drive path is a path, not a scheme', P.plan('open_window', { target: 'C:\\proj\\a.js' }).ok === true);

console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`);
process.exit(fail ? 1 : 0);
