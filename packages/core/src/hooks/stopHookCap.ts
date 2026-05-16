/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_STOP_HOOK_BLOCK_CAP = 8;
export const STOP_HOOK_BLOCK_CAP_ENV = 'QWEN_CODE_STOP_HOOK_BLOCK_CAP';

export function normalizeStopHookBlockingCap(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_STOP_HOOK_BLOCK_CAP;
  }

  const normalized = Math.floor(value);
  return normalized >= 1 ? normalized : DEFAULT_STOP_HOOK_BLOCK_CAP;
}

export function resolveStopHookBlockingCap(configValue?: number): number {
  const envValue = process.env[STOP_HOOK_BLOCK_CAP_ENV];
  if (envValue !== undefined) {
    const parsed = Number(envValue);
    return normalizeStopHookBlockingCap(parsed);
  }

  return normalizeStopHookBlockingCap(configValue);
}

export function formatStopHookBlockingCapWarning(
  hookLabel: 'Stop' | 'SubagentStop',
  cap: number,
): string {
  // Only Stop and SubagentStop hooks can request continuation after the
  // model or subagent would otherwise finish, so keep user-facing labels
  // explicit instead of accepting arbitrary hook names.
  const hookName = hookLabel === 'Stop' ? 'Stop hook' : 'SubagentStop hook';
  return `${hookName} blocked continuation ${cap} consecutive times; overriding and ending the turn.`;
}
