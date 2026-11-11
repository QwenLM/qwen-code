/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Per-request Attachment type definitions.
 *
 * Attachment is a discriminated union type representing all categories of
 * context that can be dynamically injected into the LLM request on every
 * turn. Attachments are persisted with the conversation so a resumed or
 * forked session can reproduce the original provider prefix.
 *
 * Architecture:
 *   getAttachments() → Attachment[]
 *   normalizeAttachmentForAPI() → UserMessage[]
 *   inject into conversationMessages before streamProviderRequest()
 *
 */

import type { FileStateCache } from '../utils/fileStateCache.js';
import type { TranscriptAttachment } from '../protocol/transcript/message.js';
import type { SubagentActivityItem } from '../agents/types.js';
import type { PendingHookOutput } from '../hooks/types.js';
import type { PermissionMode } from '../permissions/manager/decision/index.js';
import type { ScopedMemoryIndexFileState } from '../memory/memory-index.js';
import type { RuleFileState } from '../utils/memoryDiscovery.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import type {
  AgentMentionAttachment,
  PeerMentionAttachment,
  AgentListingDeltaAttachment,
  TeamContextAttachment,
} from './models/agent-attachments.js';
export {
  AgentMentionAttachment,
  PeerMentionAttachment,
  AgentListingDeltaAttachment,
  TeamContextAttachment,
} from './models/agent-attachments.js';
import type {
  AutoModeAttachment,
  AutoModeExitAttachment,
} from './models/auto-mode-attachments.js';
export {
  AutoModeAttachment,
  AutoModeExitAttachment,
} from './models/auto-mode-attachments.js';
import type { QueuedCommandAttachment } from './models/command-attachments.js';
export { QueuedCommandAttachment } from './models/command-attachments.js';
import type { EnvironmentAttachment } from './models/environment-attachment.js';
export { EnvironmentAttachment } from './models/environment-attachment.js';
import type { SessionContextAttachment } from './models/session-context-attachment.js';
export { SessionContextAttachment } from './models/session-context-attachment.js';
import type {
  FileAttachment,
  ImageFileAttachment,
  InvalidImageFileAttachment,
  AlreadyReadFileAttachment,
  CompactFileReferenceAttachment,
  PDFReferenceAttachment,
  PDFFileAttachment,
  EditedTextFileAttachment,
  EditedImageFileAttachment,
  DirectoryAttachment,
} from './models/file-attachments.js';
export {
  FileAttachment,
  ImageFileAttachment,
  InvalidImageFileAttachment,
  AlreadyReadFileAttachment,
  CompactFileReferenceAttachment,
  PDFReferenceAttachment,
  PDFFileAttachment,
  EditedTextFileAttachment,
  EditedImageFileAttachment,
  DirectoryAttachment,
} from './models/file-attachments.js';
import type { GoalStateAttachment } from './models/goal-attachments.js';
export { GoalStateAttachment } from './models/goal-attachments.js';
import type {
  TurnBudgetGuidanceAttachment,
  TurnBudgetExhaustedAttachment,
  RemainingTurnsAttachment,
  AdditionalTurnsAttachment,
} from './models/turn-attachments.js';
export {
  TurnBudgetGuidanceAttachment,
  TurnBudgetExhaustedAttachment,
  RemainingTurnsAttachment,
  AdditionalTurnsAttachment,
} from './models/turn-attachments.js';
import type {
  HookOutputAttachment,
  HookBlockingErrorAttachment,
  HookNonBlockingErrorAttachment,
  HookErrorDuringExecutionAttachment,
  HookSuccessAttachment,
  HookCancelledAttachment,
  HookStoppedContinuationAttachment,
  HookSystemMessageAttachment,
  HookPermissionDecisionAttachment,
} from './models/hook-attachments.js';
export {
  HookOutputAttachment,
  HookBlockingErrorAttachment,
  HookNonBlockingErrorAttachment,
  HookErrorDuringExecutionAttachment,
  HookSuccessAttachment,
  HookCancelledAttachment,
  HookStoppedContinuationAttachment,
  HookSystemMessageAttachment,
  HookPermissionDecisionAttachment,
} from './models/hook-attachments.js';
import type {
  McpInstructionsDeltaAttachment,
  McpLazyToolsDeltaAttachment,
  McpResourceAttachment,
} from './models/mcp-attachments.js';
export {
  McpInstructionsDeltaAttachment,
  McpLazyToolsDeltaAttachment,
  McpResourceAttachment,
} from './models/mcp-attachments.js';
import type {
  RelevantMemoriesAttachment,
  CurrentSessionMemoryAttachment,
} from './models/memory-attachments.js';
export {
  RelevantMemoriesAttachment,
  CurrentSessionMemoryAttachment,
} from './models/memory-attachments.js';
import type {
  PlanFileReferenceAttachment,
  PlanModeAttachment,
  PlanModeReentryAttachment,
  PlanModeExitAttachment,
  VerifyPlanReminderAttachment,
} from './models/plan-attachments.js';
export {
  PlanFileReferenceAttachment,
  PlanModeAttachment,
  PlanModeReentryAttachment,
  PlanModeExitAttachment,
  VerifyPlanReminderAttachment,
} from './models/plan-attachments.js';
import type { PostCompactRestoredFilesAttachment } from './models/restore-attachments.js';
export { PostCompactRestoredFilesAttachment } from './models/restore-attachments.js';
import type {
  SkillListingAttachment,
  InvokedSkillsAttachment,
} from './models/skill-attachments.js';
export {
  SkillListingAttachment,
  InvokedSkillsAttachment,
} from './models/skill-attachments.js';
import type {
  DateChangeAttachment,
  CriticalSystemReminderAttachment,
  StreamInterruptionAttachment,
  TokenUsageAttachment,
  CompactionReminderAttachment,
} from './models/system-attachments.js';
export {
  DateChangeAttachment,
  CriticalSystemReminderAttachment,
  StreamInterruptionAttachment,
  TokenUsageAttachment,
  CompactionReminderAttachment,
} from './models/system-attachments.js';
import type {
  TaskReminderAttachment,
  TodoReminderAttachment,
} from './models/task-attachments.js';
export {
  TaskReminderAttachment,
  TodoReminderAttachment,
} from './models/task-attachments.js';
import type {
  WorkflowKeywordRequestAttachment,
  UltraEffortEnterAttachment,
  UltraEffortExitAttachment,
} from './models/workflow-attachments.js';
export {
  WorkflowKeywordRequestAttachment,
  UltraEffortEnterAttachment,
  UltraEffortExitAttachment,
} from './models/workflow-attachments.js';

/** Public data members of an attachment, without its prototype methods. */
export type AttachmentData<T> = {
  [K in keyof T as T[K] extends (...args: never[]) => unknown
    ? never
    : K]: T[K];
};

/**
 * Sub-union of all hook attachment types (for precise type narrowing).
 */
export type HookAttachment =
  | HookBlockingErrorAttachment
  | HookNonBlockingErrorAttachment
  | HookErrorDuringExecutionAttachment
  | HookSuccessAttachment
  | HookCancelledAttachment
  | HookStoppedContinuationAttachment
  | HookSystemMessageAttachment
  | HookPermissionDecisionAttachment;

/** A single subagent's current state and activity. */
export interface SubagentProgressEntry {
  agentName: string;
  state?: string;
  result?: string;
  recentActivity: SubagentActivityItem[];
  color?: string;
}

// ============================================================================
// Attachment union type
// ============================================================================

/**
 * Discriminated union of all attachment types.
 * New attachment types must extend BaseAttachment, join this union, and be
 * registered for restoration in transcript-conversion.ts.
 */
export type Attachment =
  // ── File & Content ──
  | FileAttachment
  | ImageFileAttachment
  | InvalidImageFileAttachment
  | AlreadyReadFileAttachment
  | CompactFileReferenceAttachment
  | PDFReferenceAttachment
  | PDFFileAttachment
  | EditedTextFileAttachment
  | EditedImageFileAttachment
  | DirectoryAttachment
  // ── Memory system ──
  | RelevantMemoriesAttachment
  | CurrentSessionMemoryAttachment
  | PlanFileReferenceAttachment
  // ── Skills ──
  | SkillListingAttachment
  | InvokedSkillsAttachment
  // ── Mode & State ──
  | PlanModeAttachment
  | PlanModeReentryAttachment
  | PlanModeExitAttachment
  | GoalStateAttachment
  | TurnBudgetGuidanceAttachment
  | TurnBudgetExhaustedAttachment
  | RemainingTurnsAttachment
  | AdditionalTurnsAttachment
  | AutoModeAttachment
  | AutoModeExitAttachment
  | VerifyPlanReminderAttachment
  // ── System & State ──
  | EnvironmentAttachment
  | SessionContextAttachment
  | DateChangeAttachment
  | CriticalSystemReminderAttachment
  | StreamInterruptionAttachment
  | WorkflowKeywordRequestAttachment
  | UltraEffortEnterAttachment
  | UltraEffortExitAttachment
  | TokenUsageAttachment
  | CompactionReminderAttachment
  // ── Queue & Commands ──
  | QueuedCommandAttachment
  // ── Task & Agent ──
  | TaskReminderAttachment
  | TodoReminderAttachment
  | AgentMentionAttachment
  | PeerMentionAttachment
  | AgentListingDeltaAttachment
  // ── System Deltas ──
  | McpInstructionsDeltaAttachment
  | McpLazyToolsDeltaAttachment
  | McpResourceAttachment
  // ── Hook outputs ──
  | HookOutputAttachment
  | HookAttachment
  // ── Agent swarms ──
  | TeamContextAttachment
  // ── Post-compact restore ──
  | PostCompactRestoredFilesAttachment;

// ============================================================================
// AttachmentMessage — transcript-level container
// ============================================================================

/**
 * AttachmentMessage wraps attachment data with uuid and timestamp for the
 * message transcript. It is the unit yielded by getAttachmentMessages().
 *
 * Note: Persisted to disk through the session transcript writer handle.
 */
export interface AttachmentMessage {
  type: 'attachment';
  attachment: TranscriptAttachment;
  uuid: string; // crypto.randomUUID()
  timestamp: string; // ISO 8601
  /** Retained session prefix; shared with runtime transcript messages. */
  isCompactionPrefix?: boolean;
}

// ============================================================================
// ToolUseContext — dependency injection for attachment generators
// ============================================================================

/**
 * Context passed to all attachment generators.
 *
 * Provides access to shared state needed for deduplication, file tracking,
 * and agent identity. This is the main dependency injection surface for
 * the attachment pipeline.
 */
export interface AttachmentToolUseContext {
  /** Tool baselines are separate from the attachment diff cache below. */
  fileReadState: FileStateCache;
  /**
   * LRU cache tracking files already read into LLM context.
   * Used for deduplication (already_read_file) and change detection
   * (edited_text_file / edited_image_file).
   */
  readFileState: FileStateCache;

  /**
   * Current agent identifier. Used for per-agent skill tracking and
   * queued command routing.
   */
  agentId?: string;

  /**
   * True when this context belongs to the top-level QueryEngine session
   * (i.e. the main agent, not a sub-agent). Used to distinguish the main
   * agent from sub-agents when computing `isSubAgent` on plan attachments,
   * since the main agent also carries a non-empty `agentId` (its sessionId).
   */
  isMainAgent?: boolean;

  /** Current working directory. Used for display path computation. */
  cwd: string;

  /**
   * The rules and trusted directories the attachment channel checks paths
   * against.
   *
   * An `@` reference reads a file without being a tool call: there is no
   * toolUseId and nothing to prompt about, so it cannot go through
   * `checkPermission`. It consults the rules directly instead, which is what
   * makes a user's `Read(...)` deny apply to attachments too. Absent, the
   * guard derives the same context live from the `permission` module below.
   */
  permissionPaths?: import('../tools/tool-checkers/checker-reasons.js').PathPermissionContext;

  /**
   * The session's permission module, threaded so attachment generators can
   * read the live mode and honor the deny-rule guard. Undefined until the
   * host threads it in.
   */
  permission?: import('../permissions/manager/session-permission-manager.js').SessionPermissionManager;

  /**
   * Config reference threaded alongside `permission` for attachment
   * generators that need session state. Undefined until the host threads it
   * in.
   */
  config?: import('../config/config.js').Config;

  /**
   * Set of nested memory file paths already loaded in this session.
   * Persists across LRU eviction to prevent AGENTS.md re-injection.
   * Also used by getRelevantMemoriesAttachments() for delta detection.
   */
  loadedNestedMemoryPaths: Set<string>;

  /**
   * Per-agent skill tracking: maps agentId → Set of already-sent skill names.
   * Used to implement delta logic (only send new/changed skills).
   */
  sentSkillNames: Map<string, Set<string>>;

  /**
   * Per-agent fingerprint of the last skill listing actually injected.
   * Hot reloads clear `sentSkillNames` so the next turn can resend, but most
   * reload triggers (settings edits, trust changes, plugin reloads) leave the
   * listing unchanged — re-injecting it would only add noise to the context.
   */
  sentSkillListingFingerprints?: Map<string, string>;

  /**
   * Most recent local date observed by getDateChangeAttachments() when no
   * stable startup date is available. Normal session deduplication uses the
   * model-visible message history.
   */
  lastDateSeen?: string;

  // ── Delta tracking fields ──

  /**
   * Whether seedStaticMemoryPaths() has run the first-turn seed.
   * Reset to false after compaction so the seed re-runs.
   */
  isFirstTurnSeedDone?: boolean;

  /**
   * Absolute path to the current session's plan file, kept in sync by
   * QueryEngine via two mechanisms:
   *   - human-turn boundary (submitMessage): covers the normal case
   *   - PermissionModeChanged listener: covers mid-turn entry via enter_plan_mode
   *
   * Used by getPlanModeInterTurnAttachment() so inter-turn reminders include
   * the plan file path without needing PlanStateManager.
   * Undefined until plan mode is first entered.
   */
  currentPlanFilePath?: string;

  /**
   * One-shot flag set by QueryEngine's PermissionModeChanged listener when the
   * mode transitions into PLAN mid-turn (e.g. enter_plan_mode tool executes).
   *
   * Consumed (read + reset) by getPlanModeInterTurnAttachment(): the first
   * inter-turn injection after entering plan mode emits a 'full' reminder
   * instead of 'sparse', so the model receives the complete 5-phase workflow
   * instructions in the same turn it entered plan mode.
   *
   * Reset to false after consumption; never set by human-turn boundary sync.
   */
  planModeJustEntered?: boolean;

  /**
   * One-shot flag set by the PermissionModeChanged listener (QueryEngine and TUI
   * orchestrator) when the mode transitions OUT of PLAN mid-turn.
   *
   * Causes the next inter-turn injection to emit a plan_mode_exit attachment
   * so the model immediately knows it can proceed without waiting for the next
   * human turn. The flag is also consumed by the inter-turn path to disarm the
   * planStateManager exit flag, preventing a duplicate injection on the next turn.
   */
  planModeJustExited?: boolean;

  /**
   * One-shot flag set at the start of each inter-turn injection and cleared at
   * human-turn boundaries. Prevents the sparse plan_mode reminder from firing
   * more than once per assistant turn (i.e., once per round of tool calls).
   */
  interTurnSparseEmittedThisTurn?: boolean;

  /**
   * SHA-1 hash of the last emitted subagent progress list.
   * Used by getTeamContextAttachment() to detect changes.
   */
  lastSubagentHash?: string;

  /**
   * Set of MCP server names whose instructions have already been announced
   * (emitted as mcp_instructions_delta attachments). Used by
   * getMcpInstructionsDeltaAttachments() to compute added/removed delta.
   *
   * Should be reset after compaction to force re-announcement.
   */
  announcedMcpInstructionServers: Set<string>;

  /**
   * Qualified MCP tool names already announced through
   * `mcp_lazy_tools_delta` attachments. The lazy reminder generator diffs the
   * current catalog against it and stays silent when nothing changed.
   *
   * Reset after compaction so the full catalog is announced again.
   */
  announcedLazyMcpTools: Set<string>;

  /**
   * Set of agent type names that have been announced to the model via a
   * prior agent_listing_delta attachment. Used by
   * getAgentListingDeltaAttachments() to compute added/removed delta.
   *
   * Should be reset after compaction so the full list is re-announced with
   * isInitial=true
   * call in compactConversation()).
   */
  announcedAgentTypes: Set<string>;

  /** Last announced descriptions, used to re-announce Full/Lean changes. */
  announcedAgentDescriptions?: Map<string, string>;

  /** SessionStart hook payloads already present in restored transcript history. */
  seenSessionStartHookOutputs: Set<string>;

  // ── Event queues (populated externally, drained by generators) ──

  /**
   * Hook outputs queued for injection.
   * Populated by QueryEngine when hook fireBefore/fireAfter returns additionalContext.
   * Drained synchronously by drainHookOutputAttachments() each turn.
   */
  pendingHookOutputs: PendingHookOutput[];

  /**
   * Prebuilt hook attachments queued for the attachment pipeline.
   * Populated by hook call sites via hookResultsToAttachments() or direct
   * attachment producers, then drained by drainHookOutputAttachments().
   * Provider visibility is determined by normalizeAttachmentForAPI() for each
   * attachment type.
   */
  pendingHookAttachments: HookAttachment[];

  /**
   * Files to restore after context compaction.
   * Set to an array by QueryEngine after compression completes.
   * Drained (one-shot) by drainPostCompactRestoreAttachments() on the next turn.
   * null = no pending restoration; [] = restoration was triggered but no files found.
   */
  postCompactCandidates: PostCompactRestoredFilesAttachment['files'] | null;

  /**
   * Plan file reference attachment to inject after context compaction.
   * Set by QueryEngine's onCompressionCompleted when there is an approved plan.
   * Drained (one-shot) by drainPostCompactPlanAttachment() on the next turn.
   */
  postCompactPlanAttachment?: PlanFileReferenceAttachment | null;

  /**
   * Delta attachment messages (agent listing, MCP instructions, plan mode, etc.)
   * deferred when compaction fires mid tool-call (hasPendingToolTail=true).
   * Drained (one-shot) by drainPendingPostCompactDeltaAttachments() on the
   * inter-turn pass after the tool_result arrives.
   */
  pendingPostCompactDeltaAttachments?: Attachment[] | null;

  /**
   * Last known todo list, preserved across context compression.
   *
   * After compaction, write_todos tool_use blocks fall outside the retained
   * history window, so the message-scan in deriveTodoCounts() finds nothing
   * and returns currentTodos=[]. finalizePostCompact() populates this field
   * by scanning workingHistory (pre-compression) before discarding it.
   * getTodoReminderAttachments() uses this as a fallback when the scan is empty.
   */
  lastKnownTodos?: Array<import('../tools/tools.js').Todo>;
}

// ============================================================================
// AttachmentExternalContext — external system references for generators
// ============================================================================

/**
 * External system references passed to getAttachments() / getAttachmentMessages()
 * on each turn. These are read-only snapshots of runtime state from outside the
 * attachment pipeline (Config, CompressionPipeline, AgentRegistry, etc.).
 *
 * Kept separate from AttachmentToolUseContext (the mutable long-lived bag) to
 * avoid baking external system dependencies into the context lifecycle.
 */
export interface AttachmentExternalContext {
  /** Model selected for model-aware Agent listing descriptions, when known. */
  effectiveModel?: string;

  /** SDK consumption files whose initial contents form the stable prompt prefix. */
  sdkMemoryFileStates?: ReadonlyArray<{
    filePath: string;
    content: string;
    timestamp: number;
    isPartialView?: boolean;
    retainIfMissing?: boolean;
  }>;

  /** MemoryContextManager for startup memory seeding and relevant_memories. */
  memoryContextManager?: {
    getGlobalMemory(): string;
    getPluginMemory(): string;
    getEnvironmentMemory(): string;
    getLocalMemory(): string;
    getLoadedPaths(): ReadonlySet<string>;
    getCategorizedPaths?(): {
      global: readonly string[];
      plugin: readonly string[];
      project: readonly string[];
      local: readonly string[];
    } | null;
    /** JIT discovery: traverse upward from an accessed path to find unloaded AGENTS.md files. */
    discoverContext?(
      accessedPath: string,
      trustedRoots: string[],
    ): Promise<string>;
    /** Returns paths discovered via JIT (not part of startup tiers). */
    getJitDiscoveredPaths?(): {
      project: readonly string[];
      local: readonly string[];
    };
    /** Auto-memory MEMORY.md files loaded at startup, used to seed readFileState. */
    getAutoMemoryIndexFileStates?(): readonly ScopedMemoryIndexFileState[];
    /** Project rule files (.qwen/rules/*.md) loaded at startup, used to seed
     *  readFileState for mid-session change detection. */
    getRuleFileStates?(): readonly RuleFileState[];
  };

  /** Current approval mode (string union, e.g. 'plan' | 'default' | 'auto_edit'). */
  approvalMode?: PermissionMode;

  /**
   * Path to the currently approved plan file (if in plan mode).
   * @deprecated Use planStateManager.getPlanFilePath() instead.
   */
  approvedPlanPath?: string;

  /**
   * Absolute path to the plans directory (~/.${CONFIG_DIR}/plans or custom).
   * Required by plan-generators for slug → file path resolution.
   */
  plansDir?: string;

  /**
   * Current session ID.
   * Required by plan-generators for slug → file path resolution.
   */
  sessionId?: string;

  /** Current subagent progress list for team_context. */
  subagentProgress?: SubagentProgressEntry[];

  /**
   * MCP client manager snapshot for mcp_instructions_delta generation.
   * Provides connected server names and their instructions.
   */
  mcpClientManager?: {
    getConnectedServerInstructions(): Array<{
      serverName: string;
      instructions: string | undefined;
    }>;
    /**
     * Lazy MCP catalog source for the `mcp_lazy_tools_delta` generator.
     * Returns null before the main registry is attached; an empty array when
     * no server currently contributes deferred tools.
     */
    getLazyMcpServerSnapshot?(): Array<
      import('../tools/mcp-lazy/tool-list-text.js').LazyMcpServerSnapshot
    > | null;
    /**
     * Returns the currently-locked lazy-mode decision without triggering
     * the lock. `true` = locked-lazy, `false` = locked-eager, `null` = not
     * yet locked. Lets the lazy reminder generator distinguish the
     * lazy→eager transition (e.g. user disabled enough servers via
     * `/mcp reload` to drop below the threshold) from a clean cold start —
     * we need to emit a one-shot retraction in the former case so older
     * "use mcp_list/get/call" reminders glued into history are explicitly
     * superseded. Optional for the same reasons as the other accessors.
     */
    peekLazyMode?(): boolean | null;
  };

  /** Explicit host opt-in for @server:uri resource reads, separate from tools. */
  mcpResources?: {
    findResource(identifier: string): (Resource & { serverName: string }) | undefined;
    canUseServer(serverName: string): boolean;
    readResource(
      serverName: string,
      uri: string,
      signal: AbortSignal,
    ): Promise<ReadResourceResult | undefined>;
  };

  /**
   * Agent registry snapshot for agent_listing_delta generation.
   * Returns the list of currently enabled agent types with descriptions.
   * Used to re-announce the full set after compaction and to detect
   * add/remove deltas across turns.
   */
  agentRegistry?: {
    getAgentListing(modelId?: string): Array<{
      name: string;
      description: string;
    }>;
  };

  /**
   * Tool registry snapshot for attachment generators that need to gate
   * prompt reminders on whether a tool is actually enabled this turn. When
   * available, getTool(Agent) also supplies the concrete tool instance's
   * policy-filtered Agent listing.
   */
  toolRegistry?: {
    hasToolEnabled(name: string): boolean;
    getTool?(name: string): unknown;
    /** With CodeMode the agent reaches deferred MCP tools in scripts instead of the meta tools. */
    getCodeModeExposure?(): string | undefined;
  };
}

// ============================================================================
// Queued command type (for queued_command attachment)
// ============================================================================

/**
 * A command queued for injection into the next agent turn.
 *
 * Re-exported from `../input/types` for backward compatibility.
 * The canonical definition lives in the input pipeline module.
 */
export type { QueuedCommand } from '../input/types.js';
