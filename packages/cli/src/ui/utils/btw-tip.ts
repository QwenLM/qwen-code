/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TipHistory } from '../../services/tips/index.js';

/** Seconds a turn must run before the spinner suggests /btw. */
export const BTW_TIP_MIN_ELAPSED_SECONDS = 30;

/**
 * The spinner suggests /btw during long turns until the user has tried it.
 * `tipHistory` is null when tips are disabled.
 */
export function shouldShowBtwTip({
  tipHistory,
  elapsedTime,
}: {
  tipHistory: Pick<TipHistory, 'btwUseCount'> | null;
  elapsedTime: number;
}): boolean {
  return (
    tipHistory !== null &&
    tipHistory.btwUseCount === 0 &&
    elapsedTime >= BTW_TIP_MIN_ELAPSED_SECONDS
  );
}
