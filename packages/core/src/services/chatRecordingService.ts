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
import type { AttributionSnapshot } from './commitAttribution.js';
import { tryGenerateSessionTitle } from './sessionTitle.js';
import type {
  ChatCompressionInfo,
  ToolCallResponseInfo,
} from '../core/turn.js';
import type { Status } from '../core/coreToolScheduler.js';
import type { AgentResultDisplay, FileDiff } from '../tools/tools.js';
import type { UiEvent } from '../telemetry/uiTelemetry.js';

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
  if (!isFileDiffDisplay(resultDisplay)) {
    return toolCallResult;
  }

  const sanitizedResultDisplay = sanitizeFileDiffForRecording(resultDisplay);
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
 * Forms a tree structure via uuid/parentUuid for future checkpointing support.
 *
 * Each record is self-contained with full metadata, enabling:
 * - Append-only writes (crash-safe)
 * - Tree reconstruction by following parentUuid chain
 * - Future checkpointing by branching from any historical record
 */
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
  /** Optional system subtype for distinguishing system behaviors */
  subtype?:
    | 'chat_compression'
    | 'slash_command'
    | 'ui_telemetry'
    | 'at_command'
    | 'attribution_snapshot'
    | 'notification'
    | 'cron'
    | 'custom_title'
    | 'rewind'
    | 'agent_bootstrap'
    | 'agent_launch_prompt';
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
  toolCallResult?: Partial<ToolCallResponseInfo>;

  /**
   * Payload for system records. For chat compression, this stores all data needed
   * to reconstruct the compressed history without mutating the original UI list.
   */
  systemPayload?:
    | ChatCompressionRecordPayload
    | SlashCommandRecordPayload
    | UiTelemetryRecordPayload
    | AtCommandRecordPayload
    | AttributionSnapshotPayload
    | CustomTitleRecordPayload
    | NotificationRecordPayload
    | RewindRecordPayload
    | AgentBootstrapRecordPayload;

  /** Background subagent that produced this record (e.g. "explore-7f3c"). */
  agentId?: string;
  /** Display name for the subagent (e.g. "Explore"). */
  agentName?: string;
  /** UI hint for tools rendering subagent transcripts. */
  agentColor?: string;
  /** True for records produced by a subagent (a sidechain off the parent session). */
  isSidechain?: boolean;
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
 * Service for recording the current chat session to disk.
 *
 * This service provides comprehensive conversation recording that captures:
 * - All user and assistant messages
 * - Tool calls and their execution results
 * - Token usage statistics
 * - Assistant thoughts and reasoning
 *
 * **API Design:**
 * - `recordUserMessage()` - Records a user message (immediate write)
 * - `recordAssistantTurn()` - Records an assistant turn with all data (immediate write)
 * - `recordToolResult()` - Records tool results (immediate write)
 *
 * **Storage Format:** JSONL files with tree-structured records.
 * Each record has uuid/parentUuid fields enabling:
 * - Append-only writes (never rewrite the file)
 * - Linear history reconstruction
 * - Future checkpointing (branch from any historical point)
 *
 * File location: ~/.qwen/tmp/<project_id>/chats/
 *
 * For session management (list, load, remove), use SessionService.
 */
export class ChatRecordingService {
  /** UUID of the last written record in the chain */
  private lastRecordUuid: string | null = null;
  private readonly config: Config;
  /**
   * Tracks the `lastRecordUuid` value just before each user turn was recorded.
   * Used by {@link rewindRecording} to re-root the parentUuid chain so that
   * rewound messages end up on a dead branch in the tree, making
   * `reconstructHistory()` skip them automatically on resume.
   *
   * Index `i` holds the UUID of the last record written before the (i+1)th
   * user message was appended. For example, `turnParentUuids[0]` is the UUID
   * right before the very first user message (often `null` or the startup
   * context record).
   */
  private turnParentUuids: Array<string | null> = [];
  /**
   * Cached chats-dir / conversation-file path so per-record appendRecord
   * doesn't re-stat them on every write. The first call performs the
   * mkdir / wx-create; subsequent calls short-circuit.
   */
  private chatsDirEnsured = false;
  private cachedConversationFile: string | undefined;
  /**
   * Serialized async write queue for appendRecord. We update lastRecordUuid
   * synchronously so the next createBaseRecord sees the right parentUuid,
   * but the actual fs write runs in this chain so the event loop is not
   * blocked. Must be flushed before process exit (see {@link flush}).
   */
  private writeChain: Promise<void> = Promise.resolve();
  /** In-memory cache of the current session's custom title (for re-append on exit) */
  private currentCustomTitle: string | undefined;
  /**
   * Source of {@link currentCustomTitle}. `undefined` on legacy records that
   * pre-date the `titleSource` field — that's treated as manual everywhere
   * (safe default) without rewriting the persisted record.
   */
  private currentTitleSource: TitleSource | undefined;
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

  /**
   * JSON-serialized form of the most recent attribution snapshot we
   * wrote, used to deduplicate identical writes on every non-retry
   * turn. Without this, sessions that touch many files would write a
   * full duplicate of the entire snapshot to the JSONL on every turn,
   * inflating the on-disk session and making `/resume` slower to
   * hydrate.
   */
  private lastAttributionSnapshotJson: string | undefined;

  /**
   * Approximate bytes of JSONL content appended since the last
   * `custom_title` record landed in this file. Used by the title
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

  constructor(config: Config) {
    this.config = config;
    this.lastRecordUuid =
      config.getResumedSessionData()?.lastCompletedUuid ?? null;

    // On resume, load the cached custom title AND its source from the
    // session file. Preserving the persisted source is load-bearing: the
    // SessionPicker dim-styling depends on it, and hardcoding `'manual'`
    // would silently downgrade auto-titled sessions every time they get
    // resumed. Legacy records (no `titleSource` field) stay `undefined` —
    // treated as manual for safety without rewriting the JSONL.
    //
    // We then re-append a custom_title record to EOF so the title stays
    // within the tail window that readers scan (guarding against a crash
    // before the next finalize).
    if (config.getResumedSessionData()) {
      try {
        const sessionService = config.getSessionService();
        const info = sessionService.getSessionTitleInfo(config.getSessionId());
        this.currentCustomTitle = info.title;
        this.currentTitleSource = info.source;
        this.finalize();
      } catch {
        // Best-effort — don't block construction
      }
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
    return this.config.getSessionId();
  }

  /**
   * Ensures the chats directory exists, creating it if it doesn't exist.
   * @returns The path to the chats directory.
   * @throws Error if the directory cannot be created.
   */
  private ensureChatsDir(): string {
    const projectDir = this.config.storage.getProjectDir();
    const chatsDir = path.join(projectDir, 'chats');

    if (this.chatsDirEnsured) {
      return chatsDir;
    }
    try {
      fs.mkdirSync(chatsDir, { recursive: true });
      // Only cache success — keep transient mkdir failures self-healing.
      this.chatsDirEnsured = true;
    } catch {
      // ignored
    }
    return chatsDir;
  }

  /**
   * Ensures the conversation file exists, creating it if it doesn't exist.
   * Uses atomic file creation to avoid race conditions. Result is cached so
   * subsequent appendRecord calls skip the wx-create entirely.
   * @returns The path to the conversation file.
   * @throws Error if the file cannot be created or accessed.
   */
  private ensureConversationFile(): string {
    if (this.cachedConversationFile) {
      return this.cachedConversationFile;
    }
    const chatsDir = this.ensureChatsDir();
    const sessionId = this.getSessionId();
    const safeFilename = `${sessionId}.jsonl`;
    const conversationFile = path.join(chatsDir, safeFilename);

    try {
      // Use 'wx' flag for exclusive creation - atomic operation that fails if
      // the file already exists. EEXIST is the expected steady-state path on
      // resume; we treat it as success.
      fs.writeFileSync(conversationFile, '', { flag: 'wx', encoding: 'utf8' });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'EEXIST') {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to create conversation file at ${conversationFile}: ${message}`,
        );
      }
    }

    this.cachedConversationFile = conversationFile;
    return conversationFile;
  }

  /**
   * Creates base fields for a ChatRecord.
   */
  private createBaseRecord(
    type: ChatRecord['type'],
  ): Omit<ChatRecord, 'message' | 'tokens' | 'model' | 'toolCallsMetadata'> {
    return {
      uuid: randomUUID(),
      parentUuid: this.lastRecordUuid,
      sessionId: this.getSessionId(),
      timestamp: new Date().toISOString(),
      type,
      cwd: this.config.getProjectRoot(),
      version: this.config.getCliVersion() || 'unknown',
      gitBranch: getGitBranch(this.config.getProjectRoot()),
    };
  }

  /**
   * Appends a record to the session file and updates lastRecordUuid.
   *
   * lastRecordUuid is updated synchronously so the next createBaseRecord sees
   * the correct parentUuid without waiting for the previous write. The actual
   * fs write is enqueued on {@link writeChain} and runs async; per-file
   * mutex inside {@link jsonl.writeLine} preserves on-disk ordering.
   *
   * **Known tradeoff (parentUuid chain integrity on write failure):** if the
   * enqueued write rejects (e.g., disk full, permission dropped), the error
   * is logged but subsequent records still claim the failed record's uuid
   * as their parent. On resume, readers that walk parentUuid (e.g.
   * sessionService.reconstructHistory) will silently drop records whose
   * ancestor is missing on disk. This matches the sync version's behavior
   * when its own throw was caught and logged by the caller — under normal
   * local-disk writes failures are rare enough to accept the fire-and-forget
   * simplification.
   */
  /**
   * Fire-and-forget: queues a JSONL write on the internal writeChain
   * and swallows async failures (logs them via debugLogger). All
   * existing call sites — recordUserMessage, recordAssistantTurn,
   * etc. — invoke this synchronously without awaiting, so the
   * internal swallow keeps an unhandled-promise-rejection from
   * surfacing on a single transient writeLine failure.
   *
   * Callers that need to react to per-record write FAILURE (e.g. the
   * snapshot dedup-key rollback in `recordAttributionSnapshot`) pass
   * an `onError` callback, which fires after the write rejects (and
   * after the rejection has been logged + the chain re-armed). Sync
   * throws still propagate so the caller's outer try/catch can roll
   * back optimistic state — see the synchronous-failure test.
   */
  private appendRecord(
    record: ChatRecord,
    onError?: (err: unknown) => void,
    options?: { updateActiveTail?: boolean },
  ): void {
    let conversationFile: string;
    try {
      conversationFile = this.ensureConversationFile();
    } catch (error) {
      debugLogger.error('Error appending record:', error);
      throw error;
    }
    if (options?.updateActiveTail !== false) {
      this.lastRecordUuid = record.uuid;
    }
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(() => jsonl.writeLine(conversationFile, record))
      .catch((err) => {
        debugLogger.error('Error appending record (async):', err);
        if (onError) {
          try {
            onError(err);
          } catch (cbErr) {
            debugLogger.error('appendRecord onError callback threw:', cbErr);
          }
        }
      });
    this.updateTitleAnchorTracking(record);
  }

  /**
   * Maintain the "title is always in the tail window" invariant by
   * counting bytes appended since the last `custom_title` record and
   * re-anchoring once enough non-title content has been written.
   *
   * - A `custom_title` record IS the new anchor — reset the counter.
   * - Without a current title (never set), the counter is irrelevant.
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
      return;
    }
    if (!this.currentCustomTitle) return;
    // +1 for the trailing newline jsonl.writeLine appends.
    this.bytesSinceTitleAnchor +=
      Buffer.byteLength(JSON.stringify(record), 'utf8') + 1;
    if (this.bytesSinceTitleAnchor >= TITLE_REANCHOR_BYTES) {
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
      this.appendRecord(record, undefined, { updateActiveTail: false });
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
    await this.writeChain;
  }

  /**
   * Records a user message.
   * Writes immediately to disk.
   *
   * @param message The raw PartListUnion object as used with the API
   */
  recordUserMessage(message: PartListUnion): void {
    try {
      this.turnParentUuids.push(this.lastRecordUuid);
      const record: ChatRecord = {
        ...this.createBaseRecord('user'),
        message: createUserContent(message),
      };
      this.appendRecord(record);
    } catch (error) {
      debugLogger.error('Error saving user message:', error);
    }
  }

  /**
   * Records a cron-fired prompt.
   * Stored as a user-role message with subtype 'cron' so the UI
   * restores it as a notification item instead of a user turn.
   */
  recordCronPrompt(message: PartListUnion, displayText?: string): void {
    this.recordNotificationLike(message, 'cron', displayText);
  }

  /**
   * Records a background agent notification.
   * Stored as a user-role message with subtype 'notification' so the
   * UI restores it as an info item, not a user turn.
   */
  recordNotification(message: PartListUnion, displayText?: string): void {
    this.recordNotificationLike(message, 'notification', displayText);
  }

  private recordNotificationLike(
    message: PartListUnion,
    subtype: 'notification' | 'cron',
    displayText?: string,
  ): void {
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('user'),
        subtype,
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
   * Writes immediately to disk.
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
  }): void {
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('assistant'),
        model: data.model,
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
    if (this.autoTitleController) return;
    if (this.autoTitleAttempts >= AUTO_TITLE_ATTEMPT_CAP) return;
    // Opt-out env var — lets users silence auto-titling without having to
    // unset their fast model (which would break `/rename --auto`, recap,
    // compression, and other fast-model features).
    if (autoTitleDisabledByEnv()) return;
    // Headless/one-shot CLI flows (`qwen -p "…"`, cron, CI scripts) run a
    // single prompt and throw the session away. Spending fast-model tokens
    // on a title no one will ever resume is pure waste; skip entirely.
    // Checked before `getFastModelForSideQuery()` because it's strictly
    // cheaper (a bool field read vs. a method that looks up available models).
    if (!this.config.isInteractive()) return;
    const fastModel =
      this.config.getFastModelForSideQuery?.() ?? this.config.getFastModel();
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
        // Re-check in case a /rename landed while the LLM call was in flight —
        // manual wins. In-process is the common path.
        if (this.currentTitleSource === 'manual') return;
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
        this.recordCustomTitle(outcome.title, 'auto');
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
   * Writes immediately to disk.
   *
   * @param message The raw PartListUnion object with functionResponse parts
   * @param toolCallResult Optional tool call result info for UI recovery
   */
  recordToolResult(
    message: PartListUnion,
    toolCallResult?: Partial<ToolCallResponseInfo> & { status: Status },
  ): void {
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('tool_result'),
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
  rewindRecording(targetTurnIndex: number, payload: RewindRecordPayload): void {
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
    let prevUuid: string | null =
      this.config.getResumedSessionData()?.lastCompletedUuid !== undefined
        ? null
        : this.lastRecordUuid;

    for (let i = 0; i < messages.length; i++) {
      const record = messages[i];
      if (
        record.type === 'user' &&
        record.subtype !== 'notification' &&
        record.subtype !== 'cron'
      ) {
        this.turnParentUuids.push(prevUuid);
      }
      prevUuid = record.uuid;
    }
    // Ensure lastRecordUuid points to the end of the reconstructed chain.
    if (messages.length > 0) {
      this.lastRecordUuid = messages[messages.length - 1].uuid;
    }
  }

  /**
   * Records a custom title for the session.
   * Appended as a system record so it persists with the session data.
   * Also caches the title in memory for re-append on shutdown.
   *
   * @param customTitle The title text.
   * @param titleSource Where the title came from — defaults to `'manual'`
   *   so existing `/rename` call sites keep their behavior unchanged.
   * @returns true if the record was written successfully, false on I/O error.
   */
  recordCustomTitle(
    customTitle: string,
    titleSource: TitleSource = 'manual',
  ): boolean {
    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('system'),
        type: 'system',
        subtype: 'custom_title',
        systemPayload: { customTitle, titleSource },
      };

      this.appendRecord(record);
      this.currentCustomTitle = customTitle;
      this.currentTitleSource = titleSource;
      return true;
    } catch (error) {
      debugLogger.error('Error saving custom title record:', error);
      return false;
    }
  }

  /**
   * Finalizes the current session by re-appending cached metadata to EOF.
   *
   * Call this whenever leaving the current session — whether switching to
   * another session, shutting down the process, or any other transition.
   * This single entry point replaces scattered re-append calls and ensures
   * the custom_title record stays within the last 64KB tail window that
   * readSessionTitleFromFile() scans.
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
    if (!this.currentCustomTitle) {
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
   * Set the dedup key optimistically and roll it back if the write
   * fails. Synchronous identical calls (common during a tool-driven
   * turn) all dedup correctly, but a transient write failure clears
   * the key so the next identical snapshot retries the write rather
   * than being permanently suppressed.
   */
  recordAttributionSnapshot(snapshot: AttributionSnapshot): void {
    let json: string | undefined;
    try {
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
      this.appendRecord(record, () => {
        // Async write failed — only roll back if the key still
        // belongs to our snapshot (a later distinct write may have
        // overwritten it).
        if (this.lastAttributionSnapshotJson === json) {
          this.lastAttributionSnapshotJson = undefined;
        }
      });
    } catch (error) {
      // appendRecord (and createBaseRecord/JSON.stringify) can throw
      // synchronously — e.g. ensureConversationFile() fails because
      // the project temp dir isn't writable. The .catch() handler
      // attached to the promise never runs in that case, so we'd
      // otherwise leave the dedup key set without a write ever
      // having landed and permanently suppress identical retries.
      // Roll back here too.
      if (json !== undefined && this.lastAttributionSnapshotJson === json) {
        this.lastAttributionSnapshotJson = undefined;
      }
      debugLogger.error('Error saving attribution snapshot:', error);
    }
  }
}
