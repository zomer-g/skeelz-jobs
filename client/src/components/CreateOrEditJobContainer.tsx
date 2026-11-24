import React, { useRef, useState } from 'react';
import JobDetails from './JobDetails';
import Button from './common/Button';
import { JobData } from '../models/interfaces/Props.interfaces';
import { JobService } from '../services/api/Job.service';
import useToastStore from '../store/Toast.store';
import { isString } from '../utils/utils';
import { i18n } from '../i18n/I18n';
import { ExtendedJobCard } from './jobcard/ExtendedJobCard';
import { Spinner } from 'react-bootstrap';
import { track } from '../utils/analytics';

// Define constants for step names
const DETAILS = 'details';
const PREVIEW = 'preview';

interface CreateOrEditJobContainerProps {
    initialJobData?: JobData; // Optional initial data for editing an existing job
    onJobUploaded?: () => void; // Callback after job is uploaded/edited
}

const CreateOrEditJobContainer: React.FC<CreateOrEditJobContainerProps> = ({
    initialJobData,
    onJobUploaded,
}) => {
    const [currentStep, setCurrentStep] = useState<string>(DETAILS); // Use the constant
    const [jobData, setJobData] = useState<JobData | undefined>(initialJobData);
    const [blockButton,setBlockButton] = useState(false)
    const { showToast } = useToastStore();
    const translations = i18n.getTranslations();
    const formSubmitTriggerRef = useRef<() => void>(() => { });
    const handleSaveDetails = (data: JobData) => {
        setJobData(data);
        setCurrentStep(PREVIEW);
    };

    const handleBackToDetails = () => {
        setCurrentStep(DETAILS);
    };

    const addNewJob = async (jobValues: JobData) => {
        const response = await JobService.getInstance().addNewJob(jobValues);
        if (isString(response)) {
            showToast(response, "error")
            setBlockButton(false)
        } else {
            // Analytics: the job's id only (jobs-management screen, staff).
            const id = (response as { id?: unknown }).id;
            if (typeof id === 'string') track('job_publish', { job_id: id });
            showToast(translations.Jobs.NewJobUploadedToast, "success");
        }
    };

    const editJob = async (jobValues: JobData) => {    
        const response = await JobService.getInstance().editJob(jobValues._id!, jobValues);
        if (isString(response)) {
            showToast(response, "error")
        } else {
            showToast(translations.Jobs.EditJobToast, "success")
        }
    };

    const handleUploadOrEditJob = async () => {
        setBlockButton(true)
        if (!jobData) return;
        // applyPolicy is computed by the server (read-only); only the overrides are sent.
        // isSelfApply is computed by the server from the guest mode; the form sends guestModeOverride.
        const { location, dateToDisplay, locationPreview, applyPolicy, isSelfApply, extraFields, ...jobDataToSend } = jobData;
        if (jobData._id) {
            await editJob(jobDataToSend as JobData);
        } else {
            await addNewJob(jobDataToSend as JobData);
        }
        if (onJobUploaded) {
            onJobUploaded();
        }
    };

    const handleFormSubmit = () => {
        if (formSubmitTriggerRef.current) {
            formSubmitTriggerRef.current(); // Trigger Formik's form submission
        }
    };

    return (
        <div>
            {currentStep === DETAILS && (
                <>
                    <div className='p-4 height-40-56rem overflow-auto custom-scrollbar'>
                        <JobDetails
                            job={jobData}
                            onSave={handleSaveDetails}
                            setReferenceToSubmitTrigger={(submitForm) => {
                                formSubmitTriggerRef.current = submitForm;
                            }}
                        />
                    </div>
                    <div className={`text-start bg-light w-100 border-top border-dark border-radius-b-40 py-2 px-3 height-5-625rem d-flex justify-content-end align-items-center`} >

                        <Button
                            onClick={handleFormSubmit}
                            className='bg-color-purple ms-3 ps-4 pe-4 pt-2 pb-2 fs-6 rounded-pill text-center'                        >
                            {jobData?._id ? 'שמור שינויים' : 'העלה משרה'}
                        </Button>

                    </div>
                </>
            )}

            {currentStep === PREVIEW && jobData && (
                <>
                    <div className='p-4 height-40-56rem overflow-auto custom-scrollbar'>
                        <ExtendedJobCard jobData={jobData} />
                    </div>
                    <div className={`text-start bg-light position-sticky bottom-0 w-100 border-top border-dark border-radius-b-40 py-2 px-3 height-5-625rem d-flex justify-content-between align-items-center`} >
                        <Button
                            className='font-RubikMedium bg-white ms-1 px-5 fs-6 text-color-dark-green-2 border-color-dark-green-2 rounded-pill text-center'
                            onClick={handleBackToDetails}
                        >
                            {translations.Jobs.back}
                        </Button>
                        <Button
                            onClick={!blockButton ? handleUploadOrEditJob : undefined}
                            disabled={blockButton}
                            className="bg-color-purple ms-3 ps-4 pe-4 fs-6 rounded-pill text-center"
                        >
                            {blockButton ? (
                                <Spinner animation="border" size="sm" />
                            ) : (
                                jobData?._id ? "שמור שינויים" : "העלה משרה"
                            )}
                        </Button>
                    </div>
                </>
            )}
        </div>
    );
};

export default CreateOrEditJobContainer;
