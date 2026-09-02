/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ChromeExtensionTransport as BridgeTransport,
  type ChromeExtensionTransportOptions,
} from './bridge/transport/chrome-extension-transport.js';

export type {
  BridgeConnectionListener,
  BridgeEventListener,
  ChromeBridge,
  ChromeExtensionTransportOptions,
} from './bridge/transport/chrome-extension-transport.js';

export class ChromeExtensionTransport extends BridgeTransport {
  constructor(options: string | ChromeExtensionTransportOptions = {}) {
    super(typeof options === 'string' ? { socketPath: options } : options);
  }
}
