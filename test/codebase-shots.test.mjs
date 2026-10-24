// Screenshots the agent takes must show up in the Codebase screen: kept in memory only, size-capped, PNG only, served by id, shown as an image.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const SH = require('../server/codebase-shots.js');
const { describe, rowHtml } = await import('../web/codebasescreen.js');
const { toRow } = await import('../web/codebaselog.js');
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? '  -> ' + String(x).slice(0, 200) : '')); } };
const PNG = n => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 1)]);

const id = SH.put(PNG(500));
ok('a real PNG is stored and gets a 16-hex id', /^[a-f0-9]{16}$/.test(id));
ok('and can be read back', SH.get(id) && SH.get(id).length === 508);
ok('not a PNG: refused', SH.put(Buffer.from('<html>not an image'.repeat(20))) === null && SH.put('text') === null && SH.put(null) === null);
ok('too big: refused', SH.put(PNG(SH.MAX_BYTES + 10)) === null);
ok('too small to be a picture: refused', SH.put(PNG(10)) === null);
const ids = []; for (let i = 0; i < SH.MAX_KEEP + 5; i++) ids.push(SH.put(PNG(200 + i)));
ok('only the newest few are kept', SH.get(ids[0]) === null && SH.get(ids[ids.length - 1]) !== null);
ok('a guessed or hostile id finds nothing', SH.get('../../etc/passwd') === null && SH.get('constructor') === null && SH.get('') === null && SH.get(undefined) === null && SH.get('a'.repeat(16)) === null);
SH.clear(); ok('clear empties it', SH.get(ids[ids.length - 1]) === null);

// the screen
const good = 'abcdef0123456789';
const d = describe({ kind: 'tool', tool: 'screenshot_', result: 'A YouTube page.\nOPEN WINDOWS (opened by the agent, closable): ["x"]', cost: 10, shot: good });
ok('a screenshot is its own row with the picture id', d.tag === 'SCREEN' && d.shot === good && d.cost === 10);
ok('the window list is not shown as text', !/OPEN WINDOWS/.test(d.result) && /YouTube/.test(d.result));
const h = rowHtml(d);
ok('it renders an <img> that points at the safe route and opens big on click', /<img [^>]*src="\/api\/codebase\/shot\/abcdef0123456789"/.test(h) && /<a class="cbs-shot" href="\/api\/codebase\/shot\/abcdef0123456789"/.test(h));
for (const evil of ['"><script>alert(1)</script>', '../../x', 'javascript:alert(1)', 'ABCDEF0123456789', 'abc']) {
  const e = rowHtml(describe({ kind: 'tool', tool: 'screenshot_', result: 'r', shot: evil }));
  ok('a bad picture id is dropped, no <img>: ' + evil.slice(0, 18), !/<img|<script/.test(e), e);
}
ok('no picture id: still a normal row', !/<img/.test(rowHtml(describe({ kind: 'tool', tool: 'screenshot_', result: 'x' }))));
ok('the result text is escaped', !/<b>/.test(rowHtml(describe({ kind: 'tool', tool: 'screenshot_', result: '<b>x</b>', shot: good }))));
const row = toRow({ kind: 'tool', tool: 'screenshot_', result: 'seen', cost: 10, shot: good, at: 1 });
ok('the log row keeps the picture id', row.kind === 'screenshot' && row.shot === good);
ok('and drops a bad one', toRow({ kind: 'tool', tool: 'screenshot_', result: 'r', shot: '../x', at: 1 }).shot === '');
console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`); process.exit(fail ? 1 : 0);
