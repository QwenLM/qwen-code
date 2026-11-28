/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_ENV_PREFIX } from '@qwen-code/core';
import { normalizePermissionModeValue } from './permissionMode.js';

export function getTrimmedEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export function getStringArg(
  argv: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = argv[key];
  return typeof value === 'string' ? value : undefined;
}

/** 首次启动和项目重建共用环境默认值，不覆盖显式参数。 */
export function applyEnvironmentDefaults(
  opts: Record<string, unknown>,
  excludedKeys: readonly string[] = [],
): string[] {
  const populated: string[] = [];
  for (const [key, suffix] of [
    ['model', 'MODEL'],
    ['cwd', 'WORKING_DIR'],
    ['sessionId', 'SESSION_ID'],
    ['name', 'SESSION_NAME'],
    ['permissionMode', 'PERMISSION_MODE'],
    ['appendSystemPrompt', 'APPEND_SYSTEM_PROMPT'],
  ] as const) {
    if (excludedKeys.includes(key)) continue;
    if (key === 'cwd' && getStringArg(opts, 'workspace') !== undefined)
      continue;
    if (opts[key] !== undefined && opts[key] !== false) continue;
    const value = getTrimmedEnv(`${BRAND_ENV_PREFIX}${suffix}`);
    if (value === undefined) continue;
    opts[key] =
      key === 'permissionMode' ? normalizePermissionModeValue(value) : value;
    populated.push(key);
  }
  return populated.sort();
}
