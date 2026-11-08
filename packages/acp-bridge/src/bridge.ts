/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeOptions } from './bridgeOptions.js';
import type { AcpSessionBridge } from './bridgeTypes.js';
import { createChannelHarness } from './channel-harness.js';
import { createSessionControlPlane } from './session-control-plane.js';

export {
  extractErrorMessage,
  extractErrorCode,
  classifyTurnErrorKind,
} from './session-control-plane.js';

export function createAcpSessionBridge(opts: BridgeOptions): AcpSessionBridge {
  return createSessionControlPlane(opts, createChannelHarness);
}

/** @deprecated Use `createAcpSessionBridge` instead. */
export const createHttpAcpBridge = createAcpSessionBridge;
