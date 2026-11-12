import { useEffect, useState } from "react";
import { DayValues, Option } from "../i18n/General.enums";
import { v4 as uuidv4 } from 'uuid';

export function isString(value: any): value is string {
  return typeof value === 'string';
}

export const generateToken = () => {
  return uuidv4();
};

export const isEnglishString = (text: string): boolean => {
    return /^[A-Za-z0-9 ._\-()]+$/.test(text);
  }

// Utility function to format date from milliseconds to 'YYYY-MM-DD'
export const formatDate = (ms: number): string => {
  const date = new Date(ms);
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }); // Customize format if needed
};

export const stripHtmlTags = (html: string): string => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || div.innerText || '';
};

// Utility function to compare two arrays of options
export const arraysAreEqual = (arr1: Option[], arr2: Option[]): boolean => {
  if (arr1.length !== arr2.length) return false;
  return arr1.every((option, index) => option.value === arr2[index]?.value);
};

export const formatDateToDisplay = (
  dateToDisplay: string | undefined,
  translations: { today: string; yesterday: string; days: string }
): string => {
  if (!dateToDisplay) {
    return '';
  }

  // Case 1: If dateToDisplay is "today"
  if (dateToDisplay === DayValues.TODAY) {
    return translations.today;
  }

  // Case 2: If dateToDisplay is one of the DayValues enums (one to seven days ago)
  const daysPastMapping: { [key in DayValues]?: number } = {
    [DayValues.ONE]: 1,
    [DayValues.TWO]: 2,
    [DayValues.THREE]: 3,
    [DayValues.FOUR]: 4,
    [DayValues.FIVE]: 5,
    [DayValues.SIX]: 6,
    [DayValues.SEVEN]: 7,
  };

  if (daysPastMapping[dateToDisplay as DayValues] !== undefined) {
    const daysPast = daysPastMapping[dateToDisplay as DayValues];
    if (daysPast === 1) {
      return translations.yesterday;
    }
    return `${daysPast} ${translations.days}`;
  }

  // Case 3: If dateToDisplay is an ISO 8601 date
  try {
    const date = new Date(dateToDisplay);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    // Check if the date is today
    if (
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() &&
      date.getDate() === today.getDate()
    ) {
      return translations.today;
    }

    // Check if the date is yesterday
    if (
      date.getFullYear() === yesterday.getFullYear() &&
      date.getMonth() === yesterday.getMonth() &&
      date.getDate() === yesterday.getDate()
    ) {
      return translations.yesterday;
    }

    // Format as DD/MM/YY
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
    const year = String(date.getFullYear()).slice(-2); // Get last two digits of the year
    return `${day}/${month}/${year}`;
  } catch {
    // Fallback for invalid dates
    return dateToDisplay;
  }
};


export const extractTextFromHTML = (htmlString: string): string => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');
  const body = doc.body;

  // Use a recursive function to extract text with spaces
  const extractText = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) {
          return node.nodeValue?.trim() || '';
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
          return Array.from(node.childNodes)
              .map(extractText)
              .filter(Boolean) // Remove empty strings
              .join(' '); // Join with spaces
      }
      return '';
  };

  return extractText(body).trim();
}

export function getDefaultFilenameByMime(mime: string): string {
  const map: Record<string, string> = {
    'application/pdf': 'document.pdf',
    'application/msword': 'document.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document.docx',
  };
  return map[mime] || 'downloaded-file';
}


export const useIsMobile = () => {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkIsMobile = () => window.innerWidth < 576;
    setIsMobile(checkIsMobile());

    const handleResize = () => {
      setIsMobile(checkIsMobile());
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return isMobile;
};

