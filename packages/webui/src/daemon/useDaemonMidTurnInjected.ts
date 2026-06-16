/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useSyncExternalStore } from 'react';
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
   * Clear the buffer once the batches have been reconciled. Safe to call from
   * the effect body: it is synchronous, so no new frame can append between the
   * read and the clear. Stable reference.
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
  return { batches, consume: clearSidechannelMidTurnInjected };
}
