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
  type GenerateContentResponseUsageMetadata,
  createUserContent,
  createModelContent,
} from '@google/genai';
import * as jsonl from '../utils/jsonl-utils.js';
import { getGitBranch } from '../utils/gitUtils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { tryGenerateSessionTitle } from './sessionTitle.js';
import type {
  ChatCompressionInfo,
  ToolCallResponseInfo,
} from '../core/turn.js';
import type { Status } from '../core/coreToolScheduler.js';
import type { AgentResultDisplay } from '../tools/tools.js';
import type { UiEvent } from '../telemetry/uiTelemetry.js';

const debugLogger = createDebugLogger('CHAT_RECORDING');

/**
 * Maximum number of auto-title generation attempts per session. See
 * {@link ChatRecordingService.autoTitleAttempts} for the rationale behind
 * retrying across turns.
 */
const AUTO_TITLE_ATTEMPT_CAP = 3;

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
    | 'notification'
    | 'cron'
    | 'custom_title';
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
    | CustomTitleRecordPayload
    | NotificationRecordPayload;
}

export interface NotificationRecordPayload {
  displayText: string;
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

    try {
      fs.mkdirSync(chatsDir, { recursive: true });
    } catch {
      // Ignore errors - directory will be created if it doesn't exist
    }

    return chatsDir;
  }

  /**
   * Ensures the conversation file exists, creating it if it doesn't exist.
   * Uses atomic file creation to avoid race conditions.
   * @returns The path to the conversation file.
   * @throws Error if the file cannot be created or accessed.
   */
  private ensureConversationFile(): string {
    const chatsDir = this.ensureChatsDir();
    const sessionId = this.getSessionId();
    const safeFilename = `${sessionId}.jsonl`;
    const conversationFile = path.join(chatsDir, safeFilename);

    if (fs.existsSync(conversationFile)) {
      return conversationFile;
    }

    try {
      // Use 'wx' flag for exclusive creation - atomic operation that fails if file exists
      // This avoids the TOCTOU race condition of existsSync + writeFileSync
      fs.writeFileSync(conversationFile, '', { flag: 'wx', encoding: 'utf8' });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      // EEXIST means file already exists, which is expected and fine
      if (nodeError.code !== 'EEXIST') {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to create conversation file at ${conversationFile}: ${message}`,
        );
      }
    }

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
   */
  private appendRecord(record: ChatRecord): void {
    try {
      const conversationFile = this.ensureConversationFile();

      jsonl.writeLineSync(conversationFile, record);
      this.lastRecordUuid = record.uuid;
    } catch (error) {
      debugLogger.error('Error appending record:', error);
      throw error;
    }
  }

  /**
   * Records a user message.
   * Writes immediately to disk.
   *
   * @param message The raw PartListUnion object as used with the API
   */
  recordUserMessage(message: PartListUnion): void {
    try {
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
    // Checked before `getFastModel()` because it's strictly cheaper (a bool
    // field read vs. a method that looks up available models for the auth
    // type).
    if (!this.config.isInteractive()) return;
    if (!this.config.getFastModel()) return;

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
        // special case for task executions - we don't want to record the tool calls
        if (
          typeof toolCallResult.resultDisplay === 'object' &&
          toolCallResult.resultDisplay !== null &&
          'type' in toolCallResult.resultDisplay &&
          toolCallResult.resultDisplay.type === 'task_execution'
        ) {
          const taskResult = toolCallResult.resultDisplay as AgentResultDisplay;
          record.toolCallResult = {
            ...toolCallResult,
            resultDisplay: {
              ...taskResult,
              toolCalls: [],
            },
          };
        } else {
          record.toolCallResult = toolCallResult;
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
}
