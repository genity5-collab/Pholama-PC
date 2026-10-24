'use strict';
const G = require('../server/codebase-github');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } };
const TOKEN = 'github_pat_SECRETSECRETSECRETSECRET1234567890';

// ---- a tiny fake GitHub ----
function fakeGitHub({ failAt, defaultBranch = 'main', code = 403 } = {}) {
  const log = [], branches = { [defaultBranch]: 'sha-main' }; let n = 0, pages = false;
  const reply = (code, json) => ({ status: code, json: async () => json });
  const f = async (url, opts) => {
    const u = url.replace('https://api.github.com', ''), m = opts.method;
    log.push({ m, u, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers.Authorization, host: url.split('/')[2] });
    if (failAt && failAt.test(m + ' ' + u)) return reply(code, { message: 'nope ' + TOKEN });
    let x;
    if (m === 'GET' && (x = /^\/repos\/[^/]+\/[^/]+$/.exec(u))) return reply(200, { full_name: 'o/r', default_branch: defaultBranch, private: false, description: 'd ' + TOKEN, pushed_at: 't', has_pages: pages });
    if (m === 'GET' && (x = /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/(.+)$/.exec(u))) { const b = decodeURIComponent(x[1]); return branches[b] ? reply(200, { object: { sha: branches[b] } }) : reply(404, {}); }
    if (m === 'POST' && /\/git\/refs$/.test(u)) { const b = JSON.parse(opts.body).ref.replace('refs/heads/', ''); branches[b] = JSON.parse(opts.body).sha; return reply(201, {}); }
    if (m === 'GET' && /\/git\/commits\//.test(u)) return reply(200, { tree: { sha: 'tree0' } });
    if (m === 'POST' && /\/git\/blobs$/.test(u)) return reply(201, { sha: 'blob' + (++n) });
    if (m === 'POST' && /\/git\/trees$/.test(u)) return reply(201, { sha: 'tree' + (++n) });
    if (m === 'POST' && /\/git\/commits$/.test(u)) return reply(201, { sha: 'commit' + (++n) + 'abcdef' });
    if (m === 'PATCH' && (x = /\/git\/refs\/heads\/(.+)$/.exec(u))) { branches[decodeURIComponent(x[1])] = JSON.parse(opts.body).sha; return reply(200, {}); }
    if (m === 'POST' && /\/pulls$/.test(u)) return reply(201, { number: 7, html_url: 'https://github.com/o/r/pull/7' });
    if (/\/pages$/.test(u)) { if (m === 'GET') return pages ? reply(200, { html_url: 'https://o.github.io/r/', status: 'built', source: { branch: 'pholama-preview' } }) : reply(404, {}); pages = true; return reply(m === 'POST' ? 201 : 204, {}); }
    if (m === 'GET' && /\/contents\//.test(u)) return reply(200, /\/contents\/dir/.test(u) ? [{ type: 'file', path: 'dir/a.js' }] : { type: 'file', path: 'a.js', content: Buffer.from('hello ' + TOKEN).toString('base64') });
    if (m === 'GET' && /\/branches/.test(u)) return reply(200, [{ name: 'main' }, { name: 'pholama/x' }]);
    if (m === 'GET' && /\/commits/.test(u)) return reply(200, [{ sha: 'abcdef1234', commit: { message: 'first\nsecond' } }]);
    return reply(500, {});
  };
  return { f, log, branches };
}
const P = (k, a) => G.plan(k, a);
const GOOD = { action: 'write_files', repo: 'owner/repo', branch: 'pholama/add-menu', message: 'add menu', files: [{ path: 'src/menu.js', content: 'x' }] };

(async () => {
  // ===== repo / branch / path validation =====
  for (const r of ['owner/repo', 'a/b', 'My-Org/my.repo_1', 'genity5-collab/Pholama-PC']) ok('valid repo: ' + r, !!G.repoRef(r));
  for (const r of ['', 'owner', 'owner/', '/repo', 'a/b/c', 'owner/repo.git', 'owner/..', 'owner/.', '-bad/repo', 'o w/r', 'o/r r', 'o/r;rm', 'o/r\n', 'https://github.com/o/r', '../x/y', 'a'.repeat(50) + '/r', null, undefined, 5, {}, []]) ok('invalid repo refused: ' + JSON.stringify(r), G.repoRef(r) === null);
  for (const b of ['pholama/x', 'pholama/add-menu', 'pholama/a.b_c/d']) ok('valid branch: ' + b, G.branchOk(b));
  for (const b of ['', 'a..b', 'a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a@{b', '/a', 'a/', 'a//b', 'a.lock', 'a.', '-a', 'a\nb', 'x'.repeat(101), null, 5]) ok('invalid branch refused: ' + JSON.stringify(b), !G.branchOk(b));
  for (const p of ['a.js', 'src/a.js', 'docs/readme.md', 'a/b/c/d.txt', '.gitignore', '.eslintrc.json']) ok('valid path: ' + p, G.pathOk(p));
  for (const p of ['', '/a', '../a', 'a/../b', 'a/./b', './a', 'a//b', 'a/', '.git/config', 'a/.git/hooks/x', '.GIT/x', '.gitmodules', 'sub/.gitmodules', '.github/workflows/ci.yml', '.GitHub/workflows/x.yml', '.github/actions/x/action.yml', 'a\\b', 'a\0b', 'a\nb', 'x'.repeat(301), null, 5]) ok('invalid path refused: ' + JSON.stringify(String(p).slice(0, 30)), !G.pathOk(p));

  // ===== plan: writes can never reach the main branch =====
  ok('a normal write plans', P('github_write', GOOD).ok === true);
  for (const b of ['main', 'master', 'develop', 'release', 'production', 'prod', 'trunk', 'feature/x', 'pholama', 'pholamax/y', 'Pholama/x', 'x/pholama/y']) ok('write to a non-pholama branch refused: ' + b, P('github_write', { ...GOOD, branch: b }).ok === false);
  ok('open_pr only from a pholama branch', P('github_write', { action: 'open_pr', repo: 'o/r', branch: 'main', title: 't' }).ok === false && P('github_write', { action: 'open_pr', repo: 'o/r', branch: 'pholama/x', title: 't' }).ok === true);
  ok('create_branch only makes pholama branches', P('github_write', { action: 'create_branch', repo: 'o/r', branch: 'main' }).ok === false && P('github_write', { action: 'create_branch', repo: 'o/r', branch: 'pholama/x' }).ok === true);

  // ===== plan: file rules =====
  ok('workflow files are refused', P('github_write', { ...GOOD, files: [{ path: '.github/workflows/ci.yml', content: 'x' }] }).ok === false);
  ok('path escapes are refused', P('github_write', { ...GOOD, files: [{ path: '../../etc/passwd', content: 'x' }] }).ok === false);
  ok('.git writes are refused', P('github_write', { ...GOOD, files: [{ path: '.git/config', content: 'x' }] }).ok === false);
  ok('one bad file refuses the whole commit', P('github_write', { ...GOOD, files: [{ path: 'ok.js', content: 'x' }, { path: '../bad', content: 'x' }] }).ok === false);
  ok('the same file twice (even by case) is refused', P('github_write', { ...GOOD, files: [{ path: 'A.js', content: '1' }, { path: 'a.js', content: '2' }] }).ok === false);
  ok('content must be text', P('github_write', { ...GOOD, files: [{ path: 'a.js', content: 5 }] }).ok === false && P('github_write', { ...GOOD, files: [{ path: 'a.js' }] }).ok === false);
  ok('a file over 400 KB is refused', P('github_write', { ...GOOD, files: [{ path: 'a.js', content: 'x'.repeat(401 * 1024) }] }).ok === false);
  ok('multi-byte text is measured in bytes, not characters', P('github_write', { ...GOOD, files: [{ path: 'a.js', content: '€'.repeat(150 * 1024) }] }).ok === false);
  ok('over 60 files is refused', P('github_write', { ...GOOD, files: Array.from({ length: 61 }, (_, i) => ({ path: 'f' + i, content: 'x' })) }).ok === false);
  ok('over 2 MB in one commit is refused', P('github_write', { ...GOOD, files: Array.from({ length: 6 }, (_, i) => ({ path: 'f' + i, content: 'x'.repeat(390 * 1024) })) }).ok === false);
  ok('no files / not an array is refused', P('github_write', { ...GOOD, files: [] }).ok === false && P('github_write', { ...GOOD, files: 'a' }).ok === false && P('github_write', { ...GOOD, files: null }).ok === false);
  ok('a commit needs a message of sane length', P('github_write', { ...GOOD, message: '' }).ok === false && P('github_write', { ...GOOD, message: 'x'.repeat(301) }).ok === false && P('github_write', { ...GOOD, message: '   ' }).ok === false);
  ok('files with prototype-ish junk are handled', P('github_write', { ...GOOD, files: [null] }).ok === false && P('github_write', { ...GOOD, files: [5] }).ok === false && P('github_write', { ...GOOD, files: [[]] }).ok === false);

  // ===== plan: unknown things =====
  ok('unknown actions refused', P('github_write', { action: 'delete_repo', repo: 'o/r' }).ok === false && P('github_write', { action: 'force_push', repo: 'o/r' }).ok === false && P('github_read', { action: 'write_files', repo: 'o/r' }).ok === false);
  ok('inherited names refused', P('github_write', { action: 'constructor', repo: 'o/r' }).ok === false && P('github_read', { action: '__proto__', repo: 'o/r' }).ok === false && P('github_read', { action: 'toString', repo: 'o/r' }).ok === false);
  ok('missing action / null args refused', P('github_write', {}).ok === false && P('github_write', null).ok === false && P('github_read', undefined).ok === false);
  ok('reads need a valid repo', P('github_read', { action: 'repo_info', repo: 'nope' }).ok === false);
  ok('read_file needs a safe path', P('github_read', { action: 'read_file', repo: 'o/r' }).ok === false && P('github_read', { action: 'read_file', repo: 'o/r', path: '../x' }).ok === false && P('github_read', { action: 'read_file', repo: 'o/r', path: 'a.js' }).ok === true);
  ok('reads validate the ref', P('github_read', { action: 'commits', repo: 'o/r', ref: 'a b' }).ok === false && P('github_read', { action: 'commits', repo: 'o/r', ref: 'main' }).ok === true);

  // ===== previews =====
  const site = [{ path: 'index.html', content: '<h1>hi</h1>' }, { path: 'app.js', content: 'x' }, { path: 'img/a.png', content: 'x' }];
  let pv = P('github_write', { action: 'publish_preview', repo: 'o/r', files: site });
  ok('a preview plans and targets only the preview branch', pv.ok && pv.branch === 'pholama-preview');
  ok('a preview ignores a branch the model passes', P('github_write', { action: 'publish_preview', repo: 'o/r', branch: 'main', files: site }).branch === 'pholama-preview');
  ok('a preview needs index.html at the top', P('github_write', { action: 'publish_preview', repo: 'o/r', files: [{ path: 'app.js', content: 'x' }] }).ok === false && P('github_write', { action: 'publish_preview', repo: 'o/r', files: [{ path: 'sub/index.html', content: 'x' }] }).ok === false);
  for (const bad of ['run.exe', 'a.bat', 'x.cmd', 'x.ps1', 'x.sh', 'x.dll', 'x.msi', 'x.php', 'X.EXE']) ok('a preview refuses ' + bad, P('github_write', { action: 'publish_preview', repo: 'o/r', files: [...site, { path: bad, content: 'x' }] }).ok === false);
  ok('a preview cannot carry workflow files', P('github_write', { action: 'publish_preview', repo: 'o/r', files: [...site, { path: '.github/workflows/x.yml', content: 'x' }] }).ok === false);
  ok('enable_pages targets the preview branch only', P('github_write', { action: 'enable_pages', repo: 'o/r', branch: 'main' }).branch === 'pholama-preview');

  // ===== execute: what is actually sent =====
  let gh = fakeGitHub(), out = await G.execute(P('github_write', GOOD), { token: TOKEN, fetchFn: gh.f });
  ok('write: succeeds', out.ok && /Committed 1 file/.test(out.text));
  ok('write: nothing was ever sent to a ref called main', !gh.log.some(c => /PATCH/.test(c.m) && /heads\/main/.test(c.u)) && !gh.log.some(c => c.body && c.body.ref === 'refs/heads/main'));
  ok('write: the branch was created from main then updated', gh.branches['pholama/add-menu'] && gh.branches['pholama/add-menu'] !== 'sha-main');
  ok('write: every request went to api.github.com with the bearer token', gh.log.every(c => c.host === 'api.github.com' && c.auth === 'Bearer ' + TOKEN));
  ok('write: files are sent as base64 blobs', gh.log.some(c => c.body && c.body.encoding === 'base64' && Buffer.from(c.body.content, 'base64').toString() === 'x'));
  ok('write: the final update is never forced', gh.log.filter(c => c.m === 'PATCH').every(c => c.body.force === false));
  ok('write: the token never appears in the result', !JSON.stringify(out).includes('SECRET'));

  // a file called main.js is fine, a BRANCH called main is not, even via execute directly
  gh = fakeGitHub(); out = await G.execute({ ok: true, kind: 'github_write', action: 'write_files', repo: G.repoRef('o/r'), branch: 'main', message: 'm', files: [{ path: 'a', content: 'x' }] }, { token: TOKEN, fetchFn: gh.f });
  ok('execute itself refuses the default branch even if a plan were forged', out.ok === false && /main branch/.test(out.text) && !gh.log.some(c => c.m !== 'GET'));
  gh = fakeGitHub({ defaultBranch: 'trunk' }); out = await G.execute({ ok: true, kind: 'github_write', action: 'write_files', repo: G.repoRef('o/r'), branch: 'TRUNK', message: 'm', files: [{ path: 'a', content: 'x' }] }, { token: TOKEN, fetchFn: gh.f });
  ok('default-branch check ignores case and uses the repo\'s real default', out.ok === false && !gh.log.some(c => c.m !== 'GET'));
  out = await G.execute({ kind: 'github_write', action: 'write_files' }, { token: TOKEN, fetchFn: gh.f });
  ok('a plan without ok:true never runs', out.ok === false && gh.log.length === 1);
  ok('null/undefined plans never run', (await G.execute(null, {})).ok === false && (await G.execute(undefined, {})).ok === false);

  // existing branch is updated, not recreated
  gh = fakeGitHub(); gh.branches['pholama/add-menu'] = 'sha-existing';
  out = await G.execute(P('github_write', GOOD), { token: TOKEN, fetchFn: gh.f });
  ok('an existing branch is reused, not recreated', out.ok && !gh.log.some(c => c.m === 'POST' && /\/git\/refs$/.test(c.u)));
  ok('the commit parent is the branch\'s current head', gh.log.some(c => c.m === 'POST' && /\/git\/commits$/.test(c.u) && c.body.parents[0] === 'sha-existing'));

  // pull request
  gh = fakeGitHub(); out = await G.execute(P('github_write', { action: 'open_pr', repo: 'o/r', branch: 'pholama/x', title: 'Add menu', body: 'b' }), { token: TOKEN, fetchFn: gh.f });
  ok('open_pr: succeeds and returns the link', out.ok && /pull\/7/.test(out.text));
  ok('open_pr: targets the default branch when no base is given', gh.log.some(c => c.m === 'POST' && /pulls$/.test(c.u) && c.body.base === 'main' && c.body.head === 'pholama/x'));

  // preview
  gh = fakeGitHub(); out = await G.execute(pv, { token: TOKEN, fetchFn: gh.f });
  ok('publish_preview: succeeds', out.ok && /pholama-preview/.test(out.text));
  ok('publish_preview: replaces the tree (no base_tree, so old files do not linger)', gh.log.some(c => c.m === 'POST' && /\/git\/trees$/.test(c.u) && !('base_tree' in c.body)));
  ok('publish_preview: only the preview branch was written', gh.log.filter(c => c.m === 'PATCH').every(c => /pholama-preview/.test(c.u)));
  out = await G.execute(P('github_write', { action: 'enable_pages', repo: 'owner/repo' }), { token: TOKEN, fetchFn: gh.f });
  ok('enable_pages: succeeds and gives the preview address', out.ok && /https:\/\/owner\.github\.io\/repo\//.test(out.text));
  ok('enable_pages: points Pages at the preview branch', gh.log.some(c => /pages$/.test(c.u) && c.body && c.body.source && c.body.source.branch === 'pholama-preview'));
  out = await G.execute(P('github_read', { action: 'pages_status', repo: 'o/r' }), { token: TOKEN, fetchFn: gh.f });
  ok('pages_status reports the address', out.ok && /github\.io/.test(out.text));

  // reads
  gh = fakeGitHub();
  out = await G.execute(P('github_read', { action: 'read_file', repo: 'o/r', path: 'a.js' }), { token: TOKEN, fetchFn: gh.f });
  ok('read_file: returns the text', out.ok && /^hello /.test(out.text));
  ok('read_file: a token inside the file is hidden', !out.text.includes('SECRET') && /\[hidden\]/.test(out.text));
  out = await G.execute(P('github_read', { action: 'repo_info', repo: 'o/r' }), { token: TOKEN, fetchFn: gh.f });
  ok('repo_info: hides a token in the description', out.ok && !out.text.includes('SECRET'));
  out = await G.execute(P('github_read', { action: 'list_files', repo: 'o/r', path: 'dir' }), { token: TOKEN, fetchFn: gh.f });
  ok('list_files works', out.ok && /dir\/a\.js/.test(out.text));
  out = await G.execute(P('github_read', { action: 'commits', repo: 'o/r' }), { token: TOKEN, fetchFn: gh.f });
  ok('commits: first line of each message', out.ok && /abcdef1 first/.test(out.text) && !/second/.test(out.text));
  out = await G.execute(P('github_read', { action: 'list_branches', repo: 'o/r' }), { token: TOKEN, fetchFn: gh.f });
  ok('list_branches works', out.ok && /pholama\/x/.test(out.text));
  ok('reads never send anything but GET', gh.log.every(c => c.m === 'GET'));
  const bigFake = async () => ({ status: 200, json: async () => ({ type: 'file', content: Buffer.from('y'.repeat(100000)).toString('base64') }) });
  out = await G.execute(P('github_read', { action: 'read_file', repo: 'o/r', path: 'big.txt' }), { token: TOKEN, fetchFn: bigFake });
  ok('a long file is cut', out.ok && out.text.length < 62000 && /cut/.test(out.text));
  const dirFake = async () => ({ status: 200, json: async () => ([{ type: 'file', path: 'x' }]) });
  out = await G.execute(P('github_read', { action: 'read_file', repo: 'o/r', path: 'dir' }), { token: TOKEN, fetchFn: dirFake });
  ok('read_file on a folder says so', out.ok === false && /folder/.test(out.text));

  // the token only ever goes to api.github.com, whatever the model typed
  const hosts = []; const spy = async (url, o) => { hosts.push({ url, auth: o.headers.Authorization }); return fakeGitHub().f(url, o); };
  const hostile = ['@evil.com', '//evil.com', 'evil.com/', 'a@evil.com', 'x#@evil.com', 'x?host=evil.com'];
  for (const h of hostile) {
    for (const [k, a2] of [['github_read', { action: 'read_file', repo: 'o/r', path: h }], ['github_read', { action: 'list_files', repo: 'o/r', path: h }], ['github_read', { action: 'commits', repo: 'o/r', ref: h }], ['github_read', { action: 'repo_info', repo: h + '/r' }], ['github_read', { action: 'repo_info', repo: 'o/' + h }], ['github_write', { ...GOOD, branch: 'pholama/' + h }], ['github_write', { ...GOOD, files: [{ path: h, content: 'x' }] }]]) {
      const pl = P(k, a2); if (pl.ok) await G.execute(pl, { token: TOKEN, fetchFn: spy });
    }
  }
  ok('hostile input never makes the token leave api.github.com', hosts.every(x => /^https:\/\/api\.github\.com\/repos\/o\/r/.test(x.url) || /^https:\/\/api\.github\.com\/repos\/owner\/repo/.test(x.url)));
  const all = []; const spy2 = async (url, o) => { all.push(url); return fakeGitHub().f(url, o); };
  for (const [k, a2] of [['github_read', { action: 'repo_info', repo: 'o/r' }], ['github_read', { action: 'read_file', repo: 'o/r', path: 'a.js' }], ['github_read', { action: 'list_branches', repo: 'o/r' }], ['github_read', { action: 'commits', repo: 'o/r' }], ['github_read', { action: 'pages_status', repo: 'o/r' }], ['github_write', GOOD], ['github_write', { action: 'open_pr', repo: 'o/r', branch: 'pholama/x', title: 't' }], ['github_write', { action: 'publish_preview', repo: 'o/r', files: site }], ['github_write', { action: 'enable_pages', repo: 'o/r' }], ['github_write', { action: 'create_branch', repo: 'o/r', branch: 'pholama/n' }]]) await G.execute(P(k, a2), { token: TOKEN, fetchFn: spy2 });
  ok('every request of every action goes to https://api.github.com/', all.length > 20 && all.every(u => u.startsWith('https://api.github.com/')));
  ok('the planner refuses a write action it does not know even when called directly', P('github_write', { action: 'merge_pr', repo: 'o/r' }).ok === false && P('github_write', { action: 'delete_branch', repo: 'o/r' }).ok === false);
  ok('the planner refuses unknown actions before looking at any other field', P('github_write', { action: 'zzz' }).say === 'Unknown write action.');

  // errors: friendly, and never leak the token
  for (const [code, re] of [[401, /did not accept the token/], [403, /not allowed/], [404, /Not found/], [409, /conflict/], [422, /refused/], [500, /error \(500\)/]]) {
    gh = fakeGitHub({ failAt: /^GET \/repos\/owner\/repo$/, code });
    out = await G.execute(P('github_write', GOOD), { token: TOKEN, fetchFn: gh.f });
    ok('error ' + code + ' is explained plainly', out.ok === false && re.test(out.text));
    ok('error ' + code + ' never leaks the token', !out.text.includes('SECRET') && !out.text.includes(TOKEN));
  }
  out = await G.execute(P('github_write', GOOD), { token: TOKEN, fetchFn: async () => { throw new Error('socket ' + TOKEN); } });
  ok('a network error is plain and leak-free', out.ok === false && !out.text.includes('SECRET') && /reach GitHub/.test(out.text));
  out = await G.execute(P('github_write', GOOD), { token: '', fetchFn: fakeGitHub().f });
  { // a token in the environment must NEVER be picked up by itself
    const saved = { a: process.env.GITHUB_TOKEN_5, b: process.env.GITHUB_TOKEN_4, c: process.env.GITHUB_TOKEN };
    process.env.GITHUB_TOKEN_5 = 'github_pat_ENVIRONMENTTOKENENVIRONMENTTOKEN12345'; process.env.GITHUB_TOKEN_4 = 'ghp_ENVIRONMENTTOKENENVIRONMENTTOKEN123456'; process.env.GITHUB_TOKEN = 'ghp_ENVIRONMENTTOKENENVIRONMENTTOKEN654321';
    let hit = 0; const spy = async () => { hit++; return { status: 200, json: async () => ({}), text: async () => '{}' }; };
    const pl = G.plan('github_read', { action: 'repo_info', repo: 'a/b' });
    for (const t of [undefined, '', null, 0, {}, []]) { hit = 0; const r = await G.execute(pl, t === undefined ? { fetchFn: spy } : { token: t, fetchFn: spy }); ok('environment tokens are ignored (token=' + JSON.stringify(t) + '): refused, GitHub never called', r.ok === false && hit === 0 && /No GitHub token/.test(r.text)); }
    ok('no options at all is refused too', (await G.execute(pl)).ok === false);
    let sent = ''; const spy2 = async (u, o) => { sent = JSON.stringify(o && o.headers || {}); return { status: 200, json: async () => ({ full_name: 'a/b', default_branch: 'main' }), text: async () => '{}' }; };
    await G.execute(pl, { token: 'ghp_GIVENBYTHEPERSONGIVENBYTHEPERSON12345', fetchFn: spy2 });
    ok('only the token the person gave is sent', sent.includes('GIVENBYTHEPERSON') && !sent.includes('ENVIRONMENTTOKEN'));
    if (saved.a === undefined) delete process.env.GITHUB_TOKEN_5; else process.env.GITHUB_TOKEN_5 = saved.a;
    if (saved.b === undefined) delete process.env.GITHUB_TOKEN_4; else process.env.GITHUB_TOKEN_4 = saved.b;
    if (saved.c === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved.c;
  }
  ok('no token: says so without calling GitHub', out.ok === false && /No GitHub token/.test(out.text));
  // failure halfway never claims success
  for (const step of [/POST .*\/git\/blobs$/, /POST .*\/git\/trees$/, /POST .*\/git\/commits$/, /PATCH .*\/git\/refs/, /POST .*\/git\/refs$/]) {
    gh = fakeGitHub({ failAt: step }); out = await G.execute(P('github_write', GOOD), { token: TOKEN, fetchFn: gh.f });
    ok('a failure at ' + step + ' is reported, not hidden', out.ok === false && !/Committed/.test(out.text));
  }
  // scrub
  ok('scrub removes the exact token', !G.scrub('a ' + TOKEN + ' b', TOKEN).includes('SECRET'));
  ok('scrub removes token-looking strings it was not told about', !G.scrub('x ghp_' + 'a'.repeat(30) + ' y', 'other').includes('ghp_'));
  ok('scrub survives null/undefined', G.scrub(null, 'x') === '' && G.scrub(undefined, '') === '');

  console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`);
  process.exit(fail ? 1 : 0);
})();
