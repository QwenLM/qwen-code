/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  normalizeUiLanguagePreference,
  resolveUiLocale,
  type I18nService,
  type UiLocale,
} from '@qwen-code/core';
import type { LoadedSettings } from '../../config/settings.js';

export interface I18nSettingsOptions {
  systemLocale?: string;
  forcedLocale?: UiLocale;
  dynamicContentEnabled?: boolean;
}

/** Bind before mounting UI; the service never reads React or SettingsContext. */
export function bindI18nSettings(
  service: I18nService,
  settings: LoadedSettings,
  options: I18nSettingsOptions = {},
): () => void {
  const update = () => {
    const raw = settings.getSnapshot().merged.ui?.language;
    service.configureUi({
      preference: options.forcedLocale ?? normalizeUiLanguagePreference(raw),
      locale:
        options.forcedLocale ??
        resolveUiLocale(raw, process.env, options.systemLocale),
      dynamicContentEnabled: options.dynamicContentEnabled ?? true,
    });
  };
  const stop = settings.subscribe(update);
  update();
  return stop;
}
