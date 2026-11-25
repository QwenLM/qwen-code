/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  resolveSessionWorktreeState,
  releasePersistedWorktreeSessionOwnership,
  SessionStateStore,
  type TranscriptWorktreeSession,
} from '@qwen-code/core';

type TranscriptDeletionStore = {
  deleteTranscript: (filePath: string) => Promise<void>;
};

type SessionTranscriptDeletionOptions = {
  sessionPath: string;
  sessionId: string;
  /** 会话 artifact 根用于读取和清理历史 Worktree sidecar。 */
  sessionArtifactProjectRoot?: string;
  /** 已解析的状态可避免在会话选择路径重复读取 JSONL。 */
  worktreeSession?: TranscriptWorktreeSession | null;
  transcriptStore: TranscriptDeletionStore;
  /** owner 结算成功后、删除恢复依据前清理关联产物；失败时保留 JSONL。 */
  beforeDelete?: () => Promise<void>;
};

/**
 * 在删除前结算 transcript 记录的 Worktree 生命周期权限。
 *
 * 若结算失败，调用方必须保留 transcript 与关联产物，
 * 让后续删除或恢复能够继续完成 owner/handoff 交接。
 */
export async function deleteSessionTranscript(
  options: SessionTranscriptDeletionOptions,
): Promise<void> {
  const sessionStateStore = options.sessionArtifactProjectRoot
    ? new SessionStateStore({
        projectRoot: options.sessionArtifactProjectRoot,
        sessionId: options.sessionId,
      })
    : undefined;

  const worktreeSession =
    options.worktreeSession !== undefined
      ? options.worktreeSession
      : await resolveSessionWorktreeState(
          options.sessionPath,
          options.sessionId,
          sessionStateStore,
          { failOnDecryptionError: true },
        );

  if (worktreeSession) {
    await releasePersistedWorktreeSessionOwnership(
      worktreeSession,
      options.sessionId,
    );
  }

  await options.beforeDelete?.();
  await options.transcriptStore.deleteTranscript(options.sessionPath);
  await sessionStateStore?.delete();
}
