import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { i18n } from "../../i18n/I18n";
import { AllowedFileTypes, Language } from "../../i18n/General.enums";
import { UploadFileService } from "../../services/api/UploadFile.service";
import { JobService } from "../../services/api/Job.service";
import { ApplyCvChoice, ApplyJobResponse } from "../../models/interfaces/Api.interfaces";
import { generateToken, isEnglishString, isString } from "../../utils/utils";
import { languageStore } from "../../store/Language.store";
import Button from "../common/Button";
import { errorCode, track, trackOnce } from "../../utils/analytics";
import { fileTypeOf } from "../../utils/analyticsPolicy";

/*
 * Apply step for a signed-in candidate (rendered inside the global modal):
 *  1. shows the CV on their profile and asks "apply with this CV, or update it?"
 *     (no CV on file -> asks to upload one)
 *  2. after an upload: "update my profile CV" or "use it only for this job"
 *  3. sends the application with that choice (server: services/applicationCv.ts)
 *
 * Accessibility: the surrounding dialog gets aria-modal + a label, Tab/Shift+Tab
 * stay inside it, Escape cancels, focus moves to each step's heading and goes
 * back to the element that opened it.
 */

// Same rules as the existing upload areas and the server (fileTypeCheckMiddleware, 5 MB).
const MAX_FILE_KB = 5000;
const MAX_NAME_LENGTH = 50;
const NAME_PATTERN = /^[֐-׿a-zA-Z0-9 _.-]+$/;
const ALLOWED_TYPES: string[] = Object.values(AllowedFileTypes);

const sanitizeFileName = (fileName: string) =>
  (isEnglishString(fileName) ? fileName.toLowerCase() : fileName).replace(/ /g, "_");

type Step = "loading" | "current" | "upload";
type Scope = "replaceProfile" | "jobOnly";
type ProfileCv = { fileName: string; uploadedAt: string | null } | null;

interface ApplyWithCvDialogProps {
  jobId: string;
  onApplied: (result: ApplyJobResponse) => void;
  onCancel: () => void;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const ApplyWithCvDialog: React.FC<ApplyWithCvDialogProps> = ({ jobId, onApplied, onCancel }) => {
  const t = i18n.getTranslations();
  const tr = t.ApplyCv;
  const isHebrew = languageStore.getState().currentLanguage === Language.HEBREW;
  const ids = useId();
  const titleId = `${ids}-title`;
  const fileInputId = `${ids}-file`;
  const fileHintId = `${ids}-file-hint`;

  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("loading");
  const [profileCv, setProfileCv] = useState<ProfileCv>(null);
  const [loadError, setLoadError] = useState(false);
  const [uploadedPath, setUploadedPath] = useState("");
  const [uploadedName, setUploadedName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [fileError, setFileError] = useState("");
  const [scope, setScope] = useState<Scope | "">("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  // An upload that ended up unused is cancelled when the dialog goes away.
  const pendingUpload = useRef("");
  const applied = useRef(false);

  // --- dialog semantics, focus trap, Escape -----------------------------------
  const cancel = useCallback(() => {
    if (!submitting) onCancel();
  }, [onCancel, submitting]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const dialog = rootRef.current?.closest('[role="dialog"]') as HTMLElement | null;
    const previous = dialog ? { modal: dialog.getAttribute("aria-modal"), label: dialog.getAttribute("aria-labelledby") } : null;
    if (dialog) {
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", titleId);
    }
    return () => {
      if (dialog && previous) {
        previous.modal === null ? dialog.removeAttribute("aria-modal") : dialog.setAttribute("aria-modal", previous.modal);
        previous.label === null ? dialog.removeAttribute("aria-labelledby") : dialog.setAttribute("aria-labelledby", previous.label);
      }
      if (pendingUpload.current && !applied.current) {
        void UploadFileService.getInstance().deleteCV(pendingUpload.current);
      }
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [titleId]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const container = (rootRef.current?.closest(".modal-content") as HTMLElement | null) ?? rootRef.current;
      if (!container) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !container.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === headingRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [cancel]);

  // Each step starts with its heading focused, so screen readers announce it.
  useEffect(() => {
    headingRef.current?.focus();
    if (step !== "loading") trackOnce(`apply_form_shown:${jobId}`, "apply_form_shown", { job_id: jobId, apply_type: "registered", cv_required: false });
  }, [step]);

  // --- data --------------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    (async () => {
      const result = await UploadFileService.getInstance().fetchMyCvInfo();
      if (!alive) return;
      if (isString(result)) {
        setLoadError(true);
        setStep("upload");
        return;
      }
      setProfileCv(result.cv);
      setStep(result.cv ? "current" : "upload");
    })();
    return () => { alive = false; };
  }, []);

  const formatDate = (iso: string | null) => {
    if (!iso) return tr.UploadDateUnknown;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return tr.UploadDateUnknown;
    return new Intl.DateTimeFormat(isHebrew ? "he-IL" : "en-GB", { day: "numeric", month: "long", year: "numeric" }).format(d);
  };

  const viewProfileCv = async () => {
    const result = await UploadFileService.getInstance().fetchMyCvFile();
    if (isString(result)) {
      setSubmitError(t.Cv.CouldNotPreviewFile);
      return;
    }
    const contentType = String(result.headers["content-type"] || "application/octet-stream");
    const url = window.URL.createObjectURL(new Blob([result.data], { type: contentType }));
    if (contentType === "application/pdf") {
      window.open(url, "_blank", "noopener");
    } else {
      const a = document.createElement("a");
      a.href = url;
      a.download = profileCv?.fileName || "cv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
    setTimeout(() => window.URL.revokeObjectURL(url), 10000);
  };

  const discardUpload = async () => {
    const path = pendingUpload.current;
    pendingUpload.current = "";
    setUploadedPath("");
    setUploadedName("");
    setScope("");
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (path) await UploadFileService.getInstance().deleteCV(path);
  };

  const onFileChosen = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setFileError("");
    setSubmitError("");
    if (!file) return;
    if (pendingUpload.current) await discardUpload();
    const ext = file.name.toLowerCase().split(".").pop() ?? "";
    const uploadError = (code: string, message: string) => {
      track("cv_upload_error", { job_id: jobId, apply_type: "registered", error_code: code });
      setFileError(message);
    };
    if (!ALLOWED_TYPES.includes(ext)) return uploadError("UNSUPPORTED_TYPE", t.Cv.SupportedFormats);
    if (file.size / 1024 > MAX_FILE_KB) return uploadError("FILE_TOO_LARGE", t.Cv.MaxFileSize);
    if (file.name.length > MAX_NAME_LENGTH) return uploadError("FILE_NAME_TOO_LONG", t.Cv.FileNameTooLong);
    if (!NAME_PATTERN.test(file.name)) return uploadError("FILE_NAME_INVALID", t.Cv.fileNameInvalidCharacters);

    setUploading(true);
    const token = generateToken();
    const formData = new FormData();
    formData.append("file", file);
    const result = await UploadFileService.getInstance().uploadCV(token, formData, { "Content-Type": "multipart/form-data" });
    setUploading(false);
    if (isString(result)) {
      track("cv_upload_error", { job_id: jobId, apply_type: "registered", error_code: "UPLOAD_FAILED" });
      setFileError(t.Cv.UploadError);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    const path = `${token}/${sanitizeFileName(file.name)}`;
    pendingUpload.current = path;
    track("cv_upload", { job_id: jobId, apply_type: "registered", file_type: fileTypeOf(file.name), file_size_kb: Math.round(file.size / 1024) });
    setUploadedPath(path);
    setUploadedName(file.name);
  };

  const submit = async (choice: ApplyCvChoice) => {
    // keep = profile CV as is; none = no CV on file and applied without one.
    const cvChoice = choice.mode === "replaceProfile" ? "replace" : choice.mode === "jobOnly" ? "job_only" : profileCv ? "keep" : "none";
    const ev = { job_id: jobId, apply_type: "registered", cv_choice: cvChoice } as const;
    track("apply_cv_choice", ev);
    track("apply_submit", ev);
    setSubmitting(true);
    setSubmitError("");
    const result = await JobService.getInstance().applyJob(jobId, choice);
    setSubmitting(false);
    if (isString(result)) {
      track("apply_error", { job_id: jobId, apply_type: "registered", error_code: errorCode(result) });
      setSubmitError(tr.ApplyFailed);
      return;
    }
    track("apply_success", ev);
    applied.current = true;
    onApplied(result);
  };

  const submitUpload = () => {
    if (!uploadedPath) return setFileError(tr.UploadFirst);
    if (!scope) return;
    void submit({ mode: scope, cvFilePath: uploadedPath });
  };

  // --- view --------------------------------------------------------------------
  const heading = (text: string) => (
    <h2 id={titleId} ref={headingRef} tabIndex={-1} className="font-RubikBold fs-5 mb-2 text-center outline-none">
      {text}
    </h2>
  );

  return (
    <div ref={rootRef} className="w-100 d-flex flex-column gap-3 p-2" aria-busy={step === "loading" || submitting}>
      {step === "loading" && (
        <>
          {heading(tr.Title)}
          <p role="status" className="font-RubikRegular text-center m-0">{tr.Loading}</p>
        </>
      )}

      {step === "current" && profileCv && (
        <>
          {heading(tr.ApplyWithThisOrUpdate)}
          <p className="font-RubikRegular text-color-dark-grey text-center m-0">{tr.ReviewRequirements}</p>
          <section aria-label={tr.CurrentCvHeading} className="border border-radius-8 p-3 bg-color-light-grey">
            <div className="font-RubikMedium fs-14 text-color-dark-grey mb-1">{tr.CurrentCvHeading}</div>
            <div className="font-RubikBold text-break" dir="auto">{profileCv.fileName}</div>
            <div className="font-RubikRegular fs-14">
              {profileCv.uploadedAt ? `${tr.UploadedOn} ` : ""}
              <time dateTime={profileCv.uploadedAt ?? undefined}>{formatDate(profileCv.uploadedAt)}</time>
            </div>
            <button type="button" className="btn btn-link p-0 mt-1 font-RubikMedium text-color-purple" onClick={viewProfileCv}>
              {tr.ViewCv}
              <span className="visually-hidden">: {profileCv.fileName}</span>
            </button>
          </section>
          <div className="d-flex justify-content-between gap-3">
            <Button className="font-RubikMedium bg-color-dark-green-2 flex-grow-1" onClick={() => submit({ mode: "profile" })} disabled={submitting}>
              {submitting ? tr.Submitting : tr.ApplyWithThisCv}
            </Button>
            <Button className="font-RubikMedium text-color-dark-green-2 flex-grow-1" onClick={() => { setSubmitError(""); setStep("upload"); }} disabled={submitting}>
              {tr.UpdateCv}
            </Button>
          </div>
          <button type="button" className="btn btn-link p-0 font-RubikRegular fs-14 align-self-center" onClick={cancel} disabled={submitting}>
            {tr.Cancel}
          </button>
        </>
      )}

      {step === "upload" && (
        <>
          {heading(profileCv ? tr.UploadHeading : tr.Title)}
          {!profileCv && (
            <p className="font-RubikRegular text-center m-0">{loadError ? tr.LoadFailed : tr.NoCvOnFile}</p>
          )}
          <p className="font-RubikRegular text-color-dark-grey text-center m-0">{tr.ReviewRequirements}</p>

          <div>
            <label htmlFor={fileInputId} className="form-label font-RubikMedium mb-1">{t.Cv.UploadCv}</label>
            <input
              id={fileInputId}
              ref={fileInputRef}
              type="file"
              className="form-control"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              aria-describedby={fileHintId}
              aria-invalid={!!fileError}
              onChange={onFileChosen}
              disabled={uploading || submitting}
            />
            <div id={fileHintId} className="font-RubikRegular fs-14 text-color-dark-grey mt-1">
              {t.Cv.MaxFileSize} · {t.Cv.SupportedFormats}
            </div>
            <div aria-live="polite" className="fs-14 mt-1">
              {uploading && <span>{t.Cv.UploadCv}…</span>}
              {!uploading && uploadedPath && <span className="text-success font-RubikMedium" dir="auto">✓ {uploadedName}</span>}
            </div>
            {fileError && <div role="alert" className="text-danger fs-14 mt-1">{fileError}</div>}
          </div>

          {uploadedPath && (
            <fieldset className="border-0 p-0 m-0">
              <legend className="font-RubikBold fs-6 mb-2">{tr.UseHowQuestion}</legend>
              {([
                ["replaceProfile", tr.ReplaceProfileCv, tr.ReplaceProfileCvHint],
                ["jobOnly", tr.JobOnlyCv, tr.JobOnlyCvHint],
              ] as const).map(([value, label, hint]) => (
                <div className="form-check mb-2" key={value}>
                  <input
                    className="form-check-input float-none mx-1"
                    type="radio"
                    name={`${ids}-scope`}
                    id={`${ids}-${value}`}
                    value={value}
                    checked={scope === value}
                    onChange={() => setScope(value)}
                    aria-describedby={`${ids}-${value}-hint`}
                  />
                  <label className="form-check-label font-RubikMedium" htmlFor={`${ids}-${value}`}>{label}</label>
                  <div id={`${ids}-${value}-hint`} className="fs-14 text-color-dark-grey ms-4 me-4">{hint}</div>
                </div>
              ))}
            </fieldset>
          )}

          <div className="d-flex justify-content-between gap-3">
            <Button
              className="font-RubikMedium bg-color-dark-green-2 flex-grow-1"
              onClick={submitUpload}
              disabled={!uploadedPath || !scope || uploading || submitting}
            >
              {submitting ? tr.Submitting : tr.Submit}
            </Button>
            <Button
              className="font-RubikMedium text-color-dark-green-2 flex-grow-1"
              onClick={async () => {
                if (profileCv) {
                  await discardUpload();
                  setFileError("");
                  setStep("current");
                } else {
                  cancel();
                }
              }}
              disabled={submitting}
            >
              {profileCv ? tr.Back : tr.Cancel}
            </Button>
          </div>
          {!profileCv && !uploadedPath && (
            <button type="button" className="btn btn-link p-0 font-RubikRegular fs-14 align-self-center" onClick={() => submit({ mode: "profile" })} disabled={submitting}>
              {tr.ApplyWithoutCv}
            </button>
          )}
        </>
      )}

      {submitError && <div role="alert" className="text-danger text-center fs-14">{submitError}</div>}
    </div>
  );
};

export default ApplyWithCvDialog;
