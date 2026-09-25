/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WriteTextFileRequest } from '@agentclientprotocol/sdk';

export const TOOL_WRITE_ORIGIN_META_KEY =
  'qwen-code/tool-write-origin' as const;

export const TOOL_WRITE_ORIGINS = [
  'write_file',
  'edit',
  'notebook_edit',
  'shell_sed_edit',
] as const;

export type ToolWriteOrigin = (typeof TOOL_WRITE_ORIGINS)[number];

const TOOL_WRITE_ORIGIN_SET: ReadonlySet<string> = new Set(TOOL_WRITE_ORIGINS);

export function buildToolWriteOriginMeta(
  meta: WriteTextFileRequest['_meta'],
  source: ToolWriteOrigin | undefined,
): WriteTextFileRequest['_meta'] {
  const sanitized = { ...meta };
  delete sanitized[TOOL_WRITE_ORIGIN_META_KEY];
  if (source !== undefined) {
    sanitized[TOOL_WRITE_ORIGIN_META_KEY] = { version: 1, source };
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function parseToolWriteOriginMeta(
  meta: WriteTextFileRequest['_meta'],
): ToolWriteOrigin | undefined {
  const marker = meta?.[TOOL_WRITE_ORIGIN_META_KEY];
  if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) {
    return undefined;
  }
  const keys = Object.keys(marker);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(marker, 'version') ||
    !Object.hasOwn(marker, 'source')
  ) {
    return undefined;
  }
  const record = marker as Record<string, unknown>;
  return record['version'] === 1 &&
    typeof record['source'] === 'string' &&
    TOOL_WRITE_ORIGIN_SET.has(record['source'])
    ? (record['source'] as ToolWriteOrigin)
    : undefined;
}
