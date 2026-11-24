import React, { useEffect, useState } from 'react';
import { useFormik } from 'formik';
import * as Yup from 'yup';
import { JobStatus, OptionType } from '../models/interfaces/General.interfaces';
import useLanguageStore from '../store/Language.store';
import { getLocalizedOptions } from '../i18n/i18nHelper';
import { DayValues, LocalizedDataKey, MessageColors } from '../i18n/General.enums';
import { JobData } from '../models/interfaces/Props.interfaces';
import { LocationService } from '../services/api/Location.service';
import { isString } from '../utils/utils';
import useToastStore from '../store/Toast.store';
import TextInput from './common/TextInput';
import Select from './common/Select';
import RichTextEditor from './common/RichTextEditor';
import TextArea from './common/TextArea';
import { i18n } from '../i18n/I18n';
import SelectAutocomplete from './common/SelectAutocomplete';
import { SkillsService } from '../services/api/Skills.service';
import useAuthStore from '../store/Auth.store';
import { canManageContent } from '../i18n/General.enums';
import Checkbox from './common/Checkbox';
import JobFlags from './jobsAdmin/JobFlags';
import SettingsService from '../services/api/Settings.service';
import { ApplyPolicy } from '../models/interfaces/Props.interfaces';
import { fromDateInput, isFutureDate, maxScheduleInput, toDateInput } from '../utils/jobBoard';
import CustomFieldInputs from './common/CustomFieldInputs';
import { customErrors, FormField, loadJobCustomFields, valuesToSend } from '../utils/customFields';

interface JobDetailsProps {
  job?: JobData; // Optional job prop for editing
  onSave: (job: JobData) => void; // Callback function to save the job
  setReferenceToSubmitTrigger: (submitForm: () => void) => void;
}

const defaultJob: JobData = {
  title: '',
  companyName: '',
  citySymbol: 0,
  jobScope: [],
  requiredSkills: [],
  description: '',
  contactPersonName: '',
  contactPersonPhone: '',
  contactPersonEmail: '',
  comments: '',
  location: { citySymbol: 0, city: '' },
  status:'',
  publishDate:  new Date(),
  isSponsored: false,
  isMarked: false,
  isSelfApply: false,
  externalLink:'',
  thresholdCondition: '',
  // A new job follows the site-wide "הגדרות הגשה" until a content manager picks a value here.
  guestModeOverride: null,
  quickCvOverride: null,
  regularCvOverride: null,
};

const JobDetails: React.FC<JobDetailsProps> = ({ job = defaultJob, onSave, setReferenceToSubmitTrigger }) => {
  const [skillsOptions, setSkillsOptions] = useState<OptionType[]>([]);
  const [jobScopeOptions, setJobScopeOptions] = useState<OptionType[]>([]);
  const [locations, setLocations] = useState<Record<number, string>>({});
  const [choosenlable,setChoosenlable] = useState('')
  const { currentLanguage } = useLanguageStore.getState();
  const translations = i18n.getTranslations();
  const { showToast } = useToastStore();
  const { user } = useAuthStore();
  // A placement coordinator edits a job but not its threshold condition or apply settings (server: roleFields.ts).
  const coordinator = !canManageContent(user?.role);
  const [applyDefaults, setApplyDefaults] = useState<ApplyPolicy | undefined>();
  // The job form's added fields (settings screen); coordinators fill them too.
  const [jobFields, setJobFields] = useState<FormField[]>([]);

  const JobSchema = Yup.object().shape({
    title: Yup.string()
      .required(translations.Inputs.Required)
      .max(30, translations.Inputs.MaxLengthExceeded),

    companyName: Yup.string()
      .required(translations.Inputs.Required)
      .max(28, translations.Inputs.MaxLengthExceeded),

    citySymbol: Yup.string().required(translations.Inputs.Required),

    jobScope: Yup.array()
      .min(1, translations.Inputs.Required)
      .required(translations.Inputs.Required),

    requiredSkills: Yup.array()
      .min(1, translations.Inputs.Required)
      .required(translations.Inputs.Required),

    description: Yup.string().required(translations.Inputs.Required),

    contactPersonName: Yup.string()
      .matches(/^[^0-9]*$/, translations.Inputs.NameLettersOnly)
      .max(70, translations.Inputs.MaxLengthExceeded),

    contactPersonPhone: Yup.string()
      .matches(/^\d+$/, translations.Inputs.NumbersOnly)
      .max(20, translations.Inputs.PhoneMaxLength)
      .nullable(),

    contactPersonEmail: Yup.string()
      .email(translations.Inputs.InvalidEmailAddress)
      .matches(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, translations.Inputs.InvalidEmailAddress)
      .nullable(),

      externalLink: Yup.string()
      .trim()
      .url(translations.Inputs.ValidWebsite)
      .nullable(),

    comments: Yup.string(),
    // תנאי סף: plain text, optional (server: thresholdCondition.ts, 3–500 characters).
    thresholdCondition: Yup.string().trim().nullable()
      .test('threshold-min', translations.Threshold.TooShort, (v) => !v || v.trim().length >= 3)
      .max(500, translations.Threshold.TooLong),
    isSponsored: Yup.boolean(),
    isMarked: Yup.boolean(),
    isSelfApply: Yup.boolean(),

    atLeastOneContact: Yup.mixed().test(
      'at-least-one-contact-method',
      translations.Inputs.AtLeastOneContact,
      function (_, context) {
        const {contactPersonEmail, externalLink } = context.parent;

        const email = contactPersonEmail?.trim();
        const link = externalLink?.trim();

        return !!(email || link);
      }
    )
  });



  const fetchLocations = async () => {
    const result = await LocationService.getInstance().fetchAllLocations();
    if (isString(result)) {
      showToast(result, "error");
      return;
    }
    const keyValueResult = result.reduce<Record<number, string>>((prev, current) => {
      prev[current.citySymbol] = current.city;
      return prev;
    }, {});
    setLocations(keyValueResult);
  };

  const fetchSkills = async () =>{
    const result = await SkillsService.getInstance().fetchSkillsListRequest();
  if (isString(result)) {
    showToast(
        result,
      "error",
    )
    return;
  }
  const transformedSkillsOptions = result.skills.map(skill => ({
    value: skill._id,  // The _id will be saved as the value
    label: skill.name  // The name will be displayed as the label
  }));

  setSkillsOptions(transformedSkillsOptions)
}

  useEffect(() => {
    setJobScopeOptions(getLocalizedOptions(LocalizedDataKey.JOB_SCOPE, currentLanguage));
    fetchSkills();
  }, [currentLanguage]);

  useEffect(() => {
    fetchLocations();
    // Shown next to "use the default" so the admin knows what a job inherits.
    SettingsService.getInstance().getApplyPolicy().then((result) => {
      if (!isString(result)) setApplyDefaults(result);
    });
    loadJobCustomFields().then(setJobFields);
  }, []);


  const handleChoosenLabelChange = (newValue: string) => {
    setChoosenlable(newValue); // Update parent state
  };

  const formik = useFormik({
    initialValues: {
      _id: job?._id ,
      title: job.title ,
      companyName: job.companyName ,
      citySymbol: job.citySymbol,
      jobScope: job.jobScope ,
      requiredSkills: job.requiredSkills ,
      description: job.description ,
      contactPersonName: job.contactPersonName ,
      contactPersonPhone: job.contactPersonPhone ,
      contactPersonEmail: job.contactPersonEmail ,
      externalLink: job.externalLink,
      comments: job.comments ,
      thresholdCondition: job.thresholdCondition ?? '',
      location: job.location ,
      publishDate: job.publishDate ,
      isSponsored: job.isSponsored,
      isMarked: job.isMarked,
      isSelfApply: job.isSelfApply,
      guestModeOverride: job.guestModeOverride ?? null,
      quickCvOverride: job.quickCvOverride ?? null,
      regularCvOverride: job.regularCvOverride ?? null,
      schedulePublish: false,
      atLeastOneContact: "",
      customFields: { ...(job.customFields ?? {}) } as Record<string, string | boolean>,
    },

    validationSchema: JobSchema,
    validate: (values) => {
      const e = customErrors(jobFields, values.customFields);
      return Object.keys(e).length ? ({ customFields: e } as any) : {};
    },
    onSubmit: (values) => {
      const { atLeastOneContact, ...cleanedValues } = values;
      const jobData: JobData = {
        ...cleanedValues,
        citySymbol: Number(values.citySymbol),
        // '' clears the condition (the server stores none).
        thresholdCondition: (values.thresholdCondition ?? '').trim(),
        dateToDisplay: DayValues.TODAY,
        // A new job starts Active; an edit keeps the job's status (it used to reactivate closed jobs).
        status: job?._id && job.status ? job.status : JobStatus.ACTIVE,
        // A future date is sent only as scheduled publishing (the box below); the server refuses it otherwise.
        schedulePublish: isFutureDate(values.publishDate) ? values.schedulePublish === true : undefined,
        locationPreview: choosenlable,
        ...(job?._id ? {} : { uploadBy: user?.email || '' }),
        // Every added field ('' / false = no answer); left out when the form has none.
        customFields: jobFields.length ? valuesToSend(jobFields, values.customFields) : undefined,
      };


      onSave(jobData);
    },
  });

  useEffect(() => {
    if (
      formik.errors.atLeastOneContact &&
      formik.submitCount > 0 &&
      !formik.isSubmitting
    ) {
      showToast(formik.errors.atLeastOneContact, "error");
    }
  }, [formik.errors.atLeastOneContact, formik.submitCount, formik.isSubmitting]);

  setReferenceToSubmitTrigger(formik.submitForm);
  return (
    <div className="px-4">
      <p className='pb-3 pt-2 font-RubikSmall'>
        {translations.JobDetails.Instructions}
      </p>
      <h5 className='font-RubikBold pb-3 '>{translations.JobDetails.JobDetailsTitle}</h5>
      <form onSubmit={formik.handleSubmit}>
        <div className="row gap-4">
        <div className="col-sm-2 col-xs-12 flex-grow-1 mb-3">
            <TextInput
              label={translations.JobDetails.CompanyNameLabel}
              name="companyName"
              type="text"
              value={formik.values.companyName}
              onChange={formik.handleChange}
              onBlur={formik.handleBlur}
              error={formik.touched.companyName && formik.errors.companyName ? formik.errors.companyName : null}
              required
            />
          </div>
          <div className="col-sm-2 col-xs-12 flex-grow-1 mb-3">
            <TextInput
              label={translations.JobDetails.JobNameLabel}
              name="title"
              type="text"
              value={formik.values.title}
              onChange={formik.handleChange}
              onBlur={formik.handleBlur}
              error={formik.touched.title && formik.errors.title ? formik.errors.title : null}
              required
            />
          </div>
          <div className="col-sm-2 col-xs-12 flex-grow-1 mb-3">
            <SelectAutocomplete
              label={translations.JobDetails.LocationLabel}
              name="citySymbol"
              value={formik.values.citySymbol}
              onChange={formik.handleChange}
              onBlur={formik.handleBlur}
              onValueChange={handleChoosenLabelChange}
              error={formik.touched.citySymbol && formik.errors.citySymbol ? formik.errors.citySymbol : ''}
              options={locations}
              required
            />
          </div>
          <div className="col-sm-2 col-xs-12 flex-grow-1 mb-3">
            <Select
              label={translations.JobDetails.JobScopeLabel}
              name="jobScope"
              value={formik.values.jobScope}
              onChange={formik.handleChange}
              onBlur={formik.handleBlur}
              error={
                formik.touched.jobScope && formik.errors.jobScope
                  ? Array.isArray(formik.errors.jobScope)
                    ? formik.errors.jobScope.join(', ')
                    : formik.errors.jobScope
                  : ''
              }
              options={jobScopeOptions}
              multiple
              required
            />
          </div>
        </div>

        <div className="row">
          <div className="col-md-3 mb-3 ps-3">
            <Select
              label={translations.Skills.Skills}
              name="requiredSkills"
              value={formik.values.requiredSkills}
              onChange={formik.handleChange}
              onBlur={formik.handleBlur}
              error={
                formik.touched.requiredSkills && formik.errors.requiredSkills
                  ? Array.isArray(formik.errors.requiredSkills)
                    ? formik.errors.requiredSkills.join(', ')
                    : formik.errors.requiredSkills
                  : ''
              } options={skillsOptions}
              multiple
              required
            />
          </div>

          <div className="col-md-3 mb-3 pe-1 pt-3 d-flex align-content-center">
            <Checkbox
              name="isSponsored"
              label={translations.JobDetails.SponsoredJob}
              checked={formik.values.isSponsored}
              onBlur={formik.handleBlur}
              className="p-2 font-RubikSmall"
              boxSize='1.25rem'
              onChange={(e) => {
                const isChecked = e.target.checked;
                formik.setFieldValue('isSponsored', isChecked);
                if (isChecked) {
                  formik.setFieldValue('isMarked', true);
                  // A sponsored job is applied for through SKEELZ (as before: no self apply).
                  if (formik.values.guestModeOverride === 'self') formik.setFieldValue('guestModeOverride', null);
                }
              }}
            />
          </div>
           <div className="col-md-3 mb-3 pe-1 pt-3 d-flex align-content-center">
            <Checkbox
              name="isMarked"
              label={translations.JobDetails.HotPosition}
              checked={formik.values.isMarked}
              onChange={formik.handleChange}
              onBlur={formik.handleBlur}
              className="p-2 font-RubikSmall"
              boxSize='1.25rem'
            />
          </div>
        </div>

        {/* Board placement (docs/jobs-management.md): publish date (a future date = scheduled, hidden until then) Only Active jobs are public (the status). */}
        <div className="row mb-2 align-items-end">
          <div className="col-md-3 mb-3">
            <label htmlFor="job-publish-date" className="font-RubikMedium fs-6 mb-1 d-block">{translations.JobsAdmin.FormPublishDate}</label>
            <input
              id="job-publish-date"
              type="date"
              className="form-control"
              max={maxScheduleInput()}
              value={toDateInput(formik.values.publishDate)}
              onChange={(e) => {
                const d = fromDateInput(e.target.value);
                if (d) formik.setFieldValue('publishDate', d);
              }}
              aria-describedby={isFutureDate(formik.values.publishDate) ? 'job-publish-date-hint' : undefined}
            />
          </div>
          {isFutureDate(formik.values.publishDate) && (
            <div className="col-md-4 mb-3">
              <Checkbox
                name="schedulePublish"
                label={translations.JobsAdmin.SchedulePublish}
                checked={!!formik.values.schedulePublish}
                onChange={(e) => formik.setFieldValue('schedulePublish', e.target.checked)}
                className="p-2 font-RubikSmall"
                boxSize='1.25rem'
              />
              <div id="job-publish-date-hint" className="font-RubikSmall text-color-dark-grey">{translations.JobsAdmin.ScheduledHint}</div>
            </div>
          )}
        </div>

        <div className="row mb-2">
          <div className="col-12">
            <h6 className="font-RubikBold pb-1">{translations.ApplyPolicy.JobSectionTitle}</h6>
            {/* Ways to apply (utils/applyPolicy.ts) as compact checkboxes; equal to the site default = follow it. */}
            <JobFlags
              idPrefix="job-form-flags"
              label={translations.ApplyPolicy.JobSectionTitle}
              values={formik.values as any}
              defaults={applyDefaults}
              show={{}}
              disabled={coordinator}
              onChange={(patch) => {
                for (const [k, v] of Object.entries(patch)) formik.setFieldValue(k, v);
                // Direct apply and sponsored don't go together (as before).
                if (patch.guestModeOverride === 'self') formik.setFieldValue('isSponsored', false);
              }}
            />
            <div className="font-RubikSmall text-color-dark-grey mt-1">{coordinator ? translations.JobsAdmin.ContentManagerOnly : translations.JobsAdmin.FlagsHint}</div>
          </div>
        </div>

        <div className="row mb-3">
          <div className="col rich-text-editor">
            <RichTextEditor
              label={translations.JobDetails.DescriptionLabel}
              required
              placeholder={translations.JobDetails.DescriptionPlaceholder}
              value={formik.values.description}
              onChange={(html: string) => formik.setFieldValue('description', html)}
            />
            {formik.touched.description && formik.errors.description && (
              <div className="text-danger">{formik.errors.description}</div>
            )}
          </div>
        </div>

        <div className="row">
          <div className="col-12">
            <TextArea
              label={translations.JobDetails.CommentsLabel}
              name="comments"
              value={formik.values.comments}
              onChange={formik.handleChange}
              onBlur={formik.handleBlur}
              rows={4}
              required={false}
              error={formik.touched.comments && formik.errors.comments ? formik.errors.comments : undefined}
              placeholder={translations.JobDetails.CommentsPlaceholder}
            />
          </div>
        </div>

        <div className="row">
          <div className="col-12">
            <TextArea
              label={translations.Threshold.Label}
              name="thresholdCondition"
              value={formik.values.thresholdCondition ?? ''}
              onChange={formik.handleChange}
              onBlur={formik.handleBlur}
              rows={2}
              maxLength={500}
              required={false}
              disabled={coordinator}
              aria-describedby="thresholdCondition-hint"
              error={formik.touched.thresholdCondition && formik.errors.thresholdCondition ? String(formik.errors.thresholdCondition) : undefined}
              placeholder={translations.Threshold.FieldPlaceholder}
            />
            <p id="thresholdCondition-hint" className="font-RubikSmall text-color-dark-grey mt-n2 mb-3">{coordinator ? translations.JobsAdmin.ContentManagerOnly : translations.Threshold.FieldHint}</p>
          </div>
        </div>

        {jobFields.length > 0 && (
          <>
            <h5 className='font-RubikBold pb-1'>פרטים נוספים</h5>
            <p className='font-RubikSmall text-color-dark-grey pb-2 mb-0'>שדות שמנהלי התוכן הוסיפו בהגדרות. חלקם מוצגים בעמוד המשרה.</p>
            <CustomFieldInputs
              fields={jobFields}
              values={formik.values.customFields}
              idPrefix="job"
              errors={formik.submitCount > 0 ? ((formik.errors as any).customFields ?? {}) : {}}
              requiredText={translations.Inputs.Required}
              invalidText={translations.Inputs.InvalidValue}
              onChange={(id, value) => formik.setFieldValue('customFields', { ...(formik.values.customFields ?? {}), [id]: value })}
            />
          </>
        )}

        <h5 className='font-RubikBold pb-1'>{translations.JobDetails.ContactInfoTitle}</h5>
        <p className='font-RubikSmall text-color-dark-grey pb-3 mb-0'>{translations.ApplyPolicy.ContactPublicHint}</p>
        <div className="row gap-4">
          <div className="col-sm-2 col-xs-12 flex-grow-1 mb-3">
            <TextInput
              label={translations.JobDetails.ContactPersonNameLabel}
              name="contactPersonName"
              type="text"
              value={formik.values.contactPersonName}
              onChange={formik.handleChange}
              onBlur={formik.handleBlur}
              error={
                formik.touched.contactPersonName && formik.errors.contactPersonName
                  ? formik.errors.contactPersonName
                  : null
              }
            />
          </div>
          <div className="col-sm-2 col-xs-12 flex-grow-1 mb-3">
            <TextInput
              label={translations.JobDetails.ContactPersonPhoneLabel}
              name="contactPersonPhone"
              type="text"
              value={formik.values.contactPersonPhone}
              onChange={formik.handleChange}
              onBlur={formik.handleBlur}
              error={
                formik.touched.contactPersonPhone && formik.errors.contactPersonPhone
                  ? formik.errors.contactPersonPhone
                  : null
              }
            />
          </div>
          <div className="col-sm-2 col-xs-12 flex-grow-1 mb-3">
            <TextInput
              label={translations.JobDetails.ContactPersonEmailLabel}
              name="contactPersonEmail"
              type="email"
              value={formik.values.contactPersonEmail}
              onChange={formik.handleChange}
              onBlur={formik.handleBlur}
              error={
                formik.touched.contactPersonEmail && formik.errors.contactPersonEmail
                  ? formik.errors.contactPersonEmail
                  : null
              }
            />
          </div>
          <div className="col-sm-2 col-xs-12 flex-grow-1 mb-3">
            <TextInput
              label={translations.JobDetails.ExternalLink}
              name="externalLink"
              type="email"
              value={formik.values.externalLink}
              onChange={formik.handleChange}
              onBlur={formik.handleBlur}
              error={
                formik.touched.externalLink && formik.errors.externalLink
                  ? formik.errors.externalLink
                  : null
              }
            />
          </div>
        </div>
      </form>
    </div>
  );
};

export default JobDetails;
