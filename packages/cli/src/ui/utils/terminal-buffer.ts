/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';

type TerminalEnvironment = Record<string, string | undefined>;

function isCiEnvironment(env: TerminalEnvironment): boolean {
  if (env['CI'] === '0' || env['CI'] === 'false') {
    return false;
  }

  return (
    'CI' in env ||
    'CONTINUOUS_INTEGRATION' in env ||
    Object.keys(env).some((key) => key.startsWith('CI_'))
  );
}

export function isInteractiveTerminal(
  stdoutIsTTY: boolean | undefined = process.stdout.isTTY,
  env: TerminalEnvironment = process.env,
): boolean {
  return Boolean(stdoutIsTTY) && !isCiEnvironment(env);
}

export function shouldUseVirtualViewport(
  useTerminalBuffer: boolean | undefined,
  screenReader: boolean,
  terminalInteractive: boolean,
): boolean {
  // The settings loader does not apply schema defaults, so keep this fallback
  // in sync with settingsSchema.ts's default for ui.useTerminalBuffer.
  return terminalInteractive && (useTerminalBuffer ?? true) && !screenReader;
}
