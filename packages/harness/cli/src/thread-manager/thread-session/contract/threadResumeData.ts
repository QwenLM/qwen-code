/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Entry,
  FileHistorySnapshot,
  LlmGenerationConfig,
  Message,
  TranscriptResumeReadState,
  TranscriptWorktreeSession,
} from '@qwen-code/core';

export interface ThreadResumeData {
  readonly forkTranscriptEntries?: readonly Entry[];
  readonly resumeState: TranscriptResumeReadState;
  readonly messages: readonly Message[];
  readonly fileHistorySnapshots: readonly FileHistorySnapshot[];
  readonly sourceSessionId: string;
  /** 源会话最后一次真实模型响应的模型；优先取 runtimeConfig，缺失时从消息投影。 */
  readonly model?: string;
  readonly reasoningEffort?: string | null;
  readonly contextWindow?: number | null;
  readonly generation?: LlmGenerationConfig | null;
  /** 源会话的工作区目录（fork 产物与 SessionState 的目录事实）。 */
  readonly directories?: readonly string[];
  /** 目标 fork 的 worktree 状态；null 表示落在普通目录。 */
  readonly worktreeSession?: TranscriptWorktreeSession | null;
}
