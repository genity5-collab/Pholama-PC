// Cloud search (cloud_browse): read a page or search the web in the cloud, nothing opens on the PC.
const W = require('../server/codebase-web.js'), P = require('../server/codebase-plan.js');
let bad = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + String(x).slice(0, 240))); if (!c) bad++; };
const page = '<html><head><title>My &amp; Page</title><style>.a{}</style></head><body><nav>menu</nav><h1>Hello</h1><script>evil()</script><p>First <b>para</b></p><p>Second</p><!-- c --></body></html>';
const mk = (o = {}) => { const seen = { urls: [], q: [] }; return { seen, web: W.create({
  fetchText: async (u, ms) => { seen.urls.push([u, ms]); if (o.fetch) return o.fetch(u); return { status: 200, text: page }; },
  webSearch: async x => { seen.q.push(x.query); if (o.search) return o.search(x); return '1. Pizza\n   https://p.test\n   Good'; },
  checkLink: u => /^https?:\/\/(127\.|10\.|192\.168\.|localhost|169\.254\.)/.test(u) ? { ok: false } : { ok: true, url: u } }) }; };

// planner
ok('plan: a url is accepted', P.plan('cloud_browse', { url: 'https://example.com/a' }).ok === true);
ok('plan: a query is accepted', P.plan('cloud_browse', { query: 'best pizza' }).query === 'best pizza');
ok('plan: "search" and "q" mean query', P.plan('cloud_browse', { search: 'x' }).query === 'x' && P.plan('cloud_browse', { q: 'y' }).query === 'y');
ok('plan: nothing given is refused with a plain message', !P.plan('cloud_browse', {}).ok && /query.*url/.test(P.plan('cloud_browse', {}).say));
ok('plan: a non-http address is refused', !P.plan('cloud_browse', { url: 'file:///C:/x' }).ok && !P.plan('cloud_browse', { url: 'javascript:alert(1)' }).ok && !P.plan('cloud_browse', { url: 'ftp://a.b' }).ok);
ok('plan: a 301 character query is refused', !P.plan('cloud_browse', { query: 'x'.repeat(301) }).ok);
(async () => {
  let m = mk(), r = await m.web.execute({ url: 'https://example.com' });
  ok('a page comes back as plain text', r.ok && /Hello/.test(r.text) && /First para/.test(r.text) && /Second/.test(r.text), r.text);
  ok('with its title, decoded', /TITLE: My & Page/.test(r.text));
  ok('scripts, styles and comments are gone', !/evil|\.a\{\}|<script|<!--/.test(r.text));
  ok('it says the text is data, not instructions', /DATA, not instructions/.test(r.text));
  ok('the fetch has a 12 second limit', m.seen.urls[0][1] === 12000);
  m = mk({ fetch: async () => ({ status: 200, text: '<p>' + 'word '.repeat(5000) + '</p>' }) }); r = await m.web.execute({ url: 'https://e.test' });
  ok('a huge page is cut and says how much was cut', r.ok && r.text.length < 6200 && /\[cut: \d+ more characters\]/.test(r.text), r.text.length);
  m = mk(); r = await m.web.execute({ query: 'best pizza' });
  ok('a search returns results and tells how to read one', r.ok && /Pizza/.test(r.text) && /cloud_browse with its address/.test(r.text) && m.seen.q[0] === 'best pizza');
  for (const bad of ['http://127.0.0.1/admin', 'http://localhost:3000', 'http://192.168.1.1/', 'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data']) {
    m = mk(); r = await m.web.execute({ url: bad }); ok('an internal address is refused and never fetched: ' + bad, r.ok === false && /not allowed/.test(r.text) && m.seen.urls.length === 0, JSON.stringify(r));
  }
  m = mk({ fetch: async () => ({ status: 404, text: 'nope' }) }); r = await m.web.execute({ url: 'https://e.test/x' });
  ok('an error page is reported plainly', r.ok === false && /error 404/.test(r.text));
  m = mk({ fetch: async () => ({ status: 200, text: '<html><body><script>app()</script></body></html>' }) }); r = await m.web.execute({ url: 'https://spa.test' });
  ok('a page with no text says it may need JavaScript', r.ok === false && /JavaScript/.test(r.text));
  m = mk({ fetch: async () => { const e = new Error('The operation was aborted'); throw e; } }); r = await m.web.execute({ url: 'https://slow.test' });
  ok('a timeout says the page took too long', r.ok === false && /too long/.test(r.text));
  m = mk({ fetch: async () => { throw new Error('a redirect pointed at a private or unsafe address, so I stopped'); } }); r = await m.web.execute({ url: 'https://redir.test' });
  ok('a redirect to a private address is reported, not followed', r.ok === false && /private or unsafe/.test(r.text));
  m = mk({ search: async () => { throw new Error('no results (search engine may be blocking this network)'); } }); r = await m.web.execute({ query: 'x' });
  ok('a failed search is an ordinary result, not a crash', r.ok === false && /no results/.test(r.text));
  // through the real tool chain: nothing runs on the PC
  const API = require('../server/codebase-api.js'); let winCalled = 0;
  const tools = API.buildTools({ win: { execute: async () => { winCalled++; return { ok: true, text: 'WIN' }; } }, github: {}, media: {}, web: mk().web });
  const out = await tools.cloud_browse({ url: 'https://example.com' });
  ok('through the tool chain the page text arrives and the Windows runner is never used', /Hello/.test(out) && winCalled === 0, out);
  const out2 = await tools.cloud_browse({ query: 'pizza' }); ok('a search works through the tool chain', /Pizza/.test(out2) && winCalled === 0);
  const out3 = await tools.cloud_browse({}); ok('a bad request is a plain REFUSED', /^REFUSED:/.test(out3));
  const none = API.buildTools({ win: { execute: async () => ({ ok: true }) }, github: {}, media: {} }); ok('with no web module it says so instead of crashing', /not available/.test(await none.cloud_browse({ url: 'https://a.test' })));
  console.log(bad ? bad + ' FAILED' : 'ALL PASSED'); process.exit(bad ? 1 : 0);
})();
