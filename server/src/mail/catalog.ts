/* ============================================================================
 *  The service emails the site sends ("events"), each with its own template (docs/mail.md).
 *
 *  Pure: no DB, no network. For every kind: who receives it, the closed list of parameters a template may use
 *  (with a sample value for the preview and the test send), the parameters a template must keep, whether it is on
 *  when nobody has set it, and the default text, used whenever no template is published (or a published one
 *  cannot be rendered). Service mail only: marketing mail is not sent from here.
 *
 *  Template markup (render.ts): a blank line starts a paragraph; "# " a heading line; "- " a list item;
 *  **bold**; [text](https://… or {{aLinkParameter}}); a button on its own line: [[כפתור: text | {{aLinkParameter}}]].
 * ========================================================================== */

export type MailAudience = 'candidate' | 'employer' | 'staff' | 'team';

export interface MailParam {
  name: string;
  label: string;
  sample: string;
  /** A link the server builds (siteUrl, jobLink…): the only parameters allowed as a link / button target. */
  link?: boolean;
}

export interface MailKind {
  kind: string;
  audience: MailAudience;
  label: string;
  /** When it is sent, in a sentence (shown on the screen). */
  when: string;
  params: MailParam[];
  /** Parameters a template must contain (subject or body), or it is not saved. */
  required?: string[];
  /** On when nobody has set it. New candidate / employer events start off: the owner turns them on. */
  defaultEnabled: boolean;
  /** false: cannot be turned off (the sign-in code, while email sign-in is on). */
  canDisable: boolean;
  defaultSubject: string;
  defaultBody: string;
}

const SITE: MailParam = { name: 'siteUrl', label: 'כתובת האתר', sample: 'https://j.skeelz.co.il', link: true };
const JOB_TITLE: MailParam = { name: 'jobTitle', label: 'שם המשרה', sample: 'רכז/ת לוגיסטיקה' };
const COMPANY: MailParam = { name: 'companyName', label: 'שם החברה', sample: 'חברה לדוגמה בע"מ' };
const FIRST: MailParam = { name: 'firstName', label: 'שם פרטי', sample: 'נועה' };
const JOB_LINK: MailParam = { name: 'jobLink', label: 'קישור למשרה', sample: 'https://j.skeelz.co.il/job/000000000000000000000000', link: true };
const REASON: MailParam = { name: 'reason', label: 'הסיבה (מה שהצוות כתב)', sample: 'חסרים פרטים על היקף המשרה.' };
const SIGN = 'צוות סקילז';

export const MAIL_KINDS: readonly MailKind[] = [
  // ---- candidates ----------------------------------------------------------------------------------------------
  {
    kind: 'sign_in_code', audience: 'candidate', label: 'קוד כניסה במייל',
    when: 'מועמד או מעסיק ביקש קוד כניסה ("קבלת קוד למייל").',
    params: [{ name: 'code', label: 'הקוד', sample: '123456' }, { name: 'minutes', label: 'דקות בתוקף', sample: '10' }, SITE],
    required: ['code'], defaultEnabled: true, canDisable: false,
    defaultSubject: 'קוד הכניסה שלך לסקילז: {{code}}',
    defaultBody: `שלום,

קוד הכניסה שלך ללוח המשרות של סקילז הוא:
# {{code}}

הקוד בתוקף {{minutes}} דקות ואפשר להשתמש בו פעם אחת בלבד.
אם לא ביקשת להיכנס ל-{{siteUrl}}, אפשר להתעלם מההודעה. אף אחד לא יוכל להיכנס בלי הקוד.

${SIGN}`,
  },
  {
    kind: 'welcome', audience: 'candidate', label: 'ברוכים הבאים',
    when: 'מועמד חדש סיים להירשם, או חשבון קיים (מעסיק, איש צוות) הוסיף לעצמו תפקיד מועמד.',
    params: [FIRST, SITE, { name: 'profileLink', label: 'קישור לאזור האישי', sample: 'https://j.skeelz.co.il/?profile=1', link: true }],
    defaultEnabled: true, canDisable: true,
    defaultSubject: 'ברוכים הבאים לסקילז!',
    defaultBody: `שלום {{firstName}},

שמחים שהצטרפת לקהילה שלנו, אפשר להתחיל לחפש את העבודה הבאה שלך.

אם לא העלית קורות חיים בהרשמה, אפשר להעלות או לעדכן אותם בכל עת באתר ({{siteUrl}}): "אזור אישי" ואז "הפרטים שלי".`,
  },
  {
    kind: 'application_received', audience: 'candidate', label: 'אישור הגשת מועמדות',
    when: 'מועמד (רשום או בלי חשבון) הגיש מועמדות למשרה דרך האתר.',
    params: [FIRST, JOB_TITLE, COMPANY, JOB_LINK, SITE],
    defaultEnabled: false, canDisable: true,
    defaultSubject: 'קיבלנו את המועמדות שלך: {{jobTitle}}',
    defaultBody: `שלום {{firstName}},

קיבלנו את המועמדות שלך למשרה **{{jobTitle}}** ב-{{companyName}}.
הצוות שלנו יעבור עליה, ואם יש התאמה ניצור איתך קשר.

[[כפתור: למודעת המשרה | {{jobLink}}]]

${SIGN}`,
  },
  {
    kind: 'application_forwarded', audience: 'candidate', label: 'המועמדות הועברה למעסיק',
    when: 'הצוות העביר את המועמדות למעסיק ("העברה למעסיק").',
    params: [FIRST, JOB_TITLE, COMPANY, SITE],
    defaultEnabled: false, canDisable: true,
    defaultSubject: 'המועמדות שלך הועברה למעסיק: {{jobTitle}}',
    defaultBody: `שלום {{firstName}},

הצוות שלנו העביר את המועמדות שלך למשרה **{{jobTitle}}** אל {{companyName}}.
המעסיק רואה את השם וקורות החיים שלך. אם יש התאמה, הוא או אנחנו ניצור איתך קשר.

בהצלחה!
${SIGN}`,
  },
  {
    kind: 'job_closed', audience: 'candidate', label: 'משרה שהגשת אליה נסגרה',
    when: 'משרה שהמועמד הגיש אליה הפסיקה להיות פעילה (נסגרה או הוסרה מהלוח). נשלח פעם אחת לכל משרה.',
    params: [FIRST, JOB_TITLE, COMPANY, SITE],
    defaultEnabled: false, canDisable: true,
    defaultSubject: 'המשרה {{jobTitle}} נסגרה',
    defaultBody: `שלום {{firstName}},

המשרה **{{jobTitle}}** ב-{{companyName}}, שהגשת אליה מועמדות, כבר לא פעילה.
תודה על ההתעניינות. משרות חדשות מחכות לך בלוח המשרות.

[[כפתור: ללוח המשרות | {{siteUrl}}]]

${SIGN}`,
  },
  // ---- employers -----------------------------------------------------------------------------------------------
  {
    kind: 'employer_new_applicant', audience: 'employer', label: 'מועמד חדש הועבר אליך (למעסיק)',
    when: 'הצוות העביר מועמד למשרה של המעסיק. המייל לא כולל פרטים של המועמד, רק הזמנה לאזור המעסיק.',
    params: [FIRST, JOB_TITLE, { name: 'areaLink', label: 'קישור לאזור המעסיק', sample: 'https://j.skeelz.co.il/employer', link: true }, SITE],
    defaultEnabled: false, canDisable: true,
    defaultSubject: 'מועמד חדש למשרה {{jobTitle}}',
    defaultBody: `שלום {{firstName}},

הצוות של סקילז העביר אליך מועמד חדש למשרה **{{jobTitle}}**.
את השם וקורות החיים אפשר לראות באזור המעסיק.

[[כפתור: לאזור המעסיק | {{areaLink}}]]

${SIGN}`,
  },
  {
    kind: 'submission_approved', audience: 'employer', label: 'המשרה שהגשת פורסמה',
    when: 'הצוות אישר משרה שמעסיק שלח בטופס המעסיקים.',
    params: [{ name: 'contactName', label: 'שם איש הקשר', sample: 'דני' }, JOB_TITLE, JOB_LINK, SITE],
    defaultEnabled: false, canDisable: true,
    defaultSubject: 'המשרה שלך פורסמה: {{jobTitle}}',
    defaultBody: `שלום {{contactName}},

המשרה **{{jobTitle}}** שנשלחה אלינו אושרה ופורסמה בלוח המשרות של סקילז.

[[כפתור: למודעת המשרה | {{jobLink}}]]

${SIGN}`,
  },
  {
    kind: 'submission_rejected', audience: 'employer', label: 'המשרה שהגשת לא פורסמה',
    when: 'הצוות דחה משרה שמעסיק שלח בטופס המעסיקים.',
    params: [{ name: 'contactName', label: 'שם איש הקשר', sample: 'דני' }, JOB_TITLE, REASON, SITE],
    defaultEnabled: false, canDisable: true,
    defaultSubject: 'המשרה {{jobTitle}} לא פורסמה',
    defaultBody: `שלום {{contactName}},

בדקנו את המשרה **{{jobTitle}}** שנשלחה אלינו, והפעם לא נפרסם אותה.
{{reason}}

אפשר לשלוח משרה מעודכנת בטופס המעסיקים באתר ({{siteUrl}}).

${SIGN}`,
  },
  {
    kind: 'edit_request_approved', audience: 'employer', label: 'בקשת העריכה אושרה',
    when: 'הצוות אישר בקשה של מעסיק לערוך משרה שלו.',
    params: [FIRST, JOB_TITLE, JOB_LINK, SITE],
    defaultEnabled: false, canDisable: true,
    defaultSubject: 'השינויים במשרה {{jobTitle}} אושרו',
    defaultBody: `שלום {{firstName}},

השינויים שביקשת במשרה **{{jobTitle}}** אושרו ומופיעים עכשיו במודעה.

[[כפתור: למודעת המשרה | {{jobLink}}]]

${SIGN}`,
  },
  {
    kind: 'edit_request_rejected', audience: 'employer', label: 'בקשת העריכה לא אושרה',
    when: 'הצוות דחה בקשה של מעסיק לערוך משרה שלו.',
    params: [FIRST, JOB_TITLE, REASON, SITE],
    defaultEnabled: false, canDisable: true,
    defaultSubject: 'השינויים במשרה {{jobTitle}} לא אושרו',
    defaultBody: `שלום {{firstName}},

השינויים שביקשת במשרה **{{jobTitle}}** לא אושרו.
{{reason}}

אפשר לשלוח בקשה חדשה מאזור המעסיק ({{siteUrl}}).

${SIGN}`,
  },
  // ---- staff ---------------------------------------------------------------------------------------------------
  {
    kind: 'staff_invite', audience: 'staff', label: 'הזמנת איש צוות',
    when: 'מנהל מערכת הוסיף איש צוות: כתובת חדשה, או חשבון קיים (מועמד, מעסיק) שקיבל תפקיד צוות. לא נשלח כשרק התפקיד של איש צוות משתנה.',
    params: [{ name: 'roleName', label: 'התפקיד', sample: 'מנהל/ת תוכן' }, SITE],
    defaultEnabled: true, canDisable: true,
    defaultSubject: 'הוספת לצוות לוח המשרות של סקילז',
    defaultBody: `שלום,

נוספת לצוות לוח המשרות של סקילז בתפקיד {{roleName}}.

כדי להיכנס: באתר {{siteUrl}} לוחצים "התחברות" ואז "המשך עם Google", ונכנסים עם חשבון ה-Google של כתובת המייל הזאת.
אנשי צוות נכנסים רק כך. אין סיסמה לחשבון צוות.`,
  },
  {
    kind: 'staff_new_application', audience: 'team', label: 'מועמדות חדשה (לתיבת הצוות)',
    when: 'מועמד הגיש מועמדות. נשלח לתיבת הצוות שהוגדרה בשרת.',
    params: [
      { name: 'candidateName', label: 'שם המועמד', sample: 'נועה כהן' },
      { name: 'candidateEmail', label: 'מייל המועמד', sample: 'noa@example.com' },
      { name: 'candidatePhone', label: 'טלפון המועמד', sample: '050-0000000' },
      { name: 'applicantType', label: 'סוג מועמד', sample: 'רשום/ה באתר' },
      JOB_TITLE, { name: 'jobNumber', label: 'מספר משרה', sample: '1234' }, COMPANY,
      { name: 'city', label: 'מיקום', sample: 'תל אביב' },
      { name: 'publishDate', label: 'תאריך פרסום', sample: '20/11/2026' },
      { name: 'contactPersonName', label: 'איש קשר', sample: 'לא צוין' },
      { name: 'contactPersonEmail', label: 'מייל איש קשר', sample: 'לא צוין' },
      { name: 'contactPersonPhone', label: 'טלפון איש קשר', sample: 'לא צוין' },
      { name: 'applyType', label: 'סוג הגשה', sample: 'הגשה ישירה ל-SKEELZ' },
      { name: 'applicationTime', label: 'זמן ההגשה', sample: '23/11/2026 10:00' },
    ],
    defaultEnabled: true, canDisable: true,
    defaultSubject: 'מועמדות חדשה למשרה: {{jobTitle}}',
    defaultBody: `שלום צוות גיוס,

{{candidateName}} ({{candidateEmail}}) הגיש/ה מועמדות למשרה {{jobTitle}} ב-{{companyName}}.

**פרטי המועמד.ת:**
- שם: {{candidateName}}
- אימייל: {{candidateEmail}}
- טלפון: {{candidatePhone}}
- סוג: {{applicantType}}

**פרטי המשרה:**
- מזהה משרה: {{jobNumber}}
- שם משרה: {{jobTitle}}
- מיקום: {{city}}
- חברה: {{companyName}}
- תאריך פרסום המשרה: {{publishDate}}
- איש קשר: {{contactPersonName}}
- אימייל איש קשר: {{contactPersonEmail}}
- טלפון איש קשר: {{contactPersonPhone}}
- סוג הגשה: {{applyType}}

זמן הגשת מועמדות: {{applicationTime}}

נא לעיין בפרטי המועמדות ולפעול בהתאם.

בברכה,
צוות האתר`,
  },
  {
    kind: 'staff_job_submission', audience: 'team', label: 'משרה חדשה ממתינה לאישור (לתיבת הצוות)',
    when: 'מעסיק שלח משרה בטופס המעסיקים. נשלח לתיבת הצוות שהוגדרה בשרת.',
    params: [JOB_TITLE, COMPANY, { name: 'submissionId', label: 'מזהה ההגשה', sample: 'sub_000' },
      { name: 'reviewLink', label: 'קישור למסך האישור', sample: 'https://j.skeelz.co.il/jobs-management/submissions', link: true }],
    defaultEnabled: true, canDisable: true,
    defaultSubject: 'משרה חדשה ממתינה לאישור',
    defaultBody: `משרה חדשה נשלחה בטופס המעסיקים וממתינה לאישור.
משרה: {{jobTitle}}
חברה: {{companyName}}
מזהה: {{submissionId}}

[[כפתור: לאישור | {{reviewLink}}]]`,
  },
];

const BY_KIND = new Map(MAIL_KINDS.map((k) => [k.kind, k]));
export const mailKind = (kind: unknown): MailKind | undefined => (typeof kind === 'string' ? BY_KIND.get(kind) : undefined);
export const isMailKind = (kind: unknown): kind is string => mailKind(kind) !== undefined;

/** Sample values of a kind (preview and test send: never a real person's data). */
export const sampleValues = (k: MailKind): Record<string, string> => Object.fromEntries(k.params.map((p) => [p.name, p.sample]));

export const AUDIENCE_LABELS: Record<MailAudience, string> = {
  candidate: 'למועמדים', employer: 'למעסיקים', staff: 'לאנשי צוות', team: 'לתיבת הצוות',
};
