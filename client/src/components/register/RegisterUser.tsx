import React, { useEffect, useRef, useState } from 'react';
import { FormikProps } from 'formik';
import { RegisterFormValues } from '../../models/interfaces/Props.interfaces';
import UserDetails from './UserDetails';
import UserSkills from './UserSkills';
import { UserService } from '../../services/api/User.service';
import { isString } from '../../utils/utils';
import { applyContextParams, clearApplyContext, track, ssoSignUpMethod } from '../../utils/analytics';
import { i18n } from '../../i18n/I18n';
import {LeftArrowIcon } from '../../icons';
import Button from '../common/Button';
import useToastStore from '../../store/Toast.store';
import useAuthStore from '../../store/Auth.store';
import { Spinner } from 'react-bootstrap';
import { LoginService } from '../../services/api/Login.service';
import ConsentChecks, { ConsentValues } from '../consent/ConsentChecks';
import MarketingConsentToggle from '../consent/MarketingConsentToggle';
import { SignupFields, loadSignupFields } from '../../utils/signupFields';
import { FormField, loadSignupCustomFields, valuesToSend } from '../../utils/customFields';
import { lastApiErrorCode } from '../../utils/lastApiError';

/**
 * email-signup after a right code by email for a new address ("קבלת קוד למייל"): email read-only (the verified
 *              address, held by the server in a signed cookie); the account is created only when this form is sent.
 * sso-signup   after "Continue with Google" with a new identity: email from Google (read-only);
 *              the account is created only when this form is sent.
 * Candidates have no password (since 11.2026).
 * complete     an account missing required details (e.g. created by an earlier Google sign-in): same form.
 * edit         the personal area: a candidate edits their own details (email read-only).
 * add-candidate  a signed-in staff member or employer becomes a candidate too, on the same account (several roles
 *              per account since 23.11.2026): the sign-up form and consent, sent to POST /api/users/me/roles/candidate.
 */
export type RegisterMode = 'email-signup' | 'sso-signup' | 'complete' | 'edit' | 'add-candidate';

// What the server accepts for a candidate's own details (server/src/security/pure.ts PROFILE_FIELDS).
// The ID number: left out when the setting hides it; in the personal area an empty one clears it.
const profileFields = (v: RegisterFormValues, fields: SignupFields, own: boolean, custom: FormField[] = []) => ({
    firstName: v.firstName, lastName: v.lastName, phoneNumber: v.phoneNumber || undefined, citySymbol: Number(v.citySymbol) || undefined,
    gender: v.gender || undefined, dateOfBirth: v.dateOfBirth || undefined, skills: v.skills ?? [],
    ...(fields.idNumber === 'hidden' ? {} : own ? { idNumber: v.idNumber ?? '' } : v.idNumber ? { idNumber: v.idNumber } : {}),
    ...(v.cvFileUrl ? { cvFileUrl: v.cvFileUrl } : {}),
    // The added questions (settings screen): every one of them, '' / false = no answer.
    ...(custom.length ? { customFields: valuesToSend(custom, v.customFields) } : {}),
});

const RegisterUser: React.FC<{ onSuccess: () => void; mode?: RegisterMode; prefill?: Partial<RegisterFormValues>; hasCv?: boolean }> = ({ onSuccess, mode = 'email-signup', prefill, hasCv }) => {
    const translations = i18n.getTranslations();
    const formikRef = useRef<FormikProps<RegisterFormValues>>(null);
    const [step, setStep] = useState<number>(1);
    const transaltions = i18n.getTranslations();
    const { showToast } = useToastStore();
    const setUser = useAuthStore.getState().setUser;
    const [blockButton,setBlockButton] = useState(false)
    // Sign-up only: the required terms box and the optional marketing box (server/src/security/consent.ts).
    const isSignUp = mode === 'email-signup' || mode === 'sso-signup' || mode === 'add-candidate';
    const [consent, setConsent] = useState<ConsentValues>({ consent: false, marketingConsent: false });
    const [consentError, setConsentError] = useState(false);
    // A refusal from the server, said next to the button (role="alert"), not in a toast.
    const [submitError, setSubmitError] = useState('');
    const errorRef = useRef<HTMLDivElement>(null);
    const fail = (text: string) => {
        setBlockButton(false);
        // A candidate role an admin blocked on this account is never added back (server 403 role_blocked).
        setSubmitError(lastApiErrorCode() === 'role_blocked' ? translations.ApplyFlow.BlockedText : text);
        setTimeout(() => errorRef.current?.focus(), 0);
    };
    useEffect(() => { if (isSignUp) track('sign_up_start', applyContextParams()); }, []);
    // Which fields are required / optional / hidden (admins' setting; the server checks the same).
    const [fields, setFields] = useState<SignupFields | null>(null);
    const [customFields, setCustomFields] = useState<FormField[] | null>(null);
    useEffect(() => {
        let alive = true;
        Promise.all([loadSignupFields(), loadSignupCustomFields()]).then(([f, c]) => { if (alive) { setFields(f); setCustomFields(c); } });
        return () => { alive = false; };
    }, []);
    const tp = translations.Profile;
    const intro = mode === 'sso-signup' ? tp.SignUpIntro : mode === 'email-signup' ? tp.EmailSignUpIntro : mode === 'complete' ? tp.CompleteIntro : '';
    const emailHint = mode === 'sso-signup' ? tp.EmailFromGoogle : mode === 'email-signup' ? tp.EmailFromCode : tp.EmailReadOnly;
    const [userData, setUserData] = useState<RegisterFormValues>({
        email: '',
        gender: null,
        firstName: '',
        lastName: '',
        dateOfBirth: null,
        phoneNumber: '',
        citySymbol: 0,
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
        setSubmitError('');
        if (isSignUp && !consent.consent) {
            setConsentError(true);
            setBlockButton(false);
            document.getElementById('signup-consent')?.focus();
            return;
        }
        if (mode === 'sso-signup' || mode === 'email-signup') {
            const values = { ...profileFields(userData, fields!, false, customFields ?? []), ...consent };
            const r = mode === 'sso-signup'
                ? await LoginService.getInstance().completeSsoSignup(values)
                : await LoginService.getInstance().completeEmailSignup(values);
            if (isString(r)) { fail(r); return; }
            setUser({ ...r.user, jobApplicationsId: r.jobApplicationsId } as any);
            track('sign_up', { method: mode === 'sso-signup' ? ssoSignUpMethod() : 'email_code', ...applyContextParams() });
            clearApplyContext();
            onSuccess();
            return;
        }
        if (mode === 'add-candidate') {
            // The added sign-up questions too (the server asks for the required ones, like every sign-up).
            const r = await UserService.getInstance().addMyRole('candidate', { ...profileFields(userData, fields!, false, customFields ?? []), ...consent });
            if (isString(r)) { fail(r); return; }
            // The session now carries the candidate role too: read it again.
            const s = await LoginService.getInstance().getSession();
            if (s && !isString(s)) setUser({ ...s.user, jobApplicationsId: s.jobApplicationsId } as any);
            onSuccess();
            return;
        }
        if (mode === 'complete' || mode === 'edit') {
            const r = await UserService.getInstance().updateMe(profileFields(userData, fields!, true, customFields ?? []));
            if (isString(r)) { fail(r); return; }
            const current = useAuthStore.getState().user;
            setUser({ ...(current ?? {}), ...r.user } as any);
            showToast(tp.Saved, 'success');
            onSuccess();
            return;
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
                        {mode === 'edit' && <MarketingConsentToggle className="mx-4 mt-3" />}
                        {!fields || !customFields ? <div className="p-5 text-center" aria-busy="true"><Spinner animation="border" size="sm" /></div> : <UserDetails
                         fields = {fields}
                         customFields = {customFields}
                         initialData = {userData}
                          formikRef = {formikRef}
                           handleSubmit = {handleUserDetailsSubmit}
                           emailReadOnlyHint = {emailHint}
                           cvHint = {hasCv ? tp.CurrentCv : undefined}
                    />}</div>
                ) : (
                    <>
                    <UserSkills
                        initialSelectedSkills={userData.skills}
                        onSkillsChange={handleUserSkillsChange}
                    />
                    {isSignUp && (
                        <ConsentChecks idPrefix="signup" audience="candidate" className="px-4 pb-3" values={consent}
                            termsError={consentError}
                            onChange={(v) => { setConsent(v); if (v.consent) setConsentError(false); }} />
                    )}
                    </>
                )}
            </div>
            {submitError && (
                <div ref={errorRef} tabIndex={-1} role="alert" className="apply-note apply-note-stop mx-4 mb-3" data-testid="register-error">
                    {submitError}
                </div>
            )}
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
