/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Entry } from '../../protocol/transcript/entry.js';
import * as path from 'node:path';
import { isFsTouchUnsafePath } from '../../utils/pathShape.js';

const KNOWN_ENTRY_TYPES = new Set([
  'user',
  'assistant',
  'system',
  'attachment',
  'summary',
  'custom-title',
  'ai-title',
  'last-prompt',
  'tag',
  'workspace-directories',
  'runtime-config',
  'mode',
  'content-replacement',
  'file-history-snapshot',
  'token-stats',
  'active-leaf',
  'relocated',
  'worktree-state',
]);

export interface EncodedTranscriptEntry {
  readonly entry: Entry;
  readonly bytes: Buffer;
}

export type DecodedTranscriptLine =
  | { readonly kind: 'entry'; readonly entry: Entry }
  | {
      readonly kind: 'unknown';
      readonly value: unknown;
      readonly type?: string;
    }
  | {
      readonly kind: 'invalid-shape';
      readonly value: unknown;
      readonly type: string;
    }
  | { readonly kind: 'malformed'; readonly error: SyntaxError };

/**
 * Encodes exactly one complete JSONL record, including its trailing LF.
 * Entry size is intentionally unrestricted: the persisted protocol does not
 * define a maximum record size.
 */
export function encodeTranscriptEntry(entry: Entry): EncodedTranscriptEntry {
  return {
    entry,
    bytes: Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8'),
  };
}

/** Decodes one JSONL record without applying graph or resume semantics. */
export function decodeTranscriptLine(
  line: Buffer | string,
): DecodedTranscriptLine {
  const text = typeof line === 'string' ? line : line.toString('utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      kind: 'malformed',
      error:
        error instanceof SyntaxError
          ? error
          : new SyntaxError(
              error instanceof Error ? error.message : String(error),
            ),
    };
  }

  const type = getEntryType(value);
  if (!type || !KNOWN_ENTRY_TYPES.has(type)) {
    return { kind: 'unknown', value, ...(type ? { type } : {}) };
  }
  if (!hasValidKnownEntryShape(value, type)) {
    return { kind: 'invalid-shape', value, type };
  }
  return { kind: 'entry', entry: normalizeDecodedEntry(value as Entry) };
}

function getEntryType(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return isString(value['type']) ? value['type'] : undefined;
}

function hasValidKnownEntryShape(
  value: unknown,
  type: string,
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  switch (type) {
    case 'user':
    case 'assistant':
      return (
        hasString(value, 'uuid') &&
        hasString(value, 'timestamp') &&
        isRecord(value['message'])
      );
    case 'system':
      return (
        hasString(value, 'uuid') &&
        hasString(value, 'timestamp') &&
        (value['requiresActiveLeafCommit'] === undefined ||
          isBoolean(value['requiresActiveLeafCommit']))
      );
    case 'attachment':
      return (
        hasString(value, 'uuid') &&
        hasNullableString(value, 'parentUuid') &&
        isBoolean(value['isSidechain']) &&
        hasString(value, 'timestamp') &&
        hasString(value, 'cwd') &&
        hasString(value, 'sessionId') &&
        hasString(value, 'userType') &&
        hasString(value, 'version')
      );
    case 'summary':
      return hasString(value, 'leafUuid') && hasString(value, 'summary');
    case 'custom-title':
      return hasString(value, 'sessionId') && hasString(value, 'customTitle');
    case 'ai-title':
      return hasString(value, 'sessionId') && hasString(value, 'aiTitle');
    case 'last-prompt':
      return hasString(value, 'sessionId') && hasString(value, 'lastPrompt');
    case 'tag':
      return hasString(value, 'sessionId') && hasString(value, 'tag');
    case 'workspace-directories':
      return (
        hasString(value, 'sessionId') &&
        Array.isArray(value['directories']) &&
        value['directories'].every(isString)
      );
    case 'runtime-config':
      return hasString(value, 'sessionId') && isNumber(value['timestamp']);
    case 'mode':
      return (
        hasString(value, 'sessionId') &&
        (value['mode'] === 'normal' || value['mode'] === 'coordinator')
      );
    case 'content-replacement':
      return (
        hasString(value, 'sessionId') && Array.isArray(value['replacements'])
      );
    case 'file-history-snapshot':
      return (
        hasString(value, 'messageId') &&
        isRecord(value['snapshot']) &&
        isBoolean(value['isSnapshotUpdate'])
      );
    case 'token-stats':
      return (
        hasString(value, 'sessionId') &&
        isNumber(value['promptTokenCount']) &&
        isNumber(value['timestamp'])
      );
    case 'active-leaf':
      return (
        hasString(value, 'sessionId') &&
        hasNullableString(value, 'leafUuid') &&
        isBoolean(value['explicit']) &&
        (value['rewound'] === undefined || isBoolean(value['rewound'])) &&
        (value['compactBoundaryUuid'] === undefined ||
          (isString(value['compactBoundaryUuid']) &&
            value['explicit'] === false)) &&
        isNumber(value['timestamp'])
      );
    case 'relocated':
      return hasString(value, 'sessionId') && hasString(value, 'relocatedCwd');
    case 'worktree-state':
      return (
        hasString(value, 'sessionId') &&
        (value['discardLegacyFileHistorySnapshots'] === undefined ||
          value['discardLegacyFileHistorySnapshots'] === true) &&
        (value['worktreeSession'] === null ||
          hasValidWorktreeSession(value['worktreeSession']))
      );
    default:
      return false;
  }
}

function hasValidWorktreeSession(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasSafeAbsolutePath(value, 'originalCwd') &&
    (value['preEnterOriginalCwd'] === undefined ||
      hasSafeAbsolutePath(value, 'preEnterOriginalCwd')) &&
    hasSafeAbsolutePath(value, 'worktreePath') &&
    (value['worktreeCwd'] === undefined ||
      hasSafeAbsolutePath(value, 'worktreeCwd')) &&
    hasString(value, 'worktreeName') &&
    hasString(value, 'sessionId') &&
    (value['worktreeBranch'] === undefined ||
      isString(value['worktreeBranch'])) &&
    (value['originalBranch'] === undefined ||
      isString(value['originalBranch'])) &&
    (value['originalHeadCommit'] === undefined ||
      isString(value['originalHeadCommit'])) &&
    (value['lifecycle'] === undefined ||
      value['lifecycle'] === 'owner' ||
      value['lifecycle'] === 'attached') &&
    (value['hookBased'] === undefined || isBoolean(value['hookBased'])) &&
    (value['enteredExisting'] === undefined ||
      isBoolean(value['enteredExisting'])) &&
    (value['pendingExit'] === undefined || value['pendingExit'] === true) &&
    (value['pendingOwnerReleasePath'] === undefined ||
      hasSafeAbsolutePath(value, 'pendingOwnerReleasePath'))
  );
}

function hasSafeAbsolutePath(
  value: Record<string, unknown>,
  key: string,
): boolean {
  const candidate = value[key];
  return (
    isString(candidate) &&
    candidate.length > 0 &&
    path.isAbsolute(candidate) &&
    !isFsTouchUnsafePath(candidate)
  );
}

/**
 * 历史 transcript 允许直接写入 runtime message，因而可能缺少持久化上下文字段。
 * Reader 只补齐图解析必需的链字段；Writer 仍始终写出完整的自描述记录。
 */
function normalizeDecodedEntry(entry: Entry): Entry {
  if (
    entry.type !== 'user' &&
    entry.type !== 'assistant' &&
    entry.type !== 'system'
  ) {
    return entry;
  }
  const message = entry as Entry & {
    parentUuid?: string | null;
    isSidechain?: boolean;
  };
  return {
    ...message,
    parentUuid: message.parentUuid || null,
    isSidechain: message.isSidechain ?? false,
  } as Entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return isString(value[key]);
}

function hasNullableString(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return value[key] === null || isString(value[key]);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}
