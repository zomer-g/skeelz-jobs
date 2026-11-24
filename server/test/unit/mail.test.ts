// Service emails (src/mail): the catalog, the template checks and rendering (escaping), Resend's webhook signature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAIL_KINDS, mailKind, sampleValues } from '../../src/mail/catalog.js';
import { renderTemplate, validateTemplate, SERVICE_FOOTER } from '../../src/mail/render.js';
import { interpretEvent, signSvix, verifySvix } from '../../src/mail/webhookPure.js';

const k = (kind: string) => mailKind(kind)!;

test('catalog: every default template is valid for its own kind and renders with the sample values', () => {
  assert.ok(MAIL_KINDS.length >= 12);
  const kinds = new Set<string>();
  for (const m of MAIL_KINDS) {
    assert.ok(!kinds.has(m.kind), `duplicate ${m.kind}`); kinds.add(m.kind);
    assert.match(m.kind, /^[a-z_]+$/, 'kind is a Resend tag value');
    assert.deepEqual(validateTemplate(m, m.defaultSubject, m.defaultBody), [], m.kind);
    const r = renderTemplate(m.defaultSubject, m.defaultBody, sampleValues(m), { footer: SERVICE_FOOTER });
    assert.ok(r.subject && r.text && r.html.includes('dir="rtl"'), m.kind);
    assert.ok(!/\{\{/.test(r.subject + r.text + r.html), `${m.kind}: a parameter left unfilled`);
  }
});

test('catalog: the sign-in code needs {{code}} and cannot be turned off; new candidate / employer events start off', () => {
  assert.deepEqual(k('sign_in_code').required, ['code']);
  assert.equal(k('sign_in_code').canDisable, false);
  for (const kind of ['application_received', 'application_forwarded', 'job_closed', 'employer_new_applicant',
    'submission_approved', 'submission_rejected', 'edit_request_approved', 'edit_request_rejected']) {
    assert.equal(k(kind).defaultEnabled, false, kind);
  }
  for (const kind of ['sign_in_code', 'welcome', 'staff_invite', 'staff_new_application', 'staff_job_submission']) assert.equal(k(kind).defaultEnabled, true, kind);
  // The employer's notice of a forwarded candidate carries nothing about the candidate.
  assert.ok(!k('employer_new_applicant').params.some((p) => /candidate|email|phone/i.test(p.name)));
});

test('validation: unknown parameters, a missing required one, bad links, multi-line subjects and sizes are refused', () => {
  const m = k('sign_in_code');
  assert.deepEqual(validateTemplate(m, 'קוד: {{code}}', 'הקוד {{code}}'), []);
  assert.ok(validateTemplate(m, 'קוד', 'שלום {{firstName}}').includes('unknown_param:firstName'));
  assert.ok(validateTemplate(m, 'קוד', 'שלום').includes('missing_required:code'));
  assert.ok(validateTemplate(m, '', '{{code}}').includes('subject_empty'));
  assert.ok(validateTemplate(m, 'a\nb', '{{code}}').includes('subject_multiline'));
  assert.ok(validateTemplate(m, 'x'.repeat(201), '{{code}}').includes('subject_too_long'));
  assert.ok(validateTemplate(m, 's', '{{code}}' + 'x'.repeat(10_001)).includes('body_too_long'));
  assert.ok(validateTemplate(m, 's', '{{code}} \u0007').includes('control_chars'));
  const a = k('application_received');
  assert.deepEqual(validateTemplate(a, 's', '[למשרה]({{jobLink}}) [אתר](https://skeelz.co.il/x?a=1&b=2)'), []);
  assert.ok(validateTemplate(a, 's', '[x](javascript:alert(1))').some((e) => e.startsWith('bad_link:')));
  assert.ok(validateTemplate(a, 's', '[x](http://plain.example)').some((e) => e.startsWith('bad_link:')), 'http (not https) refused');
  assert.ok(validateTemplate(a, 's', '[x]({{firstName}})').some((e) => e.startsWith('bad_link:')), 'a non-link parameter is no link target');
  assert.ok(validateTemplate(a, 's', '[[כפתור: לחצו | javascript:x]]').some((e) => e.startsWith('bad_link:')));
});

test('rendering: values are escaped and never read as markup; the template markup works', () => {
  const m = k('application_received');
  const body = '# כותרת\nשלום **{{firstName}}**\n- {{jobTitle}}\n\n[למשרה]({{jobLink}})\n[[כפתור: למשרה | {{jobLink}}]]';
  const r = renderTemplate('{{jobTitle}}', body, {
    firstName: '<img src=x onerror=alert(1)>', jobTitle: '**bold?** [x](https://evil.example)', jobLink: 'https://j.skeelz.co.il/job/1?a=1&b=2',
  });
  assert.ok(!r.html.includes('<img'), 'tag escaped');
  assert.ok(r.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!r.html.includes('href="https://evil.example"'), 'a value is never a link');
  assert.ok(r.html.includes('**bold?**'), 'a value is never bold');
  assert.ok(r.html.includes('<strong>&lt;img'), 'the template bold works around a value');
  assert.ok(r.html.includes('<li>'), 'list');
  assert.ok(r.html.includes('href="https://j.skeelz.co.il/job/1?a=1&amp;b=2"'), 'link value escaped in the attribute');
  assert.ok(/<a href="https:\/\/j\.skeelz\.co\.il[^"]*" style="display:inline-block/.test(r.html), 'button');
  assert.equal(r.subject, '**bold?** [x](https://evil.example)', 'subject is plain text');
  assert.ok(r.text.includes('שלום <img src=x onerror=alert(1)>'), 'plain text keeps the value as typed');
  assert.ok(r.text.includes('למשרה: https://j.skeelz.co.il/job/1'), 'button in plain text');
});

test('rendering: a link parameter that is not an http(s) address shows as text only', () => {
  const r = renderTemplate('s', '[למשרה]({{jobLink}})\n[[כפתור: לחצו | {{jobLink}}]]', { jobLink: 'javascript:alert(1)' });
  assert.ok(!r.html.includes('href'), r.html);
  assert.ok(!r.html.includes('javascript:'));
});

test('rendering: a subject never carries a new line (header injection)', () => {
  const r = renderTemplate('קוד {{code}}', '{{code}}', { code: '1\r\nBcc: x@example.com' });
  assert.ok(!/[\r\n]/.test(r.subject));
});

const SECRET = 'whsec_' + Buffer.from('test-secret-key-0123456789abcdef').toString('base64');

test('webhook signature: Svix scheme, raw body, timestamp window, several signatures', () => {
  const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'e1', to: ['a@example.com'], bounce: { type: 'Permanent' } } });
  const now = 1_800_000_000;
  const sig = signSvix(SECRET, 'msg_1', now, body);
  assert.deepEqual(verifySvix(SECRET, { id: 'msg_1', timestamp: String(now), signature: sig }, body, now), { ok: true });
  assert.deepEqual(verifySvix(SECRET, { id: 'msg_1', timestamp: String(now), signature: `v1,AAAA ${sig}` }, Buffer.from(body), now), { ok: true });
  assert.equal(verifySvix(SECRET, { id: 'msg_1', timestamp: String(now), signature: sig }, body + ' ', now).ok, false, 'changed body');
  assert.equal(verifySvix(SECRET, { id: 'msg_2', timestamp: String(now), signature: sig }, body, now).ok, false, 'other id');
  assert.deepEqual(verifySvix(SECRET, { id: 'msg_1', timestamp: String(now), signature: sig }, body, now + 301), { ok: false, reason: 'stale' });
  assert.deepEqual(verifySvix(undefined, { id: 'msg_1', timestamp: String(now), signature: sig }, body, now), { ok: false, reason: 'no_secret' });
  assert.deepEqual(verifySvix(SECRET, { id: 'msg_1', timestamp: String(now) }, body, now), { ok: false, reason: 'missing_headers' });
  const other = 'whsec_' + Buffer.from('another-secret').toString('base64');
  assert.equal(verifySvix(other, { id: 'msg_1', timestamp: String(now), signature: sig }, body, now).ok, false, 'other secret');
});

test('webhook events: permanent bounce, complaint and suppression stop sending; a temporary bounce does not', () => {
  const ev = (type: string, extra: Record<string, unknown> = {}) => interpretEvent({ type, data: { email_id: 'e1', to: ['a@example.com'], ...extra } });
  assert.deepEqual(ev('email.bounced', { bounce: { type: 'Permanent' } }), { emailId: 'e1', recipients: ['a@example.com'], status: 'bounced', suppress: 'bounce' });
  assert.equal(ev('email.bounced', { bounce: { type: 'Transient' } }).suppress, null);
  assert.equal(ev('email.complained').suppress, 'complaint');
  assert.equal(ev('email.suppressed').suppress, 'resend_suppressed');
  assert.deepEqual([ev('email.delivered').status, ev('email.delivered').suppress], ['delivered', null]);
  assert.deepEqual([ev('email.opened').status, ev('email.opened').suppress], [null, null]);
  assert.deepEqual(interpretEvent(null), { emailId: null, recipients: [], status: null, suppress: null });
});
