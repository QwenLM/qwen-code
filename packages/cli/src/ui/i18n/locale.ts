/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';

export {
  isUiLanguagePreference,
  normalizeUiLanguagePreference,
  resolveUiLocale,
} from '@qwen-code/core';

const SYSTEM_LOCALE_COMMAND_TIMEOUT_MS = 1000;

type LocaleCommandRunner = (
  executable: string,
  args: string[],
) => string | undefined;

function runLocaleCommand(
  executable: string,
  args: string[],
): string | undefined {
  try {
    return (
      execFileSync(executable, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: SYSTEM_LOCALE_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

function firstAppleLanguage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const listBody = value.replace(/^\s*\(\s*/u, '').replace(/\s*\)\s*$/u, '');
  const language = listBody.split(',')[0]?.trim().replace(/^"|"$/gu, '');
  return language || undefined;
}

/** Read the operating system's current UI language, when available. */
export function detectSystemUiLocale(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  runCommand: LocaleCommandRunner = runLocaleCommand,
): string | undefined {
  if (platform === 'darwin') {
    return (
      firstAppleLanguage(
        runCommand('/usr/bin/defaults', ['read', '-g', 'AppleLanguages']),
      ) ?? runCommand('/usr/bin/defaults', ['read', '-g', 'AppleLocale'])
    );
  }

  if (platform === 'win32') {
    const windowsRoot =
      env['SystemRoot'] ?? env['SYSTEMROOT'] ?? env['windir'] ?? env['WINDIR'];
    if (!windowsRoot || !win32.isAbsolute(windowsRoot)) return undefined;

    return runCommand(
      win32.join(
        windowsRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-UICulture).Name',
      ],
    );
  }

  return undefined;
}
