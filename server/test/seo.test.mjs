// What search engines and link previews get (src/seo, docs/seo.md), without a DB.
// Run: npx tsc && npm test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.ACCESS_TOKEN_SECRET ||= 'test'; process.env.REFRESH_TOKEN_SECRET ||= 'test'; process.env.RESET_TOKEN_SECRET ||= 'test';
process.env.DATABASE_URL ||= 'postgresql://127.0.0.1:1/none'; // never reached here
await import('reflect-metadata');
const express = (await import('express')).default;
const seo = await import('../dist/seo/seoPure.js');
const { default: seoRouter, setJobsSource, pageSeoFor } = await import('../dist/seo/seoRoutes.js');
const { toPublicJob, PUBLIC_SITE_URL } = await import('../dist/public/publicJob.js');

const SITE = { allowIndexing: true, siteUrl: 'https://jobs.skeelz.co.il' };
const OFF = { ...SITE, allowIndexing: false };

// A DAL job with fields that must never reach a page (contacts, comments, uploader).
const dalJob = (over = {}) => ({
  _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', id: 'aaaaaaaaaaaaaaaaaaaaaaaa', title: 'מפתח/ת Fullstack', jobScope: ['FullTime'],
  companyName: 'אקמה', publishDate: new Date('2026-11-01T08:00:00Z'), updatedAt: new Date('2026-11-10T08:00:00Z'),
  citySymbol: 5000, description: '<p>עבודה עם <b>React</b> &amp; Node.</p><p>שורה שנייה</p>', jobId: 1234,
  contactPersonName: 'דנה סודית', contactPersonPhone: '050-1234567', contactPersonEmail: 'dana@secret.test',
  comments: 'הערה פנימית', uploadBy: 'staff@skeelz.test', status: 'Active', deletedAt: null,
  location: { _id: '5000', city: 'תל אביב - יפו', district: 'תל אביב' }, requiredSkills: [], requiredSkillsDetails: {},
  isSponsored: false, isMarked: false, isSelfApply: true,
  applyPolicy: { guestMode: 'self', quickCv: 'required', regularCv: 'optional' }, thresholdCondition: 'רישיון נהיגה',
  ...over,
});
const pub = (over) => toPublicJob(dalJob(over));
const NEVER = ['דנה סודית', '050-1234567', 'dana@secret.test', 'הערה פנימית', 'staff@skeelz.test'];

test('indexable only on the canonical host and only with ALLOW_INDEXING', () => {
  assert.equal(seo.isIndexable(SITE, 'jobs.skeelz.co.il'), true);
  assert.equal(seo.isIndexable(SITE, 'JOBS.skeelz.co.il'), true);
  assert.equal(seo.isIndexable(SITE, 'j.skeelz.co.il'), false);
  assert.equal(seo.isIndexable(SITE, 'skeelz-jobs-example.xhostd.app'), false);
  assert.equal(seo.isIndexable(SITE, ''), false);
  assert.equal(seo.isIndexable(OFF, 'jobs.skeelz.co.il'), false);
});

test('robots.txt: Disallow everything unless indexable; then the sitemap and no staff areas', () => {
  assert.equal(seo.robotsTxt(OFF, false), 'User-agent: *\nDisallow: /\n');
  const on = seo.robotsTxt(SITE, true);
  assert.match(on, /^User-agent: \*\nAllow: \/\n/);
  for (const p of ['/api/', '/mcp', '/jobs-management', '/users-management', '/security-management', '/staff-management', '/settings', '/employer', '/job-Applications-management'])
    assert.ok(on.includes(`Disallow: ${p}\n`), p);
  assert.ok(on.includes('Sitemap: https://jobs.skeelz.co.il/sitemap.xml'));
});

test('page kinds: public pages, jobs (with or without a slug), staff areas, everything else 404', () => {
  assert.deepEqual(seo.pageKindOf('/'), { kind: 'page', path: '/' });
  assert.deepEqual(seo.pageKindOf('/privacy/'), { kind: 'page', path: '/privacy' });
  assert.deepEqual(seo.pageKindOf('/developers'), { kind: 'page', path: '/developers' });
  assert.deepEqual(seo.pageKindOf('/post-job'), { kind: 'page', path: '/post-job' });
  assert.deepEqual(seo.pageKindOf('/job/AAAAAAAAAAAAAAAAAAAAAAAA'), { kind: 'job', id: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.deepEqual(seo.pageKindOf('/job/aaaaaaaaaaaaaaaaaaaaaaaa/מפתח-תל-אביב'), { kind: 'job', id: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
  for (const p of ['/jobs-management', '/jobs-management/submissions', '/users-management', '/security-management', '/staff-management', '/settings', '/employer', '/job-Applications-management'])
    assert.equal(seo.pageKindOf(p).kind, 'private', p);
  for (const p of ['/nope', '/job/123', '/job/zzz', '/sitemap', '/jobs', '/employers', '/privacy/x'])
    assert.equal(seo.pageKindOf(p).kind, 'unknown', p);
});

test('every client route is known to the server (a new route must be added to seoPure.ts)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../client/src/i18n/ClientRoutes.enum.ts', import.meta.url), 'utf-8');
  const paths = [...src.matchAll(/=\s*'([^']+)'/g)].map((m) => m[1].replace(':jobId', 'aaaaaaaaaaaaaaaaaaaaaaaa'));
  assert.ok(paths.length >= 10);
  for (const p of paths) assert.notEqual(seo.pageKindOf(p).kind, 'unknown', p);
});

test('job page: title, description, canonical only when indexable, nothing private', () => {
  const j = pub();
  const on = seo.jobPage(j, SITE, true);
  assert.equal(on.status, 200);
  assert.equal(on.title, 'מפתח/ת Fullstack בתל אביב - יפו | אקמה | SKEELZ');
  assert.equal(on.description, 'עבודה עם React & Node. שורה שנייה');
  assert.equal(on.canonical, 'https://jobs.skeelz.co.il/job/aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(on.robots, 'index, follow');
  const off = seo.jobPage(j, OFF, false);
  assert.equal(off.canonical, null);
  assert.equal(off.robots, 'noindex, follow');
  const html = seo.headHtml(on, 'n0nce') + seo.noscriptHtml(on);
  for (const s of NEVER) assert.ok(!html.includes(s), `leaked ${s}`);
  assert.ok(html.includes('<link rel="canonical" href="https://jobs.skeelz.co.il/job/aaaaaaaaaaaaaaaaaaaaaaaa">'));
  assert.ok(html.includes('<meta property="og:locale" content="he_IL">'));
  assert.ok(!seo.headHtml(off, 'n').includes('canonical') && !seo.headHtml(off, 'n').includes('og:url'));
});

test('JobPosting: required fields, mapped scope, no contacts, threshold condition shown', () => {
  const ld = seo.jobPostingLd(pub(), 'https://jobs.skeelz.co.il/job/aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(ld['@type'], 'JobPosting');
  for (const k of ['title', 'description', 'datePosted', 'hiringOrganization', 'jobLocation']) assert.ok(ld[k], k);
  assert.equal(ld.datePosted, '2026-11-01T08:00:00.000Z');
  assert.deepEqual(ld.hiringOrganization, { '@type': 'Organization', name: 'אקמה' });
  assert.deepEqual(ld.jobLocation.address, { '@type': 'PostalAddress', addressLocality: 'תל אביב - יפו', addressRegion: 'תל אביב', addressCountry: 'IL' });
  assert.equal(ld.employmentType, 'FULL_TIME');
  assert.deepEqual(ld.identifier, { '@type': 'PropertyValue', name: 'SKEELZ', value: '1234' });
  assert.equal(ld.directApply, false); // self-apply
  assert.equal(seo.jobPostingLd(pub({ applyPolicy: { guestMode: 'quick', quickCv: 'required', regularCv: 'optional' } }), null).directApply, true);
  assert.ok(ld.description.includes('תנאי סף'));
  assert.ok(!('validThrough' in ld));
  assert.deepEqual(seo.jobPostingLd(pub({ jobScope: ['FullTime', 'PartialTime'] }), null).employmentType, ['FULL_TIME', 'PART_TIME']);
  const s = JSON.stringify(ld);
  for (const x of NEVER) assert.ok(!s.includes(x), `leaked ${x}`);
  assert.equal(seo.jobPostingLd({ ...pub(), location: null }, null), null);
});

test('JSON-LD and text cannot break out of their element', () => {
  const evil = pub({ title: '</script><script>alert(1)</script>', companyName: '"><img src=x>' });
  const p = seo.jobPage(evil, SITE, true);
  const head = seo.headHtml(p, 'n');
  assert.ok(!head.includes('</script><script>'));
  assert.ok(!head.includes('"><img'));
  assert.ok(!seo.noscriptHtml(seo.boardPage([evil], SITE, true)).includes('<img src=x>'));
});

test('board, gone and not-found pages', () => {
  const b = seo.boardPage([pub()], SITE, true);
  assert.equal(b.status, 200);
  assert.ok(b.bodyHtml.includes('<a href="/job/aaaaaaaaaaaaaaaaaaaaaaaa">'));
  assert.ok(b.jsonLd.some((x) => x['@type'] === 'WebSite'));
  assert.equal(seo.boardPage([], OFF, false).jsonLd.length, 0);
  const g = seo.gonePage([pub()]);
  assert.equal(g.status, 410);
  assert.equal(g.robots, 'noindex, follow');
  assert.ok(g.bodyHtml.includes('/job/aaaaaaaaaaaaaaaaaaaaaaaa'));
  assert.equal(seo.notFoundPage().status, 404);
  assert.equal(seo.privatePage().robots, 'noindex, nofollow');
});

test('plainText: tags out, entities decoded, cut at a word', () => {
  assert.equal(seo.plainText('<p>a&nbsp;b</p><br>c &lt;d&gt;'), 'a b c <d>');
  const long = seo.plainText('מילה '.repeat(100), 30);
  assert.ok(long.length <= 30 && long.endsWith('…'));
});

test('sitemap: the public pages and the given jobs, with dates', () => {
  const xml = seo.sitemapXml(SITE, [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', lastmod: '2026-11-10T08:00:00.000Z' }]);
  assert.ok(xml.startsWith('<?xml'));
  assert.ok(xml.includes('<loc>https://jobs.skeelz.co.il/</loc><lastmod>2026-11-10</lastmod>'));
  assert.ok(xml.includes('<loc>https://jobs.skeelz.co.il/job/aaaaaaaaaaaaaaaaaaaaaaaa</loc><lastmod>2026-11-10</lastmod>'));
  assert.ok(xml.includes('<loc>https://jobs.skeelz.co.il/privacy</loc>'));
  assert.ok(!xml.includes('jobs-management'));
});

// ---- the router over HTTP (robots.txt, sitemap.xml, redirect), and pageSeoFor without a DB

const app = express();
app.use(seoRouter);
app.get('*', (_req, res) => res.send('page'));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const port = server.address().port;
const get = (path, host) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on('error', reject);
});
const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const canonicalHost = new URL(PUBLIC_SITE_URL).host;
setJobsSource(async () => [dalJob(), dalJob({ _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', status: 'Closed' })]);

test('robots.txt and sitemap.xml over HTTP follow ALLOW_INDEXING and the host', async () => {
  await withEnv({ ALLOW_INDEXING: 'false' }, async () => {
    assert.equal((await get('/robots.txt', canonicalHost)).body, 'User-agent: *\nDisallow: /\n');
    assert.equal((await get('/sitemap.xml', canonicalHost)).status, 404);
  });
  await withEnv({ ALLOW_INDEXING: 'true' }, async () => {
    assert.match((await get('/robots.txt', canonicalHost)).body, /Sitemap: /);
    assert.equal((await get('/robots.txt', 'skeelz-jobs-example.xhostd.app')).body, 'User-agent: *\nDisallow: /\n');
    const sm = await get('/sitemap.xml', canonicalHost);
    assert.equal(sm.status, 200);
    assert.match(sm.headers['content-type'], /xml/);
    assert.ok(sm.body.includes('/job/aaaaaaaaaaaaaaaaaaaaaaaa'));
    assert.ok(!sm.body.includes('bbbbbbbbbbbbbbbbbbbbbbbb'), 'closed job in the sitemap');
    assert.equal((await get('/sitemap.xml', 'j.skeelz.co.il')).status, 404);
  });
});

test('move to the canonical host: off by default, pages only', async () => {
  await withEnv({ ALLOW_INDEXING: 'true', REDIRECT_TO_CANONICAL: undefined }, async () => {
    delete process.env.REDIRECT_TO_CANONICAL;
    assert.equal((await get('/job/aaaaaaaaaaaaaaaaaaaaaaaa', 'j.skeelz.co.il')).status, 200);
  });
  await withEnv({ ALLOW_INDEXING: 'false', REDIRECT_TO_CANONICAL: 'true' }, async () => {
    assert.equal((await get('/', 'j.skeelz.co.il')).status, 200, 'no move while indexing is off');
  });
  await withEnv({ ALLOW_INDEXING: 'true', REDIRECT_TO_CANONICAL: 'true' }, async () => {
    const r = await get('/job/aaaaaaaaaaaaaaaaaaaaaaaa?utm_source=x', 'j.skeelz.co.il');
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, `${PUBLIC_SITE_URL}/job/aaaaaaaaaaaaaaaaaaaaaaaa?utm_source=x`);
    for (const p of ['/api/jobs/active', '/api/auth/xhostd/callback?state=1', '/mcp', '/assets/x.js'])
      assert.equal((await get(p, 'j.skeelz.co.il')).status, 200, p);
    assert.equal((await get('/', canonicalHost)).status, 200);
  });
});

test('pageSeoFor: listed job, unknown path, staff area (no DB needed)', async () => {
  const req = (path, host = canonicalHost) => ({ path, headers: { host } });
  const list = [dalJob()];
  assert.equal((await pageSeoFor(req('/job/aaaaaaaaaaaaaaaaaaaaaaaa'), list)).status, 200);
  assert.equal((await pageSeoFor(req('/nope'), list)).status, 404);
  assert.equal((await pageSeoFor(req('/jobs-management'), list)).status, 200);
  assert.equal((await pageSeoFor(req('/jobs-management'), list)).robots, 'noindex, nofollow');
  assert.equal((await pageSeoFor(req('/'), list)).status, 200);
});
