/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { isNetworkShapedPath } from '../utils/pathShape.js';
import { TranscriptRepository } from './transcript/repository.js';
import type { TranscriptWorktreeSession } from '../protocol/transcript/entry.js';

/** 原项目优先；历史目录仅来自已选 JSONL 中同会话、同原项目的记录。 */
export async function getSessionArtifactProjectRoots(
  projectRoot: string,
  sessionId: string,
  sessionTranscriptPath?: string,
  worktreeStates?: readonly TranscriptWorktreeSession[],
): Promise<string[]> {
  const originalRoot = path.resolve(projectRoot);
  const roots = new Set([originalRoot]);
  const addState = (state: TranscriptWorktreeSession) => {
    if (
      state.sessionId !== sessionId ||
      path.resolve(state.originalCwd) !== originalRoot
    )
      return;
    for (const cwd of [state.worktreeCwd, state.worktreePath]) {
      if (cwd && path.isAbsolute(cwd) && !isNetworkShapedPath(cwd))
        roots.add(path.resolve(cwd));
    }
  };
  if (worktreeStates !== undefined) {
    for (const state of worktreeStates) addState(state);
    return [...roots];
  }
  if (!sessionTranscriptPath) return [...roots];
  const index = await new TranscriptRepository().loadIndex(
    sessionTranscriptPath,
    { profile: { kind: 'metadata' } },
  );
  const entries = index?.entriesInFileOrder ?? [];
  for (let offset = entries.length - 1; offset >= 0; offset--) {
    const { entry } = entries[offset];
    if (entry.type !== 'worktree-state' || entry.sessionId !== sessionId)
      continue;
    const state = entry.worktreeSession;
    if (state) addState(state);
  }
  return [...roots];
}
