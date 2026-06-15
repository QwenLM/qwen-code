/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useSyncExternalStore } from 'react';
import type { DaemonMidTurnMessageInjectedData } from '@qwen-code/sdk/daemon';
import {
  getSidechannelMidTurnInjected,
  subscribeSidechannelMidTurnInjected,
} from './midTurnInjectedSidechannel.js';

/**
 * Returns the most recently injected mid-turn batch, or `undefined` if none.
 * The snapshot reference changes on every publish (even for identical text), so
 * a consumer can run an effect keyed on the return value to process each batch
 * exactly once — typically to drop the matching messages from its own pending
 * queue so they are not resent as the next turn.
 */
export function useDaemonMidTurnInjected():
  | DaemonMidTurnMessageInjectedData
  | undefined {
  return useSyncExternalStore(
    subscribeSidechannelMidTurnInjected,
    getSidechannelMidTurnInjected,
    getSidechannelMidTurnInjected,
  );
}
