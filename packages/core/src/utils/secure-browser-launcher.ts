/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import {
  isBrowserCommandBlocked,
  shouldAttemptBrowserLaunch,
} from './browser.js';

const execFileAsync = promisify(execFile);

type BrowserLaunchOptions = {
  allowFile?: boolean;
  allowedFilePaths?: string[];
};

/**
 * Validates that a URL is safe to open in a browser.
 * Only allows HTTP and HTTPS URLs by default. file:// URLs are allowed only
 * when a caller opts in for locally generated reports.
 *
 * @param url The URL to validate
 * @throws Error if the URL is invalid or uses an unsafe protocol
 */
function validateUrl(
  url: string,
  { allowFile = false, allowedFilePaths }: BrowserLaunchOptions = {},
): void {
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

  if (parsedUrl.protocol === 'file:' && allowFile) {
    if (!allowedFilePaths?.length) {
      throw new Error('allowedFilePaths is required when allowFile is true');
    }
    const requestedPath = resolve(fileURLToPath(parsedUrl));
    const allowed = allowedFilePaths.map((filePath) => resolve(filePath));
    if (!allowed.includes(requestedPath)) {
      throw new Error('File URL is not in the allowed file set');
    }
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
  browserOptions: BrowserLaunchOptions = {},
): Promise<void> {
  // Validate the URL first
  validateUrl(url, browserOptions);

  const platformName = platform();
  let command: string;
  let args: string[];

  const browserEnv = process.env['BROWSER']?.trim();
  const browserCommand =
    platformName === 'win32' ? undefined : buildBrowserCommand(browserEnv, url);

  if (browserCommand) {
    try {
      await launchDetached(browserCommand.command, browserCommand.args);
      return;
    } catch (_error) {
      /* eslint-disable no-console */
      console.warn(
        `Failed to open BROWSER command ${browserCommand.command}: ${formatLaunchError(
          _error,
        )}. Falling back to the platform browser opener.`,
      );
      /* eslint-enable no-console */
    }
  }

  if (!shouldAttemptBrowserLaunch({ ignoreBrowserBlocklist: true })) {
    /* eslint-disable no-console */
    console.warn(
      `Browser launch is not available in this environment. Please open this URL manually: ${url}`,
    );
    /* eslint-enable no-console */
    return;
  }

  {
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
        { command: 'gnome-open', detached: false },
        { command: 'kde-open', detached: false },
        { command: 'firefox', detached: true },
        { command: 'chromium', detached: true },
        { command: 'google-chrome', detached: true },
        { command: 'microsoft-edge', detached: true },
      ];

      for (const { command: fallbackCommand, detached } of fallbackCommands) {
        try {
          if (detached) {
            await launchDetached(fallbackCommand, [url]);
          } else {
            await execFileAsync(fallbackCommand, [url], execOptions);
          }
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

async function launchDetached(command: string, args: string[]): Promise<void> {
  const spawnOptions: SpawnOptions = {
    env: {
      ...process.env,
      SHELL: undefined,
    },
    detached: true,
    stdio: 'ignore',
  };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, spawnOptions);
    let settled = false;

    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });

    child.once('spawn', () => {
      if (settled) {
        return;
      }
      settled = true;
      child.unref();
      resolve();
    });
  });
}

function formatLaunchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildBrowserCommand(
  browserEnv: string | undefined,
  url: string,
): { command: string; args: string[] } | undefined {
  if (!browserEnv) {
    return undefined;
  }

  const browserCommand = parseBrowserCommand(browserEnv);
  if (!browserCommand) {
    /* eslint-disable no-console */
    console.warn(
      'Invalid BROWSER environment variable, falling back to platform default.',
    );
    /* eslint-enable no-console */
    return undefined;
  }

  if (isBrowserCommandBlocked(browserCommand.command)) {
    return undefined;
  }

  let usedPlaceholder = false;
  const args = browserCommand.args.map((arg) => {
    if (!arg.includes('%s')) {
      return arg;
    }
    usedPlaceholder = true;
    return arg.replace(/%s/g, () => url);
  });

  if (!usedPlaceholder) {
    args.push(url);
  }

  return { command: browserCommand.command, args };
}

function parseBrowserCommand(
  browserEnv: string,
): { command: string; args: string[] } | undefined {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;

  for (const char of browserEnv) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    return undefined;
  }

  if (current) {
    parts.push(current);
  }

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
  return shouldAttemptBrowserLaunch();
}
