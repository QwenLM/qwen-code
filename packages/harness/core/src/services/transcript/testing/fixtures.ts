/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { TranscriptStore } from '../store.js';
import type { TranscriptWriterHandle } from '../writer-handle.js';

export interface TestTranscriptWriterOptions {
  filePath: string;
  sessionId: string;
  cwd: string;
  entrypoint: string;
  userType?: string;
  version?: string;
  gitBranch?: string;
  flushIntervalMs?: number;
  initialWorkspaceDirectories?: readonly string[];
}

export async function createTestTranscriptWriter(
  options: TestTranscriptWriterOptions,
): Promise<{ writer: TranscriptWriterHandle; store: TranscriptStore }> {
  const store = new TranscriptStore({
    coordinatorOptions: {
      ...(options.flushIntervalMs !== undefined
        ? { flushIntervalMs: options.flushIntervalMs }
        : {}),
    },
  });
  const writer = await store.acquireSessionWriter({
    filePath: options.filePath,
    sessionId: options.sessionId,
    cwd: options.cwd,
    entrypoint: options.entrypoint,
    ...(options.userType ? { userType: options.userType } : {}),
    ...(options.version ? { version: options.version } : {}),
    ...(options.gitBranch ? { gitBranch: options.gitBranch } : {}),
    ...(options.initialWorkspaceDirectories
      ? { initialWorkspaceDirectories: options.initialWorkspaceDirectories }
      : {}),
  });
  return { writer, store };
}
