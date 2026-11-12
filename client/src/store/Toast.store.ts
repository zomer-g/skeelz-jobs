import { create } from 'zustand';

export type ToastStore = {
  isVisible: boolean;
  severity: 'success' | 'error' | 'info' | 'warning';
  message: string;
  showToast: (message: string, severity: ToastStore['severity']) => void;
  closeToast: () => void;
  showSuccessToast: () => void;
  showErrorToast: () => void;
};

const useToastStore = create<ToastStore>((set) => ({
  isVisible: false,
  severity: 'info',
  message: '',

  // General method to display a toast
  showToast: (message, severity) => {
    set({
      isVisible: true,
      message,
      severity,
    });
  },

  // Method to close the toast
  closeToast: () => {
    set({ isVisible: false });
  },

  // Predefined success toast
  showSuccessToast: () => {
    set({
      isVisible: true,
      severity: 'success',
    });
  },

  // Predefined error toast
  showErrorToast: () => {
    set({
      isVisible: true,
      severity: 'error',
    });
  },
}));

export default useToastStore;
