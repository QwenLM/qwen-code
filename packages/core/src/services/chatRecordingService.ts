/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { shellResultText } from '../utils/shell-result.js';
import type { SessionSourcesSnapshot } from './session-sources.js';
import type { ContentBlock } from '@agentclientprotocol/sdk';

import { type Config } from '../config/config.js';
import {
  backgroundTurnContext,
  type BackgroundNotificationTurn,
} from '../utils/background-turn-context.js';
import { getCurrentAgentId } from '../agents/runtime/agent-context.js';
import { ApprovalMode } from '../config/approval-mode.js';
import path from 'node:path';
import fs from 'node:fs';
import { isManagedExecutionTranscriptSync } from '../utils/sessionStorageUtils.js';
import {
  SessionExecutionEngineError,
  type SessionExecutionEngine,
  type SessionExecutionEnginePayload,
} from './session-execution-engine.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  PartListUnion,
  Content,
  FunctionDeclaration,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import { createModelContent, createUserContent } from '../core/genai-compat.js';
import * as jsonl from '../utils/jsonl-utils.js';
import { getGitBranch } from '../utils/gitUtils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  observeToolResultBoundary,
  toolResultBoundaryArtifact,
  toolResultPartDiagnosticValues,
} from '../tools/tool-result-boundary-diagnostics.js';
import { compactToolResultDisplayForRecording } from '../utils/toolResultDisplayCompaction.js';
import { stripRuntimeSnapshotPrefix } from '../utils/runtimeModelPrefix.js';
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
  type SessionWriterCommitProof,
  type SessionWriterLease,
} from './session-writer-lease.js';
import { prepareTranscriptRecords } from '../utils/transcript-records.js';
import type {
  AgentMentionRecordPayload,
  AgentMessageRecordPayload,
} from '../agents/session-agents/contract.js';
import type {
  GoalStateRecordPayloadV2,
  GoalTurnPermit,
  TranscriptCursor,
} from '../goals/goal-protocol.js';
import {
  collectPendingBranchToolCalls,
  resolveCompletedTurnBranchCandidateFromRecords,
  updatePendingBranchToolCalls,
  type BranchCheckpointRecordPayloadV1,
  type BranchPoint,
  type BranchToolCallIdentity,
} from './branch-points.js';
import { getApiHistoryPromptId } from './session-api-history.js';

const debugLogger = createDebugLogger('CHAT_RECORDING');

/**
 * Maximum number of auto-title generation attempts per session. See
 * {@link ChatRecordingService.autoTitleAttempts} for the rationale behind
 * retrying across turns.
 */
const AUTO_TITLE_ATTEMPT_CAP = 3;
const MAX_TITLE_USER_DISPLAY_TEXTS = 20;
const SESSION_FILE_DIFF_AGGREGATE_CHAR_LIMIT = 100_000;
const SESSION_FILE_DIFF_CHAR_LIMIT = 50_000;
const SESSION_FILE_CONTENT_CHAR_LIMIT = 16_000;

/**
 * Re-append tail-readable metadata to EOF once this many bytes of other JSONL
 * content have been written since its last anchor. Half of the reader's 64KB
 * tail window leaves room for the anchor record itself.
 */
const METADATA_REANCHOR_BYTES = 32 * 1024;

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
  | 'execution_output'
  | 'goal_control'
  | 'goal_runtime'
  | 'system'
  /** Written on behalf of a workspace agent (session multi-agent). */
  | 'external_agent';

export type RecordToolResultOptions = {
  subtype?: 'code_mode_tool_result';
} & (
  | {
      goalContext?: GoalTurnPermit;
      provenance?: 'tool_result';
    }
  | {
      goalContext: GoalTurnPermit;
      provenance: 'goal_runtime' | 'execution_output';
    }
);

function copyGoalContext(goalContext: GoalTurnPermit): GoalTurnPermit {
  return {
    goalId: goalContext.goalId,
    revision: goalContext.revision,
    turnId: goalContext.turnId,
  };
}

/** An `agent_mention` / `agent_message` record found by its key. */
export interface ExternalAgentRecordRef {
  uuid: string;
  /** The record's own ISO 8601 timestamp. */
  timestamp: string;
}

/**
 * Where a Managed session's records go instead of the transcript: the record
 * sink of its Managed Session authority. Declared structurally so this module
 * does not depend on the managed runtime.
 */
export interface ManagedSessionRecordWriter {
  /**
   * Whether the Managed Session format has a mapping for the record and the
   * record has the shape that mapping takes.
   */
  canCarry(record: ChatRecord): boolean;
  /** Commits the record to the log as a Managed transaction. */
  write(record: ChatRecord): Promise<void>;
  /** The reader-facing records rebuilt from the log, in log order. */
  project(): Promise<ChatRecord[]>;
  /** Records that this session stopped advancing the log. */
  stopAdvancing(): Promise<void>;
  /** The committed position the writer is sealed with. */
  commitProof(): SessionWriterCommitProof;
  /** The log's size in bytes, or `undefined` when it cannot be read. */
  logSize(): number | undefined;
}

/**
 * A record the Managed Session format has no mapping for, or a record in a
 * shape its mapping does not take. It is refused before it is queued, so the
 * session keeps recording.
 */
export class ManagedSessionRecordRefusedError extends Error {
  readonly code = 'managed_session_record_refused';

  constructor(record: Pick<ChatRecord, 'type' | 'subtype'>) {
    super(
      `A Managed session cannot record a ${record.type} record` +
        `${record.subtype ? ` with subtype ${record.subtype}` : ''}.`,
    );
    this.name = 'ManagedSessionRecordRefusedError';
  }
}

export interface ChatRecord {
  /** Daemon admission identity, distinct from CLI file-history prompt IDs. */
  daemonPromptId?: string;
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
    | 'background_task_completed'
    | 'cron'
    | 'mid_turn_user_message'
    | 'custom_title'
    | 'parent_session'
    | 'session_source'
    | 'session_execution_engine'
    | 'omni_recall'
    | 'session_model'
    | 'session_approval_mode'
    | 'rewind'
    | 'agent_bootstrap'
    | 'agent_launch_prompt'
    | 'agent_retry'
    | 'agent_session_ready'
    | 'file_history_snapshot'
    | 'user_text_elements'
    | 'session_artifact_event'
    | 'session_artifact_snapshot'
    | 'session_sources_snapshot'
    | 'branch_checkpoint'
    | 'goal_state'
    | 'goal_runtime'
    | 'goal_turn_end'
    | 'code_mode_tool_result'
    | 'realtime_message'
    | 'turn_result'
    | 'managed_session_header_v1'
    | 'managed_session_event_v1'
    | 'managed_session_commit_v1'
    // Session multi-agent records (agents/session-agents/contract.ts). Both
    // are `type: 'user'`: kept in model history, but never a real user
    // prompt, a turn boundary, a title source, or a cold notification.
    | 'agent_mention'
    | 'agent_message';
  /** Explicit source classification used by Goal evidence validation. */
  provenance?: ChatRecordProvenance;
  /** Goal identity and logical turn that owned this model-facing record. */
  goalContext?: GoalTurnPermit;
  backgroundTurn?: BackgroundNotificationTurn;
  /**
   * `true` on a `subtype: 'notification'` record that IS the user entry of a
   * turn the `LlmClient.sendMessageStream` send path admitted and went on to
   * send (`client.ts`), so the stamp exists even where the admission branch
   * runs outside `backgroundTurnContext`. Records persisted BEFORE their turn
   * ran (`recordNotificationStrict`, the pre-send `recordNotification` copies)
   * carry no stamp. This is the only reliable separator between the two — both
   * share `provenance: 'system'` + `subtype: 'notification'`, and
   * `backgroundTurn` vanishes on the `channelTask` admission branch
   * (`backgroundTurnContext.exit`). Session recovery trims only unstamped
   * notification records: a stamped-but-unanswered entry is treated as an
   * `interrupted_prompt`, not as a cold notification nobody owes a response.
   *
   * The stamp means "admitted and sent", NOT "the model accepted a request".
   * Every pre-send refusal gate on that path — `MaxSessionTurns`,
   * `!boundedTurns`, the session token limit, the arena control signal —
   * returns after the record is appended, and an abort before the first token
   * does too, so a refused or aborted turn is stamped as well and then
   * recovers as `interrupted_prompt`. That false positive is accepted: the
   * record cannot move below the gates without losing the resumed info item it
   * exists to restore, and an appended JSONL record cannot be mutated
   * afterwards. Only the abort arm needs no setup — the gates are off or
   * unreachable by default (`maxSessionTurns` is `-1`, the arena client is
   * unset, `boundedTurns` reaches 0 only once the turn recursion is
   * exhausted) — and the only observable symptom today is one recovery banner
   * line, because no consumer of a record-derived plan reads `continuation`.
   * Pinned by the cap-refusal case in `client.test.ts`.
   */
  deliveredTurn?: boolean;
  /** Working directory at time of message */
  cwd: string;
  /** CLI version for compatibility tracking */
  version: string;
  /** Current git branch, if available */
  gitBranch?: string;
  /** Stable identity shared with the visible user turn and API history. */
  promptId?: string;

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
    | SessionModelRecordPayload
    | SessionExecutionEnginePayload
    | SessionApprovalModeRecordPayload
    | NotificationRecordPayload
    | UserPromptRecordPayload
    | RewindRecordPayload
    | AgentBootstrapRecordPayload
    | AgentRetryRecordPayload
    | AgentSessionReadyRecordPayload
    | FileHistorySnapshotRecordPayload
    | UserTextElementsRecordPayload
    | SessionArtifactEventRecordPayload
    | SessionArtifactSnapshotRecordPayload
    | SessionSourcesSnapshot
    | BranchCheckpointRecordPayloadV1
    | GoalStateRecordPayloadV2
    | GoalTurnEndRecordPayload
    | TurnResultRecordPayload
    | AgentMessageRecordPayload
    | AgentMentionRecordPayload;

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
   * Idempotency key of an `agent_mention` / `agent_message` record the daemon
   * asked for (`recordExternalAgentRecordStrict`). Persisted so a re-sent
   * request after a restart finds the record instead of writing a second one.
   */
  externalRecordKey?: string;

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
  attachmentReferences?: UserPromptAttachmentReference[];
  backgroundTask?: {
    taskId: string;
    status: string;
    /** `peer`: a message from another session; `taskId` is the message id. */
    kind: 'agent' | 'monitor' | 'shell' | 'workflow' | 'peer';
    toolUseId?: string;
    sourceTurnId?: string;
    /** Structured fields for i18n rendering (persisted for page refresh). */
    description?: string;
    commandLabel?: string;
    eventCount?: number;
    droppedLines?: number;
  };
}

export interface UserPromptRecordPayload {
  /**
   * Core/headless: submitted projection, otherwise expanded pre-hook text.
   * ACP: display projection or raw request text before expansion. ACP omits
   * this payload when no projection, references, or input annotations exist.
   */
  displayText: string;
  /** Sanitized hook context duplicated from the tagged model-bound part. */
  hookContext: string;
  /** UI-only annotations; interpreted by transcript consumers, not the model. */
  inputAnnotations?: unknown[];
  /** Daemon-owned attachment references used to restore prompt previews. */
  attachmentReferences?: UserPromptAttachmentReference[];
  /** Original ACP resource references, independent of model-input expansion. */
  resourceLinks?: Array<Extract<ContentBlock, { type: 'resource_link' }>>;
}

export interface UserPromptAttachmentReference {
  type: 'image' | 'resource';
  attachmentId: string;
  mimeType: string;
  size: number;
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
   * Legacy launch-time system instruction. Current writers omit this field and
   * resume reconstructs the instruction from the current parent runtime.
   */
  systemInstruction?: string | Content;
  /**
   * Legacy launch-time tool declarations / allowlist. Current writers omit
   * this field and resume resolves tool names through the current registry.
   */
  tools?: Array<string | FunctionDeclaration>;
}

export interface AgentSessionReadyRecordPayload {
  callId: string;
  subagentSessionReady: boolean;
}

export interface AgentRetryRecordPayload {
  /** 1-based attempt number this attach resumes with (2+ on a retry). */
  attempt: number;
}

/**
 * Stored payload for chat compression checkpoints. This allows us to rebuild the
 * effective chat history on resume while keeping the original UI-visible history.
 *
 * NOTE: the payload carries `ChatCompressionInfo`, which has no
 * `compressionKind` — the 'summarize' vs 'fast' distinction (see
 * `CompressionProps.compressionKind` in cli's ui/types.ts) exists only on
 * ephemeral UI items today. If resume ever reconstructs compression markers
 * from this record, it must re-derive the kind; rebuilding every marker
 * kind-less and falling back to 'summarize' would misclassify fast markers
 * as truncation boundaries and re-introduce the silent pre-marker history
 * drop of #9320 on any session that ran /compress-fast before being resumed.
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
  /** Prompt identities parallel to compressedHistory. */
  promptIds?: Array<string | null>;
  completedToolCallIds?: string[];
}

export interface GoalTurnEndRecordPayload {
  toolCallId: string;
}

export interface SlashCommandRecordPayload {
  /** Whether this record represents the invocation or the resulting output. */
  phase: 'invocation' | 'result';
  /** Raw user-entered slash command (e.g., "/about"). */
  rawCommand: string;
  /** Whether the visible slash-command invocation reached model history. */
  sentToModel?: boolean;
  /**
   * Whether the UI intentionally hid this invocation from visible history,
   * so resume/preview reconstruction skips the user row as well.
   */
  hiddenInvocation?: boolean;
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

/** Last-wins binding of the model a daemon session should restore. */
export interface SessionModelRecordPayload {
  modelId: string;
  authType: string;
  baseUrl?: string;
  isRuntime?: boolean;
}

/** Last-wins approval state a daemon session should restore. */
export interface SessionApprovalModeRecordPayload {
  mode: ApprovalMode;
  prePlanMode?: ApprovalMode;
  planExecutionMode?: ApprovalMode;
}

interface SessionApprovalModeRecordCandidate {
  mode: ApprovalMode;
  prePlanMode?: unknown;
  planExecutionMode?: unknown;
}

const APPROVAL_MODE_VALUES = new Set<string>(Object.values(ApprovalMode));

function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === 'string' && APPROVAL_MODE_VALUES.has(value);
}

export function isValidSessionApprovalModePayload(
  payload: unknown,
): payload is SessionApprovalModeRecordCandidate {
  const candidate = payload as
    | SessionApprovalModeRecordCandidate
    | null
    | undefined;
  if (!isApprovalMode(candidate?.mode)) return false;
  if (candidate.mode !== ApprovalMode.PLAN) return true;
  return (
    (candidate.prePlanMode === undefined ||
      (isApprovalMode(candidate.prePlanMode) &&
        candidate.prePlanMode !== ApprovalMode.PLAN)) &&
    (candidate.planExecutionMode === undefined ||
      (isApprovalMode(candidate.planExecutionMode) &&
        candidate.planExecutionMode !== ApprovalMode.PLAN))
  );
}

export function normalizeSessionApprovalModePayload(
  payload: SessionApprovalModeRecordCandidate,
): SessionApprovalModeRecordPayload {
  if (payload.mode !== ApprovalMode.PLAN) {
    return { mode: payload.mode };
  }
  return {
    mode: ApprovalMode.PLAN,
    prePlanMode:
      isApprovalMode(payload.prePlanMode) &&
      payload.prePlanMode !== ApprovalMode.PLAN
        ? payload.prePlanMode
        : ApprovalMode.DEFAULT,
    ...(isApprovalMode(payload.planExecutionMode) &&
    payload.planExecutionMode !== ApprovalMode.PLAN
      ? { planExecutionMode: payload.planExecutionMode }
      : {}),
  };
}

export function sessionApprovalModePayloadsEqual(
  a: SessionApprovalModeRecordPayload,
  b: SessionApprovalModeRecordPayload,
): boolean {
  return (
    a.mode === b.mode &&
    a.prePlanMode === b.prePlanMode &&
    a.planExecutionMode === b.planExecutionMode
  );
}

export function isValidSessionModelPayload(
  payload: unknown,
): payload is SessionModelRecordPayload {
  const candidate = payload as SessionModelRecordPayload | null | undefined;
  return (
    typeof candidate?.modelId === 'string' &&
    Boolean(candidate.modelId.trim()) &&
    typeof candidate.authType === 'string' &&
    Boolean(candidate.authType.trim())
  );
}

export function normalizeSessionModelPayload(
  payload: SessionModelRecordPayload,
): SessionModelRecordPayload {
  const normalized: SessionModelRecordPayload = {
    modelId: stripRuntimeSnapshotPrefix(payload.modelId.trim()),
    authType: payload.authType.trim(),
  };
  if (payload.baseUrl !== undefined) {
    normalized.baseUrl = payload.baseUrl;
  }
  if (payload.isRuntime) {
    normalized.isRuntime = true;
  }
  return normalized;
}

export function sessionModelPayloadsEqual(
  a: SessionModelRecordPayload,
  b: SessionModelRecordPayload,
): boolean {
  return (
    a.modelId === b.modelId &&
    a.authType === b.authType &&
    (a.baseUrl ?? '') === (b.baseUrl ?? '') &&
    Boolean(a.isRuntime) === Boolean(b.isRuntime)
  );
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

/**
 * Cap (in UTF-16 code units) on the prompt / result text stored in a
 * `turn_result` record. Writers truncate and set the paired flag.
 */
export const TURN_RESULT_TEXT_MAX_CHARS = 32_768;
export const TURN_RESULT_ERROR_MESSAGE_MAX_CHARS = 4_096;
export const TURN_RESULT_ERROR_CODE_MAX_CHARS = 256;
export const TURN_RESULT_IDENTIFIER_MAX_CHARS = 256;

export const TURN_RESULT_CODE_TEXT_TRUNCATED = 'RESULT_TEXT_TRUNCATED' as const;
export type TurnResultCode = typeof TURN_RESULT_CODE_TEXT_TRUNCATED;

export interface TurnResultErrorPayload {
  message: string;
  code?: string;
  messageTruncated?: boolean;
  codeTruncated?: boolean;
}

function readTurnResultErrorField(
  error: unknown,
  field: 'message' | 'code' | 'rpcCode',
): unknown {
  if (
    (typeof error !== 'object' || error === null) &&
    typeof error !== 'function'
  ) {
    return undefined;
  }
  try {
    return Reflect.get(error, field);
  } catch {
    return undefined;
  }
}

function truncateTurnResultErrorField(
  value: string,
  maxChars: number,
): { value: string; truncated: boolean } {
  return value.length > maxChars
    ? { value: value.slice(0, maxChars), truncated: true }
    : { value, truncated: false };
}

export function normalizeTurnResultError(
  error: unknown,
): TurnResultErrorPayload {
  const rawMessage = readTurnResultErrorField(error, 'message');
  let message =
    typeof rawMessage === 'string' && rawMessage.length > 0
      ? rawMessage
      : undefined;
  if (message === undefined) {
    try {
      const converted = String(error);
      if (converted.length > 0) message = converted;
    } catch {
      // Use the stable fallback below.
    }
  }
  const boundedMessage = truncateTurnResultErrorField(
    message ?? 'Unknown error',
    TURN_RESULT_ERROR_MESSAGE_MAX_CHARS,
  );

  const rawCode =
    readTurnResultErrorField(error, 'code') ??
    readTurnResultErrorField(error, 'rpcCode');
  const code =
    typeof rawCode === 'string' && rawCode.length > 0
      ? rawCode
      : typeof rawCode === 'number'
        ? String(rawCode)
        : undefined;
  const boundedCode =
    code === undefined
      ? undefined
      : truncateTurnResultErrorField(code, TURN_RESULT_ERROR_CODE_MAX_CHARS);

  return {
    message: boundedMessage.value,
    ...(boundedMessage.truncated ? { messageTruncated: true } : {}),
    ...(boundedCode ? { code: boundedCode.value } : {}),
    ...(boundedCode?.truncated ? { codeTruncated: true } : {}),
  };
}

/**
 * Settled outcome of one admitted prompt, appended at turn settle so
 * pollable turn-status queries survive daemon restarts. `state`
 * distinguishes normal completion (`completed`, with `stopReason`),
 * user/abort cancellation (`cancelled`), and failure (`error`).
 */
export interface TurnResultRecordPayload {
  promptId: string;
  state: 'completed' | 'cancelled' | 'error';
  stopReason?: string;
  error?: TurnResultErrorPayload;
  /** Epoch ms the turn started executing (agent clock). */
  startedAt?: number;
  /** Epoch ms the user-cancel signal was received (agent clock). */
  cancelledAt?: number;
  /** Epoch ms the turn settled (agent clock). */
  endedAt: number;
  promptText?: string;
  promptTextTruncated?: boolean;
  resultText?: string;
  resultTruncated?: boolean;
  resultCode?: TurnResultCode;
  originatorClientId?: string;
}

export function isTurnResultRecordPayload(
  value: unknown,
): value is TurnResultRecordPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  if (
    typeof payload['promptId'] !== 'string' ||
    payload['promptId'].length === 0 ||
    payload['promptId'].length > TURN_RESULT_IDENTIFIER_MAX_CHARS ||
    !['completed', 'cancelled', 'error'].includes(payload['state'] as string) ||
    typeof payload['endedAt'] !== 'number' ||
    !Number.isFinite(payload['endedAt'])
  ) {
    return false;
  }
  const optionalString = (field: string, maxChars?: number) => {
    const fieldValue = payload[field];
    return (
      fieldValue === undefined ||
      (typeof fieldValue === 'string' &&
        (maxChars === undefined || fieldValue.length <= maxChars))
    );
  };
  const optionalBoolean = (field: string) =>
    payload[field] === undefined || typeof payload[field] === 'boolean';
  const optionalTimestamp = (field: string) =>
    payload[field] === undefined ||
    (typeof payload[field] === 'number' && Number.isFinite(payload[field]));
  if (
    !optionalString('stopReason', TURN_RESULT_IDENTIFIER_MAX_CHARS) ||
    !optionalTimestamp('startedAt') ||
    !optionalTimestamp('cancelledAt') ||
    !optionalString('promptText', TURN_RESULT_TEXT_MAX_CHARS) ||
    !optionalBoolean('promptTextTruncated') ||
    !optionalString('resultText', TURN_RESULT_TEXT_MAX_CHARS) ||
    !optionalBoolean('resultTruncated') ||
    !optionalString('originatorClientId', TURN_RESULT_IDENTIFIER_MAX_CHARS) ||
    (payload['resultCode'] !== undefined &&
      (payload['resultCode'] !== TURN_RESULT_CODE_TEXT_TRUNCATED ||
        payload['resultTruncated'] !== true))
  ) {
    return false;
  }
  const error = payload['error'];
  if (error === undefined) return payload['state'] !== 'error';
  if (
    payload['state'] !== 'error' ||
    typeof error !== 'object' ||
    error === null
  ) {
    return false;
  }
  const fields = error as Record<string, unknown>;
  return (
    typeof fields['message'] === 'string' &&
    fields['message'].length > 0 &&
    fields['message'].length <= TURN_RESULT_ERROR_MESSAGE_MAX_CHARS &&
    (fields['code'] === undefined ||
      (typeof fields['code'] === 'string' &&
        fields['code'].length > 0 &&
        fields['code'].length <= TURN_RESULT_ERROR_CODE_MAX_CHARS)) &&
    (fields['messageTruncated'] === undefined ||
      typeof fields['messageTruncated'] === 'boolean') &&
    (fields['codeTruncated'] === undefined ||
      typeof fields['codeTruncated'] === 'boolean')
  );
}

export interface ChatRecordingFailureEvent {
  sessionId: string;
  error: Error;
}

export type ChatRecordingFailureListener = (
  event: ChatRecordingFailureEvent,
) => void | Promise<void>;

interface BufferedRecordAppend {
  record: ChatRecord;
  options: { updateActiveTail?: boolean } | undefined;
  resolve?: () => void;
  reject?: (error: unknown) => void;
}

interface TranscriptTopologyFence {
  buffered: BufferedRecordAppend[];
}

export interface BranchCheckpointCursor {
  recordId: string | null;
  activeRecordCount: number;
  pendingToolCalls: readonly BranchToolCallIdentity[];
}

export interface ChatRecordingRestoreState {
  lastCompletedUuid: string;
  turnParentUuids: Array<string | null>;
  customTitle?: string;
  titleSource?: TitleSource;
  parentSessionId?: string;
  sourceType?: string;
  sourceId?: string;
  sessionModel?: SessionModelRecordPayload;
  sessionApprovalMode?: SessionApprovalModeRecordPayload;
}

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
  /** Active chain mirrored in memory so end-of-turn validation is incremental. */
  private activeBranchRecords: ChatRecord[] = [];
  /** Parent of the first mirrored record, or the restored tail before appends. */
  private activeBranchBaseUuid: string | null = null;
  /** Unclosed tool calls at the current active tail. */
  private pendingBranchToolCalls: BranchToolCallIdentity[] = [];
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
  /** Session identity pinned by `pinSessionIdentity` at rotation time. */
  private pinnedSessionId: string | undefined;
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
  private acceptingWrites = false;
  private closePromise: Promise<void> | undefined;
  private handoffRequested = false;
  /** Prevents asynchronous metadata writers from becoming checkpoint siblings. */
  private topologyFence: TranscriptTopologyFence | undefined;
  /** First async JSONL write failure; permanently degrades this recorder. */
  private writeFailure: Error | undefined;
  private integrityFailure: Error | undefined;
  private readonly writerLeaseRequired: boolean;
  /**
   * `externalRecordKey` -> record of the active chain, built from the
   * transcript on first use and extended by every external record written.
   */
  private externalRecordIndex: Map<string, ExternalAgentRecordRef> | undefined;
  private externalRecordIndexLoad:
    | Promise<Map<string, ExternalAgentRecordRef>>
    | undefined;
  /** Bumped whenever recorder state is rebuilt; a stale index load is dropped. */
  private externalRecordIndexGeneration = 0;
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
  /** Last-wins daemon session model binding, used to skip duplicate writes. */
  private currentSessionModel: SessionModelRecordPayload | undefined;
  /** Last-wins daemon session approval state, used to skip duplicate writes. */
  private currentSessionApprovalMode:
    | SessionApprovalModeRecordPayload
    | undefined;
  private readonly userDisplayTextsForTitle: Array<string | undefined> = [];
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
  /** Source writes whose durable result and cached value are unresolved. */
  private pendingSourceWrites = 0;

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
  private bytesSinceSourceAnchor = 0;

  constructor(
    config: Config,
    private readonly onWriteFailure?: ChatRecordingFailureListener,
    writerLeaseRequired = config.isSessionWriterLeaseEnabled?.() ??
      config.getExperimentalZedIntegration?.() ??
      true,
    restoreState?: ChatRecordingRestoreState,
  ) {
    this.config = config;
    this.writerLeaseRequired = writerLeaseRequired;
    const resumed = config.getResumedSessionData();
    if (writerLeaseRequired) {
      this.lastRecordUuid =
        restoreState?.lastCompletedUuid ?? resumed?.lastCompletedUuid ?? null;
      this.lastPersistedRecordUuid = this.lastRecordUuid;
    } else {
      this.state = 'active';
      this.acceptingWrites = true;
      if (restoreState) {
        this.restoreProjectedState(restoreState);
      } else {
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
    }
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
    return (
      this.binding?.sessionId ??
      this.pinnedSessionId ??
      this.config.getSessionId()
    );
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
    if (isManagedExecutionTranscriptSync(conversationFile)) {
      throw new SessionExecutionEngineError(
        this.getSessionId(),
        'belongs to managed, cannot record with legacy',
      );
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
    this.lastPersistedRecordUuid = this.lastRecordUuid;
    this.resetExternalRecordIndex();
    this.currentCustomTitle = undefined;
    this.currentTitleSource = undefined;
    this.currentParentSessionId = undefined;
    this.currentSourceType = undefined;
    this.currentSourceId = undefined;
    this.currentSessionModel = undefined;
    this.currentSessionApprovalMode = undefined;
    this.activeBranchRecords = [];
    this.activeBranchBaseUuid = null;
    this.pendingBranchToolCalls = [];
    this.userDisplayTextsForTitle.length = 0;
    if (!sessionData) return;
    this.rebuildTurnBoundaries(sessionData.conversation.messages);
    for (const record of sessionData.conversation.messages) {
      if (record.type === 'user' && record.subtype === undefined) {
        this.trackUserDisplayTextForTitle(
          (record.systemPayload as UserPromptRecordPayload | undefined)
            ?.displayText,
        );
      }
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
      } else if (record.subtype === 'session_model') {
        if (isValidSessionModelPayload(record.systemPayload)) {
          this.currentSessionModel = normalizeSessionModelPayload(
            record.systemPayload,
          );
        }
      } else if (record.subtype === 'session_approval_mode') {
        if (isValidSessionApprovalModePayload(record.systemPayload)) {
          this.currentSessionApprovalMode = normalizeSessionApprovalModePayload(
            record.systemPayload,
          );
        }
      }
    }
    if (persistedTitleInfo !== undefined) {
      this.currentCustomTitle = persistedTitleInfo.title;
      this.currentTitleSource = persistedTitleInfo.source;
    }
    if (this.currentCustomTitle) {
      this.bytesSinceTitleAnchor = METADATA_REANCHOR_BYTES;
    }
    if (this.currentSourceType) {
      this.bytesSinceSourceAnchor = METADATA_REANCHOR_BYTES;
    }
  }

  private trackUserDisplayTextForTitle(displayText: string | undefined): void {
    this.userDisplayTextsForTitle.push(displayText);
    if (this.userDisplayTextsForTitle.length > MAX_TITLE_USER_DISPLAY_TEXTS) {
      this.userDisplayTextsForTitle.shift();
    }
  }

  private restoreProjectedState(state: ChatRecordingRestoreState): void {
    this.lastRecordUuid = state.lastCompletedUuid;
    this.lastPersistedRecordUuid = state.lastCompletedUuid;
    this.resetExternalRecordIndex();
    this.activeBranchBaseUuid = state.lastCompletedUuid;
    this.turnParentUuids = [...state.turnParentUuids];
    this.currentCustomTitle = state.customTitle;
    this.currentTitleSource = state.titleSource;
    this.currentParentSessionId = state.parentSessionId;
    this.currentSourceType = state.sourceType;
    this.currentSourceId = state.sourceId;
    this.currentSessionModel = state.sessionModel
      ? normalizeSessionModelPayload(state.sessionModel)
      : undefined;
    this.currentSessionApprovalMode = state.sessionApprovalMode
      ? normalizeSessionApprovalModePayload(state.sessionApprovalMode)
      : undefined;
    if (this.currentCustomTitle) {
      this.bytesSinceTitleAnchor = METADATA_REANCHOR_BYTES;
    }
    if (this.currentSourceType) {
      this.bytesSinceSourceAnchor = METADATA_REANCHOR_BYTES;
    }
  }

  activate(
    lease: SessionWriterLease,
    sessionData?: {
      conversation: { messages: ChatRecord[] };
      lastCompletedUuid: string | null;
    },
    persistedTitleInfo?: { title?: string; source?: TitleSource },
    restoreState?: ChatRecordingRestoreState,
  ): void {
    if (
      !this.writerLeaseRequired ||
      this.state !== 'inactive' ||
      lease.sessionId !== this.config.getSessionId()
    ) {
      throw new SessionWriterUnavailableError();
    }
    this.binding = { sessionId: lease.sessionId, lease };
    if (restoreState) {
      this.restoreProjectedState(restoreState);
    } else {
      this.restoreSessionState(sessionData, persistedTitleInfo);
    }
    this.state = 'active';
    this.acceptingWrites = true;
  }

  /**
   * Creates base fields for a ChatRecord.
   */
  private createBaseRecord(
    type: ChatRecord['type'],
  ): Omit<ChatRecord, 'message' | 'tokens' | 'model' | 'toolCallsMetadata'> {
    const cwd = this.config.getProjectRoot();
    const background = backgroundTurnContext.getStore();
    const backgroundTurn =
      background?.active &&
      background.sessionId === this.getSessionId() &&
      !getCurrentAgentId()
        ? background.turn
        : undefined;
    return {
      ...(backgroundTurn ? { backgroundTurn } : {}),
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
    this.acceptingWrites = false;
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
      this.lastRecordUuid = this.lastPersistedRecordUuid;
      debugLogger.error('Chat recording failure:', this.writeFailure);
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

  private updateActiveBranch(record: ChatRecord): void {
    const currentTail = this.activeBranchRecords.at(-1)?.uuid ?? null;
    if (record.parentUuid !== currentTail) {
      const parentIndex =
        record.parentUuid === null
          ? -1
          : this.activeBranchRecords.findIndex(
              (candidate) => candidate.uuid === record.parentUuid,
            );
      this.activeBranchRecords =
        parentIndex < 0
          ? []
          : this.activeBranchRecords.slice(0, parentIndex + 1);
      if (parentIndex < 0) {
        this.activeBranchBaseUuid = record.parentUuid ?? null;
      }
      this.pendingBranchToolCalls = collectPendingBranchToolCalls(
        this.activeBranchRecords,
      );
    }
    this.activeBranchRecords.push(record);
    updatePendingBranchToolCalls(this.pendingBranchToolCalls, record);
  }

  /**
   * Set for a Managed session: its records go to the authority's record sink
   * instead of straight into the transcript.
   */
  private managedSink?: ManagedSessionRecordWriter;

  /** The Managed log's size when the recorder last measured its growth. */
  private managedLogSizeSeen = 0;

  /**
   * Routes every record of a Managed session through its authority. Bound
   * before activation, so no record of the session reaches the transcript
   * directly.
   */
  bindManagedSink(sink: ManagedSessionRecordWriter): void {
    if (
      !this.writerLeaseRequired ||
      this.state !== 'inactive' ||
      this.managedSink !== undefined
    ) {
      throw new SessionWriterUnavailableError();
    }
    this.managedSink = sink;
    this.managedLogSizeSeen = sink.logSize() ?? 0;
  }

  /**
   * Whether a Managed session must refuse the record. The refusal happens
   * before the record is queued: a failed write would stop the recorder for
   * the rest of the session.
   */
  private refusesManagedRecord(record: ChatRecord): boolean {
    return this.managedSink !== undefined && !this.managedSink.canCarry(record);
  }

  private enqueueRecordWrite(
    record: ChatRecord,
    legacyConversationFile?: string,
    updateActiveTail = true,
  ): Promise<void> {
    const pendingWrite = this.operationTail.then(async () => {
      if (this.writeFailure) throw this.writeFailure;
      const managedSink = this.managedSink;
      try {
        const lease = this.binding?.lease;
        if (managedSink) {
          // The authority appends through the same lease; writing the record
          // here as well would leave a raw line in the Managed Session log.
          await managedSink.write(record);
        } else if (lease) {
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
      if (managedSink) await this.anchorManagedMetadata(managedSink);
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
    if (this.writeFailure || !this.acceptingWrites || this.state !== 'active')
      return;
    if (this.refusesManagedRecord(record)) {
      debugLogger.warn(
        `Managed session ${record.sessionId} dropped a ${record.type} record${
          record.subtype ? ` with subtype ${record.subtype}` : ''
        } that its log cannot carry`,
      );
      return;
    }
    if (this.topologyFence) {
      this.topologyFence.buffered.push({ record, options });
      return;
    }
    const legacyConversationFile = this.writerLeaseRequired
      ? undefined
      : this.ensureConversationFile();
    const updateActiveTail = options?.updateActiveTail !== false;
    if (updateActiveTail) {
      this.lastRecordUuid = record.uuid;
      this.updateActiveBranch(record);
    }
    this.enqueueRecordWrite(record, legacyConversationFile, updateActiveTail);
    this.updateMetadataAnchorTracking(record);
  }

  private async appendRecordStrict(
    record: ChatRecord,
    options?: { updateActiveTail?: boolean },
  ): Promise<void> {
    if (this.writeFailure) throw this.writeFailure;
    if (!this.acceptingWrites || this.state !== 'active')
      throw new SessionWriterUnavailableError();
    if (this.refusesManagedRecord(record)) {
      throw new ManagedSessionRecordRefusedError(record);
    }
    if (this.topologyFence) {
      await new Promise<void>((resolve, reject) => {
        this.topologyFence!.buffered.push({
          record,
          options,
          resolve,
          reject,
        });
      });
      return;
    }

    const updateActiveTail = options?.updateActiveTail !== false;
    const legacyConversationFile = this.writerLeaseRequired
      ? undefined
      : this.ensureConversationFile();
    if (updateActiveTail) {
      this.lastRecordUuid = record.uuid;
      this.updateActiveBranch(record);
    }
    const pendingWrite = this.enqueueRecordWrite(
      record,
      legacyConversationFile,
      updateActiveTail,
    );
    // Keep anchor accounting in logical queue order, matching appendRecord.
    // Once accepted, a failed write permanently stops this recorder, so no
    // rollback of this bookkeeping is needed on rejection.
    this.updateMetadataAnchorTracking(record);

    await pendingWrite;
  }

  private releaseTopologyFence(fence: TranscriptTopologyFence): void {
    if (this.topologyFence !== fence) return;
    this.topologyFence = undefined;
    for (const intent of fence.buffered) {
      // Side artifacts keep updateActiveTail=false, but still move behind the
      // reserved checkpoint so they cannot become siblings of the completed
      // turn and invalidate the active transcript topology.
      intent.record.parentUuid = this.lastRecordUuid;
      if (intent.resolve && intent.reject) {
        void this.appendRecordStrict(intent.record, intent.options).then(
          intent.resolve,
          intent.reject,
        );
      } else {
        this.appendRecord(intent.record, intent.options);
      }
    }
  }

  /**
   * Keep title and source metadata inside the reader's tail window by
   * counting bytes accepted since each metadata record and re-anchoring
   * independently before either can drift beyond that window.
   *
   * Each metadata subtype resets only its own counter. Otherwise, active or
   * pending metadata accumulates the serialized record size and is re-appended
   * to EOF once its threshold is reached.
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
   *
   * A Managed session only resets its anchor counters here;
   * {@link anchorManagedMetadata} measures its log once each record lands.
   */
  private updateMetadataAnchorTracking(record: ChatRecord): void {
    const isTitleAnchor =
      record.type === 'system' && record.subtype === 'custom_title';
    const isSourceAnchor =
      record.type === 'system' && record.subtype === 'session_source';
    if (isTitleAnchor) {
      this.bytesSinceTitleAnchor = 0;
      this.hasNonTitleContentSinceTitleAnchor = false;
    }
    if (isSourceAnchor) {
      this.bytesSinceSourceAnchor = 0;
    }
    const trackTitle =
      !isTitleAnchor &&
      (this.currentCustomTitle !== undefined || this.pendingTitleWrites > 0);
    const trackSource =
      !isSourceAnchor &&
      (this.currentSourceType !== undefined || this.pendingSourceWrites > 0);
    if (!trackTitle && !trackSource) return;
    if (this.managedSink) return;
    let serializedRecord: string;
    try {
      serializedRecord = JSON.stringify(record);
    } catch {
      // Anchor bookkeeping must not change the writer's success contract.
      // The real serializer will surface the failure through writeChain.
      return;
    }
    const bytes = Buffer.byteLength(serializedRecord, 'utf8') + 1;
    if (trackTitle) {
      this.hasNonTitleContentSinceTitleAnchor = true;
      this.bytesSinceTitleAnchor += bytes;
    }
    if (trackSource) {
      this.bytesSinceSourceAnchor += bytes;
    }
    if (
      this.bytesSinceTitleAnchor >= METADATA_REANCHOR_BYTES &&
      this.pendingTitleWrites === 0
    ) {
      this.reanchorTitle();
    }
    if (
      this.bytesSinceSourceAnchor >= METADATA_REANCHOR_BYTES &&
      this.pendingSourceWrites === 0
    ) {
      this.reanchorSessionSource();
    }
  }

  /**
   * Keeps a Managed session's title and source inside the readers' windows.
   * The readers scan the same windows as on a Legacy transcript, but a
   * record's own size does not tell how far the log moved: the record is
   * committed inside transaction records, its content goes to a resource, and
   * activation renewals append between records. So once a record lands, the
   * growth of the log is counted, and a due anchor is written right behind
   * that record, inside the same queued write: it lands before anything
   * queued later, and a flush waits for it. Growth of records that were queued
   * before an anchor still counts against that anchor, so a re-anchor comes
   * early rather than late.
   */
  private async anchorManagedMetadata(
    sink: ManagedSessionRecordWriter,
  ): Promise<void> {
    this.countManagedLogGrowth(sink);
    const anchors: ChatRecord[] = [];
    if (
      this.currentCustomTitle &&
      this.bytesSinceTitleAnchor >= METADATA_REANCHOR_BYTES &&
      this.pendingTitleWrites === 0
    ) {
      anchors.push(
        this.titleAnchorRecord(
          this.currentCustomTitle,
          this.currentTitleSource,
        ),
      );
    }
    if (
      this.currentSourceType &&
      this.bytesSinceSourceAnchor >= METADATA_REANCHOR_BYTES &&
      this.pendingSourceWrites === 0
    ) {
      anchors.push(
        this.sourceAnchorRecord(this.currentSourceType, this.currentSourceId),
      );
    }
    for (const anchor of anchors) {
      // Its parent is the last record in the log, not the last one queued.
      anchor.parentUuid = this.lastPersistedRecordUuid;
      try {
        await sink.write(anchor);
      } catch (error) {
        // The record before it was committed; only later writes fail.
        this.enterWriteFailure(error, anchor.sessionId);
        return;
      }
      this.countManagedLogGrowth(sink);
      if (anchor.subtype === 'custom_title') {
        this.bytesSinceTitleAnchor = 0;
      } else {
        this.bytesSinceSourceAnchor = 0;
      }
    }
  }

  private countManagedLogGrowth(sink: ManagedSessionRecordWriter): void {
    const size = sink.logSize();
    if (size === undefined) return;
    const growth = Math.max(0, size - this.managedLogSizeSeen);
    this.managedLogSizeSeen = size;
    if (this.currentCustomTitle !== undefined || this.pendingTitleWrites > 0) {
      this.bytesSinceTitleAnchor += growth;
    }
    if (this.currentSourceType !== undefined || this.pendingSourceWrites > 0) {
      this.bytesSinceSourceAnchor += growth;
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
    if (
      !this.currentCustomTitle ||
      this.bytesSinceTitleAnchor < METADATA_REANCHOR_BYTES
    ) {
      return;
    }
    this.bytesSinceTitleAnchor = 0;
    try {
      const record = this.titleAnchorRecord(
        this.currentCustomTitle,
        this.currentTitleSource,
      );
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

  private reanchorSessionSource(): void {
    if (
      !this.currentSourceType ||
      this.bytesSinceSourceAnchor < METADATA_REANCHOR_BYTES
    ) {
      return;
    }
    this.bytesSinceSourceAnchor = 0;
    try {
      const record = this.sourceAnchorRecord(
        this.currentSourceType,
        this.currentSourceId,
      );
      this.appendRecord(record, { updateActiveTail: false });
    } catch (error) {
      debugLogger.error('Error re-anchoring session source:', error);
    }
  }

  private titleAnchorRecord(
    title: string,
    source: TitleSource | undefined,
  ): ChatRecord {
    return {
      ...this.createBaseRecord('system'),
      type: 'system',
      subtype: 'custom_title',
      systemPayload: {
        customTitle: title,
        ...(source ? { titleSource: source } : {}),
      },
    };
  }

  private sourceAnchorRecord(
    sourceType: string,
    sourceId: string | undefined,
  ): ChatRecord {
    return {
      ...this.createBaseRecord('system'),
      type: 'system',
      subtype: 'session_source',
      systemPayload: {
        sourceType,
        ...(sourceId !== undefined ? { sourceId } : {}),
      },
    };
  }

  /**
   * Awaits all queued async writes. Call before process exit / session
   * teardown to ensure no records are dropped.
   */
  async flush(): Promise<void> {
    await this.operationTail;
    if (this.writeFailure) throw this.writeFailure;
  }

  async readActiveTranscriptChain(): Promise<readonly ChatRecord[]> {
    await this.flush();
    if (this.managedSink) {
      // A Managed log holds wrapper records; the records a reader sees come
      // from its projection, and the active chain is rebuilt from them the
      // same way as from a transcript.
      return prepareTranscriptRecords(await this.managedSink.project())
        .records as ChatRecord[];
    }
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

  async runWithWriteBarrier<T>(operation: () => Promise<T>): Promise<T> {
    if (this.writeFailure) throw this.writeFailure;
    if (!this.acceptingWrites || this.state !== 'active') {
      throw new SessionWriterUnavailableError();
    }
    const pending = this.operationTail.then(async () => {
      if (this.writeFailure) throw this.writeFailure;
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

  close(options?: { handoff?: boolean }): Promise<void> {
    if (options?.handoff) {
      this.handoffRequested = true;
    }
    if (this.closePromise) return this.closePromise;
    if (this.state === 'closed') return Promise.resolve();
    this.beginClose(options);
    const pending = this.closeOnce();
    this.closePromise = pending;
    void pending.catch(() => {
      if (
        this.closePromise === pending &&
        this.binding !== undefined &&
        this.state === 'integrity_failed'
      ) {
        this.closePromise = undefined;
      }
    });
    return pending;
  }

  beginClose(options?: { handoff?: boolean }): void {
    if (options?.handoff) {
      this.handoffRequested = true;
    }
    this.autoTitleController?.abort();
    this.acceptingWrites = false;
    if (this.state === 'active') {
      this.state = 'closing';
    }
  }

  private async closeOnce(): Promise<void> {
    let flushFailure: unknown;
    try {
      await this.flush();
    } catch (error) {
      flushFailure = error;
    }
    const managedSink = this.managedSink;
    if (this.handoffRequested && flushFailure !== undefined && !managedSink) {
      // Fail closed: a handoff whose final flush did not durably land must
      // neither seal (the proof would be incomplete) nor release (a successor
      // could take over records that were never persisted). Unlike the
      // release-then-throw normal-close path below, it retains the active lock
      // so write ownership stays unambiguous until an external writer fence
      // recovers it.
      this.state = 'integrity_failed';
      throw flushFailure;
    }
    const lease = this.binding?.lease;
    let stopFailure: unknown;
    try {
      if (managedSink) {
        // A Managed log is only ever sealed: releasing would delete the lock
        // and leave the log open to any writer. The seal pins the authority's
        // committed position, which stays exact even after a failed write,
        // because a record without its commit marker is not part of it.
        //
        // Due anchors land first: a close without finalize(), such as a
        // handoff, still leaves the title and source where the session list
        // reads them, however far renewals moved the log since the last one.
        // A failed write does not skip them: an anchor the authority cannot
        // take fails on its own, and the seal below still follows.
        await this.anchorManagedMetadata(managedSink);
        try {
          // After the last record and before the seal: the authority refuses
          // a record that names a stopped activation.
          await managedSink.stopAdvancing();
        } catch (error) {
          stopFailure = error;
        }
        await lease?.sealForHandoff(managedSink.commitProof());
      } else if (this.handoffRequested) {
        await lease?.sealForHandoff();
      } else {
        await lease?.release();
      }
      this.binding = undefined;
      this.state = 'closed';
    } catch (error) {
      if (
        error instanceof SessionWriterLostError ||
        (lease?.isReleased && !lease.isReleaseDurabilityPending)
      ) {
        this.binding = undefined;
        this.state = 'closed';
      } else {
        this.state = 'integrity_failed';
      }
      throw error;
    }
    if (flushFailure !== undefined) throw flushFailure;
    if (stopFailure !== undefined) throw stopFailure;
  }

  hasWriteOwnership(): boolean {
    return this.binding !== undefined && !this.binding.lease.isReleased;
  }

  /**
   * Pins this recorder to the given session identity so late writes keep
   * targeting that session's transcript even after `Config.startNewSession()`
   * rotates the shared Config to a new session id. Called on the outgoing
   * recorder at rotation time; a lease binding already owns the identity and
   * is never overridden.
   */
  pinSessionIdentity(sessionId: string): void {
    if (this.binding === undefined) {
      this.pinnedSessionId = sessionId;
    }
  }

  getTranscriptCursor(): TranscriptCursor {
    return { recordId: this.lastRecordUuid };
  }

  getBranchCheckpointCursor(): BranchCheckpointCursor {
    return {
      recordId: this.lastRecordUuid,
      activeRecordCount: this.activeBranchRecords.length,
      pendingToolCalls: this.pendingBranchToolCalls.map((call) => ({
        ...call,
      })),
    };
  }

  async recordBranchCheckpointTransaction(input: {
    cursor: BranchCheckpointCursor;
    stopReason: string;
  }): Promise<BranchPoint | undefined> {
    if (input.stopReason !== 'end_turn') return undefined;
    if (this.writeFailure) throw this.writeFailure;
    if (this.state !== 'active') throw new SessionWriterUnavailableError();
    if (this.topologyFence) {
      throw new Error('Transcript topology transaction already active');
    }

    const fence: TranscriptTopologyFence = { buffered: [] };
    this.topologyFence = fence;
    try {
      await this.flush();
      const endInclusiveRecordUuid = this.lastRecordUuid;
      if (endInclusiveRecordUuid === null) return undefined;
      const cursorRecordId =
        input.cursor.activeRecordCount === 0
          ? this.activeBranchBaseUuid
          : this.activeBranchRecords[input.cursor.activeRecordCount - 1]?.uuid;
      if (
        cursorRecordId !== input.cursor.recordId ||
        this.activeBranchRecords.at(-1)?.uuid !== endInclusiveRecordUuid
      ) {
        throw new Error('Transcript changed while recording branch checkpoint');
      }
      const candidate = resolveCompletedTurnBranchCandidateFromRecords({
        records: this.activeBranchRecords.slice(input.cursor.activeRecordCount),
        startExclusiveRecordUuid: input.cursor.recordId,
        pendingCallsAtStart: input.cursor.pendingToolCalls,
      });
      if (!candidate) return undefined;

      const checkpointUuid = randomUUID();
      const checkpoint: ChatRecord = {
        ...this.createBaseRecord('system'),
        uuid: checkpointUuid,
        parentUuid: endInclusiveRecordUuid,
        type: 'system',
        subtype: 'branch_checkpoint',
        systemPayload: {
          v: 1,
          startExclusiveRecordUuid: input.cursor.recordId,
          assistantRecordUuid: candidate.assistantRecordUuid,
        },
      };

      this.topologyFence = undefined;
      const checkpointWrite = this.appendRecordStrict(checkpoint);
      this.topologyFence = fence;
      await checkpointWrite;
      return { ...candidate, checkpointUuid };
    } finally {
      this.releaseTopologyFence(fence);
    }
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
    this.resetExternalRecordIndex();
  }

  /**
   * Records a user message.
   * Queues the write immediately on the serialized async writer.
   *
   * @param message The raw PartListUnion object as used with the API
   * @param goalContext Goal identity and turn that own this message
   * @param promptPayload User-authored display text and hook-context provenance
   * @param promptId Identity shared with this turn's API-history entry
   * @param daemonPromptId Transport identity replayed to the daemon
   */
  recordUserMessage(
    message: PartListUnion,
    goalContext?: GoalTurnPermit,
    promptPayload?: UserPromptRecordPayload,
    promptId?: string,
    daemonPromptId?: string,
  ): void {
    try {
      this.trackUserDisplayTextForTitle(promptPayload?.displayText);
      this.turnParentUuids.push(this.lastRecordUuid);
      const record: ChatRecord = {
        ...this.createBaseRecord('user'),
        ...(daemonPromptId ? { daemonPromptId } : {}),
        ...(goalContext ? { goalContext: copyGoalContext(goalContext) } : {}),
        message: createUserContent(message),
        ...(promptPayload ? { systemPayload: promptPayload } : {}),
        ...(promptId ? { promptId } : {}),
      };
      this.appendRecord(record);
    } catch (error) {
      debugLogger.error('Error saving user message:', error);
    }
  }

  getUserDisplayTextsForTitle(): ReadonlyArray<string | undefined> {
    return this.userDisplayTextsForTitle;
  }

  recordGoalRuntimeMessage(
    message: PartListUnion,
    goalContext: GoalTurnPermit,
  ): void {
    try {
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

  async recordGoalTurnEnd(
    toolCallId: string,
    goalContext: GoalTurnPermit,
  ): Promise<void> {
    await this.appendRecordStrict({
      ...this.createBaseRecord('system'),
      subtype: 'goal_turn_end',
      goalContext: copyGoalContext(goalContext),
      systemPayload: { toolCallId },
    });
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
    displayText: string,
    goalContext?: GoalTurnPermit,
    attachmentReferences?: UserPromptAttachmentReference[],
  ): void {
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('user'),
        subtype: 'mid_turn_user_message',
        ...(goalContext ? { goalContext: copyGoalContext(goalContext) } : {}),
        message: createUserContent(message),
        systemPayload: {
          displayText,
          ...(attachmentReferences ? { attachmentReferences } : {}),
        },
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
    this.recordNotificationLike(
      message,
      'cron',
      displayText,
      undefined,
      goalContext,
    );
  }

  recordBackgroundTaskCompleted(payload: NotificationRecordPayload): void {
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        subtype: 'background_task_completed',
        systemPayload: payload,
      };
      delete record.backgroundTurn;
      this.appendRecord(record);
    } catch (error) {
      debugLogger.error('Error saving background task completion:', error);
    }
  }

  /**
   * Records a background agent notification.
   * Stored as a user-role message with subtype 'notification' so the
   * UI restores it as an info item, not a user turn.
   *
   * `deliveredTurn` must be `true` exactly when the record IS the user entry
   * of a notification turn the `client.ts` send path admitted and went on to
   * send; copies persisted before the turn runs leave it unset so session
   * recovery can still trim them. See `ChatRecord.deliveredTurn` for what the
   * stamp does and does not guarantee.
   */
  recordNotification(
    message: PartListUnion,
    displayText?: string,
    backgroundTask?: NotificationRecordPayload['backgroundTask'],
    goalContext?: GoalTurnPermit,
    deliveredTurn?: boolean,
  ): void {
    this.recordNotificationLike(
      message,
      'notification',
      displayText,
      backgroundTask,
      goalContext,
      deliveredTurn,
    );
  }

  /**
   * Durably records a daemon-delivered notification before its sender is
   * acknowledged. Unlike the ordinary in-process notification path, this
   * rejects when the writer is unavailable or the append fails.
   */
  async recordNotificationStrict(
    message: PartListUnion,
    displayText?: string,
    backgroundTask?: NotificationRecordPayload['backgroundTask'],
  ): Promise<void> {
    await this.appendRecordStrict(
      this.createNotificationRecord(
        message,
        'notification',
        displayText,
        backgroundTask,
      ),
    );
  }

  /**
   * Durably records a session multi-agent record (`agent_mention` or
   * `agent_message`) the daemon asked the ACP child to write, and returns
   * its uuid (the agents' read-cursor anchor) and its own timestamp, so a live
   * update can carry exactly what replay will.
   *
   * Written as `type: 'user'` so the main model reads it as input on its next
   * turn (resume rebuilds it through `appendApiHistoryRecord`). It never
   * starts a turn, never feeds the auto title (only subtype-less user records
   * do), and is never trimmed as a cold notification.
   *
   * Idempotent per `recordKey`, durably: the key is persisted on the record
   * (`externalRecordKey`) and a repeat returns the existing record with
   * `created: false`, also after a restart (see
   * {@link findExternalAgentRecord}).
   *
   * Managed sessions: `ManagedSessionRecordSink.canCarry` has no mapping for
   * these subtypes, so `appendRecordStrict` throws
   * `ManagedSessionRecordRefusedError` before queueing. That refusal is left
   * in place on purpose and propagates to the caller, which reports the
   * feature as not supported in managed sessions.
   * TODO(multi-agent): add a managed mapping if managed sessions need agents.
   */
  async recordExternalAgentRecordStrict(
    input:
      | {
          kind: 'agent_mention';
          modelText: string;
          payload: AgentMentionRecordPayload;
          recordKey: string;
        }
      | {
          kind: 'agent_message';
          modelText: string;
          payload: AgentMessageRecordPayload;
          recordKey: string;
        },
  ): Promise<ExternalAgentRecordRef & { created: boolean }> {
    const existing = await this.findExternalAgentRecord(input.recordKey);
    if (existing) return { ...existing, created: false };
    const generation = this.externalRecordIndexGeneration;
    const record: ChatRecord = {
      ...this.createBaseRecord('user'),
      subtype: input.kind,
      provenance:
        input.kind === 'agent_mention' && input.payload.author === undefined
          ? 'real_user'
          : 'external_agent',
      message: createUserContent([{ text: input.modelText }]),
      systemPayload: input.payload,
      externalRecordKey: input.recordKey,
      ...(input.kind === 'agent_message'
        ? {
            agentId: input.payload.author.agentId,
            agentName: input.payload.author.name,
            ...(input.payload.author.color
              ? { agentColor: input.payload.author.color }
              : {}),
          }
        : {}),
    };
    // Not part of any background notification turn.
    delete record.backgroundTurn;
    await this.appendRecordStrict(record);
    const ref = { uuid: record.uuid, timestamp: record.timestamp };
    // A rebuilt index (generation moved) reads this record from disk instead.
    if (generation === this.externalRecordIndexGeneration) {
      this.externalRecordIndex?.set(input.recordKey, ref);
    }
    return { ...ref, created: true };
  }

  /**
   * The external record written for `recordKey` on the active chain, if any.
   * The first call reads the transcript once (`readActiveTranscriptChain`);
   * later calls are answered from memory. Throws when that read fails, so a
   * caller never mistakes an unreadable transcript for a missing record.
   */
  async findExternalAgentRecord(
    recordKey: string,
  ): Promise<ExternalAgentRecordRef | undefined> {
    return (await this.loadExternalRecordIndex()).get(recordKey);
  }

  private loadExternalRecordIndex(): Promise<
    Map<string, ExternalAgentRecordRef>
  > {
    if (this.externalRecordIndex) {
      return Promise.resolve(this.externalRecordIndex);
    }
    if (this.externalRecordIndexLoad) return this.externalRecordIndexLoad;
    const generation = this.externalRecordIndexGeneration;
    const load = (async () => {
      const index = new Map<string, ExternalAgentRecordRef>();
      // Nothing persisted yet (a fresh session, whose transcript cannot be
      // loaded at all), or a Managed log, which refuses these records anyway.
      if (this.lastPersistedRecordUuid !== null && !this.managedSink) {
        for (const record of await this.readActiveTranscriptChain()) {
          if (
            typeof record.externalRecordKey === 'string' &&
            (record.subtype === 'agent_mention' ||
              record.subtype === 'agent_message')
          ) {
            index.set(record.externalRecordKey, {
              uuid: record.uuid,
              timestamp: record.timestamp,
            });
          }
        }
      }
      return index;
    })();
    this.externalRecordIndexLoad = load;
    void load.then(
      (index) => {
        if (this.externalRecordIndexLoad !== load) return;
        this.externalRecordIndexLoad = undefined;
        if (generation === this.externalRecordIndexGeneration) {
          this.externalRecordIndex = index;
        }
      },
      () => {
        // Retried on the next call.
        if (this.externalRecordIndexLoad === load) {
          this.externalRecordIndexLoad = undefined;
        }
      },
    );
    return load;
  }

  private resetExternalRecordIndex(): void {
    this.externalRecordIndexGeneration += 1;
    this.externalRecordIndex = undefined;
    this.externalRecordIndexLoad = undefined;
  }

  private recordNotificationLike(
    message: PartListUnion,
    subtype: 'notification' | 'cron',
    displayText?: string,
    backgroundTask?: NotificationRecordPayload['backgroundTask'],
    goalContext?: GoalTurnPermit,
    deliveredTurn?: boolean,
  ): void {
    try {
      const record = this.createNotificationRecord(
        message,
        subtype,
        displayText,
        backgroundTask,
        goalContext,
        deliveredTurn,
      );
      this.appendRecord(record);
    } catch (error) {
      debugLogger.error(`Error saving ${subtype} record:`, error);
    }
  }

  private createNotificationRecord(
    message: PartListUnion,
    subtype: 'notification' | 'cron',
    displayText?: string,
    backgroundTask?: NotificationRecordPayload['backgroundTask'],
    goalContext?: GoalTurnPermit,
    deliveredTurn?: boolean,
  ): ChatRecord {
    return {
      ...this.createBaseRecord('user'),
      subtype,
      provenance: 'system',
      ...(goalContext ? { goalContext: copyGoalContext(goalContext) } : {}),
      ...(deliveredTurn ? { deliveredTurn: true } : {}),
      message: createUserContent(message),
      systemPayload: displayText
        ? {
            displayText,
            ...(backgroundTask ? { backgroundTask } : {}),
          }
        : undefined,
    };
  }

  /**
   * Tokens billed to the Goal turn that is currently open.
   *
   * One entry, not a map: the Goal runtime holds a single permit at a time, so
   * a record stamped with a different turn id means the previous turn is over
   * and its total was either already taken or is no longer wanted.
   */
  private goalTurnSpend?: { turnId: string; tokens: number };

  private accumulateGoalTurnTokens(
    turnId: string,
    usage: GenerateContentResponseUsageMetadata,
  ): void {
    this.billGoalTurnTokens(turnId, usage.totalTokenCount ?? 0);
  }

  billGoalTurnTokens(turnId: string, total: number): void {
    if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) {
      return;
    }
    if (this.goalTurnSpend?.turnId !== turnId) {
      this.goalTurnSpend = { turnId, tokens: 0 };
    }
    this.goalTurnSpend.tokens += total;
  }

  /**
   * The tokens billed to `turnId`, consuming them so a turn is counted once.
   *
   * Answers zero for a turn that spent nothing, that was never opened, or
   * whose total has already been taken — a Goal with no model calls in a turn
   * bills nothing rather than guessing.
   */
  takeGoalTurnTokens(turnId: string): number {
    if (this.goalTurnSpend?.turnId !== turnId) return 0;
    const { tokens } = this.goalTurnSpend;
    this.goalTurnSpend = undefined;
    return tokens;
  }

  /**
   * Evidence-bearing tool results recorded in the Goal turn that is currently
   * open. Single entry for the same reason the spend is.
   */
  private goalTurnToolResults?: { turnId: string; count: number };

  private accumulateGoalTurnToolResult(turnId: string): void {
    if (this.goalTurnToolResults?.turnId !== turnId) {
      this.goalTurnToolResults = { turnId, count: 0 };
    }
    this.goalTurnToolResults.count += 1;
  }

  /**
   * The evidence-bearing tool results `turnId` recorded, consuming them so a
   * turn is counted once.
   *
   * `get_goal` and `update_goal` results are excluded: they are the Goal
   * runtime talking to itself, and a turn that only reads its own state is
   * exactly the idling this count exists to notice.
   */
  takeGoalTurnToolResults(turnId: string): number {
    if (this.goalTurnToolResults?.turnId !== turnId) return 0;
    const { count } = this.goalTurnToolResults;
    this.goalTurnToolResults = undefined;
    return count;
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
        if (data.goalContext) {
          this.accumulateGoalTurnTokens(data.goalContext.turnId, data.tokens);
        }
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

  async recordRealtimeConversation(
    entries: ReadonlyArray<{
      role: 'user' | 'assistant';
      text: string;
    }>,
    model: string,
  ): Promise<void> {
    for (const entry of entries) {
      const record: ChatRecord = {
        ...this.createBaseRecord(entry.role),
        subtype: 'realtime_message',
        message:
          entry.role === 'user'
            ? createUserContent([{ text: entry.text }])
            : createModelContent([{ text: entry.text }]),
        ...(entry.role === 'assistant' ? { model } : {}),
      };
      await this.appendRecordStrict(record);
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
          this.userDisplayTextsForTitle,
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
      const persistedOutputFiles = toolCallResult?.persistedOutputFiles;
      const artifacts = [
        toolResultBoundaryArtifact(
          persistedOutputFiles,
          toolCallResult?.artifacts,
        ),
      ];
      const inputDisplay = toolCallResult?.resultDisplay;
      const inputValues = () => [
        ...toolResultPartDiagnosticValues(message),
        ...(shellResultText(inputDisplay) !== undefined
          ? [
              {
                representation: 'display' as const,
                value: shellResultText(inputDisplay)!,
              },
            ]
          : []),
      ];
      let recordingToolCallResult:
        | (Partial<ToolCallResponseInfo> & { status: Status })
        | undefined;
      if (toolCallResult) {
        const recordableToolCallResult = { ...toolCallResult };
        delete recordableToolCallResult.persistedOutputFiles;
        delete recordableToolCallResult.boundaryArtifact;
        recordingToolCallResult = sanitizeToolCallResultForRecording(
          recordableToolCallResult,
        );
        if (
          typeof recordingToolCallResult.resultDisplay === 'object' &&
          recordingToolCallResult.resultDisplay !== null &&
          'type' in recordingToolCallResult.resultDisplay &&
          recordingToolCallResult.resultDisplay.type === 'task_execution'
        ) {
          const taskResult =
            recordingToolCallResult.resultDisplay as AgentResultDisplay;
          recordingToolCallResult = {
            ...recordingToolCallResult,
            resultDisplay: { ...taskResult, toolCalls: [] },
          };
        }
      }
      const outputDisplay = recordingToolCallResult?.resultDisplay;
      let displayMutated: boolean | undefined;
      const mutated = () =>
        (displayMutated ??= !isDeepStrictEqual(inputDisplay, outputDisplay));
      observeToolResultBoundary({
        stage: 'recorder_input',
        sessionId: this.getSessionId(),
        toolCallId: toolCallResult?.callId,
        artifacts,
        mutated,
        values: inputValues,
      });
      observeToolResultBoundary({
        stage: 'recorder_output',
        sessionId: this.getSessionId(),
        toolCallId: toolCallResult?.callId,
        artifacts,
        mutated,
        values: () => [
          ...toolResultPartDiagnosticValues(message),
          ...(shellResultText(outputDisplay) !== undefined
            ? [
                {
                  representation: 'display' as const,
                  value: shellResultText(outputDisplay)!,
                },
              ]
            : []),
        ],
      });

      const record: ChatRecord = {
        ...this.createBaseRecord('tool_result'),
        ...(options?.subtype ? { subtype: options.subtype } : {}),
        ...(options?.goalContext
          ? { goalContext: copyGoalContext(options.goalContext) }
          : {}),
        ...(options?.provenance ? { provenance: options.provenance } : {}),
        message: createUserContent(message),
      };

      if (recordingToolCallResult) {
        record.toolCallResult = recordingToolCallResult;
      }

      if (options?.goalContext && options.provenance !== 'goal_runtime') {
        this.accumulateGoalTurnToolResult(options.goalContext.turnId);
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
   * Records the omni passive media-memory recall payload injected into the
   * model-bound request (memory design M §9.3, D10 sideQuery mode). The
   * reminder is assembled AFTER the user record is persisted, so without
   * this record the transcript would never show what memory the model was
   * given — the trajectory exporter reads it back as `turn.recall`.
   */
  recordOmniRecallReminder(payload: unknown): void {
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        type: 'system',
        subtype: 'omni_recall',
        systemPayload: payload as ChatRecord['systemPayload'],
      };

      this.appendRecord(record);
    } catch (error) {
      debugLogger.error('Error saving omni recall record:', error);
    }
  }

  /**
   * Records a chat compression checkpoint as a system record. This keeps the UI
   * history immutable while allowing resume/continue flows to reconstruct the
   * compressed model-facing history from the stored snapshot.
   */
  recordChatCompression(payload: ChatCompressionRecordPayload): void {
    try {
      // Freeze the array so later live-history mutations cannot desynchronize
      // entries from the parallel promptIds array.
      const compressedHistory = [...payload.compressedHistory];
      const promptIds = compressedHistory.map(
        (content) => getApiHistoryPromptId(content) ?? null,
      );
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        type: 'system',
        subtype: 'chat_compression',
        systemPayload: {
          ...payload,
          compressedHistory,
          ...(promptIds.some(Boolean) ? { promptIds } : {}),
        },
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
    sessionApprovalMode?: SessionApprovalModeRecordPayload,
  ): void {
    try {
      if (
        sessionApprovalMode &&
        isValidSessionApprovalModePayload(sessionApprovalMode)
      ) {
        this.currentSessionApprovalMode =
          normalizeSessionApprovalModePayload(sessionApprovalMode);
      }
      // Re-root: point back to the record just before the target user turn.
      this.lastRecordUuid = this.turnParentUuids[targetTurnIndex] ?? null;
      const projectionStart = Math.max(
        0,
        this.turnParentUuids.length - this.userDisplayTextsForTitle.length,
      );
      this.userDisplayTextsForTitle.splice(
        Math.max(0, targetTurnIndex - projectionStart),
      );
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

      // Last-wins session_model may now sit on the abandoned branch. Re-append
      // the live binding so cold restore still sees the model Config is on.
      if (this.currentSessionModel) {
        this.appendRecord({
          ...this.createBaseRecord('system'),
          type: 'system',
          subtype: 'session_model',
          systemPayload: this.currentSessionModel,
        });
      }

      if (this.currentSessionApprovalMode) {
        this.appendRecord({
          ...this.createBaseRecord('system'),
          type: 'system',
          subtype: 'session_approval_mode',
          systemPayload: this.currentSessionApprovalMode,
        });
      }

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
    this.resetExternalRecordIndex();
    this.turnParentUuids = [];
    this.activeBranchRecords = [...messages];
    this.activeBranchBaseUuid = messages[0]?.parentUuid ?? null;
    this.pendingBranchToolCalls = collectPendingBranchToolCalls(messages);

    for (let i = 0; i < messages.length; i++) {
      const record = messages[i];
      if (
        record.type === 'user' &&
        record.subtype !== 'goal_runtime' &&
        record.subtype !== 'notification' &&
        record.subtype !== 'cron' &&
        record.subtype !== 'mid_turn_user_message' &&
        record.subtype !== 'realtime_message' &&
        record.subtype !== 'agent_mention' &&
        record.subtype !== 'agent_message'
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

      // A Managed log keeps a title as metadata that its projection does not
      // replay, so the title must not become the parent of the next record.
      await this.appendRecordStrict(
        record,
        this.managedSink ? { updateActiveTail: false } : undefined,
      );
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
        this.bytesSinceTitleAnchor >= METADATA_REANCHOR_BYTES &&
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

  /**
   * Persist the execution engine that owns this session. A failed write
   * rejects, so creation fails instead of continuing without a durable owner.
   * A session without chat recording has no recorder, so nothing is written.
   */
  async recordExecutionEngine(engine: SessionExecutionEngine): Promise<void> {
    const systemPayload: SessionExecutionEnginePayload = { version: 1, engine };
    await this.appendRecordStrict({
      ...this.createBaseRecord('system'),
      type: 'system',
      subtype: 'session_execution_engine',
      systemPayload,
    });
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
    this.pendingSourceWrites++;
    let persisted = false;
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
      persisted = true;
      return true;
    } catch (error) {
      if (error !== this.writeFailure) {
        debugLogger.error('Error saving session source:', error);
      }
      return false;
    } finally {
      this.pendingSourceWrites--;
      if (
        persisted &&
        this.pendingSourceWrites === 0 &&
        this.bytesSinceSourceAnchor >= METADATA_REANCHOR_BYTES &&
        !this.writeFailure
      ) {
        this.reanchorSessionSource();
      }
    }
  }

  /** Persist the daemon session's current model so load/resume can restore it. */
  async recordSessionModel(
    payload: SessionModelRecordPayload,
  ): Promise<boolean> {
    if (!isValidSessionModelPayload(payload)) {
      return false;
    }
    const normalized = normalizeSessionModelPayload(payload);
    if (
      this.currentSessionModel &&
      sessionModelPayloadsEqual(this.currentSessionModel, normalized)
    ) {
      return true;
    }
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        type: 'system',
        subtype: 'session_model',
        systemPayload: normalized,
      };
      // Assign before the awaited write so a rewind landing in the
      // pending-write window re-appends the new binding rather than the
      // stale one. Roll back on failure: ensureConversationFile can throw
      // before writeFailure latches, and a later identical call would
      // otherwise skip the write.
      const previous = this.currentSessionModel;
      this.currentSessionModel = normalized;
      try {
        await this.appendRecordStrict(record);
      } catch (error) {
        this.currentSessionModel = previous;
        throw error;
      }
      return true;
    } catch (error) {
      if (error !== this.writeFailure) {
        debugLogger.error('Error saving session model record:', error);
      }
      return false;
    }
  }

  /** Persist the daemon session's approval state so load/resume can restore it. */
  async recordSessionApprovalMode(
    payload: SessionApprovalModeRecordPayload,
  ): Promise<boolean> {
    if (!isValidSessionApprovalModePayload(payload)) {
      return false;
    }
    const normalized = normalizeSessionApprovalModePayload(payload);
    if (
      this.currentSessionApprovalMode &&
      sessionApprovalModePayloadsEqual(
        this.currentSessionApprovalMode,
        normalized,
      )
    ) {
      return true;
    }
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        type: 'system',
        subtype: 'session_approval_mode',
        systemPayload: normalized,
      };
      this.currentSessionApprovalMode = normalized;
      try {
        await this.appendRecordStrict(record);
      } catch (error) {
        // A newer mode may already be queued, so only invalidate deduplication.
        this.currentSessionApprovalMode = undefined;
        throw error;
      }
      return true;
    } catch (error) {
      if (error !== this.writeFailure) {
        debugLogger.error('Error saving session approval mode record:', error);
      }
      return false;
    }
  }

  /**
   * Finalizes the current session by re-appending cached metadata to EOF, but
   * only after this recorder has appended non-title content since the last
   * title anchor. Pure load/resume must remain read-only so session lists do
   * not treat restored sessions as newly active. A Managed session re-appends
   * it only once its log grew past the re-anchor threshold since the last
   * anchor, as after each record and on close; its activation writes to the
   * log on any resume, so there is no read-only resume to keep.
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
    if (this.managedSink) {
      // Re-anchored by the log's growth alone, which renewals add to while the
      // session is idle.
      this.countManagedLogGrowth(this.managedSink);
      if (this.bytesSinceTitleAnchor < METADATA_REANCHOR_BYTES) return;
    } else if (!this.hasNonTitleContentSinceTitleAnchor) {
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
      // A Managed title is metadata the projection does not replay.
      this.appendRecord(
        record,
        this.managedSink ? { updateActiveTail: false } : undefined,
      );
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

  /**
   * Append the settled outcome of a turn. Best-effort by design: a
   * recording failure must never break turn settlement, so this uses the
   * non-strict append path (inactive/failed writers skip silently).
   */
  recordTurnResult(payload: TurnResultRecordPayload): void {
    if (!isTurnResultRecordPayload(payload)) {
      debugLogger.error(
        'Skipping turn result record that violates the bounded contract:',
        payload,
      );
      return;
    }
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        type: 'system',
        subtype: 'turn_result',
        systemPayload: payload,
      };
      this.appendRecord(record);
    } catch (error) {
      debugLogger.error('Error recording turn result:', error);
    }
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
  async recordSessionSourcesSnapshot(
    payload: SessionSourcesSnapshot,
  ): Promise<void> {
    const record: ChatRecord = {
      ...this.createBaseRecord('system'),
      type: 'system',
      subtype: 'session_sources_snapshot',
      systemPayload: payload,
    };
    await this.appendRecordStrict(record, { updateActiveTail: false });
  }
}
