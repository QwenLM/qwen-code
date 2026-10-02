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
