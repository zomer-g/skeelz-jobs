import { i18n } from "../../i18n/I18n";
import { CheckContainedIcon } from "../../icons";
import { ApplyJobButtonsProps, Guest } from "../../models/interfaces/Props.interfaces";
import { ApplyJobResponse } from "../../models/interfaces/Api.interfaces";
import useAuthStore from "../../store/Auth.store";
import { isCandidateUser, isEmployerUser } from "../../i18n/General.enums";
import useModalStore from "../../store/Modal.store";
import useToastStore from "../../store/Toast.store";
import Button from "../common/Button";
import { ApplyWithCvDialog } from "./ApplyWithCvDialog";
import { applyFlow, setApplyContext, startGuestApply, track } from "../../utils/analytics";

/*
 * Ways to apply (utils/applyPolicy.ts):
 *  - signed in: always the regular application (CV dialog; the job's regular-apply CV rule applies).
 *    On a self-apply job the employer's details stay one click away.
 *  - not signed in: self -> the employer's details (apply directly), quick -> the guest form, none -> sign in.
 */
export const ApplyJobButtons: React.FC<ApplyJobButtonsProps> = ({jobId, applyPolicy, openDirectApplyModal,handleGuestApply, hasThreshold = false, onExistingSite = false}) => {
    const isSelfApply = applyPolicy.guestMode === 'self';
    const { initModal, storeCurrentModalAsPending } = useModalStore();
    const translations = i18n.getTranslations();
    const { user, setOpenLogin, updateJobApplication, setUser } = useAuthStore();
    const { showToast } = useToastStore();
    const isAlreadyApplied = user?.jobApplicationsId?.some(application => application === jobId);
    // Called by ApplyWithCvDialog once the application was accepted.
    const handleApplied = (result: ApplyJobResponse) => {
        updateJobApplication(result.jobApplicationId);
        if (result.profileCvFileUrl) {
            const current = useAuthStore.getState().user;
            if (current) setUser({ ...current, cvFileUrl: result.profileCvFileUrl });
            showToast(translations.ApplyCv.ProfileCvUpdated, 'success');
        }
        // If user is logged in, show the job application success modal
        initModal({
            active: true,
            modalBody: (
                <div className='d-flex justify-content-center flex-column align-items-center text-center'>
                    <div className="my-2 d-flex justify-content-center align-items-center rounded-circle size-3-375rem background-color-green-mint border-color-green-sage border-width-0-5-rem border">
                        <CheckContainedIcon />
                    </div>
                    <h1 className='font-RubikBold py-3 m-0 fs-5'>{translations.JobApplicationModal.Title}</h1>
                    <p className='font-RubikRegular text-color-dark-grey text- mb-4'>{translations.JobApplicationModal.ApplicationReceived}</p>
                    <Button
                        className='font-RubikMedium my-2 bg-color-dark-green-2 w-100 mb-4'
                        onClick={() => initModal({ active: false })}
                    >
                        {translations.JobApplicationModal.CloseButton}
                    </Button>
                </div>
            ),
            modalStyle: {
                bodyClass: "height-16-375rem d-flex flex-column justify-content-center align-items-center",
                dialogClassName: "max-width-25rem"
            }
        });
    };

    const handleApplyJobClicked = async () => {
        track('apply_click', { job_id: jobId, apply_type: user ? 'registered' : 'guest' });
        if (!user) {
            setApplyContext(jobId);
            track('login_prompt', { job_id: jobId, source: 'apply' });
            // Store the current modal as pending
            storeCurrentModalAsPending();
            // If user is not logged in, open the login modal
            setOpenLogin(true);
            return;
        }
        // An account without the candidate role (an employer only) can't apply (server: the candidate routes refuse it);
        // say so instead. Someone who is a candidate too applies as that candidate (several roles per account).
        if (!isCandidateUser(user) && isEmployerUser(user)) {
            showToast(translations.Employers.CannotApply, 'warning');
            return;
        }
        // Signed in: choose the CV for this application, then apply. The apply funnel starts here.
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
                                // self: the employer's details (apply directly); quick: the guest form; none: log in / register first.
                                onClick={() => {
                                    if (isSelfApply) {
                                        track('apply_click', { job_id: jobId, apply_type: 'self_apply' });
                                        openDirectApplyModal();
                                    } else if (applyPolicy.guestMode !== 'quick') {
                                        track('apply_click', { job_id: jobId, apply_type: 'guest' });
                                        setApplyContext(jobId);
                                        track('login_prompt', { job_id: jobId, source: 'apply' });
                                        setOpenLogin(true);
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