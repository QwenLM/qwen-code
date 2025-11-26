/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Config } from '../config/config.js';
import { getProjectHash } from '../utils/paths.js';
import path from 'node:path';
import fs from 'node:fs';
import type { Content, Part } from '@google/genai';
import * as jsonl from '../utils/jsonl-utils.js';
import type { ChatRecord, ConversationRecord } from './chatRecordingService.js';

/**
 * Session item for list display.
 * Contains essential info extracted from the first record of a session file.
 */
export interface SessionListItem {
  /** Unique session identifier */
  sessionId: string;
  /** Working directory at session start */
  cwd: string;
  /** ISO 8601 timestamp when session started */
  startTime: string;
  /** File modification time (used for ordering and pagination) */
  mtime: number;
  /** First user prompt text (truncated for display) */
  prompt: string;
  /** Git branch at session start, if available */
  gitBranch?: string;
  /** Full path to the session file */
  filePath: string;
}

/**
 * Pagination options for listing sessions.
 */
export interface ListSessionsOptions {
  /**
   * Cursor for pagination (mtime of the last item from previous page).
   * Items with mtime < cursor will be returned.
   * If undefined, starts from the most recent.
   */
  cursor?: number;
  /**
   * Maximum number of items to return.
   * @default 20
   */
  size?: number;
}

/**
 * Result of listing sessions with pagination info.
 */
export interface ListSessionsResult {
  /** Session items for this page */
  items: SessionListItem[];
  /**
   * Cursor for next page (mtime of last item).
   * Undefined if no more items.
   */
  nextCursor?: number;
  /** Whether there are more items after this page */
  hasMore: boolean;
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
 * Maximum number of files to process when listing sessions.
 * This is a safety limit to prevent performance issues with very large chat directories.
 */
const MAX_FILES_TO_PROCESS = 10000;

/**
 * Pattern for validating session file names.
 * Session files are named as `${sessionId}.jsonl` where sessionId is a UUID-like identifier
 * (32-36 hex characters, optionally with hyphens).
 */
const SESSION_FILE_PATTERN = /^[0-9a-fA-F-]{32,36}\.jsonl$/;

/**
 * Service for managing chat sessions.
 *
 * This service handles:
 * - Listing sessions with pagination (ordered by mtime)
 * - Loading full session data for resumption
 * - Removing sessions
 *
 * Sessions are stored as JSONL files, one per session.
 * File location: ~/.qwen/tmp/<project_id>/chats/
 */
export class SessionService {
  private readonly config: Config;
  private readonly projectHash: string;

  constructor(config: Config) {
    this.config = config;
    this.projectHash = getProjectHash(config.getProjectRoot());
  }

  private getChatsDir(): string {
    return path.join(this.config.storage.getProjectDir(), 'chats');
  }

  /**
   * Extracts the first user prompt text from a Content object.
   */
  private extractPromptText(message: Content | undefined): string {
    if (!message?.parts) return '';

    for (const part of message.parts as Part[]) {
      if ('text' in part) {
        const textPart = part as { text: string };
        const text = textPart.text;
        // Truncate long prompts for display
        return text.length > 200 ? `${text.slice(0, 200)}...` : text;
      }
    }
    return '';
  }

  /**
   * Lists sessions for the current project with pagination.
   *
   * Sessions are ordered by file modification time (most recent first).
   * Uses cursor-based pagination with mtime as the cursor.
   *
   * Only reads the first line of each JSONL file for efficiency.
   * Files are filtered by UUID pattern first, then by project hash.
   *
   * @param options Pagination options
   * @returns Paginated list of sessions
   */
  async listSessions(
    options: ListSessionsOptions = {},
  ): Promise<ListSessionsResult> {
    const { cursor, size = 20 } = options;
    const chatsDir = this.getChatsDir();

    // Get all valid session files (matching UUID pattern) with their stats
    let files: Array<{ name: string; mtime: number }> = [];
    try {
      const fileNames = fs.readdirSync(chatsDir);
      for (const name of fileNames) {
        // Only process files matching session file pattern
        if (!SESSION_FILE_PATTERN.test(name)) continue;
        const filePath = path.join(chatsDir, name);
        try {
          const stats = fs.statSync(filePath);
          files.push({ name, mtime: stats.mtimeMs });
        } catch {
          // Skip files we can't stat
          continue;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { items: [], hasMore: false };
      }
      throw error;
    }

    // Sort by mtime descending (most recent first)
    files.sort((a, b) => b.mtime - a.mtime);

    // Apply cursor filter (items with mtime < cursor)
    if (cursor !== undefined) {
      files = files.filter((f) => f.mtime < cursor);
    }

    // Iterate through files until we have enough matching ones.
    // Different projects may share the same chats directory due to path sanitization,
    // so we need to filter by project hash and continue until we have enough items.
    const items: SessionListItem[] = [];
    let filesProcessed = 0;
    let lastProcessedMtime: number | undefined;
    let hasMoreFiles = false;

    for (const file of files) {
      // Safety limit to prevent performance issues
      if (filesProcessed >= MAX_FILES_TO_PROCESS) {
        hasMoreFiles = true;
        break;
      }

      // Stop if we have enough items
      if (items.length >= size) {
        hasMoreFiles = true;
        break;
      }

      filesProcessed++;
      lastProcessedMtime = file.mtime;

      const filePath = path.join(chatsDir, file.name);
      const records = await jsonl.readLines<ChatRecord>(filePath, 1);

      if (records.length === 0) continue;
      const firstRecord = records[0];

      // Skip if not matching current project
      // We use cwd comparison since first record doesn't have projectHash
      const recordProjectHash = getProjectHash(firstRecord.cwd);
      if (recordProjectHash !== this.projectHash) continue;

      items.push({
        sessionId: firstRecord.sessionId,
        cwd: firstRecord.cwd,
        startTime: firstRecord.timestamp,
        mtime: file.mtime,
        prompt: this.extractPromptText(firstRecord.message),
        gitBranch: firstRecord.gitBranch,
        filePath,
      });
    }

    // Determine next cursor (mtime of last processed file)
    // Only set if there are more files to process
    const nextCursor =
      hasMoreFiles && lastProcessedMtime !== undefined
        ? lastProcessedMtime
        : undefined;

    return {
      items,
      nextCursor,
      hasMore: hasMoreFiles,
    };
  }

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
   * Merges content fields (message, tokens, model, toolCallResult).
   */
  private aggregateRecords(records: ChatRecord[]): ChatRecord {
    if (records.length === 0) {
      throw new Error('Cannot aggregate empty records array');
    }

    const base = { ...records[0] };

    for (let i = 1; i < records.length; i++) {
      const record = records[i];

      // Merge message (Content objects)
      if (record.message !== undefined) {
        if (base.message === undefined) {
          base.message = record.message;
        } else {
          base.message = {
            role: base.message.role,
            parts: [
              ...(base.message.parts || []),
              ...(record.message.parts || []),
            ],
          };
        }
      }

      // Merge tokens (take the latest)
      if (record.usageMetadata) {
        base.usageMetadata = record.usageMetadata;
      }

      // Merge toolCallResult
      if (record.toolCallResult && !base.toolCallResult) {
        base.toolCallResult = record.toolCallResult;
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
   */
  private reconstructHistory(
    records: ChatRecord[],
    leafUuid?: string,
  ): ChatRecord[] {
    if (records.length === 0) return [];

    const recordsByUuid = new Map<string, ChatRecord[]>();
    for (const record of records) {
      const existing = recordsByUuid.get(record.uuid) || [];
      existing.push(record);
      recordsByUuid.set(record.uuid, existing);
    }

    let currentUuid: string | null =
      leafUuid ?? records[records.length - 1].uuid;
    const uuidChain: string[] = [];
    const visited = new Set<string>();

    while (currentUuid && !visited.has(currentUuid)) {
      visited.add(currentUuid);
      uuidChain.push(currentUuid);
      const recordsForUuid = recordsByUuid.get(currentUuid);
      if (!recordsForUuid || recordsForUuid.length === 0) break;
      currentUuid = recordsForUuid[0].parentUuid;
    }

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
   * Loads a session by its session ID.
   * Reconstructs the full conversation from tree-structured records.
   *
   * @param sessionId The session ID to load
   * @returns Session data for resumption, or null if not found
   */
  async loadSession(sessionId: string): Promise<ResumedSessionData | null> {
    const chatsDir = this.getChatsDir();
    const filePath = path.join(chatsDir, `${sessionId}.jsonl`);

    const records = await this.readAllRecords(filePath);
    if (records.length === 0) {
      return null;
    }

    // Verify this session belongs to the current project
    const firstRecord = records[0];
    const recordProjectHash = getProjectHash(firstRecord.cwd);
    if (recordProjectHash !== this.projectHash) {
      return null;
    }

    // Reconstruct linear history
    const messages = this.reconstructHistory(records);
    if (messages.length === 0) {
      return null;
    }

    const lastMessage = messages[messages.length - 1];
    const stats = fs.statSync(filePath);

    const conversation: ConversationRecord = {
      sessionId: firstRecord.sessionId,
      projectHash: this.projectHash,
      startTime: firstRecord.timestamp,
      lastUpdated: new Date(stats.mtimeMs).toISOString(),
      messages,
    };

    return {
      conversation,
      filePath,
      lastCompletedUuid: lastMessage.uuid,
    };
  }

  /**
   * Removes a session by its session ID.
   *
   * @param sessionId The session ID to remove
   * @returns true if removed, false if not found
   */
  async removeSession(sessionId: string): Promise<boolean> {
    const chatsDir = this.getChatsDir();
    const filePath = path.join(chatsDir, `${sessionId}.jsonl`);

    try {
      // Verify the file exists and belongs to this project
      const records = await jsonl.readLines<ChatRecord>(filePath, 1);
      if (records.length === 0) {
        return false;
      }

      const recordProjectHash = getProjectHash(records[0].cwd);
      if (recordProjectHash !== this.projectHash) {
        return false;
      }

      fs.unlinkSync(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Gets the most recent session for the current project.
   *
   * @returns Session data for resumption, or null if no sessions exist
   * @deprecated Use {@link loadLastSession} instead
   */
  async getLatestSession(): Promise<ResumedSessionData | null> {
    return this.loadLastSession();
  }

  /**
   * Loads the most recent session for the current project.
   * Combines listSessions and loadSession for convenience.
   *
   * @returns Session data for resumption, or null if no sessions exist
   */
  async loadLastSession(): Promise<ResumedSessionData | null> {
    const result = await this.listSessions({ size: 1 });
    if (result.items.length === 0) {
      return null;
    }
    return this.loadSession(result.items[0].sessionId);
  }

  /**
   * Checks if a session exists by its session ID.
   *
   * @param sessionId The session ID to check
   * @returns true if session exists and belongs to current project
   */
  async sessionExists(sessionId: string): Promise<boolean> {
    const chatsDir = this.getChatsDir();
    const filePath = path.join(chatsDir, `${sessionId}.jsonl`);

    try {
      const records = await jsonl.readLines<ChatRecord>(filePath, 1);
      if (records.length === 0) {
        return false;
      }
      const recordProjectHash = getProjectHash(records[0].cwd);
      return recordProjectHash === this.projectHash;
    } catch {
      return false;
    }
  }
}
