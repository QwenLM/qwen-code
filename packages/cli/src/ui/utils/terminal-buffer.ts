/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';

type TerminalEnvironment = Record<string, string | undefined>;

export function isCiEnvKey(key: string): boolean {
  return (
    key === 'CI' || key === 'CONTINUOUS_INTEGRATION' || key.startsWith('CI_')
  );
}

function isActiveCiValue(value: string | undefined): boolean {
  const normalizedValue = value?.toLowerCase();
  return (
    value !== undefined &&
    value !== '' &&
    normalizedValue !== '0' &&
    normalizedValue !== 'false'
  );
}

function isCiEnvironment(env: TerminalEnvironment): boolean {
  return Object.keys(env).some(
    (key) => isCiEnvKey(key) && isActiveCiValue(env[key]),
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
