import express from 'express';
import rateLimit from 'express-rate-limit';
import * as userController from './controllers/userController.js';
import * as SalesforceAdminController from './controllers/salesforceAdminController.js';
import * as skillsController from './controllers/skillsController.js';
import { HealthCheck } from './controllers/healthCheck.js';
import * as jobController from './controllers/jobController.js';
import * as locationsController from './controllers/locationController.js'
import { validationMiddleware } from './middleware/validationMiddleware.js';
import { CreateJobDTO } from './dto/createJobDto.js';
import * as authController from './controllers/authController.js';
import * as SsoController from './controllers/ssoController.js';
import * as EmailSigninController from './controllers/emailSigninController.js';
import * as MicrosoftSsoController from './controllers/microsoftSsoController.js';
import { adminOnly, anyAccount, contentManagerOnly, employerOnly, signedIn, staffViewers } from './middleware/jwtAuthMiddleware.js';
import * as RolesController from './controllers/rolesController.js';
import { tryExtractTokenPayloadMiddleware } from './middleware/tryExtractTokenPayloadMiddleware.js';
import createUploadMiddleware from './middleware/createUploadMiddleware.js';
import * as FileController from './controllers/fileController.js';
import { fileTypeCheck } from './middleware/fileTypeCheckMiddleware.js';
import { UpdateJobDto } from './dto/updateJobDto.js';
import * as SyncController from './controllers/syncController.js';
import * as SecurityController from './controllers/securityController.js';
import * as StaffController from './controllers/staffController.js';
import * as SettingsController from './controllers/settingsController.js';
import * as MailController from './controllers/mailController.js';
import * as MarketingController from './controllers/marketingController.js';
import * as MyCvController from './controllers/myCvController.js';
import * as ProfileController from './controllers/profileController.js';
import * as JobSubmissionController from './controllers/jobSubmissionController.js';
import * as GuestApplicationController from './controllers/guestApplicationController.js';
import * as EmployerController from './controllers/employerController.js';
import * as JobEditRequestController from './controllers/jobEditRequestController.js';
import * as EmployerApplicantsController from './controllers/employerApplicantsController.js';
import * as EmployerForwardController from './controllers/employerForwardController.js';
import { SUBMISSION_LIMITS } from './security/pure.js';

import * as ApiTokensController from './internalApi/tokensController.js';
import internalApiRouter from './internalApi/routes.js';

const router = express.Router();
const healthCheck = new HealthCheck();

// Gates (separation of duties; jwtAuthMiddleware.ts):
//   staffViewers        jobs management (no settings) and VIEWING candidates (lists, applications, CVs):
//                       placement coordinators, content managers, admins
//   contentManagerOnly  settings, candidates' records, forwards to employers, Salesforce pushes
//   adminOnly           security, activity log, staff users — never candidates
//   signedIn            any signed-in candidate or staff member (not employers)
//   employerOnly        an employer's own area (/employer/*), incl. the applicants staff forwarded to them
// test/gates.test.mjs asserts which routes carry which gate.

// Who reviews content (employer job submissions, edit requests): coordinators, content managers and admins.
// A threshold condition in a submission or edit request still needs a content manager (checked in the handlers).
const contentGate = staffViewers;

// Abuse limits on the public write endpoints (per client IP, in memory: one process).
const limiter = (windowMinutes: number, limit: number) => rateLimit({
  windowMs: windowMinutes * 60 * 1000,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many requests', code: 'rl1' },
});
const authLimit = limiter(15, 30);
// Sign-in by a code sent by email (per IP; the per-address limits are in the controller, security/emailCode.ts).
const emailCodeRequestLimit = limiter(15, 20);
const emailCodeVerifyLimit = limiter(15, 60);
// Redirect sign-in (xhostd SSO): each attempt is two requests (start + callback).
const ssoLimit = limiter(15, 100);
const writeLimit = limiter(60, 30);
const unsubscribeLimit = limiter(15, 60);
const uploadLimit = limiter(60, 20);
// Staff inline edits on the jobs-management screen: many small clicks, still a wall for loops.
const writeLimitStaff = limiter(15, 600);
// Resend's webhook: its own retries and bursts, still a wall for a flood.
const webhookLimit = limiter(1, 600);
const submissionLimit =limiter(60, SUBMISSION_LIMITS.perIpPerHour);

router.get('/health-check', healthCheck.getHealthCheck);

// Sandbox copy of the data (off unless SANDBOX_EXPORT_TOKEN is set; see controller).
router.get('/internal/export', authLimit, SyncController.exportForSandbox);
// Sandbox only (404 elsewhere): replace the sandbox's data with a fresh copy of prod's. Admins.
router.post('/internal/sandbox-refresh', adminOnly, SyncController.refreshSandbox);

router.post('/logout', tryExtractTokenPayloadMiddleware, authController.logout);

// "Continue with Google" = xhostd SSO (controllers/ssoController.ts), for candidates and staff (staff: only this).
// The callback is a top-level navigation back from Google / auth.xhostd.com: index.ts lets exactly it through
// the cross-site refusal; the signed state cookie and the RS256 identity cookie are what protect it.
router.get('/auth/providers', SsoController.providers);
router.get('/auth/signup-fields', SettingsController.publicSignupFields);
router.get('/custom-fields/signup', SettingsController.publicSignupCustomFields);
router.get('/custom-fields/job', SettingsController.publicJobCustomFields);
router.get('/auth/session', tryExtractTokenPayloadMiddleware, SsoController.session);
router.get('/auth/xhostd/start', ssoLimit, SsoController.ssoStart);
router.get('/auth/xhostd/callback', ssoLimit, SsoController.ssoCallback);
// A new SSO identity fills the sign-up form first: its prefill, then the account (signed httpOnly cookie from the callback).
router.get('/auth/xhostd/signup', SsoController.pendingSignup);
router.post('/auth/xhostd/signup', writeLimit, SsoController.completeSignup);
// "Continue with Microsoft" (controllers/microsoftSsoController.ts): candidates only, off unless ENABLE_MICROSOFT_SSO.
// A new identity finishes on the same sign-up form (/auth/xhostd/signup, the cookie says which provider).
router.get('/auth/microsoft/start', ssoLimit, MicrosoftSsoController.msStart);
router.get('/auth/microsoft/callback', ssoLimit, MicrosoftSsoController.msCallback);

// "קבלת קוד למייל": candidates sign in (or sign up) with a one-time code sent by email (emailSigninController.ts).
router.post('/auth/email/request', emailCodeRequestLimit, EmailSigninController.requestCode);
router.post('/auth/email/verify', emailCodeVerifyLimit, EmailSigninController.verifyCode);
router.get('/auth/email/signup', EmailSigninController.pendingSignup);
router.post('/auth/email/signup', writeLimit, EmailSigninController.completeSignup);

router.get('/users', staffViewers, userController.fetchUsers);

// The personal area: the caller's own candidate record only (no id in the path; before /users/:id).
router.get('/users/me', signedIn, ProfileController.getMe);
router.patch('/users/me', signedIn, writeLimit, ProfileController.updateMe);
router.delete('/users/me/cv', signedIn, writeLimit, ProfileController.removeMyCv);
router.put('/users/me/marketing-consent', signedIn, writeLimit, ProfileController.setMarketingConsent);
// The consent step at sign-in: the current terms (+ the marketing question if never answered), the caller's own only.
router.put('/users/me/terms', signedIn, writeLimit, ProfileController.acceptTerms);
// Several roles per account (23.11.2026): add the candidate / employer role to one's own account (never a staff role).
router.post('/users/me/roles/candidate', anyAccount, writeLimit, RolesController.addCandidate);
router.post('/users/me/roles/employer', anyAccount, writeLimit, RolesController.addEmployer);

router.patch('/users/:id', contentManagerOnly, userController.updateUser);
// Marketing consent (security/marketing.ts, docs/marketing-consent.md): every staff role sees a candidate's state and
// history (peopleHandover); content managers record a removal on the person's request. Nobody but the person says "yes".
router.get('/admin/users/:id/marketing', staffViewers, MarketingController.candidateMarketing);
router.post('/admin/users/:id/marketing-optout', contentManagerOnly, writeLimit, MarketingController.removeCandidate);
router.post('/admin/marketing/optouts', contentManagerOnly, writeLimit, MarketingController.removeAddress);
// The one-click unsubscribe link of a marketing email: no sign-in, a signed token (RFC 8058).
router.post('/unsubscribe', unsubscribeLimit, MarketingController.unsubscribe);

// Open to guests (sign-up / guest apply), but a signed-in uploader (candidate in the personal area, staff on a
// candidate's row) is identified, so cv.uploaded names them instead of anonymous:<address>.
router.post('/files/:token',
  uploadLimit,
  tryExtractTokenPayloadMiddleware,
  createUploadMiddleware({ fileSizeLimitInMB: 5 }),
  fileTypeCheck({ isMultipartUpload: false }),
  FileController.uploadFile );

router.get('/files/:userId', staffViewers, FileController.fetchfile );
// The CV sent with one application (also a CV for that job only), through the CV hand-over.
router.get('/admin/users/:userId/applications/:jobId/cv', staffViewers, FileController.fetchApplicationCv);

// Content managers unlink a candidate's CV from the profile (the file is kept); others can only cancel their own
// pending upload (see controller).
router.delete('/files/', writeLimit, tryExtractTokenPayloadMiddleware, FileController.deleteFile );

// The caller's own profile CV only (no user id in the path), for the apply step.
router.get('/users/me/cv', signedIn, MyCvController.getMyCv);
router.get('/users/me/cv/file', signedIn, MyCvController.downloadMyCv);

router.get('/skills', skillsController.fetchSkills);

router.get('/admin/jobs/with-comments', staffViewers, jobController.adminFetchAllJobs);

// Jobs-management screen (docs/jobs-management.md): pin to top, inline board fields, soft delete + restore.
router.post('/admin/jobs/:jobId/pin', staffViewers, writeLimitStaff, jobController.pinJob);
router.post('/admin/jobs/:jobId/bump', staffViewers, writeLimitStaff, jobController.bumpJob);
router.delete('/admin/jobs/:jobId/pin', staffViewers, writeLimitStaff, jobController.unpinJob);
router.patch('/admin/jobs/:jobId/board', staffViewers, writeLimitStaff, jobController.updateJobBoard);
router.post('/admin/jobs/:jobId/archive', staffViewers, writeLimitStaff, jobController.archiveJob);
router.post('/admin/jobs/:jobId/restore', staffViewers, writeLimitStaff, jobController.restoreJob);
router.get('/admin/jobs/:jobId/applications-count', staffViewers, jobController.jobApplicationsCount);

// Site-wide apply policy defaults (quick apply, quick apply without a CV); jobs can override them.
// Read by every jobs-management screen (coordinators too: the table shows the defaults); changed by content managers.
router.get('/admin/settings/apply-policy', staffViewers, SettingsController.getApplyPolicy);
router.put('/admin/settings/apply-policy', contentManagerOnly, writeLimit, SettingsController.updateApplyPolicy);
// Employer job posting: 'open' (the anonymous form, default) or 'account_required' (docs/employers.md).
router.get('/admin/settings/employer-posting', contentManagerOnly, SettingsController.getEmployerPosting);
router.put('/admin/settings/employer-posting', contentManagerOnly, writeLimit, SettingsController.updateEmployerPosting);
// Candidate sign-up fields: required / optional (ID number also hidden). A candidate-level setting: content managers
// and admins (moved from /admin/security 11.2026); the form and the server read it.
router.get('/admin/settings/signup-fields', contentManagerOnly, SettingsController.getSignupFields);
router.put('/admin/settings/signup-fields', contentManagerOnly, writeLimit, SettingsController.updateSignupFields);
// Added fields (the settings screen /settings, docs/settings.md): content managers and admins define them; the
// sign-up form reads its own (public, definitions only); everyone who edits jobs reads the job form's.
router.get('/admin/settings/custom-fields', contentManagerOnly, SettingsController.listCustomFields);
router.post('/admin/settings/custom-fields', contentManagerOnly, writeLimitStaff, SettingsController.createCustomField);
router.patch('/admin/settings/custom-fields/:id', contentManagerOnly, writeLimitStaff, SettingsController.updateCustomField);
router.get('/admin/job-fields', staffViewers, SettingsController.jobFormFields);
// Linking an added field to a Salesforce field: admins (the Salesforce settings are theirs). Read-only describe; the
// site never creates or deletes a field in Salesforce.
router.get('/admin/security/salesforce/custom-fields', adminOnly, SettingsController.salesforceCustomFields);
router.put('/admin/security/salesforce/custom-fields/:id', adminOnly, writeLimitStaff, SettingsController.linkSalesforceCustomField);

// Service emails: events on/off and their templates (content managers and admins; src/mail, docs/mail.md).
// Its own screen (/mail-management); the test send goes only to the editor's own address.
router.get('/admin/mail', contentManagerOnly, MailController.overview);
router.post('/admin/mail/preview', contentManagerOnly, MailController.preview);
router.post('/admin/mail/test', contentManagerOnly, writeLimit, MailController.testSend);
router.post('/admin/mail/suppressions/remove', contentManagerOnly, writeLimit, MailController.removeSuppression);
router.get('/admin/mail/kinds/:kind', contentManagerOnly, MailController.getKind);
router.post('/admin/mail/kinds/:kind/versions', contentManagerOnly, writeLimitStaff, MailController.saveVersion);
router.post('/admin/mail/kinds/:kind/versions/:id/publish', contentManagerOnly, writeLimitStaff, MailController.publish);
router.post('/admin/mail/kinds/:kind/reset', contentManagerOnly, writeLimitStaff, MailController.reset);
router.put('/admin/mail/kinds/:kind/enabled', contentManagerOnly, writeLimitStaff, MailController.setEnabled);
// Resend's delivery events (bounces, complaints): no session, a signature instead (raw body, index.ts).
router.post('/webhooks/resend', webhookLimit, MailController.resendWebhook);

router.get('/jobs/active', jobController.fetchActiveJobs);

// Map search: active jobs within radiusKm of a point, nearest first.
router.get('/jobs/near', jobController.fetchActiveJobsNear);

router.get('/jobs/:jobId', tryExtractTokenPayloadMiddleware, jobController.fetchJobById);

// Was public: anyone could list anyone's applications. Own only, or any as a content manager (controller).
router.get('/users/job-applications/:userId', signedIn, jobController.findAllJobApplictionsDetailsByUserId);

// Was public: anyone could edit any job. A coordinator may not change the threshold condition or the apply
// settings (handler, 403 content_manager_required).
router.patch('/jobs/:jobId', staffViewers, validationMiddleware(UpdateJobDto), jobController.updateJob);

router.post('/jobs/apply/:jobId', signedIn, jobController.applyJob);

router.post('/jobs/guestApply', writeLimit, jobController.guestApplyJob);

// Was public: anyone could create a job.
router.post('/jobs', staffViewers, validationMiddleware(CreateJobDTO), jobController.createNewJob)

// Guest (quick) applications: stored, never deleted; shown through the hand-overs; pushed to Salesforce later.
router.get('/admin/guest-applications', staffViewers, GuestApplicationController.list);
router.get('/admin/guest-applications/:id/cv', staffViewers, GuestApplicationController.cv);
router.post('/admin/guest-applications/salesforce-push', contentManagerOnly, writeLimitStaff, GuestApplicationController.pushToSalesforce);
// Forwarding applications to the employer who owns the job (docs/employers.md "Applicants"): nothing reaches an
// employer without a forward; cancel only before the employer was shown it. The list shows names (peopleHandover).
router.get('/admin/employer-forwards', staffViewers, EmployerForwardController.list);
router.post('/admin/employer-forwards', contentManagerOnly, writeLimitStaff, EmployerForwardController.forward);
router.post('/admin/employer-forwards/:id/cancel', contentManagerOnly, writeLimitStaff, EmployerForwardController.cancel);

// Employer job submissions: public form (stored as pending, never public until approved) + staff review.
// Identifies optionally: with the setting 'account_required' only a signed-in employer may send (checked in the
// controller, DB role); a signed-in employer's submission carries the account.
router.get('/job-submissions/policy', SettingsController.publicEmployerPosting);
router.post('/job-submissions', submissionLimit, tryExtractTokenPayloadMiddleware, JobSubmissionController.submit);
router.get('/admin/job-submissions', contentGate, JobSubmissionController.list);
router.get('/admin/job-submissions/:id', contentGate, JobSubmissionController.get);
router.patch('/admin/job-submissions/:id', contentGate, JobSubmissionController.edit);
router.post('/admin/job-submissions/:id/approve', contentGate, JobSubmissionController.approve);
router.post('/admin/job-submissions/:id/reject', contentGate, JobSubmissionController.reject);
// Employers' edit requests for their published jobs: the content managers' queue (approve applies, reject keeps).
router.get('/admin/job-edit-requests', contentGate, JobEditRequestController.list);
router.get('/admin/job-edit-requests/:id', contentGate, JobEditRequestController.get);
router.post('/admin/job-edit-requests/:id/approve', contentGate, writeLimitStaff, JobEditRequestController.approve);
router.post('/admin/job-edit-requests/:id/reject', contentGate, writeLimitStaff, JobEditRequestController.reject);

// The employer's personal area (docs/employers.md): own rows only (id from the session). Candidates only as the
// applicants staff forwarded for the employer's own jobs: name + CV, own budgets, strict log (hand-overs).
router.get('/employer/me', employerOnly, EmployerController.getMe);
router.patch('/employer/me', employerOnly, writeLimit, EmployerController.updateMe);
router.get('/employer/submissions', employerOnly, EmployerController.submissions);
router.post('/employer/submissions/claim', employerOnly, writeLimit, EmployerController.claim);
router.get('/employer/jobs', employerOnly, EmployerController.jobs);
router.get('/employer/jobs/:jobId', employerOnly, EmployerController.job);
router.post('/employer/jobs/:jobId/edit-requests', employerOnly, writeLimit, EmployerController.requestEdit);
router.get('/employer/edit-requests', employerOnly, EmployerController.editRequests);
router.post('/employer/edit-requests/:id/withdraw', employerOnly, writeLimit, EmployerController.withdraw);
router.get('/employer/applicants', employerOnly, EmployerApplicantsController.list);
router.get('/employer/applicants/:forwardId/cv', employerOnly, EmployerApplicantsController.cv);

// Security screen (admins): alerts, limits, grants, access reviews, the activity log.
router.get('/admin/security', adminOnly, SecurityController.summary);
router.post('/admin/security/grant', adminOnly, SecurityController.grant);
router.post('/admin/security/alerts/:id/handle', adminOnly, SecurityController.handleAlert);
router.post('/admin/security/reviews/:userId', adminOnly, SecurityController.confirmReview);
router.post('/admin/security/admins/:userId/revoke', adminOnly, SecurityController.revokeAdmin);
router.get('/admin/audit', adminOnly, SecurityController.auditSearch);
router.get('/admin/audit/person', adminOnly, SecurityController.personActivity);
// Salesforce (admins): state, read-only connection check, retry failures (salesforceAdminController.ts).
router.get('/admin/security/salesforce', adminOnly, SalesforceAdminController.status);
router.post('/admin/security/salesforce/check', adminOnly, writeLimitStaff, SalesforceAdminController.check);
router.post('/admin/security/salesforce/retry', adminOnly, writeLimitStaff, SalesforceAdminController.retry);
// The existing site's jobs (mirror state, read now) and the cutover report, READ ONLY in Salesforce.
router.get('/admin/security/salesforce/legacy-jobs', adminOnly, SalesforceAdminController.legacyJobs);
router.post('/admin/security/salesforce/legacy-jobs/run', adminOnly, writeLimitStaff, SalesforceAdminController.runLegacyJobs);
router.get('/admin/security/salesforce/legacy-candidates', adminOnly, SalesforceAdminController.legacyCandidates);
router.post('/admin/security/salesforce/legacy-candidates/run', adminOnly, writeLimitStaff, SalesforceAdminController.runLegacyCandidates);
router.get('/admin/security/salesforce/cutover-report', adminOnly, SalesforceAdminController.cutoverReport);

// Staff users (admins): add/invite, role, deactivate, close sessions. Lists staff only, never candidates.
router.get('/admin/staff', adminOnly, StaffController.list);
router.post('/admin/staff', adminOnly, StaffController.add);
router.patch('/admin/staff/:userId/role', adminOnly, StaffController.setRole);
router.post('/admin/staff/:userId/deactivate', adminOnly, StaffController.deactivate);
router.post('/admin/staff/:userId/activate', adminOnly, StaffController.activate);
router.post('/admin/staff/:userId/revoke-sessions', adminOnly, StaffController.revokeSessions);

// Internal API tokens: admins only (owner, 20.11.2026): list, create and revoke, on the security screen.
// The handler also checks the DB role (issuableScopes) so a key's scopes always match an admin issuer.
router.get('/admin/api-tokens', adminOnly, ApiTokensController.listTokens);
router.post('/admin/api-tokens', adminOnly, writeLimit, ApiTokensController.createToken);
router.post('/admin/api-tokens/:id/revoke', adminOnly, ApiTokensController.revokeToken);

// Internal API for SKEELZ's own systems: its own gate (internalApiAuth), never the user JWT.
// Kept apart from the public read-only API. Routes: internalApi/routes.ts; checked by test/gates.test.mjs.
router.use('/internal/v1', internalApiRouter);

//locations routes

router.get('/locations', locationsController.getAllLocations);
router.get('/locations-and-districts', locationsController.getAllLocationsAndDistricts);


/** Development only (index.ts mounts it with DEV_MODE=true outside production): e2e scripts read sign-in codes. */
export const devRouter = express.Router();
devRouter.get('/dev/email-code', EmailSigninController.devLastCode);
devRouter.post('/dev/email-code', EmailSigninController.devMintCode);


export default router;
