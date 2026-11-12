import React, { useEffect, useState } from "react";
import { Form, Formik} from "formik";
import * as Yup from "yup";
import { LoginService, SignInProviders } from "../../services/api/Login.service";
import { isString } from "../../utils/utils";
import { applyContextParams, track } from "../../utils/analytics";
import StatusMessage from "../common/StatusMessage";
import useToastStore from "../../store/Toast.store";
import { i18n } from "../../i18n/I18n";
import useAuthStore from "../../store/Auth.store";
import Button from "../common/Button";
import TextInput from "../common/TextInput";
import SignInOptions from "./SignInOptions";

interface LoginFormValues {
  email: string;
  password: string;
}

interface LoginModalProps {
  onForgotPasswordClick: () => void;
  onRegisterButtonClicked: () => void;
  onSuccess: () => void;
}

const LoginModal: React.FC<LoginModalProps> = ({ onForgotPasswordClick, onSuccess, onRegisterButtonClicked }) => {
  const translations = i18n.getTranslations();
  const [error, setError] = useState<string>('');
  const setUser = useAuthStore.getState().setUser;
  const { showToast } = useToastStore();
  // "Continue with Google" (xhostd SSO) on → it is the main option at the top, and email + password / sign-up
  // follow for people without a Google account. Off → the password form alone, as before.
  const [providers, setProviders] = useState<SignInProviders | null>(null);
  useEffect(() => {
    let alive = true;
    LoginService.getInstance().getProviders().then((p) => { if (alive) setProviders(p); });
    return () => { alive = false; };
  }, []);
  const sso = !!providers?.sso;

  const validationSchema = Yup.object({
    email: Yup.string()
      .email(translations.Inputs.InvalidEmailAddress)
      .matches(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, translations.Inputs.InvalidEmailAddress)
      .required(translations.Inputs.DontForgetToEnterEmail),
    password: Yup.string()
      .min(6, translations.PasswordRequirements.MinLength)
      .required(translations.Inputs.DontForgetToEnterPassword),
  });

  const initialValues: LoginFormValues = { email: '', password: '' };

  const loginUser = async (values: LoginFormValues) => {
    const response = await LoginService.getInstance().login(values);
    if (isString(response)) {
      setError(response);
    } else {
      response.user = {
        ...response.user, // Spread existing properties of user
        jobApplicationsId: response.jobApplicationsId, // Add jobApplications to user
      };
      showToast(translations.Login.LoginSuccess, 'success');
      setUser(response.user);
      track('login', { method: 'email', ...applyContextParams() });
      onSuccess();
    }
  };

  return (
    <div className="pb-4">
      {sso && (
        <>
          <SignInOptions />
          {/* The second option: for people without a Google / Gmail account. Visible, not hidden behind a toggle. */}
          <div className="d-flex align-items-center justify-content-center gap-3 pt-3 mx-auto w-320px" aria-hidden="true">
            <hr className="flex-grow-1 m-0" />
            <span className="text-muted font-RubikRegular">{translations.SignIn.Or}</span>
            <hr className="flex-grow-1 m-0" />
          </div>
          <h2 id="no-google-account" className="font-RubikMedium fs-6 text-center text-color-dark-grey pt-2 mb-0 px-3">
            {translations.SignIn.NoGoogleAccount}
          </h2>
        </>
      )}
      <section aria-labelledby={sso ? 'no-google-account' : undefined}>
      <Formik
        initialValues={initialValues}
        validationSchema={validationSchema}
        onSubmit={loginUser}
      >
        {({ handleSubmit, values, handleChange, handleBlur, errors, touched }) => (
          <Form onSubmit={handleSubmit} className="pt-2">
            {/* Email Input */}
            <div className="row height-16rem justify-content-center">
              <div className="pt-3 w-320px height-6-6rem">
                <TextInput
                  required
                  label={translations.Register.EmailAddress}
                  type="email"
                  name="email"
                  placeholder={translations.Register.EmailAddress}
                  value={values.email}
                  onChange={handleChange}
                  onBlur={handleBlur}
                  error={errors.email}
                />
              </div>

              {/* Password Input */}
              <div className=" w-320px height-6-6rem">
                <TextInput
                  required
                  label={translations.Register.Password}
                  name="password"
                  type="password"
                  placeholder={translations.Register.Password}
                  value={values.password}
                  onChange={handleChange}
                  onBlur={handleBlur}
                  error={errors.password}
                />

                <Button
                  className="font-RubikBold text-decoration-underline text-color-dark-green mx-1 pb-2"
                  onClick={onForgotPasswordClick}  // Opens Reset Password modal
                >
                  <div>
                    <span>{translations.Login.ForgotPassword}</span>
                  </div>
                </Button>
              </div>
            </div>

            {/* Error Message */}
      
            
            {/* Submit Button */}
            <div className="height-2-75rem">
              <StatusMessage message={error} isError className="font-RubikMedium font-responsive-3 text-center" />
              </div>
            <div className="d-flex justify-content-center pb-3">
              <Button
                type="submit"
                className={sso
                  // secondary next to "Continue with Google"
                  ? "bg-white border border-2 font-RubikMedium fw-500 btn-h w-320px py-3 rounded-pill d-flex align-items-center justify-content-center"
                  : "bg-color-purple-btn font-RubikMedium w-320px py-3 py-sm-4 rounded-pill"}
                customStyle={sso}
                style={sso ? { color: '#cd0077', borderColor: '#cd0077' } : undefined}
              >
                {translations.Login.Login}
              </Button>
            </div>
          </Form>
        )}
      </Formik>

      {/* Register Button */}
      <div className="d-flex justify-content-center">
        <Button
          className="font-RubikBold text-color-dark-green-2 fw-bold w-320px py-3 py-sm-4 border-color-dark-green-2-2px border border-3"


          onClick={onRegisterButtonClicked}
        >
          {translations.Login.NewUser}
        </Button>
      </div>
      </section>
    </div>
  );
};

export default LoginModal;