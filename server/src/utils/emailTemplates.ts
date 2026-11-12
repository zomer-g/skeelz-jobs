import appConfig from '../config/appConfig.js';
import { Guest } from '../models/interfaces/general.interface.js';
import { Job } from '../models/schemas/jobs.js';
import IUser from '../models/schemas/user.js';
import { formatToIsraelTime } from './utils.js';

export const generatePasswordResetEmail = (token: string): { subject: string, text: string } => {
  const tokenLifeInMinutes = Math.round(appConfig.passwordResetTokenLifeSeconds / 60);
  const subject = 'בקשה לאיפוס סיסמה';
  const text = `
נשלחה בקשה לאיפוס הסיסמה שלך.

השתמש בקישור הבא כדי לאפס את הסיסמה שלך:
${appConfig.clientBaseUrl}/reset-password?token=${token}

שים לב: קישור זה יפוג בעוד ${tokenLifeInMinutes} דקות.`;

  return { subject, text };
};

export const generateWelcomeEmail = (user: IUser): { subject: string; text: string } => {
  const subject = 'ברוכים הבאים לסקילז!';
  const text = `שלום ${user.firstName},

    שמחים שהצטרפת לקהילה שלנו, אפשר להתחיל לחפש את העבודה הבאה שלך.

   במידה ולא העלאת קורות חיים בתהליך ההרשמה, יש לשלוח אלינו במייל חוזר את קורות החיים המעודכנים שלך ל- ${process.env.SUPPORT_EMAIL}.
  `;

  return { subject, text };
};

export const generateApplyJobEmail = (user: IUser, job: Job): { subject: string; text: string } => {
  const subject = `מועמדות חדשה למשרה: ${job.title}`;
  
  // Current time in Israel's timezone
  const applicationTime = formatToIsraelTime(new Date());

  const text = `שלום צוות גיוס,

    ${user.firstName} ${user.lastName} (${user.email}) הגיש/ה מועמדות למשרה ${job.title} ב-${job.companyName}.
    פרטי המועמד.ת:
    - שם: ${user.firstName} ${user.lastName}
    - אימייל: ${user.email}
    - טלפון: ${user.phoneNumber}

    פרטי המשרה:
    - מזהה משרה: ${job.jobId}
    - שם משרה: ${job.title}
    - מיקום: ${job.location?.city ?? ''}
    - חברה: ${job.companyName}
    - תאריך פרסום המשרה: ${formatToIsraelTime(new Date(job.publishDate))}
    - איש קשר: ${job.contactPersonName || 'לא צוין'}
    - אימייל איש קשר: ${job.contactPersonEmail || 'לא צוין'}
    - טלפון איש קשר: ${job.contactPersonPhone || 'לא צוין'}
    - סוג הגשה: ${job.isSelfApply? 'הוגש באופן עצמאי' : '-הגשה ישירה לSKEELZ'}
    זמן הגשת מועמדות: ${applicationTime}

    נא לעיין בפרטי המועמדות ולפעול בהתאם.

    בברכה,
    צוות האתר
  `;

  return { subject, text };
};

export const generateGuestApplyJobEmail = (guest: Guest, job: Job): { subject: string; text: string } => {
  const subject = ` מועמדות חדשה למשרה:  ${job.title}`;
  
  const applicationTime = formatToIsraelTime(new Date());

  const text = `שלום צוות גיוס,

    ${guest.fullName} (${guest.email}) הגיש/ה מועמדות למשרה ${job.title} ב-${job.companyName}.
    פרטי המועמד.ת:
    - שם: ${guest.fullName}
    - אימייל: ${guest.email}

    פרטי המשרה:
    - מזהה משרה: ${job.jobId}
    - שם משרה: ${job.title}
    - מיקום: ${job.location?.city ?? ''}
    - חברה: ${job.companyName}
    - תאריך פרסום המשרה: ${formatToIsraelTime(new Date(job.publishDate))}
    - איש קשר: ${job.contactPersonName || 'לא צוין'}
    - אימייל איש קשר: ${job.contactPersonEmail || 'לא צוין'}
    - טלפון איש קשר: ${job.contactPersonPhone || 'לא צוין'}
    - סוג הגשה: ${job.isSelfApply? 'הוגש באופן עצמאי' : '-הגשה ישירה לSKEELZ - ליד (אורח)'}
    זמן הגשת מועמדות: ${applicationTime}

    נא לעיין בפרטי המועמדות ולפעול בהתאם.

    בברכה,
    צוות האתר
  `;

  return { subject, text };
};
/** A new staff account (staff screen): staff sign in only with "Continue with Google" (xhostd SSO), never a password. */
export const generateStaffInviteEmail = (role: string): { subject: string; text: string } => {
  const roleName = role === 'admin' ? 'מנהל/ת מערכת' : 'מנהל/ת תוכן';
  const subject = 'הוספת לצוות לוח המשרות של סקילז';
  const text = `שלום,

נוספת לצוות לוח המשרות של סקילז בתפקיד ${roleName}.

כדי להיכנס: באתר ${appConfig.clientBaseUrl || ''} לוחצים "התחברות" ואז "המשך עם Google", ונכנסים עם חשבון ה-Google של כתובת המייל הזאת.
אנשי צוות נכנסים רק כך — אין סיסמה לחשבון צוות.`;
  return { subject, text };
};
