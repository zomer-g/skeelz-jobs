import React, { useEffect, useRef, useState } from 'react';
import { FormikProps } from 'formik';
import { RegisterFormValues } from '../../models/interfaces/Props.interfaces';
import UserDetails from './UserDetails';
import UserSkills from './UserSkills';
import { UserService } from '../../services/api/User.service';
import { isString } from '../../utils/utils';
import { applyContextParams, clearApplyContext, track } from '../../utils/analytics';
import { i18n } from '../../i18n/I18n';
import {LeftArrowIcon } from '../../icons';
import Button from '../common/Button';
import useToastStore from '../../store/Toast.store';
import useAuthStore from '../../store/Auth.store';
import { Spinner } from 'react-bootstrap';
import { LoginService } from '../../services/api/Login.service';

/**
 * register     "new user": email + password sign-up.
 * sso-signup   after "Continue with Google" with a new identity: email from Google (read-only), no password;
 *              the account is created only when this form is sent.
 * complete     an account missing required details (e.g. created by an earlier Google sign-in): same form.
 * edit         the personal area: a candidate edits their own details (email read-only).
 */
export type RegisterMode = 'register' | 'sso-signup' | 'complete' | 'edit';

// What the server accepts for a candidate's own details (server/src/security/pure.ts PROFILE_FIELDS).
const profileFields = (v: RegisterFormValues) => ({
    firstName: v.firstName, lastName: v.lastName, phoneNumber: v.phoneNumber, citySymbol: Number(v.citySymbol) || undefined,
    gender: v.gender || undefined, dateOfBirth: v.dateOfBirth || undefined, skills: v.skills ?? [],
    ...(v.cvFileUrl ? { cvFileUrl: v.cvFileUrl } : {}),
});

const RegisterUser: React.FC<{ onSuccess: () => void; mode?: RegisterMode; prefill?: Partial<RegisterFormValues>; hasCv?: boolean }> = ({ onSuccess, mode = 'register', prefill, hasCv }) => {
    const translations = i18n.getTranslations();
    const formikRef = useRef<FormikProps<RegisterFormValues>>(null);
    const [step, setStep] = useState<number>(1);
    const transaltions = i18n.getTranslations();
    const { showToast } = useToastStore();
    const setUser = useAuthStore.getState().setUser;
    const [blockButton,setBlockButton] = useState(false)
    useEffect(() => { if (mode === 'register' || mode === 'sso-signup') track('sign_up_start', applyContextParams()); }, []);
    const tp = translations.Profile;
    const intro = mode === 'sso-signup' ? tp.SignUpIntro : mode === 'complete' ? tp.CompleteIntro : '';
    const emailHint = mode === 'sso-signup' ? tp.EmailFromGoogle : mode === 'register' ? undefined : tp.EmailReadOnly;
    const [userData, setUserData] = useState<RegisterFormValues>({
        email: '',
        gender: null,
        firstName: '',
        lastName: '',
        dateOfBirth: null,
        phoneNumber: '',
        citySymbol: 0,
        password: '',
        confirmPassword: '',
        skills: [],
        cvFileUrl:'',
        hasAppliedToJob: false,
        ...prefill,
    });


    const handleUserDetailsSubmit = (values: RegisterFormValues) => {
        setUserData((prevData) => ({ ...prevData, ...values }));
        setStep(2);
    };

    const goBackToUserDetails = () => {
        setStep(1);
    };

    const handleUserSkillsChange = (skills: string[]) => {
        setUserData((prevData) => ({ ...prevData, skills }));
    };

    const handleFinalSubmit = async () => {
        if (mode === 'sso-signup') {
            const r = await LoginService.getInstance().completeSsoSignup(profileFields(userData));
            if (isString(r)) { setBlockButton(false); showToast(r, 'error'); return; }
            setUser({ ...r.user, jobApplicationsId: r.jobApplicationsId } as any);
            track('sign_up', { method: 'google', ...applyContextParams() });
            clearApplyContext();
            onSuccess();
            return;
        }
        if (mode === 'complete' || mode === 'edit') {
            const r = await UserService.getInstance().updateMe(profileFields(userData));
            if (isString(r)) { setBlockButton(false); showToast(r, 'error'); return; }
            const current = useAuthStore.getState().user;
            setUser({ ...(current ?? {}), ...r.user } as any);
            showToast(tp.Saved, 'success');
            onSuccess();
            return;
        }
        const result = await UserService.getInstance().createNewUser(userData);
        if (isString(result)) {
            setBlockButton(false)
            showToast(result, "error");
        } else {
            setUser(result.user);
            track('sign_up', { method: 'email', ...applyContextParams() });
            clearApplyContext();
            onSuccess();
            // show success toast or message
        }
    };

    const nextStepOrSubmit = () => {
        if (step === 1) {
            if (formikRef.current) {
                formikRef.current.submitForm().then(() => {
                    if (formikRef.current?.isValid) {
                        handleUserDetailsSubmit(formikRef.current.values);
                    }
                });
            }
        } else {
            setBlockButton(true)
            handleFinalSubmit();
        }
    };
    return (
        <div>
            <div className=''>
                {step === 1 ? (
                    <div className=' overflow-auto'>
                        {intro && <p className="font-RubikRegular fs-1-125rem px-4 pt-3 mb-0" role="note">{intro}</p>}
                        <UserDetails
                         initialData = {userData}
                          formikRef = {formikRef}
                           handleSubmit = {handleUserDetailsSubmit}
                           noPassword = {mode !== 'register'}
                           emailReadOnlyHint = {emailHint}
                           cvHint = {hasCv ? tp.CurrentCv : undefined}
                    /></div>
                ) : (
                    <UserSkills
                        initialSelectedSkills={userData.skills}
                        onSkillsChange={handleUserSkillsChange}
                    />
                )}
            </div>
            <div className={`text-start bg-light position-sticky bottom-0 w-100 border-top border-dark border-radius-b-40 py-2 px-3 height-5-625rem d-flex ${step === 2 ? 'justify-content-between' : 'justify-content-end'}`} >
                {step === 2 && <Button
                    className='font-RubikMedium bg-white mt-3 ms-1 px-5 py-2 fs-6 text-color-dark-green-2 border-color-dark-green-2 rounded-pill text-center'
                    onClick={goBackToUserDetails}
                >
                    {transaltions.Register.Back}
                </Button>}
                <Button
                    className="font-RubikMedium bg-color-dark-green-2 mt-3 ms-1 px-4 py-2 fs-6 rounded-pill text-center"
                    onClick={nextStepOrSubmit}
                    disabled={blockButton} // Prevents clicking when loading
                >
                    {step === 1 ? (
                        <>
                            {translations.Register.Next}
                            <span className="pe-2">
                                <LeftArrowIcon />
                            </span>
                        </>
                    ) : blockButton ? (
                        <Spinner animation="border" size="sm" />
                    ) : (
                        mode === 'edit' || mode === 'complete' ? tp.Save : translations.Register.CompleteRegistration
                    )}
                </Button>

            </div>
        </div>
    );
};

export default RegisterUser;
