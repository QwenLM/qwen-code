/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { UiLocale } from '@qwen-code/core';
import {
  fetchChangelogForLocale,
  getChangelogSnapshot,
  subscribeChangelog,
  getChangelogUrl,
  type ChangelogSnapshot,
} from './changelogFetch.js';
import { useI18nService } from '../ui/i18n/I18nServiceContext.js';

/** Subscribe to the process-wide changelog snapshot. */
export function useChangelog(
  localeOverride?: UiLocale,
  getUrl: typeof getChangelogUrl = getChangelogUrl,
): ChangelogSnapshot {
  const { locale: contextLocale } = useI18nService();
  const locale = localeOverride ?? contextLocale;
  const getSnapshot = useCallback(() => getChangelogSnapshot(locale), [locale]);
  const snapshot = useSyncExternalStore(
    subscribeChangelog,
    getSnapshot,
    getSnapshot,
  );

  useEffect(() => {
    fetchChangelogForLocale(locale, getUrl).catch(() => {});
  }, [locale, getUrl]);

  return snapshot;
}
