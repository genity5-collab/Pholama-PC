// Pholama Codebase log rows: screenshots and notes appear as rows, approvals flip to Done/Denied, nothing leaks.
const path = require('path');
let pass = 0, fail = 0, C, info, mergeLive;
const ok = (n, c) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } };

(async () => {
const root = path.join(__dirname, '..');
C = await import(path.join(root, 'web', 'codebaselog.js'));
const E = await import(path.join(root, 'web', 'editlog.js')); info = E.info; mergeLive = E.mergeLive;
const shot = { kind: 'tool', tool: 'screenshot_', result: 'Chrome window "Updating" loading bar at 60%', cost: 10, at: 1000 };
const note = { kind: 'tool', tool: 'note_', args: '{"text":"Next: fix the login button"}', result: 'saved', at: 2000 };
let rows = [];
rows = C.add(rows, note); rows = C.add(rows, shot);
ok('a screenshot becomes a screenshot row', rows[0].kind === 'screenshot' && /60%/.test(rows[0].text));
ok('the screenshot row records its 10 credit cost', rows[0].cost === 10);
ok('a note becomes a note row', rows[1].kind === 'note');
ok('newest first', rows[0].tool === 'screenshot_');
ok('screenshot title shows what was read', /^Screenshot: Chrome window/.test(C.rowTitle(rows[0])));
ok('note title shows the note', /^Note:/.test(C.rowTitle(rows[1])));
ok('screenshot detail shows what the AI saw', C.rowDetail(rows[0]).some(([k, v]) => k === 'What the AI saw' && /60%/.test(v)));
ok('screenshot detail shows credits', C.rowDetail(rows[0]).some(([k, v]) => k === 'Credits' && v === '10'));

// approvals: Waiting for you -> Done
rows = C.add([], { kind: 'ask', tool: 'edit_file', callId: 'c7', args: '{"path":"a.js"}', level: 'ask', at: 1 });
ok('an approval request is "Waiting for you"', rows[0].status === 'proposed' && info(rows[0].status).word === 'Waiting for you');
rows = mergeLive(rows, C.answered('c7', true));
ok('allowing flips the SAME row to Done', rows.length === 1 && rows[0].status === 'ok' && rows[0].tool === 'edit_file');
rows = C.add([], { kind: 'ask', tool: 'terminal_open', callId: 'c8', args: '{"cmd":"dir"}', level: 'strict', at: 1 });
rows = mergeLive(rows, C.answered('c8', false));
ok('denying flips the same row to Denied by you', rows.length === 1 && info(rows[0].status).word === 'Denied by you');
ok('a strict row says it is asked every time', C.rowDetail({ kind: 'tool', tool: 'terminal_open', level: 'strict' }).some(([k]) => k === 'Permission'));

// other events
ok('refused rows show the reason', C.add([], { kind: 'refused', tool: 'edit_file', code: 'note-first', say: 'Write a note first', at: 1 })[0].status === 'refused');
ok('a user denial shows as denied', C.add([], { kind: 'refused', tool: 'edit_file', code: 'denied', say: 'no', at: 1 })[0].status === 'denied');
ok('stopped rows exist', C.add([], { kind: 'stopped', say: 'Out of credits for now.', at: 1 })[0].status === 'stopped');
ok('done rows exist', /^Finished: all good/.test(C.add([], { kind: 'done', say: 'all good', at: 1 })[0].text));
ok('unknown events are ignored', C.add(['x'], { kind: 'weird' }).length === 1 && C.add([], null).length === 0 && C.add([], 'text').length === 0);

// safety: no HTML is built here, long text is capped, bad times do not crash
const big = C.add([], { kind: 'tool', tool: 'screenshot_', result: 'A'.repeat(50000), cost: 10, at: 1 })[0];
ok('very long screenshot text is capped', big.text.length <= 800);
ok('a bad timestamp does not crash', typeof C.toRow({ kind: 'done', say: 'x', at: 'nope' }).t === 'string');
ok('the log is capped at 300 rows', Array.from({ length: 400 }, (_, i) => i).reduce((l, i) => C.add(l, { kind: 'tool', tool: 'note_', args: String(i), at: i }), []).length === 300);
ok('rows hold plain text only (the page must escape it)', C.toRow({ kind: 'tool', tool: 'note_', args: '<img src=x onerror=alert(1)>', at: 1 }).text.includes('<img'));

console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`);
process.exit(fail ? 1 : 0);
})();
