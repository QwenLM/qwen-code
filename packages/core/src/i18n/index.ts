/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { I18nService } from './i18n-service.js';
import { DefaultI18nService } from './default-i18n-service.js';

export type {
  I18nService,
  DynamicTextSnapshot,
  I18nSnapshot,
  I18nUiState,
  MessageParams,
  UiLanguagePreference,
  I18nCatalog,
} from './i18n-service.js';
export {
  formatMessage,
  tokenizeMessage,
  getPlaceholderNames,
} from './message-format.js';
export { DefaultI18nService } from './default-i18n-service.js';
export { parseMarkdownDescription } from './markdown.js';

let globalService: I18nService | undefined;
const staticService = new DefaultI18nService();

/** Install the instance owned by the entry Framework. */
export function installI18nService(service: I18nService): void {
  if (globalService === service) return;
  if (globalService !== undefined) {
    throw new Error('I18n service has already been installed or created');
  }
  globalService = service;
}

export function initializeI18nService(): void {
  globalService ??= new DefaultI18nService();
  globalService.initSync();
}

/** Framework initialization must install the service before consumers run. */
export function getI18nService(): I18nService {
  return globalService!;
}

export function getStaticI18nService(): I18nService {
  return staticService;
}

export function resetI18nService(): void {
  try {
    globalService?.dispose();
  } finally {
    globalService = undefined;
  }
}
export {
  isUiLanguagePreference,
  normalizeUiLanguagePreference,
  resolveUiLocale,
} from './ui-locale.js';
export type { MessageToken } from './message-format.js';

export { DefaultI18nCatalog } from './default-i18n-catalog.js';
