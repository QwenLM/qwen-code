/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { DaemonMidTurnMessageInjectedData } from '@qwen-code/sdk/daemon';
import {
  clearSidechannelMidTurnInjected,
  getSidechannelMidTurnInjected,
  subscribeSidechannelMidTurnInjected,
} from './midTurnInjectedSidechannel.js';

export interface UseDaemonMidTurnInjectedResult {
  /**
   * All injected mid-turn batches accumulated since the last `consume()`, in
   * arrival order. The array reference changes on every publish/consume, so a
   * consumer can run an effect keyed on it to reconcile every batch (not just
   * the newest) against its pending queue.
   */
  batches: readonly DaemonMidTurnMessageInjectedData[];
  /**
   * Clear the batches that were reconciled. Compare-and-swap: it only clears if
   * the buffer still holds exactly the `batches` snapshot returned above. A
   * frame that appended between the render snapshot and the (async) effect that
   * calls this is therefore preserved, not wiped — it is reconciled on the next
   * effect run instead of being lost (which would resend it next turn).
   */
  consume: () => void;
}

/**
 * Subscribe to injected mid-turn batches. Unlike a latest-wins signal, this
 * accumulates every batch so multi-batch turns (one frame per tool batch) are
 * all reconciled; the consumer calls `consume()` after processing.
 */
export function useDaemonMidTurnInjected(): UseDaemonMidTurnInjectedResult {
  const batches = useSyncExternalStore(
    subscribeSidechannelMidTurnInjected,
    getSidechannelMidTurnInjected,
    getSidechannelMidTurnInjected,
  );
  // Compare-and-swap on the exact snapshot we reconciled, so a frame that
  // appended between this render and the consuming effect survives. `batches` is
  // reference-stable between store changes (useSyncExternalStore), so the
  // `[batches]` dep keeps `consume` stable too — a new snapshot is what makes a
  // new closure, which is exactly when the consuming effect should re-run.
  const consume = useCallback(
    () => clearSidechannelMidTurnInjected(batches),
    [batches],
  );
  return { batches, consume };
}
