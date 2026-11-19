export const WEB_SHELL_LANGUAGES = ['en', 'zh-CN', 'zh-TW', 'ru'] as const;

export type WebShellLanguage = (typeof WEB_SHELL_LANGUAGES)[number];
