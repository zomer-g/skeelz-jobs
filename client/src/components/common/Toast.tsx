						  
import { Alert, AlertColor, IconButton, Snackbar } from "@mui/material";
import { i18n } from "../../i18n/I18n";									  
import { AlertTriangleIcon, CheckmarkIcon, CloseIcon, XContainedIcon } from "../../icons";
									   

interface ToastProps {
  open: boolean;
  message?: string;
  severity?: AlertColor; // "success", "error", "warning", "info"
  onClose: () => void;
}

const Toast: React.FC<ToastProps> = ({ open, message, severity = 'success', onClose }) => {
  const isRTL = i18n.isRTL();
  const translations = i18n.getTranslations();

  const defaultMessage = severity === 'success' ? translations.ToastMessages.SUCCESS : translations.ToastMessages.ERROR;

  const getIcon = (severity: AlertColor) => {
    switch (severity) {
      case 'success':
        return <CheckmarkIcon />;
      case 'error':
        return <XContainedIcon />;
      case 'warning':
        return <AlertTriangleIcon />;
      case 'info':
        return null;
      default:
        return null;
    }
  };

  const getBackgroundClass = (severity: AlertColor) => {
    switch (severity) {
      case 'success':
        return 'background-successful-b';
      case 'error':
        return 'background-pink';
      case 'warning':
        return 'background-color-orange';
      case 'info':
        return '';
      default:
        return '';
    }
  };

  return (
    <Snackbar
      anchorOrigin={{ vertical: 'bottom', horizontal: isRTL ? 'right' : 'left' }} 
      open={open}
      autoHideDuration={6000}
      onClose={onClose}
      className="toast-snackbar"
    >
      <Alert
        severity={severity}
        className={`toast-alert ${getBackgroundClass(severity)} ${isRTL ? 'custom-toast-rtl' : ''}`}
        action={
          <IconButton
            aria-label="close"
            color="inherit"
            size="small"
            onClick={onClose}
          >
            <CloseIcon />
          </IconButton>
        }
        icon={getIcon(severity)}
      >
        {message || defaultMessage}
      </Alert>
    </Snackbar>
  );
};

export default Toast;
