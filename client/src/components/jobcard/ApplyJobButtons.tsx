import { useEffect, useRef } from "react";
import { i18n } from "../../i18n/I18n";
import { CheckContainedIcon } from "../../icons";
import { ApplyJobButtonsProps } from "../../models/interfaces/Props.interfaces";
import { ApplyJobResponse } from "../../models/interfaces/Api.interfaces";
import useAuthStore from "../../store/Auth.store";
import { isCandidateUser } from "../../i18n/General.enums";
import useModalStore from "../../store/Modal.store";
import Button from "../common/Button";
import { ApplyWithCvDialog } from "./ApplyWithCvDialog";
import { BlockedCandidateNote, CandidateStep, isCandidateBlocked } from "./CandidateStep";
import { applyFlow, setApplyContext, startGuestApply, track } from "../../utils/analytics";
import { onApplyIntentReady, registerApplyButtons, saveApplyIntent, takeReadyIntent } from "../../utils/applyIntent";

/*
 * Ways to apply (utils/applyPolicy.ts):
 *  - signed in: always the regular application (CV dialog; the job's regular-apply CV rule applies).
 *    On a self-apply job the employer's details stay one click away.
 *    Every signed-in person is a candidate (owner, 24.11.2026): an account without the candidate role (an employer
 *    only, a staff member) gets the candidate details step here in the dialog (CandidateStep) and goes on applying;
 *    a candidate role an admin blocked gets a clear note here (BlockedCandidateNote). No toasts.
 *  - not signed in: self -> the employer's details (apply directly), quick -> the guest form, none -> the sign-in
 *    window; after signing in (any way, a new person's sign-up form included) the person comes straight back to
 *    this job's apply step (utils/applyIntent.ts).
 */
export const ApplyJobButtons: React.FC<ApplyJobButtonsProps> = ({jobId, applyPolicy, openDirectApplyModal,handleGuestApply, hasThreshold = false, onExistingSite = false}) => {
    const isSelfApply = applyPolicy.guestMode === 'self';
    const { initModal, storeCurrentModalAsPending } = useModalStore();
    const translations = i18n.getTranslations();
    const { user, setOpenLogin, updateJobApplication, setUser } = useAuthStore();
    const isAlreadyApplied = user?.jobApplicationsId?.some(application => application === jobId);
    // Called by ApplyWithCvDialog once the application was accepted.
    const handleApplied = (result: ApplyJobResponse) => {
        updateJobApplication(result.jobApplicationId);
        const cvUpdated = !!result.profileCvFileUrl;
        if (result.profileCvFileUrl) {
            const current = useAuthStore.getState().user;
            if (current) setUser({ ...current, cvFileUrl: result.profileCvFileUrl });
        }
        initModal({
            active: true,
            modalBody: (
                <div className='d-flex justify-content-center flex-column align-items-center text-center' role="status" data-testid="apply-success">
                    <div className="my-2 d-flex justify-content-center align-items-center rounded-circle size-3-375rem background-color-green-mint border-color-green-sage border-width-0-5-rem border">
                        <CheckContainedIcon />
                    </div>
                    <h1 className='font-RubikBold py-3 m-0 fs-5'>{translations.JobApplicationModal.Title}</h1>
                    <p className='font-RubikRegular text-color-dark-grey mb-2'>{translations.JobApplicationModal.ApplicationReceived}</p>
                    {/* Was a toast: said here, with the confirmation. */}
                    {cvUpdated && <p className='font-RubikRegular text-color-dark-grey mb-2'>{translations.ApplyCv.ProfileCvUpdated}</p>}
                    <Button
                        className='font-RubikMedium my-2 bg-color-dark-green-2 w-100 mb-4'
                        onClick={() => initModal({ active: false })}
                    >
                        {translations.JobApplicationModal.CloseButton}
                    </Button>
                </div>
            ),
            modalStyle: {
                bodyClass: "py-4 d-flex flex-column justify-content-center align-items-center",
                dialogClassName: "max-width-25rem"
            }
        });
    };

    // Not signed in, and this job takes applications through an account only: the sign-in window. The job modal is
    // kept aside (it comes back after an in-window sign-in) and the job is remembered for the redirect sign-ins.
    const signInToApply = () => {
        track('apply_click', { job_id: jobId, apply_type: 'guest' });
        setApplyContext(jobId);
        saveApplyIntent(jobId);
        track('login_prompt', { job_id: jobId, source: 'apply' });
        storeCurrentModalAsPending();
        setOpenLogin(true);
    };

    // The CV dialog: the regular application. The apply funnel starts here.
    const openCvDialog = () => {
        applyFlow.start({ job_id: jobId, apply_type: 'registered', apply_mode: 'regular', cv_required: applyPolicy.regularCv === 'required', has_threshold: hasThreshold });
        initModal({
            active: true,
            modalBody: (
                <ApplyWithCvDialog
                    jobId={jobId}
                    cvRequired={applyPolicy.regularCv === 'required'}
                    onApplied={handleApplied}
                    onCancel={() => initModal({ active: false })}
                />
            ),
            modalStyle: {
                bodyClass: "d-flex flex-column justify-content-center align-items-center",
                dialogClassName: "max-width-31rem"
            }
        });
    };

    const handleApplyJobClicked = () => {
        const who = useAuthStore.getState().user;
        if (!who) { signInToApply(); return; }
        if (isCandidateUser(who)) { openCvDialog(); return; }
        // Not a candidate (yet): blocked by an admin → say so here; otherwise the candidate step, then the CV dialog.
        if (isCandidateBlocked(who)) {
            initModal({
                active: true,
                modalTitle: translations.ApplyFlow.ModalTitle,
                modalBody: <BlockedCandidateNote onClose={() => initModal({ active: false })} />,
                modalStyle: { dialogClassName: "max-width-31rem", titleClass: 'font-RubikBold fs-1-125rem' },
            });
            return;
        }
        initModal({
            active: true,
            modalTitle: translations.ApplyFlow.ModalTitle,
            modalBody: <CandidateStep user={who} onJoined={openCvDialog} />,
            modalStyle: { dialogClassName: 'max-width-72-06rem', bodyClass: 'p-0', titleClass: 'font-RubikBold fs-1-125rem' },
        });
    };

    // Back from signing in to apply (utils/applyIntent.ts): go on with the application once, without a second press.
    const startRef = useRef(handleApplyJobClicked);
    startRef.current = handleApplyJobClicked;
    useEffect(() => {
        if (!jobId || onExistingSite) return;
        const unregister = registerApplyButtons(jobId);
        const tryResume = () => {
            if (useAuthStore.getState().user && takeReadyIntent(jobId)) startRef.current();
        };
        tryResume();
        const off = onApplyIntentReady(tryResume);
        return () => { unregister(); off(); };
    }, [jobId, onExistingSite]);

    // A job of the existing site: shown here, but applications to it are not taken here (owner, 23.11.2026).
    if (onExistingSite) {
        return (
            <div className='d-flex justify-content-start align-items-center gap-3 flex-wrap'>
                <p className='m-0 font-RubikRegular' role='status'>{translations.Profile.ExistingSiteJob}</p>
                {isSelfApply && (
                    <Button className="ps-3 pe-3 bg-color-white text-color-purple" onClick={() => openDirectApplyModal()}>
                        {translations.ApplyPolicy.EmployerDetails}
                    </Button>
                )}
            </div>
        );
    }

    return (

        <div className='d-flex justify-content-start align-items-center'>
            {
                user ? (
                    <>
                        {isSelfApply ? (
                            <Button
                                className="ps-3 pe-3 bg-color-white text-color-purple"
                                onClick={() => {
                                    track('apply_click', { job_id: jobId, apply_type: 'self_apply' });
                                    openDirectApplyModal();
                                }}
                            >
                                {translations.ApplyPolicy.EmployerDetails}
                            </Button>
                        ) : (
                            <Button
                                className="d-none d-sm-inline-block ps-5 bg-color-white text-color-purple"
                                onClick={() => initModal({ active: false })}
                            >
                                { translations.JobCard.Close }
                            </Button>
                        )}
                        <Button
                            className="bg-color-purple-btn ms-3 ps-4 pe-4 pt-2 pb-2 fs-6 custom-button-width"
                            onClick={handleApplyJobClicked}
                            disabled={isAlreadyApplied}
                            data-testid="apply-button"
                        >
                            {isAlreadyApplied ? translations.JobCard.ApplicationSubmitted : translations.JobCard.ApplyJob}
                        </Button>
                    </>
                ) :
                    (
                        <>
                            <Button
                                className="d-none d-sm-inline-block ps-5 bg-color-white text-color-purple"
                                onClick={() =>{
                                    initModal({ active: false })
                                    setOpenLogin(true);
                                }}
                            >
                                {translations.Login.Login}
                            </Button>
                            <Button
                                className="bg-color-purple-btn ms-3 ps-4 pe-4 pt-2 pb-2 fs-6 custom-button-width"
                                data-testid="apply-button"
                                // self: the employer's details (apply directly); quick: the guest form; none: log in / register first.
                                onClick={() => {
                                    if (isSelfApply) {
                                        track('apply_click', { job_id: jobId, apply_type: 'self_apply' });
                                        openDirectApplyModal();
                                    } else if (applyPolicy.guestMode !== 'quick') {
                                        signInToApply();
                                    } else {
                                        track('apply_click', { job_id: jobId, apply_type: 'guest' });
                                        startGuestApply(jobId, applyPolicy.quickCv === 'required', hasThreshold);
                                        handleGuestApply();
                                    }
                                }}
                            >
                                {translations.JobCard.ApplyJob}
                            </Button>
                        </>

                    )
            }
        </div>
    );
};