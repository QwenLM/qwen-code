/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export { BrowserRuntimeError, type RuntimeErrorCode } from './errors.js';
export {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  CHROME_EXTENSION_ID,
  CHROME_NATIVE_HOST_NAME,
  MAX_BRIDGE_FRAME_BYTES,
  defaultChromeBridgeSocketPath,
  type BridgeEvent,
  type BridgeHello,
  type BridgeMessage,
  type BridgeRequest,
  type BridgeResponse,
} from './protocol.js';
export {
  ChromeExtensionTransport,
  type BridgeConnectionListener,
  type BridgeEventListener,
  type ChromeBridge,
  type ChromeExtensionTransportOptions,
} from './transport/chrome-extension-transport.js';
export { encodeFrame, FrameDecoder } from './transport/framing.js';
