// The two documents required by the Privacy Protection (Data Security) Regulations, 2017 — the database definition
// document (reg. 2) and the security procedure (reg. 4). Both are shown on /privacy AND written to docs/privacy/*.md
// from here (one source of truth): `cd server && npx tsx ../docs/privacy/build-docs.ts`.
// Plain language (owner, 20.11.2026): short, each fact once, what is done — not the internal numbers (limits, alert
// thresholds, review periods, backup times), which live in server/src/security/pure.ts and docs/security.md.
// server/test/privacy.test.ts fails if a number creeps in or if the .md files differ. Every sentence must stay TRUE of
// the code. No secret names, settings, internal addresses or anything else that maps the attack surface.
// Pure module (no JSX) so the tests can import it.

export const PRIVACY_UPDATED = '23.11.2026';
/** The version id of this text = server/src/security/consent.ts TERMS_VERSION (checked by server/test/privacy.test.ts).
 *  Each version is kept as published (server/privacy-versions/<id>.html): after changing any text here or on the
 *  page, bump both and run `cd client && npm run snapshot:privacy`. */
export const PRIVACY_VERSION = '2026-11-23-b';
/** How long a cookie choice is kept before the banner asks again (CONSENT_MAX_AGE_DAYS = 365). */
export const PRIVACY_CONSENT_MONTHS = 12;

/** Not yet named by the owner — replace with a name and role (shown publicly). */
export const SECURITY_OFFICER = '[למילוי: שם ותפקיד הממונה על אבטחת המידע]';

export interface DocSection { heading: string; paragraphs?: string[]; items?: string[] }
export interface PrivacyDocument { id: string; title: string; intro: string; sections: DocSection[] }

export const DATABASE_DEFINITION: PrivacyDocument = {
  id: 'database-definition',
  title: 'מסמך הגדרות מאגר',
  intro: 'לפי תקנה 2 לתקנות הגנת הפרטיות (אבטחת מידע), התשע"ז-2017. המאגר: המועמדים והמשרות של לוח המשרות של SKEELZ.',
  sections: [
    {
      heading: 'מטרות המאגר',
      paragraphs: ['פרסום משרות, גיוס והשמה של מועמדים, קשר עם מועמדים ומעסיקים (כולל הודעות שירות במייל), דיוור למי שהסכים לכך ואבטחת המידע.'],
    },
    {
      heading: 'סוגי המידע',
      items: [
        'מועמדים: פרטים אישיים ופרטי קשר, מספר תעודת זהות, כישורים, קורות חיים, הגשות ותשובות לשאלות נוספות שהצוות הוסיף לטופס.',
        'מעסיקים: פרטי המשרה ופרטי איש הקשר.',
        'אנשי צוות: שם, מייל ותפקיד.',
        'הסכמות לתנאים ולדיוור, רשימת מי שביקש הסרה מדיוור (כקוד שאי אפשר לשחזר ממנו את הכתובת), ויומן פעילות עם כתובות IP ופרטי דפדפן.',
      ],
      paragraphs: ['מידע רגיש: מספר תעודת זהות, תאריך לידה, מגדר וקורות חיים.'],
    },
    {
      heading: 'מקורות המידע',
      paragraphs: ['המידע מגיע מהמועמדים, מהמעסיקים ומאנשי הצוות עצמם, ומאתר המשרות הקודם של SKEELZ ומערכות קודמות שלנו: המשרות שפורסמו שם, ופרטי מועמדים שנרשמו שם. פרטי המועמדים מועתקים לכאן ומחוברים לחשבון לפי כתובת מייל מאומתת. קורות החיים שלהם נשארים במערכת ניהול הקשרים ונפתחים רק לפי צורך.'],
    },
    {
      heading: 'העברת המידע ומקום החזקתו',
      paragraphs: ['המידע עובר למעסיקים (רק מה שהצוות העביר להם), לספקי שירות בישראל ובחו"ל ולצדדים שלישיים לפי הסכמים עם העמותה. הוא נשמר אצל ספק אירוח מנוהל, ועשוי להיות מוחזק מחוץ לישראל.'],
    },
    {
      heading: 'הסיכונים העיקריים',
      items: [
        'השתלטות על חשבון של איש צוות.',
        'משיכה המונית של פרטי מועמדים, גם בידי מי שמורשה לראות אותם.',
        'מעסיק שמנסה לראות מועמדים שלא הועברו אליו.',
        'חשיפה של מידע אצל ספק שירות.',
        'קבצים זדוניים שמועלים לאתר.',
        'שימוש לרעה במספר תעודת זהות, או בגיל ובמגדר כדי להפלות.',
      ],
    },
    {
      heading: 'אחריות',
      paragraphs: [`בעלת המאגר: העמותה. הממונה על אבטחת המידע ואיש הקשר לפניות: ${SECURITY_OFFICER}.`],
    },
  ],
};

export const SECURITY_PROCEDURE: PrivacyDocument = {
  id: 'security-procedure',
  title: 'נוהל אבטחת מידע',
  intro: 'לפי תקנה 4 לתקנות הגנת הפרטיות (אבטחת מידע), התשע"ז-2017. הנוהל חל על כל מי שעובד עם המאגר.',
  sections: [
    {
      heading: 'הרשאות',
      items: [
        'חשבון אחד יכול להיות של מועמד, של מעסיק ושל איש צוות. כל תפקיד רואה רק את מה שהוא צריך. ההרשאה נבדקת בשרת בכל בקשה.',
        'צפייה בפרטי מועמדים ובקורות חיים מוגבלת ביום. רק מנהל מערכת יכול להגדיל את המגבלה, ולמעסיקים היא לא מוגדלת.',
        'השבתה של חשבון או שינוי תפקיד חלים מיד.',
      ],
    },
    {
      heading: 'הזדהות',
      paragraphs: ['אין סיסמאות. הרשאות של איש צוות פועלות רק בכניסה עם חשבון Google. מועמדים ומעסיקים נכנסים גם עם חשבון Microsoft או עם קוד חד-פעמי שנשלח למייל.'],
    },
    {
      heading: 'תיעוד ובקרה',
      paragraphs: ['כל כניסה, כל צפייה בפרטי מועמדים וכל פעולת ניהול נרשמות ביומן לפני שהמידע מוצג. אי אפשר לשנות את היומן, והוא נשמר לפי התקנות. מנהלי המערכת מקבלים התראות על שימוש חריג ועל כניסות חריגות ובודקים אותן.'],
    },
    {
      heading: 'אירוח, גיבויים וספקים',
      paragraphs: ['המערכת מתארחת אצל ספק אירוח מנוהל, התקשורת מוצפנת והמידע מגובה באופן קבוע. ספק שירות מקבל רק את המידע שהוא צריך, וחיבור לשירות חיצוני מופעל רק בהחלטה של העמותה.'],
    },
    {
      heading: 'סקירות',
      paragraphs: ['מנהל מערכת בודק באופן קבוע שכל איש צוות עדיין צריך את הגישה שלו. הנוהל ומסמך הגדרות המאגר נבדקים לפחות פעם בשנה ובכל שינוי מהותי.'],
    },
    {
      heading: 'אירוע אבטחה',
      paragraphs: ['מי שחושד באירוע מדווח מיד לממונה על אבטחת המידע. חוסמים את הגישה שנפגעה, בודקים ביומן מה נחשף, מתעדים, ומדווחים לרשות להגנת הפרטיות ולמי שנפגע כנדרש בדין.'],
    },
    {
      heading: 'חובות אנשי הצוות',
      items: [
        'לשמור על סודיות ולהשתמש במידע רק לצורך התפקיד.',
        'לא לשתף את החשבון, ולהפעיל אימות דו-שלבי בחשבון Google.',
        'לא לשמור מידע על מועמדים במחשב או בטלפון מעבר לנדרש, ולמחוק קובץ שהורד כשאין בו צורך.',
        'לדווח מיד על חשד לשימוש לרעה או לדליפה.',
      ],
    },
  ],
};

export const PRIVACY_DOCUMENTS: PrivacyDocument[] = [DATABASE_DEFINITION, SECURITY_PROCEDURE];

/** The docs/privacy/<id>.md file for a document (the test compares the file with this). */
export function toMarkdown(doc: PrivacyDocument): string {
  const out = [
    `# ${doc.title} — לוח המשרות של SKEELZ`,
    '',
    `<!-- Generated from client/src/components/privacy/privacyTexts.ts — edit there, then: cd server && npx tsx ../docs/privacy/build-docs.ts -->`,
    '',
    `עודכן ב-${PRIVACY_UPDATED}. ${doc.intro} מוצג גם בעמוד \`/privacy#${doc.id}\`.`,
  ];
  for (const s of doc.sections) {
    out.push('', `## ${s.heading}`, '');
    if (s.items) out.push(...s.items.map((i) => `- ${i}`));
    if (s.items && s.paragraphs) out.push('');
    if (s.paragraphs) out.push(s.paragraphs.join('\n\n'));
  }
  return out.join('\n') + '\n';
}
