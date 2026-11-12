import express from 'express';
import rateLimit from 'express-rate-limit';
import * as userController from './controllers/userController.js';
import * as skillsController from './controllers/skillsController.js';
import { HealthCheck } from './controllers/healthCheck.js';
import * as jobController from './controllers/jobController.js';
import * as locationsController from './controllers/locationController.js'
import { validationMiddleware } from './middleware/validationMiddleware.js';
import { CreateJobDTO } from './dto/createJobDto.js';
import * as authController from './controllers/authController.js';
import * as SsoController from './controllers/ssoController.js';
import { adminOnly, contentManagerOnly, signedIn, staffOnly } from './middleware/jwtAuthMiddleware.js';
import { tryExtractTokenPayloadMiddleware } from './middleware/tryExtractTokenPayloadMiddleware.js';
import { ResetPasswordDTO } from './dto/resetPasswordDTO.js';
import createUploadMiddleware from './middleware/createUploadMiddleware.js';
import * as FileController from './controllers/fileController.js';
import { fileTypeCheck } from './middleware/fileTypeCheckMiddleware.js';
import { UpdateJobDto } from './dto/updateJobDto.js';
import * as SyncController from './controllers/syncController.js';
import * as SecurityController from './controllers/securityController.js';
import * as StaffController from './controllers/staffController.js';
import * as SettingsController from './controllers/settingsController.js';
import * as MyCvController from './controllers/myCvController.js';
import * as ProfileController from './controllers/profileController.js';
import * as JobSubmissionController from './controllers/jobSubmissionController.js';
import { SUBMISSION_LIMITS } from './security/pure.js';

import * as ApiTokensController from './internalApi/tokensController.js';
import internalApiRouter from './internalApi/routes.js';

const router = express.Router();
const healthCheck = new HealthCheck();

// Gates (separation of duties; jwtAuthMiddleware.ts):
//   contentManagerOnly  jobs management and candidates' data (lists, applications, CVs)
//   adminOnly           security, activity log, staff users — never candidates
//   signedIn            any signed-in account
// test/gates.test.mjs asserts which routes carry which gate.

// Who reviews content (employer job submissions): content managers (admins see no candidates or content).
const contentGate = contentManagerOnly;

// Abuse limits on the public write endpoints (per client IP, in memory: one process).
const limiter = (windowMinutes: number, limit: number) => rateLimit({
  windowMs: windowMinutes * 60 * 1000,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many requests', code: 'rl1' },
});
const authLimit = limiter(15, 30);
// Redirect sign-in (xhostd SSO): each attempt is two requests (start + callback).
const ssoLimit = limiter(15, 100);
const writeLimit = limiter(60, 30);
const uploadLimit = limiter(60, 20);
// Staff inline edits on the jobs-management screen: many small clicks, still a wall for loops.
const writeLimitStaff = limiter(15, 600);
const submissionLimit =limiter(60, SUBMISSION_LIMITS.perIpPerHour);

router.get('/health-check', healthCheck.getHealthCheck);

// Sandbox copy of the data (off unless SANDBOX_EXPORT_TOKEN is set; see controller).
router.get('/internal/export', authLimit, SyncController.exportForSandbox);

router.post('/login', authLimit, authController.login);

router.post('/logout', tryExtractTokenPayloadMiddleware, authController.logout);

// "Continue with Google" = xhostd SSO (controllers/ssoController.ts), for candidates and staff (staff: only this).
// The callback is a top-level navigation back from Google / auth.xhostd.com: index.ts lets exactly it through
// the cross-site refusal; the signed state cookie and the RS256 identity cookie are what protect it.
router.get('/auth/providers', SsoController.providers);
router.get('/auth/session', tryExtractTokenPayloadMiddleware, SsoController.session);
router.get('/auth/xhostd/start', ssoLimit, SsoController.ssoStart);
router.get('/auth/xhostd/callback', ssoLimit, SsoController.ssoCallback);
// A new SSO identity fills the sign-up form first: its prefill, then the account (signed httpOnly cookie from the callback).
router.get('/auth/xhostd/signup', SsoController.pendingSignup);
router.post('/auth/xhostd/signup', writeLimit, SsoController.completeSignup);

router.get('/users', contentManagerOnly, userController.fetchUsers);

// The personal area: the caller's own candidate record only (no id in the path; before /users/:id).
router.get('/users/me', signedIn, ProfileController.getMe);
router.patch('/users/me', signedIn, writeLimit, ProfileController.updateMe);
router.delete('/users/me/cv', signedIn, writeLimit, ProfileController.removeMyCv);

// Fields are whitelisted in userDAL.createUser (role can never be set here).
router.post('/users', writeLimit, userController.createUser);

router.patch('/users/:id', contentManagerOnly, userController.updateUser);

router.post('/files/:token',
  uploadLimit,
  createUploadMiddleware({ fileSizeLimitInMB: 5 }),
  fileTypeCheck({ isMultipartUpload: false }),
  FileController.uploadFile );

router.get('/files/:userId', contentManagerOnly, FileController.fetchfile );

// Content managers delete a candidate's CV; others can only cancel their own pending upload (see controller).
router.delete('/files/', writeLimit, tryExtractTokenPayloadMiddleware, FileController.deleteFile );

// The caller's own profile CV only (no user id in the path), for the apply step.
router.get('/users/me/cv', signedIn, MyCvController.getMyCv);
router.get('/users/me/cv/file', signedIn, MyCvController.downloadMyCv);

router.get('/skills', skillsController.fetchSkills);

router.get('/admin/jobs/with-comments', contentManagerOnly, jobController.adminFetchAllJobs);

// Jobs-management screen (docs/jobs-management.md): pin to top, inline board fields, soft delete + restore.
router.post('/admin/jobs/:jobId/pin', contentManagerOnly, writeLimitStaff, jobController.pinJob);
router.delete('/admin/jobs/:jobId/pin', contentManagerOnly, writeLimitStaff, jobController.unpinJob);
router.patch('/admin/jobs/:jobId/board', contentManagerOnly, writeLimitStaff, jobController.updateJobBoard);
router.post('/admin/jobs/:jobId/archive', contentManagerOnly, writeLimitStaff, jobController.archiveJob);
router.post('/admin/jobs/:jobId/restore', contentManagerOnly, writeLimitStaff, jobController.restoreJob);
router.get('/admin/jobs/:jobId/applications-count', contentManagerOnly, jobController.jobApplicationsCount);

// Site-wide apply policy defaults (quick apply, quick apply without a CV); jobs can override them.
router.get('/admin/settings/apply-policy', contentManagerOnly, SettingsController.getApplyPolicy);
router.put('/admin/settings/apply-policy', contentManagerOnly, writeLimit, SettingsController.updateApplyPolicy);

router.get('/jobs/active', jobController.fetchActiveJobs);

// Map search: active jobs within radiusKm of a point, nearest first.
router.get('/jobs/near', jobController.fetchActiveJobsNear);

router.get('/jobs/:jobId', tryExtractTokenPayloadMiddleware, jobController.fetchJobById);

// Was public: anyone could list anyone's applications. Own only, or any as a content manager (controller).
router.get('/users/job-applications/:userId', signedIn, jobController.findAllJobApplictionsDetailsByUserId);

// Was public: anyone could edit any job.
router.patch('/jobs/:jobId', contentManagerOnly, validationMiddleware(UpdateJobDto), jobController.updateJob);

router.post('/jobs/apply/:jobId', signedIn, jobController.applyJob);

router.post('/jobs/guestApply', writeLimit, jobController.guestApplyJob);

// Was public: anyone could create a job.
router.post('/jobs', contentManagerOnly, validationMiddleware(CreateJobDTO), jobController.createNewJob)

// Employer job submissions: public form (stored as pending, never public until approved) + staff review.
router.post('/job-submissions', submissionLimit, JobSubmissionController.submit);
router.get('/admin/job-submissions', contentGate, JobSubmissionController.list);
router.get('/admin/job-submissions/:id', contentGate, JobSubmissionController.get);
router.patch('/admin/job-submissions/:id', contentGate, JobSubmissionController.edit);
router.post('/admin/job-submissions/:id/approve', contentGate, JobSubmissionController.approve);
router.post('/admin/job-submissions/:id/reject', contentGate, JobSubmissionController.reject);

// Security screen (admins): alerts, limits, grants, access reviews, the activity log.
router.get('/admin/security', adminOnly, SecurityController.summary);
router.post('/admin/security/grant', adminOnly, SecurityController.grant);
router.post('/admin/security/alerts/:id/handle', adminOnly, SecurityController.handleAlert);
router.post('/admin/security/reviews/:userId', adminOnly, SecurityController.confirmReview);
router.post('/admin/security/admins/:userId/revoke', adminOnly, SecurityController.revokeAdmin);
router.get('/admin/audit', adminOnly, SecurityController.auditSearch);

// Staff users (admins): add/invite, role, deactivate, close sessions. Lists staff only, never candidates.
router.get('/admin/staff', adminOnly, StaffController.list);
router.post('/admin/staff', adminOnly, StaffController.add);
router.patch('/admin/staff/:userId/role', adminOnly, StaffController.setRole);
router.post('/admin/staff/:userId/deactivate', adminOnly, StaffController.deactivate);
router.post('/admin/staff/:userId/activate', adminOnly, StaffController.activate);
router.post('/admin/staff/:userId/revoke-sessions', adminOnly, StaffController.revokeSessions);

// Internal API tokens: both staff roles see all tokens and can revoke any (oversight). Creating one is also
// staffOnly, but the handler allows people scopes (candidates/applications/CVs) only to a content manager
// (DB role): an admin sees no candidates, so cannot issue a key that does (separation of duties).
router.get('/admin/api-tokens', staffOnly, ApiTokensController.listTokens);
router.post('/admin/api-tokens', staffOnly, writeLimit, ApiTokensController.createToken);
router.post('/admin/api-tokens/:id/revoke', staffOnly, ApiTokensController.revokeToken);

// Internal API for SKEELZ's own systems: its own gate (internalApiAuth), never the user JWT.
// Kept apart from the public read-only API. Routes: internalApi/routes.ts; checked by test/gates.test.mjs.
router.use('/internal/v1', internalApiRouter);

//locations routes

router.get('/locations', locationsController.getAllLocations);
router.get('/locations-and-districts', locationsController.getAllLocationsAndDistricts);

router.post('/password/reset/initiate', authLimit, authController.requestPasswordReset);
router.post('/password/reset', authLimit, validationMiddleware(ResetPasswordDTO), authController.resetPassword);


export default router;
