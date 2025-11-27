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
import type { ToolCallResponseInfo } from '../core/turn.js';
import { type ResumedSessionData } from './sessionService.js';

/**
 * Token usage summary for a message or conversation.
 */
export interface UsageMetadata {
  input: number; // promptTokenCount
  output: number; // candidatesTokenCount
  cached: number; // cachedContentTokenCount
  thoughts?: number; // thoughtsTokenCount
  tool?: number; // toolUsePromptTokenCount
  total: number; // totalTokenCount
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
  /** Message type: user input, assistant response, or tool result */
  type: 'user' | 'assistant' | 'tool_result';
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
  usageMetadata?: UsageMetadata;
  /** Model used for this response */
  model?: string;
  /**
   * Tool call metadata for UI recovery.
   * Contains enriched info (displayName, status, result, etc.) not in API format.
   */
  toolCallResult?: Partial<ToolCallResponseInfo>;
}

/**
 * Complete conversation reconstructed from ChatRecords.
 * Used for resuming sessions and API compatibility.
 */
export interface ConversationRecord {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  /** Messages in chronological order (reconstructed from tree) */
  messages: ChatRecord[];
}

/**
 * Converts GenerateContentResponseUsageMetadata to TokensSummary.
 */
export function toTokensSummary(
  metadata: GenerateContentResponseUsageMetadata,
): UsageMetadata {
  return {
    input: metadata.promptTokenCount ?? 0,
    output: metadata.candidatesTokenCount ?? 0,
    cached: metadata.cachedContentTokenCount ?? 0,
    thoughts: metadata.thoughtsTokenCount ?? 0,
    tool: metadata.toolUsePromptTokenCount ?? 0,
    total: metadata.totalTokenCount ?? 0,
  };
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
  private conversationFile: string | null = null;
  private sessionId: string | undefined = undefined;
  /** UUID of the last written record in the chain */
  private lastRecordUuid: string | null = null;
  private readonly config: Config;
  private resumedSessionData?: ResumedSessionData;

  constructor(config: Config) {
    this.config = config;
  }

  private getChatsDir(): string {
    return path.join(this.config.storage.getProjectDir(), 'chats');
  }

  /**
   * Creates base fields for a ChatRecord.
   */
  private createBaseRecord(
    type: 'user' | 'assistant' | 'tool_result',
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
    if (!this.conversationFile) return;

    try {
      jsonl.writeLineSync(this.conversationFile, record);
      this.lastRecordUuid = record.uuid;
    } catch (error) {
      console.error('Error appending record:', error);
      throw error;
    }
  }

  /**
   * Initializes the chat recording service.
   * Loads a resumed session if requested, or creates a new session file.
   */
  initialize(sessionId?: string, sessionData?: ResumedSessionData): void {
    this.sessionId = sessionId ?? randomUUID();

    try {
      if (sessionData) {
        // Resume from existing session
        this.conversationFile = sessionData.filePath;
        this.sessionId = sessionData.conversation.sessionId;
        this.lastRecordUuid = sessionData.lastCompletedUuid;
        this.resumedSessionData = sessionData;
      } else {
        // Create new session
        const chatsDir = this.getChatsDir();

        const filename = `${this.sessionId}.jsonl`;
        this.conversationFile = path.join(chatsDir, filename);
        this.lastRecordUuid = null;

        if (process.env['VITEST'] === 'true') {
          return;
        }

        // Create the chats directory if it doesn't exist
        fs.mkdirSync(chatsDir, { recursive: true });
        // Touch the file to create it (empty file until first message)
        fs.writeFileSync(this.conversationFile, '', 'utf8');
      }
    } catch (error) {
      console.error('Error initializing chat recording service:', error);
      throw error;
    }
  }

  /**
   * Returns the resumed session data if this session was resumed from a previous one.
   */
  getResumedSessionData(): ResumedSessionData | undefined {
    return this.resumedSessionData;
  }

  /**
   * Returns the session ID (may be updated after initialization if resuming).
   */
  getSessionId(): string {
    if (!this.sessionId) {
      if (process.env['VITEST'] === 'true') {
        this.sessionId = 'test-session-id';
      } else {
        throw new Error('ChatRecordingService is not initialized');
      }
    }
    return this.sessionId;
  }

  /**
   * Records a user message.
   * Writes immediately to disk.
   *
   * @param message The raw PartListUnion object as used with the API
   */
  recordUserMessage(message: PartListUnion): void {
    if (!this.conversationFile) return;

    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('user'),
        message: createUserContent(message),
      };
      this.appendRecord(record);
    } catch (error) {
      console.error('Error saving user message:', error);
      throw error;
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
    tokens?: UsageMetadata;
  }): void {
    if (!this.conversationFile) return;

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
      throw error;
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
    toolCallResult?: Partial<ToolCallResponseInfo>,
  ): void {
    if (!this.conversationFile) return;

    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('tool_result'),
        message: createUserContent(message),
      };

      if (toolCallResult) {
        record.toolCallResult = toolCallResult;
      }

      this.appendRecord(record);
    } catch (error) {
      console.error('Error saving tool result:', error);
      throw error;
    }
  }
}
