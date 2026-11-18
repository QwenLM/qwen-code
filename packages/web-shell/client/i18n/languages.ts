export const WEB_SHELL_LANGUAGES = [
  'en',
  'zh-CN',
  'zh-TW',
  'ru',
  'ar',
] as const;

export type WebShellLanguage = (typeof WEB_SHELL_LANGUAGES)[number];

export type LanguageDirection = 'ltr' | 'rtl';

export function isRtlLanguage(language: string | undefined): boolean {
  if (!language) return false;
  const normalized = language.trim().toLowerCase();
  return normalized === 'ar' || normalized.startsWith('ar-');
}

export function languageDirection(
  language: string | undefined,
): LanguageDirection {
  return isRtlLanguage(language) ? 'rtl' : 'ltr';
}
