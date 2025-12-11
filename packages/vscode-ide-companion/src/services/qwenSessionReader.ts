/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface QwenMessage {
  id: string;
  timestamp: string;
  type: 'user' | 'qwen';
  content: string;
  thoughts?: unknown[];
  tokens?: {
    input: number;
    output: number;
    cached: number;
    thoughts: number;
    tool: number;
    total: number;
  };
  model?: string;
}

export interface QwenSession {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  messages: QwenMessage[];
  filePath?: string;
}

export class QwenSessionReader {
  private qwenDir: string;

  constructor() {
    this.qwenDir = path.join(os.homedir(), '.qwen');
  }

  /**
   * Get all session list (optional: current project only or all projects)
   */
  async getAllSessions(
    workingDir?: string,
    allProjects: boolean = false,
  ): Promise<QwenSession[]> {
    try {
      const sessions: QwenSession[] = [];

      if (!allProjects && workingDir) {
        // Current project only
        const projectHash = await this.getProjectHash(workingDir);
        const chatsDir = path.join(this.qwenDir, 'tmp', projectHash, 'chats');
        const projectSessions = await this.readSessionsFromDir(chatsDir);
        sessions.push(...projectSessions);
      } else {
        // All projects
        const tmpDir = path.join(this.qwenDir, 'tmp');
        if (!fs.existsSync(tmpDir)) {
          console.log('[QwenSessionReader] Tmp directory not found:', tmpDir);
          return [];
        }

        const projectDirs = fs.readdirSync(tmpDir);
        for (const projectHash of projectDirs) {
          const chatsDir = path.join(tmpDir, projectHash, 'chats');
          const projectSessions = await this.readSessionsFromDir(chatsDir);
          sessions.push(...projectSessions);
        }
      }

      // Sort by last updated time
      sessions.sort(
        (a, b) =>
          new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
      );

      return sessions;
    } catch (error) {
      console.error('[QwenSessionReader] Failed to get sessions:', error);
      return [];
    }
  }

  /**
   * Read all sessions from specified directory
   */
  private async readSessionsFromDir(chatsDir: string): Promise<QwenSession[]> {
    const sessions: QwenSession[] = [];

    if (!fs.existsSync(chatsDir)) {
      return sessions;
    }

    const files = fs
      .readdirSync(chatsDir)
      .filter((f) => f.startsWith('session-') && f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(chatsDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const session = JSON.parse(content) as QwenSession;
        session.filePath = filePath;
        sessions.push(session);
      } catch (error) {
        console.error(
          '[QwenSessionReader] Failed to read session file:',
          filePath,
          error,
        );
      }
    }

    return sessions;
  }

  /**
   * Get details of specific session
   */
  async getSession(
    sessionId: string,
    _workingDir?: string,
  ): Promise<QwenSession | null> {
    // First try to find in all projects
    const sessions = await this.getAllSessions(undefined, true);
    return sessions.find((s) => s.sessionId === sessionId) || null;
  }

  /**
   * Calculate project hash (needs to be consistent with Qwen CLI)
   * Qwen CLI uses SHA256 hash of project path
   */
  private async getProjectHash(workingDir: string): Promise<string> {
    const crypto = await import('crypto');
    return crypto.createHash('sha256').update(workingDir).digest('hex');
  }

  /**
   * Get session title (based on first user message)
   */
  getSessionTitle(session: QwenSession): string {
    const firstUserMessage = session.messages.find((m) => m.type === 'user');
    if (firstUserMessage) {
      // Extract first 50 characters as title
      return (
        firstUserMessage.content.substring(0, 50) +
        (firstUserMessage.content.length > 50 ? '...' : '')
      );
    }
    return 'Untitled Session';
  }

  /**
   * Delete session file
   */
  async deleteSession(
    sessionId: string,
    _workingDir: string,
  ): Promise<boolean> {
    try {
      const session = await this.getSession(sessionId, _workingDir);
      if (session && session.filePath) {
        fs.unlinkSync(session.filePath);
        return true;
      }
      return false;
    } catch (error) {
      console.error('[QwenSessionReader] Failed to delete session:', error);
      return false;
    }
  }
}
