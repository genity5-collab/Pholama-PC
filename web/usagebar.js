// Pholama Codebase usage bar: "Current month  [=====----]  22% used  Resets ..." like a terminal usage screen.
// The text is built by plain functions (no page code) so it is tested on its own. Numbers come from /api/codebase/usage.
(function (root) {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n, d = 0) => (Number.isFinite(+n) ? +n : d);
  const fmt = n => num(n).toLocaleString('en-US');

  // "4pm" / "4:30pm" in the viewer's own time zone, plus the zone name when the browser knows it.
  function clock(ms, tz) {
    const d = new Date(num(ms)); if (!num(ms)) return '';
    let h = d.getHours(), m = d.getMinutes(); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12;
    return h + (m ? ':' + String(m).padStart(2, '0') : '') + ap + (tz ? ' (' + tz + ')' : '');
  }
  function when(ms, now, tz) {
    const t = num(ms); if (!t) return '';
    const d = new Date(t), n = new Date(num(now, Date.now()));
    const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    if (sameDay) return clock(t, tz);
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
    return mon + ' ' + d.getDate() + ', ' + clock(t, tz);
  }
  // What the grey line under the bar says.
  function resetLine(v, now, tz) {
    v = v || {};
    if (v.state === 'locked') return 'All ' + fmt(v.cap || 15000) + ' used. Resets ' + when(v.monthResetsAt, now, tz);
    if (v.state === 'paused') return 'Resting. Back at ' + when(v.pauseUntil, now, tz) + ' · month resets ' + when(v.monthResetsAt, now, tz);
    return fmt(v.left) + ' left · rest after ' + fmt(v.untilPause) + ' more · month resets ' + when(v.monthResetsAt, now, tz);
  }
  // Marks on the bar where the 7-hour rests happen (33% and 67%), so the user sees them coming.
  const marks = v => [5000, 10000].map(x => Math.round(x / num(v && v.cap, 15000) * 100));

  function html(v, opts = {}) {
    v = v || {}; const now = opts.now, tz = opts.tz;
    const pct = Math.max(0, Math.min(100, num(v.percent)));
    const cls = v.state === 'locked' ? 'locked' : v.state === 'paused' ? 'paused' : '';
    return '<div class="ubar ' + cls + '" role="group" aria-label="Pholama Codebase usage">'
      + '<div class="ubar-h">Current month</div>'
      + '<div class="ubar-row"><div class="ubar-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '">'
      + '<i style="width:' + pct + '%"></i>' + marks(v).map(m => '<b style="left:' + m + '%"></b>').join('') + '</div>'
      + '<span class="ubar-pct">' + pct + '% used</span></div>'
      + '<div class="ubar-sub">' + esc(resetLine(v, now, tz)) + '</div></div>';
  }
  const api = { html, resetLine, when, clock, marks, fmt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PholamaUsageBar = api;
})(typeof window !== 'undefined' ? window : globalThis);
