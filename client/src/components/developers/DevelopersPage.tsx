// Public page (/developers): how to use the public read-only API (/api/public/v1) and MCP server (/mcp).
// Every sentence must stay TRUE of server/src/public/. The numbers and the tool list below are checked
// against PUBLIC_LIMITS / PUBLIC_MCP_TOOLS by server/test/public.test.mjs.
import React from 'react';
import { ClientRoutes } from '../../i18n/ClientRoutes.enum';

export const DEVELOPER_NUMBERS = { restPerMinute: 120, mcpPerMinute: 60, maxPageSize: 100, defaultPageSize: 20, maxRadiusKm: 200 };
export const DEVELOPER_MCP_TOOLS = ['search_jobs', 'get_job', 'jobs_near', 'list_locations', 'list_skills'];

const N = DEVELOPER_NUMBERS;
const SITE = typeof window !== 'undefined' ? window.location.origin : 'https://jobs.skeelz.co.il';
const API = `${SITE}/api/public/v1`;
const MCP = `${SITE}/mcp`;

const Code: React.FC<{ children: string }> = ({ children }) => (
  <pre className="dev-page__code" dir="ltr" tabIndex={0}><code>{children}</code></pre>
);
const C: React.FC<{ children: React.ReactNode }> = ({ children }) => <code dir="ltr" className="dev-page__inline">{children}</code>;

const ENDPOINTS: [string, string][] = [
  ['/jobs', 'חיפוש משרות פעילות, החדשות קודם. סינון לפי טקסט, מיקום, כישורים והיקף משרה.'],
  ['/jobs/near', 'משרות בטווח של עד ' + N.maxRadiusKm + ' ק"מ מנקודה בישראל, הקרובות קודם, עם מרחק בק"מ.'],
  ['/jobs/{id}', 'משרה אחת לפי מזהה (24 תווי hex) או מספר משרה, כולל התיאור המלא.'],
  ['/locations', 'יישובים ואזורים (סמל יישוב, שם, אזור, קואורדינטות).'],
  ['/skills', 'הכישורים שמשרות יכולות לדרוש (מזהה ושם).'],
  ['/openapi.json', 'תיאור מלא של ה-API בפורמט OpenAPI.'],
];

const PARAMS: [string, string][] = [
  ['q', 'טקסט חופשי בעברית או באנגלית: כותרת, תיאור או שם החברה'],
  ['location', 'שמות יישובים, שמות אזורים או סמלי יישוב, מופרדים בפסיק. משרות מהבית תמיד נכללות'],
  ['skills', 'מזהים או שמות של כישורים, מופרדים בפסיק'],
  ['scope', 'FullTime, PartialTime (משרה מלאה / חלקית)'],
  ['lat, lng, radiusKm', 'חיפוש לפי מרחק מנקודה (ב-/jobs/near חובה)'],
  ['page, limit', `עמוד (מ-1) ומספר תוצאות בעמוד: ברירת מחדל ${N.defaultPageSize}, לכל היותר ${N.maxPageSize}`],
];

const TOOLS: Record<string, string> = {
  search_jobs: 'חיפוש משרות לפי טקסט, מיקום, כישורים והיקף משרה',
  get_job: 'משרה אחת עם התיאור המלא',
  jobs_near: 'משרות ליד נקודה, הקרובות קודם',
  list_locations: 'יישובים ואזורים, לסינון ולקואורדינטות',
  list_skills: 'רשימת הכישורים',
};

export default function DevelopersPage() {
  return (
    <div className="board-frame dev-page" dir="rtl">
      <h1 className="dev-page__title font-EzerRegularLoft">API ו-MCP למפתחים</h1>
      <p className="dev-page__lead">
        המשרות שמתפרסמות בלוח של SKEELZ פתוחות גם לתוכנות ולעוזרי AI: ממשק API לקריאה בלבד, ושרת MCP עם אותו מידע.
        בלי הרשמה ובלי מפתח.
      </p>

      <section className="dev-page__section" aria-labelledby="dev-what">
        <h2 id="dev-what">מה אפשר לקבל</h2>
        <ul>
          <li>רק משרות פעילות, ורק מה שממילא מופיע בדף המשרה באתר: כותרת, חברה, תיאור, מיקום, כישורים, היקף, תאריך פרסום וקישור לדף המשרה.</li>
          <li>לעולם לא מועמדים, הגשות מועמדות, קורות חיים או פרטי אנשי קשר.</li>
          <li>קריאה בלבד: אי אפשר לשנות דבר דרך ה-API או ה-MCP. מועמדות מגישים בדף המשרה באתר (השדה <C>url</C> בכל משרה).</li>
        </ul>
      </section>

      <section className="dev-page__section" aria-labelledby="dev-api">
        <h2 id="dev-api">ה-API</h2>
        <p>כתובת הבסיס:</p>
        <Code>{API}</Code>
        <p>כל הבקשות הן <C>GET</C> (שיטה אחרת מחזירה 405). התשובות ב-JSON.</p>

        <div className="dev-page__table-wrap" tabIndex={0} role="region" aria-label="נקודות קצה">
          <table className="dev-page__table">
            <caption className="visually-hidden">נקודות הקצה של ה-API</caption>
            <thead><tr><th scope="col">נתיב</th><th scope="col">מה מחזיר</th></tr></thead>
            <tbody>
              {ENDPOINTS.map(([path, what]) => (
                <tr key={path}><td><C>{path}</C></td><td>{what}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3>פרמטרים לחיפוש משרות</h3>
        <ul className="dev-page__params">
          {PARAMS.map(([name, what]) => <li key={name}><C>{name}</C> — {what}</li>)}
        </ul>
        <p>
          רשימות חוזרות בצורה <C>{'{ data, page, limit, total }'}</C>. התשובות כוללות <C>ETag</C> ו-<C>Cache-Control</C>,
          ו-CORS פתוח לכל אתר (בלי עוגיות).
        </p>

        <h3>דוגמאות</h3>
        <Code>{`curl '${API}/jobs?q=data&limit=5'
curl '${API}/jobs?location=חיפה&scope=FullTime'
curl '${API}/jobs/near?lat=32.0853&lng=34.7818&radiusKm=15'`}</Code>
        <p>
          <a className="dev-page__link" href={`${API}/openapi.json`} target="_blank" rel="noopener noreferrer">
            מפרט OpenAPI (openapi.json)<span className="visually-hidden"> (נפתח בחלון חדש)</span>
          </a>
        </p>
      </section>

      <section className="dev-page__section" aria-labelledby="dev-mcp">
        <h2 id="dev-mcp">שרת MCP</h2>
        <p>
          אותו מידע ככלים לעוזרי AI שתומכים ב-Model Context Protocol (למשל Claude). חיבור Streamable HTTP, בלי הזדהות:
        </p>
        <Code>{MCP}</Code>

        <div className="dev-page__table-wrap" tabIndex={0} role="region" aria-label="כלי MCP">
          <table className="dev-page__table">
            <caption className="visually-hidden">הכלים של שרת ה-MCP</caption>
            <thead><tr><th scope="col">כלי</th><th scope="col">מה עושה</th></tr></thead>
            <tbody>
              {DEVELOPER_MCP_TOOLS.map((t) => (
                <tr key={t}><td><C>{t}</C></td><td>{TOOLS[t]}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>כל הכלים לקריאה בלבד.</p>

        <h3>איך מתחברים</h3>
        <ul>
          <li>ב-Claude: הגדרות ← Connectors ← הוספת connector מותאם, והדבקת הכתובת למעלה.</li>
          <li>ב-Claude Code:</li>
        </ul>
        <Code>{`claude mcp add --transport http skeelz-jobs ${MCP}`}</Code>
        <ul>
          <li>בלקוח שמוגדר בקובץ JSON:</li>
        </ul>
        <Code>{`{
  "mcpServers": {
    "skeelz-jobs": { "type": "http", "url": "${MCP}" }
  }
}`}</Code>
        <ul>
          <li>לבדיקה מהירה עם MCP Inspector:</li>
        </ul>
        <Code>{`npx @modelcontextprotocol/inspector --cli ${MCP} --transport http --method tools/list`}</Code>
      </section>

      <section className="dev-page__section" aria-labelledby="dev-limits">
        <h2 id="dev-limits">מגבלות שימוש</h2>
        <ul>
          <li>ב-API עד {N.restPerMinute} בקשות בדקה מכל כתובת IP, ובשרת ה-MCP עד {N.mcpPerMinute} בקשות בדקה. מעבר לזה מתקבלת תשובה 429.</li>
          <li>לכל היותר {N.maxPageSize} תוצאות בעמוד.</li>
          <li>
            הנתונים הם המשרות שמתפרסמות בלוח. מה נשמר ומה לא:{' '}
            <a className="dev-page__link" href={ClientRoutes.Privacy}>מדיניות הפרטיות</a>.
          </li>
        </ul>
      </section>
    </div>
  );
}
