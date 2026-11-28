/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TranscriptEntry } from '../entry/transcript-entry.js';
import type { TranscriptMessageEntry } from '../entry/transcript-message-entry.js';
import type { DecodedTranscriptLine } from './decoded-line.js';
import type { EncodedTranscriptEntry } from './encoded-entry.js';

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

/**
 * Encodes exactly one complete JSONL record, including its trailing LF.
 *
 * Mirrors the legacy `encodeTranscriptEntry` behaviour.
 */
export function encodeTranscriptEntry(
  entry: TranscriptEntry,
): EncodedTranscriptEntry {
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
  if (text.length === 0) {
    return { kind: 'unknown', value: '' };
  }
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
  return {
    kind: 'entry',
    entry: normalizeDecodedEntry(value as TranscriptEntry),
  };
}

export function isKnownTranscriptEntryType(type: string): boolean {
  return KNOWN_ENTRY_TYPES.has(type);
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
    hasString(value, 'originalCwd') &&
    (value['preEnterOriginalCwd'] === undefined ||
      isString(value['preEnterOriginalCwd'])) &&
    hasString(value, 'worktreePath') &&
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
      isBoolean(value['enteredExisting']))
  );
}

/**
 * Older transcripts may omit chain fields; the reader normalizes them to the
 * current shape without rewriting the file.
 */
function normalizeDecodedEntry(entry: TranscriptEntry): TranscriptEntry {
  if (
    entry.type !== 'user' &&
    entry.type !== 'assistant' &&
    entry.type !== 'system' &&
    entry.type !== 'attachment'
  ) {
    return entry;
  }
  const message = entry as TranscriptMessageEntry & {
    parentUuid?: string | null;
    isSidechain?: boolean;
  };
  return {
    ...message,
    parentUuid: message.parentUuid ?? null,
    isSidechain: message.isSidechain ?? false,
  } as TranscriptEntry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function hasString(
  record: Record<string, unknown>,
  key: string,
): boolean {
  return isString(record[key]);
}

function hasNullableString(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  return value === null || isString(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}
