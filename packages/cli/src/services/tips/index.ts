/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { TipHistory } from './tipHistory.js';

export { TipHistory } from './tipHistory.js';
export { selectTip } from './tipScheduler.js';
export {
  tipRegistry,
  getContextUsagePercent,
  type ContextualTip,
  type TipContext,
  type TipTrigger,
} from './tipRegistry.js';

/**
 * Shared TipHistory singleton for the session. Loaded once on first access
 * so both startup tips and post-response tips share the same state.
 */
let _tipHistory: TipHistory | null = null;
export function getTipHistory(): TipHistory {
  if (!_tipHistory) {
    _tipHistory = TipHistory.load();
  }
  return _tipHistory;
}
