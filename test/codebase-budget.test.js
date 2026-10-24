// Pholama Codebase budget: 15,000 credits a month, a 7-hour rest after every 5,000, a month lock at 15,000.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.PHOLAMA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-'));
const B = require('../server/codebase-budget.js');
let bad = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + String(x).slice(0, 220))); if (!c) bad++; };
const reset = () => { try { fs.unlinkSync(B.FILE()); } catch {} };
const T = (y, m, d, h = 12, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime();   // local time, like the app
const H = 3600 * 1000;

ok('the numbers are the agreed ones', B.MONTH_CREDITS === 15000 && B.STEP === 5000 && B.PAUSE_HOURS === 7 && B.PAUSE_MS === 7 * H);
reset(); let t = T(2026, 10, 24, 9);
let v = B.status(t);
ok('a fresh month starts at 0 of 15,000 and may work', v.used === 0 && v.left === 15000 && v.percent === 0 && v.state === 'ok' && B.gate(t).ok);
ok('the bar knows how far the first rest is', v.untilPause === 5000 && v.stepsUsed === 0);
v = B.spend(1200, t);
ok('spending is counted and the percentage follows', v.used === 1200 && v.left === 13800 && v.percent === 8 && v.crossed === 0 && v.state === 'ok');
ok('a charge of 0, negative, NaN or text changes nothing', [0, -5, NaN, 'abc', null, undefined, Infinity].every(c => B.spend(c, t).used === 1200), JSON.stringify(B.status(t)));
v = B.spend(3799, t);
ok('4,999 used: still working, 1 credit from the first rest', v.used === 4999 && v.state === 'ok' && v.untilPause === 1 && B.gate(t).ok);

// first 5,000 line
v = B.spend(1, t);
ok('exactly 5,000 used: the 7-hour rest begins', v.used === 5000 && v.crossed === 1 && v.state === 'paused' && v.pauseUntil === t + 7 * H, JSON.stringify(v));
let g = B.gate(t + 60000);
ok('during the rest the agent may not work, and says until when', !g.ok && g.state === 'paused' && g.until === t + 7 * H && /resting/.test(g.message), JSON.stringify(g));
ok('6 h 59 min later it is still resting', !B.gate(t + 7 * H - 60000).ok);
ok('at exactly 7 hours it may work again', B.gate(t + 7 * H).ok === true && B.status(t + 7 * H).state === 'ok');
ok('the bar shows when it can work again while resting', B.status(t + H).resetsAt === t + 7 * H && B.status(t + H).percent === 33);
ok('the rest survives a restart of the app (it is on disk)', (() => { delete require.cache[require.resolve('../server/codebase-budget.js')]; const B2 = require('../server/codebase-budget.js'); return !B2.gate(t + H).ok; })());

// work after the rest, second line
t += 8 * H;
v = B.spend(4999, t); ok('after the rest: 9,999 used, working', v.used === 9999 && v.state === 'ok' && v.crossed === 0);
v = B.spend(1, t);
ok('10,000 used: a second 7-hour rest begins', v.used === 10000 && v.crossed === 1 && v.state === 'paused' && v.pauseUntil === t + 7 * H);
t += 7 * H + 1;
ok('the second rest also ends after 7 hours', B.gate(t).ok);

// the month lock
v = B.spend(4999, t); ok('14,999 used: still not locked, working', v.used === 14999 && v.state === 'ok' && B.gate(t).ok);
v = B.spend(1, t);
ok('15,000 used: locked for the month, no 7-hour timer', v.used === 15000 && v.left === 0 && v.percent === 100 && v.state === 'locked', JSON.stringify(v));
g = B.gate(t);
ok('locked: the gate says it works again on the 1st', !g.ok && g.state === 'locked' && g.until === T(2026, 11, 1, 0, 0) && /1st/.test(g.message), JSON.stringify(g));
ok('locked: the bar resets on the 1st of next month at 00:00', B.status(t).resetsAt === T(2026, 11, 1, 0, 0));
ok('reaching 15,000 stores no 7-hour timer (the month lock is the only rule)', JSON.parse(fs.readFileSync(B.FILE(), 'utf8')).pauseUntil < t, fs.readFileSync(B.FILE(), 'utf8'));
ok('more spending past the cap cannot exceed 15,000', B.spend(999999, t).used === 15000);
ok('locked even a month-end day later', !B.gate(T(2026, 10, 31, 23, 59)).ok);
ok('on the 1st of the next month the pool is full again', (() => { const n = T(2026, 11, 1, 0, 0); const s = B.status(n); return B.gate(n).ok && s.used === 0 && s.left === 15000 && s.state === 'ok'; })());

// big jumps
reset(); t = T(2026, 10, 24, 9);
v = B.spend(12000, t);
ok('one big job past two lines: one rest only, not two (7 hours, not 14)', v.used === 12000 && v.crossed === 2 && v.pauseUntil === t + 7 * H, JSON.stringify(v));
reset(); v = B.spend(20000, t);
ok('a job past the whole pool locks the month and is capped at 15,000', v.used === 15000 && v.state === 'locked' && v.crossed === 3);
reset(); B.spend(5000, t); const p1 = B.status(t).pauseUntil; B.spend(10, t + H);
ok('a charge during a rest does not restart or extend it', B.status(t + H).pauseUntil === p1);

// month edges and bad files
reset(); B.spend(7000, T(2026, 10, 31, 23, 59));
ok('a pause that spans midnight into a new month ends with the new month', B.gate(T(2026, 11, 1, 0, 1)).ok && B.status(T(2026, 11, 1, 0, 1)).used === 0);
ok('December rolls into January of the next year', B.nextMonthStart(T(2026, 12, 15)) === T(2027, 1, 1, 0, 0) && B.monthKey(T(2026, 12, 31, 23, 59)) === '2026-12');
ok('February in a leap year is handled', B.nextMonthStart(T(2028, 2, 29, 12)) === T(2028, 3, 1, 0, 0));
for (const [name, body] of [['not json', '{oops'], ['wrong version', '{"v":9,"used":5}'], ['negative', '{"v":1,"month":"' + B.monthKey() + '","used":-50,"pauseUntil":0}'], ['text', '{"v":1,"month":"' + B.monthKey() + '","used":"lots","pauseUntil":"never"}'], ['huge', '{"v":1,"month":"' + B.monthKey() + '","used":9e99,"pauseUntil":0}']]) {
  fs.writeFileSync(B.FILE(), body); const s = B.status();
  ok('a damaged file (' + name + ') gives sane numbers, never NaN', Number.isFinite(s.used) && s.used >= 0 && s.used <= 15000 && Number.isFinite(s.percent) && Number.isFinite(s.resetsAt), JSON.stringify(s));
}
reset(); fs.writeFileSync(B.FILE(), '{"v":1,"month":"2026-10","used":14000,"pauseUntil":0}');
ok('a damaged file never gives MORE credits than a good one would (14,000 stays 14,000 this month)', B.status(T(2026, 10, 20)).used === 14000);
ok('the status never contains NaN anywhere', !/NaN|null|undefined/.test(JSON.stringify(B.status())), JSON.stringify(B.status()));
console.log(bad ? 'FAILED ' + bad : 'ALL PASSED');
process.exit(bad ? 1 : 0);
