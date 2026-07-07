/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface FollowupState {
  /** Current suggestion text */
  suggestion: string | null;
  /** Whether to show suggestion */
  isVisible: boolean;
  /** Timestamp when suggestion was shown (for telemetry) */
  shownAt: number;
}

export const INITIAL_FOLLOWUP_STATE: Readonly<FollowupState> = Object.freeze({
  suggestion: null,
  isVisible: false,
  shownAt: 0,
});
