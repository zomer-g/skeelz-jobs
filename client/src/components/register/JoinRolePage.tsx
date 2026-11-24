// Several roles per account (owner, 23.11.2026): a signed-in account adds the candidate or the employer role to
// itself, on the same account (same email, same sign-in). The forms are the usual sign-up forms (details + consent);
// the server takes the account from the session (POST /api/users/me/roles/<role>, rolesController.ts). Staff roles are
// never added here: an admin gives them on the staff screen.
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { i18n } from '../../i18n/I18n';
import useAuthStore from '../../store/Auth.store';
import useLanguageStore from '../../store/Language.store';
import { ClientRoutes } from '../../i18n/ClientRoutes.enum';
import { isCandidateUser, isEmployerUser } from '../../i18n/General.enums';
import { UserService } from '../../services/api/User.service';
import { LoginService } from '../../services/api/Login.service';
import { isString } from '../../utils/utils';
import RegisterUser from './RegisterUser';
import EmployerSignUp from '../employer/EmployerSignUp';

const TEXT = {
  candidateTitle: 'הצטרפות גם כמועמד/ת',
  candidateIntro: 'החשבון שלך נשאר אותו חשבון, עם אותה כתובת מייל ואותה כניסה. אחרי שתמלאו את הפרטים יהיה לכם גם אזור אישי של מועמד/ת.',
  employerTitle: 'הצטרפות גם כמעסיק',
  employerIntro: 'החשבון שלך נשאר אותו חשבון, עם אותה כתובת מייל ואותה כניסה. אחרי שתמלאו את פרטי החברה יהיה לכם גם אזור מעסיק.',
  already: 'כבר יש לחשבון הזה את התפקיד הזה.',
  signIn: 'צריך להתחבר קודם.',
};

const JoinRolePage: React.FC<{ role: 'candidate' | 'employer' }> = ({ role }) => {
  useLanguageStore();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore.getState().setUser;
  const navigate = useNavigate();
  const rtl = i18n.isRTL() ? 'rtl' : 'ltr';

  if (!user) return <main className="container py-5" dir={rtl}><p role="alert">{TEXT.signIn}</p></main>;
  const holds = role === 'candidate' ? isCandidateUser(user) : isEmployerUser(user);
  if (holds) return <main className="container py-5" dir={rtl}><p role="status">{TEXT.already}</p></main>;

  const refresh = async () => {
    const s = await LoginService.getInstance().getSession();
    if (s && !isString(s)) setUser({ ...s.user, jobApplicationsId: s.jobApplicationsId } as any);
  };

  return (
    <main className="container py-4" dir={rtl} aria-labelledby="join-role-title" style={{ maxWidth: 720 }}>
      <h1 id="join-role-title" className="fs-3 mb-2">{role === 'candidate' ? TEXT.candidateTitle : TEXT.employerTitle}</h1>
      <p className="mb-3">{role === 'candidate' ? TEXT.candidateIntro : TEXT.employerIntro}</p>
      <div className="border rounded-4 bg-white">
        {role === 'candidate' ? (
          <RegisterUser mode="add-candidate" prefill={{ email: user.email, firstName: user.firstName, lastName: user.lastName }}
            onSuccess={() => navigate(ClientRoutes.JobApplicationsManagement)} />
        ) : (
          <EmployerSignUp email={user.email} emailHint={i18n.getTranslations().Profile.EmailReadOnly}
            prefill={{ firstName: user.firstName ?? '', lastName: user.lastName ?? '' }}
            submit={async (values) => {
              const r = await UserService.getInstance().addMyRole('employer', values);
              if (isString(r)) return r;
              await refresh();
              navigate(ClientRoutes.EmployerArea);
              return null;
            }} />
        )}
      </div>
    </main>
  );
};

export default JoinRolePage;
