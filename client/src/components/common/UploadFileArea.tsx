import React, { useState, useRef, forwardRef, useEffect } from "react";
import CircularLoader from "./CircularLoader";
import { UploadFileService } from "../../services/api/UploadFile.service";
import { generateToken, isEnglishString, isString } from "../../utils/utils";
import { CheckCircleIcon, CrossIcon, DocFileIcon, FileIcon, PdfFileIcon, RedCircleIcon, UploadFilesIcon } from "../../icons";
import useToastStore from "../../store/Toast.store";
import { AllowedFileTypes, Colors } from "../../i18n/General.enums";
import { i18n } from "../../i18n/I18n";

interface UploadFileAreaProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  placeholder?: string;
  className?: string;
  error?: string | null;
  iconColor?: string;
  fileInside?: boolean;
  fileConfirm?: boolean;
  onFilePathChange?: (value: string) => void;
}

const UploadFileArea = forwardRef<HTMLInputElement, UploadFileAreaProps>(
  ({ label, placeholder, className = "", error, iconColor, fileInside, onFilePathChange, ...props }, ref) => {
    const [file, setFile] = useState<File | null>(null);
    const [dragging, setDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement | null>(null); // Ref to file input
    const [fileSize, setFileSize] = useState<number | null>(null);
    const [fileType, setFileType] = useState('');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [fileUploaded, setfileUploaded] = useState(false);
    const [cvFilePath,setCvFilePath] = useState('')
    const { showToast } = useToastStore();
    const allowedTypes: string[] = Object.values(AllowedFileTypes);
    const translations = i18n.getTranslations();

    useEffect(() => {
      if (fileSize !== null && fileSize > 5000) {
        setErrorMessage(translations.Cv.MaxFileSize)
      } else if (fileType && !allowedTypes.includes(fileType) || '') {
        setErrorMessage(translations.Cv.SupportedFormats)
      } else {
        if(file){
          if(!validateFileName(file.name)){
            return;
          }
        }
        setfileUploaded(false)
        setErrorMessage('')
        uploadFile();
      }
    }, [file])


    const validateFileName = (fileName: string) => {
      const maxLength = 50;
      const allowedPattern = /^[\u0590-\u05FFa-zA-Z0-9 _.-]+$/;
    
      if (fileName.length > maxLength) {
        setErrorMessage(translations.Cv.FileNameTooLong)
        return false;
      }
    
      if (!allowedPattern.test(fileName)) {
        setErrorMessage(translations.Cv.fileNameInvalidCharacters)
        return false;
      }
      return true;
    };

    const sanitizeFileName = (fileName: string): string => {
      const isEnglish = isEnglishString(fileName);
      let sanitizedFileName =  isEnglish ? fileName.toLowerCase() : fileName;
      sanitizedFileName = sanitizedFileName.replace(/ /g, "_");
      return sanitizedFileName;
    };

    const uploadFile = async () => {
      if (file !== null) {
        const token = generateToken();
        const formData = new FormData();
        formData.append("file", file);
        const headers: Record<string, string> = { "Content-Type": "multipart/form-data" };

        const result = await UploadFileService.getInstance().uploadCV(token, formData, headers);
        if (!isString(result)) {
          const sanitizedFileName = sanitizeFileName(file.name)
          const filePath = token + "/" + sanitizedFileName;
          onFilePathChange?.(filePath);
          setfileUploaded(true);
          setCvFilePath(filePath)
        } else {
          showToast(translations.Cv.CvFileUploadFailed, 'error');
          setErrorMessage(translations.Cv.UploadError)
        }
      }
    };

    async function deleteFileFromBucket() {
            try {
              if(!errorMessage){
                const result = await UploadFileService.getInstance().deleteCV(cvFilePath)

                if (!isString(result)) {
                    showToast(translations.Cv.CancelUploadFile, "success");
                } else {
                    showToast(translations.Cv.DeleteFileFailed,'error');
                }
              } 
            } catch (error) {
                if(isString(error)){
                    showToast(translations.Cv.DeleteFileFailed,'error');
                }
            }
        }

    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFile = event.target.files?.[0] || null;
      if (selectedFile) {
        setFileSize(parseFloat((selectedFile.size / 1024).toFixed(2))); // Convert bytes to KB and round to 2 decimal places 
        const fileName = selectedFile.name.toLowerCase();
        const fileType = fileName.split(".").pop() ?? "";
        setFileType(fileType);
      }
      setFile(selectedFile);
    };

    const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
      if(!file || errorMessage){
        event.preventDefault();
        setDragging(true);
      }
    };

    const handleDragLeave = () => {
      setDragging(false);
    };

    const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      if (event.dataTransfer.files.length > 0) {
        setFile(event.dataTransfer.files[0]);
      }
    };

    // Trigger the file input click when the div is clicked
    const handleFileCardClick = () => {
      if(!file || errorMessage){
        if (fileInputRef.current) {
          fileInputRef.current.click();
        }
      }
    };

    const getFileIcon = () => {
      if (!file || typeof file.name !== "string") return <FileIcon className="mt-0 " />;
      if (fileType === "pdf") return <PdfFileIcon className="mt-0 " />;
      if (fileType === "docx") return <DocFileIcon className="mt-0 " />;

      return <FileIcon />;
    };

    const handleRemoveFile = () => {
      deleteFileFromBucket()
      setErrorMessage(null)
      onFilePathChange?.('');
      setFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    };

    return (
      <div
        className={`${className}`}
      >
        <div
          className={`upload-file-card border-dashed-${errorMessage ? "red" : "grey"}  border-radius-8 d-flex justify-content-start align-items-center max-width-41-25rem w-sm-100 cv-frame-height ${dragging && "dragging"}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleFileCardClick}
        >

          <div className={`d-flex align-items-sm-center w-sm-100 ps-3 ps-sm-5 ${file ? '' : 'align-items-center'}`}>
            <div className="pe-sm-1 pe-sm-4 pt-2 ">
              <UploadFilesIcon
                className="attach-file-icon responsive-height-1"
              />
            </div>
            <div className="flex-grow-1 pe-sm-4 text-end w-100 sm-w-32rem">
              <h4 className="mt-2 font-responsive-3 font-RubikBold">{label || translations.Cv.UploadCv}</h4>

              <input
                type="file"
                ref={fileInputRef} // Assign ref to the file input
                className="d-none"
                onChange={handleFileChange}
                {...props}
              />

              {fileInside || file ? (
                <div className="ms-2 border-top border-black">
                  <div className="height-2-5rem my-1 my-sm-3 px-2 d-flex justify-content-between align-items-center w-sm-100 bg-color-light-grey rounded ">
                    <div className="d-block d-sm-none">
                      {getFileIcon()}
                    </div>
                    <div className={`d-flex ms-auto me-2 ${errorMessage ? 'flex-column flex-sm-row' : 'align-items-center'}`}>
                      <div className="d-flex align-items-center width-2rem w-responsive-2 height-1rem">
                        <div className="d-none d-sm-block">
                          {getFileIcon()}
                        </div>
                        <h5 className="px-sm-2 text-color-dark-grey-B pt-2 pt-sm-3 pb-sm-2 font-RubikRegular fs-0-875rem text-truncate">{file?.name || translations.Cv.FileInside}</h5>
                      </div>
                      {
                        errorMessage &&
                        <>
                          <span className="text-color-red font-RubikMedium fs-14 m-auto d-none d-md-block ">{errorMessage}</span>
                          <span className="text-color-red font-RubikMedium fs-12 m-auto d-block d-md-none text-truncate w-responsive-2">{translations.Cv.UploadError}</span> {/* just for mobile */}
                        </>
                      }
                    </div>

                    <div className="d-flex justify-content-center align-items-center">
                      {fileSize !== null && <span className="font-RubikRegular text-color-dark-grey-B px-1 px-2 fs-12">{fileSize}KB</span>}
                      {errorMessage ? <RedCircleIcon size={25} /> : (fileUploaded || fileInside) ? <CheckCircleIcon size={20} color="#228B22" /> : <CircularLoader size={18} color="success" />}
                      <CrossIcon size={24} className="my-1" onClick={handleRemoveFile} />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-muted font-RubikRegular pb-2">
                  {placeholder || (
                    <>
                      <div className="d-none d-sm-block">
                        <span className="font-responsive-1">{translations.Cv.DragAndDrop} <u>{translations.Cv.ChooseFile}</u></span>
                      </div>
                      <span className="font-responsive-1  d-block">{translations.Cv.MaxFileSize}</span>
                      <span className="font-responsive-1 ">{translations.Cv.SupportedFormats}</span>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        {error && <span className="text-danger px-2 py-1">{error}</span>}
      </div>
    );
  }
);

export default UploadFileArea;
