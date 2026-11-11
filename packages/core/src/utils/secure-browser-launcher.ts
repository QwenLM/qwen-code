/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { URL } from 'node:url';
import type { EnterpriseUsage } from '../qoder/types.js';

const execFileAsync = promisify(execFile);
const ENTERPRISE_DEEP_LINK_PROTOCOL_ALLOWLIST = new Set(['dingtalk:', 'alilang:']);

/**
 * Validates that a URL is safe to open in a browser.
 * Only allows HTTP and HTTPS URLs to prevent command injection.
 *
 * @param url The URL to validate
 * @throws Error if the URL is invalid or uses an unsafe protocol
 */
function validateUrl(url: string): void {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // Only allow HTTP and HTTPS protocols
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(
      `Unsafe protocol: ${parsedUrl.protocol}. Only HTTP and HTTPS are allowed.`,
    );
  }

  // Additional validation: ensure no newlines or control characters
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\x00-\x1f]/.test(url)) {
    throw new Error('URL contains invalid characters');
  }
}

function validateHttpsUrl(url: string): void {
  validateUrl(url);
  if (new URL(url).protocol !== 'https:') {
    throw new Error('Enterprise usage URLs must use HTTPS.');
  }
}

function validateEnterpriseDeepLink(url: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\x00-\x1f]/.test(url)) {
    throw new Error('URL contains invalid characters');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('Invalid Enterprise usage Deep Link.');
  }

  if (
    parsedUrl.protocol !== 'https:' &&
    !ENTERPRISE_DEEP_LINK_PROTOCOL_ALLOWLIST.has(parsedUrl.protocol)
  ) {
    throw new Error('Unsupported Enterprise usage Deep Link protocol.');
  }
}

async function openUrlWithSystemHandler(
  url: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const platformName = platform();
  let command: string;
  let args: string[];

  switch (platformName) {
    case 'darwin':
      // macOS
      command = 'open';
      args = [url];
      break;

    case 'win32':
      // Windows - avoid launching a nested PowerShell process from the
      // user's terminal.
      command = 'rundll32.exe';
      args = ['url,OpenURL', url];
      break;

    case 'linux':
    case 'freebsd':
    case 'openbsd':
      // Linux and BSD variants
      // Try xdg-open first, fall back to other options
      command = 'xdg-open';
      args = [url];
      break;

    default:
      throw new Error(`Unsupported platform: ${platformName}`);
  }

  const options: Record<string, unknown> = {
    // Don't inherit parent's environment to avoid potential issues
    env: {
      ...process.env,
      // Ensure we're not in a shell that might interpret special characters
      SHELL: undefined,
    },
    // Detach the browser process so it doesn't block
    detached: platformName !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
    ...(signal ? { signal } : {}),
  };

  try {
    await execFileAsync(command, args, options);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    // For Linux, try fallback commands if xdg-open fails
    if (
      (platformName === 'linux' ||
        platformName === 'freebsd' ||
        platformName === 'openbsd') &&
      command === 'xdg-open'
    ) {
      const fallbackCommands = [
        'gnome-open',
        'kde-open',
        'firefox',
        'chromium',
        'google-chrome',
      ];

      for (const fallbackCommand of fallbackCommands) {
        try {
          await execFileAsync(fallbackCommand, [url], options);
          return; // Success!
        } catch (fallbackError) {
          if (signal?.aborted) throw signal.reason ?? fallbackError;
          // Try next command

        }
      }
    }

    // Re-throw the error if all attempts failed
    throw new Error(
      `Failed to open browser: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Opens an HTTP(S) URL in the default browser without shell interpretation.
 */
export async function openBrowserSecurely(
  url: string,
  signal?: AbortSignal,
): Promise<void> {
  validateUrl(url);
  await openUrlWithSystemHandler(url, signal);
}

/**
 * Opens the server-provided Enterprise usage destination according to its
 * explicit mode. Deep Links use an optional HTTPS fallback when provided.
 */
export async function openEnterpriseUsage(
  usage: EnterpriseUsage,
): Promise<void> {
  if (usage.openMode === 'externalBrowser') {
    validateHttpsUrl(usage.detailUrl);
    await openUrlWithSystemHandler(usage.detailUrl);
    return;
  }

  if (usage.fallbackUrl) validateHttpsUrl(usage.fallbackUrl);
  try {
    validateEnterpriseDeepLink(usage.detailUrl);
    await openUrlWithSystemHandler(usage.detailUrl);
  } catch (error) {
    if (!usage.fallbackUrl) throw error;
    await openUrlWithSystemHandler(usage.fallbackUrl);
  }
}

/**
 * Checks if the current environment should attempt to launch a browser.
 * This is the same logic as in browser.ts for consistency.
 *
 * @returns True if the tool should attempt to launch a browser
 */
export function shouldLaunchBrowser(): boolean {
  // A list of browser names that indicate we should not attempt to open a
  // web browser for the user.
  const browserBlocklist = ['www-browser'];
  const browserEnv = process.env['BROWSER'];
  if (browserEnv && browserBlocklist.includes(browserEnv)) {
    return false;
  }

  // Common environment variables used in CI/CD or other non-interactive shells.
  if (
    process.env['CI'] ||
    process.env['DEBIAN_FRONTEND'] === 'noninteractive'
  ) {
    return false;
  }

  // The presence of SSH_CONNECTION indicates a remote session.
  // We should not attempt to launch a browser unless a display is explicitly available
  // (checked below for Linux).
  const isSSH = !!process.env['SSH_CONNECTION'];

  // On Linux, the presence of a display server is a strong indicator of a GUI.
  if (platform() === 'linux') {
    // These are environment variables that can indicate a running compositor on Linux.
    const displayVariables = ['DISPLAY', 'WAYLAND_DISPLAY', 'MIR_SOCKET'];
    const hasDisplay = displayVariables.some((v) => !!process.env[v]);
    if (!hasDisplay) {
      return false;
    }
  }

  // If in an SSH session on a non-Linux OS (e.g., macOS), don't launch browser.
  // The Linux case is handled above (it's allowed if DISPLAY is set).
  if (isSSH && platform() !== 'linux') {
    return false;
  }

  // For non-Linux OSes, we generally assume a GUI is available
  // unless other signals (like SSH) suggest otherwise.
  return true;
}
