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
function validateUrl(url: string, { allowFile = false } = {}): void {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch (_error) {
    throw new Error(`Invalid URL: ${url}`);
  }

  const allowedProtocols = allowFile
    ? ['http:', 'https:', 'file:']
    : ['http:', 'https:'];

  // Only allow browser-safe protocols by default.
  if (!allowedProtocols.includes(parsedUrl.protocol)) {
    throw new Error(
      `Unsafe protocol: ${parsedUrl.protocol}. Only ${allowedProtocols.join(
        ', ',
      )} are allowed.`,
    );
  }

  // Additional validation: ensure no newlines or control characters
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\x00-\x1f]/.test(url)) {
    throw new Error('URL contains invalid characters');
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
 * @param options.allowFile - Allow file:// URLs for locally generated reports.
 * @returns A promise that resolves when the attempt is made (whether successful or logged).
 */
export async function openBrowserSecurely(
  url: string,
  browserOptions: { allowFile?: boolean } = {},
): Promise<void> {
  // Validate the URL first
  validateUrl(url, browserOptions);

  const platformName = platform();
  let command: string;
  let args: string[];

  const browserEnv = process.env['BROWSER']?.trim();
  const browserBlocklist = ['www-browser'];
  if (browserEnv && !browserBlocklist.includes(browserEnv)) {
    const browserCommand = parseBrowserCommand(browserEnv);
    if (browserCommand) {
      command = browserCommand.command;
      args = [...browserCommand.args, url];
    } else {
      throw new Error('Invalid BROWSER environment variable');
    }
  } else {
    switch (platformName) {
      case 'darwin':
        // macOS
        command = 'open';
        args = [url];
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
          `Start-Process '${url.replace(/'/g, "''")}'`,
        ];
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
  }

  const execOptions: Record<string, unknown> = {
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

  try {
    await execFileAsync(command, args, execOptions);
  } catch (_error) {
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
        'microsoft-edge',
      ];

      for (const fallbackCommand of fallbackCommands) {
        try {
          await execFileAsync(fallbackCommand, [url], execOptions);
          return; // Success!
        } catch {
          // Try next command
          continue;
        }
      }
    }

    // Log the URL so the user can open it manually instead of crashing.
    /* eslint-disable no-console */
    console.warn(
      `Failed to open browser automatically. Please open this URL manually: ${url}`,
    );
    /* eslint-enable no-console */
    return;
  }
}

function parseBrowserCommand(
  browserEnv: string,
): { command: string; args: string[] } | undefined {
  const parts =
    browserEnv.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map((part) => {
      if (
        (part.startsWith('"') && part.endsWith('"')) ||
        (part.startsWith("'") && part.endsWith("'"))
      ) {
        return part.slice(1, -1);
      }
      return part;
    }) ?? [];

  const [command, ...args] = parts;
  if (!command) {
    return undefined;
  }
  return { command, args };
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
