/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { URL } from 'node:url';

const execFileAsync = promisify(execFile);

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
  } catch (_error) {
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

function validateFilePath(filePath: string): void {
  if (!filePath.trim()) {
    throw new Error('Invalid file path');
  }

  // eslint-disable-next-line no-control-regex
  if (/[\r\n\x00-\x1f]/.test(filePath)) {
    throw new Error('File path contains invalid characters');
  }
}

function getLinuxBrowserCommands(): string[] {
  const browserEnv = process.env['BROWSER']?.trim();
  const commands = [
    ...(browserEnv && browserEnv !== 'www-browser' ? [browserEnv] : []),
    'xdg-open',
    'gnome-open',
    'kde-open',
    'firefox',
    'chromium',
    'google-chrome',
    'microsoft-edge',
  ];

  return [...new Set(commands)];
}

async function launchTarget(
  target: string,
  manualTargetLabel: 'URL' | 'file',
): Promise<void> {
  const platformName = platform();
  const options: Record<string, unknown> = {
    // Don't inherit parent's environment to avoid potential issues
    env: {
      ...process.env,
      // Ensure we're not in a shell that might interpret special characters
      SHELL: undefined,
    },
    // Detach the browser process so it doesn't block
    detached: true,
    stdio: 'ignore',
  };

  if (
    platformName === 'linux' ||
    platformName === 'freebsd' ||
    platformName === 'openbsd'
  ) {
    for (const command of getLinuxBrowserCommands()) {
      try {
        await execFileAsync(command, [target], options);
        return;
      } catch {
        continue;
      }
    }

    /* eslint-disable no-console */
    console.warn(
      `Failed to open browser automatically. Please open this ${manualTargetLabel} manually: ${target}`,
    );
    /* eslint-enable no-console */
    return;
  }

  let command: string;
  let args: string[];

  switch (platformName) {
    case 'darwin':
      // macOS
      command = 'open';
      args = [target];
      break;

    case 'win32':
      // Windows - use PowerShell with Start-Process
      // This avoids the cmd.exe shell which is vulnerable to injection
      command = 'powershell.exe';
      args = [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        `Start-Process '${target.replace(/'/g, "''")}'`,
      ];
      break;

    default:
      throw new Error(`Unsupported platform: ${platformName}`);
  }

  try {
    await execFileAsync(command, args, options);
  } catch (_error) {
    /* eslint-disable no-console */
    console.warn(
      `Failed to open browser automatically. Please open this ${manualTargetLabel} manually: ${target}`,
    );
    /* eslint-enable no-console */
  }
}

/**
 * Opens a URL in the user's default browser securely.
 *
 * On failure (e.g., missing browser binary or command), this function does NOT throw an error.
 * Instead, it logs the URL to the console error stream so the user can open it manually,
 * and resolves successfully to prevent application crashes.
 *
 * @param url - The URL to open.
 * @returns A promise that resolves when the attempt is made (whether successful or logged).
 */
export async function openBrowserSecurely(url: string): Promise<void> {
  // Validate the URL first
  validateUrl(url);
  await launchTarget(url, 'URL');
}

export async function openFilePathSecurely(filePath: string): Promise<void> {
  validateFilePath(filePath);
  await launchTarget(filePath, 'file');
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
