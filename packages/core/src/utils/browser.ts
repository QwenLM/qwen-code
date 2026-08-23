/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const browserBlocklist = ['www-browser'];

export function isBrowserCommandBlocked(command: string): boolean {
  const commandName = command.replace(/\\/g, '/').split('/').pop();
  return !!commandName && browserBlocklist.includes(commandName);
}

export type BrowserLaunchEnvironmentOptions = {
  ignoreBrowserBlocklist?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
};

export function browserLaunchIneligibilityReasons(
  options: BrowserLaunchEnvironmentOptions = {},
): string[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const reasons: string[] = [];
  const browserEnv = env['BROWSER']?.trim();
  const browserCommand = browserEnv?.match(/^\S+/)?.[0];
  if (
    !options.ignoreBrowserBlocklist &&
    platform !== 'win32' &&
    browserCommand &&
    isBrowserCommandBlocked(browserCommand)
  ) {
    reasons.push(`BROWSER command "${browserCommand}" is blocklisted`);
  }
  if (env['CI']) {
    reasons.push('CI is set');
  }
  if (env['DEBIAN_FRONTEND'] === 'noninteractive') {
    reasons.push('DEBIAN_FRONTEND=noninteractive');
  }
  if (
    platform === 'linux' &&
    !['DISPLAY', 'WAYLAND_DISPLAY', 'MIR_SOCKET'].some((key) => env[key])
  ) {
    reasons.push('Linux has no DISPLAY, WAYLAND_DISPLAY, or MIR_SOCKET');
  }
  if (env['SSH_CONNECTION'] && platform !== 'linux') {
    reasons.push(`SSH_CONNECTION is set on ${platform}`);
  }
  return reasons;
}

/**
 * Determines if we should attempt to launch a browser for authentication
 * based on the user's environment.
 *
 * This is an adaptation of the logic from the Google Cloud SDK.
 * @returns True if the tool should attempt to launch a browser.
 */
export function shouldAttemptBrowserLaunch(
  options: BrowserLaunchEnvironmentOptions = {},
): boolean {
  return browserLaunchIneligibilityReasons(options).length === 0;
}
