/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { QwenSession, QwenMessage } from './qwenSessionReader.js';

/**
 * Qwen Session Manager
 *
 * This service provides direct filesystem access to save and load sessions
 * without relying on the CLI's ACP session/save method.
 */
export class QwenSessionManager {
  private qwenDir: string;

  constructor() {
    this.qwenDir = path.join(os.homedir(), '.qwen');
  }

  /**
   * Calculate project hash (same as CLI)
   * Qwen CLI uses SHA256 hash of the project path
   */
  private getProjectHash(workingDir: string): string {
    return crypto.createHash('sha256').update(workingDir).digest('hex');
  }

  /**
   * Get the session directory for a project
   */
  private getSessionDir(workingDir: string): string {
    const projectHash = this.getProjectHash(workingDir);
    return path.join(this.qwenDir, 'tmp', projectHash, 'chats');
  }

  /**
   * Generate a new session ID
   */
  private generateSessionId(): string {
    return crypto.randomUUID();
  }

  /**
   * Save current conversation as a checkpoint (matching CLI's /chat save format)
   * Creates checkpoint with BOTH conversationId and sessionId as tags for compatibility
   *
   * @param messages - Current conversation messages
   * @param conversationId - Conversation ID (from VSCode extension)
   * @param sessionId - Session ID (from CLI tmp session file, optional)
   * @param workingDir - Current working directory
   * @returns Checkpoint tag
   */
  async saveCheckpoint(
    messages: QwenMessage[],
    conversationId: string,
    workingDir: string,
    sessionId?: string,
  ): Promise<string> {
    try {
      console.log('[QwenSessionManager] ===== SAVEPOINT START =====');
      console.log('[QwenSessionManager] Conversation ID:', conversationId);
      console.log(
        '[QwenSessionManager] Session ID:',
        sessionId || 'not provided',
      );
      console.log('[QwenSessionManager] Working dir:', workingDir);
      console.log('[QwenSessionManager] Message count:', messages.length);

      // Get project directory (parent of chats directory)
      const projectHash = this.getProjectHash(workingDir);
      console.log('[QwenSessionManager] Project hash:', projectHash);

      const projectDir = path.join(this.qwenDir, 'tmp', projectHash);
      console.log('[QwenSessionManager] Project dir:', projectDir);

      if (!fs.existsSync(projectDir)) {
        console.log('[QwenSessionManager] Creating project directory...');
        fs.mkdirSync(projectDir, { recursive: true });
        console.log('[QwenSessionManager] Directory created');
      } else {
        console.log('[QwenSessionManager] Project directory already exists');
      }

      // Convert messages to checkpoint format (Gemini-style messages)
      console.log(
        '[QwenSessionManager] Converting messages to checkpoint format...',
      );
      const checkpointMessages = messages.map((msg, index) => {
        console.log(
          `[QwenSessionManager] Message ${index}: type=${msg.type}, contentLength=${msg.content?.length || 0}`,
        );
        return {
          role: msg.type === 'user' ? 'user' : 'model',
          parts: [
            {
              text: msg.content,
            },
          ],
        };
      });

      console.log(
        '[QwenSessionManager] Converted',
        checkpointMessages.length,
        'messages',
      );

      const jsonContent = JSON.stringify(checkpointMessages, null, 2);
      console.log(
        '[QwenSessionManager] JSON content length:',
        jsonContent.length,
      );

      // Save with conversationId as primary tag
      const convFilename = `checkpoint-${conversationId}.json`;
      const convFilePath = path.join(projectDir, convFilename);
      console.log(
        '[QwenSessionManager] Saving checkpoint with conversationId:',
        convFilePath,
      );
      fs.writeFileSync(convFilePath, jsonContent, 'utf-8');

      // Also save with sessionId if provided (for compatibility with CLI session/load)
      if (sessionId) {
        const sessionFilename = `checkpoint-${sessionId}.json`;
        const sessionFilePath = path.join(projectDir, sessionFilename);
        console.log(
          '[QwenSessionManager] Also saving checkpoint with sessionId:',
          sessionFilePath,
        );
        fs.writeFileSync(sessionFilePath, jsonContent, 'utf-8');
      }

      // Verify primary file exists
      if (fs.existsSync(convFilePath)) {
        const stats = fs.statSync(convFilePath);
        console.log(
          '[QwenSessionManager] Primary checkpoint verified, size:',
          stats.size,
        );
      } else {
        console.error(
          '[QwenSessionManager] ERROR: Primary checkpoint does not exist after write!',
        );
      }

      console.log('[QwenSessionManager] ===== CHECKPOINT SAVED =====');
      console.log('[QwenSessionManager] Primary path:', convFilePath);
      if (sessionId) {
        console.log(
          '[QwenSessionManager] Secondary path (sessionId):',
          path.join(projectDir, `checkpoint-${sessionId}.json`),
        );
      }
      return conversationId;
    } catch (error) {
      console.error('[QwenSessionManager] ===== CHECKPOINT SAVE FAILED =====');
      console.error('[QwenSessionManager] Error:', error);
      console.error(
        '[QwenSessionManager] Error stack:',
        error instanceof Error ? error.stack : 'N/A',
      );
      throw error;
    }
  }

  /**
   * Find checkpoint file for a given sessionId
   * Tries both checkpoint-{sessionId}.json and searches session files for matching sessionId
   *
   * @param sessionId - Session ID to find checkpoint for
   * @param workingDir - Current working directory
   * @returns Checkpoint tag if found, null otherwise
   */
  async findCheckpointTag(
    sessionId: string,
    workingDir: string,
  ): Promise<string | null> {
    try {
      const projectHash = this.getProjectHash(workingDir);
      const projectDir = path.join(this.qwenDir, 'tmp', projectHash);

      // First, try direct checkpoint with sessionId
      const directCheckpoint = path.join(
        projectDir,
        `checkpoint-${sessionId}.json`,
      );
      if (fs.existsSync(directCheckpoint)) {
        console.log(
          '[QwenSessionManager] Found direct checkpoint:',
          directCheckpoint,
        );
        return sessionId;
      }

      // Second, look for session file with this sessionId to get conversationId
      const sessionDir = path.join(projectDir, 'chats');
      if (fs.existsSync(sessionDir)) {
        const files = fs.readdirSync(sessionDir);
        for (const file of files) {
          if (file.startsWith('session-') && file.endsWith('.json')) {
            try {
              const filePath = path.join(sessionDir, file);
              const content = fs.readFileSync(filePath, 'utf-8');
              const session = JSON.parse(content) as QwenSession;

              if (session.sessionId === sessionId) {
                console.log(
                  '[QwenSessionManager] Found matching session file:',
                  file,
                );
                // Now check if there's a checkpoint with this conversationId
                // We need to store conversationId in session files or use another strategy
                // For now, return null and let it fallback
                break;
              }
            } catch {
              // Skip invalid files
            }
          }
        }
      }

      console.log(
        '[QwenSessionManager] No checkpoint found for sessionId:',
        sessionId,
      );
      return null;
    } catch (error) {
      console.error('[QwenSessionManager] Error finding checkpoint:', error);
      return null;
    }
  }

  /**
   * Load a checkpoint by tag
   *
   * @param tag - Checkpoint tag
   * @param workingDir - Current working directory
   * @returns Loaded checkpoint messages or null if not found
   */
  async loadCheckpoint(
    tag: string,
    workingDir: string,
  ): Promise<QwenMessage[] | null> {
    try {
      const projectHash = this.getProjectHash(workingDir);
      const projectDir = path.join(this.qwenDir, 'tmp', projectHash);
      const filename = `checkpoint-${tag}.json`;
      const filePath = path.join(projectDir, filename);

      if (!fs.existsSync(filePath)) {
        console.log(
          `[QwenSessionManager] Checkpoint file not found: ${filePath}`,
        );
        return null;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const checkpointMessages = JSON.parse(content) as Array<{
        role: 'user' | 'model';
        parts: Array<{ text: string }>;
      }>;

      // Convert back to QwenMessage format
      const messages: QwenMessage[] = checkpointMessages.map((msg) => ({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: msg.role === 'user' ? ('user' as const) : ('qwen' as const),
        content: msg.parts[0]?.text || '',
      }));

      console.log(`[QwenSessionManager] Checkpoint loaded: ${filePath}`);
      return messages;
    } catch (error) {
      console.error('[QwenSessionManager] Failed to load checkpoint:', error);
      return null;
    }
  }

  /**
   * Save current conversation as a named session (checkpoint-like functionality)
   *
   * @param messages - Current conversation messages
   * @param sessionName - Name/tag for the saved session
   * @param workingDir - Current working directory
   * @returns Session ID of the saved session
   */
  async saveSession(
    messages: QwenMessage[],
    sessionName: string,
    workingDir: string,
  ): Promise<string> {
    try {
      // Create session directory if it doesn't exist
      const sessionDir = this.getSessionDir(workingDir);
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      // Generate session ID and filename using CLI's naming convention
      const sessionId = this.generateSessionId();
      const shortId = sessionId.split('-')[0]; // First part of UUID (8 chars)
      const now = new Date();
      const isoDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
      const isoTime = now
        .toISOString()
        .split('T')[1]
        .split(':')
        .slice(0, 2)
        .join('-'); // HH-MM
      const filename = `session-${isoDate}T${isoTime}-${shortId}.json`;
      const filePath = path.join(sessionDir, filename);

      // Create session object
      const session: QwenSession = {
        sessionId,
        projectHash: this.getProjectHash(workingDir),
        startTime: messages[0]?.timestamp || new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        messages,
      };

      // Save session to file
      fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');

      console.log(`[QwenSessionManager] Session saved: ${filePath}`);
      return sessionId;
    } catch (error) {
      console.error('[QwenSessionManager] Failed to save session:', error);
      throw error;
    }
  }

  /**
   * Load a saved session by name
   *
   * @param sessionName - Name/tag of the session to load
   * @param workingDir - Current working directory
   * @returns Loaded session or null if not found
   */
  async loadSession(
    sessionId: string,
    workingDir: string,
  ): Promise<QwenSession | null> {
    try {
      const sessionDir = this.getSessionDir(workingDir);
      const filename = `session-${sessionId}.json`;
      const filePath = path.join(sessionDir, filename);

      if (!fs.existsSync(filePath)) {
        console.log(`[QwenSessionManager] Session file not found: ${filePath}`);
        return null;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const session = JSON.parse(content) as QwenSession;

      console.log(`[QwenSessionManager] Session loaded: ${filePath}`);
      return session;
    } catch (error) {
      console.error('[QwenSessionManager] Failed to load session:', error);
      return null;
    }
  }

  /**
   * List all saved sessions
   *
   * @param workingDir - Current working directory
   * @returns Array of session objects
   */
  async listSessions(workingDir: string): Promise<QwenSession[]> {
    try {
      const sessionDir = this.getSessionDir(workingDir);

      if (!fs.existsSync(sessionDir)) {
        return [];
      }

      const files = fs
        .readdirSync(sessionDir)
        .filter(
          (file) => file.startsWith('session-') && file.endsWith('.json'),
        );

      const sessions: QwenSession[] = [];
      for (const file of files) {
        try {
          const filePath = path.join(sessionDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const session = JSON.parse(content) as QwenSession;
          sessions.push(session);
        } catch (error) {
          console.error(
            `[QwenSessionManager] Failed to read session file ${file}:`,
            error,
          );
        }
      }

      // Sort by last updated time (newest first)
      sessions.sort(
        (a, b) =>
          new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
      );

      return sessions;
    } catch (error) {
      console.error('[QwenSessionManager] Failed to list sessions:', error);
      return [];
    }
  }

  /**
   * Delete a saved session
   *
   * @param sessionId - ID of the session to delete
   * @param workingDir - Current working directory
   * @returns True if deleted successfully, false otherwise
   */
  async deleteSession(sessionId: string, workingDir: string): Promise<boolean> {
    try {
      const sessionDir = this.getSessionDir(workingDir);
      const filename = `session-${sessionId}.json`;
      const filePath = path.join(sessionDir, filename);

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[QwenSessionManager] Session deleted: ${filePath}`);
        return true;
      }

      return false;
    } catch (error) {
      console.error('[QwenSessionManager] Failed to delete session:', error);
      return false;
    }
  }
}
