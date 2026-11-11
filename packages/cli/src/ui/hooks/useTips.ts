/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useState } from 'react';
import { persistentState } from '../../utils/persistentState.js';

interface UseTipsResult {
  /** Whether tips are still within the per-install impression budget. */
  showTips: boolean;
  /**
   * Record one impression. Call this only once the tips are ACTUALLY displayed
   * — counting on mount would burn impressions when the box is suppressed
   * (e.g. a too-narrow terminal). Idempotent within a launch.
   */
  markShown: () => void;
}

// Module scope, not a per-mount ref: the header can remount within one launch
// (e.g. a `conversationKey` bump on --resume) and a per-mount guard would count
// a second impression each time.
let tipsCountedThisLaunch = false;

/** Reset the per-launch impression flag. Test-only. */
export function _clearTipsShownForTest(): void {
  tipsCountedThisLaunch = false;
}

export function useTips(): UseTipsResult {
  const [tipsCount] = useState(() => persistentState.get('tipsShown') ?? 0);

  const showTips = tipsCount < 10;

  const markShown = useCallback(() => {
    if (!showTips || tipsCountedThisLaunch) return;
    tipsCountedThisLaunch = true;
    persistentState.set('tipsShown', tipsCount + 1);
  }, [tipsCount, showTips]);

  return { showTips, markShown };
}
