import React, { useEffect, useState } from 'react';
import { FormikProps, useFormik } from 'formik';
import * as Yup from 'yup';
import { Colors, Gender } from '../../i18n/General.enums';
import { isString } from '../../utils/utils';
import { LocationService } from '../../services/api/Location.service';
import { RegisterFormValues } from '../../models/interfaces/Props.interfaces';
import useToastStore from '../../store/Toast.store';
import CustomRadio from '../common/RadioButton';
import TextInput from '../common/TextInput';
import FieldErrorMessage from '../common/FieldErrorMessage';
import { i18n } from '../../i18n/I18n';
import Label from '../common/Label';
import DateInput from '../common/DateInput';
import SelectAutocomplete from '../common/SelectAutocomplete';
import UploadFileArea from '../common/UploadFileArea';
import { DEFAULT_SIGNUP_FIELDS, SignupFields, israeliIdOk } from '../../utils/signupFields';
import CustomFieldInputs from '../common/CustomFieldInputs';
import { customErrors, FormField } from '../../utils/customFields';

interface UserDetailsProps {
  formikRef?: React.MutableRefObject<FormikProps<RegisterFormValues> | null>;
  handleSubmit: (values: RegisterFormValues) => void;
  initialData: RegisterFormValues;
  /** Email shown but not editable, with this explanation under it. */
  emailReadOnlyHint?: string;
  /** Text above the CV upload (e.g. "you already have a CV"). */
  cvHint?: string;
  /** Which fields are required / optional / hidden (the admins' setting; the server enforces the same). */
  fields?: SignupFields;
  /** The questions content managers added (settings screen); the server checks the same. */
  customFields?: FormField[];
}

export const UserDetails: React.FC<UserDetailsProps> = ({ initialData, formikRef, handleSubmit, emailReadOnlyHint, cvHint, fields = DEFAULT_SIGNUP_FIELDS, customFields = [] }) => {
  const req = (f: keyof SignupFields) => fields[f] === 'required';
  const [locations, setLocations] = useState<Record<number, string>>({});
  const { showToast } = useToastStore();
  const translations = i18n.getTranslations();
  
  const handleCvFilePath = (filePath: string) => {
    formik.values.cvFileUrl = filePath;
  };
  
  const fetchLocations = async () => {
    const result = await LocationService.getInstance().fetchAllLocations();
    if (isString(result)) {
      showToast(result, 'error');
      return;
    }
    const filteredResult = result.filter(location => location.citySymbol > 0); 
    const keyValueResult = filteredResult.reduce<Record<number, string>>((prev, current) => {
      prev[current.citySymbol] = current.city;
      return prev;
    }, {});

    setLocations(keyValueResult);

  };

  useEffect(() => {
    fetchLocations();
  }, []);

  const formik = useFormik<RegisterFormValues>({
    initialValues: {
      email: initialData.email || '',
      gender: initialData.gender,
      firstName: initialData.firstName || '',
      lastName: initialData.lastName || '',
      dateOfBirth: initialData.dateOfBirth,
      idNumber: initialData.idNumber || '',
      phoneNumber: initialData.phoneNumber || '',
      citySymbol: initialData.citySymbol || 0,
      skills: initialData.skills || [],
      cvFileUrl: initialData.cvFileUrl || '',
      hasAppliedToJob: false,
      customFields: { ...(initialData.customFields ?? {}) },
    },
    // The added questions (runs together with the schema below).
    validate: (values) => {
      const e = customErrors(customFields, values.customFields);
      return Object.keys(e).length ? ({ customFields: e } as any) : {};
    },
    validationSchema: Yup.object({
      email: Yup.string()
        .email(translations.Inputs.InvalidEmailAddress)
        .matches(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, translations.Inputs.InvalidEmailAddress)
        .required(translations.Inputs.Required),
      lastName: Yup.string()
        .required(translations.Inputs.Required)
        .matches(/^[^0-9]*$/, translations.Inputs.InvalidLastName)
        .min(2, translations.Inputs.InvalidLastName)  // Minimum length of 2
        .max(30, translations.Inputs.InvalidLastName),  // Maximum length of 30

      firstName: Yup.string()
        .required(translations.Inputs.Required)
        .matches(/^[^0-9]*$/, translations.Inputs.InvalidFirstName)
        .min(2, translations.Inputs.InvalidFirstName)  // Minimum length of 2
        .max(30, translations.Inputs.InvalidFirstName),  // Maximum length of 30
      // Birth date from three dropdowns: an Invalid Date means only some were chosen.
      dateOfBirth: (req('dateOfBirth') ? Yup.date().required(translations.Inputs.Required) : Yup.date().nullable())
        .typeError(translations.Inputs.IncompleteDate)
        .max(new Date(), translations.Inputs.InvalidDate)
        .min(new Date(new Date().setFullYear(new Date().getFullYear() - 120)), translations.Inputs.InvalidDate),
      idNumber: fields.idNumber === 'hidden' ? Yup.string().notRequired() : (req('idNumber') ? Yup.string().required(translations.Inputs.Required) : Yup.string())
        .test('israeli-id', translations.Inputs.InvalidIdNumber, (v) => !v || israeliIdOk(v)),
      phoneNumber: (req('phoneNumber') ? Yup.string().required(translations.Inputs.Required) : Yup.string())
        .matches(/^\d*$/, translations.Inputs.InvalidPhoneNumber) // Ensure only digits are allowed
        .test('valid-phone', translations.Inputs.InvalidPhoneNumber, (value) => {
          if (!value) return !req('phoneNumber');
          // Mobile: 05x + 7 digits (leading zeros stripped); landline: 02/03/04/08/09 + 7 digits.
          const strippedValue = value.replace(/^0+/, '');
          if (strippedValue.startsWith('5') && strippedValue.length === 9) return /^5\d{8}$/.test(strippedValue);
          return /^(02|03|04|08|09)\d{7}$/.test(value);
        }),
      citySymbol: Yup.mixed().test('city', translations.Inputs.Required, (v) => !req('citySymbol') || Number(v) > 0),
      gender: req('gender')
        ? Yup.string().oneOf(Object.values(Gender), 'Invalid gender').required(translations.Inputs.Required)
        : Yup.string().nullable().oneOf([...Object.values(Gender), null, undefined, ''] as any[], 'Invalid gender'),
      // cvFileUrl: Yup.string()
      // .required(translations.Inputs.CVRequired),
    }),
    onSubmit: handleSubmit,
  });

  React.useEffect(() => {
    if (formikRef) {
      formikRef.current = formik;
    }
  }, [formik, formikRef]);

  return (
    <div>
      <form onSubmit={formik.handleSubmit} className="justify-content-between">
        <div className='border-bottom m-3 border-black'>
          <span className="font-RubikBold fs-1-25rem px-3 text-dark mb-4">{translations.Register.YourDetails}</span>

          {/* First Row: Email, First Name, Last Name */}
          <div className="row mt-4 mb-1 mb-md-4">
            <div className=" col-md-4   px-2">
              <TextInput
                required
                label={translations.Register.EmailAddress}
                type="email"
                name="email"
                placeholder={translations.Register.EmailAddress}
                value={formik.values.email}
                onChange={formik.handleChange}
                onBlur={formik.handleBlur}
                readOnly={!!emailReadOnlyHint}
                aria-readonly={!!emailReadOnlyHint || undefined}
                aria-describedby={emailReadOnlyHint ? 'email-readonly-hint' : undefined}
                error={formik.touched.email && formik.errors.email ? formik.errors.email : ''}
              />
              {emailReadOnlyHint && (
                <small id="email-readonly-hint" className="font-RubikRegular text-color-dark-grey d-block px-3">{emailReadOnlyHint}</small>
              )}
            </div>
            <div className="col-md-4   px-2">
              <TextInput
                required
                label={translations.Register.FirstName}
                name="firstName"
                placeholder={translations.Register.FirstName}
                value={formik.values.firstName}
                onChange={formik.handleChange}
                onBlur={formik.handleBlur}
                error={formik.touched.firstName && formik.errors.firstName ? formik.errors.firstName : ''}
              />
            </div>
            <div className="col-md-4   px-2">
              <TextInput
                required
                label={translations.Register.LastName}
                name="lastName"
                placeholder={translations.Register.LastName}
                value={formik.values.lastName}
                onChange={formik.handleChange}
                onBlur={formik.handleBlur}
                error={formik.touched.lastName && formik.errors.lastName ? formik.errors.lastName : ''}
              />
            </div>
          </div>

          <div className="row">
            <div className="col-md-4 px-2">
              <DateInput
                required={req('dateOfBirth')}
                label={translations.Register.DateOfBirth}
                value={formik.values.dateOfBirth}
                onChange={(date) => { formik.setFieldTouched('dateOfBirth', true, false); formik.setFieldValue('dateOfBirth', date); }}
                name="dateOfBirth"
                error={formik.touched.dateOfBirth && formik.errors.dateOfBirth ? String(formik.errors.dateOfBirth) : ''}
              />
            </div>

            <div className="col-md-4   px-2">
              <TextInput
                required={req('phoneNumber')}
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

            <div className="col-md-4   px-2">
              <SelectAutocomplete
                required={req('citySymbol')}
                label={translations.Register.City}
                name="citySymbol"
                value={formik.values.citySymbol} 
                onChange={formik.handleChange}
                onBlur={formik.handleBlur}
                options={locations}
                error={formik.touched.citySymbol && formik.errors.citySymbol ? formik.errors.citySymbol : ''}
              />
            </div>
          </div>

          {/* ID number (תעודת זהות): shown unless the setting hides it; never sent to analytics or logs. */}
          {fields.idNumber !== 'hidden' && (
            <div className="row mt-3">
              <div className="col-md-4 px-2">
                <TextInput
                  required={req('idNumber')}
                  label={translations.Register.IdNumber}
                  name="idNumber"
                  id="idNumber"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={9}
                  placeholder=""
                  value={formik.values.idNumber}
                  onChange={(e) => formik.setFieldValue('idNumber', e.target.value.replace(/\D/g, '').slice(0, 9))}
                  onBlur={formik.handleBlur}
                  aria-describedby="idNumber-hint"
                  error={formik.touched.idNumber && formik.errors.idNumber ? formik.errors.idNumber : ''}
                />
                <small id="idNumber-hint" className="font-RubikRegular text-color-dark-grey d-block px-3">{translations.Register.IdNumberHint}</small>
              </div>
            </div>
          )}

          {/* Gender */}
          <div className="mb-3 px-2 pb-4">
            <Label required={req('gender')} htmlFor={'gender'} className="font-RubikRegular mb-0 pt-2 ps-3 pb-1">{translations.Register.Gender}</Label>
            <div className="d-flex">
              <CustomRadio
                name="gender"
                label={translations.Register.Male}
                value={Gender.Male}
                checked={formik.values.gender === Gender.Male}
                onChange={formik.handleChange}
              />
              <CustomRadio
                name="gender"
                label={translations.Register.Female}
                value={Gender.Female}
                checked={formik.values.gender === Gender.Female}
                onChange={formik.handleChange}
              />
              <CustomRadio
                name="gender"
                label={translations.Register.Other}
                value={Gender.Other}
                checked={formik.values.gender === Gender.Other}
                onChange={formik.handleChange}
              />
            </div>
            <FieldErrorMessage error={formik.touched.gender && formik.errors.gender ? formik.errors.gender : ''} />
          </div>

          {/* Questions added by content managers (settings screen). */}
          {customFields.length > 0 && (
            <div className="mt-2">
              <CustomFieldInputs
                fields={customFields}
                values={formik.values.customFields}
                idPrefix="signup"
                errors={formik.submitCount > 0 ? ((formik.errors as any).customFields ?? {}) : {}}
                requiredText={translations.Inputs.Required}
                invalidText={translations.Inputs.InvalidValue}
                onChange={(id, value) => formik.setFieldValue('customFields', { ...(formik.values.customFields ?? {}), [id]: value })}
              />
            </div>
          )}

          {/* Upload CV File */}
          {cvHint && <p className="font-RubikRegular text-color-dark-grey px-3 mb-1">{cvHint}</p>}
          <UploadFileArea 
          fileInside={!!formik.values.cvFileUrl}
          className={'mb-3 mb-sm-5 w-sm-50 h-sm-50'} 
          iconColor={Colors.DarkGrayD} 
          onFilePathChange={handleCvFilePath}
          error={formik.touched.cvFileUrl && formik.errors.cvFileUrl ? formik.errors.cvFileUrl : ''}
          />
          
        </div>

      </form>
    </div>
  );
};

export default UserDetails;
