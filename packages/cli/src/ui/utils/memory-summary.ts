/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { t } from '../../i18n/index.js';

export function formatMemorySummary(read = 0, written = 0): string {
  return t('Memory: {{read}} read, {{written}} written', {
    read: String(read),
    written: String(written),
  });
}
