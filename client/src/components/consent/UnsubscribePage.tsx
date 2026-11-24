// /unsubscribe?t=… — the page behind the "remove me" link of a marketing email. Opening the link changes nothing (mail
// scanners open links); the button does (POST /api/unsubscribe, the same endpoint a mail client's one-click button
// calls, RFC 8058). No sign-in, and the answer never says whether the address has an account. docs/marketing-consent.md.
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

export default function UnsubscribePage() {
  const [params] = useSearchParams();
  const token = params.get('t') ?? '';
  const [state, setState] = useState<'ask' | 'busy' | 'done' | 'bad'>(token ? 'ask' : 'bad');

  const confirm = async () => {
    setState('busy');
    try {
      const r = await fetch(`/api/unsubscribe?t=${encodeURIComponent(token)}`, { method: 'POST', credentials: 'omit' });
      setState(r.ok ? 'done' : 'bad');
    } catch { setState('bad'); }
  };

  return (
    <main dir="rtl" className="container py-5" style={{ maxWidth: 640 }}>
      <h1 className="fs-3 font-RubikMedium mb-3">הסרה מדיוור שיווקי</h1>
      {state === 'ask' || state === 'busy' ? (
        <>
          <p>להפסיק לשלוח לכתובת הזאת דיוור שיווקי מלוח המשרות של SKEELZ? הודעות שירות (כמו קוד כניסה) ימשיכו להגיע.</p>
          <button type="button" className="btn btn-dark" disabled={state === 'busy'} onClick={() => void confirm()} data-testid="unsubscribe-confirm">
            כן, להסיר אותי
          </button>
        </>
      ) : state === 'done' ? (
        <p role="status" data-testid="unsubscribe-done">הוסרת מרשימת הדיוור השיווקי. אפשר להצטרף שוב בכל זמן באזור האישי.</p>
      ) : (
        <p role="alert">הקישור לא תקין. אפשר להסיר את עצמך מהדיוור באזור האישי, או לכתוב לנו ונעשה זאת.</p>
      )}
    </main>
  );
}
