/* ============================================================================
 *  /api/internal/v1 — the internal API for SKEELZ's own systems (server to
 *  server). Separate from the public read-only API: its own gate
 *  (internalApiAuth, tokens or INTERNAL_API_SECRET), no cookies, no user JWTs.
 *  Every route names the scopes it needs; test/gates.test.mjs checks that.
 *  Spec: docs/internal-api.openapi.yaml.
 * ========================================================================== */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { validationMiddleware } from '../middleware/validationMiddleware.js';
import { CreateJobDTO } from '../dto/createJobDto.js';
import { UpdateJobDto } from '../dto/updateJobDto.js';
import { internalApiAuth as gate } from './auth.js';
import * as c from './controller.js';

const router = express.Router();

// Per client IP, in memory (one process). Generous for integrations, a wall for loops.
router.use(rateLimit({
  windowMs: 60_000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { message: 'Too many requests', code: 'rl1' },
}));

router.get('/jobs', gate(['jobs:read']), c.listJobs);
router.get('/jobs/:id', gate(['jobs:read']), c.getJob);
router.post('/jobs', gate(['jobs:write']), validationMiddleware(CreateJobDTO), c.createJob);
router.patch('/jobs/:id', gate(['jobs:write']), validationMiddleware(UpdateJobDto), c.updateJob);

router.get('/candidates', gate(['candidates:read']), c.listCandidatesH);
router.get('/candidates/:id', gate(['candidates:read']), c.getCandidateH);
router.get('/candidates/:id/cv', gate(['candidates:read', 'cvs:read']), c.candidateCv);

router.get('/applications', gate(['applications:read']), c.listApplicationsH);
router.get('/applications/:id', gate(['applications:read']), c.getApplicationH);
router.get('/applications/:id/cv', gate(['applications:read', 'cvs:read']), c.applicationCv);

router.get('/salesforce/sync', gate(['salesforce:push']), c.getSyncState);
router.post('/salesforce/jobs/:id/push', gate(['salesforce:push']), c.requireSalesforce, c.pushJob);
router.post('/salesforce/applications/:id/push', gate(['salesforce:push']), c.requireSalesforce, c.pushApplication);
router.post('/salesforce/candidates/:id/push', gate(['salesforce:push']), c.requireSalesforce, c.pushCandidate);
router.post('/salesforce/push-pending', gate(['salesforce:push']), c.requireSalesforce, c.pushPending);

router.use((_req, res) => res.status(404).json({ message: 'Not found', code: 'not_found' }));

export default router;
