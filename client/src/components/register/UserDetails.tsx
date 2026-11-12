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

interface UserDetailsProps {
  formikRef?: React.MutableRefObject<FormikProps<RegisterFormValues> | null>;
  handleSubmit: (values: RegisterFormValues) => void;
  initialData: RegisterFormValues;
  /** No password section (sign-up after "Continue with Google", or editing one's own details). */
  noPassword?: boolean;
  /** Email shown but not editable, with this explanation under it. */
  emailReadOnlyHint?: string;
  /** Text above the CV upload (e.g. "you already have a CV"). */
  cvHint?: string;
}

export const UserDetails: React.FC<UserDetailsProps> = ({ initialData, formikRef, handleSubmit, noPassword, emailReadOnlyHint, cvHint }) => {
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
      phoneNumber: initialData.phoneNumber || '',
      citySymbol: initialData.citySymbol || 0,
      password: initialData.password || '',
      confirmPassword: initialData.confirmPassword || '',
      skills: initialData.skills || [],
      cvFileUrl: initialData.cvFileUrl || '',
      hasAppliedToJob: false,
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
        dateOfBirth: Yup.date()
        .required(translations.Inputs.Required)
        .max(new Date(), translations.Inputs.InvalidDate)
        .min(new Date(new Date().setFullYear(new Date().getFullYear() - 120)), translations.Inputs.InvalidDate)
        .typeError(translations.Inputs.InvalidDate) // Ensures that the error message is shown for invalid date types
      ,
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
      citySymbol: Yup.string().required(translations.Inputs.Required),
      gender: Yup.string()
        .oneOf(Object.values(Gender), 'Invalid gender') 
        .required(translations.Inputs.Required),
      ...(noPassword ? {} : {
      password: Yup.string()
        .matches(/^[A-Za-z0-9]+$/, translations.PasswordRequirements.OnlyLettersNumbers)
        .min(8, translations.PasswordRequirements.MinLength)
        .matches(/[a-z]/, translations.PasswordRequirements.Lowercase)
        .matches(/[A-Z]/, translations.PasswordRequirements.Uppercase)
        .matches(/\d/, translations.PasswordRequirements.Number)
        .required(translations.Inputs.Required),
      confirmPassword: Yup.string()
        .oneOf([Yup.ref('password')], translations.PasswordRequirements.MustMatch)
        .required(translations.Inputs.Required),
      }),
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
                required
                label={translations.Register.DateOfBirth}
                value={formik.values.dateOfBirth}
                onChange={(date) => formik.setFieldValue('dateOfBirth', date)}
                 name={''} 
                 error={formik.touched.dateOfBirth && formik.errors.dateOfBirth ? formik.errors.dateOfBirth : ''}
                 />
            </div>

            <div className="col-md-4   px-2">
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

            <div className="col-md-4   px-2">
              <SelectAutocomplete
                required
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

          {/* Gender */}
          <div className="mb-3 px-2 pb-4">
            <Label required htmlFor={'gender'} className="font-RubikRegular mb-0 pt-2 ps-3 pb-1">{translations.Register.Gender}</Label>
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

        {/* Last Row: Password and Confirm Password */}

        {!noPassword && <div className='m-3 mt-4 py-3'>
          <div className="d-flex align-items-center">
            <h2 className="font-RubikBold pe-3 ps-1 fs-1-25rem mb-1">{translations.Register.ChoosePassword}</h2>
            <span className="font-RubikRegular text-dark fs-1-25rem mb-1 d-none d-sm-block">(שימו לב שהסיסמה עומדת בכל התנאים)</span>
          </div>
          <div className='px-3'>
            <span className="font-RubikRegular text-color-dark-grey pb-4 fs-1-125rem">
            {translations.Register.ChoosePasswordRole}
          </span>
          </div>
          

          <div className="row mt-4 py-2">
            <div className="col-md-4 height-6-6rem px-2">
              <TextInput
                required
                label={translations.Register.Password}
                type="password"
                name="password"
                placeholder={translations.Register.Password}
                value={formik.values.password}
                onChange={formik.handleChange}
                onBlur={formik.handleBlur}
                error={formik.touched.password && formik.errors.password ? formik.errors.password : ''}
              />
            </div>
            <div className="col-md-4 height-6-6rem px-2">
              <TextInput
                required
                label={translations.Register.ConfirmPassword}
                type="password"
                name="confirmPassword"
                placeholder={translations.Register.ConfirmPassword}
                value={formik.values.confirmPassword}
                onChange={formik.handleChange}
                onBlur={formik.handleBlur}
                error={
                  formik.touched.confirmPassword && formik.errors.confirmPassword
                    ? formik.errors.confirmPassword
                    : ''
                }
              />
            </div>
          </div>
        </div>}
      </form>
    </div>
  );
};

export default UserDetails;
