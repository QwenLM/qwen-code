/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DefaultI18nCatalog,
  type I18nCatalog,
  type I18nService,
} from '@qwen-code/core';
import { enCatalog } from './locales/en/index.js';
import { zhCNCatalog } from './locales/zh-CN/index.js';

export const cliUiCatalog: I18nCatalog = new DefaultI18nCatalog({
  en: enCatalog,
  'zh-CN': zhCNCatalog,
});

export function registerCliUiMessages(service: I18nService): void {
  service.registerCatalog(cliUiCatalog);
}
