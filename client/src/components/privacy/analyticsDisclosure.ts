// Hebrew wording for the analytics table on /privacy. The table itself is built from the SAME
// allowlist the tracking helper enforces (EVENTS / PARAM_CHECKS in utils/analyticsPolicy.ts), so the
// page lists exactly what can be sent. server/test/analytics.test.ts fails if an event or a
// parameter has no label here, or if a label is left for something that no longer exists.
// Pure module (no JSX) so the test can import it.
import type { EventName } from '../../utils/analyticsPolicy';

/** What happened, in plain Hebrew — one per event in EVENTS. */
export const EVENT_LABELS: Record<EventName, string> = {
  page_view: 'צפייה בעמוד',
  job_list_view: 'הצגת רשימת המשרות',
  job_search: 'חיפוש או סינון משרות',
  map_search: 'חיפוש משרות במפה',
  view_switch: 'מעבר בין רשימה למפה',
  job_view: 'פתיחת משרה',
  apply_click: 'לחיצה על "הגשת מועמדות"',
  login_prompt: 'הפניה להתחברות מתוך הגשת מועמדות',
  apply_form_shown: 'הצגת טופס הגשת המועמדות',
  apply_cv_choice: 'בחירה איזה קובץ קורות חיים לשלוח',
  cv_upload: 'העלאת קובץ קורות חיים',
  cv_upload_error: 'העלאת קורות חיים שנכשלה',
  apply_validation_error: 'שדה שלא מולא כנדרש בטופס ההגשה',
  apply_submit: 'שליחת המועמדות',
  apply_success: 'המועמדות התקבלה',
  apply_error: 'המועמדות לא התקבלה',
  login: 'התחברות',
  sign_up_start: 'פתיחת טופס ההרשמה',
  sign_up: 'הרשמה הושלמה',
  post_job_view: 'צפייה בטופס פרסום משרה (מעסיקים)',
  post_job_start: 'התחלת מילוי טופס פרסום משרה',
  post_job_step: 'מעבר לחלק הבא בטופס פרסום משרה',
  post_job_validation_error: 'שדה שלא מולא כנדרש בטופס פרסום משרה',
  post_job_submit: 'שליחת המשרה',
  post_job_success: 'המשרה התקבלה לבדיקה',
  post_job_error: 'שליחת המשרה נכשלה',
  consent_update: 'אישור מדידה בבאנר העוגיות',
};

/** What each parameter holds — one per key in PARAM_CHECKS. */
export const PARAM_LABELS: Record<string, string> = {
  page_path: 'נתיב העמוד',
  page_location: 'כתובת העמוד — רק הנתיב ופרטי קמפיין (בלי מה שהוקלד בחיפוש ובלי קודים)',
  page_referrer: 'שם האתר שממנו הגעת (בלי הכתובת המלאה)',
  language: 'שפת האתר',
  utm_source: 'מקור הקמפיין (utm_source)',
  utm_medium: 'ערוץ הקמפיין (utm_medium)',
  utm_campaign: 'שם הקמפיין (utm_campaign)',
  utm_term: 'מונח הקמפיין (utm_term)',
  utm_content: 'תוכן הקמפיין (utm_content)',
  job_id: 'מזהה המשרה',
  apply_type: 'סוג ההגשה: אורח, משתמש רשום או הגשה עצמית',
  cv_choice: 'אפשרות קורות החיים: הקיימים, החלפה, רק למשרה הזו או בלי — לא הקובץ',
  cv_required: 'האם המשרה דורשת קורות חיים',
  source: 'מאיפה נפתח: רשימה, קישור ישיר או הגשת מועמדות',
  view: 'תצוגה: רשימה או מפה',
  results_count: 'מספר התוצאות',
  has_search_text: 'האם הוקלד טקסט חיפוש (כן/לא — לא הטקסט)',
  filter_count: 'מספר המסננים שנבחרו',
  filter_scope_count: 'מספר מסנני היקף משרה',
  filter_location_count: 'מספר מסנני מיקום',
  filter_skill_count: 'מספר מסנני כישורים',
  radius_km: 'רדיוס החיפוש בק"מ',
  map_point_source: 'איך נבחרה נקודה במפה: יישוב, לחיצה או מיקום — לא הנקודה עצמה',
  error_code: 'קוד שגיאה (לא הודעת השגיאה)',
  field_name: 'שם השדה (לא מה שנכתב בו)',
  step: 'מספר החלק בטופס',
  step_name: 'שם החלק בטופס',
  file_type: 'סוג הקובץ (PDF / DOCX) — לא שמו',
  file_size_kb: 'גודל הקובץ',
  method: 'שיטת ההתחברות (מייל וסיסמה)',
  consent_analytics: 'אישור מדידה',
};
