import {forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { i18n } from "../i18n/I18n";
import TextInput from "./common/TextInput";
import * as Yup from 'yup';
import { useFormik } from "formik";
import { Guest, guestApplyValues } from "../models/interfaces/Props.interfaces";
import SmallUploadFileArea from "./common/SmallUploadFileArea";
import { applyFlow, startGuestApply, track, trackOnce } from "../utils/analytics";
import ConsentChecks from "./consent/ConsentChecks";



interface UploadCvContentProps {
  userId?: string;
  index?: number;
  handleGuestApply: (guestProfile: Guest) => Promise<string | void>;
  /** Admin policy: this job does not accept a quick application without a CV. */
  cvRequired?: boolean;
  onUpdateUser?: (index: number, userId: string, cvFilePath: string) => void;
  /** For analytics only. */
  jobId?: string;
  /** For analytics only: the job has a threshold condition. */
  hasThreshold?: boolean;
}

export interface FormHandle {
  submit: () => Promise<any>;
}

export const GuestApplyModal =  forwardRef<FormHandle, UploadCvContentProps>(({ handleGuestApply, cvRequired = false, jobId, hasThreshold = false }, ref) => {
  const [cvFilePath, setCvFilePath] = useState('');
  const translations = i18n.getTranslations();
  const ga = { job_id: jobId, apply_type: 'guest' } as const;
  useEffect(() => {
    if (jobId) trackOnce(`apply_form_shown:${jobId}`, 'apply_form_shown', { ...ga, cv_required: cvRequired });
  }, [jobId]);

  const handleCvFilePath = (filePath: string) => {
    setCvFilePath(filePath);
    formik.setFieldValue('cvFilePath', filePath);
  };

  const formik = useFormik<guestApplyValues>({
    initialValues: {
      email: '',
      fullName: '',
      phoneNumber: '',
      cvFilePath: '',
      consent: false,
      marketingConsent: false,
    },
    validationSchema: Yup.object({
      email: Yup.string()
        .email(translations.Inputs.InvalidEmailAddress)
        .matches(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, translations.Inputs.InvalidEmailAddress)
        .required(translations.Inputs.Required),
      fullName: Yup.string()
        .required(translations.Inputs.Required)
        .matches(/^[^0-9]*$/, translations.Inputs.InvalidFullName)
        .min(2, translations.Inputs.InvalidFullName)  // Minimum length of 2
        .max(50, translations.Inputs.InvalidFullName),  // Maximum length of 50
      phoneNumber: Yup.string()
              .matches(/^\d+$/, translations.Inputs.InvalidPhoneNumber) // Ensure only digits are allowed
              .test('valid-phone', translations.Inputs.InvalidPhoneNumber, (value) => {
                if (value) {
                  // Remove leading zeros only if the number starts with '05' (mobile number prefix)
                  let strippedValue = value.replace(/^0+/, '');
      
                  // If the number is mobile (starts with '05'), we strip the leading zero
                  // For landlines, do not strip the leading zero
                  if (strippedValue.startsWith('5') && strippedValue.length === 9) {
                    // This is a mobile number
                    return /^5\d{8}$/.test(strippedValue); // Mobile pattern: 05xxxxxxxx
                  }
      
                  // For landline numbers (02, 03, 04, 08, 09)
                  return /^(02|03|04|08|09)\d{7}$/.test(value); // Landline pattern: 02xxxxxxx, 03xxxxxxx, etc.
                }
                return false;
              })
              .required(translations.Inputs.Required),  
      cvFilePath: cvRequired
        ? Yup.string().required(translations.Inputs.CVRequired)
        : Yup.string(),
      consent: Yup.boolean().oneOf([true], translations.Terms.TermsRequired),
    }),
    onSubmit: async (values) => {
      await handleGuestApply({ ...values, cvFilePath });
    },
  });

  useImperativeHandle(ref, () => ({
    submit: async () => {
      const errors = await formik.validateForm();
      // Field names only, never what was typed.
      for (const [field, message] of Object.entries(errors)) {
        const required = message === translations.Inputs.Required || message === translations.Inputs.CVRequired || field === 'consent';
        track('apply_validation_error', { ...ga, field_name: field, error_code: required ? 'required' : 'invalid' });
      }
      return formik.submitForm();
    },
    hasErrors: async () => {
      const errors = await formik.validateForm();
      return Object.keys(errors).length > 0;
    }
  }));


  return (
      <div className="me-0 me-md-4 bg-color-light-greyB border-radius-16 py-2" style={{ minHeight: '30rem' }}>
        {/* Analytics: the first focus in the form starts the guest's application (the apply funnel). */}
        <form onSubmit={formik.handleSubmit} className="justify-content-between"
          onFocusCapture={() => { if (jobId) startGuestApply(jobId, cvRequired, hasThreshold); }}>
          <div>
            <span className="font-RubikBold fs-1-25rem px-3 text-dark d-block">{translations.JobCard.ApplyForJob}</span>
            <div className="mt-2 mb-1 mb-md-4">
              <div className="height-5-5rem my-2 mx-4">
                <TextInput
                  required
                  label={translations.Register.fullName}
                  name="fullName"
                  placeholder={translations.Register.fullName}
                  value={formik.values.fullName}
                  onChange={formik.handleChange}
                  onBlur={formik.handleBlur}
                  error={formik.touched.fullName && formik.errors.fullName ? formik.errors.fullName : ''}
                />
              </div>
               <div className=" height-5-5rem my-2 mx-4">
                <TextInput
                  required
                  label={translations.Register.EmailAddress}
                  type="email"
                  name="email"
                  placeholder={translations.Register.EmailAddress}
                  value={formik.values.email}
                  onChange={formik.handleChange}
                  onBlur={formik.handleBlur}
                  error={formik.touched.email && formik.errors.email ? formik.errors.email : ''}
                />
              </div>
              <div className=" height-5-5rem my-2 mx-4">
                <TextInput
                  required
                  label={translations.Register.PhoneNumber}
                  type="tel"
                  name="phoneNumber"
                  placeholder={""}
                  value={formik.values.phoneNumber}
                  onChange={formik.handleChange}
                  onBlur={formik.handleBlur}
                  error={formik.touched.phoneNumber && formik.errors.phoneNumber ? formik.errors.phoneNumber : ''}
                />
              </div>
            </div>
            <div className='d-flex m-2 m-md-4 flex-column'>
              <div className='height-8rem pt-4 pt-md-1 max-width-24rem'>
                <SmallUploadFileArea 
                onFilePathChange={handleCvFilePath}
                onUploadStart={() => { if (jobId) { startGuestApply(jobId, cvRequired, hasThreshold); applyFlow.step('apply_cv_upload_start', 'cv_upload', {}, jobId); } }}
                onUploadResult={(r) => r.ok
                  ? applyFlow.step('apply_cv_upload', 'cv_upload', { file_type: r.fileType, file_size_kb: r.sizeKb }, jobId)
                  : applyFlow.step('apply_cv_upload_error', 'cv_upload', { error_code: r.code }, jobId)}
                className="w-100 pb-1"
                label={cvRequired ? `${translations.Cv.UploadCv} *` : undefined}
                aria-required={cvRequired || undefined}
                />
                {formik.touched.cvFilePath && formik.errors.cvFilePath && (
              <span className="text-danger mt-2 pe-1 text-end">
                {formik.errors.cvFilePath}
              </span>
            )}
              </div>
              <ConsentChecks idPrefix={`guest-apply-${jobId ?? 'job'}`} audience="candidate" className="mt-3"
                values={{ consent: formik.values.consent, marketingConsent: formik.values.marketingConsent }}
                termsError={!!(formik.submitCount && formik.errors.consent)}
                onChange={(v) => { formik.setFieldValue('consent', v.consent); formik.setFieldValue('marketingConsent', v.marketingConsent); }} />
            </div>
          </div>
        </form>
      </div>
  );
});
