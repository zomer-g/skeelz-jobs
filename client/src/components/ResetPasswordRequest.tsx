import React, { useState } from "react";
import { useFormik } from "formik";
import * as Yup from "yup";
import { LoginService } from "../services/api/Login.service";
import { i18n } from "../i18n/I18n";
import { StatusMessageState } from "../i18n/General.enums";
import StatusMessage from "./common/StatusMessage";
import { isString } from "../utils/utils";
import Button from "./common/Button";
import TextInput from "./common/TextInput";

interface ResetPasswordRequestProps {
  onRegisterButtonClicked: () => void;
  isFirstPasswordInitialization?: boolean;
}

const ResetPasswordRequest: React.FC<ResetPasswordRequestProps> = ({ onRegisterButtonClicked, isFirstPasswordInitialization }) => {
  const translations = i18n.getTranslations();
  const [statusMessage, setStatusMessage] = useState<StatusMessageState | null>(null);
  const [sendMailSuccess, setSendMailSuccess] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false); // State to track input focus

  const validationSchema = Yup.object({
    email: Yup.string()
      .email(translations.Inputs.InvalidEmailAddress)
      .matches(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, translations.Inputs.InvalidEmailAddress)
      .required(translations.Inputs.Required),
  });

  const formik = useFormik({
    initialValues: { email: "" },
    validationSchema,
    onSubmit: async (values) => {
      const response = await LoginService.getInstance().requestPasswordReset(values);
      if (isString(response)) {
        setStatusMessage({ message: response, isError: true });
      } else {
        if (response.message === "If this email is registered, a reset link has been sent.") {
          setStatusMessage({ message: translations.ResetPasswordRequest.UserNotFound, isError: true });
        } else {
          setSendMailSuccess(true);
          setStatusMessage({ message: translations.ResetPasswordRequest.EmailSent, isError: false });
        }
      }
    },
  });

  return (
    <form onSubmit={formik.handleSubmit} className="px-4 d-flex flex-column align-items-center">
      <div className="height-20-18rem py-4">
        <p
          className="text-center"
          dangerouslySetInnerHTML={{
            __html: isFirstPasswordInitialization
              ? translations.InitializePasswordModal.Subtitle
              : translations.ResetPasswordRequest.Subtitle,
          }}
        ></p>
        <div className="max-width-20rem m-auto">
          <div className="form-group mb-5 height-6-6rem">
            <TextInput
              label={translations.Inputs.EmailLabel}
              name="email"
              type="email"
              required
              placeholder={translations.Inputs.EmailPlaceholder}
              value={formik.values.email}
              onChange={formik.handleChange}
              onBlur={() => {
                formik.handleBlur("email");
                setIsInputFocused(false); // Update focus state
              }}
              onFocus={() => {
                setIsInputFocused(true);
                setSendMailSuccess(false);
              }
            } // Update focus state
              error={formik.touched.email ? formik.errors.email : undefined}
            />
          </div>
          <StatusMessage
            message={statusMessage?.message || ""}
            isError={statusMessage?.isError}
            className="text-center"
          />
        </div>
      </div>
      {(!sendMailSuccess || isInputFocused) && ( // Updated condition
        <div className="height-8-25rem max-width-20rem w-100 d-flex flex-column justify-content-center text-center align-items-center">
          <Button
            className="w-100 bg-color-purple w-75 pt-2 pb-2 fs-6 rounded-pill"
            type="submit"
          >
            {isFirstPasswordInitialization
              ? translations.InitializePasswordModal.Button
              : translations.ResetPasswordRequest.Button}
          </Button>
          <Button
            className="font-RubikBold bg-color-white text-color-dark-green text-decoration-underline fw-bold border border-0 mb-2"
            onClick={onRegisterButtonClicked}
          >
            {translations.Login.GoToRegisterButton}
          </Button>
        </div>
      )}
    </form>
  );
};

export default ResetPasswordRequest;

