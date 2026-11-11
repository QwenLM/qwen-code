/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * daemon open 的 fork：把源 transcript 复制成归新会话 id 的副本，并返回恢复数据。
 *
 * fork 必须显式复制——按新 id 去物化目录找 transcript 会得到空历史。源通过
 * `runtimeSnapshot` 传入：物化目录不在进程级配置根下，过不了 `createFork` 的
 * 包含性校验；目标 transcript 落在真实配置根，与 SessionState 同根。
 */

import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ForkSessionService,
  extractLastAssistantModelFromTranscript,
  runLogger,
  toAttachedForkWorktreeSession,
  TranscriptStore,
  type ForkSessionRuntimeSnapshot,
  type TranscriptSessionInfo,
  type TranscriptWorktreeSession,
} from '@qwen-code/core';
import type { ThreadResumeData } from '../thread-session/contract/threadResumeData.js';

export interface CreatedForkTranscript extends ThreadResumeData {
  readonly sessionPath: string;
  /** 目标 transcript 所属的 project root；回滚时用它做路径归属校验。 */
  readonly projectRoot: string;
}

/** fork 产物 → ThreadSession 的恢复数据。 */
export function toThreadResumeData(
  fork: CreatedForkTranscript,
): ThreadResumeData {
  return {
    forkTranscriptEntries: fork.forkTranscriptEntries,
    resumeState: fork.resumeState,
    messages: fork.messages,
    fileHistorySnapshots: fork.fileHistorySnapshots,
    sourceSessionId: fork.sourceSessionId,
    ...(fork.model === undefined ? {} : { model: fork.model }),
    ...(fork.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: fork.reasoningEffort }),
    ...(fork.contextWindow === undefined
      ? {}
      : { contextWindow: fork.contextWindow }),
    ...(fork.generation === undefined ? {} : { generation: fork.generation }),
    ...(fork.directories === undefined
      ? {}
      : { directories: fork.directories }),
    ...(fork.worktreeSession === undefined
      ? {}
      : { worktreeSession: fork.worktreeSession }),
  };
}

/**
 * open 在 fork 之后、会话装配之前失败时，删掉刚创建的 fork 产物（transcript /
 * SessionState / checkpoint）。fork 自身的中途失败由 `createFork` 回滚；这里补的是
 * 「fork 已成功、session 没建成」这段生命周期。
 */
export async function rollbackForkTranscript(input: {
  readonly fork: CreatedForkTranscript;
  readonly sessionId: string;
  readonly originalError?: unknown;
}): Promise<void> {
  const store = new TranscriptStore();
  try {
    await new ForkSessionService(store).deleteForkArtifacts({
      projectRoot: input.fork.projectRoot,
      sessionId: input.sessionId,
      sessionPath: input.fork.sessionPath,
      originalError: input.originalError,
    });
  } finally {
    await store.close();
  }
}

/** 与 `materializedTranscript.ts` 的 projectKey 派生同源：先 resolve 再 realpath，失败退回绝对路径。 */
async function canonicalCwd(cwd: string | undefined): Promise<string> {
  const absolute = resolve(cwd ?? process.cwd());
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

/**
 * 从源 transcript fork 出 `targetSessionId` 的副本，返回路径与恢复数据。
 * 源不可读时抛错，不退化成空会话。
 */
export async function createForkTranscript(input: {
  /** 入口解析出的源 transcript 绝对路径（物化目录或真实配置根均可）。 */
  readonly sourcePath: string;
  /** 源会话 id（`--resume` 的值）。 */
  readonly sourceSessionId: string;
  /** 源 transcript 所属的 project bucket；缺省按目标 project root 投影会话信息。 */
  readonly sourceProjectRoot?: string;
  /** 入口已解析的源会话信息（worktree / artifact root）；缺省由 transcript 投影。 */
  readonly sourceSessionInfo?: TranscriptSessionInfo;
  /** fork 出来的新会话 id（必须是合法 UUID，`createFork` 会校验）。 */
  readonly targetSessionId: string;
  /** 目标 transcript 的 project bucket；缺省按 cwd 的 realpath。 */
  readonly targetProjectRoot?: string;
  /** 目标工作目录；缺省按目标 worktree 或 project root。 */
  readonly targetCwd?: string;
  /** fork 是否接管源 worktree；缺省 null。 */
  readonly targetWorktreeSession?: TranscriptWorktreeSession | null;
  /** 新会话标题；缺省沿用源标题。 */
  readonly targetTitle?: string;
  /** checkpoint 迁移的严格模式；缺省非严格。 */
  readonly strictFileHistoryRestore?: boolean;
  readonly cwd?: string;
  /** Retain creation entries only for the initial mirror replay. */
  readonly sessionMirror?: boolean;
  /**
   * `--resume-session-at`：只保留源历史链到该 entry UUID（含）；缺席即整链 fork。
   * 截断在 sessionId 改写前按源 UUID 选取；命中不到直接抛错，不产出带陈旧分支的会话。
   */
  readonly resumeSessionAt?: string;
  /** `--resume-drops-turn`：截断丢弃的必须正好是这一轮，否则拒绝（防陈旧视图误删新到达的工作）。 */
  readonly resumeDropsTurn?: string;
}): Promise<CreatedForkTranscript> {
  const startedAt = Date.now();
  const log = (
    phase: string,
    event: 'started' | 'finished' | 'failed',
    details?: Record<string, unknown>,
  ) => {
    runLogger.log('[fork-transcript]', {
      phase,
      event,
      sourceSessionId: input.sourceSessionId,
      targetSessionId: input.targetSessionId,
      ...details,
    });
  };
  log('open', 'started');
  const storeStartedAt = Date.now();
  const store = new TranscriptStore();
  log('store_open', 'finished', { durationMs: Date.now() - storeStartedAt });
  try {
    // 只读解析：historical 视图保留 pre-compact 历史，flush-pending 与 readPersistedSource 同式。
    const resolveStartedAt = Date.now();
    const resolved = await store.repository().readForFork(input.sourcePath, input.sourceSessionId);
    log('resolve_source', 'finished', {
      durationMs: Date.now() - resolveStartedAt,
      entries: resolved?.chain.length ?? 0,
      snapshots: resolved?.fileHistorySnapshots.length ?? 0,
    });
    if (!resolved) {
      throw new Error(
        `fork source transcript "${input.sourceSessionId}" is not loadable`,
      );
    }

    const metadata = resolved.metadata;
    const sourceId = input.sourceSessionId;
    const directories = metadata.workspaceDirectories.get(sourceId);
    const runtimeConfig = metadata.runtimeConfigs.get(sourceId);
    const mode = metadata.modes.get(sourceId);
    const tag = metadata.tags.get(sourceId);
    const customTitle = metadata.customTitles.get(sourceId);
    const aiTitle = metadata.aiTitles.get(sourceId);
    const lastPrompt = metadata.lastPrompts.get(sourceId);
    const contentReplacements = resolved.contentReplacements.get(sourceId);
    const sourceWorktree = metadata.worktreeSessions.get(sourceId);

    // 字段映射与 ForkSessionService.readPersistedSource 同式；messages 不必给——
    // readRuntimeSnapshot 会按 transcriptChain 用 runtime 投影自己算。
    const runtimeSnapshot: ForkSessionRuntimeSnapshot = {
      transcriptChain: [...resolved.chain],
      fileHistorySnapshots: [...resolved.fileHistorySnapshots],
      directories: directories ? [...directories] : undefined,
      workspaceDirectories: directories ? [...directories] : undefined,
      runtimeConfig,
      mode,
      tag,
      customTitle,
      aiTitle,
      lastPrompt,
      contentReplacements: contentReplacements
        ? contentReplacements.map((replacement) => ({ ...replacement }))
        : [],
    };

    const cwdStartedAt = Date.now();
    // 入口没声明目标 worktree 时继承源会话的：fork 接管当前 checkout（lifecycle 降为
    // attached、不带源会话的清理权）。显式传 null 表示落在普通目录，尊重入参。
    const targetWorktreeSession =
      input.targetWorktreeSession !== undefined
        ? input.targetWorktreeSession
        : sourceWorktree
          ? toAttachedForkWorktreeSession(sourceWorktree, input.targetSessionId)
          : null;
    // 目标标题缺省沿用源标题（custom 优先、ai 兜底）；有 title 时才写
    // custom-title，否则源标题会丢失。
    const targetTitle = input.targetTitle ?? customTitle ?? aiTitle;
    // projectRoot 是目标 transcript 的归属桶：接管 worktree 时落在主仓根（originalCwd），
    // 而不是 worktree 路径自己的桶，后续按主仓根的 resume / list 才找得到它。
    const projectRoot =
      input.targetProjectRoot ??
      targetWorktreeSession?.originalCwd ??
      (await canonicalCwd(input.cwd));
    const targetCwd =
      input.targetCwd ??
      targetWorktreeSession?.worktreeCwd ??
      targetWorktreeSession?.worktreePath ??
      projectRoot;
    log('canonical_cwd', 'finished', {
      durationMs: Date.now() - cwdStartedAt,
    });
    const forkStartedAt = Date.now();
    const fork = await new ForkSessionService(store).createFork({
      projectRoot,
      targetCwd,
      sourceSessionId: input.sourceSessionId,
      // runtimeSnapshot 是权威源；不能把物化目录的 sourcePath 当作 sourceSessionPath
      // 传进去——createFork 的包含性校验会按配置根拼出另一个路径并拒绝。
      sourceProjectRoot: input.sourceProjectRoot,
      sourceSessionInfo: input.sourceSessionInfo,
      targetSessionId: input.targetSessionId,
      targetTitle,
      strictFileHistoryRestore: input.strictFileHistoryRestore,
      runtimeSnapshot,
      // 截断点在源头（source UUID）命中，必须在 createFork 里做——它改写 sessionId 之后
      // 就再也认不出源 UUID 了。缺席时 selectForkSourceAt 原样返回整链。
      ...(input.resumeSessionAt === undefined
        ? {}
        : { resumeSessionAt: input.resumeSessionAt }),
      ...(input.resumeDropsTurn === undefined
        ? {}
        : { resumeDropsTurn: input.resumeDropsTurn }),
      targetWorktreeSession,
    });
    log('create_fork', 'finished', {
      durationMs: Date.now() - forkStartedAt,
      messages: fork.messages?.length ?? 0,
      snapshots: fork.fileHistorySnapshots?.length ?? 0,
    });
    log('total', 'finished', { durationMs: Date.now() - startedAt });
    return {
      sessionPath: fork.sessionPath,
      projectRoot,
      ...(input.sessionMirror ? { forkTranscriptEntries: fork.entries } : {}),
      resumeState: fork.resumeState,
      messages: fork.messages,
      fileHistorySnapshots: fork.fileHistorySnapshots,
      sourceSessionId: input.sourceSessionId,
      // 运行时恢复事实：headless / ACP 迁移到 ThreadManager 后直接消费这些字段，
      // 不再从 fork 的 messages / runtimeConfig 重新拼 resumedSessionData。
      model:
        fork.runtimeConfig?.model ??
        extractLastAssistantModelFromTranscript(fork.messages),
      reasoningEffort: fork.runtimeConfig?.reasoningEffort,
      contextWindow: fork.runtimeConfig?.contextWindow,
      generation: fork.runtimeConfig?.generation,
      directories: fork.directories ?? undefined,
      worktreeSession: fork.worktreeSession,
    };
  } finally {
    // 独立 store 只为这一次读源 + 写副本，没有长活写入器；关掉释放协调器，避免泄漏。
    const closeStartedAt = Date.now();
    await store.close();
    log('close_store', 'finished', {
      durationMs: Date.now() - closeStartedAt,
    });
  }
}
