import { Chip } from "@mui/material";
import { safeHtml } from '../../utils/safeHtml';
import { i18n } from "../../i18n/I18n";
import { BagIcon, CheckContainedIcon, ClockIcon, DocIcon, LocationIcon } from "../../icons";
import { Guest, JobData } from "../../models/interfaces/Props.interfaces";
import { formatDateToDisplay, isString, useIsMobile } from "../../utils/utils";
import JobInfo from "./JobInfo";
import { GuestApplyModal } from "../GuestApplyModal";
import { JobService } from "../../services/api/Job.service";
import useAuthStore from "../../store/Auth.store";
import ToastStore from "../../store/Toast.store";
import useModalStore from "../../store/Modal.store";
import Button from "../common/Button";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import Spinner from "../common/Spinner";
import { effectiveApplyPolicy } from "../../utils/applyPolicy";
import { DirectApplyJobCard } from "./directApplyJobCard";
import { ThresholdConditionNote } from "../threshold/ThresholdConditionNote";
import { applyFlow, setApplyContext, startGuestApply, track, trackOnce } from "../../utils/analytics";
import { applyErrorText } from "../../utils/applyError";

interface JobCardDataProps {
    jobData: JobData;
    /** For analytics: opened from the list, the map, or a direct /job/:id link. */
    source?: 'list' | 'map' | 'direct';
}

export interface FormHandle {
    submit: () => Promise<any>;
    hasErrors: () => Promise<boolean>;
    scrollToBottom: () => void;
}

export const ExtendedJobCard = forwardRef<FormHandle, JobCardDataProps>(({ jobData, source = 'list' }, ref) => {

    const translations = i18n.getTranslations();
    const {setUserTryToApply,user,setOpenLogin} = useAuthStore();
    const { initModal } = useModalStore();
    const { showToast } = ToastStore();
    const [isLoading,setIsLoading] = useState(false)
    const isMobile = useIsMobile();
    const bottomRef = useRef<HTMLDivElement | null>(null);
    const innerRef = useRef<FormHandle>(null); // ref for GuestApplyModal
    const applyPolicy = effectiveApplyPolicy(jobData);
    // Ways to apply (utils/applyPolicy.ts). The guest form shows only for guest mode 'quick';
    // on a self-apply job everyone sees the employer's details ("apply directly to the employer").
    const isSelfApply = applyPolicy.guestMode === 'self';
    // A job of the existing site takes no applications here (ApplyJobButtons says so): no guest form either.
    const showGuestForm = !user && applyPolicy.guestMode === 'quick' && !jobData.onExistingSite;
    const cvRequired = applyPolicy.quickCv === 'required';
    const applyType = isSelfApply && !user ? 'self_apply' : user ? 'registered' : 'guest';
    const jobKey = jobData._id?.toString();
    const hasThreshold = !!jobData.thresholdCondition?.trim();
    useEffect(() => {
        if (jobKey) trackOnce(`job_view:${jobKey}`, 'job_view', { job_id: jobKey, source, apply_type: applyType });
        // The job (with the guest form) was closed while an application to it was under way: abandoned there.
        return () => { if (jobKey) applyFlow.abandon('dialog_closed', jobKey, 'quick'); };
    }, [jobKey]);

    const formatDateTranslations = {
        today: translations.Jobs.Today,
        yesterday: translations.JobCard.Yesterday,
        days: translations.JobCard.Days,
    };

      const handleGuestApplyJob = async (data: Guest) => {
        // Funnel: the guest's CV choice is the file they attached (for this job only) or none. Submit, threshold,
        // success and error are recorded by JobService (the same for every way of applying).
        if (jobKey) {
            startGuestApply(jobKey, cvRequired, hasThreshold);
            applyFlow.set({ cv_choice: data.cvFilePath ? 'job_only' : 'none' }, jobKey);
            applyFlow.step('apply_cv_choice', 'cv_choice', {}, jobKey);
        }
        setIsLoading(true)
        const result = await JobService.getInstance().guestApplyJob(jobData,data);
        setIsLoading(false)
        if (isString(result)) {
            if(result === translations.AuthErrorMessages.USER_ALREADY_EXISTS){
                setApplyContext(jobKey)
                track('login_prompt', { job_id: jobKey, source: 'apply' })
                setUserTryToApply(true)
                setOpenLogin(true)
            }else{
                showToast(applyErrorText(result, translations.ApplyCv.ApplyFailed), "error");
            }
            return;
        } else{
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
        }
    };

    const scrollToBottom = () => {
        setTimeout(() => {
            bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }, 100);
    };


    useImperativeHandle(ref, () => ({
        submit: () => innerRef.current?.submit() ?? Promise.resolve(),
        hasErrors: () => innerRef.current?.hasErrors?.() ?? Promise.resolve(false),
        scrollToBottom,
    }));

    return (
        !isLoading? <div>
        {showGuestForm ? (

            <div className="row" >
                <div className="col-md-6 overflow-sm custom-scrollbar responsive-height-3 pt-1 pe-2">
                <h3 className="font-RubikBold fs-5">{translations.JobCard.JobDetails}</h3>
                    <div className="row" >

                        <div className="col-md-12">
                            <JobInfo
                                icon={<LocationIcon />}
                                title={translations.JobCard.Location}
                                info={jobData.locationPreview?jobData.locationPreview : jobData.location?.city || ""}
                            />
                        </div>
                        <div className="col-md-12">
                            <JobInfo
                                icon={<DocIcon />}
                                title={translations.JobCard.JobScope}
                                info={jobData.jobScope
                                    .map((scope: string) => translations.Jobs[scope as keyof typeof translations.Jobs])
                                    .join(", ")}
                            />
                        </div>
                    </div>
                    <div className="row">
                        <div className="col-md-12">
                            <JobInfo
                                icon={<ClockIcon />}
                                title={translations.JobCard.JobPosting}
                                info={formatDateToDisplay(
                                    (jobData.publishDate).toString(),
                                    formatDateTranslations
                                )}
                            />
                        </div>
                        <div className="col-md-12">
                            <JobInfo
                                icon={<BagIcon />}
                                title={translations.JobCard.Company}
                                info={jobData.companyName}
                            />
                        </div>
                    </div>
                    <hr className="w-10 my-4" />
                    <h3 className="font-RubikBold fs-5">{translations.JobCard.JobDescription}</h3>
                    <div className="xxl-min-h-10vh">
                        <span
                            className="font-RubikRegular"
                            dangerouslySetInnerHTML={{ __html: safeHtml(jobData.description) }}
                        />
                    </div>
                    <hr className="w-10 my-4" />
                    <ThresholdConditionNote text={jobData.thresholdCondition} id={`${jobKey}`} />
                    {/* Details content managers added to the job form and chose to show here (settings screen). Plain text. */}
                    {jobData.extraFields && jobData.extraFields.length > 0 && (
                        <dl className="job-extra-fields mb-3" data-testid="job-extra-fields">
                            {jobData.extraFields.map((f, i) => (
                                <div key={i} className="mb-2">
                                    <dt className="font-RubikBold fs-6 d-inline">{f.label}: </dt>
                                    <dd className="font-RubikRegular d-inline m-0" style={{ whiteSpace: 'pre-line' }}>{f.value}</dd>
                                </div>
                            ))}
                        </dl>
                    )}
                    {jobData.requiredSkillsDetails && Object.keys(jobData.requiredSkillsDetails).length > 0 &&
                        <div>
                            <h3 className=" font-RubikBold fs-5">{translations.JobCard.Skills}</h3>
                            {Object.values(jobData.requiredSkillsDetails).map((item, index) => (
                                <Chip
                                    className='m-2 px-2 font-RubikRegular fs-16 text-color-dark-grey-B'
                                    label={(item)} 
                                    key={index}
                                />
                            ))}
                        </div>
                    }
                    <div className="xxl-min-w-80vh">
                        <span
                            className="font-RubikRegular"
                            dangerouslySetInnerHTML={{ __html: safeHtml(jobData.comments) }}
                        />
                    </div>
                      <hr className="w-10 my-4 d-block d-sm-none" />
                     {/*mobile */}
                 {isMobile && <div ref={bottomRef} className="mt-5 mb-3 max-width-33rem d-block d-sm-none">
                        <GuestApplyModal
                            handleGuestApply={async (cvFilePath) => handleGuestApplyJob(cvFilePath)}
                            cvRequired={cvRequired}
                            hasThreshold={hasThreshold}
                            jobId={jobKey}
                            ref={innerRef}
                            />
                    </div>
                }
                </div>
                {/* web*/}
                <div className="col-md-6 order-md-1 d-flex align-items-start justify-content-start d-none d-sm-block px-2">
                    <div className="border-end h-100">
                        <div className="max-width-33rem ">
                           { !isMobile && <GuestApplyModal
                                handleGuestApply={async (cvFilePath) => handleGuestApplyJob(cvFilePath) }
                                cvRequired={cvRequired}
                                hasThreshold={hasThreshold}
                                jobId={jobKey}
                                // innerRef, not the outer ref: this card's own handle (below) owns the outer ref
                                // and forwards submit() to innerRef; passing both left desktop submit a no-op.
                                ref={innerRef}
                                />
                           }
                        </div>
                    </div>
                </div>
            </div>
        ) : (
             <div className="row pt-2 pe-3">
                {!user && applyPolicy.guestMode === 'none' && (
                    <p className="font-RubikMedium text-color-purple">{translations.ApplyPolicy.RegisterToApply}</p>
                )}
                {isSelfApply && (
                    <section className="self-apply-box mb-3" aria-labelledby={`self-apply-${jobKey}`}>
                        <h3 id={`self-apply-${jobKey}`} className="font-RubikBold fs-6 mb-1">
                            <i className="bi bi-box-arrow-up-left me-1 ms-1" aria-hidden="true" />{translations.ApplyPolicy.SelfApplyTitle}
                        </h3>
                        <p className="font-RubikRegular fs-14 mb-2">
                            {translations.ApplyPolicy.SelfApplyIntro}{user ? ` ${translations.ApplyPolicy.SelfApplyRegistered}` : ''}
                        </p>
                        <DirectApplyJobCard jobData={jobData} compact />
                    </section>
                )}
                <h3 className="font-RubikBold fs-5">{translations.JobCard.JobDetails}</h3>
                <div className="col-12">
                    <div className="row">
                        <div className="col-md-4">
                            <JobInfo
                                icon={<LocationIcon />}
                                title={translations.JobCard.Location}
                                info={jobData.locationPreview?jobData.locationPreview : jobData.location?.city || ""}
                            />
                        </div>
                        <div className="col-md-4">
                            <JobInfo
                                icon={<DocIcon />}
                                title={translations.JobCard.JobScope}
                                info={jobData.jobScope
                                    .map((scope: string) => translations.Jobs[scope as keyof typeof translations.Jobs])
                                    .join(", ")}
                            />
                        </div>
                    </div>
                    <div className="row">
                        <div className="col-md-4">
                            <JobInfo
                                icon={<ClockIcon />}
                                title={translations.JobCard.JobPosting}
                                info={formatDateToDisplay(
                                    (jobData.publishDate).toString(),
                                    formatDateTranslations
                                )}
                            />
                        </div>
                        <div className="col-md-4">
                            <JobInfo
                                icon={<BagIcon />}
                                title={translations.JobCard.Company}
                                info={jobData.companyName}
                            />
                        </div>
                    </div>
                    <hr className="w-10 my-4" />
                    <h3 className="font-RubikBold fs-5">{translations.JobCard.JobDescription}</h3>
                    <div className="xxl-min-w-80vh xxl-min-h-10vh">
                        <span
                            className="font-RubikRegular"
                            dangerouslySetInnerHTML={{ __html: safeHtml(jobData.description) }}
                        />
                    </div>
                    <hr className="w-10 my-4" />
                    <ThresholdConditionNote text={jobData.thresholdCondition} id={`${jobKey}`} />
                    {/* Details content managers added to the job form and chose to show here (settings screen). Plain text. */}
                    {jobData.extraFields && jobData.extraFields.length > 0 && (
                        <dl className="job-extra-fields mb-3" data-testid="job-extra-fields">
                            {jobData.extraFields.map((f, i) => (
                                <div key={i} className="mb-2">
                                    <dt className="font-RubikBold fs-6 d-inline">{f.label}: </dt>
                                    <dd className="font-RubikRegular d-inline m-0" style={{ whiteSpace: 'pre-line' }}>{f.value}</dd>
                                </div>
                            ))}
                        </dl>
                    )}
                    {jobData.requiredSkillsDetails && Object.keys(jobData.requiredSkillsDetails).length > 0 &&
                        <div>
                            <h3 className=" font-RubikBold fs-5">{translations.JobCard.Skills}</h3>
                            {Object.values(jobData.requiredSkillsDetails).map((item, index) => (
                                <Chip
                                    className='m-2 px-2 font-RubikRegular fs-16 text-color-dark-grey-B'
                                    label={(item)} 
                                    key={index}
                                />
                            ))}
                        </div>
                    }
                    <div className="xxl-min-w-80vh">
                        <span
                            className="font-RubikRegular"
                            dangerouslySetInnerHTML={{ __html: safeHtml(jobData.comments) }}
                        />
                    </div>
                </div>
            </div>
        )
        
        }
        </div>
        :
        <div className=" mt-3 ms-1 px-4 py-2 text-center">
            <Spinner  size="lg" color="dark" srText="" />
        </div>
    );
});
