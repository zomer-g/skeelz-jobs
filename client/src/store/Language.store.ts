import { create } from 'zustand';
import { Language } from '../i18n/General.enums';

type LanguageStore = {
  currentLanguage: Language;
  toggleLanguage: () => void;
  translations: Record<string, string>; // Store translations here
};

const useLanguageStore = create<LanguageStore>((set) => ({
  currentLanguage: Language.HEBREW, // Default to Hebrew
  toggleLanguage: () => {
    set((state) => ({
      currentLanguage: state.currentLanguage === Language.HEBREW ? Language.ENGLISH : Language.HEBREW,
    }));
  },
  translations: {}, // Initialize translations as an empty object
}));

export default useLanguageStore;

// Export the store object directly for use in i18n.tsx
export const languageStore = useLanguageStore;