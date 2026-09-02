/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileURLToPath } from 'node:url';
import { BrokerClientTransport } from './broker-client-transport.js';
import { ensureBrowserBroker } from './broker-launcher.js';
import { BrowserRuntime } from './runtime.js';

export interface BrowserBackend {
  dispatch(method: string, args: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export async function createBrowserBackend(): Promise<BrowserBackend> {
  const runtime = createRuntime();
  return {
    async dispatch(method, args) {
      return await runtime.dispatch(method, args);
    },
    async close() {
      await runtime.stop();
    },
  };
}

function createRuntime(): BrowserRuntime {
  const brokerPath = fileURLToPath(
    new URL('./browser-broker.js', import.meta.url),
  );
  return new BrowserRuntime(
    new BrokerClientTransport({
      ensureBroker: async (socketPath) =>
        await ensureBrowserBroker(brokerPath, socketPath),
    }),
  );
}
