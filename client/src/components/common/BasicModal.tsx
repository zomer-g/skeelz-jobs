import React, { ReactNode, useEffect, useState } from 'react';
import { modalStore } from '../../store/Modal.store';
import { modalStyleSetting } from '../../models/types/modal.types';
import { i18n } from '../../i18n/I18n';
import Button from './Button';
import { CloseIcon } from '../../icons';

interface BasicModalProps {
  initialTitle?: string;
  initialBody?: ReactNode;
  initialFooter?: ReactNode;
  initialModalStyle?: modalStyleSetting;
  initialActive?: boolean;
}

const BasicModal: React.FC<BasicModalProps> = ({
  initialTitle,
  initialBody,
  initialFooter,
  initialModalStyle,
  initialActive,
}) => {
  const [isClient, setIsClient] = useState(false);
  const isRTL = i18n.isRTL();
  const {
    active: storeActive,
    modalTitle,
    modalBody,
    modalFooter,
    modalStyle: storeModalStyle,
    initModal,
    onClose,
  } = modalStore();

  useEffect(() => {
    setIsClient(true);
  }, []);

  // Use initial props during SSR, fallback to Zustand state on client
  const finalTitle = !isClient && initialTitle ? initialTitle : modalTitle;
  const finalBody = !isClient && initialBody ? initialBody : modalBody;
  const finalFooter = !isClient && initialFooter ? initialFooter : modalFooter;
  const finalModalStyle = !isClient && initialModalStyle ? initialModalStyle : storeModalStyle;
  const showModal = !isClient && initialActive ? initialActive : storeActive;

  const handleClose = () => {
    initModal({ active: false });
    if (onClose) onClose();
  };

  // Simplified structure for SSR
  if (!isClient) {
    return (
      <span>
        {finalTitle ? <h1 className={finalModalStyle?.titleTypography?.titleClass || ''}>{finalTitle}</h1> : null}
        <div>{finalBody}</div>
        <div>{finalFooter}</div>
      </span>
    );
  }

  if (!showModal) {
    return null;
  }

  const modalDirection = isRTL ? 'direction_rtl' : 'direction_ltr';

  return (
    <>
      <div
        className={`modal fade show d-block ${modalDirection} ${finalModalStyle?.modalClass || ''}`}
        tabIndex={-1}
        role="dialog"
      >
        <div
          className={`modal-dialog xs-modal-dialog w-100 modal-dialog-centered   ${finalModalStyle?.dialogClassName || ''}`} // New dialog class
          role="document"
        >
          <div className="modal-content border-0 border-radius-30 overflow-hidden">
            {finalTitle && (
              <div className={`modal-header height-5-625rem xs-h-4rem d-flex justify-content-center text-center border-black ${finalModalStyle?.headerClass}`}>
                <h2 className={`modal-title w-100 text-center font-EzerRegularLoft ${finalModalStyle?.titleClass}  custom-jb-font-size`}>{finalTitle}</h2>
                <Button
                  iconOnlyStyle
                  className='px-2'
                  onClick={handleClose}
                >
                  <CloseIcon color={finalModalStyle?.closeButtonColor || 'black'}/>
                </Button>
              </div>
            )}

            <div className={`modal-body ${finalModalStyle?.bodyClass || ''}`}>
              {finalBody}
            </div>

            {finalFooter && (
              <div className={`modal-footer height-5-625rem border-black ${finalModalStyle?.footerClass || ''}`}>
                {finalFooter}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="modal-backdrop fade show" onClick={handleClose} role="presentation"></div>
    </>
  );
};

export default BasicModal;
