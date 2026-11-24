/**
 * What search engines and link previews get from the server (docs/seo.md). Pure: no DB, no clock except the
 * `now` passed in, no request object. Tested in test/seo.test.mjs.
 *
 * The client is a SPA (no server-side React): the server writes, per page, the <head> (title, description,
 * robots, canonical, Open Graph, JSON-LD) and a plain-HTML copy of the content inside <noscript> (for crawlers
 * and previews that do not run JS; people never see it), and answers with the right status (404 / 410).
 *
 * Job data comes ONLY from the public shape (public/publicJob.ts → toPublicJob): the same allowlist as the
 * public API. The employer's contact details are not written here, not even on self-apply jobs.
 *
 * Indexing: only when ALLOW_INDEXING=true AND the request is for the host of PUBLIC_SITE_URL. Everything
 * else (j.skeelz.co.il before the cutover, the xhostd.app address, the sandbox) says noindex, and its
 * robots.txt says Disallow. canonical / og:url are written only when indexable, so no page points at an
 * address that is not this site yet.
 */
import type { PublicJob } from '../public/publicJob.js';

export const SITE_NAME = 'SKEELZ';

export interface SeoEnv {
  /** process.env.ALLOW_INDEXING === 'true' */
  allowIndexing: boolean;
  /** The one public address, e.g. https://jobs.skeelz.co.il (no trailing slash). */
  siteUrl: string;
}

export const hostOf = (url: string | undefined | null): string => {
  try { return url ? new URL(url).host.toLowerCase() : ''; } catch { return ''; }
};

/** Host header without the port, lower case ("" when missing). */
export const requestHost = (host: string | undefined | null): string => String(host ?? '').trim().toLowerCase();

/** May search engines index this request? Only the canonical host, and only when the owner turned it on. */
export const isIndexable = (env: SeoEnv, reqHost: string | undefined | null) =>
  env.allowIndexing && !!hostOf(env.siteUrl) && requestHost(reqHost) === hostOf(env.siteUrl);

// ---------------------------------------------------------------- text

export const escapeHtml = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** HTML → one line of plain text, cut at a word boundary to at most `max` characters (with "…"). */
export const plainText = (html: unknown, max = 160): string => {
  const text = String(html ?? '')
    .replace(/<(br|\/p|\/li|\/h\d|\/div)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (ENTITIES[k] !== undefined) return ENTITIES[k];
      if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16) || 32);
      if (k.startsWith('#')) return String.fromCodePoint(Number(k.slice(1)) || 32);
      return m;
    })
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
};

/** JSON that is safe inside a <script> element (no "</script>" breakout). */
export const safeJson = (v: unknown) =>
  JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

// ---------------------------------------------------------------- pages

/** Client routes (client/src/i18n/ClientRoutes.enum.ts). Staff and personal areas are never indexed. */
const PUBLIC_PAGES: Record<string, { title: string; description: string }> = {
  '/': {
    title: `לוח משרות | ${SITE_NAME}`,
    description: 'משרות פתוחות ב-SKEELZ. אפשר לחפש לפי אזור, כישורים והיקף משרה, ולהגיש מועמדות באתר.',
  },
  '/privacy': {
    title: `מדיניות פרטיות | ${SITE_NAME}`,
    description: 'איזה מידע לוח המשרות של SKEELZ אוסף, למה, מי מקבל אותו, ואיך הוא נשמר.',
  },
  '/developers': {
    title: `API ו-MCP למשרות | ${SITE_NAME}`,
    description: 'ממשק ציבורי לקריאה בלבד ושרת MCP למשרות הפתוחות בלוח המשרות של SKEELZ.',
  },
  '/post-job': {
    title: `פרסום משרה | ${SITE_NAME}`,
    description: 'מעסיקים: שליחת משרה ללוח המשרות של SKEELZ. המשרה עולה ללוח אחרי בדיקה של הצוות.',
  },
};

/** Areas behind a sign-in (the client guards them; the server gates every API they call). */
const PRIVATE_PREFIXES = ['/jobs-management', '/users-management', '/security-management', '/staff-management', '/settings',
  '/employer', '/job-applications-management', '/mail-management', '/unsubscribe',
  // Several roles per account (23.11.2026): a signed-in account adds the candidate / employer role to itself.
  '/join'];

export type PageKind =
  | { kind: 'page'; path: string }
  | { kind: 'job'; id: string }
  | { kind: 'private' }
  | { kind: 'unknown' };

const JOB_PATH = /^\/job\/([0-9a-f]{24})(?:\/[^/]*)?\/?$/i;

/** Which kind of page a path is. Anything the client does not have is 'unknown' (404). */
export const pageKindOf = (rawPath: string): PageKind => {
  const p = (rawPath || '/').replace(/\/{2,}/g, '/');
  const path = p.length > 1 ? p.replace(/\/+$/, '') : p;
  const m = path.match(JOB_PATH);
  if (m) return { kind: 'job', id: m[1].toLowerCase() };
  if (PUBLIC_PAGES[path]) return { kind: 'page', path };
  const lower = path.toLowerCase();
  if (PRIVATE_PREFIXES.some((x) => lower === x || lower.startsWith(`${x}/`))) return { kind: 'private' };
  return { kind: 'unknown' };
};

export interface PageSeo {
  status: 200 | 404 | 410;
  title: string;
  description: string;
  /** Written as <meta name="robots"> and the X-Robots-Tag header. */
  robots: 'index, follow' | 'noindex, follow' | 'noindex, nofollow';
  /** Absolute; only when indexable. */
  canonical: string | null;
  ogType: 'website' | 'article';
  jsonLd: object[];
  /** Plain HTML for the <noscript> copy. */
  bodyHtml: string;
}

const jobUrl = (siteUrl: string, id: string) => `${siteUrl}/job/${id}`;
const joinNonEmpty = (parts: (string | null | undefined)[], sep: string) => parts.map((x) => (x ?? '').trim()).filter(Boolean).join(sep);

const SCOPE_LABEL: Record<string, string> = { FullTime: 'משרה מלאה', PartialTime: 'משרה חלקית' };
const SCOPE_SCHEMA: Record<string, string> = { FullTime: 'FULL_TIME', PartialTime: 'PART_TIME' };

export const jobTitle = (j: PublicJob) => {
  const city = j.location?.city?.trim();
  return `${joinNonEmpty([city ? `${j.title.trim()} ב${city}` : j.title, j.companyName], ' | ')} | ${SITE_NAME}`;
};

/** The visible description plus the threshold condition, as the job page shows them. */
const jobDescriptionHtml = (j: PublicJob) =>
  j.thresholdCondition ? `${j.description}<p><strong>תנאי סף:</strong> ${escapeHtml(j.thresholdCondition)}</p>` : j.description;

/**
 * schema.org JobPosting (Google: https://developers.google.com/search/docs/appearance/structured-data/job-posting).
 * Required: title, description, datePosted, hiringOrganization, jobLocation. No location or no publish date →
 * no JobPosting at all (a half posting is an error in Search Console). No validThrough: jobs have no closing
 * date; a closed job answers 410 and leaves the sitemap instead. No contact details.
 */
export const jobPostingLd = (j: PublicJob, canonical: string | null): object | null => {
  if (!j.location?.city || !j.publishDate || !j.title.trim() || !j.description.trim()) return null;
  const types = j.jobScope.map((s) => SCOPE_SCHEMA[s]).filter(Boolean);
  return {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: j.title.trim(),
    description: jobDescriptionHtml(j),
    datePosted: j.publishDate,
    hiringOrganization: { '@type': 'Organization', name: j.companyName.trim() || SITE_NAME },
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        addressLocality: j.location.city,
        ...(j.location.district ? { addressRegion: j.location.district } : {}),
        addressCountry: 'IL',
      },
    },
    ...(types.length ? { employmentType: types.length === 1 ? types[0] : types } : {}),
    identifier: { '@type': 'PropertyValue', name: SITE_NAME, value: String(j.jobNumber) },
    // Apply on the page itself without an account (the "quick" form). Self-apply / sign-in first: not direct.
    directApply: j.applyMode === 'quick',
    ...(canonical ? { url: canonical } : {}),
  };
};

const siteLd = (siteUrl: string): object[] => [
  { '@context': 'https://schema.org', '@type': 'Organization', name: SITE_NAME, url: 'https://www.skeelz.co.il',
    logo: `${siteUrl}/images/logo.svg` },
  { '@context': 'https://schema.org', '@type': 'WebSite', name: `לוח המשרות של ${SITE_NAME}`, url: `${siteUrl}/`, inLanguage: 'he' },
];

const jobLine = (j: PublicJob) =>
  `<li><a href="/job/${escapeHtml(j.id)}">${escapeHtml(j.title)}</a>${
    joinNonEmpty([j.companyName, j.location?.city], ', ') ? ` · ${escapeHtml(joinNonEmpty([j.companyName, j.location?.city], ', '))}` : ''}</li>`;

const jobListHtml = (jobs: PublicJob[]) => (jobs.length ? `<ul>${jobs.map(jobLine).join('')}</ul>` : '<p>אין כרגע משרות פתוחות.</p>');

const backHome = '<p><a href="/">לכל המשרות הפתוחות</a></p>';

export const boardPage = (jobs: PublicJob[], env: SeoEnv, indexable: boolean): PageSeo => ({
  status: 200,
  ...PUBLIC_PAGES['/'],
  robots: indexable ? 'index, follow' : 'noindex, follow',
  canonical: indexable ? `${env.siteUrl}/` : null,
  ogType: 'website',
  jsonLd: indexable ? siteLd(env.siteUrl) : [],
  bodyHtml: `<h1>לוח המשרות של ${SITE_NAME}</h1>${jobListHtml(jobs)}`,
});

export const staticPage = (path: string, env: SeoEnv, indexable: boolean): PageSeo => ({
  status: 200,
  ...PUBLIC_PAGES[path],
  robots: indexable ? 'index, follow' : 'noindex, follow',
  canonical: indexable ? `${env.siteUrl}${path}` : null,
  ogType: 'website',
  jsonLd: [],
  bodyHtml: `<h1>${escapeHtml(PUBLIC_PAGES[path].title.split(' | ')[0])}</h1><p>${escapeHtml(PUBLIC_PAGES[path].description)}</p>${backHome}`,
});

export const jobPage = (j: PublicJob, env: SeoEnv, indexable: boolean): PageSeo => {
  const canonical = indexable ? jobUrl(env.siteUrl, j.id) : null;
  const ld = jobPostingLd(j, canonical);
  const facts = joinNonEmpty([j.companyName, j.location?.city, j.jobScope.map((s) => SCOPE_LABEL[s]).filter(Boolean).join(', ')], ' · ');
  return {
    status: 200,
    title: jobTitle(j),
    description: plainText(j.description, 160) || PUBLIC_PAGES['/'].description,
    robots: indexable ? 'index, follow' : 'noindex, follow',
    canonical,
    ogType: 'article',
    jsonLd: ld ? [ld] : [],
    bodyHtml: `<article><h1>${escapeHtml(j.title)}</h1>${facts ? `<p>${escapeHtml(facts)}</p>` : ''}${jobDescriptionHtml(j)}</article>${backHome}`,
  };
};

/** A job that was public and is not any more (closed or archived): 410, with the open jobs to move on to. */
export const gonePage = (others: PublicJob[]): PageSeo => ({
  status: 410,
  title: `המשרה כבר לא פעילה | ${SITE_NAME}`,
  description: 'המשרה הזו כבר לא פעילה. אפשר לראות את המשרות הפתוחות בלוח.',
  robots: 'noindex, follow',
  canonical: null,
  ogType: 'website',
  jsonLd: [],
  bodyHtml: `<h1>המשרה הזו כבר לא פעילה</h1><p>אלה המשרות הפתוחות עכשיו:</p>${jobListHtml(others.slice(0, 20))}${backHome}`,
});

export const notFoundPage = (): PageSeo => ({
  status: 404,
  title: `הדף לא נמצא | ${SITE_NAME}`,
  description: 'הדף לא נמצא.',
  robots: 'noindex, follow',
  canonical: null,
  ogType: 'website',
  jsonLd: [],
  bodyHtml: `<h1>הדף לא נמצא</h1>${backHome}`,
});

/** Sign-in areas: the app loads as before (200), never indexed. */
export const privatePage = (): PageSeo => ({
  status: 200,
  title: SITE_NAME,
  description: '',
  robots: 'noindex, nofollow',
  canonical: null,
  ogType: 'website',
  jsonLd: [],
  bodyHtml: '',
});

/** The <head> part: replaces the template's <title> and goes where <!--app-head--> is. */
export const headHtml = (p: PageSeo, nonce: string): string => {
  const tags = [
    p.description ? `<meta name="description" content="${escapeHtml(p.description)}">` : '',
    `<meta name="robots" content="${p.robots}">`,
    p.canonical ? `<link rel="canonical" href="${escapeHtml(p.canonical)}">` : '',
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    '<meta property="og:locale" content="he_IL">',
    `<meta property="og:type" content="${p.ogType}">`,
    `<meta property="og:title" content="${escapeHtml(p.title)}">`,
    p.description ? `<meta property="og:description" content="${escapeHtml(p.description)}">` : '',
    p.canonical ? `<meta property="og:url" content="${escapeHtml(p.canonical)}">` : '',
    '<meta name="twitter:card" content="summary">',
    ...p.jsonLd.map((ld) => `<script type="application/ld+json" nonce="${escapeHtml(nonce)}">${safeJson(ld)}</script>`),
  ];
  return tags.filter(Boolean).join('\n    ');
};

/** The template's <title> → this page's title. */
export const withTitle = (template: string, title: string) =>
  template.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);

/** The <noscript> copy that goes inside #root next to the loading indicator (React replaces both). */
export const noscriptHtml = (p: PageSeo) =>
  p.bodyHtml ? `<noscript><div dir="rtl" lang="he" style="max-width:60rem;margin:0 auto;padding:1rem">${p.bodyHtml}</div></noscript>` : '';

// ---------------------------------------------------------------- robots.txt, sitemap.xml

/** Never crawled even when indexing is on: sign-in areas, the API (the public API has its own docs page). */
const DISALLOW = ['/api/', '/mcp', ...PRIVATE_PREFIXES.filter((p) => p !== '/job-applications-management'), '/job-Applications-management'];

export const robotsTxt = (env: SeoEnv, indexable: boolean): string =>
  indexable
    ? ['User-agent: *', 'Allow: /', ...DISALLOW.map((d) => `Disallow: ${d}`), 'Allow: /api/public/v1/$', '', `Sitemap: ${env.siteUrl}/sitemap.xml`, ''].join('\n')
    : 'User-agent: *\nDisallow: /\n';

export interface SitemapJob { id: string; lastmod: string | null }

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const day = (iso: string | null) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 10) : null);

/** The board, the public pages and every public job (lastmod = the job's last change). */
export const sitemapXml = (env: SeoEnv, jobs: SitemapJob[]): string => {
  const url = (loc: string, lastmod: string | null) =>
    `  <url><loc>${xmlEscape(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
  const newest = jobs.map((j) => day(j.lastmod)).filter(Boolean).sort().pop() ?? null;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    url(`${env.siteUrl}/`, newest),
    ...Object.keys(PUBLIC_PAGES).filter((p) => p !== '/').map((p) => url(`${env.siteUrl}${p}`, null)),
    ...jobs.map((j) => url(jobUrl(env.siteUrl, j.id), day(j.lastmod))),
    '</urlset>',
    '',
  ].join('\n');
};

/** Pages only (not the API, sign-in callbacks, MCP or files): where the optional move to the canonical host applies. */
export const isRedirectablePath = (path: string) =>
  !/^\/(api|mcp|assets|\.well-known)(\/|$)/i.test(path) && path !== '/robots.txt' && path !== '/sitemap.xml';
