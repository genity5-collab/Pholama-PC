// Shows the Pholama Codebase usage bar in any element with id "cbUsage" and keeps it fresh.
// It asks the local server (/api/codebase/usage); on the public website that route does not exist, so nothing is shown there.
(function () {
  const U = window.PholamaUsageBar; let timer = 0;
  async function paint() {
    const box = document.getElementById('cbUsage'); if (!box || !U) return;
    try {
      const r = await fetch('/api/codebase/usage', { cache: 'no-store' }); if (!r.ok) throw 0;
      const v = await r.json(); box.innerHTML = U.html(v, { now: v.now, tz: v.tz });
      const wait = v.state === 'paused' ? Math.max(1000, v.pauseUntil - Date.now() + 500) : 60000;   // wake up exactly when a rest ends
      clearTimeout(timer); timer = setTimeout(paint, Math.min(wait, 300000));
    } catch { box.innerHTML = ''; }
  }
  window.PholamaCodebaseUsage = { paint };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint); else paint();
})();
