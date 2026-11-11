/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FileHistorySnapshot } from '../file-history/file-history.js';
import { SYNTHETIC_MODEL } from '../protocol/provider/request-converter.js';
import type { Message } from '../protocol/transcript/message.js';
import type { LlmGenerationConfig } from '../config/generation-config.js';
import type {
  Entry,
  TranscriptWorktreeSession,
} from '../protocol/transcript/entry.js';
import { assertResumeDropsTurn } from './resumeSessionAt.js';
import { filterUnresolvedToolUses } from './transcript/resume-projector.js';
import type { ProjectedTranscriptSession } from './transcript/resume-projector.js';
import { selectHistoricalLineage } from './transcript/historical-lineage.js';
import type { TranscriptResumeReadState, ResumeTranscriptResult } from './transcript/repository.js';
import type { AcquireSessionWriterOptions } from './transcript/store.js';
import { ResumeReadError, type ResumeReadAttempt } from './transcript/resume-read-budget.js';
import { SessionStateStore } from './session-state-store.js';
import {
  getLegacyWorktreeState,
  projectLegacyWorktreeState,
} from './legacyWorktreeSessionState.js';
import * as path from 'node:path';

/**
 * Runtime data required to resume or fork an existing session.
 */
export interface SessionResumeData {
  sessionId: string;
  messages: Message[];
  directories?: string[];
  fileHistorySnapshots?: FileHistorySnapshot[];
  sourceSessionId?: string;
  /** Fork 的源 Transcript 精确路径，只用于本次恢复历史产物，不持久化。 */
  sourceSessionPath?: string;
  /** Target transcript created before the headless mirror observer is installed. */
  forkTranscriptPath?: string;
  forkTranscriptEntries?: readonly Entry[];
  /** Fail Fork initialization when any required checkpoint blob cannot copy. */
  strictFileHistoryRestore?: boolean;
  /** Model used by the last real assistant response in the resumed transcript. */
  model?: string;
  /** Reasoning effort selected by the resumed session runtime config. */
  reasoningEffort?: string | null;
  /** Context window selected by the resumed session runtime config; null means explicitly cleared. */
  contextWindow?: number | null;
  /** Generation config selected by the resumed session; null means explicitly cleared. */
  generation?: LlmGenerationConfig | null;
  /** Writer 要绑定的 Transcript 路径；Fork 时为新会话文件，不能代替 sourceSessionPath。 */
  sessionPath?: string;
  /** The project root that owns the source transcript bucket (for writer/state rebinding). */
  transcriptProjectRoot?: string;
  /** 从历史记录推导的逻辑项目根，仅用于本次恢复，不新增持久化字段。 */
  originalCwd?: string;
  /** Latest worktree state folded from the source transcript. */
  worktreeSession?: TranscriptWorktreeSession | null;
  /** Stored custom title of the resumed session, when it has one. */
  customTitle?: string;
  /** 精确恢复读取的临时初始化数据；恢复结束后释放，不写入 JSONL。 */
  transcriptReadState?: TranscriptResumeReadState;
  /** 冷恢复临时 owner 字段；绑定失效仍保留，由编排层在 finally 结束。 */
  readonly resumeAttempt?: ResumeReadAttempt;
  /** 同进程入口向 ThreadManager 转交候选，避免重复读取与嵌套准入。 */
  readonly resumeCandidate?: ResumeTranscriptResult;
}

/** 将 Writer 的快照失效重读同步回本次恢复数据，保持消息与持久化链来自同一版本。 */
export function createSessionResumeWriterBinding(
  data: SessionResumeData,
  projectRoot: string,
): AcquireSessionWriterOptions['resume'] {
  const state = data.transcriptReadState;
  if (
    !state ||
    (data.resumeAttempt &&
      state.attempt &&
      data.resumeAttempt !== state.attempt) ||
    state.sessionId !== data.sessionId ||
    (data.sessionPath &&
      path.resolve(data.sessionPath) !== path.resolve(state.filePath)) ||
    (data.sourceSessionId && data.sourceSessionId !== data.sessionId) ||
    (data.messages.at(-1)?.uuid ?? null) !== state.runtimeTailUuid
  ) {
    if (data.resumeAttempt) throw new ResumeReadError('unsafe');
    return undefined;
  }
  const originalRoot =
    data.worktreeSession?.originalCwd ?? data.originalCwd ?? projectRoot;
  return {
    state,
    finishOnAccept: data.resumeAttempt !== undefined,
    onRefresh: async (fresh, nextState) => {
      // Config 已按首次选择加载，不能在接管 Writer 时悄悄扩大或更换工作区边界。
      if (
        JSON.stringify(state.writerState.workspaceDirectories ?? []) !==
        JSON.stringify(nextState.writerState.workspaceDirectories ?? [])
      ) {
        throw new Error(
          'Workspace directories changed during resume. Please select the session again.',
        );
      }
      const metadata = fresh.metadata;
      const activeLeaf = metadata.activeLeaves.get(data.sessionId);
      const explicitlyEmpty =
        activeLeaf?.explicit && activeLeaf.leafUuid === null;
      if (
        fresh.messages.length === 0 &&
        !metadata.worktreeSessions.get(data.sessionId) &&
        !explicitlyEmpty
      ) {
        throw new Error(
          'The transcript was cleared during resume. Please select the session again.',
        );
      }
      let worktreeSession = metadata.worktreeSessions.get(data.sessionId);
      if (worktreeSession === undefined) {
        const legacy = await getLegacyWorktreeState(
          new SessionStateStore({
            projectRoot: originalRoot,
            sessionId: data.sessionId,
          }),
        );
        worktreeSession = legacy
          ? projectLegacyWorktreeState(legacy)
          : undefined;
      }
      const nextOriginalRoot =
        worktreeSession?.originalCwd ??
        nextState.worktreeStates[0]?.originalCwd;
      if (
        nextOriginalRoot &&
        path.resolve(nextOriginalRoot) !== path.resolve(originalRoot)
      ) {
        throw new Error(
          'The session project changed during resume. Please select the session again.',
        );
      }
      const messages = fresh.messages;
      const fileHistorySnapshots = [...fresh.fileHistorySnapshots];
      const originalCwd = nextOriginalRoot ?? data.originalCwd;
      const customTitle = metadata.customTitles.get(data.sessionId);
      const runtime = metadata.runtimeConfigs.get(data.sessionId);
      const model =
        runtime?.model ?? extractLastAssistantModelFromTranscript(messages);
      const reasoningEffort = runtime?.reasoningEffort;
      const contextWindow = runtime?.contextWindow;
      const generation = runtime?.generation;
      // 准备完成不发布；只有最终快照校验后的同步提交才能修改已接线数据。
      return () => {
        // 保持消息数组身份，不使用大数组参数展开。
        data.messages.length = 0;
        for (const message of messages) data.messages.push(message);
        data.fileHistorySnapshots = fileHistorySnapshots;
        data.worktreeSession = worktreeSession;
        data.originalCwd = originalCwd;
        data.customTitle = customTitle;
        data.model = model;
        data.reasoningEffort = reasoningEffort;
        data.contextWindow = contextWindow;
        data.generation = generation;
        data.transcriptReadState = nextState;
      };
    },
  };
}

/** 视频恢复复用已读历史，并补入 sidecar 状态及运行时恢复/进入后确定的目录。 */
export function getResumeArtifactWorktreeStates(
  data: SessionResumeData,
  runtimeWorktreeStates: ReadonlyArray<
    TranscriptWorktreeSession | null | undefined
  > = [],
): readonly TranscriptWorktreeSession[] | undefined {
  const state = data.transcriptReadState;
  if (
    !state ||
    state.sessionId !== data.sessionId ||
    (data.sessionPath &&
      path.resolve(data.sessionPath) !== path.resolve(state.filePath))
  )
    return undefined;
  return [
    ...state.worktreeStates,
    ...[data.worktreeSession, ...runtimeWorktreeStates].filter(
      (worktree): worktree is TranscriptWorktreeSession => !!worktree,
    ),
  ];
}

/** Selects a historical resume point from an already projected conversation. */
export function selectSessionResumePoint(
  messages: readonly Message[],
  fileHistorySnapshots: readonly FileHistorySnapshot[] | undefined,
  resumeSessionAt: string | undefined,
  resumeDropsTurn?: string,
): {
  messages: Message[];
  fileHistorySnapshots: FileHistorySnapshot[] | undefined;
} {
  if (!resumeSessionAt) {
    return {
      messages: [...messages],
      fileHistorySnapshots: fileHistorySnapshots
        ? [...fileHistorySnapshots]
        : undefined,
    };
  }
  const cutoff = messages.findIndex(
    (message) => message.uuid === resumeSessionAt,
  );
  if (cutoff < 0) {
    throw new Error(`Resume point "${resumeSessionAt}" was not found.`);
  }
  assertResumeDropsTurn(messages.slice(cutoff + 1), resumeDropsTurn);
  const selectedMessages = messages.slice(0, cutoff + 1);
  return {
    messages: [...filterUnresolvedToolUses(selectedMessages)],
    fileHistorySnapshots: fileHistorySnapshots
      ? [...fileHistorySnapshots]
      : undefined,
  };
}

/** Selects a cold-resume point from the complete historical lineage. */
export function selectHistoricalSessionResumePoint(
  session: ProjectedTranscriptSession,
  resumeSessionAt: string,
  resumeDropsTurn?: string,
): {
  messages: Message[];
  fileHistorySnapshots: FileHistorySnapshot[];
} {
  const selection = selectHistoricalLineage(
    session.chain,
    resumeSessionAt,
    'through-target',
  );
  if (!selection) {
    throw new Error(`Resume point "${resumeSessionAt}" was not found.`);
  }
  assertResumeDropsTurn(selection.discardedChain, resumeDropsTurn);
  return {
    messages: [...selection.runtimeMessages],
    fileHistorySnapshots: [...session.fileHistorySnapshots],
  };
}

export function extractLastAssistantModelFromTranscript(
  messages: readonly Message[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.type !== 'assistant') {
      continue;
    }
    if (
      message.isMeta ||
      message.isCompactSummary ||
      message.isApiErrorMessage
    ) {
      continue;
    }

    const rawModel = message.message.model;
    const model = typeof rawModel === 'string' ? rawModel.trim() : '';
    if (!model || model === SYNTHETIC_MODEL) {
      continue;
    }

    return model;
  }

  return undefined;
}

export type { Message };
