/**
 * robots.txt, sitemap.xml, the optional move to the canonical host, and the per-page SEO of the SPA pages
 * (index.ts calls pageSeoFor for every page it serves). Rules and wording: seoPure.ts, docs/seo.md.
 * Public, read-only, public job data only (toPublicJob).
 */
import { Router, Request } from 'express';
import * as jobDAL from '../dal/jobDAL.js';
import { Job } from '../models/schemas/jobs.js';
import { JobStatus } from '../models/enums.js';
import { PUBLIC_SITE_URL, publicJobs, toPublicJob } from '../public/publicJob.js';
import {
  SeoEnv, PageSeo, isIndexable, pageKindOf, boardPage, staticPage, jobPage, gonePage, notFoundPage, privatePage,
  robotsTxt, sitemapXml, isRedirectablePath, hostOf, requestHost,
} from './seoPure.js';

export const seoEnv = (): SeoEnv => ({ allowIndexing: process.env.ALLOW_INDEXING === 'true', siteUrl: PUBLIC_SITE_URL });

/** The public job list (index.ts hands over its short cache; the same list the board shows). */
let jobsSource: () => Promise<Job[]> = async () => [];
export const setJobsSource = (fn: () => Promise<Job[]>) => { jobsSource = fn; };

const lastChange = (j: Job) => {
  const t = [j.updatedAt, j.publishDate, j.bumpedAt].map((d) => (d ? new Date(d).getTime() : NaN)).filter(Number.isFinite);
  return t.length ? new Date(Math.max(...t)).toISOString() : null;
};

/** Closed or archived: it was public once, so 410 (gone). Paused, scheduled or never existed: 404. */
const wasPublicOnce = (job: Job) => job.status === JobStatus.CLOSED || !!job.deletedAt;

export const pageSeoFor = async (req: Request, jobList: Job[]): Promise<PageSeo> => {
  const env = seoEnv();
  const indexable = isIndexable(env, req.headers.host);
  const kind = pageKindOf(req.path);
  if (kind.kind === 'private') return privatePage();
  if (kind.kind === 'unknown') return notFoundPage();
  if (kind.kind === 'page') return kind.path === '/' ? boardPage(publicJobs(jobList), env, indexable) : staticPage(kind.path, env, indexable);

  const listed = jobList.find((j) => String(j._id) === kind.id);
  const pub = toPublicJob(listed);
  if (pub) return jobPage(pub, env, indexable);
  // Not in the (short-cached) list: look it up once. Only the public shape is ever used from it.
  const job = await jobDAL.findJobByJobId(kind.id).catch(() => null);
  const fresh = toPublicJob(job);
  if (fresh) return jobPage(fresh, env, indexable);
  if (job && wasPublicOnce(job)) return gonePage(publicJobs(jobList));
  return notFoundPage();
};

const router = Router();

// Optional (off unless REDIRECT_TO_CANONICAL=true, and only with indexing on): pages on any other host of this
// app (j.skeelz.co.il, the xhostd.app address) move to the same path on PUBLIC_SITE_URL. Pages only: the API,
// the sign-in callbacks (/api/auth/...), MCP and files keep working on every host.
router.use((req, res, next) => {
  const env = seoEnv();
  if (process.env.REDIRECT_TO_CANONICAL !== 'true' || !env.allowIndexing) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const target = hostOf(env.siteUrl);
  if (!target || requestHost(req.headers.host) === target || !isRedirectablePath(req.path)) return next();
  return res.redirect(301, `${env.siteUrl}${req.originalUrl}`);
});

router.get('/robots.txt', (req, res) => {
  const env = seoEnv();
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.type('text/plain').send(robotsTxt(env, isIndexable(env, req.headers.host)));
});

// Only where the site may be indexed; anywhere else there is nothing to submit (404).
router.get('/sitemap.xml', async (req, res, next) => {
  try {
    const env = seoEnv();
    if (!isIndexable(env, req.headers.host)) {
      res.setHeader('X-Robots-Tag', 'noindex');
      return res.status(404).type('text/plain').send('Not found');
    }
    const jobs = (await jobsSource()).filter((j) => toPublicJob(j) !== null);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.type('application/xml').send(sitemapXml(env, jobs.map((j) => ({ id: String(j._id), lastmod: lastChange(j) }))));
  } catch (e) { next(e); }
});

export default router;
