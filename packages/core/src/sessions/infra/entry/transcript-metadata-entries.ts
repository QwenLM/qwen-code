/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface SummaryEntry {
  readonly type: 'summary';
  readonly leafUuid: string;
  readonly summary: string;
}

export interface CustomTitleEntry {
  readonly type: 'custom-title';
  readonly sessionId: string;
  readonly customTitle: string;
}

export interface AiTitleEntry {
  readonly type: 'ai-title';
  readonly sessionId: string;
  readonly aiTitle: string;
}

export interface LastPromptEntry {
  readonly type: 'last-prompt';
  readonly sessionId: string;
  readonly lastPrompt: string;
}

export interface TagEntry {
  readonly type: 'tag';
  readonly sessionId: string;
  readonly tag: string;
}

export interface WorkspaceDirectoriesEntry {
  readonly type: 'workspace-directories';
  readonly sessionId: string;
  readonly directories: readonly string[];
}

export interface ActiveLeafEntry {
  readonly type: 'active-leaf';
  readonly sessionId: string;
  readonly leafUuid: string | null;
  readonly explicit: boolean;
  readonly rewound?: boolean;
  readonly compactBoundaryUuid?: string;
  readonly timestamp: number;
}

// ============================================================================
// Legacy-aligned metadata entry types
// ============================================================================

/** Session operating mode. */
export type SessionMode = 'coordinator' | 'normal';

export interface ModeEntry {
  readonly type: 'mode';
  readonly sessionId: string;
  readonly mode: SessionMode;
}

/**
 * Runtime configuration snapshot persisted in the transcript.
 *
 * `generation` is intentionally typed as an opaque record to avoid coupling
 * with the runtime `LlmGenerationConfig` interface.
 */
export interface RuntimeConfigEntry {
  readonly type: 'runtime-config';
  readonly sessionId: string;
  readonly model?: string;
  readonly reasoningEffort?: string | null;
  readonly contextWindow?: number | null;
  readonly generation?: Record<string, unknown> | null;
  readonly timestamp: number;
}

/**
 * Declares that specific message blocks have been replaced with stub content
 * (e.g. for display or compaction purposes).
 */
export interface ContentReplacementEntry {
  readonly type: 'content-replacement';
  readonly sessionId: string;
  readonly agentId?: string;
  readonly replacements: ReadonlyArray<{
    readonly messageUuid: string;
    readonly blockIndex: number;
    readonly originalType: string;
    readonly stubContent: string;
  }>;
}

/**
 * File history snapshot persisted in the transcript.
 *
 * `snapshot` is intentionally typed as an opaque record to avoid coupling with
 * the runtime `FileHistorySnapshot` interface.
 */
export interface FileHistorySnapshotEntry {
  readonly type: 'file-history-snapshot';
  readonly messageId: string;
  readonly snapshot: Record<string, unknown>;
  readonly isSnapshotUpdate: boolean;
}

/** Prompt token count recorded for the session. */
export interface TokenStatsEntry {
  readonly type: 'token-stats';
  readonly sessionId: string;
  readonly promptTokenCount: number;
  readonly timestamp: number;
}

// ============================================================================
// Relocation entries
// ============================================================================

/** Records that the active session moved to a different project directory. */
export interface RelocatedEntry {
  readonly type: 'relocated';
  readonly sessionId: string;
  readonly relocatedCwd: string;
}

/**
 * Worktree lifecycle state persisted with the main transcript.
 *
 * The common fields intentionally match the native worktree transcript shape.
 * `lifecycle` and `hookBased` retain the owner/attached safety semantics.
 */
export interface TranscriptWorktreeSession {
  readonly originalCwd: string;
  /** Native-compatible pre-enter cwd; older producers may omit it. */
  readonly preEnterOriginalCwd?: string;
  readonly worktreePath: string;
  readonly worktreeName: string;
  readonly worktreeBranch?: string;
  readonly originalBranch?: string;
  readonly originalHeadCommit?: string;
  readonly sessionId: string;
  readonly lifecycle?: 'owner' | 'attached';
  readonly hookBased?: boolean;
  /** Native-compatible marker for EnterWorktree({ path }). */
  readonly enteredExisting?: boolean;
}

export interface WorktreeStateEntry {
  readonly type: 'worktree-state';
  readonly sessionId: string;
  readonly worktreeSession: TranscriptWorktreeSession | null;
}

