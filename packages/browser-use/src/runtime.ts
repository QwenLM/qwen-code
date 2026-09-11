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
  isChromeExtensionInstalled,
  nativeHostInstallHome,
} from './native-host-installer.js';
import { PlaywrightRuntime } from './playwright/playwright-runtime.js';

export type BrowserBackend = Pick<PlaywrightRuntime, 'dispatch' | 'stop'>;

export async function createBrowserBackend(): Promise<BrowserBackend> {
  if (
    !process.env['QWEN_BROWSER_USE_SOCKET_PATH'] &&
    (process.platform === 'darwin' || process.platform === 'linux')
  ) {
    const options = {
      homeDir: nativeHostInstallHome(),
      nativeHostPath: fileURLToPath(
        new URL('./native-host.js', import.meta.url),
      ),
    };
    const deadline = Date.now() + 30_000;
    while (!(await isChromeExtensionInstalled(options))) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          'Could not detect the Qwen Code Chrome extension after waiting 30 seconds. ' +
            'If you just installed it, wait a few seconds and retry Browser Use. ' +
            'If it is not installed, install it at chrome://extensions ' +
            '(Developer mode > Load unpacked), then retry Browser Use.',
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1_000, remainingMs)),
      );
    }
    await installChromeNativeHost(options);
  }
  return new PlaywrightRuntime({
    bridge: new ChromeExtensionTransport(),
    documentation: DEFAULT_CHROME_DOCUMENTATION,
  });
}
