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

/**
 * The transport spends its own 35s connect budget polling for a Chrome that
 * published an endpoint. Where no Native Messaging Host can be registered and
 * nothing else publishes one, that wait can only end in the disconnect error,
 * so it is cut short (#13692).
 */
const UNREGISTERABLE_HOST_CONNECT_TIMEOUT_MS = 0;

/** A managed endpoint is published by something else, so no Host is needed. */
function hasManagedEndpointOverride(): boolean {
  return Boolean(
    process.env['QWEN_BROWSER_USE_SOCKET_PATH']?.trim() ||
      process.env['QWEN_BROWSER_USE_DISCOVERY_DIR']?.trim(),
  );
}

/** Only these platforms have a Chrome profile root the manifest can live in. */
function supportsNativeHostRegistration(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux';
}

export async function createBrowserBackend(): Promise<BrowserBackend> {
  let describeProfiles: ChromeProfileDescriber | undefined;
  const managed = hasManagedEndpointOverride();
  const registrable = supportsNativeHostRegistration();
  if (!managed && registrable) {
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
  // The bridge can only ever reach a Host this process registered, so where
  // registration was impossible and nothing else publishes an endpoint there
  // is provably nothing to wait for.
  const connectTimeoutMs =
    !managed && !registrable
      ? UNREGISTERABLE_HOST_CONNECT_TIMEOUT_MS
      : undefined;
  return new PlaywrightRuntime({
    bridge: new ChromeExtensionTransport({
      describeProfiles,
      connectTimeoutMs,
    }),
    documentation: DEFAULT_CHROME_DOCUMENTATION,
  });
}
