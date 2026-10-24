// Attacks on the Pholama Codebase panel: hostile text from the AI or from a screenshot must never become live HTML.
const P = require('../web/codebasepanel.js');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } };

const EVIL = ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '"><svg onload=alert(1)>', "' onmouseover='alert(1)", '`<b>x</b>`', '<a href="javascript:alert(1)">x</a>', '&lt;already&gt;'];
// A tag only counts as live if its "<" survives. After escaping there must be no "<" except the panel's own tags.
const OWN = /<\/?(ul|li|span|div|b|p|pre|button|h4|em)( [^<>]*)?>/g;
const OWNSAFE = /<\/?(ul|li|span|div|b|p|pre|button|h4|em)( (class|data-call|data-act)="[^"<>]*")*>/g;   // only the panel's own tags with only its own attributes
const live = html => html.replace(OWNSAFE, '').includes('<');
// Attribute NAMES in real tags (values are quoted and inert). Walk each tag, skipping over quoted values, so text inside quotes can never look like an attribute.
const attrNames = html => { const names = []; const tag = /<[a-z0-9]+((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>/gi; let m; while ((m = tag.exec(html))) { const re = /\s+([a-z-]+)(?:="[^"]*")?/gi; let x; while ((x = re.exec(m[1]))) names.push(x[1].toLowerCase()); } return names; };
const hasHandler = html => attrNames(html).some(n => n.startsWith('on') || !['class', 'data-call', 'data-act'].includes(n));

for (const evil of EVIL) {
  for (const kind of ['screenshot', 'note', 'tool', 'step']) {
    const h = P.row({ kind, status: 'ok', text: evil, result: evil, tool: evil, cost: 10 });
    ok(`${kind} row neutralises ${evil.slice(0, 22)}`, !live(h) && !hasHandler(h));
  }
  ok(`log neutralises ${evil.slice(0, 22)}`, !live(P.log([{ kind: 'note', status: 'ok', text: evil }])));
  ok(`note board neutralises ${evil.slice(0, 22)}`, !live(P.board([{ kind: 'note', text: evil }])));
  const a = P.ask({ tool: evil, level: 'strict', callId: evil, args: evil });
  ok(`allow card neutralises ${evil.slice(0, 22)}`, !live(a) && !hasHandler(a) && (a.match(/data-call="/g) || []).length === 1 && a.split('<button').length === 3);
}
ok('double quote cannot break out of the data-call attribute', P.ask({ tool: 't', callId: '" onclick="x', args: '' }).includes('data-call="&quot; onclick=&quot;x"'));
// The contract of esc() itself, character by character. A broken escaper must fail HERE even if it breaks in a way that happens to look harmless.
ok('esc: < becomes &lt;', P.esc('<') === '&lt;');
ok('esc: > becomes &gt;', P.esc('>') === '&gt;');
ok('esc: & becomes &amp;', P.esc('&') === '&amp;');
ok('esc: " becomes &quot;', P.esc('"') === '&quot;');
ok("esc: ' becomes &#39;", P.esc("'") === '&#39;');
ok('esc: ` becomes &#96;', P.esc('`') === '&#96;');
ok('esc keeps the text readable (no undefined, no loss)', P.esc('a<b>&"c') === 'a&lt;b&gt;&amp;&quot;c' && !/undefined/.test(P.esc('<>&"\'`')));
ok('esc escapes an already-escaped string again (no double-decode trick)', P.esc('&lt;') === '&amp;lt;');
ok('the visible text of a hostile row still contains the original characters, escaped', P.row({ kind: 'note', status: 'ok', text: '<b>x</b>' }).includes('&lt;b&gt;x&lt;/b&gt;'));
ok('esc handles null and numbers', P.esc(null) === '' && P.esc(5) === '5');

// shape
ok('a screenshot row shows what the AI saw and its cost', /What the AI saw/.test(P.row({ kind: 'screenshot', status: 'ok', text: 'bar at 60%', cost: 10 })) && /10 credits/.test(P.row({ kind: 'screenshot', status: 'ok', text: 'x', cost: 10 })));
ok('a waiting row says Waiting for you', /Waiting for you/.test(P.row({ kind: 'tool', status: 'proposed', tool: 'edit_file' })));
ok('a strict card says it is asked every time', /asked every time/.test(P.ask({ tool: 'terminal_open', level: 'strict', callId: 'c1', args: 'dir' })));
ok('an ordinary card does not', !/asked every time/.test(P.ask({ tool: 'edit_file', level: 'ask', callId: 'c1', args: 'a.js' })));
ok('the card has Allow and Deny', /data-act="allow"/.test(P.ask({ tool: 'x', callId: 'c' })) && /data-act="deny"/.test(P.ask({ tool: 'x', callId: 'c' })));
ok('an empty log says Nothing yet', /Nothing yet/.test(P.log([])) && /Nothing yet/.test(P.log(null)));
ok('an empty board says No notes yet', /No notes yet/.test(P.board([])));
ok('the board lists only notes', !/screen/.test(P.board([{ kind: 'screenshot', text: 'screen' }, { kind: 'note', text: 'plan' }])) && /plan/.test(P.board([{ kind: 'note', text: 'plan' }])));
ok('a null card is empty', P.ask(null) === '');
ok('long text is capped in the row', P.row({ kind: 'note', status: 'ok', text: 'A'.repeat(5000) }).split('A').length - 1 <= 900);
ok('a huge result is capped', P.row({ kind: 'tool', status: 'ok', tool: 't', result: 'B'.repeat(9000) }).split('B').length - 1 <= 800);
ok('the board caps each note and the count', P.board(Array.from({ length: 200 }, () => ({ kind: 'note', text: 'C'.repeat(3000) }))).split('C').length - 1 <= 60 * 800);
ok('unknown kinds and statuses do not crash', typeof P.row({ kind: 'zzz', status: 'zzz' }) === 'string');

console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`);
process.exit(fail ? 1 : 0);
