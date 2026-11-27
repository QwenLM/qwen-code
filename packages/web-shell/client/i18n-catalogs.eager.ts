import type { Messages, WebShellLanguage } from './i18n.js';
import { AR } from './i18n-ar.js';
import { RU } from './i18n-ru.js';
import { ZH } from './i18n-zh-cn.js';
import { ZH_TW } from './i18n-zh-tw.js';

export const eagerCatalogs = new Map<WebShellLanguage, Messages>([
  ['zh-CN', ZH],
  ['zh-TW', ZH_TW],
  ['ru', RU],
  ['ar', AR],
]);

export const lazyCatalogs = new Map<
  WebShellLanguage,
  () => Promise<Messages>
>();
