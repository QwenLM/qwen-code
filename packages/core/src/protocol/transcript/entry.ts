/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Transcript JSONL entry types.
 *
 * This file extends runtime `Message` values with chain metadata and required
 * session fields, then combines them with non-message metadata entries that are
 * stored in the same transcript file.
 */

import type { FileHistorySnapshot } from '../../file-history/file-history.js';
import type { Message } from './message.js';
import type { LlmGenerationConfig } from '../../config/generation-config.js';

// ============================================================================
// TranscriptMessage — Message + chain metadata + session context
// ============================================================================

/**
 * A `Message` persisted in the JSONL transcript, enriched with:
 *
 * - `parentUuid` / `logicalParentUuid` / `isSidechain`
 *   These describe transcript relationships and are stripped when transcript
 *   entries are converted back to runtime messages.
 *
 * - required session stamps such as `cwd`, `sessionId`, `userType`, `version`
 *   These are required in the transcript so each persisted entry is
 *   self-describing.
 */
export type TranscriptMessage = Message & {
  parentUuid: string | null;
  logicalParentUuid?: string | null;
  isSidechain: boolean;
  cwd: string;
  sessionId: string;
  userType: string;
  version: string;
  timestamp: string;
  gitBranch?: string;
  agentId?: string;
  teamName?: string;
  agentName?: string;
  agentColor?: string;
  promptId?: string;
  forkedFrom?: {
    sessionId: string;
    messageUuid: string;
  };
};

// ============================================================================
// Metadata entry types — non-message JSONL entries
// ============================================================================

export type SummaryMessage = {
  type: 'summary';
  leafUuid: string;
  summary: string;
};

export type CustomTitleEntry = {
  type: 'custom-title';
  sessionId: string;
  customTitle: string;
};

export type AiTitleEntry = {
  type: 'ai-title';
  sessionId: string;
  aiTitle: string;
};

export type LastPromptEntry = {
  type: 'last-prompt';
  sessionId: string;
  lastPrompt: string;
};

export type TagEntry = {
  type: 'tag';
  sessionId: string;
  tag: string;
};

export type SessionMode = 'coordinator' | 'normal';

export type ModeEntry = {
  type: 'mode';
  sessionId: string;
  mode: SessionMode;
};

export type WorkspaceDirectoriesEntry = {
  type: 'workspace-directories';
  sessionId: string;
  directories: string[];
};

export type RuntimeConfigEntry = {
  type: 'runtime-config';
  sessionId: string;
  model?: string;
  reasoningEffort?: string | null;
  contextWindow?: number | null;
  /** Effective unified generation config for the current session/model. */
  generation?: LlmGenerationConfig | null;
  timestamp: number;
};

export type ContentReplacementEntry = {
  type: 'content-replacement';
  sessionId: string;
  agentId?: string;
  replacements: Array<{
    messageUuid: string;
    blockIndex: number;
    originalType: string;
    stubContent: string;
  }>;
};

export type FileHistorySnapshotEntry = {
  type: 'file-history-snapshot';
  messageId: string;
  snapshot: FileHistorySnapshot;
  isSnapshotUpdate: boolean;
};

export type TokenStatsEntry = {
  type: 'token-stats';
  sessionId: string;
  promptTokenCount: number;
  timestamp: number;
};

export type ActiveLeafEntry = {
  type: 'active-leaf';
  sessionId: string;
  leafUuid: string | null;
  explicit: boolean;
  rewound?: boolean;
  compactBoundaryUuid?: string;
  timestamp: number;
};

/** Records that the active session moved to a different project directory. */
export type RelocatedEntry = {
  type: 'relocated';
  sessionId: string;
  relocatedCwd: string;
};

/**
 * Worktree lifecycle state persisted with the main transcript.
 *
 * The common fields intentionally match the native worktree transcript shape.
 * `lifecycle` and `hookBased` retain the owner/attached safety semantics.
 */
export interface TranscriptWorktreeSession {
  originalCwd: string;
  /** Native-compatible pre-enter cwd; older producers may omit it. */
  preEnterOriginalCwd?: string;
  worktreePath: string;
  /** 历史 JSONL 可能缺失；新写入必须提供。 */
  worktreeCwd?: string;
  worktreeName: string;
  worktreeBranch?: string;
  originalBranch?: string;
  originalHeadCommit?: string;
  sessionId: string;
  lifecycle?: 'owner' | 'attached';
  hookBased?: boolean;
  /** Native-compatible marker for EnterWorktree({ path }). */
  enteredExisting?: boolean;
  /** 切换到当前 Worktree 后尚待释放 owner 的旧 checkout；只在交接期间存在。 */
  pendingOwnerReleasePath?: string;
  /** 退出已开始但尚未结算；恢复只释放 owner 并返回原项目，不自动删除 checkout。 */
  pendingExit?: true;
}

export type WorktreeStateEntry = {
  type: 'worktree-state';
  sessionId: string;
  worktreeSession: TranscriptWorktreeSession | null;
  /** 缺失 Worktree 回退时保留快照来源边界，后续普通 Resume 也不能接受旧的无 cwd 快照。 */
  discardLegacyFileHistorySnapshots?: true;
};

// ============================================================================
// Entry union — all JSONL entry types
// ============================================================================

/**
 * Discriminated union of all JSONL entry types.
 *
 * `TranscriptMessage` discriminates on `type` = MessageType
 * ('user' | 'assistant' | 'system' | 'progress' | 'tool_use_summary' | 'tombstone').
 *
 * Metadata entries discriminate on their own `type` string literals
 * ('summary' | 'custom-title' | 'ai-title' | 'last-prompt' | 'tag' | 'mode' | 'content-replacement').
 *
 * These are disjoint sets, so the union is properly discriminated.
 *
 * This starts with the entry types currently needed by transcript read/write
 * paths; additional variants can be added without changing the union shape.
 */
export type Entry =
  | TranscriptMessage
  | SummaryMessage
  | CustomTitleEntry
  | AiTitleEntry
  | LastPromptEntry
  | TagEntry
  | ModeEntry
  | WorkspaceDirectoriesEntry
  | RuntimeConfigEntry
  | ContentReplacementEntry
  | FileHistorySnapshotEntry
  | TokenStatsEntry
  | ActiveLeafEntry
  | RelocatedEntry
  | WorktreeStateEntry;

// ============================================================================
// Type guards
// ============================================================================

/**
 * Type guard for transcript entries that participate in persisted message
 * chains. Includes every attachment accepted by the transcript writer,
 * because later entries may use the attachment as their parent.
 */
export function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  if (entry.type === 'attachment') {
    return 'attachment' in entry;
  }
  return (
    entry.type === 'user' ||
    entry.type === 'assistant' ||
    entry.type === 'system'
  );
}
