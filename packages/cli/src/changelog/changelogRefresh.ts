/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger, type UiLocale } from '@qwen-code/core';
import { getUiLocale, onUiLocaleChange } from '../ui/i18n/uiLocaleState.js';
import { onUpdateSuccess } from '../utils/updateEventEmitter.js';
import { fetchChangelogForLocale, getChangelogUrl } from './changelogFetch.js';

/**
 * Keep the TUI's changelog aligned with its locale: fetch it for the locale
 * the UI renders in (and again whenever that changes), and refresh it after
 * each successful CLI update. Returns a function that stops following.
 */
export function startChangelogRefresh(
  getUrl: typeof getChangelogUrl = getChangelogUrl,
): () => void {
  let stopUpdateRefresh: (() => void) | undefined;

  const follow = (locale: UiLocale) => {
    fetchChangelogForLocale(locale, getUrl).catch((error) => {
      runLogger.warn('Background changelog fetch failed:', error);
    });
    stopUpdateRefresh?.();
    stopUpdateRefresh = onUpdateSuccess(() => {
      fetchChangelogForLocale(locale, getUrl, true).catch((error) => {
        runLogger.warn(
          'Background changelog refresh after update failed:',
          error,
        );
      });
    });
  };

  const stopLocale = onUiLocaleChange(follow);
  const current = getUiLocale();
  if (current) follow(current);

  return () => {
    stopLocale();
    stopUpdateRefresh?.();
    stopUpdateRefresh = undefined;
  };
}
