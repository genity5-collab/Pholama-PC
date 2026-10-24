// The Codebase usage bar: right numbers, right wording per state, and never NaN or injected HTML.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.PHOLAMA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ub-'));
const U = require('../web/usagebar.js'), B = require('../server/codebase-budget.js');
let bad = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + String(x).slice(0, 260))); if (!c) bad++; };
const T = (y, m, d, h = 12, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const now = T(2026, 10, 24, 9);

let h = U.html(B.spend(3300, now), { now });
ok('22% shows as "22% used" with a bar 22% wide', /22% used/.test(h) && /width:22%/.test(h) && /aria-valuenow="22"/.test(h), h);
ok('it has the heading, the track and the grey line', /Current month/.test(h) && /ubar-track/.test(h) && /ubar-sub/.test(h));
ok('the grey line says what is left, when the rest comes, and the month reset', /11,700 left/.test(h) && /rest after 1,700 more/.test(h) && /month resets Nov 1, 12am/.test(h), h.match(/ubar-sub">([^<]*)/)[1]);
ok('markers sit at 33% and 67% (the two rests)', /left:33%/.test(h) && /left:67%/.test(h) && U.marks({ cap: 15000 }).join() === '33,67');
ok('an ok bar has no state class', /class="ubar "/.test(h));

h = U.html(B.spend(1700, now), { now });   // crosses 5,000
ok('resting: amber state, shows the time it comes back', /ubar paused/.test(h) && /Resting\. Back at 4pm/.test(h), h.match(/ubar-sub">([^<]*)/)[1]);
ok('resting at 33% used', /33% used/.test(h));
fs.unlinkSync(B.FILE());
h = U.html(B.spend(15000, now), { now });
ok('locked: red state, 100%, and the reset date', /ubar locked/.test(h) && /100% used/.test(h) && /All 15,000 used\. Resets Nov 1, 12am/.test(h), h.match(/ubar-sub">([^<]*)/)[1]);

ok('a time with minutes keeps them: 4:30pm', U.clock(T(2026, 10, 24, 16, 30)) === '4:30pm' && U.clock(T(2026, 10, 24, 0, 0)) === '12am' && U.clock(T(2026, 10, 24, 12, 0)) === '12pm');
ok('the time zone name is shown when given', U.clock(T(2026, 10, 24, 16), 'Europe/Warsaw') === '4pm (Europe/Warsaw)');
ok('same-day times show just the clock, other days show the date', U.when(T(2026, 10, 24, 16), now) === '4pm' && U.when(T(2026, 10, 25, 3), now) === 'Oct 25, 3am');

for (const [name, v] of [['empty', {}], ['null', null], ['undefined', undefined], ['text', { percent: 'lots', used: 'x', left: 'y', cap: 'z', untilPause: 'q', resetsAt: 'never' }], ['NaN', { percent: NaN, left: NaN, untilPause: NaN, monthResetsAt: NaN }], ['over 100', { percent: 900, state: 'ok' }], ['negative', { percent: -40 }]]) {
  const o = U.html(v, { now });
  ok('garbage input (' + name + ') never prints NaN/undefined/null', !/NaN|undefined|null/.test(o), o);
  const w = +(o.match(/width:(\d+)%/) || [])[1]; ok('...and the bar width stays 0 to 100 (' + name + ')', w >= 0 && w <= 100, o);
}
const evil = U.html({ percent: 10, state: '"><script>alert(1)</script>', left: '<img src=x onerror=1>', cap: 15000 }, { now, tz: '<b>x</b>' });
ok('hostile values cannot inject HTML', !/<script|<img|<b>x/.test(evil) && !/onerror=1>/.test(evil.replace(/&lt;img[^&]*/, '')), evil);
ok('an unknown state cannot add its own CSS class', !/script/.test((evil.match(/class="ubar[^"]*"/) || [''])[0]), evil.match(/class="ubar[^"]*"/));
console.log(bad ? 'FAILED ' + bad : 'ALL PASSED'); process.exit(bad ? 1 : 0);
