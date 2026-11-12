import { Language, LocalizedDataKey } from './General.enums';
import { localizedData } from './localizedData';

// Generalized function to retrieve localized content by dataset key and language
export const getLocalizedOptions = (
  datasetKey: keyof typeof localizedData,
  lang: 'en' | 'he'
) => {
  const data = localizedData[datasetKey];

  return (Object.keys(data) as Array<keyof typeof data>).map(key => ({
    value: key,
    label: data[key][lang],
  }));
};

/**
 * Returns a dictionary mapping keys to their localized labels
 * @param datasetKey - The key for the dataset (e.g., DEGREE_TYPES, FILE_TYPES)
 * @param lang - The target language ('en' or 'he')
 * @returns A dictionary where keys are dataset keys and values are localized strings
 */
export const getLocalizedDictionary = (
  datasetKey: LocalizedDataKey,
  lang: Language
): Record<string, string> => {
  const data = localizedData[datasetKey];

  return Object.keys(data).reduce((dict, key) => {
    dict[key] = data[key][lang];
    return dict;
  }, {} as Record<string, string>);
};
