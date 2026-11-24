# חיבור SKEELZ Jobs ל-Salesforce — מדריך הקמה

המדריך הזה הוא לבעלים של האתר, ולא דורש ידע בפיתוח. הוא מסביר מה האתר שולח ל-Salesforce, מה צריך להגדיר בתוך
Salesforce, אילו ערכים להעתיק לשרת (xhostd), ואיך מדליקים את החיבור בבטחה. בסוף יש פרומפט מוכן להדבקה לסשן
שעובד מול Salesforce, וטבלת תקלות.

> **מצב היום:** החיבור **דלוק** בפרודקשן (מ-19.11.2026). כל עוד `ENABLE_SALESFORCE` לא שווה `true`, האתר לא שולח שום דבר ל-Salesforce.
>
> **המעבר מהאתר הקיים (20.11.2026):** מועמד שיש לו כבר Contact מהאתר הקיים — האתר מוצא אותו לפי המייל ומשתמש בו (סעיף 1א).
> משרות האתר הקיים נקראות מ-Salesforce ומנוהלות כאן אחרי המעבר (`LEGACY_JOBS_MODE`, `docs/jobs-management.md`).
> סימון Beta נכבה ב-`SALESFORCE_BETA_MARK=false`.

---

## 1. מה האתר שולח, ומתי

כל שינוי באתר נכנס ל**תור**, ונשלח ברקע תוך כמה שניות. האתר אף פעם לא מחכה ל-Salesforce, והגשה או הרשמה לא
נכשלות אם Salesforce לא זמין — הן פשוט נשלחות אחר כך.

| מה קרה באתר | מה נוצר / מתעדכן ב-Salesforce | איך הרשומה נמצאת שוב (בלי כפילויות) |
|---|---|---|
| מועמד נרשם, או עדכן פרטים / קורות חיים בפרופיל | **Contact** בחשבון (Account) של המועמדים, וקובץ קורות החיים של הפרופיל מקושר אליו | השדה `ID_cambium__c` = מזהה המועמד באתר |
| מועמד רשום הגיש מועמדות | **Case** מסוג הרשומה של ההגשות, מקושר ל-Contact (`ContactId`), עם קורות החיים **של ההגשה הזו** | `A_ID_cambium__c` = מזהה ההגשה |
| הגשה מהירה (בלי חשבון) | **Contact** של המגיש + **Case** של ההגשה, עם קובץ אחד שמקושר לשניהם | Contact: `ID_cambium__c` = מזהה האורח; Case: `A_ID_cambium__c` |
| משרה **שנוצרה באתר הזה** (מסך ניהול המשרות או טופס מעסיק שאושר), נערכה, הוסרה מהלוח או הוחזרה | **Case** מסוג הרשומה של המשרות **כמו היום** (`Position`), באותם שדות (סעיף 5א) | `PID_cambium__c` = מזהה המשרה |
| מעסיק נרשם או עדכן פרטים | **Account** לחברה שהזין + **Contact** של איש הקשר, תחת ה-Account הזה | `SKEELZ_Employer_Id__c` = מזהה המעסיק באתר (בשניהם) |

**סימון Beta — על כל רשומה (עד המעבר).** כל Contact, כל Case וכל Account שהאתר יוצר או מעדכן מקבלים **Beta = מסומן**, כדי שאפשר יהיה
להחריג אותם מכל הרשימות, הדוחות והאוטומציות שהצוות עובד איתם היום. זה לא רשות: אם השדה לא קיים (או שאין
למשתמש האינטגרציה הרשאה לערוך אותו), **האתר לא שולח כלום** — הרשומה נעצרת עם הקוד `beta_field_missing` ומחכה
ל"ננסה שוב" אחרי התיקון. בדיקת החיבור בודקת את זה ב-Contact, ב-Case וב-Account.

**כיבוי Beta (המעבר):** `SALESFORCE_BETA_MARK=false` — האתר מפסיק לכתוב את השדה ולא דורש אותו. רשומה שסומנה קודם **נשארת
מסומנת** עד שהצוות מסיר את הסימון ב-Salesforce (האתר לא מסיר). רשומות של האתר הקיים שהאתר מעדכן (Contact שנמצא לפי מייל,
Position של משרה שעברה לניהול כאן) **לעולם לא מסומנות**.

### 1א. מועמד שכבר קיים ב-Salesforce (לפי מייל)

לפני יצירת Contact למועמד רשום האתר מחפש: לפי המזהה ששמר, לפי `ID_cambium__c` = מזהה המועמד, ואם אין — לפי **המייל**
(`Email` או `email_cambium__c`), **רק בחשבון "מועמדים קמביום"**. המייל מאומת (קוד במייל, Google או Microsoft).
- **נמצא אחד:** האתר משתמש בו. לא נוצר Contact שני. השדות שריקים שם מתמלאים, קישור קורות החיים מתעדכן, **שום שדה לא
  נדרס ולא מתרוקן** (שם, מייל, טלפון, חשבון ו-`ID_cambium__c` נשארים). לא מסומן Beta.
- **ההגשות** שלו נושאות ב-`A_CID_cambium__c` את ה-`ID_cambium__c` **הישן** של ה-Contact, כך שה-Flow `new_applied` מקשר אותן אליו.
- **נמצאו כמה:** האחרון שעודכן; נספר כ"כמה Contacts באותו מייל" בדוח המעבר, לבדיקת הצוות.
- **לא נמצא / Contact שהאתר עצמו יצר (של הגשה מהירה):** Contact חדש, כמו קודם.
- **הגשה מהירה** (בלי חשבון) לא מחפשת לפי מייל: המייל לא מאומת.

### 1ב. מועמדי האתר הקיים: העתק לצפייה בלבד עד המעבר (`LEGACY_CANDIDATES_MODE`)

החלטות הבעלים (20.11.2026): כל המועמדים **הרשומים** של האתר הקיים מקבלים חשבון כאן, לצפייה בלבד עד המעבר, ונפתחים
לעריכה מלאה ביום המעבר.
- **מי:** Contacts עם `ID_cambium__c`, בחשבונות ש-`LEGACY_CANDIDATE_ACCOUNTS` מונה ("קמביום מועמדים" ו"מועמדים ריטריין";
  ברירת המחדל: `SALESFORCE_CONTACTS_ACCOUNT_ID` לבד), בלי Beta. **הגשות מהירות לא מועתקות**: בחשבון המועמדים, Contact בלי
  תאריך לידה ובלי מגדר הוא הגשה מהירה (בארגון, 11.2026: 1,858 רשומים מול 1,727 הגשות מהירות). אנשי הריטריין (מערכת
  קודמת: שם, מייל וטלפון בלבד) מועתקים כולם. Contacts שהאתר הזה עצמו יצר לא מועתקים.
- **`mirror`:** פעם בשעה (`LEGACY_CANDIDATES_MIRROR_MINUTES`, 5–1440) האתר **קורא** את מה שהשתנה, ופעם ביום הכול. עד המעבר
  מועמד רק צופה כאן, כך ששינוי שנעשה באתר הקיים יכול להופיע כאן עד שעה אחר כך. שם, מייל, טלפון,
  תאריך לידה, מגדר, יישוב וכישורים, בפורמט של האתר. המזהה כאן = `ID_cambium__c` (כשהוא מזהה תקין). **שום דבר לא נכתב
  ל-Salesforce.** המועמד נכנס עם אותו מייל (קוד, Google או Microsoft) ו**רואה** את הפרטים. שינוי ומחיקת קורות חיים
  נדחים (409 `candidate_read_only`; טריגר במסד: `users_legacy_guard`). **הגשה למשרות שנוצרו באתר הזה מותרת** (בעלים,
  23.11.2026): עם קורות החיים שבתיק או קובץ למשרה הזו בלבד (לא החלפת קורות החיים בפרופיל); ה-Case נקשר ל-Contact שלהם
  (`A_CID_cambium__c` = המפתח הישן), הקובץ מקושר ולא מועלה שוב. משרות של האתר הקיים לא מקבלות הגשות כאן, מאף אחד
  (409 `job_on_existing_site`; טריגר `job_applications_legacy_guard`). הסכמה לדיוור
  אפשר לשנות. הצוות רואה אותם ברשימת המועמדים, דרך אותן מסירות (מגבלה, יומן, התראות), ולא עורך אותם.
- **קורות חיים לא מועתקים.** `cv_file_url` מחזיק מצביע (`sf:<ContentVersion>`) לקובץ ה-pdf/doc/docx החדש ביותר ב-Contact.
  הקובץ נפתח מ-Salesforce רק כשמישהו פותח אותו (המועמד, הצוות דרך `cvHandover`, מעסיק שהועבר אליו), ב-GET בלבד
  (`services/legacyCvs.ts`). זו הקריאה היחידה ל-Salesforce מתוך בקשה.
- **כמה Contacts באותו מייל:** זה שהשתנה אחרון; מסומן `legacy_match = 'ambiguous'`.
- **חשבון שכבר נפתח כאן עם אותו מייל:** נשאר של האתר הזה (לא לקריאה בלבד). מקושר ל-Contact, והשדות הריקים בו מתמלאים פעם אחת.
- **מחיקה כאן** (בקשת מחיקה): ה-Contact נרשם ב-`legacy_candidates_removed` ולא מועתק שוב. **ב-Salesforce צריך למחוק בנפרד.**
- **`owned` (המעבר):** בהפעלה כולם הופכים למועמדים רגילים (נרשם ביומן). שינוי שלהם נשלח בתור **לאותו Contact, במלואו**:
  כל ערך שיש לאתר, בלי לרוקן שדה, בלי `ID_cambium__c`, בלי החשבון ובלי Beta. הגשה נושאת את `ID_cambium__c` הישן, וקורות
  החיים של Salesforce **מקושרים** ל-Case ההגשה (לא מועלים שוב). באותו רגע: לחסום באתר הקיים כתיבה ויצירת רשומות.
- **חזרה לאחור:** `mirror` שוב. לקריאה בלבד שוב; מה שהמועמדים שינו בינתיים נשאר (וכבר נשלח ל-Contact).

**בעלות:** כל רשומה שהאתר יוצר שייכת למשתמש האינטגרציה (כמו המשרות של האתר הקיים, שהבעלים שלהן הוא משתמש
האינטגרציה שלו). כל כתיבה של Case נשלחת עם ההוראה **לא להפעיל כללי הקצאה** (`Sforce-Auto-Assign: FALSE`), כך שכלל
הקצאה לא מחליף את הבעלים. (Flow שמשנה בעלים כן יכול — לכן הוא ברשימת ההחרגות של Beta.)

**אין שליחה לאחור:** מה שקרה באתר בזמן שהחיבור היה כבוי **לא נשלח אף פעם**. רשומה נשלחת רק כשהיא נוצרת או משתנה
אחרי ההדלקה (למשל: מועמד שנרשם לפני ההדלקה ומגיש אחריה — ה-Contact שלו נוצר עם ההגשה).

**מה לא נשלח אף פעם:**
- **משרות שיובאו מהאתר הקיים.** הן כבר ב-Salesforce של האתר הקיים, ונשארות שם כמו שהן. האתר הזה לא יוצר להן Case
  ולא משנה אותן. (הגשה **למשרה כזו** כן נשלחת, עם `A_PID_cambium__c` = מזהה המשרה — אותו מזהה שה-Case הקיים נושא.)
- **מחיקה.** האתר לא מוחק שום דבר ב-Salesforce. קובץ קורות חיים שהוחלף נשאר; רק הקישור בפרופיל מתעדכן.
- **אנשי צוות.** מנהלי תוכן ומנהלי מערכת לא נשלחים. מעסיקים נשלחים רק כמעסיקים.
- **הצמדה והקפצה** של משרות — הן חיות רק באתר. (הסרה מהלוח כן נשלחת: הסטטוס באתר הופך ל-`Closed`.)

**השדות, אחד-אחד** (כולם כבר קיימים בארגון מהחיבור של האתר הקיים, או שדות רגילים של Salesforce, חוץ משדה המזהה
של המעסיקים, שדה ה-Beta ושלושת שדות תנאי הסף):

| אובייקט | שדות שהאתר כותב |
|---|---|
| Contact (מועמד) | `FirstName`, `LastName`, `Email`, `Phone`, `Birthdate`, `AccountId`, `dateOfBirth_cambium__c`, `email_cambium__c`, `firstName_cambium__c`, `lastName_cambium__c`, `gender_cambium__c`, `ID_cambium__c`, `citySymbol_cambium__c`, `phoneNumber_cambium__c`, `skills_cambium__c`, `CV_link_cambium__c` |
| Contact (הגשה מהירה) | `LastName` (השם המלא), `Email`, `Phone`, `AccountId`, `email_cambium__c`, `lastName_cambium__c`, `phoneNumber_cambium__c`, `ID_cambium__c` |
| Account (חברת המעסיק) | `Name` (שם החברה), `RecordTypeId` (אם הוגדר), `Description` (`SKEELZ Jobs employer account <מזהה>`), `SKEELZ_Employer_Id__c` |
| Contact (מעסיק) | `FirstName`, `LastName`, `Email`, `Phone`, `Title` (התפקיד שלו בחברה), `AccountId` (ה-Account של החברה), `Description`, `SKEELZ_Employer_Id__c`; ואם קיים: `Is_SKEELZ_Employer__c` |
| Case (משרה) | `AccountId`, `RecordTypeId`, `ContactId` (איש הקשר של המעסיק, במשרה שמעסיק רשום פרסם), `isSponserd_cambium__c`, `isMarked_cambium__c`, `isSelfApply_cambium__c`, `company_cambium__c`, `Position_cambium__c`, `PLocation_cambium__c`, `citySymbol_cambium__c`, `PTime_cambium__c`, `PSkills_cambium__c`, `PDescription_cambium__c`, `PComments_cambium__c`, `PFullName_cambium__c`, `PPhone_cambium__c`, `PEmail_cambium__c`, `PID_cambium__c`, `PLink_cambium__c`, `PStatus__c`, `PCreatedDate_cambium__c`, `PModifiedDate_cambium__c`; ואם קיים: `Threshold_Condition__c` (תנאי הסף, ריק כשאין) |
| Case (הגשה) | `AccountId`, `RecordTypeId`, `ContactId`, `A_ID_cambium__c`, `A_PID_cambium__c`, `A_CID_cambium__c`; ואם קיימים: `Threshold_Confirmed__c` (המועמד אישר את תנאי הסף), `Threshold_Confirmed_At__c` (מתי) |
| כל Contact, Case ו-Account | `Beta__c` = מסומן (שם השדה ניתן לשינוי: `SALESFORCE_BETA_FIELD`) |
| קבצים | `ContentVersion` (הקובץ), `ContentDocumentLink` (הקישור לרשומה) |

טקסט ארוך מהשדה ב-Salesforce נחתך לאורך השדה (כדי שרשומה לא תיפול על זה).

**איך המידע של האתר החדש נכנס לשדות הקיימים של המשרה** (בלי שדות חדשים):

| מידע באתר | שדה קיים |
|---|---|
| סטטוס באתר (פעילה / מושהית / סגורה) | `PStatus__c`: `Active` / `Suspended` / `Closed` |
| הוסרה מהלוח (ארכוב) | `PStatus__c` = `Closed`; כשמחזירים — הסטטוס שהיה |
| תאריך פרסום | `PCreatedDate_cambium__c` (אם אין — תאריך היצירה) |
| קישור חיצוני להגשה | שורה בסוף `PComments_cambium__c`: `קישור חיצוני להגשה: <כתובת>` |
| שם המעסיק / החברה | `company_cambium__c` |
| המעסיק הרשום שפרסם | `ContactId` = ה-Contact שלו |
| כישורים | `PSkills_cambium__c` — מזהי הכישורים, כמו שהאתר הקיים שולח (הדשבורד מתרגם אותם לשמות) |
| הגשה עצמאית אצל המעסיק | `isSelfApply_cambium__c` |

מה שאין לו שדה קיים ולא נשלח: אופן ההגשה המפורט (הגשה מהירה / רק עם חשבון) וחובת קורות חיים.

---

## 2. מה כבר הוחלט, ומה עוד פתוח

**הוחלט:**
- מועמדים → Contact בחשבון **מועמדים קמביום**, כמו היום.
- הגשות → סוג הרשומה **הגשות קמביום** (`RecordType2`).
- משרות → **אותו סוג רשומה כמו היום** (`Position`, בחשבון "משרות קמביום"), באותם שדות. בלי שדות חדשים (הטבלה למעלה).
- מעסיק רשום → **Account** לחברה + **Contact** לאיש הקשר. שדה המזהה `SKEELZ_Employer_Id__c` נוסף לשניהם.
- **Beta** מסומן על כל רשומה שהאתר כותב. הרשומות האלה כבר מוחרגות אצל הצוות.
- בעלות: נשארת על משתמש האינטגרציה (כללי הקצאה לא רצים).
- הגשה מהירה במייל של מועמד רשום יוצרת Contact נוסף — ידוע, ייפתר בהמשך.
- **אין שליחה לאחור.** מדליקים אחרי בדיקה של מועמד, משרה והגשה.
- **תנאי סף** (11.2026, לבקשתך): נשלח לשלושה שדות חדשים ב-Case (סעיף 5ב) — הטקסט ב-Case של המשרה (בכל יצירה
  ועריכה, באותו Case; כשמסירים את התנאי השדה מתרוקן), ובהגשה: שהמועמד אישר ומתי. הטקסט כפי שהיה ברגע האישור לא
  נשמר באתר, ולכן לא נשלח עם ההגשה. **שדה שחסר — מדלגים עליו** (השאר נשלח), ובדיקת החיבור מסמנת אותו בכתום בשמו.

**נעשה בארגון (17.11.2026, אומת שם; בלי שינוי ב-Layout, Flow או נתונים):**
- משתמש האינטגרציה: `<integration-user>` (שם תצוגה JOBS-XHOSTD, `005Sr00000HY78XIAT`), Profile
  "Minimum Access - API Only Integrations", License "Salesforce API Integration".
- Permission Set: **"JOBS-XHOSTD Integration"** (`0PSSr000000I7mDOAS`; בהמשך המדריך — זה ה-Permission Set). Read / Create /
  Edit / View All על Account, Case, Contact; בלי Delete ובלי Modify All. Edit על כל השדות החדשים.
- שדות: `SKEELZ_Employer_Id__c` ב-Contact וב-Account (Text(24), Unique, External ID); `Is_SKEELZ_Employer__c` ב-Contact;
  שלושת שדות תנאי הסף ב-Case (סעיף 5ב). External ID על `Contact.ID_cambium__c`, `Case.PID_cambium__c`, `Case.A_ID_cambium__c`.
- `Beta__c` קיים בשלושת האובייקטים — **לא צריך** את `SALESFORCE_BETA_FIELD`.
- `PStatus__c` במשרות Position: רק `Active` / `Suspended` / `Closed` (ועוד כ-1,567 ישנות ריקות) — תואם בדיוק את האתר.
- **לא אומת** (לא קריא ב-API): שיוך סוגי הרשומה (Case: הגשות קמביום + Position; Account: Organization) ל-Permission
  Set. בדיקת החיבור באתר תגלה את זה (`record_type_not_assigned`).

**פתוח — סעיף 13.**

### 2א. Flows ו-Validation Rules שירוצו על הרשומות של האתר

אף אחד מהם לא בודק Beta היום.

- ⚠ **`new_applied`** (Case מסוג הגשות קמביום, כשיש `A_ID_cambium__c`): מוצא את המשרה לפי
  `PID_cambium__c = A_PID_cambium__c` ואת המועמד לפי `Contact.ID_cambium__c = A_CID_cambium__c`, ו**דורס** את
  `ContactId`, `ParentId`, `Subject`, `PEmail/PFullName/PPhone`, `company_cambium__c` וקובע `Priority`. אם אין Contact
  תואם — `ContactId` **מתרוקן**. לכן:
  - האתר שולח תמיד ב-`A_CID_cambium__c` בדיוק את ה-`ID_cambium__c` שכתב ל-Contact: מועמד רשום — מזהה המשתמש; הגשה
    מהירה — מזהה המגיש (guest id). ה-Contact נכתב **לפני** ה-Case.
  - Case של הגשה נוצר **פעם אחת ולא מתעדכן לעולם** מהאתר — כך שמה שה-Flow קבע (`ParentId`, `Subject`, `Priority` וכו')
    לא נדרס. האתר לא שולח `ParentId`, `Subject`, `Priority`, `Status`, `OwnerId` או את שדות ה-P* בהגשה.
  - **פער ידוע:** משרה שנוצרה באתר כשהחיבור היה כבוי (או שעוד לא נשלחה) — אין לה Case, וה-Flow לא ימצא אותה:
    `ParentId` יישאר ריק. תוכנית תיקון: לשלוח את המשרה לפני ההגשה (ממתין לאישורך).
- **`new_position_publish`**: מייל לצוות על כל Case חדש מסוג Position — גם על משרות בדיקה. אם לא רוצים: תנאי Beta = לא מסומן.
- **`SKZ_Position_Closed_Notify`**: מייל לצוות כש-`PStatus__c` משתנה ל-`Closed` או `Suspended` — כולל הסרה מהלוח באתר
  (נשלחת כ-`Closed`) והשהיה. כנ"ל: אפשר להוסיף תנאי Beta.
- **`SKZ_Contact_Latest_As_Primary`**: Contact חדש בחשבון Organization הופך לאיש הקשר הראשי שלו — רצוי (איש הקשר של המעסיק).
- **`Check_If_Contact_Has_Files`**: מסמן הגשה מהירה ב-Contact בחשבון "קמביום מועמדים" כש-`gender_cambium__c` ריק. האתר
  לא שולח מגדר להגשה מהירה (נכון שיסומן); מועמד רשום ממלא מגדר בפרופיל (שדה חובה), אז לא יסומן.
- **`SKZ_Handler_From_Case`**: מדלג על משתמשי אינטגרציה לפי רשימת מזהים קבועה; JOBS-XHOSTD עוד לא בה. האתר **לא משנה**
  `Status` או `OwnerId` של הגשה, אז זה לא אמור להשפיע. ליתר ביטחון אפשר להוסיף את `005Sr00000HY78XIAT` לרשימה.
- Validation Rules: `Contact_Preferred_Email` (NPSP) — האתר לא כותב שדות `npe01__…`; `only_position` על Case — לא אמור
  לחסום. הבדיקה המלאה (סעיף 9, שלב 5) תאשר.

## 3. משתמש אינטגרציה

> **כבר נעשה** (סעיף 2): `<integration-user>`. השלבים נשארים לתיעוד.

1. **Setup → Users → Users → New User**.
2. פרטים:
   - **Last Name:** `JOBS-XHOSTD` (כך נוצר)
   - **Email:** כתובת שלך (יגיע מייל אימות)
   - **Username:** ייחודי בכל Salesforce, למשל `<integration-user>`
   - **User License:** `Salesforce Integration`
   - **Profile:** `Minimum Access - API Only Integrations`
3. שמירה.
4. בדף המשתמש: **Permission Set License Assignments → Edit Assignments → `Salesforce API Integration`**. **חובה** —
   בלעדיו שלב 4 נכשל עם `The user license doesn't allow the permission`.
5. לא נוגעים במשתמשי אינטגרציה קיימים (של האתר הקיים או של הדשבורד) — מערכות אחרות מתחברות דרכם.

> אם כבר יצרת משתמש API (כתוב שיצרת) — ודא רק שסעיפים 2–4 נכונים לגביו, ושהוא לא משמש מערכת אחרת.

---

## 4. Permission Set — ההרשאות המדויקות

> **כבר נעשה** בשם "JOBS-XHOSTD Integration" (סעיף 2). נשאר לוודא רק את שיוך סוגי הרשומה (שלב 4.3).

1. **Setup → Permission Sets → New**
   - **Label:** `JOBS-XHOSTD Integration` (כך נוצר)
   - **License:** `--None--` (אם בוחרים רישיון, חלק מהאובייקטים לא יופיעו ב-Object Settings).
2. **Object Settings:**

| אובייקט | הרשאות אובייקט | הרשאות שדות |
|---|---|---|
| **Contacts** | Read, Create, Edit, **View All** — **בלי Delete** | **Edit** (= Read + Edit) לכל שדות ה-Contact שבטבלה בסעיף 1 |
| **Cases** | Read, Create, Edit, **View All** — **בלי Delete** | **Edit** לכל שדות ה-Case שבטבלה בסעיף 1 (כולל `Contact Name` = `ContactId`) |
| **Accounts** | Read, Create, Edit, **View All** — **בלי Delete** | **Edit** ל-`Account Name`, `Description`, `SKEELZ_Employer_Id__c`, Beta (חשבונות של חברות המעסיקים; האתר מעדכן רק חשבונות שהוא עצמו יצר, לפי המזהה) |

3. **Record Type Assignments:** ב-**Cases** סמן את **שני** סוגי הרשומה (הגשות קמביום ו-Position). ב-**Accounts** את הסוג
   של חברות (ב-NPSP: `Organization`). בלי זה Salesforce מסרב ליצור רשומה מהסוג הזה, ובדיקת החיבור תראה
   `record_type_not_assigned`.
4. **קבצים:** ל-Files אין שורה ב-Object Settings. משתמש עם `Salesforce Integration` + `Salesforce API Integration` יכול
   להעלות קבצים דרך ה-API. אם העלאת קורות חיים נכשלת עם `INSUFFICIENT_ACCESS` — ראו בטבלת התקלות.
5. **Manage Assignments → Add Assignment** → משתמש האינטגרציה.

> **View All** נדרש כדי שהאתר ימצא רשומה שמישהו בצוות שינה לה בעלים, ולא ייצור כפילות.
> הבעלים נשאר משתמש האינטגרציה (כללי הקצאה לא רצים על מה שהאתר כותב). אם בכל זאת מישהו בצוות מעביר משרה לבעלים
> אחר ומופיע `INSUFFICIENT_ACCESS_OR_READONLY` על עדכון שלה — Sharing Rule שנותן למשתמש האינטגרציה Read/Write על
> Cases מסוג Position. האתר עצמו לעולם לא מוחק.
>
> **הרשאה חדשה נכנסת לתוקף תוך חצי שעה** — האתר מחדש את ההתחברות כל 30 דקות (ובדיקת החיבור תמיד מתחברת מחדש).

---

## 5. שדות מותאמים (Custom Fields)

**חובה — Beta:** שדה **Checkbox** בשם `Beta__c` ב-**Contact**, ב-**Case** וב-**Account** (אם הוא קיים בשם אחר — מגדירים
את השם ב-`SALESFORCE_BETA_FIELD`; השם חייב להיות זהה בשלושתם). ב-Permission Set: **Edit** לשדה בשלושת האובייקטים.
ההחרגה בצד הצוות (List Views, דוחות, אוטומציות) כבר נעשתה. אם מוסיפים בעתיד רשימה, דוח או Flow — לזכור את התנאי
**Beta = לא מסומן**.

**חובה — מזהה המעסיק** (Object Manager → **Contact** → Fields & Relationships → New, ואותו דבר ב-**Account**):

| שדה | סוג | הגדרות | למה |
|---|---|---|---|
| `SKEELZ_Employer_Id__c` (Label: SKEELZ Employer Id) | Text(24) | ✔ Unique, ✔ External ID | ה-Account וה-Contact של המעסיק נמצאים לפיו בכל עדכון, גם אם החליף מייל או שם חברה |

בלי השדה בשני האובייקטים **שום דבר של מעסיקים לא נשלח** (קוד `employer_id_field_missing`); מועמדים, משרות והגשות
ממשיכים כרגיל. בזכותו האתר נוגע **רק** בחשבונות ובאנשי קשר שהוא עצמו יצר — לא בחשבון קיים של חברה.

**רשות:** `Is_SKEELZ_Employer__c` (Label: SKEELZ Employer), Checkbox ב-Contact — לרשימות ודוחות של מעסיקים. האתר כותב אליו
רק אם הוא קיים.

כל שאר הפרטים של המעסיק כבר יש להם שדה רגיל: שם פרטי ומשפחה, מייל, טלפון, תפקיד (`Title`) ב-Contact; שם החברה
(`Account Name`) ב-Account.

**חובה:** כל שדות ה-`_cambium__c` וה-`PStatus__c` מהטבלה בסעיף 1. הם כבר קיימים בארגון (האתר הקיים משתמש בהם).
בדיקת החיבור תגיד בדיוק איזה שדה חסר, אם בכלל.

**מומלץ (לא חובה) — שדות חיפוש כ-External ID:** ב-Setup → Object Manager → Contact → `ID_cambium__c` → Edit → סמן
**External ID**. אותו דבר ב-Case ל-`PID_cambium__c` ול-`A_ID_cambium__c`. זה לא משנה שום נתון; זה רק מאנדקס את השדה,
כך שהחיפוש "האם הרשומה כבר קיימת" נשאר מהיר גם כשיש הרבה רשומות.

### 5ב. תנאי סף — שלושה שדות ב-Case

Object Manager → **Case** → Fields & Relationships → New (אחד-אחד):

| שם API | Label | סוג | הגדרות | נכתב ב- |
|---|---|---|---|---|
| `Threshold_Condition__c` | תנאי סף | **Text Area (Long)** | Length **1000** (באתר עד 500 תווים), Visible Lines 3 | Case של משרה (Position) |
| `Threshold_Confirmed__c` | אישר תנאי סף | **Checkbox** | ברירת מחדל: לא מסומן | Case של הגשה (הגשות קמביום) |
| `Threshold_Confirmed_At__c` | מועד אישור תנאי סף | **Date/Time** | — | Case של הגשה (הגשות קמביום) |

- **הרשאות שדה (FLS):** ב-Permission Set "JOBS-XHOSTD Integration" → Object Settings → Cases → **Edit** (Read + Edit)
  לשלושתם. לפרופילים של הצוות — **Read** (System Administrator, Executive Management, Standard User), כדי שיראו אותם.
  באשף יצירת השדה: בשלב "Establish field-level security" לסמן Visible לפרופילים האלה, ו-Read-Only אם לא רוצים שהצוות ישנה.
- **תצוגה (Page Layout):** בשלב "Add to page layouts" — `Threshold_Condition__c` ל-Layout של המשרות (Position);
  `Threshold_Confirmed__c` ו-`Threshold_Confirmed_At__c` ל-Layout של הגשות קמביום ("Interested"). זה רק להצגה — האתר
  כותב לשדות גם אם הם לא ב-Layout.
- **בלי השדות** הכול ממשיך לעבוד: האתר פשוט לא כותב את השדה החסר. בבדיקת החיבור השורה "שדות תנאי סף ב-Case" מופיעה
  בכתום עם `threshold_fields_missing` ושם כל שדה שחסר (או שאין לו Edit / שהסוג שלו שונה).

### 5ג. תעודת זהות — שדה אחד ב-Contact (רשות)

החלטת הבעלים (11.2026): מספר תעודת הזהות של מועמד, כשנמסר, נשלח ל-Contact שלו. Object Manager → **Contact** → Fields &
Relationships → New:

| שם API | Label | סוג | הגדרות | נכתב ב- |
|---|---|---|---|---|
| `ID_Number__c` | תעודת זהות | **Text** | Length **9** | Contact של מועמד |

- **הרשאות שדה (FLS):** ב-Permission Set "JOBS-XHOSTD Integration" → Object Settings → Contacts → **Edit** (Read + Edit).
  לצוות — Read רק למי שצריך לראות תעודות זהות (זה מידע רגיש).
- **בלי השדה** הכול ממשיך לעבוד ולא נשלח שום דבר מתעודת הזהות. בבדיקת החיבור השורה "שדה תעודת זהות ב-Contact"
  מופיעה בכתום עם `id_number_fields_missing`.
- מועמד שמחק את המספר באזור האישי → השדה מתרוקן ב-Contact (בעדכון הבא שלו). כמו כל השדות, אין שליחה של מה שנאסף
  לפני שהשדה נוצר (אין backlog): המספר מגיע בעדכון הבא של אותו מועמד.

### 5ד. שדות שמנהלי התוכן הוסיפו (מסך ההגדרות) — רק אחרי יצירה וקישור

החלטת הבעלים (23.11.2026): שאלה שנוספה לטופס ההרשמה ושדה שנוסף לטופס המשרה במסך ההגדרות (`/settings`, `docs/settings.md`)
**נשלחים ל-Salesforce רק אחרי שנוצר להם שדה בארגון ומנהל מערכת קישר אותו**. עד אז לא נשלח כלום, והמסך מציג
"לא נשלח ל-Salesforce עד שייווצר ויקושר שדה מתאים". האתר לעולם לא יוצר, משנה או מוחק שדות ב-Salesforce.

מה עושים, לכל שדה:
1. Object Manager → **Contact** (לשאלה מטופס ההרשמה) או **Case** (לשדה משרה, באותו סוג רשומה Position) → Fields & Relationships → New.
   סוג: טקסט → **Text** (עד 255) או **Long Text Area**; בחירה מרשימה → **Picklist** עם **אותם ערכים בדיוק** כמו באתר (או Text);
   תיבת סימון → **Checkbox**. שם ה-API חייב להסתיים ב-`__c`.
2. **הרשאות שדה (FLS):** ב-Permission Set "JOBS-XHOSTD Integration" → Read + Edit לשדה. ב-Case: להוסיף את השדה ל-Page Layout של Position אם הצוות צריך לראות אותו.
3. באתר, מנהל מערכת: `/settings` → בשורה של השדה → **Salesforce** → שם ה-API → "קישור ובדיקה". האתר קורא את הגדרות האובייקט
   (describe, קריאה בלבד) ומראה אם השדה נמצא, בסוג מתאים ועם הרשאת עריכה. רק אז הוא נשלח.
4. אין שליחה של מה שנאסף קודם (אין backlog): תשובה קיימת עוברת בעדכון הבא של אותו מועמד או אותה משרה.

- ערך ב-Picklist שלא קיים ב-Salesforce נדחה שם (400) ועוצר את הרשומה עד שמנהל מערכת שולח שוב: לכן ערכי הרשימה חייבים להיות זהים, או שהשדה יהיה Text.
- בדיקת החיבור מציגה שורה "שדות שנוספו בהגדרות" עם כל שדה פעיל ומצבו (אזהרה כשאחד לא נשלח).
- Contact קיים של האתר הקיים (adopted): השדה ממולא רק אם הוא ריק שם, כמו תעודת הזהות. סימון Beta נשאר כמו בכל רשומה.

### 5א. משרות — סוג הרשומה הקיים

משרות שנוצרות באתר החדש נכנסות **לאותו סוג רשומה של המשרות היום** (`Position`, בחשבון "משרות קמביום"), עם אותם שדות
ואותה תצוגה — בלי סוג רשומה חדש ובלי שדות חדשים. המזהה (`012…`) של `Position` נכנס ל-`SALESFORCE_CASE_RECORD_TYPE_ID`,
והמזהה של "משרות קמביום" ל-`SALESFORCE_CASE_ACCOUNT_ID`.

---

## 6. External Client App (התחברות בלי סיסמה של אדם)

> מאז Spring '26 אי אפשר ליצור Connected App חדש — משתמשים ב-External Client App.

1. **Setup → External Client App Manager → New External Client App**.
2. **Basic Information:** Name `SKEELZ Jobs`, Contact Email, **Distribution State:** `Local`.
3. **API (Enable OAuth Settings)** → **Enable OAuth**:
   - **Callback URL:** `https://login.salesforce.com/services/oauth2/success` (חובה למלא, לא בשימוש)
   - **OAuth Scopes:** `Manage user data via APIs (api)`
   - **Flow Enablement:** ✔ **Enable Client Credentials Flow**
4. **Create**.
5. **Policies → Edit → OAuth Policies**:
   - ✔ **Enable Client Credentials Flow** — זו **תיבה שנייה, נפרדת**. שתיהן חייבות להיות מסומנות.
   - **Run As (Username):** ה-Username של משתמש האינטגרציה משלב 3
   - **Permitted Users:** `All users may self-authorize`
   - **IP Relaxation:** `Relax IP restrictions` (לשרת של xhostd אין כתובת יציאה קבועה)
6. **Settings → OAuth Settings → Consumer Key and Secret** (יגיע קוד אימות במייל) → העתק **Consumer Key** ו-**Consumer Secret**.
   - את ה-Secret **לא שולחים במייל ולא מדביקים בצ'אט.** מזינים אותו ישר ב-xhostd כ-secret (שלב 8).

## 7. איפה מוצאים כל ערך

| ערך | איפה |
|---|---|
| **My Domain URL** | Setup → **My Domain** → *Current My Domain URL*, למשל `https://<org>.my.salesforce.com`. **לא** `login.salesforce.com` — Client Credentials עובד רק מול My Domain |
| **מזהה Account** (מתחיל ב-`001`) | פותחים את החשבון ב-Salesforce; המזהה מופיע בכתובת: `.../lightning/r/Account/`**`001XXXXXXXXXXXXXXX`**`/view` |
| **מזהה Record Type** (מתחיל ב-`012`) | Setup → Object Manager → **Case** (או **Account**) → **Record Types** → לוחצים על הסוג; המזהה בכתובת אחרי `RecordTypes/` (או `id=`). דרך מהירה: Developer Console → Query Editor: `SELECT Id, SobjectType, DeveloperName, Name FROM RecordType WHERE SobjectType IN ('Case', 'Account')` |
| **Consumer Key / Secret** | שלב 6 |

מזהה של 15 או 18 תווים — שניהם תקינים.

---

## 8. ההגדרות בשרת (xhostd, אפליקציה `skeelz-jobs`)

| משתנה | דוגמה | סוד? | מאיפה | חובה |
|---|---|---|---|---|
**הערכים של הארגון** (מהארגון, 17.11.2026; מזהים, לא סודות):

```text
SALESFORCE_LOGIN_URL=https://<org>.my.salesforce.com
SALESFORCE_CONTACTS_ACCOUNT_ID=001Tw00000M80rFIAR
SALESFORCE_JOBAPPLICATIONS_ACCOUNT_ID=001Tw00000MAnK2IAL
SALESFORCE_JOBAPPLICATIONS_CASE_RECORD_TYPE_ID=012Tw0000029JS5IAM
SALESFORCE_CASE_ACCOUNT_ID=001Tw00000M8CjwIAF
SALESFORCE_CASE_RECORD_TYPE_ID=0128d000000DoNyAAK
SALESFORCE_EMPLOYER_ACCOUNT_RECORD_TYPE_ID=0128d000001SyKdAAK
```

`SALESFORCE_BETA_FIELD` לא נחוץ (השדה נקרא `Beta__c`). `SALESFORCE_CLIENT_ID` / `SALESFORCE_CLIENT_SECRET` — מה-External
Client App (שלב 6), את הסוד מזינים ישר ב-xhostd. `ENABLE_SALESFORCE` — אחרון.

| `SALESFORCE_LOGIN_URL` | `https://<org>.my.salesforce.com` | לא (`set_env`) | שלב 7 — My Domain | ✔ |
| `SALESFORCE_CLIENT_ID` | `3MVG9…` | לא, אבל לא לפרסם (`set_env`) | שלב 6 — Consumer Key | ✔ |
| `SALESFORCE_CLIENT_SECRET` | `••••` | **כן** (`set_secret`) | שלב 6 — Consumer Secret | ✔ |
| `SALESFORCE_CONTACTS_ACCOUNT_ID` | `001…` | לא | החשבון **מועמדים קמביום** | ✔ |
| `SALESFORCE_JOBAPPLICATIONS_ACCOUNT_ID` | `001…` | לא | החשבון של Cases ההגשות | ✔ |
| `SALESFORCE_JOBAPPLICATIONS_CASE_RECORD_TYPE_ID` | `012…` | לא | סוג הרשומה של ההגשות (הגשות קמביום) | ✔ |
| `SALESFORCE_CASE_ACCOUNT_ID` | `001…` | לא | החשבון **משרות קמביום** | ✔ |
| `SALESFORCE_CASE_RECORD_TYPE_ID` | `012…` | לא | סוג הרשומה של המשרות, `Position` (סעיף 5א) | ✔ |
| `SALESFORCE_EMPLOYER_ACCOUNT_RECORD_TYPE_ID` | `012…` | לא | סוג הרשומה של חשבונות החברות (ב-NPSP: `Organization`); ריק = ברירת המחדל של משתמש האינטגרציה | מומלץ |
| `SALESFORCE_API_VERSION` | `v62.0` | לא | ברירת מחדל `v62.0`; מקבל גם `65.0` | רשות |
| `SALESFORCE_BETA_FIELD` | `Beta__c` | לא | שם ה-API של שדה ה-Beta, רק אם הוא לא `Beta__c` | רשות |
| `SALESFORCE_BETA_MARK` | `false` | לא | `true` (ברירת מחדל) = כל רשומה מסומנת Beta; `false` = אחרי המעבר | רשות |
| `LEGACY_JOBS_MODE` | `mirror` | לא | משרות האתר הקיים: `off` / `mirror` (נקראות מ-Salesforce, לקריאה בלבד כאן) / `owned` (מנוהלות כאן) — `docs/jobs-management.md` | רשות |
| `LEGACY_PUBLIC_API` | `https://jobs.skeelz.co.il/api` | לא | הלוח הציבורי של האתר הקיים, GET בלבד: מספרי משרה ותיאור מעוצב | רשות |
| `LEGACY_JOBS_MIRROR_MINUTES` | `5` | לא | כל כמה דקות לקרוא משרות (1–60) | רשות |
| `LEGACY_CANDIDATES_MIRROR_MINUTES` | `60` | לא | כל כמה דקות לקרוא מועמדים (5–1440); הכול נקרא שוב פעם ביום | רשות |
| `LEGACY_CANDIDATES_MODE` | `mirror` | לא | מועמדי האתר הקיים: `off` / `mirror` (העתק לצפייה בלבד) / `owned` (מועמדים רגילים, כתיבה מלאה לאותו Contact) — סעיף 1ב | רשות |
| `LEGACY_CANDIDATE_ACCOUNTS` | `001Tw00000M80rFIAR,0018d00000WS5TrAAL` | לא | החשבונות שאנשי הקשר שלהם הם מועמדי האתר הקיים (מועמדים קמביום, מועמדים ריטריין) | רשות |
| `ENABLE_SALESFORCE` | `true` | לא | **אחרון**, רק אחרי שבדיקת החיבור עברה (שלב 9) | ✔ |

השרת בודק את כל הערכים בהפעלה. אם `ENABLE_SALESFORCE=true` אבל משהו חסר או לא תקין, החיבור **נשאר כבוי** ושום
דבר לא נשלח; ביומן השרת ובמסך האבטחה מופיעה הודעה שאומרת **איזה משתנה** לתקן (בלי להציג את הערך). בסנדבוקס
(`SANDBOX=true`) החיבור תמיד כבוי.

---

## 9. סדר ההדלקה

1. **ב-Salesforce:** שלבים 3–6 (משתמש, Permission Set, שדות, External Client App).
2. **ב-xhostd:** מגדירים את כל המשתנים מהטבלה **חוץ מ-`ENABLE_SALESFORCE`** (או משאירים אותו `false`), ומפעילים מחדש.
3. **בדיקת חיבור:** באתר, כמנהל מערכת → **ניהול אבטחה** → כרטיס **Salesforce** → **בדיקת חיבור**. הבדיקה **קוראת בלבד**:
   מתחברת, בודקת שהאובייקטים, השדות, החשבונות וסוגי הרשומה קיימים ומותרים לכתיבה — ולא יוצרת ולא משנה כלום.
   היא עובדת גם כשהחיבור כבוי. כל שורה אדומה מגיעה עם קוד והסבר (טבלת התקלות למטה).
4. כשהכול ירוק: `ENABLE_SALESFORCE=true` והפעלה מחדש. בכרטיס יופיע "פעיל".
5. **בדיקה מלאה לפני שמשאירים דלוק:** מועמד, משרה והגשה, אחד מכל אחד:
   - **מועמד:** נרשמים כמועמד בדיקה (מייל שלך) → Contact אחד בחשבון מועמדים קמביום, עם Beta, ובעלים = משתמש האינטגרציה.
   - **משרה:** יוצרים משרת בדיקה במסך ניהול המשרות (סטטוס מושהית, כדי שלא תופיע ללוח) → Case אחד מסוג Position,
     עם Beta. עורכים אותה → אותו Case מתעדכן. מסירים אותה מהלוח → `PStatus__c` = `Closed`.
     עם **תנאי סף** במשרה → `Threshold_Condition__c` מלא; מוחקים את התנאי → השדה מתרוקן (אותו Case).
   - **הגשה:** מגישים כמועמד הבדיקה למשרה → Case אחד מסוג הגשות קמביום, מקושר ל-Contact, עם קורות החיים.
     למשרה עם תנאי סף → `Threshold_Confirmed__c` מסומן ו-`Threshold_Confirmed_At__c` עם שעת האישור.
   - בכרטיס Salesforce המספרים עולים ב"נשלחו", ואין תקלות. אם משהו לא נכון — `ENABLE_SALESFORCE=false` ומתקנים.
6. **מה שקרה לפני ההדלקה לא נשלח** — אין כפתור לזה. בכרטיס רואים כמה יש (עמודת "לא נשלחו") וזהו.

**לכבות:** `ENABLE_SALESFORCE=false` (או למחוק אותו) והפעלה מחדש — מיד לא נשלח כלום. מה שכבר היה בתור מחכה,
ויישלח אם מדליקים שוב; מה שקורה בזמן שהחיבור כבוי לא נכנס לתור בכלל. לחסימה מצד Salesforce: להשבית את משתמש האינטגרציה או את ה-External Client App.

---

## 10. מה רואים במסך (ומה נרשם ביומן)

- **כרטיס Salesforce** במסך האבטחה (מנהלי מערכת בלבד): פעיל/כבוי, מה לתקן בהגדרות, תוצאת בדיקת החיבור, מספרים לכל
  סוג (נשלחו, בתור, נכשלו, לא נשלחו — מלפני ההדלקה, ולא יישלחו), ותקלות אחרונות — **סוג, מזהה רשומה, קוד שגיאה וכמה ניסיונות**. אין שם שמות,
  מיילים או טלפונים, ואין את מה ש-Salesforce החזיר — רק הקוד.
- **ניסיון חוזר:** תקלה זמנית (Salesforce לא זמין, רשת) נשלחת שוב לבד: אחרי דקה, 5 דקות, רבע שעה, שעה, 3, 6, 12 ו-24
  שעות. סירוב של Salesforce (קוד `http_400_…`, למשל שדה חובה או חוק כפילויות) **נעצר מיד** — מתקנים ב-Salesforce
  ולוחצים **"ננסה שוב את כולן"**.
- **אין כפילויות:** לפני כל יצירה האתר מחפש את הרשומה לפי המזהה שלה. ניסיון חוזר מעדכן את אותה רשומה, וקובץ קורות
  חיים נשלח פעם אחת לכל רשומה.
- **יומן הפעילות:** לפני כל שליחה של אנשים נרשם `salesforce.pushed` עם המזהים שלהם (מי נשלח, מתי). בדיקת חיבור
  וניסיון חוזר נרשמים גם הם (`salesforce.checked`, `salesforce.retried`).

---

## 11. תקלות נפוצות

| מה רואים | למה | מה עושים |
|---|---|---|
| "מבוקש אבל כבוי" + `SALESFORCE_LOGIN_URL must be the org's My Domain URL` | הוזן `login.salesforce.com` | להזין את כתובת My Domain (שלב 7) |
| `… is not a Salesforce Account id` / `Record Type id` | הוזן מזהה מסוג אחר (Account צריך `001`, סוג רשומה `012`) או עם רווח | להעתיק שוב (שלב 7) |
| `auth_invalid_client` | Consumer Key/Secret שגויים, **או** Client Credentials מסומן רק באחת משתי התיבות | לסמן גם ב-Settings וגם ב-Policies (שלב 6, סעיפים 3 ו-5); להעתיק שוב Key/Secret |
| `auth_invalid_grant` / `no client credentials user enabled` | אין **Run As**, או שמשתמש האינטגרציה מושבת | Policies → Run As (שלב 6.5) |
| `auth_net_…` | השרת לא מגיע לכתובת | לבדוק את `SALESFORCE_LOGIN_URL` |
| `api_version_not_available` | גרסה שהארגון לא מכיר | למחוק את `SALESFORCE_API_VERSION` (ברירת מחדל) |
| `fields_missing` + שם שדה | השדה לא קיים, **או** קיים אבל אין לו הרשאת שדה | Object Manager לבדוק שהוא קיים; ב-Permission Set → Field Permissions → Edit |
| `fields_not_writable` | יש Read בלי Edit לשדה | Field Permissions → Edit |
| `object_not_writable` / `http_403…` / `INSUFFICIENT_ACCESS` | חסרה הרשאת Create/Edit באובייקט | Object Settings (שלב 4) |
| `record_type_not_assigned` | סוג הרשומה לא משויך ל-Permission Set | Record Type Assignments (שלב 4.3) |
| `record_type_not_case` / `record_type_not_account` / `record_type_inactive` | מזהה של סוג רשומה של אובייקט אחר, או סוג לא פעיל | לבחור את הסוג הנכון (Case למשרות ולהגשות, Account לחברות) |
| `account_not_found` | מזהה חשבון שגוי, או שאין ל-Permission Set הרשאת Read על Accounts | לבדוק את המזהה; Accounts → Read |
| `http_400_DUPLICATES_DETECTED` | Duplicate Rule ב-Salesforce חסם (למשל הגשה מהירה במייל של מועמד רשום) | להחליט: לאפשר למשתמש האינטגרציה (Duplicate Rule → Action on Create: Allow + Report), או להשאיר חסום |
| `http_400_REQUIRED_FIELD_MISSING` / `FIELD_CUSTOM_VALIDATION_EXCEPTION` | שדה חובה או Validation Rule שהאתר לא ממלא | לפטור את משתמש האינטגרציה מהכלל, או לומר למפתח איזה שדה חסר |
| `cv_http_…` | הרשומה נוצרה אבל קובץ קורות החיים לא עלה | לרוב הרשאת קבצים; אחרי תיקון — "ננסה שוב" (הקובץ יישלח, הרשומה לא תשוכפל) |
| `INSUFFICIENT_ACCESS_OR_READONLY` על עדכון משרה | מישהו העביר את ה-Case לבעלים אחר ואין למשתמש גישת עריכה | Sharing Rule (שלב 4, ההערה) |
| `employer_id_field_missing` | אין `SKEELZ_Employer_Id__c` ב-Contact או ב-Account (או שאין לו Edit) | ליצור את השדה בשניהם (סעיף 5) ולתת Edit, ואז "ננסה שוב" |
| נתתי הרשאה ועדיין נכשל | Salesforce מחיל הרשאות על התחברות חדשה | לחכות עד חצי שעה, או ללחוץ "בדיקת חיבור" (היא מתחברת מחדש) ואז "ננסה שוב" |
| `beta_field_missing` | אין שדה Beta (Checkbox) ב-Contact, ב-Case או ב-Account, השם שונה, או שאין לו Edit ב-Permission Set | ליצור / לתקן את השם ב-`SALESFORCE_BETA_FIELD` / Field Permissions → Edit, ואז "ננסה שוב" |
| `imported_read_only` | ניסיון לשלוח משרה שיובאה מהאתר הקיים | תקין — זה בכוונה. היא לא נשלחת |
| `legacy_case_not_editable` | משתמש האינטגרציה לא יכול לערוך את ה-Position Cases של האתר הקיים (הבעלים: משתמש האינטגרציה שלו) | Sharing Rule: Read/Write ל-JOBS-XHOSTD על Cases מסוג Position — **לפני** `LEGACY_JOBS_MODE=owned` |
| `threshold_fields_missing` (כתום) | שדה של תנאי סף חסר ב-Case, בלי Edit ב-Permission Set, או מסוג אחר | ליצור לפי סעיף 5ב ולתת Edit. עד אז השדה הזה לא נשלח; כל השאר כן. אחרי התיקון — "בדיקת חיבור"; משרות ייכתבו בעריכה הבאה שלהן, הגשות — רק חדשות (אין שליחה לאחור) |

**בדיקה עצמית מהמחשב שלך** (לא חובה): בטרמינל, עם הערכים שלך (את ה-Secret מקלידים מקומית בלבד):

```bash
curl -s -X POST "https://<org>.my.salesforce.com/services/oauth2/token" -d grant_type=client_credentials -d client_id="$SF_KEY" -d client_secret="$SF_SECRET"
```

תשובה תקינה מכילה `access_token` ו-`instance_url`. מי שמריץ את השרת ממחשב עם קוד המקור יכול גם להריץ את אותה
בדיקת חיבור בטרמינל (קוראת בלבד):

```bash
cd server && npm run build && npm run sf:check
```

---

## 12. פרומפט מוכן לסשן שעובד מול Salesforce

להדביק כמו שהוא לסשן שיש לו גישה לארגון ה-Salesforce (למשל עם ה-skill של Skeelz ל-Salesforce):

```text
אני מחבר את אתר המשרות החדש SKEELZ Jobs לארגון ה-Salesforce של סקילז. האתר כותב ל-Salesforce דרך
API בלבד, כמשתמש אינטגרציה, ב-Client Credentials. אל תשנה שום Layout, Flow או נתון קיים, ואל תמחק כלום. אל תיגע
במשתמשי אינטגרציה קיימים. אל תציג ואל תכתוב את ה-Consumer Secret בשום מקום. לפני כל שינוי (שדה, הרשאות) — הראה
לי מה אתה עומד לעשות וחכה לאישור.

1. סוגי רשומה: תן לי Id + SobjectType + DeveloperName + Name + IsActive של:
   SELECT Id, SobjectType, DeveloperName, Name, IsActive FROM RecordType WHERE SobjectType IN ('Case', 'Account')
   הגשות = "הגשות קמביום" (RecordType2). משרות = אותו סוג של המשרות של האתר הקיים (Position) — אל תיצור סוג חדש.
   חשבונות של חברות מעסיקים = סוג ה-Account של ארגונים (ב-NPSP: Organization).
2. Beta: בדוק ששדה Beta (Checkbox) קיים ב-Contact, ב-Case וב-Account, באותו שם API בשלושתם, ותן לי את השם המדויק.
   אם חסר באחד מהם — אחרי אישור שלי צור Beta__c (Checkbox, ברירת מחדל false) רק באובייקט שחסר.
3. בדוק שהשדות האלה קיימים, ותן לי לכל אחד: קיים / סוג / אורך / האם External ID:
   Contact: ID_cambium__c, dateOfBirth_cambium__c, email_cambium__c, firstName_cambium__c, lastName_cambium__c,
     gender_cambium__c, citySymbol_cambium__c, phoneNumber_cambium__c, skills_cambium__c, CV_link_cambium__c
   Case: isSponserd_cambium__c, isMarked_cambium__c, isSelfApply_cambium__c, company_cambium__c, Position_cambium__c,
     PLocation_cambium__c, citySymbol_cambium__c, PTime_cambium__c, PSkills_cambium__c, PDescription_cambium__c,
     PComments_cambium__c, PFullName_cambium__c, PPhone_cambium__c, PEmail_cambium__c, PID_cambium__c, PLink_cambium__c,
     PStatus__c, PCreatedDate_cambium__c, PModifiedDate_cambium__c, A_ID_cambium__c, A_PID_cambium__c, A_CID_cambium__c
   ובנוסף ב-Case (תנאי סף): Threshold_Condition__c, Threshold_Confirmed__c, Threshold_Confirmed_At__c
   וב-Contact (תעודת זהות, אם נוצר): ID_Number__c
   וגם: אילו ערכים יש היום ב-PStatus__c במשרות מסוג Position (SELECT PStatus__c, COUNT(Id) FROM Case WHERE
   RecordType.DeveloperName = 'Position' GROUP BY PStatus__c). האתר שולח Active / Suspended / Closed.
4. אחרי אישור שלי: צור שדה SKEELZ_Employer_Id__c — Text(24), Unique, External ID, Label "SKEELZ Employer Id" — גם
   ב-Contact וגם ב-Account; ובנוסף ב-Contact: Is_SKEELZ_Employer__c — Checkbox, ברירת מחדל false, Label "SKEELZ Employer".
   אל תוסיף אותם לאף Layout בלי אישור.
4א. אחרי אישור שלי: צור ב-Case שלושה שדות לתנאי סף (אם אינם):
   Threshold_Condition__c — Text Area (Long), Length 1000, Visible Lines 3, Label "תנאי סף";
   Threshold_Confirmed__c — Checkbox, ברירת מחדל false, Label "אישר תנאי סף";
   Threshold_Confirmed_At__c — Date/Time, Label "מועד אישור תנאי סף".
   FLS: Read לפרופילים System Administrator, Executive Management, Standard User (Read-Only — הצוות לא עורך).
   הצע (וחכה לאישור) להוסיף את Threshold_Condition__c ל-Layout של Position, ואת שני האחרים ל-Layout "Interested"
   של הגשות קמביום (RecordType2).
5. אחרי אישור שלי: סמן External ID על Contact.ID_cambium__c, Case.PID_cambium__c, Case.A_ID_cambium__c (אם עוד לא).
6. אחרי אישור שלי: צור Permission Set בשם "JOBS-XHOSTD Integration" (License: None; כבר קיים — רק השלם מה שחסר) עם:
   Contact: Read, Create, Edit, View All (בלי Delete); Case: Read, Create, Edit, View All (בלי Delete);
   Account: Read, Create, Edit, View All (בלי Delete);
   Field Permissions Edit לכל השדות בסעיף 3 + Case.ContactId + Contact: FirstName, LastName, Email, Phone, Birthdate,
   AccountId, Title, Description + Account: Name, Description + SKEELZ_Employer_Id__c (בשניהם) + Is_SKEELZ_Employer__c +
   שדה ה-Beta בשלושתם + Case: Threshold_Condition__c, Threshold_Confirmed__c, Threshold_Confirmed_At__c;
   Record Type Assignments: Case — הגשות קמביום + Position; Account — Organization.
   שייך אותו למשתמש האינטגרציה <integration-user> (ודא שיש לו License "Salesforce Integration", Profile
   "Minimum Access - API Only Integrations" ו-Permission Set License "Salesforce API Integration").
7. בדוק ודווח (בלי לשנות): Validation Rules פעילים על Contact, Case ו-Account; Flows / Process Builders שמשנים
   OwnerId של Case או רצים על Account חדש; Duplicate Rules על Account (חברה בשם שכבר קיים). Assignment Rules לא
   ירוצו על מה שהאתר כותב (הוא שולח Sforce-Auto-Assign: FALSE) — רק אשר שזה כך אצלנו.
8. External Client App: את זה אעשה בעצמי בממשק (Client Credentials בשתי התיבות, Run As = משתמש האינטגרציה). רק תגיד
   לי אם קיים כבר External Client App או Connected App עם Client Credentials שמשתמש באותו Run As.
9. בסוף תן לי טבלה: SALESFORCE_CONTACTS_ACCOUNT_ID (החשבון "מועמדים קמביום"), SALESFORCE_JOBAPPLICATIONS_ACCOUNT_ID
   (החשבון של Cases ההגשות), SALESFORCE_CASE_ACCOUNT_ID ("משרות קמביום"), SALESFORCE_JOBAPPLICATIONS_CASE_RECORD_TYPE_ID
   (RecordType2), SALESFORCE_CASE_RECORD_TYPE_ID (Position), SALESFORCE_EMPLOYER_ACCOUNT_RECORD_TYPE_ID (Organization),
   SALESFORCE_BETA_FIELD (רק אם השם אינו Beta__c), SALESFORCE_LOGIN_URL (My Domain) — עם הערך ומאיפה לקחת אותו.
   את מזהי החשבונות קח מהרשומות האחרונות שהאתר הקיים יצר מכל סוג (Contact של מועמד, Case של הגשה, Case של משרה),
   והצג לי לאישור.
```

---

## 13. ההחלטות שנשארו לך

רוב ההחלטות התקבלו (סעיף 2). נשארו רק דברים לבצע ולאשר:

1. ~~להריץ את הפרומפט~~ — **נעשה** (17.11.2026): משתמש, Permission Set, שדות, External ID. נשאר רק לוודא את שיוך
   סוגי הרשומה ל-Permission Set (בדיקת החיבור תראה `record_type_not_assigned` אם חסר), ולהוסיף את שדות תנאי הסף
   ל-Layouts אם רוצים לראות אותם.
2. ~~ערכי `PStatus__c`~~ — **סגור:** במשרות של היום יש רק `Active` / `Suspended` / `Closed`; אין מה להתאים באתר.
3. **Flows** (סעיף 2א): להחליט אם להוסיף תנאי Beta ל-`new_position_publish` ול-`SKZ_Position_Closed_Notify` (אחרת
   משרות בדיקה ישלחו מיילים לצוות), ואם להוסיף את JOBS-XHOSTD ל-`SKZ_Handler_From_Case` (לא הכרחי). ולאשר את תיקון
   הפער של `new_applied` (משרה בלי Case → נשלחת לפני ההגשה).
4. **אותה חברה, כמה מעסיקים:** כל מעסיק רשום מקבל Account משלו. אם שני אנשים מאותה חברה נרשמים, יהיו שני חשבונות
   בשם החברה (אפשר למזג ידנית ב-Salesforce). אם תרצה שיתחברו אוטומטית לחשבון אחד — זה פיתוח נוסף.
5. **להעתיק את הערכים ל-xhostd** (סעיף 8), לבדוק חיבור, ואז את הבדיקה המלאה (סעיף 9, שלב 5) — ורק אז להשאיר דלוק.

---

## 14. למפתחים (בקצרה)

- הגדרות ובדיקתן: `server/src/config/salesforceSettings.ts` (טהור, נבדק ב-`test/unit/salesforce.test.ts`).
- התחברות: `server/src/config/salesforceConfig.ts` — Client Credentials, הסוד בגוף ה-POST, token במטמון 30 דקות
  (הקודם מבוטל לפני חידוש), ניסיון חוזר אחד ב-401.
- מיפוי השדות: `server/src/utils/salesforceUtils.ts` (`fieldsWritten()` מופק מהפונקציות עצמן — בדיקת החיבור והטבלה למעלה).
- פעולות (כולן אידמפוטנטיות, בלי מחיקה): `server/src/services/salesforceService.ts`.
- התור והעובד: `server/src/services/salesforceSync.ts` (`queueSalesforce(kind, id)` מכל נתיב באתר; לעולם לא קריאה ישירה
  מבקשה), כללי הניסיון החוזר: `salesforceSyncPure.ts`.
- בדיקת החיבור: `server/src/services/salesforceCheck.ts`, מסך: `client/src/components/security/SalesforceSync.tsx`,
  נתיבים: `/api/admin/security/salesforce`, `/check`, `/retry` (`adminOnly`). אין נתיב לשליחה לאחור (החלטת הבעלים).
- e2e מול Salesforce מדומה: `server/test/e2e-salesforce.mjs` + `server/test/helpers/mockSalesforce.mjs` (אף פעם לא ארגון אמיתי).
