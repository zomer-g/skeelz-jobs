import React, { useState } from "react";
import { useFormik } from "formik";
import * as Yup from "yup";
import { LoginService } from "../services/api/Login.service";
import { i18n } from "../i18n/I18n";
import { isString } from "../utils/utils";
import { StatusMessageState } from "../i18n/General.enums";
import StatusMessage from "./common/StatusMessage";
import Button from "./common/Button";
import TextInput from "./common/TextInput";
import { CheckContainedIcon } from "../icons";
import useModalStore from "../store/Modal.store";

interface ResetPasswordProps {
  token: string;
}

const ResetPassword: React.FC<ResetPasswordProps> = ({ token }) => {
  const translations = i18n.getTranslations();
  const [statusMessage, setStatusMessage] = useState<StatusMessageState | null>(null);
  const { initModal } = useModalStore();
  const validationSchema = Yup.object({
    password: Yup.string()
        .matches(/^[A-Za-z0-9]+$/, translations.PasswordRequirements.OnlyLettersNumbers)
        .min(8, translations.PasswordRequirements.MinLength)
        .matches(/[a-z]/, translations.PasswordRequirements.Lowercase)
        .matches(/[A-Z]/, translations.PasswordRequirements.Uppercase)
        .matches(/\d/, translations.PasswordRequirements.Number)
        .required(translations.Inputs.Required),
    confirmPassword: Yup.string()
      .oneOf([Yup.ref("password")], translations.PasswordRequirements.MustMatch)
      .required(translations.Inputs.Required),
  });

  const formik = useFormik({
    initialValues: { password: "", confirmPassword: "" },
    validationSchema,
    onSubmit: async (values, { setSubmitting }) => {
      if (!token) {
        setStatusMessage({ message: translations.ResetPassword.MissingToken, isError: true });
        setSubmitting(false);
        return;
      }

      const response = await LoginService.getInstance().resetPassword({
        token,
        newPassword: values.password,
      });

      if (isString(response)) {
        setStatusMessage({ message: response, isError: true });
      } else {
        // setStatusMessage({ message: translations.ResetPassword.MissingToken, isError: false });
        initModal({
          active: true,
          modalBody: (
            <div className='d-flex justify-content-center flex-column align-items-center text-center'>
              <div className="my-2 d-flex justify-content-center align-items-center rounded-circle size-3-375rem background-color-green-mint border-color-green-sage border-width-0-5-rem border">
                <CheckContainedIcon />
              </div>
              <h1 className='font-RubikBold py-3 m-0 fs-5'>{translations.ResetPassword.NewPasswordSaved}</h1>
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

      setSubmitting(false);
    },
  });

  return (
    <div className="px-2">
      <form onSubmit={formik.handleSubmit} className="d-flex flex-column align-items-center">
        <div className="max-width-20rem height-20-18rem py-4 w-100">
          <p className="text-center">{translations.ResetPassword.Subtitle}</p>

          {/* Password Field */}
          <div className="pb-3 w-100">
            <TextInput
              label={translations.Inputs.PasswordLabel}
              name="password"
              required
              type="password"
              placeholder={translations.Inputs.PasswordPlaceholder}
              value={formik.values.password}
              onChange={formik.handleChange}
              onBlur={formik.handleBlur}
              error={formik.touched.password ? formik.errors.password : undefined}
            />
          </div>

          {/* Confirm Password Field */}
          <div className="pb-3 w-100">
            <TextInput
              required
              label={translations.Inputs.ConfirmPasswordLabel}
              name="confirmPassword"
              type="password"
              placeholder={translations.Inputs.ConfirmPasswordPlaceholder}
              value={formik.values.confirmPassword}
              onChange={formik.handleChange}
              onBlur={formik.handleBlur}
              error={formik.touched.confirmPassword ? formik.errors.confirmPassword : undefined}
            />
          </div>
          {/* Status Message */}
          <StatusMessage
            message={statusMessage?.message || ""}
            isError={statusMessage?.isError}
            className="text-center mt-3"
          />
        </div>

        {/* Submit Button */}
        <div className="max-width-20rem height-8-25rem w-100 d-flex flex-column justify-content-center text-center align-items-center">
          <Button
            className="w-100 bg-color-purple w-75 pt-2 pb-2 fs-6 rounded-pill"
            type="submit"
          >
            {translations.ResetPassword.Button}
          </Button>
        </div>
      </form>
    </div>
  );
};

export default ResetPassword;
