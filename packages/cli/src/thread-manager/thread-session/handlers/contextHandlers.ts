/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 上下文 / 回退能力组：`addDirectories` / `seedReadState` / `rewind` / `rewindFiles` /
 * `getContextUsage`。
 *
 * 入参是宿主归一后的产品语义值，返回产品语义结果，失败抛 `ThreadCapabilityError`（不带 code）。
 * `rewind` 的 rejected/partial 与 `rewindFiles` 的 canRewind:false 属于能力结果，不是异常。
 */

import path from 'node:path';
import {
  formatFileHistoryRewindFailure,
  getCommandQueueRevision,
  systemPromptToText,
  uiTelemetryService,
  type Config,
  type ConversationRewindPlan,
  type FileHistoryDiffStats,
} from '@qwen-code/core';
import { collectContextUsage } from '../../../services/contextUsage/contextUsageCollector.js';
import { projectContextUsageForSdk } from '../../../services/contextUsage/contextUsageProjection.js';
import type { ThreadCallContext } from '../contract/hostContext.js';
import type {
  ThreadAddDirectoriesResult,
  ThreadRewindResult,
} from '../contract/threadSessionTypes.js';
import {
  ThreadCapabilityError,
  type ThreadSessionInternals,
} from '../contract/handlerContract.js';

/**
 * 追加可信目录，并同步 permission 的 additionalDirectories。
 *
 * `added` 取调用前后 WorkspaceContext 的目录差集，比 result.added 更贴近最终事实。
 * 目录为空或含空白项抛 `missing or invalid directories`，其余错误取 `err.message`。
 */
export async function addDirectories(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  directories: readonly string[],
): Promise<ThreadAddDirectoriesResult> {
  const config = session.requireConfig();
  if (
    directories.length === 0 ||
    !directories.every(
      (directory) => typeof directory === 'string' && directory.trim(),
    )
  ) {
    throw new ThreadCapabilityError('missing or invalid directories');
  }

  try {
    return addWorkspaceDirectories(config, directories);
  } catch (err) {
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'add_directories failed',
    );
  }
}

/**
 * 把目录写进会话 WorkspaceContext，并同步 permission 的 additionalDirectories。
 *
 * 调用方负责目录校验；resume 恢复历史目录时复用同一份副作用，避免两处各自维护目录落地逻辑。
 */
export function addWorkspaceDirectories(
  config: Config,
  directories: readonly string[],
): ThreadAddDirectoriesResult {
  const workspaceContext = config.getWorkspaceContext();
  const beforeDirectories = new Set(workspaceContext.getDirectories());
  // core 的 addDirectories 收可变 string[]，声明入参是 readonly，故展开一份。
  const result = workspaceContext.addDirectories([...directories]);
  const workspaceDirectories = [...workspaceContext.getDirectories()];
  const addedDirectories = workspaceDirectories.filter(
    (directory) => !beforeDirectories.has(directory),
  );
  const trustedDirectories =
    addedDirectories.length > 0 ? addedDirectories : result.added;

  if (config.permission && result.added.length > 0) {
    config.permission.setAdditionalDirectories([
      ...config.permission.getAdditionalDirectories(),
      ...trustedDirectories,
    ]);
  }

  return {
    added: addedDirectories,
    failed: result.failed.map((failure) => ({
      path: failure.path,
      error: failure.error.message,
    })),
    directories: workspaceDirectories,
  };
}

/**
 * 预置文件读取状态，避免宿主已读文件被再次要求 Read。
 *
 * 状态写入 per-config 的 file-read state（按会话隔离），路径按 targetDir 解析为绝对路径，
 * 并标记 contentNotInModelContext。缺 path / mtime 非有限数分别抛 `missing path` /
 * `missing or invalid mtime`；写入异常取 `err.message`，均不带 code。
 */
export async function seedReadState(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  entries: ReadonlyArray<{ path: string; mtime: number }>,
): Promise<void> {
  const config = session.requireConfig();
  const fileStateCache =
    session.peekQueryRunner()?.getFileReadState() ?? config.fileReadState;
  const targetDir = config.getTargetDir();
  for (const entry of entries) {
    const filePath = entry.path;
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new ThreadCapabilityError('missing path');
    }
    const mtime = entry.mtime;
    if (typeof mtime !== 'number' || !Number.isFinite(mtime)) {
      throw new ThreadCapabilityError('missing or invalid mtime');
    }
    try {
      fileStateCache.set(path.resolve(targetDir, filePath), {
        contentNotInModelContext: true,
        content: '',
        timestamp: Math.floor(mtime),
        offset: undefined,
        limit: undefined,
      });
    } catch (err) {
      throw new ThreadCapabilityError(
        err instanceof Error ? err.message : 'seed_read_state failed',
      );
    }
  }
}

type RewindScope = 'conversation' | 'files' | 'both';

/** 缺省 `both`；非三值之一按 invalid 处理（抛 error，不是 reject）。 */
function parseRewindScope(value: unknown): RewindScope | undefined {
  const scope = value ?? 'both';
  return scope === 'conversation' || scope === 'files' || scope === 'both'
    ? scope
    : undefined;
}

/**
 * 会话分支回退与文件检查点回退，支持 dry_run 与部分失败。
 *
 * 拒绝也走 success 返回（`status:'rejected'` + error），调用方按 status 分支，抛异常会走进错误路径。
 * 空闲门禁须在 `assertReady` 回调里现读，并核对命令队列 revision：准备期间有输入进出就拒绝，
 * 否则回退会吞掉新输入。文件回退成功后删除涉及文件的读取状态，失败时整份 clear。
 */
// 全局单例：`getCommandQueueRevision` 读的是 core 模块级命令队列，别的会话入队也会让它变，
// 本会话回退可能被无关输入误判为「队列变了」；误判方向保守（只拒绝、不回退错）。
export async function rewind(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  request: { userMessageId: string; scope?: string; dryRun?: boolean },
): Promise<ThreadRewindResult> {
  const config = session.requireConfig();
  // 回退要求 idle，期间不会重新装配 runner，取一次即可。
  const runner = session.peekQueryRunner();
  const targetUserMessageId = request.userMessageId;
  if (typeof targetUserMessageId !== 'string') {
    throw new ThreadCapabilityError('missing user_message_id');
  }

  const scope = parseRewindScope(request.scope);
  if (!scope) {
    throw new ThreadCapabilityError('invalid rewind scope');
  }
  const dryRun = request.dryRun === true;
  const includesConversation = scope === 'conversation' || scope === 'both';
  const includesFiles = scope === 'files' || scope === 'both';
  const rejected = (error: string): ThreadRewindResult => ({
    status: 'rejected',
    targetUserMessageId,
    scope,
    error,
  });

  if (session.isTurnRunning() || session.queuedCommandUuids().length > 0) {
    return rejected(
      'Conversation rewind requires an idle session with no queued input.',
    );
  }
  if (!runner) {
    return rejected(
      'Conversation rewind requires an active local CLI session.',
    );
  }

  let conversationPlan: ConversationRewindPlan | undefined;
  let removedMessageIds: string[] | undefined;
  if (includesConversation) {
    try {
      conversationPlan =
        await runner.previewConversationRewind(targetUserMessageId);
      removedMessageIds = [...(conversationPlan.removedMessageIds ?? [])];
    } catch (error) {
      return rejected(
        error instanceof Error
          ? error.message
          : 'Conversation rewind target is not valid.',
      );
    }
  }

  const fileHistoryManager = includesFiles
    ? config.getFileHistoryManager()
    : undefined;
  let diffStats: FileHistoryDiffStats | undefined;
  if (includesFiles) {
    if (!fileHistoryManager) {
      return rejected('File checkpointing is not enabled.');
    }
    if (!fileHistoryManager.canRewind(targetUserMessageId)) {
      return rejected(
        `No file checkpoint found for user message ${targetUserMessageId}.`,
      );
    }
    try {
      diffStats = (await fileHistoryManager.getDiffStats(
        targetUserMessageId,
      )) ?? { filesChanged: [], insertions: 0, deletions: 0 };
    } catch (error) {
      return rejected(
        error instanceof Error
          ? error.message
          : 'Failed to inspect the file checkpoint.',
      );
    }
  }

  const baseResponse = {
    targetUserMessageId,
    scope,
    ...(conversationPlan
      ? {
          retainedLeafId: conversationPlan.retainedLeafUuid,
          removedMessageIds,
        }
      : {}),
    ...(diffStats
      ? {
          filesChanged: diffStats.filesChanged,
          insertions: diffStats.insertions,
          deletions: diffStats.deletions,
          ...(diffStats.failedFiles?.length
            ? { failedFiles: diffStats.failedFiles }
            : {}),
        }
      : {}),
  };

  if (dryRun) {
    return { status: 'ready', ...baseResponse };
  }

  if (includesConversation) {
    const rewindRevision = getCommandQueueRevision();
    try {
      conversationPlan = await runner.rewindConversation(targetUserMessageId, {
        getRevision: () => getCommandQueueRevision(),
        assertReady: () => {
          if (
            session.isTurnRunning() ||
            session.queuedCommandUuids().length > 0
          ) {
            throw new Error(
              'Conversation rewind requires an idle session with no queued input.',
            );
          }
          if (getCommandQueueRevision() !== rewindRevision) {
            throw new Error(
              'Conversation input changed while rewind was being prepared.',
            );
          }
        },
      });
    } catch (error) {
      return rejected(
        error instanceof Error
          ? error.message
          : 'Failed to rewind the conversation branch.',
      );
    }
  }

  let filesChanged = diffStats?.filesChanged ?? [];
  let failedFiles: Array<{ path: string; error: string }> = [];
  if (fileHistoryManager) {
    const readState = runner.getFileReadState() ?? config.fileReadState;
    try {
      const fileResult =
        await fileHistoryManager.rewindDetailed(targetUserMessageId);
      filesChanged = fileResult.filesChanged;
      failedFiles = fileResult.failedFiles;
      for (const file of [...filesChanged, ...failedFiles.map((f) => f.path)]) {
        readState.delete(path.resolve(config.getTargetDir(), file));
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to rewind the file checkpoint.';
      readState.clear();
      if (!includesConversation) {
        return rejected(message);
      }
      return {
        status: 'partial',
        ...baseResponse,
        filesChanged: [],
        failedFiles: [],
        error: `Conversation was rewound, but file restoration failed: ${message}`,
      };
    }
  }

  const status = failedFiles.length > 0 ? 'partial' : 'success';
  return {
    status,
    ...baseResponse,
    ...(includesFiles ? { filesChanged, failedFiles } : {}),
    ...(failedFiles.length > 0
      ? {
          error: `${failedFiles.length} file(s) could not be restored.`,
        }
      : {}),
  };
}

/**
 * 只回退文件检查点，不触碰会话分支。
 *
 * 非 dry_run 回退后删除涉及文件（含失败文件）的读取状态；异常路径整份 clear()，宁可让模型重新 Read。
 * canRewind:false 只表示无法完整恢复（未启用 / 无快照 / 部分失败），仍会列出已恢复文件；
 * `missing user_message_id` 抛异常，其余错误取 `err.message`。
 */
export async function rewindFiles(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  request: { userMessageId: string; dryRun?: boolean },
): Promise<ThreadRewindResult> {
  const config = session.requireConfig();
  const userMessageId = request.userMessageId;
  const dryRun = request.dryRun === true;
  if (typeof userMessageId !== 'string') {
    throw new ThreadCapabilityError('missing user_message_id');
  }
  try {
    const fileHistoryManager = config.getFileHistoryManager();
    if (!fileHistoryManager) {
      return {
        canRewind: false,
        error: 'file checkpointing is not enabled',
      };
    }

    if (!fileHistoryManager.canRewind(userMessageId)) {
      return {
        canRewind: false,
        error: `no snapshot found for message ${userMessageId}`,
      };
    }

    if (dryRun) {
      const diffStats = await fileHistoryManager.getDiffStats(userMessageId);
      return {
        canRewind: !diffStats?.failedFiles?.length,
        ...(diffStats?.failedFiles?.length
          ? {
              error:
                'Some files have no usable checkpoint backup: ' +
                diffStats.failedFiles.map((f) => f.path).join(', '),
            }
          : {}),
        filesChanged: diffStats?.filesChanged ?? [],
        insertions: diffStats?.insertions ?? 0,
        deletions: diffStats?.deletions ?? 0,
      };
    }

    const rewindResult = await fileHistoryManager.rewindDetailed(userMessageId);
    const filesChanged = rewindResult.filesChanged;
    const readState =
      session.peekQueryRunner()?.getFileReadState() ?? config.fileReadState;
    for (const file of [
      ...filesChanged,
      ...rewindResult.failedFiles.map((f) => f.path),
    ]) {
      readState.delete(path.resolve(config.getTargetDir(), file));
    }
    return {
      canRewind: rewindResult.failedFiles.length === 0,
      ...(rewindResult.failedFiles.length
        ? { error: formatFileHistoryRewindFailure(rewindResult) }
        : {}),
      filesChanged,
      insertions: 0,
      deletions: 0,
    };
  } catch (err) {
    if (!dryRun) {
      (
        session.peekQueryRunner()?.getFileReadState() ?? config.fileReadState
      ).clear();
    }
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'rewind_files failed',
    );
  }
}

/**
 * 汇总当前上下文占用并投影为 SDK 形状。
 *
 * 消息取本会话 runner；token 计数来自进程级 `uiTelemetryService`，同进程多会话并发时读数可能串，
 * 属已知缺口。异常抛 `<err.message 或 'get_context_usage failed'>`，不带 code。
 */
export async function getContextUsage(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
): Promise<Record<string, unknown>> {
  const config = session.requireConfig();
  try {
    const messages = session.peekQueryRunner()?.getMessages() ?? [];
    const requestSnapshot = config.getCacheSafeQuerySnapshot?.() ?? null;
    const systemPrompt = config.getSystemPrompt?.();
    const snapshot = await collectContextUsage({
      config,
      messages,
      requestSnapshot,
      cachedSystemPrompt: systemPrompt,
      cachedRenderedSystemPrompt: systemPrompt
        ? systemPromptToText(systemPrompt)
        : undefined,
      cachedParentToolSchemas: config.getParentToolSchemas?.(),
      session: {
        metrics: uiTelemetryService.getMetrics(),
      },
    });

    return projectContextUsageForSdk(snapshot);
  } catch (err) {
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'get_context_usage failed',
    );
  }
}
