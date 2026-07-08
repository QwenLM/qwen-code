/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryGap } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

/**
 * Localized, user-facing notice for a bridged history gap — an earlier segment
 * of the session was physically lost (storage interruption) and the older
 * history was stitched back on during load. Shared by the terminal `/resume`
 * divider and the ACP replay notice so both surfaces read identically and go
 * through the i18n path.
 */
export function formatHistoryGapNotice(gap: HistoryGap): string {
  if (!gap.bridgedToUuid) {
    // No earlier island could be recovered — this notice is the first visible
    // item with nothing above it, so it must not claim recovered history is
    // shown above.
    return t(
      '⚠️ History gap: earlier conversation was lost before this point (storage interruption) and could not be recovered.',
    );
  }
  const days =
    gap.approxLostMs && gap.approxLostMs > 0
      ? Math.round(gap.approxLostMs / 86_400_000)
      : 0;
  return days > 0
    ? t(
        '⚠️ History gap: about {{days}} day(s) of earlier conversation were lost here (storage interruption, unrecoverable). Recovered earlier history is shown above; the conversation continues below.',
        { days: String(days) },
      )
    : t(
        '⚠️ History gap: an earlier segment of conversation was lost here (storage interruption, unrecoverable). Recovered earlier history is shown above; the conversation continues below.',
      );
}
