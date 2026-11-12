import JobInfo from './JobInfo';
import { JobData } from '../../models/interfaces/Props.interfaces';
import useModalStore from '../../store/Modal.store';
import { useEffect, useRef } from 'react';
import { i18n } from '../../i18n/I18n'
import { BagIcon, ClockIcon, CrownIcon, LocationIcon } from '../../icons';
import Button from '../common/Button';
import useAuthStore from '../../store/Auth.store';
import { formatDateToDisplay, isString } from '../../utils/utils';
import { ExtendedJobCard, FormHandle } from './ExtendedJobCard';
import { ApplyJobButtons } from './ApplyJobButtons';
import Tooltip from '../common/Tooltip';
import { DirectApplyJobCard } from './directApplyJobCard';
import { JobService } from '../../services/api/Job.service';
import { effectiveApplyPolicy } from '../../utils/applyPolicy';
import { errorCode, track } from '../../utils/analytics';

interface JobCard {
  index: number;
  version: number;
  jobData: JobData;
  openJob: boolean;
}

function JobCard({index, version, jobData, openJob }: JobCard) {
  const { initModal } = useModalStore();
  const { user, setOpenLogin, updateJobApplication } = useAuthStore();
  const translations = i18n.getTranslations();
  const isAlreadyApplied = user?.jobApplicationsId?.some(application => application === jobData._id);
  const formRef = useRef<FormHandle>(null);

  const GuestApply = async () => {
    if (formRef.current) {
      await formRef.current.submit();
      const hasErrors = await formRef.current.hasErrors?.();
      if (hasErrors) {
        formRef.current.scrollToBottom();
      }
    }
  };

  const cardColorVersion =
    version === 1
      ? 'bg-color-dark-green text-light text-bold-white-1'
      : 'bg-color-light-green text-dark text-bold-black-2';

  const openJobDetailsModal = (source: 'list' | 'direct' = 'list') => {
    const currentSearch = window.location.search;
    const newUrl = '/job/' + jobData._id!.toString() + currentSearch;
    window.history.replaceState({}, '', newUrl);
    initModal({
      onClose: () => {
        window.history.replaceState({}, '', `/${currentSearch}`);
      },
      active: true,
      modalTitle: jobData.title,
      modalBody:
        <div>
          <div className='px-md-4 pt-md-4 responsive-height-2 overflow-auto custom-scrollbar'>
            <ExtendedJobCard jobData={jobData} ref={formRef} source={source} />
          </div>
          <div className={`text-start bg-light w-100 custom-border-top border-dark border-xs-0 py-2 px-3 height-5-625rem d-flex justify-content-center justify-content-sm-end align-items-center xs-top-shadow`} >
            <ApplyJobButtons handleGuestApply={GuestApply} openDirectApplyModal={openDirectApplyModal} isSelfApply={jobData.isSelfApply} quickApply={effectiveApplyPolicy(jobData).quickApply} jobId={jobData._id!}/>
          </div>
        </div>,
      modalStyle: {
        modalClass: 'modal-slide-up',
        dialogClassName: ' modal-fullscreen-sm-down max-width-72-125rem xs-p-0',
        headerClass: version === 2 ? 'bg-color-light-green' : 'bg-color-dark-green',
        titleClass: `font-EzerRegularLoft ${version === 2 ? '' : 'text-white'}`,
        bodyClass: 'p-0',
        closeButtonColor: `${version === 2 ? '' : 'white'}`
      }
    })
  }

  const applyJob = async () => {
    if(jobData?._id){
      const ev = { job_id: jobData._id.toString(), apply_type: 'self_apply', cv_choice: 'none' } as const;
      track('apply_submit', ev);
      const result = await JobService.getInstance().applyJob(jobData._id);
      if (isString(result)) {
          track('apply_error', { job_id: ev.job_id, apply_type: 'self_apply', error_code: errorCode(result) });
          return;
      } else {

          track('apply_success', ev);
          updateJobApplication(result.jobApplicationId);
      }

    }
  }

  const openDirectApplyModal = () => {
     if (!user) {
            setOpenLogin(true);
            return;
        }
    const newUrl = '/job/' + jobData._id!.toString();
    window.history.replaceState({}, '', newUrl);
    initModal({
      onClose: () => {
        window.history.replaceState({}, '', '/');
      },
      active: true,
      modalTitle: translations.JobCard.ApplyForJob,
      modalBody:
        <div>
          <div className='p-4 height-28rem xs-h-30rem overflow-auto custom-scrollbar'>
            <DirectApplyJobCard jobData={jobData} />
          </div>
          <div className="d-flex justify-content-center">
          <Button
              className='font-RubikMedium my-2 bg-color-purple-btn width-40p mb-4 mx-3'
              onClick={() => {
                applyJob()
                initModal({ active: false })
              }}
              disabled={isAlreadyApplied}
            >
              {translations.JobApplicationModal.ThankYouWillSubmitMyself }
            </Button>
            <Button
              className="font-RubikMedium my-2 bg-color-white text-color-purple width-40p mb-4 mx-3"
              onClick={() => initModal({ active: false })}
            >
              {isAlreadyApplied ? translations.JobApplicationModal.CloseButton : translations.JobApplicationModal.NextTime }
            </Button>
          </div>
        </div>,
      modalStyle: {
        modalClass: 'modal-slide-up',
        dialogClassName: 'width-37-5rem modal-fullscreen-sm-down max-width-72-125rem mw-sm-100 xs-p-0',
        headerClass: '',
        titleClass: `font-RubikBold fs-5`,
        bodyClass: 'p-0',
        closeButtonColor: '#7C7B7B',
      }
    })
  }

  useEffect(() => {
    if (openJob) {
      const loadData = async () => {
        openJobDetailsModal('direct');
      }
      loadData();
    }
  }, []);

  const CardData: React.FC = () => {
    const { user } = useAuthStore();
    const isAlreadyApplied = user?.jobApplicationsId?.some(
      (applicationId) => applicationId === jobData._id
    );

    const formatDateTranslations = {
      today: translations.Jobs.Today,
      yesterday: translations.JobCard.Yesterday,
      days: translations.JobCard.Days
    }

    return (
      <>
        <div>
          <div className="row">
            <div className="col-12">
              <div className={`font-EzerRegularLoft ${jobData.jobScope.join(",") === translations.Jobs.FullTime ? 'text-color-purple' : 'text-color-dark-green'}`}>
                <div className="d-flex justify-content-between align-items-center w-100 height-1-75rem">
                  <span className="fw-normal fs-1rem md-fs-1-125rem text-truncate">
                    {jobData.jobScope
                      .map((scope: string) => translations.Jobs[scope as keyof typeof translations.Jobs])
                      .join(', ')}
                  </span>
                  {jobData.isMarked && index < 2 && (
                    <Tooltip text={translations.Jobs.HotPosition}>
                      <CrownIcon />
                    </Tooltip>
                  )}

                </div>
              </div>
            </div>

            <div className="col-12">
              <JobInfo icon={<BagIcon />} title={translations.JobCard.Company} info={jobData.companyName} />
            </div>
          </div>
        </div>
        <div className="row">
          <div className="col-lg-6 col-md-12 col-xl-6">

            <div className='mb-1'>
              <JobInfo icon={<ClockIcon />} title={translations.JobCard.JobPosting} info={formatDateToDisplay((jobData.publishDate).toString(), formatDateTranslations)} />
              <JobInfo icon={<LocationIcon />} title={translations.JobCard.Location} info={jobData.location?.city || ''} />
            </div>
          </div>

          <div className="col-12 col-lg-6 col-md-12 d-flex align-items-end justify-content-end">
            <Button
              customStyle
              className="font-RubikMedium text-nowrap w-100  rounded-pill border-0 text-white fw-500 bg-color-purple-btn md-h-2-75rem h-2-5rem d-flex align-items-center justify-content-center"
              onClick={() => openJobDetailsModal()}
            >
              {isAlreadyApplied ? translations.JobCard.ApplicationSubmitted : translations.JobCard.DetailsAndApplication}
            </Button>
          </div>
        </div>
      </>
    );
  };




  return (
    <div>
      {/* Desktop view (5 columns) */}
      <div className="my-4 d-none d-lg-flex justify-content-center card-height lg-card-height h-lg-auto">
        <div className={`${cardColorVersion} fs-6 lg-max-width-23-25rem font-EzerRegularLoft pt-4 ps-5 pe-4 d-flex col-md-5 col-xl-5 rounded-start-0 border-radius-20 align-items-start justify-content-start`}>
          <h4 className=" fs-2-25rem font-EzerRegularLoft">{jobData.title}</h4>
        </div>

        <div className="max-width-37-5rem col-md-6 col-xl-7 bg-color-light-grey p-4 rounded-end-0 border-radius-20 border border-2">
          <CardData />
        </div>
      </div>

      {/* Mobile view (full width) */}
      <div className='my-3 d-block d-lg-none'>
        <div className={`${cardColorVersion} fs-6 lg-max-width-23-25rem height-4-312rem rounded-bottom-0 border-radius-20 text-center d-flex align-items-center justify-content-start`}>
          <h4 className=" m-0 font-responsive-2 font-EzerRegularLoft pe-3">{jobData.title}</h4>
        </div>

        <div className="bg-color-light-grey p-3 rounded-top-0  border-radius-20 border border-2">
          <CardData />
        </div>
      </div>
    </div>
  );
}

export default JobCard;
