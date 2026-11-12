/**
 * Public MCP server (Streamable HTTP, stateless, no auth) at /mcp.
 *
 * Five read-only tools over the same service layer as /api/public/v1. No
 * resources, no prompts, nothing that writes. A fresh server + transport per
 * request (stateless mode): no sessions to steal or exhaust.
 *
 * Mounted in index.ts before the site's /api middleware and the SPA catch-all.
 * Order inside: CORS (so browser clients like MCP Inspector can connect) ->
 * method guard -> rate limit -> small JSON body parser -> transport.
 */
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as publicService from './publicService.js';
import { PUBLIC_LIMITS, PublicInputError, parseJobRef, parseJobSearch } from './publicParams.js';
import { PublicLocation } from './publicJob.js';
import { safeErrorText } from '../security/pure.js';

export const MCP_PATH = '/mcp';

/** The complete, fixed tool list (test/public.test.mjs pins it). */
export const PUBLIC_MCP_TOOLS = ['search_jobs', 'get_job', 'jobs_near', 'list_locations', 'list_skills'] as const;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
const fail = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });

const run = async (fn: () => Promise<unknown>) => {
  try {
    return json(await fn());
  } catch (e) {
    if (e instanceof PublicInputError) return fail(e.message);
    console.error('[mcp] tool failed', safeErrorText(e));
    return fail('Server error');
  }
};

const textFilters = {
  query: z.string().max(PUBLIC_LIMITS.maxTextLength).optional()
    .describe('Free text (Hebrew or English): matches the title, description or company name'),
  skills: z.array(z.string().max(PUBLIC_LIMITS.maxTextLength)).max(PUBLIC_LIMITS.maxFilterValues).optional()
    .describe('Skill names or ids (see list_skills)'),
  scope: z.array(z.enum(['FullTime', 'PartialTime'])).max(2).optional().describe('Full time / part time'),
};
const paging = {
  page: z.number().int().min(1).optional().describe('Page number, from 1'),
  limit: z.number().int().min(1).max(PUBLIC_LIMITS.maxPageSize).optional()
    .describe(`Results per page (default ${PUBLIC_LIMITS.defaultPageSize}, max ${PUBLIC_LIMITS.maxPageSize})`),
};
const point = {
  lat: z.number().describe('Latitude (inside Israel)'),
  lng: z.number().describe('Longitude (inside Israel)'),
  radiusKm: z.number().positive().max(PUBLIC_LIMITS.maxRadiusKm).describe(`Radius in km (max ${PUBLIC_LIMITS.maxRadiusKm})`),
};

export const createPublicMcpServer = () => {
  const server = new McpServer(
    { name: 'skeelz-jobs', title: 'SKEELZ Jobs', version: '1.0.0' },
    {
      instructions: 'Read-only access to the active jobs published on the SKEELZ job board (Israel, mostly Hebrew). '
        + 'Use search_jobs to find jobs, get_job for one job, jobs_near for a map search, list_locations / list_skills '
        + 'for valid filter values. Each job has a url: candidates apply on the site.',
    },
  );

  server.registerTool('search_jobs', {
    title: 'Search jobs',
    description: 'Search the active jobs on the board, in board order (jobs pinned by the editors first, then newest first). Filter by text, location (city or district name, '
      + 'or city symbol), skills and scope. Returns { data, page, limit, total }.',
    inputSchema: {
      ...textFilters,
      location: z.array(z.string().max(PUBLIC_LIMITS.maxTextLength)).max(PUBLIC_LIMITS.maxFilterValues).optional()
        .describe('City names, district names or city symbols (see list_locations). Remote jobs always match.'),
      ...paging,
    },
    annotations: { title: 'Search jobs', ...READ_ONLY },
  }, (a) => run(() => publicService.searchJobs(parseJobSearch({
    q: a.query, skills: a.skills, scope: a.scope, location: a.location, page: a.page, limit: a.limit,
  }))));

  server.registerTool('get_job', {
    title: 'Get a job',
    description: 'One active job by its id (24 hex characters) or job number, with the full description (HTML).',
    inputSchema: { id: z.string().max(30).describe('Job id or job number') },
    annotations: { title: 'Get a job', ...READ_ONLY },
  }, (a) => run(async () => {
    const job = await publicService.getJob(parseJobRef(a.id));
    if (!job) throw new PublicInputError('No active job with this id');
    return job;
  }));

  server.registerTool('jobs_near', {
    title: 'Jobs near a point',
    description: 'Active jobs within radiusKm of a point in Israel, pinned jobs first, then nearest first, each with distanceKm. '
      + 'Also counts remote jobs and jobs whose town has no coordinates. Use list_locations to get a town\'s lat/lng.',
    inputSchema: { ...point, ...textFilters, ...paging },
    annotations: { title: 'Jobs near a point', ...READ_ONLY },
  }, (a) => run(async () => {
    const input = parseJobSearch({ q: a.query, skills: a.skills, scope: a.scope, lat: a.lat, lng: a.lng, radiusKm: a.radiusKm, page: a.page, limit: a.limit }, { nearRequired: true });
    return publicService.jobsNear(input as typeof input & { near: NonNullable<typeof input.near> });
  }));

  server.registerTool('list_locations', {
    title: 'List locations',
    description: 'Towns and districts used by jobs (citySymbol, city, district, lat, lng). Optional text filter.',
    inputSchema: {
      search: z.string().max(PUBLIC_LIMITS.maxTextLength).optional().describe('Part of a city or district name'),
      limit: z.number().int().min(1).max(2000).optional().describe('Max results (default 200)'),
    },
    annotations: { title: 'List locations', ...READ_ONLY },
  }, (a) => run(async () => {
    const all = await publicService.listLocations();
    const k = a.search ? publicService.norm(a.search) : '';
    const hit = (l: PublicLocation) => !k || publicService.norm(l.city).includes(k) || publicService.norm(l.district ?? '').includes(k);
    const data = all.filter(hit);
    return { data: data.slice(0, a.limit ?? 200), total: data.length };
  }));

  server.registerTool('list_skills', {
    title: 'List skills',
    description: 'Skills that jobs can require (id, name). Optional text filter.',
    inputSchema: { search: z.string().max(PUBLIC_LIMITS.maxTextLength).optional().describe('Part of a skill name') },
    annotations: { title: 'List skills', ...READ_ONLY },
  }, (a) => run(async () => {
    const k = a.search ? publicService.norm(a.search) : '';
    const data = (await publicService.listSkills()).filter((s) => !k || publicService.norm(s.name).includes(k));
    return { data, total: data.length };
  }));

  return server;
};

const router = express.Router();

// Any origin, no credentials (the MCP server has no auth and reads only public data).
router.use(MCP_PATH, cors({
  origin: '*',
  methods: ['POST', 'OPTIONS'],
  exposedHeaders: ['Mcp-Session-Id', 'Mcp-Protocol-Version'],
  maxAge: 86400,
}));

// Stateless: only POST carries JSON-RPC. GET (SSE stream) and DELETE (session end) are not offered.
router.use(MCP_PATH, (req, res, next) => {
  if (req.method === 'POST') return next();
  res.setHeader('Allow', 'POST, OPTIONS');
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
});

router.use(MCP_PATH, rateLimit({
  windowMs: 60 * 1000,
  limit: PUBLIC_LIMITS.mcpPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests' }, id: null },
}));

router.use(MCP_PATH, express.json({ limit: '64kb' }));

router.post(MCP_PATH, async (req: Request, res: Response, next: NextFunction) => {
  const server = createPublicMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('[mcp] request failed', safeErrorText(e));
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    else next(e);
  }
});

// Bad JSON body etc. -> JSON-RPC parse error, not the site's HTML/error page.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
router.use(MCP_PATH, (err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  const status = err?.status === 413 ? 413 : 400;
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32700, message: status === 413 ? 'Request too large' : 'Parse error' }, id: null });
});

export default router;
