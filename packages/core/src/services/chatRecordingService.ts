/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Config } from '../config/config.js';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  type PartListUnion,
  type Content,
  type FunctionDeclaration,
  type GenerateContentResponseUsageMetadata,
  createUserContent,
  createModelContent,
} from '@google/genai';
import * as jsonl from '../utils/jsonl-utils.js';
import { getGitBranch } from '../utils/gitUtils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { compactToolResultDisplayForRecording } from '../utils/toolResultDisplayCompaction.js';
import type { AttributionSnapshot } from './commitAttribution.js';
import { tryGenerateSessionTitle } from './sessionTitle.js';
import type {
  ChatCompressionInfo,
  ToolCallResponseInfo,
} from '../core/turn.js';
import type { Status } from '../core/coreToolScheduler.js';
import type { AgentResultDisplay, FileDiff } from '../tools/tools.js';
import type { UiEvent } from '../telemetry/uiTelemetry.js';
import type {
  FileHistorySnapshot,
  SerializedFileHistorySnapshot,
} from './fileHistoryService.js';
import { serializeSnapshot } from './fileHistoryService.js';
import type {
  SessionArtifactEventRecordPayload,
  SessionArtifactSnapshotRecordPayload,
} from './session-artifact-persistence.js';
import {
  SessionTranscriptChangedError,
  SessionWriterLostError,
  SessionWriterUnavailableError,
  type SessionWriterLease,
} from './session-writer-lease.js';
import type {
  GoalStateRecordPayloadV2,
  GoalTurnPermit,
  TranscriptCursor,
} from '../goals/goal-protocol.js';

const debugLogger = createDebugLogger('CHAT_RECORDING');

/**
 * Maximum number of auto-title generation attempts per session. See
 * {@link ChatRecordingService.autoTitleAttempts} for the rationale behind
 * retrying across turns.
 */
const AUTO_TITLE_ATTEMPT_CAP = 3;
const SESSION_FILE_DIFF_AGGREGATE_CHAR_LIMIT = 100_000;
const SESSION_FILE_DIFF_CHAR_LIMIT = 50_000;
const SESSION_FILE_CONTENT_CHAR_LIMIT = 16_000;

/**
 * Re-append a fresh `custom_title` record to EOF once this many bytes
 * of other JSONL content have been written since the last title
 * anchor. Half of the picker's 64KB tail-read window so that even an
 * oversized record landing right at the threshold keeps the title
 * within scan range. Lifting this above 64KB would let the title
 * fall out of the tail window between re-anchors; lowering it
 * trades extra writes for a tighter safety margin.
 */
const TITLE_REANCHOR_BYTES = 32 * 1024;

function isFileDiffDisplay(resultDisplay: unknown): resultDisplay is FileDiff {
  if (
    typeof resultDisplay !== 'object' ||
    resultDisplay === null ||
    !('fileDiff' in resultDisplay) ||
    !('fileName' in resultDisplay) ||
    !('originalContent' in resultDisplay) ||
    !('newContent' in resultDisplay)
  ) {
    return false;
  }

  const display = resultDisplay as Record<string, unknown>;
  const originalContent = display['originalContent'];
  return (
    typeof display['fileDiff'] === 'string' &&
    typeof display['fileName'] === 'string' &&
    typeof display['newContent'] === 'string' &&
    (originalContent === null || typeof originalContent === 'string')
  );
}

function stringLength(value: string | null | undefined): number {
  return typeof value === 'string' ? value.length : 0;
}

function truncateMiddleForSession(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  const marker = `\n[... truncated for saved session preview; original length: ${value.length} characters ...]\n`;
  const contentBudget = Math.max(0, limit - marker.length);
  const headLength = Math.ceil(contentBudget * 0.6);
  const tailLength = contentBudget - headLength;

  return (
    value.slice(0, headLength) +
    marker +
    (tailLength > 0 ? value.slice(value.length - tailLength) : '')
  );
}

function buildSyntheticDiffPreview(display: FileDiff): string {
  const originalLength = stringLength(display.originalContent);
  return [
    `--- ${display.fileName}`,
    `+++ ${display.fileName}`,
    '@@ -1 +1 @@',
    `-Full diff omitted from saved session history; original fileDiff length: ${display.fileDiff.length} characters.`,
    `+Saved session preview only; originalContent length: ${originalLength} characters, newContent length: ${display.newContent.length} characters.`,
  ].join('\n');
}

function sanitizeFileDiffForRecording(display: FileDiff): FileDiff {
  const fileDiffLength = display.fileDiff.length;
  const originalContentLength = stringLength(display.originalContent);
  const newContentLength = display.newContent.length;
  const aggregateLength =
    fileDiffLength + originalContentLength + newContentLength;

  const fileDiffTruncated = fileDiffLength > SESSION_FILE_DIFF_CHAR_LIMIT;
  const originalContentTruncated =
    originalContentLength > SESSION_FILE_CONTENT_CHAR_LIMIT;
  const newContentTruncated =
    newContentLength > SESSION_FILE_CONTENT_CHAR_LIMIT;

  if (
    aggregateLength <= SESSION_FILE_DIFF_AGGREGATE_CHAR_LIMIT &&
    !fileDiffTruncated &&
    !originalContentTruncated &&
    !newContentTruncated
  ) {
    return display;
  }

  return {
    ...display,
    fileDiff: fileDiffTruncated
      ? buildSyntheticDiffPreview(display)
      : display.fileDiff,
    originalContent:
      display.originalContent !== null && originalContentTruncated
        ? truncateMiddleForSession(
            display.originalContent,
            SESSION_FILE_CONTENT_CHAR_LIMIT,
          )
        : display.originalContent,
    newContent: newContentTruncated
      ? truncateMiddleForSession(
          display.newContent,
          SESSION_FILE_CONTENT_CHAR_LIMIT,
        )
      : display.newContent,
    truncatedForSession: true,
    fileDiffLength,
    originalContentLength,
    newContentLength,
    fileDiffTruncated,
    originalContentTruncated,
    newContentTruncated,
  };
}

export function sanitizeToolCallResultForRecording<
  T extends Partial<ToolCallResponseInfo>,
>(toolCallResult: T): T {
  const resultDisplay = toolCallResult.resultDisplay;
  if (isFileDiffDisplay(resultDisplay)) {
    const sanitizedResultDisplay = sanitizeFileDiffForRecording(resultDisplay);
    if (sanitizedResultDisplay === resultDisplay) {
      return toolCallResult;
    }

    return {
      ...toolCallResult,
      resultDisplay: sanitizedResultDisplay,
    } as T;
  }

  const sanitizedResultDisplay =
    compactToolResultDisplayForRecording(resultDisplay);
  if (sanitizedResultDisplay === resultDisplay) {
    return toolCallResult;
  }

  return {
    ...toolCallResult,
    resultDisplay: sanitizedResultDisplay,
  } as T;
}

/**
 * Users who don't want the fast model silently generating titles can opt
 * out at runtime: `QWEN_DISABLE_AUTO_TITLE=1` (or any truthy-ish value)
 * makes {@link ChatRecordingService.maybeTriggerAutoTitle} a no-op without
 * touching the rest of the feature (so `/rename --auto` still works on
 * explicit user request). Read per-call rather than cached so tests can
 * flip the var between cases without reloading the module; the cost of
 * one env lookup per assistant turn is irrelevant next to an LLM call.
 */
function autoTitleDisabledByEnv(): boolean {
  const v = process.env['QWEN_DISABLE_AUTO_TITLE'];
  if (!v) return false;
  // Accept "0", "false", "no", "off" (case-insensitive) as "not disabled".
  const lowered = v.trim().toLowerCase();
  return (
    lowered !== '' &&
    lowered !== '0' &&
    lowered !== 'false' &&
    lowered !== 'no' &&
    lowered !== 'off'
  );
}

/**
 * A single record stored in the JSONL file.
 * Forms a tree structure via uuid/parentUuid for future conversation branching support.
 *
 * Each record is self-contained with full metadata, enabling:
 * - Append-only writes (crash-safe)
 * - Tree reconstruction by following parentUuid chain
 * - Future conversation branching by forking from any historical record
 */
export type ChatRecordProvenance =
  | 'real_user'
  | 'assistant_output'
  | 'tool_result'
  | 'goal_control'
  | 'goal_runtime'
  | 'system';

export type RecordToolResultOptions =
  | {
      goalContext?: GoalTurnPermit;
      provenance?: 'tool_result';
    }
  | {
      goalContext: GoalTurnPermit;
      provenance: 'goal_runtime';
    };

function copyGoalContext(goalContext: GoalTurnPermit): GoalTurnPermit {
  return {
    goalId: goalContext.goalId,
    revision: goalContext.revision,
    turnId: goalContext.turnId,
  };
}

export interface ChatRecord {
  /** Unique identifier for this logical message */
  uuid: string;
  /** UUID of the parent message; null for root (first message in session) */
  parentUuid: string | null;
  /** Session identifier - groups records into a logical conversation */
  sessionId: string;
  /** ISO 8601 timestamp of when the record was created */
  timestamp: string;
  /**
   * Message type: user input, assistant response, tool result, or system event.
   * System records are append-only events that can alter how history is reconstructed
   * (e.g., chat compression checkpoints) while keeping the original UI history intact.
   */
  type: 'user' | 'assistant' | 'tool_result' | 'system';
  /** Optional subtype for distinguishing non-standard records */
  subtype?:
    | 'chat_compression'
    | 'slash_command'
    | 'ui_telemetry'
    | 'at_command'
    | 'attribution_snapshot'
    | 'notification'
    | 'cron'
    | 'mid_turn_user_message'
    | 'custom_title'
    | 'parent_session'
    | 'session_source'
    | 'rewind'
    | 'agent_bootstrap'
    | 'agent_launch_prompt'
    | 'file_history_snapshot'
    | 'user_text_elements'
    | 'session_artifact_event'
    | 'session_artifact_snapshot'
    | 'goal_state'
    | 'goal_runtime';
  /** Explicit source classification used by Goal evidence validation. */
  provenance?: ChatRecordProvenance;
  /** Goal identity and logical turn that owned this model-facing record. */
  goalContext?: GoalTurnPermit;
  /** Working directory at time of message */
  cwd: string;
  /** CLI version for compatibility tracking */
  version: string;
  /** Current git branch, if available */
  gitBranch?: string;

  // Content field - raw API format for history reconstruction

  /**
   * The actual Content object (role + parts) sent to/from LLM.
   * This is stored in the exact format needed for API calls, enabling
   * direct aggregation into Content[] for session resumption.
   * Contains: text, functionCall, functionResponse, thought parts, etc.
   */
  message?: Content;

  // Metadata fields (not part of API Content)

  /** Token usage statistics */
  usageMetadata?: GenerateContentResponseUsageMetadata;
  /** Model used for this response */
  model?: string;
  /** Context window size of the model used for this response */
  contextWindowSize?: number;
  /**
   * Tool call metadata for UI recovery.
   * Contains enriched info (displayName, status, result, etc.) not in API format.
   */
  toolCallResult?: Partial<ToolCallResponseInfo> & { status?: Status };

  /**
   * Payload for records that need non-API metadata. For chat compression, this
   * stores all data needed to reconstruct the compressed history without
   * mutating the original UI list.
   */
  systemPayload?:
    | ChatCompressionRecordPayload
    | SlashCommandRecordPayload
    | UiTelemetryRecordPayload
    | AtCommandRecordPayload
    | AttributionSnapshotPayload
    | CustomTitleRecordPayload
    | ParentSessionRecordPayload
    | SessionSourceRecordPayload
    | NotificationRecordPayload
    | RewindRecordPayload
    | AgentBootstrapRecordPayload
    | FileHistorySnapshotRecordPayload
    | UserTextElementsRecordPayload
    | SessionArtifactEventRecordPayload
    | SessionArtifactSnapshotRecordPayload
    | GoalStateRecordPayloadV2;

  /** Background subagent that produced this record (e.g. "explore-7f3c"). */
  agentId?: string;
  /** Display name for the subagent (e.g. "Explore"). */
  agentName?: string;
  /** UI hint for tools rendering subagent transcripts. */
  agentColor?: string;
  /** True for records produced by a subagent (a sidechain off the parent session). */
  isSidechain?: boolean;
  /** Writer execution that produced this subagent round. */
  agentRunId?: string;
  /** Round number within agentRunId. */
  agentRound?: number;
  /** Source kind for injected external input records. */
  externalInputKind?: 'message' | 'notification';

  /**
   * Set on every record of a forked session to record its lineage.
   * `sessionId` is the parent (source) session id; `messageUuid` is the
   * uuid of the equivalent message in the parent — the same value as
   * this record's `uuid`, since /branch copies each message verbatim
   * except for rewriting `sessionId` and rebuilding `parentUuid` by
   * write order.
   *
   * Written by /branch on every copied record; never consumed by any
   * feature at read time — it exists purely as per-message audit trail
   * so that when a record is inspected in isolation its origin is
   * self-contained (mirrors Claude Code's /branch behavior).
   */
  forkedFrom?: {
    sessionId: string;
    messageUuid: string;
  };
}

export interface NotificationRecordPayload {
  displayText: string;
}

export interface AgentBootstrapRecordPayload {
  /** Bootstrap kind for future-proof decoding. */
  kind: 'fork';
  /**
   * Exact model-facing history prefix seeded before the agent emitted any
   * runtime events. For forks, this includes the inherited parent context and
   * the original first task prompt/user turn.
   */
  history: Content[];
  /**
   * Immutable launch-time system instruction for the fork runtime. Resume must
   * reuse this exact value rather than reading the current parent config.
   */
  systemInstruction?: string | Content;
  /**
   * Immutable launch-time tool declarations / allowlist for the fork runtime.
   * Resume must reuse this exact capability set or stay blocked.
   */
  tools?: Array<string | FunctionDeclaration>;
}

/**
 * Stored payload for chat compression checkpoints. This allows us to rebuild the
 * effective chat history on resume while keeping the original UI-visible history.
 */
export interface ChatCompressionRecordPayload {
  /** Compression metrics/status returned by the compression service */
  info: ChatCompressionInfo;
  /**
   * Snapshot of the new history contents that the model should see after
   * compression (summary turns + retained tail). Stored as Content[] for
   * resume reconstruction.
   */
  compressedHistory: Content[];
}

export interface SlashCommandRecordPayload {
  /** Whether this record represents the invocation or the resulting output. */
  phase: 'invocation' | 'result';
  /** Raw user-entered slash command (e.g., "/about"). */
  rawCommand: string;
  /** Whether the visible slash-command invocation reached model history. */
  sentToModel?: boolean;
  /**
   * History items the UI displayed for this command, in the same shape used by
   * the CLI (without IDs). Stored as plain objects for replay on resume.
   */
  outputHistoryItems?: Array<Record<string, unknown>>;
}

/**
 * Stored payload for @-command replay.
 */
export interface AtCommandRecordPayload {
  /** Files that were read for this @-command. */
  filesRead: string[];
  /** Status for UI reconstruction. */
  status: 'success' | 'error';
  /** Optional result message for UI reconstruction. */
  message?: string;
  /** Raw user-entered @-command query (optional for legacy records). */
  userText?: string;
}

/**
 * Source of a custom session title.
 * - `manual`: set by the user via `/rename` (or pre-2026 records without
 *   a source field — treated as manual for safety so auto can't overwrite
 *   a title a user deliberately chose).
 * - `auto`: generated by the session-title service from conversation text;
 *   safe to re-generate or be replaced by a manual rename.
 */
export type TitleSource = 'manual' | 'auto';

/**
 * Stored payload for custom title set via /rename or auto-generation.
 */
export interface CustomTitleRecordPayload {
  /** The custom title for the session */
  customTitle: string;
  /**
   * How this title was produced. Absent on legacy records — readers should
   * treat `undefined` as `'manual'` so existing user-set titles are never
   * replaced by auto-generation after an upgrade.
   */
  titleSource?: TitleSource;
}

/**
 * Stored payload recording the session that spawned this one (a
 * `create_sub_session` caller). Immutable — written once, near the start of the
 * transcript. Lets a management UI link a sub-session back to its parent, and
 * survives a daemon restart via the session-list transcript scan.
 */
export interface ParentSessionRecordPayload {
  /** Id of the session that spawned this one. */
  parentSessionId: string;
}

/** Immutable attribution describing which integration created the session. */
export interface SessionSourceRecordPayload {
  sourceType: string;
  sourceId?: string;
}

/**
 * Stored payload for UI telemetry replay.
 */
export interface UiTelemetryRecordPayload {
  uiEvent: UiEvent;
}

/**
 * Stored payload for attribution state snapshots.
 * Enables session persistence of AI contribution tracking.
 */
export interface AttributionSnapshotPayload {
  snapshot: AttributionSnapshot;
}

/**
 * Stored payload for conversation rewind events.
 */
export interface RewindRecordPayload {
  /** Number of UI history items truncated. */
  truncatedCount: number;
}

/**
 * Stored payload for file history snapshot persistence.
 * Each entry records one or more snapshots for session resume.
 */
export interface FileHistorySnapshotRecordPayload {
  snapshots: SerializedFileHistorySnapshot[];
}

export interface UserTextElementsRecordPayload {
  content: string;
  textElements: unknown[];
}

export interface ChatRecordingFailureEvent {
  sessionId: string;
  error: Error;
}

export type ChatRecordingFailureListener = (
  event: ChatRecordingFailureEvent,
) => void | Promise<void>;

/**
 * Service for recording the current chat session to disk.
 *
 * This service provides comprehensive conversation recording that captures:
 * - All user and assistant messages
 * - Tool calls and their execution results
 * - Token usage statistics
 * - Assistant thoughts and reasoning
 *
 * **API Design:**
 * - `recordUserMessage()` - Queues a user message for recording
 * - `recordAssistantTurn()` - Queues an assistant turn with all data
 * - `recordToolResult()` - Queues tool results for recording
 *
 * **Storage Format:** JSONL files with tree-structured records.
 * Each record has uuid/parentUuid fields enabling:
 * - Append-only writes (never rewrite the file)
 * - Linear history reconstruction
 * - Future conversation branching (fork from any historical point)
 *
 * File location: ~/.qwen/tmp/<project_id>/chats/
 *
 * For session management (list, load, remove), use SessionService.
 */
export class ChatRecordingService {
  /** UUID of the active logical tail, including records queued for writing. */
  private lastRecordUuid: string | null = null;
  /** UUID of the last active-tail record confirmed written to disk. */
  private lastPersistedRecordUuid: string | null = null;
  private readonly config: Config;
  /**
   * Tracks the `lastRecordUuid` value just before each user turn was recorded.
   * Used by {@link rewindRecording} to re-root the parentUuid chain so that
   * rewound messages end up on a dead branch in the tree, making
   * `reconstructHistory()` skip them automatically on resume.
   *
   * Index `i` holds the active tail UUID observed before the (i+1)th user
   * message was queued. For example, `turnParentUuids[0]` is the UUID right
   * before the very first user message (often `null` or the startup context
   * record).
   */
  private turnParentUuids: Array<string | null> = [];
  private chatsDirEnsured = false;
  private cachedConversationFile: string | undefined;
  private state:
    | 'inactive'
    | 'active'
    | 'closing'
    | 'closed'
    | 'integrity_failed' = 'inactive';
  private binding:
    | {
        readonly sessionId: string;
        readonly lease: SessionWriterLease;
      }
    | undefined;
  /** Serializes appends and authoritative read barriers. Always settles. */
  private operationTail: Promise<void> = Promise.resolve();
  /** First async JSONL write failure; permanently degrades this recorder. */
  private writeFailure: Error | undefined;
  private integrityFailure: Error | undefined;
  private readonly writerLeaseRequired: boolean;
  /** In-memory cache of the current session's custom title (for re-append on exit) */
  private currentCustomTitle: string | undefined;
  /**
   * Source of {@link currentCustomTitle}. `undefined` on legacy records that
   * pre-date the `titleSource` field — that's treated as manual everywhere
   * (safe default) without rewriting the persisted record.
   */
  private currentTitleSource: TitleSource | undefined;
  /** Parent session id once recorded, so {@link recordParentSession} is
   * idempotent — a bridge retry (after a failed response) must not append a
   * second `parent_session` record for the same immutable lineage. */
  private currentParentSessionId: string | undefined;
  /** Immutable creator attribution once recorded. */
  private currentSourceType: string | undefined;
  private currentSourceId: string | undefined;
  /**
   * How many auto-title attempts have been made this process.
   *
   * We don't commit to "one attempt per session" because the first assistant
   * turn may be a pure tool-call with no user-visible text (e.g., the model
   * opens with a search) — the title service returns null, and we'd waste
   * the whole session's chance on a turn that never had a shot. Instead we
   * retry for a handful of turns until either the title lands or we hit the
   * cap, which protects against a persistently failing fast-model looping
   * on every turn. {@link AUTO_TITLE_ATTEMPT_CAP} sets the ceiling.
   */
  private autoTitleAttempts = 0;
  /**
   * AbortController for the in-flight auto-title LLM call, or `undefined`
   * when no generation is pending. Doubles as the in-flight guard — a
   * defined controller means "one is running; don't launch another".
   * Stored on the instance so {@link finalize} (called on session switch
   * and shutdown) can cancel a pending call cleanly rather than letting
   * it burn tokens after the session has already moved on.
   */
  private autoTitleController: AbortController | undefined;
  /** Explicit title writes waiting to settle; background auto-title defers. */
  private pendingExplicitTitleWrites = 0;
  /** Title writes whose durable result and final cached value are unresolved. */
  private pendingTitleWrites = 0;

  /**
   * JSON-serialized form of the most recent attribution snapshot accepted for
   * recording, used to deduplicate identical writes on every non-retry
   * turn. Without this, sessions that touch many files would write a
   * full duplicate of the entire snapshot to the JSONL on every turn,
   * inflating the on-disk session and making `/resume` slower to
   * hydrate.
   */
  private lastAttributionSnapshotJson: string | undefined;
  private cachedGitBranch:
    | { cwd: string; branch: string | undefined }
    | undefined;

  /**
   * Approximate bytes of JSONL content accepted after the last
   * `custom_title` record in the ordered writer queue. Used by the title
   * re-anchor invariant: once enough non-title content accumulates
   * past the last anchor, {@link appendRecord} re-appends a fresh
   * `custom_title` to EOF so the picker's tail-window scan
   * ({@link readSessionTitleFromFile}) keeps finding it.
   *
   * Without this, a long agentic turn that streams >64KB of tool
   * output could push the only `custom_title` record past the 64KB
   * tail window, forcing the picker into a head-window fallback (or
   * returning undefined if the title is beyond both windows).
   */
  private bytesSinceTitleAnchor = 0;
  private hasNonTitleContentSinceTitleAnchor = false;

  constructor(
    config: Config,
    private readonly onWriteFailure?: ChatRecordingFailureListener,
    writerLeaseRequired = config.getExperimentalZedIntegration?.() ?? true,
  ) {
    this.config = config;
    this.writerLeaseRequired = writerLeaseRequired;
    const resumed = config.getResumedSessionData();
    if (writerLeaseRequired) {
      this.lastRecordUuid = resumed?.lastCompletedUuid ?? null;
    } else {
      this.state = 'active';
      this.restoreSessionState(
        resumed
          ? {
              conversation: resumed.conversation ?? { messages: [] },
              lastCompletedUuid: resumed.lastCompletedUuid,
            }
          : undefined,
        resumed ? this.readPersistedTitleInfo() : undefined,
      );
    }
    this.lastPersistedRecordUuid = this.lastRecordUuid;
  }

  private readPersistedTitleInfo():
    | { title?: string; source?: TitleSource }
    | undefined {
    try {
      return this.config
        .getSessionService()
        .getSessionTitleInfo(this.config.getSessionId());
    } catch {
      return undefined;
    }
  }

  /**
   * Returns the current custom title, if any. Read-only accessor for
   * callers (e.g. auto-title trigger) that need to know whether a title is
   * already set before attempting generation.
   */
  getCurrentCustomTitle(): string | undefined {
    return this.currentCustomTitle;
  }

  /**
   * Returns the source of the current custom title, or `undefined` when no
   * title is set.
   */
  getCurrentTitleSource(): TitleSource | undefined {
    return this.currentTitleSource;
  }

  /**
   * Returns the session ID.
   * @returns The session ID.
   */
  private getSessionId(): string {
    return this.binding?.sessionId ?? this.config.getSessionId();
  }

  private ensureChatsDir(): string {
    const chatsDir = path.join(this.config.storage.getProjectDir(), 'chats');
    if (this.chatsDirEnsured) return chatsDir;
    try {
      fs.mkdirSync(chatsDir, { recursive: true });
      this.chatsDirEnsured = true;
    } catch {
      // The file creation below reports the actionable error.
    }
    return chatsDir;
  }

  private ensureConversationFile(): string {
    if (this.cachedConversationFile) return this.cachedConversationFile;
    const conversationFile = path.join(
      this.ensureChatsDir(),
      `${this.getSessionId()}.jsonl`,
    );
    try {
      fs.writeFileSync(conversationFile, '', { flag: 'wx', encoding: 'utf8' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to create conversation file at ${conversationFile}: ${message}`,
        );
      }
    }
    this.cachedConversationFile = conversationFile;
    return conversationFile;
  }

  private restoreSessionState(
    sessionData?: {
      conversation: { messages: ChatRecord[] };
      lastCompletedUuid: string | null;
    },
    persistedTitleInfo?: { title?: string; source?: TitleSource },
  ): void {
    this.lastRecordUuid = sessionData?.lastCompletedUuid ?? null;
    this.currentCustomTitle = undefined;
    this.currentTitleSource = undefined;
    this.currentParentSessionId = undefined;
    this.currentSourceType = undefined;
    this.currentSourceId = undefined;
    if (!sessionData) return;
    this.rebuildTurnBoundaries(sessionData.conversation.messages);
    for (const record of sessionData.conversation.messages) {
      if (record.type !== 'system') continue;
      if (record.subtype === 'custom_title') {
        const payload = record.systemPayload as
          | CustomTitleRecordPayload
          | undefined;
        this.currentCustomTitle = payload?.customTitle;
        this.currentTitleSource = payload?.titleSource;
      } else if (record.subtype === 'parent_session') {
        this.currentParentSessionId = (
          record.systemPayload as ParentSessionRecordPayload | undefined
        )?.parentSessionId;
      } else if (record.subtype === 'session_source') {
        const payload = record.systemPayload as
          | SessionSourceRecordPayload
          | undefined;
        this.currentSourceType = payload?.sourceType;
        this.currentSourceId = payload?.sourceId;
      }
    }
    if (persistedTitleInfo !== undefined) {
      this.currentCustomTitle = persistedTitleInfo.title;
      this.currentTitleSource = persistedTitleInfo.source;
    }
    if (this.currentCustomTitle) {
      this.bytesSinceTitleAnchor = TITLE_REANCHOR_BYTES;
    }
  }

  activate(
    lease: SessionWriterLease,
    sessionData?: {
      conversation: { messages: ChatRecord[] };
      lastCompletedUuid: string | null;
    },
    persistedTitleInfo?: { title?: string; source?: TitleSource },
  ): void {
    if (
      !this.writerLeaseRequired ||
      this.state !== 'inactive' ||
      lease.sessionId !== this.config.getSessionId()
    ) {
      throw new SessionWriterUnavailableError();
    }
    this.binding = { sessionId: lease.sessionId, lease };
    this.restoreSessionState(sessionData, persistedTitleInfo);
    this.state = 'active';
  }

  /**
   * Creates base fields for a ChatRecord.
   */
  private createBaseRecord(
    type: ChatRecord['type'],
  ): Omit<ChatRecord, 'message' | 'tokens' | 'model' | 'toolCallsMetadata'> {
    const cwd = this.config.getProjectRoot();
    return {
      uuid: randomUUID(),
      parentUuid: this.lastRecordUuid,
      sessionId: this.getSessionId(),
      timestamp: new Date().toISOString(),
      type,
      provenance:
        type === 'user'
          ? 'real_user'
          : type === 'assistant'
            ? 'assistant_output'
            : type === 'tool_result'
              ? 'tool_result'
              : 'system',
      cwd,
      version: this.config.getCliVersion() || 'unknown',
      gitBranch: this.getCachedGitBranch(cwd),
    };
  }

  private getCachedGitBranch(cwd: string): string | undefined {
    if (!this.cachedGitBranch || this.cachedGitBranch.cwd !== cwd) {
      this.cachedGitBranch = { cwd, branch: getGitBranch(cwd) };
    }
    return this.cachedGitBranch.branch;
  }

  private enterWriteFailure(
    cause: unknown,
    sessionId: string,
    operation = 'append',
  ): Error {
    const failure = cause instanceof Error ? cause : new Error(String(cause));
    if (
      !this.integrityFailure &&
      (failure instanceof SessionWriterLostError ||
        failure instanceof SessionTranscriptChangedError ||
        failure instanceof SessionWriterUnavailableError)
    ) {
      this.integrityFailure = failure;
      this.state = 'integrity_failed';
      debugLogger.error(
        `Session writer failure sessionId=${sessionId} operation=${operation} errorKind=${failure.errorKind}`,
      );
    }
    if (!this.writeFailure) {
      this.writeFailure = failure;
      debugLogger.error('Chat recording failure:', this.writeFailure);
      this.lastRecordUuid = this.lastPersistedRecordUuid;
      try {
        const notification = this.onWriteFailure?.({
          sessionId,
          error: this.writeFailure,
        });
        if (notification) {
          void notification.catch((error) => {
            debugLogger.debug(
              'Chat recording failure listener rejected:',
              error,
            );
          });
        }
      } catch (error) {
        debugLogger.debug('Chat recording failure listener threw:', error);
      }
    }
    return this.integrityFailure ?? this.writeFailure;
  }

  private enqueueRecordWrite(
    record: ChatRecord,
    legacyConversationFile?: string,
    updateActiveTail = true,
  ): Promise<void> {
    const pendingWrite = this.operationTail.then(async () => {
      if (this.writeFailure) throw this.writeFailure;
      try {
        const lease = this.binding?.lease;
        if (lease) {
          await lease.appendJsonLine(record);
        } else if (!this.writerLeaseRequired && legacyConversationFile) {
          await jsonl.writeLine(legacyConversationFile, record);
        } else {
          throw new SessionWriterUnavailableError();
        }
        if (updateActiveTail) {
          this.lastPersistedRecordUuid = record.uuid;
        }
      } catch (error) {
        throw this.enterWriteFailure(error, record.sessionId);
      }
    });
    this.operationTail = pendingWrite.then(
      () => undefined,
      () => undefined,
    );
    return pendingWrite;
  }

  /**
   * Fire-and-forget: queues a JSONL write on the internal operation tail.
   * A failed write permanently degrades this recorder; already-queued
   * descendants are skipped and later fire-and-forget calls become no-ops.
   */
  private appendRecord(
    record: ChatRecord,
    options?: { updateActiveTail?: boolean },
  ): void {
    if (this.writeFailure || this.state !== 'active') return;
    const legacyConversationFile = this.writerLeaseRequired
      ? undefined
      : this.ensureConversationFile();
    const updateActiveTail = options?.updateActiveTail !== false;
    if (updateActiveTail) {
      this.lastRecordUuid = record.uuid;
    }
    this.enqueueRecordWrite(record, legacyConversationFile, updateActiveTail);
    this.updateTitleAnchorTracking(record);
  }

  private async appendRecordStrict(
    record: ChatRecord,
    options?: { updateActiveTail?: boolean },
  ): Promise<void> {
    if (this.writeFailure) throw this.writeFailure;
    if (this.state !== 'active') throw new SessionWriterUnavailableError();

    const updateActiveTail = options?.updateActiveTail !== false;
    const legacyConversationFile = this.writerLeaseRequired
      ? undefined
      : this.ensureConversationFile();
    if (updateActiveTail) {
      this.lastRecordUuid = record.uuid;
    }
    const pendingWrite = this.enqueueRecordWrite(
      record,
      legacyConversationFile,
      updateActiveTail,
    );
    // Keep anchor accounting in logical queue order, matching appendRecord.
    // Once accepted, a failed write permanently stops this recorder, so no
    // rollback of this bookkeeping is needed on rejection.
    this.updateTitleAnchorTracking(record);

    await pendingWrite;
  }

  /**
   * Maintain the "title is always in the tail window" invariant by
   * counting bytes accepted since the last `custom_title` record and
   * re-anchoring once enough non-title content has been written.
   *
   * - A `custom_title` record IS the new anchor — reset the counter.
   * - Without a current or pending title, the counter is irrelevant.
   * - Otherwise accumulate this record's serialized size; if the
   *   running total breaches the threshold, re-append a fresh
   *   `custom_title` to EOF. The recursive `appendRecord` call will
   *   land this branch's first arm (subtype === 'custom_title') and
   *   reset the counter to 0.
   *
   * Size estimate uses `JSON.stringify` for parity with the actual
   * write path (`jsonl.writeLine` serializes the same way). It's an
   * extra serialize per record, but appendRecord is already gated by
   * an async I/O write whose cost dominates by orders of magnitude.
   *
   * Byte count uses `Buffer.byteLength(..., 'utf8')`, not `String.length`:
   * `String.length` counts UTF-16 code units, but `jsonl.writeLine`
   * emits UTF-8 — multi-byte characters (CJK, emoji) are 2–3× larger
   * on disk than `.length` reports, and undercounting would let the
   * actual on-disk distance from the last anchor blow past the 64KB
   * tail window before the threshold fires.
   */
  private updateTitleAnchorTracking(record: ChatRecord): void {
    if (record.type === 'system' && record.subtype === 'custom_title') {
      this.bytesSinceTitleAnchor = 0;
      this.hasNonTitleContentSinceTitleAnchor = false;
      return;
    }
    if (!this.currentCustomTitle && this.pendingTitleWrites === 0) return;
    this.hasNonTitleContentSinceTitleAnchor = true;
    let serializedRecord: string;
    try {
      serializedRecord = JSON.stringify(record);
    } catch {
      // Anchor bookkeeping must not change the writer's success contract.
      // The real serializer will surface the failure through writeChain.
      return;
    }
    // +1 for the trailing newline jsonl.writeLine appends.
    this.bytesSinceTitleAnchor +=
      Buffer.byteLength(serializedRecord, 'utf8') + 1;
    if (
      this.bytesSinceTitleAnchor >= TITLE_REANCHOR_BYTES &&
      this.pendingTitleWrites === 0
    ) {
      this.reanchorTitle();
    }
  }

  /**
   * Append a fresh `custom_title` record to EOF using the in-memory
   * cached title. Mirrors {@link finalize}'s record shape — invoked
   * mid-session (every 32KB of other writes) so the picker's
   * tail-window scan never has to fall back to
   * scanning the middle of the file.
   */
  private reanchorTitle(): void {
    if (!this.currentCustomTitle) return;
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        type: 'system',
        subtype: 'custom_title',
        systemPayload: {
          customTitle: this.currentCustomTitle,
          ...(this.currentTitleSource
            ? { titleSource: this.currentTitleSource }
            : {}),
        },
      };
      this.appendRecord(record, { updateActiveTail: false });
    } catch (error) {
      // Reset the counter even on failure: otherwise every subsequent
      // appendRecord re-fires reanchorTitle (counter still ≥ threshold)
      // and turns a transient I/O issue into an unbounded retry storm.
      // Skipping a single anchor write is the right tradeoff — finalize()
      // will re-emit one on the next lifecycle event.
      this.bytesSinceTitleAnchor = 0;
      debugLogger.error('Error re-anchoring custom title:', error);
    }
  }

  /**
   * Awaits all queued async writes. Call before process exit / session
   * teardown to ensure no records are dropped.
   */
  async flush(): Promise<void> {
    await this.operationTail;
    if (this.writeFailure) throw this.writeFailure;
  }

  async runWithWriteBarrier<T>(operation: () => Promise<T>): Promise<T> {
    if (this.writeFailure) throw this.writeFailure;
    if (this.state !== 'active') throw new SessionWriterUnavailableError();
    const pending = this.operationTail.then(async () => {
      if (this.writeFailure) throw this.writeFailure;
      if (this.state !== 'active') throw new SessionWriterUnavailableError();
      const lease = this.binding?.lease;
      try {
        if (lease) {
          await lease.assertOwnedAndUnchanged();
        } else if (this.writerLeaseRequired) {
          throw new SessionWriterUnavailableError();
        }
        const result = await operation();
        await lease?.assertOwnedAndUnchanged();
        return result;
      } catch (error) {
        if (
          error instanceof SessionWriterLostError ||
          error instanceof SessionTranscriptChangedError ||
          error instanceof SessionWriterUnavailableError
        ) {
          throw this.enterWriteFailure(
            error,
            this.getSessionId(),
            'read_barrier',
          );
        }
        throw error;
      }
    });
    this.operationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async assertCanStartTurn(): Promise<void> {
    try {
      await this.runWithWriteBarrier(async () => undefined);
    } catch (error) {
      if (this.integrityFailure) throw this.integrityFailure;
      if (this.writeFailure) {
        throw new SessionWriterUnavailableError({ cause: this.writeFailure });
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    this.autoTitleController?.abort();
    if (this.state === 'active') this.state = 'closing';
    let flushFailure: unknown;
    try {
      await this.flush();
    } catch (error) {
      flushFailure = error;
    }
    try {
      await this.binding?.lease.release();
      this.binding = undefined;
      this.state = 'closed';
    } catch (error) {
      if (error instanceof SessionWriterLostError) {
        this.binding = undefined;
        this.state = 'closed';
      } else {
        this.state = 'integrity_failed';
      }
      throw error;
    }
    if (flushFailure !== undefined) throw flushFailure;
  }

  hasWriteOwnership(): boolean {
    return this.binding !== undefined;
  }

  async readActiveTranscriptChain(): Promise<readonly ChatRecord[]> {
    await this.flush();
    const sessionId = this.getSessionId();
    const session = await this.config
      .getSessionService()
      .loadSession(sessionId);
    if (!session) {
      throw new Error(
        `Unable to load active transcript for session ${sessionId}`,
      );
    }
    return session.conversation.messages;
  }

  getTranscriptCursor(): TranscriptCursor {
    return { recordId: this.lastRecordUuid };
  }

  async recordGoalState(
    recordUuid: string,
    payload: GoalStateRecordPayloadV2,
  ): Promise<ChatRecord> {
    const record: ChatRecord = {
      ...this.createBaseRecord('system'),
      uuid: recordUuid,
      type: 'system',
      subtype: 'goal_state',
      provenance: 'goal_control',
      systemPayload: {
        ...payload,
        snapshot: { ...payload.snapshot, activity: 'idle' },
      },
    };
    await this.appendRecordStrict(record);
    return record;
  }

  /**
   * Clears cached filesystem paths after Config swaps to a new working
   * directory. The recorder keeps session state, but future appends must
   * resolve the JSONL path through the updated Config.storage.
   */
  resetStoragePaths(): void {
    if (this.writerLeaseRequired && this.state === 'active') {
      throw new SessionWriterUnavailableError();
    }
    this.chatsDirEnsured = false;
    this.cachedConversationFile = undefined;
  }

  /**
   * Records a user message.
   * Queues the write immediately on the serialized async writer.
   *
   * @param message The raw PartListUnion object as used with the API
   */
  recordUserMessage(
    message: PartListUnion,
    goalContext?: GoalTurnPermit,
  ): void {
    try {
      this.turnParentUuids.push(this.lastRecordUuid);
      const record: ChatRecord = {
        ...this.createBaseRecord('user'),
        ...(goalContext ? { goalContext: copyGoalContext(goalContext) } : {}),
        message: createUserContent(message),
      };
      this.appendRecord(record);
    } catch (error) {
      debugLogger.error('Error saving user message:', error);
    }
  }

  recordGoalRuntimeMessage(
    message: PartListUnion,
    goalContext: GoalTurnPermit,
  ): void {
    try {
      this.turnParentUuids.push(this.lastRecordUuid);
      const record: ChatRecord = {
        ...this.createBaseRecord('user'),
        subtype: 'goal_runtime',
        provenance: 'goal_runtime',
        goalContext: copyGoalContext(goalContext),
        message: createUserContent(message),
      };
      this.appendRecord(record);
    } catch (error) {
      debugLogger.error('Error saving Goal runtime message:', error);
    }
  }

  /**
   * Records a user message drained while tool results are being submitted.
   *
   * The model sees these as extra user-role parts in the same API Content as
   * tool results. Keeping a distinct subtype lets resume reconstruct that shape
   * instead of replaying consecutive user-role entries.
   */
  recordMidTurnUserMessage(
    message: PartListUnion,
    displayText?: string,
    goalContext?: GoalTurnPermit,
  ): void {
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('user'),
        subtype: 'mid_turn_user_message',
        ...(goalContext ? { goalContext: copyGoalContext(goalContext) } : {}),
        message: createUserContent(message),
        systemPayload: displayText
          ? ({ displayText } as NotificationRecordPayload)
          : undefined,
      };
      this.appendRecord(record);
    } catch (error) {
      debugLogger.error('Error saving mid-turn user message:', error);
    }
  }

  /**
   * Records a cron-fired prompt.
   * Stored as a user-role message with subtype 'cron' so the UI
   * restores it as a notification item instead of a user turn.
   */
  recordCronPrompt(
    message: PartListUnion,
    displayText?: string,
    goalContext?: GoalTurnPermit,
  ): void {
    this.recordNotificationLike(message, 'cron', displayText, goalContext);
  }

  /**
   * Records a background agent notification.
   * Stored as a user-role message with subtype 'notification' so the
   * UI restores it as an info item, not a user turn.
   */
  recordNotification(
    message: PartListUnion,
    displayText?: string,
    goalContext?: GoalTurnPermit,
  ): void {
    this.recordNotificationLike(
      message,
      'notification',
      displayText,
      goalContext,
    );
  }

  private recordNotificationLike(
    message: PartListUnion,
    subtype: 'notification' | 'cron',
    displayText?: string,
    goalContext?: GoalTurnPermit,
  ): void {
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('user'),
        subtype,
        provenance: 'system',
        ...(goalContext ? { goalContext: copyGoalContext(goalContext) } : {}),
        message: createUserContent(message),
        systemPayload: displayText
          ? ({ displayText } as NotificationRecordPayload)
          : undefined,
      };
      this.appendRecord(record);
    } catch (error) {
      debugLogger.error(`Error saving ${subtype} record:`, error);
    }
  }

  /**
   * Records an assistant turn with all available data.
   * Queues the write immediately on the serialized async writer.
   *
   * @param data.message The raw PartListUnion object from the model response
   * @param data.model The model name
   * @param data.tokens Token usage statistics
   * @param data.contextWindowSize Context window size of the model
   * @param data.toolCallsMetadata Enriched tool call info for UI recovery
   */
  recordAssistantTurn(data: {
    model: string;
    message?: PartListUnion;
    tokens?: GenerateContentResponseUsageMetadata;
    contextWindowSize?: number;
    goalContext?: GoalTurnPermit;
  }): void {
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('assistant'),
        model: data.model,
        ...(data.goalContext
          ? { goalContext: copyGoalContext(data.goalContext) }
          : {}),
      };

      if (data.message !== undefined) {
        record.message = createModelContent(data.message);
      }

      if (data.tokens) {
        record.usageMetadata = data.tokens;
      }

      if (data.contextWindowSize !== undefined) {
        record.contextWindowSize = data.contextWindowSize;
      }

      this.appendRecord(record);
      this.maybeTriggerAutoTitle();
    } catch (error) {
      debugLogger.error('Error saving assistant turn:', error);
    }
  }

  /**
   * Fire-and-forget: after an assistant turn is recorded, attempt to generate
   * a short session title from the conversation so far. Runs at most once per
   * process lifetime per session and only when:
   *
   * - No title is already set (auto must never overwrite a manual rename,
   *   and we don't need to regenerate an existing auto title mid-session).
   * - A fast model is configured — the service itself also guards this,
   *   but checking here avoids paying for the import/history load when
   *   there's no point.
   *
   * Errors are swallowed. The title is best-effort and must never surface
   * as a user-visible error or interrupt recording.
   */
  private maybeTriggerAutoTitle(): void {
    if (this.currentCustomTitle) return;
    if (this.writeFailure) return;
    if (this.pendingExplicitTitleWrites > 0) return;
    if (this.autoTitleController) return;
    if (this.autoTitleAttempts >= AUTO_TITLE_ATTEMPT_CAP) return;
    // Opt-out env var — lets users silence auto-titling without having to
    // unset their fast model (which would break `/rename --auto`, recap,
    // compression, and other fast-model features).
    if (autoTitleDisabledByEnv()) return;
    // Headless/one-shot CLI flows (`qwen -p "…"`, cron, CI scripts) run a
    // single prompt and throw the session away. Spending fast-model tokens
    // on a title no one will ever resume is pure waste; skip entirely.
    // Daemon (ACP) sessions are long-lived and user-resumable, so they
    // DO need auto-titles even though `isInteractive()` returns false
    // (the ACP child is spawned with pipe stdio, not a TTY).
    if (
      !this.config.isInteractive() &&
      !this.config.getExperimentalZedIntegration()
    ) {
      return;
    }
    const fastModel = this.config.getFastModel();
    if (!fastModel) return;

    this.autoTitleAttempts++;
    const controller = new AbortController();
    this.autoTitleController = controller;

    void (async () => {
      try {
        const outcome = await tryGenerateSessionTitle(
          this.config,
          controller.signal,
        );
        if (!outcome.ok) return;
        if (controller.signal.aborted) return;
        // Any explicit title, including `/rename --auto`, wins over this
        // background attempt even while its durable write is still pending.
        if (this.currentCustomTitle) return;
        if (this.pendingExplicitTitleWrites > 0) return;
        if (this.writeFailure) return;
        // Cross-process guard: another CLI tab writing to the same JSONL
        // could have renamed (manually) since we started. Re-read the file's
        // latest title record before we append so we don't clobber it.
        // Cost is one 64KB tail read; happens once per successful generation.
        try {
          const sessionService = this.config.getSessionService();
          const onDisk = sessionService.getSessionTitleInfo(
            this.config.getSessionId(),
          );
          if (onDisk.source === 'manual') {
            // Sync in-memory state with what landed on disk so subsequent
            // turns don't retry against a stale cache.
            this.currentCustomTitle = onDisk.title;
            this.currentTitleSource = 'manual';
            return;
          }
        } catch {
          // Best-effort — if the re-read fails for any reason, fall through
          // to the in-process check (which already passed) and proceed.
        }
        if (controller.signal.aborted) return;
        if (this.currentCustomTitle) return;
        if (this.pendingExplicitTitleWrites > 0) return;
        if (this.writeFailure) return;
        await this.persistCustomTitle(outcome.title, 'auto');
      } catch (err) {
        // Don't permanently disable: transient failures (network blips, rate
        // limits, bad UTF-16 in one turn's history) should still allow a
        // later turn to retry. The attempt cap bounds total waste.
        debugLogger.warn(
          `Auto-title generation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        // Clear only if we're still the active controller — `finalize()`
        // may have swapped to a new one during a subsequent session, and
        // we shouldn't overwrite that.
        if (this.autoTitleController === controller) {
          this.autoTitleController = undefined;
        }
      }
    })();
  }

  /**
   * Records tool results (function responses) sent back to the model.
   * Queues the write immediately on the serialized async writer.
   *
   * @param message The raw PartListUnion object with functionResponse parts
   * @param toolCallResult Optional tool call result info for UI recovery
   */
  recordToolResult(
    message: PartListUnion,
    toolCallResult?: Partial<ToolCallResponseInfo> & { status: Status },
    options?: RecordToolResultOptions,
  ): void {
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('tool_result'),
        ...(options?.goalContext
          ? { goalContext: copyGoalContext(options.goalContext) }
          : {}),
        ...(options?.provenance ? { provenance: options.provenance } : {}),
        message: createUserContent(message),
      };

      if (toolCallResult) {
        const recordingToolCallResult =
          sanitizeToolCallResultForRecording(toolCallResult);

        // special case for task executions - we don't want to record the tool calls
        if (
          typeof recordingToolCallResult.resultDisplay === 'object' &&
          recordingToolCallResult.resultDisplay !== null &&
          'type' in recordingToolCallResult.resultDisplay &&
          recordingToolCallResult.resultDisplay.type === 'task_execution'
        ) {
          const taskResult =
            recordingToolCallResult.resultDisplay as AgentResultDisplay;
          record.toolCallResult = {
            ...recordingToolCallResult,
            resultDisplay: {
              ...taskResult,
              toolCalls: [],
            },
          };
        } else {
          record.toolCallResult = recordingToolCallResult;
        }
      }

      this.appendRecord(record);
    } catch (error) {
      debugLogger.error('Error saving tool result:', error);
    }
  }

  /**
   * Records a slash command invocation as a system record. This keeps the model
   * history clean while allowing resume to replay UI output for commands like
   * /about.
   */
  recordSlashCommand(payload: SlashCommandRecordPayload): void {
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        type: 'system',
        subtype: 'slash_command',
        systemPayload: payload,
      };

      this.appendRecord(record);
    } catch (error) {
      debugLogger.error('Error saving slash command record:', error);
    }
  }

  /**
   * Records a chat compression checkpoint as a system record. This keeps the UI
   * history immutable while allowing resume/continue flows to reconstruct the
   * compressed model-facing history from the stored snapshot.
   */
  recordChatCompression(payload: ChatCompressionRecordPayload): void {
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        type: 'system',
        subtype: 'chat_compression',
        systemPayload: payload,
      };

      this.appendRecord(record);
    } catch (error) {
      debugLogger.error('Error saving chat compression record:', error);
    }
  }

  /**
   * Records a UI telemetry event for replaying metrics on resume.
   */
  recordUiTelemetryEvent(uiEvent: UiEvent): void {
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: { uiEvent },
      };

      this.appendRecord(record);
    } catch (error) {
      debugLogger.error('Error saving ui telemetry record:', error);
    }
  }

  /**
   * Records a conversation rewind and re-roots the parentUuid chain.
   *
   * Sets `lastRecordUuid` back to the UUID that was current just before the
   * target user turn was recorded, then appends a rewind system record.
   * This makes all messages after that point sit on a dead branch in the
   * UUID tree, so `reconstructHistory()` will skip them on resume.
   *
   * @param targetTurnIndex 0-based index of the user turn to rewind to.
   *   For example, 0 means rewind to the very first user message (keeping
   *   nothing before it), 1 means keep the first user turn, etc.
   * @param payload Additional metadata to persist with the rewind record.
   */
  rewindRecording(
    targetTurnIndex: number,
    payload: RewindRecordPayload,
    survivingFileHistorySnapshots?: FileHistorySnapshot[],
  ): void {
    try {
      // Re-root: point back to the record just before the target user turn.
      this.lastRecordUuid = this.turnParentUuids[targetTurnIndex] ?? null;
      // Trim future boundaries — they no longer exist in the active branch.
      this.turnParentUuids = this.turnParentUuids.slice(0, targetTurnIndex);
      // The previous attribution snapshot now sits on the abandoned
      // branch — clear the dedup key so the next snapshot lands on the
      // active branch and `/resume` can find it. Without this, a
      // post-rewind identical snapshot would be skipped and the rewound
      // session would lose all attribution state on restore.
      this.lastAttributionSnapshotJson = undefined;
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        type: 'system',
        subtype: 'rewind',
        systemPayload: payload,
      };

      this.appendRecord(record);

      // Re-record surviving file history snapshots on the active branch so
      // they are visible to reconstructHistory on resume.
      if (survivingFileHistorySnapshots?.length) {
        this.recordFileHistorySnapshotBatch(survivingFileHistorySnapshots);
      }
    } catch (error) {
      debugLogger.error('Error saving rewind record:', error);
    }
  }

  /**
   * Rebuilds `turnParentUuids` from a reconstructed message list.
   *
   * Call this after resuming a session so that subsequent rewinds within
   * the resumed session have correct boundary data. Also updates
   * `lastRecordUuid` to the last record in the chain.
   */
  rebuildTurnBoundaries(messages: ChatRecord[]): void {
    this.turnParentUuids = [];

    for (let i = 0; i < messages.length; i++) {
      const record = messages[i];
      if (
        record.type === 'user' &&
        record.subtype !== 'notification' &&
        record.subtype !== 'cron' &&
        record.subtype !== 'mid_turn_user_message'
      ) {
        // Reconstructed histories can start mid-chain; the persisted edge is
        // the source of truth, not the previous item in this sliced list.
        this.turnParentUuids.push(record.parentUuid ?? null);
      }
    }
    // Ensure lastRecordUuid points to the end of the reconstructed chain.
    if (messages.length > 0) {
      this.lastRecordUuid = messages[messages.length - 1].uuid;
      this.lastPersistedRecordUuid = this.lastRecordUuid;
    }
  }

  /**
   * Observer invoked after a custom title record lands (manual or auto).
   * The ACP session layer registers here to push a live title notification
   * to connected daemon clients — without it, auto-generated titles are
   * only discoverable via the next session-list poll (generation runs in
   * this child process; the daemon bridge never sees it happen).
   */
  private titleRecordedCallback?: (
    customTitle: string,
    titleSource: TitleSource,
    sessionId: string,
  ) => void;

  setTitleRecordedCallback(
    callback:
      | ((
          customTitle: string,
          titleSource: TitleSource,
          sessionId: string,
        ) => void)
      | undefined,
  ): void {
    this.titleRecordedCallback = callback;
  }

  /**
   * Returns the currently registered title-recorded callback.
   * Used to chain callbacks (e.g., when a UI component needs to observe
   * title changes without replacing an existing ACP notification callback).
   */
  getTitleRecordedCallback():
    | ((
        customTitle: string,
        titleSource: TitleSource,
        sessionId: string,
      ) => void)
    | undefined {
    return this.titleRecordedCallback;
  }

  /**
   * Durably records an explicit custom title for the session. Explicit title
   * requests take priority over the best-effort background auto-title task.
   *
   * @param customTitle The title text.
   * @param titleSource Where the title came from — defaults to `'manual'`
   *   so existing `/rename` call sites keep their behavior unchanged.
   * @returns true once the record is written, false on any I/O failure.
   */
  async recordCustomTitle(
    customTitle: string,
    titleSource: TitleSource = 'manual',
  ): Promise<boolean> {
    this.pendingExplicitTitleWrites++;
    this.autoTitleController?.abort();
    try {
      return await this.persistCustomTitle(customTitle, titleSource);
    } finally {
      this.pendingExplicitTitleWrites--;
    }
  }

  private async persistCustomTitle(
    customTitle: string,
    titleSource: TitleSource,
  ): Promise<boolean> {
    this.pendingTitleWrites++;
    let persisted = false;
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        type: 'system',
        subtype: 'custom_title',
        systemPayload: { customTitle, titleSource },
      };

      await this.appendRecordStrict(record);
      this.currentCustomTitle = customTitle;
      this.currentTitleSource = titleSource;
      try {
        this.titleRecordedCallback?.(
          customTitle,
          titleSource,
          record.sessionId,
        );
      } catch {
        // Observer errors must never break title recording.
      }
      persisted = true;
      return true;
    } catch (error) {
      if (error !== this.writeFailure) {
        debugLogger.error('Error saving custom title record:', error);
      }
      return false;
    } finally {
      this.pendingTitleWrites--;
      if (
        persisted &&
        this.pendingTitleWrites === 0 &&
        this.bytesSinceTitleAnchor >= TITLE_REANCHOR_BYTES &&
        !this.writeFailure
      ) {
        this.reanchorTitle();
      }
    }
  }

  /**
   * Records the session that spawned this one (a `create_sub_session` caller).
   * Appended as a system record near the start of the transcript so the parent
   * lineage persists with the session and survives a daemon restart (the
   * session list rehydrates it by scanning the transcript). Immutable — written
   * once when the sub-session is created.
   *
   * @param parentSessionId Id of the spawning session.
   * @returns true once the record is durably written, false on I/O error.
   *   AWAITS the write (via the strict append path) rather than the
   *   fire-and-forget `appendRecord`, whose failure is only observable through
   *   a later `flush()` and cannot determine this call's return value.
   */
  async recordParentSession(parentSessionId: string): Promise<boolean> {
    // Idempotent: the lineage is immutable and written once. A bridge retry
    // (the write succeeded but its response was lost) must not append a second
    // record — the session would then carry two `parent_session` entries.
    if (this.currentParentSessionId === parentSessionId) return true;
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        type: 'system',
        subtype: 'parent_session',
        systemPayload: { parentSessionId },
      };
      await this.appendRecordStrict(record);
      this.currentParentSessionId = parentSessionId;
      return true;
    } catch (error) {
      if (error !== this.writeFailure) {
        debugLogger.error('Error saving parent session record:', error);
      }
      return false;
    }
  }

  /** Persist immutable creator attribution near the start of the transcript. */
  async recordSessionSource(
    sourceType: string,
    sourceId?: string,
  ): Promise<boolean> {
    if (this.currentSourceType !== undefined) {
      return (
        this.currentSourceType === sourceType &&
        this.currentSourceId === sourceId
      );
    }
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        type: 'system',
        subtype: 'session_source',
        systemPayload: {
          sourceType,
          ...(sourceId !== undefined ? { sourceId } : {}),
        },
      };
      await this.appendRecordStrict(record);
      this.currentSourceType = sourceType;
      this.currentSourceId = sourceId;
      return true;
    } catch (error) {
      if (error !== this.writeFailure) {
        debugLogger.error('Error saving session source:', error);
      }
      return false;
    }
  }

  /**
   * Finalizes the current session by re-appending cached metadata to EOF, but
   * only after this recorder has appended non-title content since the last
   * title anchor. Pure load/resume must remain read-only so session lists do
   * not treat restored sessions as newly active.
   *
   * Best-effort: errors are logged but never thrown.
   */
  finalize(): void {
    // Cancel any pending auto-title LLM call — the session is transitioning
    // (switch / shutdown) and the result is no longer useful. Without this,
    // a slow fast-model call could keep a socket open past the logical end
    // of the session.
    if (this.autoTitleController) {
      try {
        this.autoTitleController.abort();
      } catch {
        // best-effort
      }
    }
    // A pending explicit rename owns the next title anchor. Re-appending the
    // previous cached title behind it would make the JSONL tail revert after
    // the rename succeeds.
    if (this.pendingExplicitTitleWrites > 0) {
      return;
    }
    if (!this.currentCustomTitle) {
      return;
    }
    if (!this.hasNonTitleContentSinceTitleAnchor) {
      return;
    }
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        type: 'system',
        subtype: 'custom_title',
        systemPayload: {
          customTitle: this.currentCustomTitle,
          ...(this.currentTitleSource
            ? { titleSource: this.currentTitleSource }
            : {}),
        },
      };
      this.appendRecord(record);
    } catch (error) {
      debugLogger.error('Error finalizing session metadata:', error);
    }
  }

  /**
   * Records @-command metadata as a system record for UI reconstruction.
   */
  recordAtCommand(payload: AtCommandRecordPayload): void {
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        type: 'system',
        subtype: 'at_command',
        systemPayload: payload,
      };

      this.appendRecord(record);
    } catch (error) {
      debugLogger.error('Error saving @-command record:', error);
    }
  }

  /**
   * Records an attribution state snapshot for session persistence.
   * Called at the start of every non-retry turn so that a resumed session
   * sees the most recent state including edits made during the prior turn.
   *
   * Deduplicates identical successive writes: if the snapshot's JSON
   * form is byte-identical to the last one we wrote, skip the append.
   * Without this, sessions that touch many files would write a full
   * duplicate of the entire snapshot to the JSONL on every turn, even
   * when nothing changed — inflating session size and slowing /resume.
   *
   * Set the dedup key optimistically so synchronous identical calls (common
   * during a tool-driven turn) dedup correctly. A synchronous setup failure
   * rolls the key back; an async write failure permanently degrades this
   * recorder, so the current instance never retries it.
   */
  recordAttributionSnapshot(snapshot: AttributionSnapshot): void {
    let json: string | undefined;
    try {
      this.cachedGitBranch = undefined;
      json = JSON.stringify(snapshot);
      if (json === this.lastAttributionSnapshotJson) {
        return;
      }
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        type: 'system',
        subtype: 'attribution_snapshot',
        systemPayload: { snapshot },
      };

      this.lastAttributionSnapshotJson = json;
      this.appendRecord(record);
    } catch (error) {
      // Synchronous setup failures happen before an async write is queued and
      // do not degrade the recorder, so roll back the optimistic dedup key to
      // let the next identical snapshot retry.
      if (json !== undefined && this.lastAttributionSnapshotJson === json) {
        this.lastAttributionSnapshotJson = undefined;
      }
      debugLogger.error('Error saving attribution snapshot:', error);
    }
  }

  recordFileHistorySnapshot(snapshot: FileHistorySnapshot): void {
    try {
      this.appendSerializedFileHistorySnapshotBatch([
        serializeSnapshot(snapshot),
      ]);
    } catch (error) {
      debugLogger.error('Error saving file history snapshot:', error);
    }
  }

  recordFileHistorySnapshotBatch(snapshots: FileHistorySnapshot[]): void {
    if (snapshots.length === 0) return;
    try {
      const serialized = snapshots.map(serializeSnapshot);
      this.appendSerializedFileHistorySnapshotBatch(serialized);
    } catch (error) {
      debugLogger.error('Error saving file history snapshot batch:', error);
    }
  }

  async recordUserTextElements(
    payload: UserTextElementsRecordPayload,
  ): Promise<void> {
    const record: ChatRecord = {
      ...this.createBaseRecord('system'),
      type: 'system',
      subtype: 'user_text_elements',
      systemPayload: payload,
    };
    await this.appendRecordStrict(record);
  }

  private appendSerializedFileHistorySnapshotBatch(
    snapshots: SerializedFileHistorySnapshot[],
  ): void {
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        type: 'system',
        subtype: 'file_history_snapshot',
        systemPayload: { snapshots },
      };
      this.appendRecord(record);
    } catch (error) {
      debugLogger.error('Error saving file history snapshot batch:', error);
    }
  }

  async recordSessionArtifactEvent(
    payload: SessionArtifactEventRecordPayload,
  ): Promise<void> {
    const record: ChatRecord = {
      ...this.createBaseRecord('system'),
      type: 'system',
      subtype: 'session_artifact_event',
      systemPayload: payload,
    };
    await this.appendRecordStrict(record, { updateActiveTail: false });
  }

  async recordSessionArtifactSnapshot(
    payload: SessionArtifactSnapshotRecordPayload,
  ): Promise<void> {
    const record: ChatRecord = {
      ...this.createBaseRecord('system'),
      type: 'system',
      subtype: 'session_artifact_snapshot',
      systemPayload: payload,
    };
    await this.appendRecordStrict(record, { updateActiveTail: false });
  }
}
