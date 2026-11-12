import React from 'react';
import RegisterUser, { RegisterMode } from './RegisterUser';
import useModalStore from '../../store/Modal.store';
import useToastStore from '../../store/Toast.store';
import { LoginService } from '../../services/api/Login.service';
import { UserService } from '../../services/api/User.service';
import { i18n } from '../../i18n/I18n';
import { Gender } from '../../i18n/General.enums';
import { RegisterFormValues } from '../../models/interfaces/Props.interfaces';
import { isString } from '../../utils/utils';

/** The candidate's stored record → the form's values (no password; CV only as "you have one"). */
const fromUser = (u: any): Partial<RegisterFormValues> => ({
  email: u?.email ?? '',
  firstName: u?.firstName && u.firstName !== '-' ? u.firstName : '',
  lastName: u?.lastName && u.lastName !== '-' ? u.lastName : '',
  phoneNumber: u?.phoneNumber ?? '',
  citySymbol: Number(u?.citySymbol) > 0 ? Number(u.citySymbol) : 0,
  gender: (Object.values(Gender) as string[]).includes(u?.gender) ? (u.gender as Gender) : null,
  dateOfBirth: u?.dateOfBirth ? new Date(u.dateOfBirth) : null,
  skills: Array.isArray(u?.skills) ? u.skills.map(String) : [],
  cvFileUrl: '',
});

/**
 * Opens the details form in the site modal:
 *   openSsoSignup  after "Continue with Google" with a new identity (?signin=signup)
 *   openComplete   a signed-in candidate whose required details are missing
 *   openEdit       the personal area ("My details")
 */
export const useProfileModals = () => {
  const { initModal, closeModal } = useModalStore();
  const { showToast } = useToastStore();
  const t = () => i18n.getTranslations();

  const open = (mode: RegisterMode, title: string, prefill: Partial<RegisterFormValues>, hasCv: boolean, doneText?: string) =>
    initModal({
      active: true,
      modalTitle: title,
      modalBody: (
        <RegisterUser
          mode={mode}
          prefill={prefill}
          hasCv={hasCv}
          onSuccess={() => { closeModal(); if (doneText) showToast(doneText, 'success'); }}
        />
      ),
      modalStyle: { dialogClassName: 'max-width-72-06rem', bodyClass: 'p-0', titleClass: 'font-RubikBold fs-4' },
    });

  const openSsoSignup = async () => {
    const p = await LoginService.getInstance().getPendingSignup();
    if (!p || isString(p)) {
      showToast(t().AuthErrorMessages.SSO_SIGNUP_EXPIRED, 'error');
      return;
    }
    open('sso-signup', t().Profile.SignUpTitle, { email: p.email, firstName: p.firstName, lastName: p.lastName }, false, t().Profile.SignedUp);
  };

  const openOwn = async (mode: 'complete' | 'edit') => {
    const me = await UserService.getInstance().getMe();
    if (isString(me)) {
      showToast(me, 'error');
      return;
    }
    open(mode, mode === 'edit' ? t().Profile.EditTitle : t().Profile.CompleteTitle, fromUser(me.user), !!me.user?.cvFileUrl);
  };

  return { openSsoSignup, openComplete: () => openOwn('complete'), openEdit: () => openOwn('edit') };
};
