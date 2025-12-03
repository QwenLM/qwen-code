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
import type {
  ChatCompressionInfo,
  ToolCallResponseInfo,
} from '../core/turn.js';
import type { Status } from '../core/coreToolScheduler.js';
import type { TaskResultDisplay } from '../tools/tools.js';
import type { UiEvent } from '../telemetry/uiTelemetry.js';

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
  subtype?: 'chat_compression' | 'slash_command' | 'ui_telemetry';
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
    | UiTelemetryRecordPayload;
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

  constructor(config: Config) {
    this.config = config;
    this.lastRecordUuid =
      config.getResumedSessionData()?.lastCompletedUuid ?? null;
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
      console.error('Error appending record:', error);
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
      console.error('Error saving user message:', error);
    }
  }

  /**
   * Records an assistant turn with all available data.
   * Writes immediately to disk.
   *
   * @param data.message The raw PartListUnion object from the model response
   * @param data.model The model name
   * @param data.tokens Token usage statistics
   * @param data.toolCallsMetadata Enriched tool call info for UI recovery
   */
  recordAssistantTurn(data: {
    model: string;
    message?: PartListUnion;
    tokens?: GenerateContentResponseUsageMetadata;
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

      this.appendRecord(record);
    } catch (error) {
      console.error('Error saving assistant turn:', error);
    }
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
          const taskResult = toolCallResult.resultDisplay as TaskResultDisplay;
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
      console.error('Error saving tool result:', error);
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
      console.error('Error saving slash command record:', error);
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
      console.error('Error saving chat compression record:', error);
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
      console.error('Error saving ui telemetry record:', error);
    }
  }
}
