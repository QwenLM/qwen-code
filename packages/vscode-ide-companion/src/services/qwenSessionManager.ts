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
 *
 * Note: This is primarily used as a fallback mechanism when ACP methods are
 * unavailable or fail. In normal operation, ACP session/list and session/load
 * should be preferred for consistency with the CLI.
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
   * Save current conversation as a named session
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
