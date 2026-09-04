/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileURLToPath } from 'node:url';

import { ChromeExtensionTransport } from './bridge/index.js';
import { DEFAULT_CHROME_DOCUMENTATION } from './core/chrome-runtime-documentation.js';
import {
  installChromeNativeHost,
  nativeHostInstallHome,
} from './native-host-installer.js';
import { PlaywrightRuntime } from './playwright/playwright-runtime.js';

export type BrowserBackend = Pick<PlaywrightRuntime, 'dispatch' | 'stop'>;

export async function createBrowserBackend(): Promise<BrowserBackend> {
  if (
    !process.env['QWEN_BROWSER_USE_SOCKET_PATH'] &&
    (process.platform === 'darwin' || process.platform === 'linux')
  ) {
    await installChromeNativeHost({
      homeDir: nativeHostInstallHome(),
      nativeHostPath: fileURLToPath(
        new URL('./native-host.js', import.meta.url),
      ),
    });
  }
  return new PlaywrightRuntime({
    bridge: new ChromeExtensionTransport(),
    documentation: DEFAULT_CHROME_DOCUMENTATION,
  });
}
