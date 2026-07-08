/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryGap } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

/**
 * Localized, user-facing notice for a detected history gap — an earlier segment
 * of the session was physically lost (storage interruption) and could not be
 * recovered. Shown at the top of the reachable history. Shared by the terminal
 * `/resume` divider and the ACP replay notice so both surfaces read identically
 * and go through the i18n path.
 */
export function formatHistoryGapNotice(_gap: HistoryGap): string {
  return t(
    '⚠️ History gap: earlier conversation was lost before this point (storage interruption) and could not be recovered.',
  );
}
