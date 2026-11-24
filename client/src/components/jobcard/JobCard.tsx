import JobInfo from './JobInfo';
import { JobData } from '../../models/interfaces/Props.interfaces';
import useModalStore from '../../store/Modal.store';
import { useEffect, useRef } from 'react';
import { i18n } from '../../i18n/I18n'
import { BagIcon, ClockIcon, LocationIcon } from '../../icons';
import Button from '../common/Button';
import useAuthStore from '../../store/Auth.store';
import { formatDateToDisplay, isString } from '../../utils/utils';
import { ExtendedJobCard, FormHandle } from './ExtendedJobCard';
import { ApplyJobButtons } from './ApplyJobButtons';

import { DirectApplyJobCard } from './directApplyJobCard';
import { JobService } from '../../services/api/Job.service';
import { effectiveApplyPolicy } from '../../utils/applyPolicy';
import { applyFlow } from '../../utils/analytics';
import { applyErrorText } from '../../utils/applyError';
import useToastStore from '../../store/Toast.store';

interface JobCard {
  index: number;
  version: number;
  jobData: JobData;
  openJob: boolean;
}

function JobCard({ version, jobData, openJob }: JobCard) {
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
            <ApplyJobButtons handleGuestApply={GuestApply} openDirectApplyModal={openDirectApplyModal} applyPolicy={effectiveApplyPolicy(jobData)} jobId={jobData._id!} hasThreshold={!!jobData.thresholdCondition?.trim()} onExistingSite={!!jobData.onExistingSite}/>
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
      // Funnel: "I'll apply to the employer myself" — no CV goes through us. Threshold, submit, success and
      // error are recorded by JobService.applyJob.
      const jobId = jobData._id.toString();
      applyFlow.start({ job_id: jobId, apply_type: 'self_apply', apply_mode: 'self', cv_required: false, has_threshold: !!jobData.thresholdCondition?.trim() });
      applyFlow.set({ cv_choice: 'none' }, jobId);
      applyFlow.step('apply_cv_choice', 'cv_choice', {}, jobId);
      const result = await JobService.getInstance().applyJob(jobData._id);
      if (isString(result)) {
          // The reason (already applied, existing site's job, limits, consent not given…); "try again" only when unknown.
          useToastStore.getState().showToast(applyErrorText(result, translations.ApplyCv.ApplyFailed), 'error');
          return;
      } else {
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

  // A real link to the job page (search engines find jobs through it; a middle-click opens it in a new tab).
  // A plain click opens the job window as before.
  const TitleLink: React.FC = () => (
    <a
      href={`/job/${jobData._id}`}
      className="text-reset text-decoration-none"
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        openJobDetailsModal();
      }}
    >
      {jobData.title}
    </a>
  );

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
                  {/* Pinned by the editors (נעוצה): stays at the start of the board until unpinned. */}
                  {jobData.pinnedAt && (
                    <span className="job-card-pin" title={translations.Jobs.PinnedJob}>
                      <i className="bi bi-pin-angle-fill" aria-hidden="true" />
                      <span aria-hidden="true">{translations.Jobs.Pinned}</span>
                      <span className="visually-hidden">{translations.Jobs.PinnedJob}</span>
                    </span>
                  )}
                  {/* The crown (hot / sponsored) is gone: the owner removed it; sponsored is a checkbox in jobs management. */}

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
          <h4 className=" fs-2-25rem font-EzerRegularLoft"><TitleLink /></h4>
        </div>

        <div className="max-width-37-5rem col-md-6 col-xl-7 bg-color-light-grey p-4 rounded-end-0 border-radius-20 border border-2">
          <CardData />
        </div>
      </div>

      {/* Mobile view (full width) */}
      <div className='my-3 d-block d-lg-none'>
        <div className={`${cardColorVersion} fs-6 lg-max-width-23-25rem height-4-312rem rounded-bottom-0 border-radius-20 text-center d-flex align-items-center justify-content-start`}>
          <h4 className=" m-0 font-responsive-2 font-EzerRegularLoft pe-3"><TitleLink /></h4>
        </div>

        <div className="bg-color-light-grey p-3 rounded-top-0  border-radius-20 border border-2">
          <CardData />
        </div>
      </div>
    </div>
  );
}

export default JobCard;
