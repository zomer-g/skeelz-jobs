import { useState } from "react";
import useModalStore from "../../store/Modal.store";
import UploadFileArea from "./UploadFileArea";
import Button from "./Button";
import { i18n } from "../../i18n/I18n";


interface UploadCvContentProps {
  userId: string;
  index: number;
  uploadFile: (userId: string, cvFilePath: string) => Promise<string | void>;
  onUpdateUser?: (index: number, userId: string, cvFilePath: string) => void;
}

export const UploadFileModal: React.FC<UploadCvContentProps> = ({ userId, index, uploadFile, onUpdateUser }) => {
  const [cvFilePath, setCvFilePath] = useState('');
  const { initModal } = useModalStore();
  const translations = i18n.getTranslations();


  const handleCvFilePath = (filePath: string) => {
    setCvFilePath(filePath);
  };

  return (
    <div>
      <div className='d-flex justify-content-center flex-column align-items-center text-center'>
        <div className='height-27rem xs-h-15rem align-content-center w-100 px-3'>
          <UploadFileArea onFilePathChange={handleCvFilePath} />
        </div>
      </div>
      <div className='height-8rem custom-border-top text-center'>
        <Button
          disabled={!cvFilePath}
          className="bg-color-purple-btn font-RubikMedium w-320px py-4 rounded-pill m-auto mt-4"
          onClick={async () => {
            await uploadFile(userId, cvFilePath);

            onUpdateUser && onUpdateUser(
              index,
              userId,
              cvFilePath,
            );

            initModal({ active: false });
          }}
        >
          {translations.General.Save}
        </Button>
      </div>
    </div>
  );
};
