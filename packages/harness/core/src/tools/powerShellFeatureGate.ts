/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isPowerShellToolQcsEnabled } from '../config-service/features/powerShellTool.js';
import { getPlatform } from '../utils/platform.js';
import { probeGitBashPathSync } from '../utils/windowsPaths.js';
import { BRAND_FIXED_ENV_PREFIX } from '../config/brand.js';

export const ENV_USE_POWERSHELL_TOOL = `${BRAND_FIXED_ENV_PREFIX}USE_POWERSHELL_TOOL`;

export type PowerShellToolOverride = true | false | undefined;

export type ShellCapabilityDecision = {
  exposeBash: boolean;
  exposePowerShell: boolean;
  defaultShell: 'bash' | 'powershell' | null;
};

export type ShellCapabilitySnapshot = ShellCapabilityDecision & {
  platform: ReturnType<typeof getPlatform>;
  hasGitBash: boolean;
  override: PowerShellToolOverride;
  qcsEnabled: boolean;
};

export function parsePowerShellToolOverride(
  value: string | undefined,
): PowerShellToolOverride {
  if (value == null || value.trim() === '') return undefined;
  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return undefined;
  }
}

export function resolveShellCapabilityDecision(input: {
  platform: ReturnType<typeof getPlatform>;
  override: PowerShellToolOverride;
  hasGitBash: boolean;
  qcsEnabled: boolean;
}): ShellCapabilityDecision {
  if (input.platform !== 'windows') {
    return {
      exposeBash: true,
      exposePowerShell: input.override === true,
      defaultShell: 'bash',
    };
  }

  const exposePowerShell = input.override ?? input.qcsEnabled;
  // Disabling the new tool restores the original Bash preparation/execution
  // path, even when Git Bash has not finished installing yet.
  const exposeBash = input.hasGitBash || !exposePowerShell;
  return {
    exposeBash,
    exposePowerShell,
    defaultShell: exposeBash ? 'bash' : 'powershell',
  };
}

/**
 * Resolves one coherent capability snapshot for a tool-registry rebuild.
 * QCS controls every Windows entrypoint unless explicitly overridden.
 */
export async function resolveShellCapabilitySnapshot(): Promise<ShellCapabilitySnapshot> {
  const platform = getPlatform();
  const override = parsePowerShellToolOverride(
    process.env[ENV_USE_POWERSHELL_TOOL],
  );
  const hasGitBash =
    platform === 'windows' ? probeGitBashPathSync() !== null : true;

  const qcsEnabled =
    platform === 'windows' && override === undefined
      ? isPowerShellToolQcsEnabled()
      : false;
  const decision = resolveShellCapabilityDecision({
    platform,
    override,
    hasGitBash,
    qcsEnabled,
  });
  return {
    platform,
    hasGitBash,
    override,
    qcsEnabled,
    ...decision,
  };
}
