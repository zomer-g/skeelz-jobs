import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ClientRoutes } from "../../i18n/ClientRoutes.enum";
import Button from "../common/Button";
import { User } from "../../models/interfaces/Props.interfaces";
import { i18n } from "../../i18n/I18n";
import { LogoutIcon } from "../../icons";
import { ROLE_LABELS, UserRole, canManageContent, canViewStaffData } from "../../i18n/General.enums";

export const AdminPanelHeader: React.FC<{ user: User | null, logOutCallback: () => void }> = ({ user, logOutCallback }) => {

    const navigate = useNavigate();
    const { pathname } = useLocation();
    const translations = i18n.getTranslations();
    const isSandbox = typeof window !== 'undefined' && window.__SANDBOX__ === true;
    const [refreshing, setRefreshing] = useState(false);
    // Coordinators and content managers → jobs + candidates; admins → the same, plus security + staff users.
    const isAdmin = user?.role === UserRole.ADMIN;
    const links: { to: string; label: string; match: (p: string) => boolean }[] = [
      ...(canViewStaffData(user?.role) ? [
        { to: ClientRoutes.JobsManagement, label: translations.Header.Jobs, match: (p: string) => p.startsWith(ClientRoutes.JobsManagement) },
        { to: ClientRoutes.UsersManagement, label: 'מועמדים', match: (p: string) => p === ClientRoutes.UsersManagement },
      ] : []),
      // Settings (sign-up form, job form, applying) and service emails (events + templates): content managers and admins.
      ...(canManageContent(user?.role) ? [
        { to: ClientRoutes.Settings, label: 'הגדרות', match: (p: string) => p === ClientRoutes.Settings },
        { to: ClientRoutes.MailManagement, label: 'מיילים', match: (p: string) => p === ClientRoutes.MailManagement },
      ] : []),
      ...(isAdmin ? [
        { to: ClientRoutes.SecurityManagement, label: 'אבטחה', match: (p: string) => p === ClientRoutes.SecurityManagement },
        { to: ClientRoutes.StaffManagement, label: 'צוות והרשאות', match: (p: string) => p === ClientRoutes.StaffManagement },
      ] : []),
    ];

    // Banner (admins only — the alerts go to them): open security alerts, access reviews due, log write failures.
    const [security, setSecurity] = useState<{ alerts: number; reviewsDue: number; auditFailures: number } | null>(null);
    useEffect(() => {
      if (!user || !isAdmin) return;
      fetch('/api/admin/security', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((b) => b?.data && setSecurity({ alerts: b.data.alerts.length, reviewsDue: b.data.reviewsDue, auditFailures: b.data.auditFailures.count }))
        .catch(() => undefined);
    }, [user]);
    const securityNotes = security ? [
      security.alerts ? `${security.alerts} התראות אבטחה פתוחות` : '',
      security.reviewsDue ? `${security.reviewsDue} אנשי צוות ממתינים לסקירת הרשאות` : '',
      security.auditFailures ? `${security.auditFailures} כשלים בכתיבה ליומן הפעילות` : '',
    ].filter(Boolean) : [];

    // Sandbox only: replace this environment's data with a fresh copy of prod's.
    const refreshFromProd = async () => {
      if (!window.confirm('למשוך עכשיו עותק טרי של הנתונים מהפרודקשן?\nכל מה שנכתב בסנדבוקס (משרות, משתמשים, הגשות) יימחק ויוחלף.')) return;
      setRefreshing(true);
      try {
        const res = await fetch('/api/internal/sandbox-refresh', { method: 'POST', credentials: 'same-origin' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
        const c = body.data?.counts || {};
        window.alert(`הנתונים נמשכו: ${c.jobs ?? 0} משרות, ${c.users ?? 0} משתמשים, ${c.job_applications ?? 0} הגשות`);
        window.location.reload();
      } catch (e) {
        window.alert(`המשיכה נכשלה: ${(e as Error).message}`);
      } finally {
        setRefreshing(false);
      }
    };

    return (
      <>
      {securityNotes.length > 0 && (
        <div dir="rtl" role="alert" className="staff-banner w-100 d-flex justify-content-center align-items-center gap-3 py-1" style={{ background: '#b00020', color: '#fff' }}>
          <span className="font-RubikMedium">{securityNotes.join(' · ')}</span>
          <button type="button" className="btn btn-sm btn-light" onClick={() => navigate(ClientRoutes.SecurityManagement)}>למסך האבטחה</button>
        </div>
      )}
      {isSandbox && isAdmin && (
        <div dir="rtl" className="w-100 d-flex justify-content-center align-items-center gap-3 py-1" style={{ background: '#ffd54f', color: '#000' }}>
          <span className="font-RubikMedium">סביבת בדיקה (סנדבוקס) — הנתונים כאן לא משפיעים על האתר החי</span>
          <button type="button" className="btn btn-sm btn-dark" disabled={refreshing} onClick={refreshFromProd}>
            {refreshing ? 'מושך…' : 'משוך נתונים מהפרודקשן'}
          </button>
        </div>
      )}
      <div className='staff-header height-7-313rem justify-content-center d-flex flex-column align-items-center border-bottom border-2 border-black'>

        <div className="staff-header__row d-flex align-items-center p-1 w-100 justify-content-between position-relative max-width-75-375rem">
          {/* Logo (Right) */}
          <a href={ClientRoutes.MainPage}>
            <img src="/images/logo.svg" alt="Logo" className="logo" />
          </a>

          {/* Middle Buttons (Aligned to Right) */}
          <nav className="staff-nav ms-auto pe-lg-5" aria-label="ניהול">
            <ul className="staff-nav__list">
              {links.map((l) => {
                const current = l.match(pathname);
                return (
                  <li key={l.to}>
                    <a href={l.to} className={`staff-nav__link${current ? ' is-current' : ''}`} aria-current={current ? 'page' : undefined}
                      onClick={(e) => { e.preventDefault(); navigate(l.to); }}>{l.label}</a>
                  </li>
                );
              })}
            </ul>
            {user && <span className="staff-nav__role">{ROLE_LABELS[user.role] ?? user.role}</span>}
          </nav>

          {/* Logout Button (Left) */}
          {user && <div>
            <Button
              className="border-0 bg-color-white-btn text-color-purple"
              onClick={logOutCallback}
            >
              <span className="font-RubikMedium px-3 py-1">
                {translations.Header.Logout}
              </span>
            </Button>
          </div>}
        </div>
      </div>
      </>
    );
  };
