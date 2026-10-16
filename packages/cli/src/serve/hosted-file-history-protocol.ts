/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseManagedToolFileHistoryState } from '@qwen-code/qwen-code-core/tools/managed-tool-file-history-protocol.js';
import type { SerializedFileHistorySnapshot } from '@qwen-code/qwen-code-core/services/fileHistoryService.js';
import { normalizeWorkspaceRelativePath } from './managed-workspace-binding.js';

export interface HostedFileHistoryState {
  ownerSessionId: string;
  snapshots: SerializedFileHistorySnapshot[];
  files: Record<string, { digest: string; mode: number } | null>;
}

export type RawFileHistoryOperation =
  | {
      kind: 'raw-file-history';
      action: 'bind';
      state: HostedFileHistoryState | null;
    }
  | {
      kind: 'raw-file-history';
      action: 'prepare';
      promptId: string;
      paths: string[];
    }
  | { kind: 'raw-file-history'; action: 'snapshot' }
  | { kind: 'raw-file-history'; action: 'rewind'; promptId: string };

export function historyPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value === '.' ||
    normalizeWorkspaceRelativePath(value) !== value
  )
    throw new Error('Invalid Hosted file history path.');
  return value;
}

export function parseHostedFileHistoryState(
  value: unknown,
  owner: string,
): HostedFileHistoryState {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Hosted file history state.');
  const state = value as Record<string, unknown>;
  if (
    Object.keys(state).sort().join(',') !== 'files,ownerSessionId,snapshots' ||
    state['ownerSessionId'] !== owner
  )
    throw new Error('Hosted file history owner conflicts.');
  const { snapshots } = parseManagedToolFileHistoryState({
    ownerSessionId: owner,
    revision: 0,
    snapshots: state['snapshots'],
  });
  const paths = new Set(
    snapshots.flatMap((s) =>
      Object.keys(s.trackedFileBackups).map(historyPath),
    ),
  );
  const files = state['files'];
  if (
    !files ||
    typeof files !== 'object' ||
    Array.isArray(files) ||
    Object.keys(files).length !== paths.size
  )
    throw new Error('Hosted file history files conflict.');
  for (const [file, expected] of Object.entries(files)) {
    if (!paths.has(historyPath(file)))
      throw new Error('Hosted file history file is untracked.');
    if (
      expected !== null &&
      (typeof expected !== 'object' ||
        Array.isArray(expected) ||
        Object.keys(expected).sort().join(',') !== 'digest,mode' ||
        !/^sha256:[a-f0-9]{64}$/.test(expected.digest) ||
        !Number.isSafeInteger(expected.mode) ||
        expected.mode < 0 ||
        expected.mode > 0o7777)
    )
      throw new Error('Invalid Hosted file history file state.');
  }
  return structuredClone({
    ownerSessionId: owner,
    snapshots,
    files: files as HostedFileHistoryState['files'],
  });
}

export interface HostedFileHistoryRecord {
  schemaVersion: 1;
  state: HostedFileHistoryState;
  pendingTurn: string | null;
  pendingMessageId?: string;
  pendingUndo: { requestId: string; promptId: string } | null;
  undoReceipts?: Array<{
    requestId: string;
    promptId: string;
    filesChanged: string[];
    conflict: boolean;
  }>;
}

export const HOSTED_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function parseHostedFileHistoryRecord(
  value: unknown,
  owner: string,
): HostedFileHistoryRecord {
  const record = value as HostedFileHistoryRecord;
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    record.schemaVersion !== 1 ||
    !(record.pendingTurn === null || typeof record.pendingTurn === 'string') ||
    (record.pendingMessageId !== undefined &&
      (typeof record.pendingMessageId !== 'string' || !record.pendingTurn)) ||
    !(
      record.pendingUndo === null ||
      (typeof record.pendingUndo?.requestId === 'string' &&
        typeof record.pendingUndo.promptId === 'string')
    )
  )
    throw new Error('Invalid Hosted file history record.');
  const state = parseHostedFileHistoryState(record.state, owner);
  const undoReceipts =
    record.undoReceipts === undefined ? [] : record.undoReceipts;
  if (!Array.isArray(undoReceipts))
    throw new Error(
      'Invalid Hosted file history undo receipts: expected an array.',
    );
  const requests = new Set<string>();
  // Hosted rewind never truncates snapshots and prepare refuses at capacity.
  // Future retention (#13124) must prune dependent receipts in the same commit.
  const prompts = new Set(state.snapshots.map((snapshot) => snapshot.promptId));
  for (const [index, receipt] of undoReceipts.entries()) {
    const invalid = (reason: string): never => {
      throw new Error(
        `Invalid Hosted file history undo receipt ${index}: ${reason}.`,
      );
    };
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      Array.isArray(receipt) ||
      Object.keys(receipt).sort().join(',') !==
        'conflict,filesChanged,promptId,requestId'
    )
      invalid(
        'expected exactly requestId, promptId, filesChanged and conflict',
      );
    if (
      typeof receipt.requestId !== 'string' ||
      !HOSTED_UUID.test(receipt.requestId)
    )
      invalid('requestId must be a lowercase UUID v1-v5');
    if (
      typeof receipt.promptId !== 'string' ||
      !HOSTED_UUID.test(receipt.promptId)
    )
      invalid('promptId must be a lowercase UUID v1-v5');
    if (!prompts.has(receipt.promptId))
      invalid('promptId is not a retained snapshot');
    if (requests.has(receipt.requestId)) invalid('requestId is duplicated');
    if (typeof receipt.conflict !== 'boolean')
      invalid('conflict must be a boolean');
    if (!Array.isArray(receipt.filesChanged))
      invalid('filesChanged must be an array');
    if (
      receipt.filesChanged.some(
        (file) => typeof file !== 'string' || !Object.hasOwn(state.files, file),
      )
    )
      invalid('filesChanged must contain only tracked paths');
    if (new Set(receipt.filesChanged).size !== receipt.filesChanged.length)
      invalid('filesChanged contains duplicate paths');
    if (receipt.conflict && receipt.filesChanged.length !== 0)
      invalid('conflict must have no changed paths');
    if (
      record.pendingUndo?.requestId === receipt.requestId &&
      record.pendingUndo.promptId !== receipt.promptId
    )
      invalid('promptId does not match pendingUndo');
    requests.add(receipt.requestId);
  }
  return {
    schemaVersion: 1,
    state,
    pendingTurn: record.pendingTurn,
    ...(record.pendingMessageId !== undefined
      ? { pendingMessageId: record.pendingMessageId }
      : {}),
    pendingUndo: record.pendingUndo,
    undoReceipts,
  };
}
