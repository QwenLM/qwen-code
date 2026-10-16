/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';

export type ModPermission = 'allow' | 'ask' | 'deny';
export interface ModToolCallInput extends Record<string, unknown> {
  tool: string;
  tool_use_id?: string;
  agentId?: string;
}
export interface ModToolCheckInput extends Record<string, unknown> {
  tool: string;
  input: unknown;
  tool_use_id?: string;
  agentId?: string;
  ceiling?: ModPermission;
}
export interface ModToolCheckResult {
  decision: ModPermission;
  reason?: string;
  rule?: string;
  hook?: string;
  ceiling?: ModPermission;
}
export type ModToolResult =
  | { deny: string }
  | {
      result: unknown;
      ref?: number;
      text?: string;
      isError?: true;
      isReadOnly?: true;
    };
export type ModToolCheck = (
  input: ModToolCheckInput,
  verdict: ModToolCheckResult,
  signal: AbortSignal,
) => Promise<ModToolCheckResult>;
export type ModToolNext = (
  input: ModToolCallInput,
  signal: AbortSignal,
  check: ModToolCheck,
) => Promise<ModToolResult>;
export type ModToolCall = (
  input: ModToolCallInput,
  next: ModToolNext,
  signal: AbortSignal,
) => Promise<ModToolResult>;

export const MOD_TOOL_RESERVED = [
  'tool',
  'tool_use_id',
  'agentId',
  'consent',
  'requestMeta',
  '$shadowed',
] as const;

export function validateToolInput(
  value: Record<string, unknown>,
  original: Record<string, unknown>,
): void {
  for (const key of MOD_TOOL_RESERVED) {
    if (
      Object.hasOwn(value, key) !== Object.hasOwn(original, key) ||
      !isDeepStrictEqual(value[key], original[key])
    )
      throw new Error('Mod hook changed pinned tool fields.');
  }
}

export function validToolResult(value: Record<string, unknown>): boolean {
  if ('deny' in value)
    return Object.keys(value).length === 1 && typeof value['deny'] === 'string';
  return (
    Object.hasOwn(value, 'result') &&
    Object.keys(value).every((key) =>
      ['result', 'ref', 'text', 'isError', 'isReadOnly'].includes(key),
    ) &&
    (value['ref'] === undefined ||
      (Number.isSafeInteger(value['ref']) && Number(value['ref']) > 0)) &&
    (value['text'] === undefined || typeof value['text'] === 'string') &&
    (value['isError'] === undefined || value['isError'] === true) &&
    (value['isReadOnly'] === undefined || value['isReadOnly'] === true)
  );
}

export function validToolCheck(value: Record<string, unknown>): boolean {
  return (
    typeof value['decision'] === 'string' &&
    ['allow', 'ask', 'deny'].includes(value['decision']) &&
    Object.keys(value).every((key) =>
      ['decision', 'reason', 'rule', 'hook', 'ceiling'].includes(key),
    ) &&
    ['reason', 'rule', 'hook'].every(
      (key) => value[key] === undefined || typeof value[key] === 'string',
    ) &&
    (value['ceiling'] === undefined ||
      (typeof value['ceiling'] === 'string' &&
        ['allow', 'ask', 'deny'].includes(value['ceiling'])))
  );
}
