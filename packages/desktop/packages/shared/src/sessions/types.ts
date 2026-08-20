/**
 * Session Types
 *
 * Types for workspace-scoped sessions.
 * Sessions are stored at {workspaceRootPath}/sessions/{id}/session.jsonl
 *
 * JSONL Format:
 * - Line 1: SessionHeader (metadata + pre-computed fields for fast list loading)
 * - Lines 2+: StoredMessage (one message per line)
 */

import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import type { StoredAttachment, MessageRole, ToolStatus, AuthRequestType, AuthStatus, CredentialInputMode, StoredMessage } from '@craft-agent/core/types';

/**
 * Session fields that persist to disk.
 * Add new fields here - they automatically propagate to JSONL read/write
 * via pickSessionFields() utility.
 *
 * IMPORTANT: When adding a new field:
 * 1. Add it to this array
 * 2. Add it to SessionConfig interface below
 * 3. Done - serialization is automatic
 */
export const SESSION_PERSISTENT_FIELDS = [
  // Identity
  'id', 'workspaceRootPath', 'sdkSessionId', 'sdkCwd',
  // Timestamps
  'createdAt', 'lastUsedAt', 'lastMessageAt',
  // Display
  'name', 'isFlagged', 'sessionStatus', 'labels', 'hidden',
  // Read tracking
  'lastReadMessageId', 'hasUnread',
  // Config
  'enabledSourceSlugs', 'workingDirectory',
  // Connection/runtime
  'thinkingLevel',
  // Sharing
  'sharedUrl', 'sharedId',
  // Plan execution
  'pendingPlanExecution',
  // Archive
  'isArchived', 'archivedAt',
  // Branching
  'branchFromMessageId',
  'branchFromSdkSessionId',
  'branchFromSessionPath',
  'branchFromSdkCwd',
  'branchFromSdkTurnId',
  // Remote transfer handoff
  'transferredSessionSummary',
  'transferredSessionSummaryApplied',
  // Automation origin
  'triggeredBy',
] as const;

export type SessionPersistentField = typeof SESSION_PERSISTENT_FIELDS[number];

/**
 * Session status (user-controlled, never automatic)
 *
 * Dynamic status ID referencing workspace status config.
 * Validated at runtime via validateSessionStatus().
 * Falls back to 'todo' if status doesn't exist.
 */
export type SessionStatus = string;

/**
 * Built-in status IDs (for TypeScript consumers)
 * These are the default statuses but users can add/remove custom ones
 */
export type BuiltInStatusId = 'todo' | 'in-progress' | 'needs-review' | 'done' | 'cancelled';

/**
 * Session token usage tracking
 */
export interface SessionTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  costUsd: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Model's context window size in tokens (from SDK modelUsage) */
  contextWindow?: number;
}

/**
 * Stored message format (simplified for persistence)
 * Re-exported from @craft-agent/core for convenience
 */
export type { StoredMessage } from '@craft-agent/core/types';

/**
 * Session configuration (persisted metadata)
 */
export interface SessionConfig {
  id: string;
  /** SDK session ID (captured after first message) */
  sdkSessionId?: string;
  /** Workspace root path this session belongs to */
  workspaceRootPath: string;
  /** Optional user-defined name */
  name?: string;
  createdAt?: number;
  lastUsedAt?: number;
  /** Timestamp of last meaningful message (user or final assistant). Used for date grouping in session list.
   *  Separate from lastUsedAt which tracks any session access (auto-save, open to read, etc.). */
  lastMessageAt?: number;
  /** Whether this session is flagged */
  isFlagged?: boolean;
  /** Legacy/runtime-only permission mode. New JSONL headers do not persist this field. */
  permissionMode?: PermissionMode;
  /** Legacy/runtime-only previous permission mode. New JSONL headers do not persist this field. */
  previousPermissionMode?: PermissionMode;
  /** User-controlled session status - determines inbox vs completed */
  sessionStatus?: SessionStatus;
  /** Labels applied to this session (bare IDs or "id::value" entries) */
  labels?: string[];
  /** ID of last message user has read */
  lastReadMessageId?: string;
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean;
  /** Per-session source selection (source slugs) */
  enabledSourceSlugs?: string[];
  /** Working directory for this session (used by agent for bash commands and context) */
  workingDirectory?: string;
  /** SDK cwd for session storage - set once at creation, never changes. Ensures SDK can find session transcripts regardless of workingDirectory changes. */
  sdkCwd?: string;
  /** Shared viewer URL (if shared via viewer) */
  sharedUrl?: string;
  /** Shared session ID in viewer (for revoke) */
  sharedId?: string;
  /** Runtime-only model override for this session. Provider-managed ACP sessions do not persist this field. */
  model?: string;
  /** Runtime-only LLM connection slug for this session */
  llmConnection?: string;
  /** Runtime-only connection lock state */
  connectionLocked?: boolean;
  /** Thinking level for this session ('off', 'think', 'max') */
  thinkingLevel?: ThinkingLevel;
  /**
   * Pending plan execution state - tracks "Accept & Compact" flow.
   * When set, indicates a plan needs to be executed after compaction completes.
   * Cleared on: successful execution, new user message, or manual clear.
   */
  pendingPlanExecution?: {
    /** Path to the plan file to execute */
    planPath: string;
    /** Optional snapshot of draft input captured at accept time */
    draftInputSnapshot?: string;
    /** Whether we're still waiting for compaction to complete */
    awaitingCompaction: boolean;
    /** Whether execution has already been dispatched from the UI. */
    executionDispatched?: boolean;
  };
  /** When true, session is hidden from session list (e.g., mini edit sessions) */
  hidden?: boolean;
  /** Whether this session is archived */
  isArchived?: boolean;
  /** Timestamp when session was archived (for retention policy) */
  archivedAt?: number;
  /**
   * Message ID this session was branched from.
   * Branching semantics are a hard cutoff: model context must not include parent messages after this message.
   */
  branchFromMessageId?: string;
  /**
   * Parent session's SDK session ID (optional, only for provider strategies that support strict SDK-level forking).
   */
  branchFromSdkSessionId?: string;
  /**
   * Parent session's storage path (optional, only when provider-level forking needs parent session files).
   */
  branchFromSessionPath?: string;
  /**
   * Parent session's sdkCwd (optional). Provider session files are stored per-CWD,
   * so forking requires the child subprocess to use the parent's CWD.
   */
  branchFromSdkCwd?: string;
  /**
   * Provider-native branch anchor at the branch point.
   */
  branchFromSdkTurnId?: string;
  /** One-shot hidden summary injected on the first turn after a remote transfer. */
  transferredSessionSummary?: string;
  /** Whether the transferred-session summary has already been injected. */
  transferredSessionSummaryApplied?: boolean;
  /** Metadata for sessions created by automations */
  triggeredBy?: { automationName?: string; event?: string; timestamp?: number };
}

/**
 * Stored session with conversation data
 */
export interface StoredSession extends SessionConfig {
  messages: StoredMessage[];
  tokenUsage: SessionTokenUsage;
}

/**
 * Session header - line 1 of session.jsonl
 *
 * Contains all metadata needed for list views (pre-computed at save time).
 * This enables fast session listing without parsing message content.
 */
export interface SessionHeader {
  id: string;
  /** SDK session ID (captured after first message) */
  sdkSessionId?: string;
  /** Workspace root path (stored as portable path, e.g., ~/.craft-agent/...) */
  workspaceRootPath: string;
  /** Optional user-defined name */
  name?: string;
  createdAt?: number;
  lastUsedAt?: number;
  /** Timestamp of last meaningful message — persisted separately from lastUsedAt for stable date grouping across restarts. */
  lastMessageAt?: number;
  /** Whether this session is flagged */
  isFlagged?: boolean;
  /** Legacy/runtime-only permission mode. New JSONL headers do not persist this field. */
  permissionMode?: PermissionMode;
  /** Legacy/runtime-only previous permission mode. New JSONL headers do not persist this field. */
  previousPermissionMode?: PermissionMode;
  /** User-controlled session status - determines inbox vs completed */
  sessionStatus?: SessionStatus;
  /** Labels applied to this session (bare IDs or "id::value" entries) */
  labels?: string[];
  /** ID of last message user has read */
  lastReadMessageId?: string;
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean;
  /** Per-session source selection (source slugs) */
  enabledSourceSlugs?: string[];
  /** Working directory for this session (used by agent for bash commands and context) */
  workingDirectory?: string;
  /** SDK cwd for session storage - set once at creation, never changes */
  sdkCwd?: string;
  /** Shared viewer URL (if shared via viewer) */
  sharedUrl?: string;
  /** Shared session ID in viewer (for revoke) */
  sharedId?: string;
  /** Legacy/runtime-only model override. New JSONL headers do not persist this field. */
  model?: string;
  /** Runtime-only LLM connection slug for this session */
  llmConnection?: string;
  /** Runtime-only connection lock state */
  connectionLocked?: boolean;
  /** Thinking level for this session ('off', 'think', 'max') */
  thinkingLevel?: ThinkingLevel;
  /**
   * Pending plan execution state - tracks "Accept & Compact" flow.
   * When set, indicates a plan needs to be executed after compaction completes.
   * Cleared on: successful execution, new user message, or manual clear.
   */
  pendingPlanExecution?: {
    /** Path to the plan file to execute */
    planPath: string;
    /** Optional snapshot of draft input captured at accept time */
    draftInputSnapshot?: string;
    /** Whether we're still waiting for compaction to complete */
    awaitingCompaction: boolean;
    /** Whether execution has already been dispatched from the UI. */
    executionDispatched?: boolean;
  };
  /** When true, session is hidden from session list (e.g., mini edit sessions) */
  hidden?: boolean;
  /** Whether this session is archived */
  isArchived?: boolean;
  /** Timestamp when session was archived (for retention policy) */
  archivedAt?: number;
  /** One-shot hidden summary injected on the first turn after a remote transfer. */
  transferredSessionSummary?: string;
  /** Whether the transferred-session summary has already been injected. */
  transferredSessionSummaryApplied?: boolean;
  /** Metadata for sessions created by automations */
  triggeredBy?: { automationName?: string; event?: string; timestamp?: number };
  // Pre-computed fields for fast list loading
  /** Number of messages in session, when known without loading the full transcript */
  messageCount?: number;
  /** Role/type of the last message (for badge display without loading messages) */
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error';
  /** Preview of first user message (first 150 chars) */
  preview?: string;
  /** Token usage statistics */
  tokenUsage?: SessionTokenUsage;
  /** ID of the last final (non-intermediate) assistant message - for unread detection without loading messages */
  lastFinalMessageId?: string;
}

/**
 * Session metadata (lightweight, for lists)
 */
export interface SessionMetadata {
  id: string;
  workspaceRootPath: string;
  name?: string;
  createdAt?: number;
  lastUsedAt?: number;
  /** Timestamp of last meaningful message — used for date grouping. Falls back to lastUsedAt for pre-fix sessions. */
  lastMessageAt?: number;
  messageCount?: number;
  /** Preview of first user message */
  preview?: string;
  sdkSessionId?: string;
  /** Whether this session is flagged */
  isFlagged?: boolean;
  /** User-controlled session status */
  sessionStatus?: SessionStatus;
  /** Labels applied to this session (bare IDs or "id::value" entries) */
  labels?: string[];
  /** Legacy/runtime-only permission mode. New session metadata does not persist this field. */
  permissionMode?: PermissionMode;
  /** Legacy/runtime-only previous permission mode. New session metadata does not persist this field. */
  previousPermissionMode?: PermissionMode;
  /** Number of plan files for this session */
  planCount?: number;
  /** Shared viewer URL (if shared via viewer) */
  sharedUrl?: string;
  /** Shared session ID in viewer (for revoke) */
  sharedId?: string;
  /** Working directory for this session */
  workingDirectory?: string;
  /** SDK cwd for session storage - set once at creation, never changes */
  sdkCwd?: string;
  /** Role/type of the last message (for badge display without loading messages) */
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error';
  /** Legacy/runtime-only model override. New session metadata does not persist this field. */
  model?: string;
  /** Runtime-only LLM connection slug for this session */
  llmConnection?: string;
  /** Runtime-only connection lock state */
  connectionLocked?: boolean;
  /** Thinking level for this session ('off', 'think', 'max') */
  thinkingLevel?: ThinkingLevel;
  /** ID of last message user has read - for unread detection */
  lastReadMessageId?: string;
  /** ID of the last final (non-intermediate) assistant message - for unread detection */
  lastFinalMessageId?: string;
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean;
  /** Token usage statistics (from JSONL header, available without loading messages) */
  tokenUsage?: SessionTokenUsage;
  /** When true, session is hidden from session list (e.g., mini edit sessions) */
  hidden?: boolean;
  /** Whether this session is archived */
  isArchived?: boolean;
  /** Timestamp when session was archived (for retention policy) */
  archivedAt?: number;
  /** Message ID that this session was branched from (hard context cutoff marker). */
  branchFromMessageId?: string;
}
