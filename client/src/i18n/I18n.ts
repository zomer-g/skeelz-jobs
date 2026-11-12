import * as hebrewTranslations from './I18n.he';
import * as englishTranslations from './I18n.eng'; 
import { languageStore } from '../store/Language.store';
import { Language } from './General.enums';

export const i18n = {
  getTranslations: () => {
    const { currentLanguage } = languageStore.getState();

    // Depending on the currentLanguage, return the corresponding translation object
    return currentLanguage === Language.HEBREW ? hebrewTranslations : englishTranslations;
  },
  isRTL: () => {
    const { currentLanguage } = languageStore.getState();
    return currentLanguage === Language.HEBREW ? true : false;
  }
};