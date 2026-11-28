/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** A turn must run this long before the /btw tip replaces the rotating tip. */
export const BTW_TIP_MIN_ELAPSED_SECONDS = 30;

/** The /btw tip shows during long turns until a side question has been asked once. */
export function shouldShowBtwTip({
  showTips,
  elapsedSeconds,
  useCount,
}: {
  showTips: boolean;
  elapsedSeconds: number;
  useCount: number | undefined;
}): boolean {
  return (
    showTips && elapsedSeconds >= BTW_TIP_MIN_ELAPSED_SECONDS && !useCount
  );
}
