// Turns Pholama Codebase loop events into rows for the edit log (web/editlog.js). Pure logic, no page code.
// Screenshots and notes are first-class rows: every screenshot the AI takes appears here with what it read, and every note it writes too.
import { mergeLive } from './editlog.js';

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const iso = t => new Date(Number.isFinite(+t) ? +t : Date.now()).toISOString();

// One loop event -> one log row (or null when the event is not worth a row).
export function toRow(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const t = iso(ev.at);
  switch (ev.kind) {
    case 'tool': {
      if (ev.tool === 'note_') return { kind: 'note', status: 'ok', t, text: clip(ev.result || ev.args, 600), tool: 'note_' };
      if (ev.tool === 'screenshot_') return { kind: 'screenshot', status: 'ok', t, text: clip(ev.result, 800), cost: ev.cost || 0, tool: 'screenshot_' };
      return { kind: 'tool', status: 'ok', t, tool: ev.tool, text: clip(ev.args, 200), result: clip(ev.result, 600), cost: ev.cost || 0 };
    }
    case 'ask':     return { kind: 'tool', status: 'proposed', id: ev.callId, t, tool: ev.tool, text: clip(ev.args, 200), level: ev.level };
    case 'refused': return { kind: 'tool', status: ev.code === 'denied' ? 'denied' : 'refused', t, tool: ev.tool, text: clip(ev.say, 200), code: ev.code };
    case 'stopped': return { kind: 'step', status: 'stopped', t, text: clip(ev.say, 200) };
    case 'done':    return { kind: 'step', status: 'ok', t, text: 'Finished: ' + clip(ev.say, 300) };
    case 'retry':   return { kind: 'step', status: 'working', t, text: clip(ev.say, 200) };
    default:        return null;
  }
}

// An approval that gets answered turns its "Waiting for you" row into Done or Denied (same id replaces the row).
export function answered(callId, allowed) { return { kind: 'tool', id: callId, status: allowed ? 'ok' : 'denied' }; }

// Newest first, capped. The same id replaces its row, so "Waiting for you" becomes Done.
export function add(entries, ev) { const r = toRow(ev); return r ? mergeLive(entries, r, 300) : entries; }

// What the expanded row shows for the new kinds.
export function rowDetail(e) {
  if (!e) return [];
  const r = [];
  if (e.kind === 'screenshot') { r.push(['What the AI saw', e.text || '']); if (e.cost) r.push(['Credits', String(e.cost)]); }
  if (e.kind === 'note') r.push(['Note', e.text || '']);
  if (e.kind === 'tool') { if (e.tool) r.push(['Tool', e.tool]); if (e.text) r.push(['Target', e.text]); if (e.result) r.push(['Result', e.result]); if (e.level === 'strict') r.push(['Permission', 'Asked every time']); if (e.cost) r.push(['Credits', String(e.cost)]); }
  return r.filter(x => x[1]);
}
export const TITLE = { screenshot: 'Screenshot', note: 'Note' };
export function rowTitle(e) {
  if (!e) return 'Event';
  if (e.kind === 'screenshot') return 'Screenshot: ' + clip(e.text, 90);
  if (e.kind === 'note') return 'Note: ' + clip(e.text, 100);
  if (e.kind === 'tool') return (e.tool || 'tool') + (e.text ? ' ' + clip(e.text, 80) : '');
  return clip(e.text, 120) || 'Event';
}
