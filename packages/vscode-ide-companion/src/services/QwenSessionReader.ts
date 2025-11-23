/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface QwenMessage {
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
   * 获取所有会话列表（可选：仅当前项目或所有项目）
   */
  async getAllSessions(
    workingDir?: string,
    allProjects: boolean = false,
  ): Promise<QwenSession[]> {
    try {
      const sessions: QwenSession[] = [];

      if (!allProjects && workingDir) {
        // 仅当前项目
        const projectHash = await this.getProjectHash(workingDir);
        const chatsDir = path.join(this.qwenDir, 'tmp', projectHash, 'chats');
        const projectSessions = await this.readSessionsFromDir(chatsDir);
        sessions.push(...projectSessions);
      } else {
        // 所有项目
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

      // 按最后更新时间排序
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
   * 从指定目录读取所有会话
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
   * 获取特定会话的详情
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
   * 计算项目 hash（需要与 Qwen CLI 一致）
   * Qwen CLI 使用项目路径的 SHA256 hash
   */
  private async getProjectHash(workingDir: string): Promise<string> {
    const crypto = await import('crypto');
    return crypto.createHash('sha256').update(workingDir).digest('hex');
  }

  /**
   * 获取会话的标题（基于第一条用户消息）
   */
  getSessionTitle(session: QwenSession): string {
    const firstUserMessage = session.messages.find((m) => m.type === 'user');
    if (firstUserMessage) {
      // 截取前50个字符作为标题
      return (
        firstUserMessage.content.substring(0, 50) +
        (firstUserMessage.content.length > 50 ? '...' : '')
      );
    }
    return 'Untitled Session';
  }

  /**
   * 删除会话文件
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
