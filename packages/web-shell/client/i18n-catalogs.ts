import type { Messages, WebShellLanguage } from './i18n.js';

export const eagerCatalogs = new Map<WebShellLanguage, Messages>();

export const lazyCatalogs = new Map<WebShellLanguage, () => Promise<Messages>>([
  ['zh-CN', () => import('./i18n-zh-cn.js').then(({ ZH }) => ZH)],
  ['zh-TW', () => import('./i18n-zh-tw.js').then(({ ZH_TW }) => ZH_TW)],
  ['ru', () => import('./i18n-ru.js').then(({ RU }) => RU)],
]);
