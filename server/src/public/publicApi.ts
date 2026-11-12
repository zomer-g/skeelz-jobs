/**
 * Public, unauthenticated, read-only REST API: /api/public/v1/...
 *
 * Mounted in index.ts BEFORE the site's /api middleware (credentialed CORS,
 * cross-site refusal, cookie parser, JSON body parser). This router ends every
 * request under its prefix itself (405 / 404 / data), so none of those — and no
 * auth — ever runs for it, and it never sees cookies or a request body.
 * See docs/security.md "Public API and MCP server".
 */
import express, { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { PUBLIC_LIMITS, PublicInputError, parseJobRef, parseJobSearch } from './publicParams.js';
import * as publicService from './publicService.js';
import { openApiSpec } from './openapi.js';
import { docsPage } from './docsPage.js';
import { safeErrorText } from '../security/pure.js';

export const PUBLIC_API_PREFIX = '/api/public/v1';
const ALLOWED_METHODS = 'GET, HEAD, OPTIONS';

const router = express.Router();

// Open CORS for reads only: no credentials, nothing to send but simple headers.
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', 'Accept, If-None-Match');
  res.setHeader('Access-Control-Expose-Headers', 'ETag, RateLimit, RateLimit-Policy, Retry-After');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

// GET only. OPTIONS answers the CORS preflight; HEAD is GET without a body.
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  res.setHeader('Allow', ALLOWED_METHODS);
  if (req.method === 'OPTIONS') return res.status(204).end();
  return res.status(405).json({ message: 'Method not allowed: this API is read-only (GET)', code: 'pub405' });
});

router.use(rateLimit({
  windowMs: 60 * 1000,
  limit: PUBLIC_LIMITS.restPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many requests', code: 'pub429' },
}));

const cache = (seconds: number) => (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', `public, max-age=${seconds}`);
  next();
};

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

// Express adds a weak ETag to every JSON body and answers If-None-Match with 304.
router.get('/', cache(300), (_req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  res.type('html').send(docsPage());
});

router.get('/openapi.json', cache(300), (_req, res) => { res.json(openApiSpec()); });

router.get('/jobs', cache(60), h(async (req, res) => {
  res.json(await publicService.searchJobs(parseJobSearch(req.query as Record<string, unknown>)));
}));

router.get('/jobs/near', cache(60), h(async (req, res) => {
  const input = parseJobSearch(req.query as Record<string, unknown>, { nearRequired: true });
  res.json(await publicService.jobsNear(input as typeof input & { near: NonNullable<typeof input.near> }));
}));

router.get('/jobs/:id', cache(60), h(async (req, res) => {
  const job = await publicService.getJob(parseJobRef(req.params.id));
  if (!job) return res.status(404).json({ message: 'Job not found', code: 'pub404' });
  res.json({ data: job });
}));

router.get('/locations', cache(300), h(async (_req, res) => { res.json({ data: await publicService.listLocations() }); }));

router.get('/skills', cache(300), h(async (_req, res) => { res.json({ data: await publicService.listSkills() }); }));

router.use((_req, res) => { res.status(404).json({ message: 'Not found', code: 'pub404' }); });

// eslint-disable-next-line @typescript-eslint/no-unused-vars
router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  if (err instanceof PublicInputError) return res.status(400).json({ message: err.message, code: 'pub400' });
  console.error('[public-api] failed', safeErrorText(err));
  res.status(500).json({ message: 'Server error', code: 'pub500' });
});

export default router;
