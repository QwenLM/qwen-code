/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  CHROME_BRIDGE_PROTOCOL_VERSION as BROWSER_USE_PROTOCOL_VERSION,
  CHROME_EXTENSION_ID as QWEN_CHROME_EXTENSION_ID,
  CHROME_NATIVE_HOST_NAME as BROWSER_USE_NATIVE_HOST,
  MAX_BRIDGE_FRAME_BYTES,
  defaultChromeBridgeSocketPath as browserUseSocketPath,
  type BridgeEvent,
  type BridgeHello,
  type BridgeRequest,
  type BridgeResponse,
} from './bridge/protocol.js';
