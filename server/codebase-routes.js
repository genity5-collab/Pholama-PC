// HTTP routes for Pholama Codebase. server.js hands every /api/codebase/ request here.
// Local only, like the Studio routes: a website may chat with this PC, but it can never grant folders or spend credits.
'use strict';
const budget = require('./codebase-budget'), grants = require('./codebase-grants');

// Same rule as approving commands in server.js: the app's own page has no Origin (same-origin) or this PC's own address AND port.
const ownPage = (req, port) => { const o = req.headers.origin; return !o || new RegExp('^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):' + (+port || 11435) + '$').test(o); };

async function handle(req, res, u, deps) {
  const { json, body } = deps;
  if (req.who !== 'local') return json(res, 403, { error: 'Pholama Codebase can only be used on the PC itself.' });
  // Granting folders and spending credits belong to the PC app's own page. The Pholama website (and any origin the user listed for chat)
  // may talk to this PC for plain chat, but a web page must never be able to give itself access to your folders.
  if (!ownPage(req, deps.port)) return json(res, 403, { error: 'Only the Pholama app on this PC can change Codebase settings.' });
  const seg = u.pathname.replace(/^\/api\/codebase\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (seg[0] === 'usage' && req.method === 'GET') return json(res, 200, { ...budget.status(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '', now: Date.now() });
    if (seg[0] === 'grants' && !seg[1] && req.method === 'GET') return json(res, 200, { grants: grants.list(), downloads: grants.downloadsDir() });
    if (seg[0] === 'grants' && !seg[1] && req.method === 'POST') { const b = await body(req); return json(res, 200, grants.grant(b.dir, b.mode)); }
    if (seg[0] === 'grants' && seg[1] === 'remove' && req.method === 'POST') { const b = await body(req); return json(res, 200, { removed: grants.revoke(b.dir) }); }
    return json(res, 404, { error: 'Unknown Codebase route.' });
  } catch (e) { return json(res, 400, { error: String(e && e.message || e).slice(0, 300) }); }
}
module.exports = { handle, ownPage };
