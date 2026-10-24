'use strict';
// Pholama Codebase: GitHub tools. Typed actions only (never free text). Reads are free; writes are checked here and asked about by the app.
// Safety rules enforced in code:
//  * the token is read from the environment, sent only to api.github.com, and scrubbed from everything returned to the model
//  * writes never touch the default branch: the agent works on its own branch (pholama/...) and opens a pull request
//  * previews publish only to the dedicated branch "pholama-preview"
//  * paths cannot escape the repo, touch .git, or touch .github/workflows (that would let a model run code in GitHub Actions)
const API = 'https://api.github.com';
const PREVIEW_BRANCH = 'pholama-preview';
const MAX_FILE = 400 * 1024, MAX_FILES = 60, MAX_READ = 60 * 1024, MAX_MSG = 300;

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const isStr = v => typeof v === 'string';
const no = say => ({ ok: false, say });

function repoRef(s) {
  if (!isStr(s)) return null;
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(s);   // exactly what was given: no trimming, so stray whitespace or newlines are refused
  if (!m || !OWNER_RE.test(m[1]) || !REPO_RE.test(m[2]) || m[2] === '.' || m[2] === '..' || m[2].endsWith('.git')) return null;
  return { owner: m[1], repo: m[2], full: m[1] + '/' + m[2] };
}
// Git branch rules (the useful subset), plus: writes must be on a pholama/ branch.
function branchOk(b) {
  if (!isStr(b) || b.length < 1 || b.length > 100) return false;
  if (/[\x00-\x20~^:?*\[\\]|\.\.|@\{|\/\/|^\/|\/$|\.lock$|\.$|^-/.test(b)) return false;
  return /^[A-Za-z0-9._\/-]+$/.test(b);
}
const isDefaultName = b => /^(main|master|trunk|develop|release.*|prod(uction)?)$/i.test(String(b));
function pathOk(p) {
  if (!isStr(p) || !p.length || p.length > 300) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0') || /[\x00-\x1f]/.test(p)) return false;
  const parts = p.split('/');
  if (parts.some(x => x === '' || x === '.' || x === '..')) return false;
  if (parts.some(x => /^\.git$/i.test(x) || /^\.gitmodules$/i.test(x))) return false;
  if (/^\.github$/i.test(parts[0])) return false;   // workflows and actions: code that runs in GitHub
  return true;
}
const scrub = (s, token) => { let t = String(s == null ? '' : s); if (token) t = t.split(token).join('[hidden]'); return t.replace(/(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[hidden]'); };

// ---------- planning: validates a tool call into an exact request, no network ----------
function plan(kind, a) {
  a = a && typeof a === 'object' ? a : {};
  const act = a.action;
  if (!isStr(act)) return no('Say which GitHub action.');
  const needRepo = () => repoRef(a.repo);
  if (kind === 'github_read') {
    if (!['list_files', 'read_file', 'commits', 'repo_info', 'list_branches', 'pages_status'].includes(act)) return no('Unknown read action.');
    const r = needRepo(); if (!r) return no('repo must look like owner/name.');
    const ref = a.ref === undefined ? undefined : a.ref; if (ref !== undefined && !branchOk(ref)) return no('Invalid branch.');
    if (act === 'read_file' || (act === 'list_files' && a.path)) { if (!pathOk(a.path)) return no('Invalid path.'); }
    return { ok: true, kind, action: act, repo: r, ref, path: a.path };
  }
  if (kind === 'github_write') {
    if (!['create_branch', 'write_files', 'open_pr', 'publish_preview', 'enable_pages'].includes(act)) return no('Unknown write action.');
    const r = needRepo(); if (!r) return no('repo must look like owner/name.');
    if (act === 'create_branch') {
      if (!branchOk(a.branch) || !a.branch.startsWith('pholama/')) return no('Branch names must start with pholama/ (example: pholama/add-menu).');
      return { ok: true, kind, action: act, repo: r, branch: a.branch };
    }
    if (act === 'write_files') {
      if (!branchOk(a.branch) || !a.branch.startsWith('pholama/')) return no('Writes go to a pholama/ branch, never the main branch.');
      if (!isStr(a.message) || !a.message.trim() || a.message.length > MAX_MSG) return no('A commit needs a short message.');
      if (!Array.isArray(a.files) || !a.files.length || a.files.length > MAX_FILES) return no('Give 1 to ' + MAX_FILES + ' files.');
      const seen = new Set(); let total = 0;
      for (const f of a.files) {
        if (!f || typeof f !== 'object' || !pathOk(f.path)) return no('Invalid file path: ' + (f && isStr(f.path) ? f.path.slice(0, 80) : ''));
        if (!isStr(f.content)) return no('Each file needs text content.');
        const size = Buffer.byteLength(f.content, 'utf8'); if (size > MAX_FILE) return no(f.path + ' is too large (max ' + MAX_FILE / 1024 + ' KB).');
        total += size; if (seen.has(f.path.toLowerCase())) return no('The same file twice: ' + f.path); seen.add(f.path.toLowerCase());
      }
      if (total > 2 * 1024 * 1024) return no('Too much at once (max 2 MB per commit).');
      return { ok: true, kind, action: act, repo: r, branch: a.branch, message: a.message.trim(), files: a.files.map(f => ({ path: f.path, content: f.content })) };
    }
    if (act === 'open_pr') {
      if (!branchOk(a.branch) || !a.branch.startsWith('pholama/')) return no('Pull requests come from a pholama/ branch.');
      if (!isStr(a.title) || !a.title.trim() || a.title.length > 200) return no('A pull request needs a title.');
      if (a.body !== undefined && (!isStr(a.body) || a.body.length > 5000)) return no('The description is too long.');
      if (a.base !== undefined && !branchOk(a.base)) return no('Invalid base branch.');
      return { ok: true, kind, action: act, repo: r, branch: a.branch, title: a.title.trim(), body: a.body || '', base: a.base };
    }
    if (act === 'publish_preview') {
      // a built, static site: published to the dedicated preview branch only
      if (!Array.isArray(a.files) || !a.files.length || a.files.length > MAX_FILES) return no('Give 1 to ' + MAX_FILES + ' files.');
      if (!a.files.some(f => f && f.path === 'index.html')) return no('A preview needs an index.html at the top.');
      const v = plan('github_write', { action: 'write_files', repo: a.repo, branch: 'pholama/preview-check', message: 'x', files: a.files }); if (!v.ok) return v;
      if (a.files.some(f => /\.(?:php|exe|bat|cmd|ps1|sh|dll|msi|scr)$/i.test(f.path))) return no('A preview can only hold web files (html, css, js, images, data).');
      return { ok: true, kind, action: act, repo: r, branch: PREVIEW_BRANCH, message: isStr(a.message) && a.message.trim() ? a.message.trim().slice(0, MAX_MSG) : 'Pholama preview', files: v.files };
    }
    if (act === 'enable_pages') return { ok: true, kind, action: act, repo: r, branch: PREVIEW_BRANCH };
  }
  return no('Unknown GitHub tool.');
}

// ---------- doing it: only ever runs a plan() result ----------
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
function client(token, fetchFn = fetch) {
  async function call(method, url, body) {
    if (!token) return { status: 0, error: 'No GitHub token is set for Pholama Codebase.' };
    let res; try { res = await fetchFn(API + url, { method, headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'pholama-codebase', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); } catch { return { status: 0, error: 'Could not reach GitHub.' }; }
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  }
  return call;
}
const friendly = (r, token) => {
  if (r.error) return r.error;
  if (r.status === 401) return 'GitHub did not accept the token.';
  if (r.status === 403) return 'The token is not allowed to do that (it may need Contents or Pages write access).';
  if (r.status === 404) return 'Not found, or the token cannot see it.';
  if (r.status === 409) return 'GitHub reported a conflict (the branch may have changed).';
  if (r.status === 422) return 'GitHub refused that: ' + scrub(r.json && r.json.message, token).slice(0, 200);
  return 'GitHub returned an error (' + r.status + ').';
};

async function execute(pl, { token = '', fetchFn = fetch } = {}) {   // the token is ONLY what the person gave this PC; never an environment variable
  if (!pl || pl.ok !== true) return { ok: false, text: (pl && pl.say) || 'Not allowed.' };
  if (!token || typeof token !== 'string') return { ok: false, text: 'No GitHub token is set for Pholama Codebase. Add one in Settings first.' };
  const call = client(token, fetchFn), R = pl.repo, base = '/repos/' + R.full;
  const fail = r => ({ ok: false, text: friendly(r, token) });
  const enc = p => p.split('/').map(encodeURIComponent).join('/');
  try {
    if (pl.kind === 'github_read') {
      if (pl.action === 'repo_info') { const r = await call('GET', base); if (r.status !== 200) return fail(r); const j = r.json; return { ok: true, text: JSON.stringify({ name: j.full_name, default_branch: j.default_branch, private: j.private, description: scrub(j.description, token), pushed_at: j.pushed_at, pages: j.has_pages }) }; }
      if (pl.action === 'list_branches') { const r = await call('GET', base + '/branches?per_page=50'); if (r.status !== 200) return fail(r); return { ok: true, text: r.json.map(b => b.name).join('\n') }; }
      if (pl.action === 'commits') { const r = await call('GET', base + '/commits?per_page=15' + (pl.ref ? '&sha=' + encodeURIComponent(pl.ref) : '')); if (r.status !== 200) return fail(r); return { ok: true, text: r.json.map(c => c.sha.slice(0, 7) + ' ' + scrub(String(c.commit.message).split('\n')[0], token).slice(0, 120)).join('\n') }; }
      if (pl.action === 'list_files') { const r = await call('GET', base + '/contents/' + (pl.path ? enc(pl.path) : '') + (pl.ref ? '?ref=' + encodeURIComponent(pl.ref) : '')); if (r.status !== 200) return fail(r); if (!Array.isArray(r.json)) return { ok: true, text: r.json.path + ' (file)' }; return { ok: true, text: r.json.slice(0, 200).map(f => (f.type === 'dir' ? 'dir  ' : 'file ') + f.path).join('\n') }; }
      if (pl.action === 'read_file') { const r = await call('GET', base + '/contents/' + enc(pl.path) + (pl.ref ? '?ref=' + encodeURIComponent(pl.ref) : '')); if (r.status !== 200) return fail(r); if (Array.isArray(r.json) || r.json.type !== 'file') return { ok: false, text: 'That is a folder, not a file.' }; const txt = Buffer.from(r.json.content || '', 'base64').toString('utf8'); return { ok: true, text: scrub(txt.length > MAX_READ ? txt.slice(0, MAX_READ) + '\n[cut: file is longer]' : txt, token) }; }
      if (pl.action === 'pages_status') { const r = await call('GET', base + '/pages'); if (r.status === 404) return { ok: true, text: 'Pages is not enabled for this repo.' }; if (r.status !== 200) return fail(r); return { ok: true, text: JSON.stringify({ url: r.json.html_url, status: r.json.status, branch: r.json.source && r.json.source.branch }) }; }
    }
    if (pl.kind === 'github_write') {
      const info = await call('GET', base); if (info.status !== 200) return fail(info);
      const def = info.json.default_branch;
      if (pl.action === 'create_branch' || pl.action === 'write_files' || pl.action === 'publish_preview') {
        if (pl.branch.toLowerCase() === String(def).toLowerCase()) return { ok: false, text: 'Refused: that is the main branch.' };
        // branch exists?
        let head = await call('GET', base + '/git/ref/heads/' + enc(pl.branch));
        if (head.status === 404) {
          if (pl.action === 'publish_preview') {   // the preview branch starts empty (orphan-like): branch from default, then replace the tree
            const d = await call('GET', base + '/git/ref/heads/' + enc(def)); if (d.status !== 200) return fail(d);
            const mk = await call('POST', base + '/git/refs', { ref: 'refs/heads/' + pl.branch, sha: d.json.object.sha }); if (mk.status !== 201) return fail(mk); head = await call('GET', base + '/git/ref/heads/' + enc(pl.branch));
          } else {
            const d = await call('GET', base + '/git/ref/heads/' + enc(def)); if (d.status !== 200) return fail(d);
            const mk = await call('POST', base + '/git/refs', { ref: 'refs/heads/' + pl.branch, sha: d.json.object.sha }); if (mk.status !== 201) return fail(mk);
            if (pl.action === 'create_branch') return { ok: true, text: 'Created branch ' + pl.branch + ' from ' + def + '.' };
            head = await call('GET', base + '/git/ref/heads/' + enc(pl.branch));
          }
        } else if (head.status !== 200) return fail(head);
        else if (pl.action === 'create_branch') return { ok: true, text: 'Branch ' + pl.branch + ' already exists.' };
        const parentSha = head.json.object.sha;
        const parent = await call('GET', base + '/git/commits/' + parentSha); if (parent.status !== 200) return fail(parent);
        const tree = [];
        for (const f of pl.files) { const bl = await call('POST', base + '/git/blobs', { content: b64(f.content), encoding: 'base64' }); if (bl.status !== 201) return fail(bl); tree.push({ path: f.path, mode: '100644', type: 'blob', sha: bl.json.sha }); }
        const nt = await call('POST', base + '/git/trees', pl.action === 'publish_preview' ? { tree } : { base_tree: parent.json.tree.sha, tree }); if (nt.status !== 201) return fail(nt);
        const nc = await call('POST', base + '/git/commits', { message: pl.message, tree: nt.json.sha, parents: [parentSha] }); if (nc.status !== 201) return fail(nc);
        const up = await call('PATCH', base + '/git/refs/heads/' + enc(pl.branch), { sha: nc.json.sha, force: false }); if (up.status !== 200) return fail(up);
        return { ok: true, text: 'Committed ' + pl.files.length + ' file(s) to ' + pl.branch + ' (' + nc.json.sha.slice(0, 7) + ').' };
      }
      if (pl.action === 'open_pr') {
        const r = await call('POST', base + '/pulls', { title: pl.title, head: pl.branch, base: pl.base || def, body: pl.body }); if (r.status === 422 && /already exists/i.test(JSON.stringify(r.json))) return { ok: true, text: 'A pull request for ' + pl.branch + ' is already open.' };
        if (r.status !== 201) return fail(r); return { ok: true, text: 'Opened pull request #' + r.json.number + ': ' + r.json.html_url };
      }
      if (pl.action === 'enable_pages') {
        const ex = await call('GET', base + '/pages');
        const r = ex.status === 200 ? await call('PUT', base + '/pages', { source: { branch: pl.branch, path: '/' } }) : await call('POST', base + '/pages', { source: { branch: pl.branch, path: '/' } });
        if (![200, 201, 202, 204].includes(r.status)) return fail(r);
        return { ok: true, text: 'GitHub Pages is on for branch ' + pl.branch + '. The preview address is https://' + R.owner.toLowerCase() + '.github.io/' + R.repo + '/ (it can take a minute to appear).' };
      }
    }
  } catch (e) { return { ok: false, text: 'GitHub step failed: ' + scrub(e && e.message, token).slice(0, 150) }; }
  return { ok: false, text: 'Unknown GitHub action.' };
}
module.exports = { plan, execute, repoRef, branchOk, pathOk, scrub, PREVIEW_BRANCH };
