/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileURLToPath } from 'node:url';

import { ChromeExtensionTransport } from './bridge/index.js';
import type { ChromeProfileDescriber } from './bridge/discovery.js';
import { DEFAULT_CHROME_DOCUMENTATION } from './core/chrome-runtime-documentation.js';
import {
  describeChromeProfiles,
  ensureChromeNativeHost,
  nativeHostInstallHome,
} from './native-host-installer.js';
import { PlaywrightRuntime } from './playwright/playwright-runtime.js';

export type BrowserBackend = Pick<PlaywrightRuntime, 'dispatch' | 'stop'>;

export async function createBrowserBackend(): Promise<BrowserBackend> {
  let describeProfiles: ChromeProfileDescriber | undefined;
  if (
    !process.env['QWEN_BROWSER_USE_SOCKET_PATH']?.trim() &&
    !process.env['QWEN_BROWSER_USE_DISCOVERY_DIR']?.trim() &&
    (process.platform === 'darwin' || process.platform === 'linux')
  ) {
    const options = {
      homeDir: nativeHostInstallHome(),
      nativeHostPath: fileURLToPath(
        new URL('./native-host.js', import.meta.url),
      ),
    };
    const installed = await ensureChromeNativeHost(options);
    if (installed.skippedForeignPaths.length > 0) {
      // A foreign manifest under a browser root the user does not run is
      // harmless, so this is a warning rather than a failure; but when it is
      // the browser in use, Chrome keeps launching the other program's host
      // and the bridge only ever reports a generic connection timeout.
      process.stderr.write(
        'Browser Use: another program owns the Chrome Native Messaging ' +
          'manifest at ' +
          installed.skippedForeignPaths.join(', ') +
          '. It was left unchanged; if that browser is the one you use, ' +
          'Chrome will launch that host instead of Qwen Code. ' +
          'Remove or move the file, then retry Browser Use.\n',
      );
    }
    if (!installed.ready) {
      throw new Error(
        'Browser Use could not register its Native Host with any Chrome ' +
          'profile root. ' +
          (installed.skippedForeignPaths.length > 0
            ? 'Another program owns ' +
              installed.skippedForeignPaths.join(', ') +
              '; remove or move it, then retry Browser Use.'
            : 'Start Chrome once so its profile directory exists, then retry Browser Use.'),
      );
    }
    describeProfiles = (ids) =>
      describeChromeProfiles({ homeDir: options.homeDir }, ids);
  }
  return new PlaywrightRuntime({
    bridge: new ChromeExtensionTransport({ describeProfiles }),
    documentation: DEFAULT_CHROME_DOCUMENTATION,
  });
}
