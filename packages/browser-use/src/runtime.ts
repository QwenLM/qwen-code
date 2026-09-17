/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ChromeExtensionTransport } from './bridge/index.js';
import { DEFAULT_CHROME_DOCUMENTATION } from './core/chrome-runtime-documentation.js';
import { PlaywrightRuntime } from './playwright/playwright-runtime.js';

export type BrowserBackend = Pick<PlaywrightRuntime, 'dispatch' | 'stop'>;

export async function createBrowserBackend(): Promise<BrowserBackend> {
  return new PlaywrightRuntime({
    bridge: new ChromeExtensionTransport(),
    documentation: DEFAULT_CHROME_DOCUMENTATION,
  });
}
