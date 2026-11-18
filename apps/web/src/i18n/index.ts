import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { ar } from './ar';
import { en } from './en';

export type Lang = 'ar' | 'en';

function storedLang(): Lang {
  try {
    const v = localStorage.getItem('sofia.lang');
    if (v === 'ar' || v === 'en') return v;
  } catch {
    /* storage unavailable */
  }
  return 'ar';
}

export function applyDirection(lang: Lang): void {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ar: { translation: ar } },
  lng: storedLang(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});
applyDirection(i18n.language as Lang);

export function setLanguage(lang: Lang): void {
  try {
    localStorage.setItem('sofia.lang', lang);
  } catch {
    /* ignore */
  }
  void i18n.changeLanguage(lang);
  applyDirection(lang);
}

export function currentLang(): Lang {
  return (i18n.language as Lang) ?? 'ar';
}

export default i18n;
