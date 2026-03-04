import type { Translations } from './types';

// Get translations from window object
export function getTranslations(): Translations {
  return window.INSIGHT_TRANSLATIONS || {};
}

// Get current language
export function getLanguage(): string {
  return window.INSIGHT_LANGUAGE || 'en';
}

// Translate a key
export function t(
  key: string,
  params?: Record<string, string | number>,
): string {
  const translations = getTranslations();
  let translation = translations[key] || key;

  // Replace parameters
  if (params) {
    Object.entries(params).forEach(([paramKey, value]) => {
      translation = translation.replace(`{{${paramKey}}}`, String(value));
    });
  }

  return translation;
}
