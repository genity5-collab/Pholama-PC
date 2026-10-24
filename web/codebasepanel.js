// The Pholama Codebase live panel: the edit log (screenshots, notes, tool calls), the note board, and the Allow / Deny buttons.
// Everything the AI wrote is untrusted text, so every piece goes through esc() before it touches the page. No innerHTML with raw text, ever.
(function (root) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
  const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const TONE = { ok: 'good', proposed: 'info', working: 'info', refused: 'bad', denied: 'warn', stopped: 'warn', error: 'bad' };
  const WORD = { ok: 'Done', proposed: 'Waiting for you', working: 'Working...', refused: 'Blocked', denied: 'Denied by you', stopped: 'Stopped', error: 'Error' };
  const ICON = { screenshot: 'SCR', note: 'NOTE', tool: 'TOOL', step: 'STEP' };

  function row(e) {
    const tone = TONE[e.status] || 'mute', word = WORD[e.status] || 'Event';
    const title = e.kind === 'screenshot' ? 'Screenshot: ' + clip(e.text, 90) : e.kind === 'note' ? 'Note: ' + clip(e.text, 100) : e.kind === 'tool' ? (e.tool || 'tool') + (e.text ? ' ' + clip(e.text, 80) : '') : clip(e.text, 120) || 'Event';
    const BODY = 800;   // the panel caps what it prints itself; it never trusts the caller to have done it
    const body = e.kind === 'screenshot' ? '<div class="cbl-read"><b>What the AI saw</b><p>' + esc(clip(e.text, BODY)) + '</p></div>' : e.kind === 'note' ? '<div class="cbl-read"><b>Note</b><p>' + esc(clip(e.text, BODY)) + '</p></div>' : e.result ? '<div class="cbl-read"><b>Result</b><p>' + esc(clip(e.result, BODY)) + '</p></div>' : '';
    const cost = e.cost ? '<span class="cbl-cost">' + esc(e.cost) + ' credits</span>' : '';
    return '<li class="cbl-row ' + esc(tone) + '"><span class="cbl-k">' + esc(ICON[e.kind] || 'EVT') + '</span><span class="cbl-t">' + esc(title) + '</span>' + cost + '<span class="cbl-s">' + esc(word) + '</span>' + body + '</li>';
  }
  const log = rows => '<ul class="cbl">' + ((rows || []).map(row).join('') || '<li class="cbl-empty">Nothing yet</li>') + '</ul>';

  // The note board: every note the AI wrote, newest first. This is the AI's memory across the tasks.
  const board = rows => { const n = (rows || []).filter(r => r && r.kind === 'note'); return '<div class="cbl-board"><h4>Note board</h4>' + (n.slice(0, 60).map(r => '<p>' + esc(clip(r.text, 800)) + '</p>').join('') || '<p class="cbl-empty">No notes yet</p>') + '</div>'; };

  // The Allow / Deny card. It shows exactly what will happen, and a stricter warning for strict tools. The ids go in data attributes (escaped).
  function ask(a) {
    if (!a) return '';
    const strict = a.level === 'strict';
    return '<div class="cbl-ask ' + (strict ? 'strict' : '') + '" data-call="' + esc(a.callId) + '"><b>' + esc(a.tool) + '</b> wants to run' + (strict ? ' <em>(asked every time)</em>' : '') + ':<pre>' + esc(clip(a.args, 400)) + '</pre><button data-act="allow">Allow</button><button data-act="deny">Deny</button></div>';
  }
  root.PholamaCodebasePanel = { esc, row, log, board, ask };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PholamaCodebasePanel;
})(typeof window !== 'undefined' ? window : globalThis);
