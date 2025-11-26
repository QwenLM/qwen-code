/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Config } from '../config/config.js';
import { type Status } from '../core/coreToolScheduler.js';
import { getProjectHash } from '../utils/paths.js';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  PartListUnion,
  Content,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import * as jsonl from '../utils/jsonl-utils.js';
import { getGitBranch } from '../utils/gitUtils.js';

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
 * Record of a tool call execution within a conversation.
 */
export interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: PartListUnion | null;
  status: Status;
  timestamp: string;
  // UI-specific fields for display purposes
  displayName?: string;
  description?: string;
  resultDisplay?: string;
  renderOutputAsMarkdown?: boolean;
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
  toolCallsMetadata?: ToolCallRecord[];
}

/**
 * Lightweight metadata about a recorded session.
 * Extracted from the first and last records of a session file.
 */
export interface SessionMetadata {
  sessionId: string;
  startTime: string;
  lastUpdated: string;
  messageCount: number;
  projectHash: string;
  filePath: string;
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
 * Data structure for resuming an existing session.
 */
export interface ResumedSessionData {
  conversation: ConversationRecord;
  filePath: string;
  /** UUID of the last completed message - new messages should use this as parentUuid */
  lastCompletedUuid: string | null;
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
 * Service for automatically recording chat conversations to disk.
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
 *
 * **Storage Format:** JSONL files with tree-structured records.
 * Each record has uuid/parentUuid fields enabling:
 * - Append-only writes (never rewrite the file)
 * - Linear history reconstruction
 * - Future checkpointing (branch from any historical point)
 *
 * File location: ~/.qwen/tmp/<project_id>/chats/
 */
export class ChatRecordingService {
  private conversationFile: string | null = null;
  private sessionId: string;
  private projectHash: string;
  /** UUID of the last written record in the chain */
  private lastRecordUuid: string | null = null;
  private config: Config;
  private sessionListCache: SessionMetadata[] | null = null;

  constructor(config: Config) {
    this.config = config;
    this.sessionId = config.getSessionId();
    this.projectHash = getProjectHash(config.getProjectRoot());
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
      sessionId: this.sessionId,
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
   * Enriches tool calls with metadata from the ToolRegistry.
   */
  private enrichToolCalls(toolCalls: ToolCallRecord[]): ToolCallRecord[] {
    const toolRegistry = this.config.getToolRegistry();
    return toolCalls.map((toolCall) => {
      const toolInstance = toolRegistry.getTool(toolCall.name);
      return {
        ...toolCall,
        displayName: toolInstance?.displayName || toolCall.name,
        description: toolInstance?.description || '',
        renderOutputAsMarkdown: toolInstance?.isOutputMarkdown || false,
      };
    });
  }

  /**
   * Initializes the chat recording service.
   * Creates a new session file or resumes from an existing session.
   */
  initialize(resumedSessionData?: ResumedSessionData): void {
    try {
      if (resumedSessionData) {
        // Resume from existing session
        this.conversationFile = resumedSessionData.filePath;
        this.sessionId = resumedSessionData.conversation.sessionId;
        this.lastRecordUuid = resumedSessionData.lastCompletedUuid;
      } else {
        // Create new session
        const chatsDir = this.getChatsDir();
        fs.mkdirSync(chatsDir, { recursive: true });

        const filename = `${this.sessionId}.jsonl`;
        this.conversationFile = path.join(chatsDir, filename);
        this.lastRecordUuid = null;

        // Touch the file to create it (empty file until first message)
        fs.writeFileSync(this.conversationFile, '', 'utf8');
      }
    } catch (error) {
      console.error('Error initializing chat recording service:', error);
      throw error;
    }
  }

  /**
   * Records a user message.
   * Writes immediately to disk.
   *
   * @param content The raw Content object (role + parts) as used with the API
   */
  recordUserMessage(content: Content): void {
    if (!this.conversationFile) return;

    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('user'),
        message: content,
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
   * @param data.content The raw Content object (role + parts) from the model response
   * @param data.model The model name
   * @param data.tokens Token usage statistics
   * @param data.toolCallsMetadata Enriched tool call info for UI recovery
   */
  recordAssistantTurn(data: {
    model: string;
    content?: Content;
    tokens?: UsageMetadata;
    toolCallsMetadata?: ToolCallRecord[];
  }): void {
    if (!this.conversationFile) return;

    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('assistant'),
        model: data.model,
      };

      if (data.content !== undefined) {
        record.message = data.content;
      }

      if (data.tokens) {
        record.usageMetadata = data.tokens;
      }

      if (data.toolCallsMetadata && data.toolCallsMetadata.length > 0) {
        record.toolCallsMetadata = this.enrichToolCalls(data.toolCallsMetadata);
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
   * @param content The raw Content object with functionResponse parts
   * @param toolCallsMetadata Optional enriched tool call info for UI recovery
   */
  recordToolResult(
    content: Content,
    toolCallsMetadata?: ToolCallRecord[],
  ): void {
    if (!this.conversationFile) return;

    try {
      const record: ChatRecord = {
        ...this.createBaseRecord('tool_result'),
        message: content,
      };

      if (toolCallsMetadata && toolCallsMetadata.length > 0) {
        record.toolCallsMetadata = this.enrichToolCalls(toolCallsMetadata);
      }

      this.appendRecord(record);
    } catch (error) {
      console.error('Error saving tool result:', error);
      throw error;
    }
  }

  // ============================================================
  // Session loading and management
  // ============================================================

  /**
   * Reads all records from a session file.
   */
  private async readAllRecords(filePath: string): Promise<ChatRecord[]> {
    try {
      return await jsonl.read<ChatRecord>(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Error reading session file:', error);
      }
      return [];
    }
  }

  /**
   * Aggregates multiple records with the same uuid into a single ChatRecord.
   * Merges content fields (message, tokens, model, toolCallsMetadata).
   *
   * For message aggregation: If multiple records have Content, we merge the parts.
   * This supports streaming scenarios where parts arrive separately.
   */
  private aggregateRecords(records: ChatRecord[]): ChatRecord {
    if (records.length === 0) {
      throw new Error('Cannot aggregate empty records array');
    }

    // Start with the first record as base
    const base = { ...records[0] };

    // Merge content fields from all records
    for (let i = 1; i < records.length; i++) {
      const record = records[i];

      // Merge message (Content objects)
      if (record.message !== undefined) {
        if (base.message === undefined) {
          base.message = record.message;
        } else {
          // Merge parts from both Content objects
          base.message = {
            role: base.message.role,
            parts: [
              ...(base.message.parts || []),
              ...(record.message.parts || []),
            ],
          };
        }
      }

      // Merge tokens (take the latest/most complete one)
      if (record.usageMetadata) {
        base.usageMetadata = record.usageMetadata;
      }

      // Merge toolCallsMetadata (concatenate arrays)
      if (record.toolCallsMetadata) {
        if (!base.toolCallsMetadata) {
          base.toolCallsMetadata = [];
        }
        base.toolCallsMetadata.push(...record.toolCallsMetadata);
      }

      // Merge model (take the first non-empty one)
      if (record.model && !base.model) {
        base.model = record.model;
      }

      // Update timestamp to the latest
      if (record.timestamp > base.timestamp) {
        base.timestamp = record.timestamp;
      }
    }

    return base;
  }

  /**
   * Reconstructs a linear conversation from tree-structured records.
   * Follows parentUuid chain from the latest record back to root,
   * aggregating records with the same uuid.
   *
   * @param records All records from the file
   * @param leafUuid Optional: start from a specific record (for checkpointing)
   * @returns Aggregated messages in chronological order (root first)
   */
  private reconstructHistory(
    records: ChatRecord[],
    leafUuid?: string,
  ): ChatRecord[] {
    if (records.length === 0) return [];

    // Build uuid -> records[] map for aggregation
    const recordsByUuid = new Map<string, ChatRecord[]>();
    for (const record of records) {
      const existing = recordsByUuid.get(record.uuid) || [];
      existing.push(record);
      recordsByUuid.set(record.uuid, existing);
    }

    // Find the leaf (latest message uuid or specified checkpoint)
    let currentUuid: string | null;
    if (leafUuid) {
      currentUuid = leafUuid;
    } else {
      // Default to the uuid of the last record in the file
      currentUuid = records[records.length - 1].uuid;
    }

    // Follow parentUuid chain to root, collecting unique uuids
    const uuidChain: string[] = [];
    const visited = new Set<string>();

    while (currentUuid && !visited.has(currentUuid)) {
      visited.add(currentUuid);
      uuidChain.push(currentUuid);

      // Get the first record with this uuid to find parentUuid
      const recordsForUuid = recordsByUuid.get(currentUuid);
      if (!recordsForUuid || recordsForUuid.length === 0) break;
      currentUuid = recordsForUuid[0].parentUuid;
    }

    // Reverse to get chronological order and aggregate
    uuidChain.reverse();
    const messages: ChatRecord[] = [];
    for (const uuid of uuidChain) {
      const recordsForUuid = recordsByUuid.get(uuid);
      if (recordsForUuid && recordsForUuid.length > 0) {
        messages.push(this.aggregateRecords(recordsForUuid));
      }
    }

    return messages;
  }

  /**
   * Extracts session metadata from records.
   */
  private extractMetadata(
    records: ChatRecord[],
    filePath: string,
  ): SessionMetadata | null {
    if (records.length === 0) return null;

    // Count unique uuids for message count
    const uniqueUuids = new Set(records.map((r) => r.uuid));

    const first = records[0];
    const last = records[records.length - 1];

    return {
      sessionId: first.sessionId,
      startTime: first.timestamp,
      lastUpdated: last.timestamp,
      messageCount: uniqueUuids.size,
      projectHash: this.projectHash,
      filePath,
    };
  }

  /**
   * Deletes a session file by session ID.
   */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      const sessions = await this.listSessions();
      const match = sessions.find((session) => session.sessionId === sessionId);
      if (!match) {
        return;
      }
      fs.unlinkSync(match.filePath);

      // Remove from cache
      if (this.sessionListCache) {
        this.sessionListCache = this.sessionListCache.filter(
          (s) => s.sessionId !== sessionId,
        );
      }
    } catch (error) {
      console.error('Error deleting session:', error);
      throw error;
    }
  }

  /**
   * Lists all recorded sessions for the current project, sorted by lastUpdated descending.
   * @param forceReload - If true, bypasses cache and reloads from disk
   */
  async listSessions(forceReload = false): Promise<SessionMetadata[]> {
    // Return cached list if available and not forcing reload
    if (!forceReload && this.sessionListCache) {
      return this.sessionListCache;
    }

    const sessions: SessionMetadata[] = [];
    const chatsDir = this.getChatsDir();
    let files: string[] = [];
    try {
      files = fs.readdirSync(chatsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.sessionListCache = [];
        return [];
      }
      console.error('Error listing sessions:', error);
      throw error;
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(chatsDir, file);

      // Read all records for metadata extraction
      const records = await this.readAllRecords(filePath);
      const metadata = this.extractMetadata(records, filePath);

      if (!metadata) continue;
      if (metadata.projectHash !== this.projectHash) continue;

      sessions.push(metadata);
    }

    sessions.sort(
      (a, b) =>
        new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
    );

    // Cache the result
    this.sessionListCache = sessions;
    return sessions;
  }

  /**
   * Loads a specific session by session ID.
   * Reconstructs the conversation from tree-structured records.
   */
  async loadSession(sessionId: string): Promise<ResumedSessionData | null> {
    // Use cached session list to find the session
    const sessions = await this.listSessions();
    const session = sessions.find((s) => s.sessionId === sessionId);

    if (!session) {
      return null;
    }

    const records = await this.readAllRecords(session.filePath);
    if (records.length === 0) {
      return null;
    }

    // Reconstruct linear history from tree
    const messages = this.reconstructHistory(records);
    if (messages.length === 0) {
      return null;
    }

    const lastMessage = messages[messages.length - 1];

    const conversation: ConversationRecord = {
      sessionId: session.sessionId,
      projectHash: session.projectHash,
      startTime: session.startTime,
      lastUpdated: session.lastUpdated,
      messages,
    };

    return {
      conversation,
      filePath: session.filePath,
      lastCompletedUuid: lastMessage.uuid,
    };
  }

  /**
   * Convenience helper to get the newest session.
   */
  async getLatestSession(): Promise<ResumedSessionData | null> {
    const sessions = await this.listSessions();
    if (sessions.length === 0) return null;
    return await this.loadSession(sessions[0].sessionId);
  }
}
