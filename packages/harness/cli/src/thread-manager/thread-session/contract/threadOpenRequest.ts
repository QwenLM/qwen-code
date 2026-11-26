/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  TranscriptSessionInfo,
  TranscriptWorktreeSession,
} from '@qwen-code/core';

/**
 * 入口翻译好的 fork 意图，Manager 只执行，不再从 `CliArgs` 反推 fork 语义。
 * daemon / SDK 胶水只填 `sourceSessionId` 与 `sourceTranscriptPath`，能解析的入口可以
 * 补上源 project bucket、已解析的会话信息与 worktree 目标，复用同一套 `createFork`。
 */
export interface ThreadForkRequest {
  readonly sourceSessionId: string;
  /** 源 transcript 绝对路径；入口解析，缺失时由 Manager 拒绝。 */
  readonly sourceTranscriptPath?: string;
  /** 源 transcript 所属的 project bucket；缺省按入口给的 target project root。 */
  readonly sourceProjectRoot?: string;
  /** 入口已解析的源会话信息（worktree / artifact root 等）；缺省由 Manager 投影。 */
  readonly sourceSessionInfo?: TranscriptSessionInfo;
  /** fork 产物的 project bucket；缺省按 cwd 的 realpath。 */
  readonly targetProjectRoot?: string;
  /** fork 产物的工作目录；缺省按 target project root 或目标 worktree。 */
  readonly targetCwd?: string;
  /** fork 是否接管源 worktree；缺省 null（不接管）。 */
  readonly targetWorktreeSession?: TranscriptWorktreeSession | null;
  /** 新会话标题；缺省沿用源标题。 */
  readonly targetTitle?: string;
  readonly resumeSessionAt?: string;
  readonly resumeDropsTurn?: string;
  /** checkpoint 迁移的严格模式。 */
  readonly strictFileHistoryRestore?: boolean;
}
