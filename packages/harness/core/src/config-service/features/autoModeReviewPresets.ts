/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getConfigValue } from '../index.js';
import { runLogger } from '../../utils/runLogger.js';
import { parseObjectGateValue } from './gateParseUtils.js';
import defaults from './autoModeReviewPresets.defaults.json' with { type: 'json' };

export const AUTO_MODE_REVIEW_PRESETS_KEY = 'auto_mode_review_presets';
let lastInvalidValue: string | undefined;

export interface AutoModeReviewPresets {
  readonly commands: readonly string[];
  readonly git_subcommands: ReadonlyArray<readonly string[]>;
  readonly find_delete: boolean;
  readonly mkfs_variants: boolean;
}

/** Read the current cached value once per review; missing/invalid values reset to defaults. */
export function getAutoModeReviewPresets(): AutoModeReviewPresets {
  const value = getConfigValue(AUTO_MODE_REVIEW_PRESETS_KEY);
  const presets = parsePresets(value);
  warnInvalidPresets(value, presets !== undefined);
  return presets ?? defaults;
}

function warnInvalidPresets(value: unknown, valid: boolean): void {
  if (valid || value === undefined) {
    lastInvalidValue = undefined;
    return;
  }
  const serialized = JSON.stringify(value);
  if (lastInvalidValue === serialized) return;
  lastInvalidValue = serialized;
  runLogger.warn(
    '[config-service] Invalid auto_mode_review_presets; using built-in defaults. Expected commands and git_subcommands arrays and find_delete and mkfs_variants booleans.',
  );
}

function parsePresets(value: unknown): AutoModeReviewPresets | undefined {
  const record = parseObjectGateValue(value);
  if (!record) return undefined;
  const commands = record['commands'];
  const gitSubcommands = record['git_subcommands'];
  const findDelete = record['find_delete'];
  const mkfsVariants = record['mkfs_variants'];
  if (
    !isCommandTokens(commands) ||
    !Array.isArray(gitSubcommands) ||
    !gitSubcommands.every(
      (entry: unknown): entry is string[] =>
        isCommandTokens(entry) && entry.length > 0,
    ) ||
    typeof findDelete !== 'boolean' ||
    typeof mkfsVariants !== 'boolean'
  ) {
    return undefined;
  }
  return {
    commands,
    git_subcommands: gitSubcommands,
    find_delete: findDelete,
    mkfs_variants: mkfsVariants,
  };
}

function isCommandTokens(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (token: unknown) =>
        typeof token === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(token),
    )
  );
}
