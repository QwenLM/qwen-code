/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DefaultI18nService, type UiLocale } from '@qwen-code/core';
import { registerCliUiMessages } from '../ui/i18n/register.js';
export function createTestI18nService(locale: UiLocale = 'en') {
  const service = new DefaultI18nService();
  registerCliUiMessages(service);
  service.configureUi({
    locale,
    preference: locale,
    dynamicContentEnabled: false,
  });
  return service;
}
