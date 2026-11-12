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
import { errorCode, setApplyContext, track, trackOnce } from "../../utils/analytics";

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
    // The guest form shows only when the admin policy allows applying without registering.
    const showGuestForm = !jobData.isSelfApply && !user && applyPolicy.quickApply;
    const cvRequired = !applyPolicy.quickApplyWithoutCv;
    const applyType = jobData.isSelfApply ? 'self_apply' : user ? 'registered' : 'guest';
    const jobKey = jobData._id?.toString();
    useEffect(() => {
        if (jobKey) trackOnce(`job_view:${jobKey}`, 'job_view', { job_id: jobKey, source, apply_type: applyType });
    }, [jobKey]);

    const formatDateTranslations = {
        today: translations.Jobs.Today,
        yesterday: translations.JobCard.Yesterday,
        days: translations.JobCard.Days,
    };

      const handleGuestApplyJob = async (data: Guest) => {
        const ga = { job_id: jobKey, apply_type: 'guest', cv_choice: data.cvFilePath ? 'job_only' : 'none' } as const;
        track('apply_submit', ga);
        setIsLoading(true)
        const result = await JobService.getInstance().guestApplyJob(jobData,data);
        setIsLoading(false)
        if (isString(result)) {
            track('apply_error', { job_id: jobKey, apply_type: 'guest', error_code: errorCode(result) });
            if(result === translations.AuthErrorMessages.USER_ALREADY_EXISTS){
                setApplyContext(jobKey)
                track('login_prompt', { job_id: jobKey, source: 'apply' })
                setUserTryToApply(true)
                setOpenLogin(true)
            }else{
                showToast(result, "error");            
            }
            return;
        } else{
            track('apply_success', ga);
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
                {!user && !jobData.isSelfApply && !applyPolicy.quickApply && (
                    <p className="font-RubikMedium text-color-purple">{translations.ApplyPolicy.RegisterToApply}</p>
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
