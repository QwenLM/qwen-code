/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { getSessionTranscriptPath } from './transcript-paths.js';
import { runLogger } from '../utils/runLogger.js';
import { isNodeError } from '../utils/errors.js';

export interface LegacyWorktreeTranscriptMigrationRequest {
  sessionId: string;
  selectedPath: string;
  originalCwd: string;
  /** Writer 已打开后执行的排他迁移；底层负责并发与回滚。 */
  relocate: (originalCwd: string) => Promise<void>;
}

function normalizeFilePath(filePath: string): string {
  return path.resolve(filePath).normalize('NFC');
}

/**
 * 只收敛 Resolver 已选中的历史 JSONL。目标冲突或 I/O 失败时保留当前
 * Writer，不覆盖、不合并，也不删除任一副本。
 */
export async function migrateLegacyWorktreeTranscript(
  request: LegacyWorktreeTranscriptMigrationRequest,
): Promise<void> {
  const targetPath = getSessionTranscriptPath(
    request.originalCwd,
    request.sessionId,
  );
  if (
    normalizeFilePath(targetPath) === normalizeFilePath(request.selectedPath)
  ) {
    return;
  }

  try {
    // 关联产物不能与主 JSONL 分步移动：部分复制失败会失去恢复来源，
    // 目标同 ID 副本也不能混合。保留整份历史会话，由 Writer 精确路径定位产物。
    const artifactsDir = path.join(
      path.dirname(request.selectedPath),
      request.sessionId,
    );
    const artifacts = await fs.readdir(artifactsDir).catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      throw error;
    });
    if (artifacts.length > 0) {
      runLogger.debug(
        '[worktree-legacy] retaining selected transcript with associated artifacts',
      );
      return;
    }
    await request.relocate(request.originalCwd);
  } catch (error) {
    runLogger.debug(
      `[worktree-legacy] transcript migration skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
