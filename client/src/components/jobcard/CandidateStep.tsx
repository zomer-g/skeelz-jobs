// "Every signed-in person is a candidate" (owner, 24.11.2026; docs/security.md "Several roles per account").
//
// A signed-in account without the candidate role (an employer only, or a staff member on Google) presses
// "הגש מועמדות": instead of being sent away, it gets the candidate details step right here, in the apply dialog —
// the same sign-up form and consent boxes as every candidate (RegisterUser mode add-candidate →
// POST /api/users/me/roles/candidate: sign-up fields checked, consent recorded in consent_records). When it is saved
// the application goes on at once (onJoined). Nothing is added without this form: the role brings new data (details,
// CV, applications) and the candidate's consent.
//
// A candidate role an admin blocked is never added back (server 403 role_blocked): BlockedCandidateNote says so in
// place, with a way out.
import React, { useEffect, useRef } from 'react';
import RegisterUser from '../register/RegisterUser';
import Button from '../common/Button';
import { User } from '../../models/interfaces/Props.interfaces';
import { i18n } from '../../i18n/I18n';

export const isCandidateBlocked = (u: User | null | undefined): boolean => !!u?.blockedRoles?.includes('user');

export const CandidateStep: React.FC<{ user: User; onJoined: () => void }> = ({ user, onJoined }) => {
  const t = i18n.getTranslations().ApplyFlow;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  const clean = (v?: string) => (v && v !== '-' ? v : '');
  return (
    <section aria-labelledby="candidate-step-title" data-testid="candidate-step">
      <div className="px-4 pt-4">
        <h2 id="candidate-step-title" ref={headingRef} tabIndex={-1} className="font-RubikBold fs-5 mb-2">{t.CandidateStepTitle}</h2>
        <p className="font-RubikRegular mb-0">{t.CandidateStepIntro}</p>
      </div>
      <RegisterUser mode="add-candidate" onSuccess={onJoined}
        prefill={{ email: user.email, firstName: clean(user.firstName), lastName: clean(user.lastName), phoneNumber: user.phoneNumber ?? '' }} />
    </section>
  );
};

export const BlockedCandidateNote: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const t = i18n.getTranslations().ApplyFlow;
  return (
    <div className="d-flex flex-column align-items-center text-center p-4 gap-3" data-testid="candidate-blocked">
      <div role="alert" className="apply-note apply-note-stop w-100">
        <h2 className="font-RubikBold fs-5 mb-2">{t.BlockedTitle}</h2>
        <p className="font-RubikRegular mb-0">{t.BlockedText}</p>
      </div>
      <Button className="font-RubikMedium bg-color-dark-green-2 px-5" onClick={onClose}>{t.Close}</Button>
    </div>
  );
};
