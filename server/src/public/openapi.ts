/** OpenAPI 3.1 description of the public API (served at /api/public/v1/openapi.json). */
import { PUBLIC_LIMITS } from './publicParams.js';
import { PUBLIC_SITE_URL } from './publicJob.js';

const location = {
  type: 'object',
  required: ['citySymbol', 'city', 'district', 'lat', 'lng'],
  additionalProperties: false,
  properties: {
    citySymbol: { type: 'integer', description: 'CBS settlement code (-1 = anywhere, -2 = from home)' },
    city: { type: 'string' },
    district: { type: ['string', 'null'] },
    lat: { type: ['number', 'null'] },
    lng: { type: ['number', 'null'] },
  },
};
const skill = {
  type: 'object', required: ['id', 'name'], additionalProperties: false,
  properties: { id: { type: 'string' }, name: { type: 'string' } },
};
const job = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'jobNumber', 'title', 'companyName', 'description', 'jobScope', 'publishDate', 'location', 'skills', 'isSponsored', 'externalLink', 'url'],
  properties: {
    id: { type: 'string', pattern: '^[0-9a-f]{24}$' },
    jobNumber: { type: 'integer' },
    title: { type: 'string' },
    companyName: { type: 'string' },
    description: { type: 'string', description: 'Sanitized HTML' },
    jobScope: { type: 'array', items: { type: 'string', enum: ['FullTime', 'PartialTime'] } },
    publishDate: { type: ['string', 'null'], format: 'date-time' },
    location: { oneOf: [{ $ref: '#/components/schemas/Location' }, { type: 'null' }] },
    skills: { type: 'array', items: { $ref: '#/components/schemas/Skill' } },
    isSponsored: { type: 'boolean' },
    externalLink: { type: ['string', 'null'], format: 'uri' },
    url: { type: 'string', format: 'uri', description: 'The job page on the board (apply there)' },
  },
};
const nearJob = {
  allOf: [{ $ref: '#/components/schemas/Job' }, { type: 'object', required: ['distanceKm'], properties: { distanceKm: { type: 'number' } } }],
};

const q = (name: string, description: string, schema: object = { type: 'string' }) => ({ name, in: 'query', required: false, description, schema });
const paging = [
  q('page', 'Page number (1-based)', { type: 'integer', minimum: 1, default: 1 }),
  q('limit', `Items per page (max ${PUBLIC_LIMITS.maxPageSize})`, { type: 'integer', minimum: 1, maximum: PUBLIC_LIMITS.maxPageSize, default: PUBLIC_LIMITS.defaultPageSize }),
];
const filters = [
  q('q', 'Free text: title (letters in order), description or company name', { type: 'string', maxLength: PUBLIC_LIMITS.maxTextLength }),
  q('skills', 'Skill ids or names, comma-separated', { type: 'string' }),
  q('scope', 'FullTime, PartialTime (comma-separated)', { type: 'string' }),
];
const point = (required: boolean) => [
  { ...q('lat', 'Latitude (inside Israel)', { type: 'number' }), required },
  { ...q('lng', 'Longitude (inside Israel)', { type: 'number' }), required },
  { ...q('radiusKm', `Radius in km (max ${PUBLIC_LIMITS.maxRadiusKm})`, { type: 'number', exclusiveMinimum: 0, maximum: PUBLIC_LIMITS.maxRadiusKm }), required },
];
const err = (d: string) => ({ description: d, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
const ok = (schema: object) => ({ description: 'OK', content: { 'application/json': { schema } } });
const common = { 400: err('Bad input'), 405: err('Only GET is allowed'), 429: err(`More than ${PUBLIC_LIMITS.restPerMinute} requests a minute from one IP`) };

const jobPage = (item: string, extra: Record<string, object> = {}) => ({
  type: 'object',
  required: ['data', 'page', 'limit', 'total', ...Object.keys(extra)],
  properties: { data: { type: 'array', items: { $ref: `#/components/schemas/${item}` } }, page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' }, ...extra },
});

export const openApiSpec = () => ({
  openapi: '3.1.0',
  info: {
    title: 'SKEELZ Jobs public API',
    version: '1.0.0',
    description: 'Read-only access to the jobs published on the SKEELZ job board: active jobs, locations, skills and a map search. '
      + 'No authentication. Only GET. Data is the same as the public site shows. '
      + `Rate limit: ${PUBLIC_LIMITS.restPerMinute} requests/minute per IP. An MCP server with the same data is at /mcp.`,
  },
  servers: [{ url: `${PUBLIC_SITE_URL}/api/public/v1` }],
  paths: {
    '/jobs': {
      get: {
        summary: 'List / search active jobs',
        description: 'Board order: jobs pinned by the editors first (latest pin on top), then newest first. With lat, lng and radiusKm it becomes the near search (pinned first, then nearest; location ignored).',
        parameters: [...filters, q('location', 'City symbols, city names or district names, comma-separated'), ...point(false), ...paging],
        responses: { 200: ok({ $ref: '#/components/schemas/JobPage' }), ...common },
      },
    },
    '/jobs/near': {
      get: {
        summary: 'Active jobs near a point, pinned first, then nearest',
        parameters: [...point(true), ...filters, ...paging],
        responses: { 200: ok({ $ref: '#/components/schemas/NearPage' }), ...common },
      },
    },
    '/jobs/{id}': {
      get: {
        summary: 'One active job',
        parameters: [{ name: 'id', in: 'path', required: true, description: 'Job id (24 hex) or job number', schema: { type: 'string' } }],
        responses: {
          200: ok({ type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/Job' } } }),
          404: err('No such active job'), ...common,
        },
      },
    },
    '/locations': {
      get: { summary: 'All locations (with coordinates where known)', responses: { 200: ok({ type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Location' } } } }), ...common } },
    },
    '/skills': {
      get: { summary: 'All skills', responses: { 200: ok({ type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Skill' } } } }), ...common } },
    },
  },
  components: {
    schemas: {
      Job: job,
      NearJob: nearJob,
      Location: location,
      Skill: skill,
      JobPage: jobPage('Job'),
      NearPage: jobPage('NearJob', { remote: { type: 'integer' }, withoutCoordinates: { type: 'integer' } }),
      Error: { type: 'object', required: ['message', 'code'], properties: { message: { type: 'string' }, code: { type: 'string' } } },
    },
  },
});
