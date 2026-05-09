/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as crypto from 'crypto';
import { getProjectHash } from '@qwen-code/qwen-code-core/src/utils/paths.js';
import { getGitBranch } from '@qwen-code/qwen-code-core/src/utils/gitUtils.js';
import { getRuntimeBaseDir } from '../utils/paths.js';
import { truncatePanelTitle } from '../webview/utils/panelTitleUtils.js';

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
  messageCount?: number;
  firstUserText?: string;
  customTitle?: string;
  cwd?: string;
}

export class QwenSessionReader {
  private get runtimeDir(): string {
    return getRuntimeBaseDir();
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
        const projectHash = getProjectHash(workingDir);
        const chatsDir = path.join(
          this.runtimeDir,
          'tmp',
          projectHash,
          'chats',
        );
        const projectSessions = await this.readSessionsFromDir(chatsDir);
        sessions.push(...projectSessions);
      } else {
        // All projects
        const tmpDir = path.join(this.runtimeDir, 'tmp');
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

    const files = fs.readdirSync(chatsDir);

    const jsonSessionFiles = files.filter(
      (f) => f.startsWith('session-') && f.endsWith('.json'),
    );

    const jsonlSessionFiles = files.filter((f) =>
      /^[0-9a-fA-F-]{32,36}\.jsonl$/.test(f),
    );

    for (const file of jsonSessionFiles) {
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

    // Support new JSONL session format produced by the CLI
    for (const file of jsonlSessionFiles) {
      const filePath = path.join(chatsDir, file);
      try {
        const session = await this.readJsonlSession(filePath, false);
        if (session) {
          sessions.push(session);
        }
      } catch (error) {
        console.error(
          '[QwenSessionReader] Failed to read JSONL session file:',
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
    const found = sessions.find((s) => s.sessionId === sessionId);

    if (!found) {
      return null;
    }

    // If the session points to a JSONL file, load full content on demand
    if (
      found.filePath &&
      found.filePath.endsWith('.jsonl') &&
      found.messages.length === 0
    ) {
      const hydrated = await this.readJsonlSession(found.filePath, true);
      if (hydrated) {
        return hydrated;
      }
    }

    return found;
  }

  /**
   * Get session title (based on first user message)
   */
  getSessionTitle(session: QwenSession): string {
    // Prefer custom title set via /rename
    if (session.customTitle) {
      return session.customTitle;
    }
    // Prefer cached prompt text to avoid loading messages for JSONL sessions
    const text = session.firstUserText
      ? session.firstUserText
      : (session.messages.find((m) => m.type === 'user')?.content ?? '');

    if (!text) {
      return 'Untitled Session';
    }

    return truncatePanelTitle(text);
  }

  /**
   * Parse a JSONL session file written by the CLI.
   * When includeMessages is false, only lightweight metadata is returned.
   */
  private async readJsonlSession(
    filePath: string,
    includeMessages: boolean,
  ): Promise<QwenSession | null> {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }

      const stats = fs.statSync(filePath);
      const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      const messages: QwenMessage[] = [];
      const seenUuids = new Set<string>();
      let sessionId: string | undefined;
      let startTime: string | undefined;
      let firstUserText: string | undefined;
      let customTitle: string | undefined;
      let cwd: string | undefined;

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (!sessionId && typeof obj.sessionId === 'string') {
          sessionId = obj.sessionId;
        }
        if (!startTime && typeof obj.timestamp === 'string') {
          startTime = obj.timestamp;
        }
        if (!cwd && typeof obj.cwd === 'string') {
          cwd = obj.cwd;
        }

        const type = typeof obj.type === 'string' ? obj.type : '';
        if (type === 'user' || type === 'assistant') {
          const uuid = typeof obj.uuid === 'string' ? obj.uuid : undefined;
          if (uuid) {
            seenUuids.add(uuid);
          }

          const text = this.contentToText(obj.message);
          if (includeMessages) {
            messages.push({
              id: uuid || `${messages.length}`,
              timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : '',
              type: type === 'user' ? 'user' : 'qwen',
              content: text,
            });
          }

          if (!firstUserText && type === 'user' && text) {
            firstUserText = text;
          }
        }

        // Extract custom title from system records (last one wins)
        if (
          type === 'system' &&
          obj.subtype === 'custom_title' &&
          typeof obj.systemPayload === 'object' &&
          obj.systemPayload !== null
        ) {
          const payload = obj.systemPayload as Record<string, unknown>;
          if (typeof payload.customTitle === 'string') {
            customTitle = payload.customTitle;
          }
        }
      }

      // Ensure stream is closed
      rl.close();

      if (!sessionId) {
        return null;
      }

      const projectHash = cwd
        ? getProjectHash(cwd)
        : path.basename(path.dirname(path.dirname(filePath)));

      return {
        sessionId,
        projectHash,
        startTime: startTime || new Date(stats.birthtimeMs).toISOString(),
        lastUpdated: new Date(stats.mtimeMs).toISOString(),
        messages: includeMessages ? messages : [],
        filePath,
        messageCount: seenUuids.size,
        firstUserText,
        customTitle,
        cwd,
      };
    } catch (error) {
      console.error(
        '[QwenSessionReader] Failed to parse JSONL session:',
        error,
      );
      return null;
    }
  }

  // Extract plain text from CLI Content structure
  private contentToText(message: unknown): string {
    try {
      if (typeof message !== 'object' || message === null) {
        return '';
      }

      const typed = message as { parts?: unknown[] };
      const parts = Array.isArray(typed.parts) ? typed.parts : [];
      const texts: string[] = [];
      for (const part of parts) {
        if (typeof part !== 'object' || part === null) {
          continue;
        }
        const p = part as Record<string, unknown>;
        if (typeof p.text === 'string') {
          texts.push(p.text);
        } else if (typeof p.data === 'string') {
          texts.push(p.data);
        }
      }
      return texts.join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Reads the UUID of the last record in a JSONL file via tail-read.
   */
  private readLastRecordUuid(filePath: string): string | null {
    try {
      const TAIL_SIZE = 64 * 1024;
      const stats = fs.statSync(filePath);
      const readStart = Math.max(0, stats.size - TAIL_SIZE);
      const readLength = Math.min(stats.size, TAIL_SIZE);

      const fd = fs.openSync(filePath, 'r');
      let buffer: Buffer;
      try {
        buffer = Buffer.alloc(readLength);
        fs.readSync(fd, buffer, 0, readLength, readStart);
      } finally {
        fs.closeSync(fd);
      }

      const lines = buffer.toString('utf-8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) {
          continue;
        }
        try {
          const record = JSON.parse(trimmed);
          if (record.uuid) {
            return record.uuid;
          }
        } catch {
          continue;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Delete session file
   */
  async deleteSession(sessionId: string, workingDir: string): Promise<boolean> {
    try {
      const session = await this.getSession(sessionId, workingDir);
      if (!session || !session.filePath) {
        return false;
      }
      // Verify the session belongs to the current project
      const expectedHash = getProjectHash(workingDir);
      if (session.projectHash && session.projectHash !== expectedHash) {
        return false;
      }
      fs.unlinkSync(session.filePath);
      return true;
    } catch (error) {
      console.error('[QwenSessionReader] Failed to delete session:', error);
      return false;
    }
  }

  /**
   * Rename session by appending a custom_title system record to the JSONL file.
   */
  async renameSession(
    sessionId: string,
    title: string,
    workingDir: string,
  ): Promise<boolean> {
    try {
      const session = await this.getSession(sessionId, workingDir);
      if (!session || !session.filePath) {
        return false;
      }
      // Verify the session belongs to the current project
      const expectedHash = getProjectHash(workingDir);
      if (session.projectHash && session.projectHash !== expectedHash) {
        return false;
      }

      // Read the last record's UUID so the custom_title record is properly
      // chained into the parent history (reconstructHistory walks from tail).
      const lastUuid = this.readLastRecordUuid(session.filePath);

      const cwd = session.cwd || workingDir;
      const record = JSON.stringify({
        uuid: crypto.randomUUID(),
        parentUuid: lastUuid,
        sessionId,
        timestamp: new Date().toISOString(),
        type: 'system',
        subtype: 'custom_title',
        cwd,
        version: 'vscode',
        gitBranch: getGitBranch(cwd),
        systemPayload: { customTitle: title },
      });

      fs.appendFileSync(session.filePath, record + '\n');
      return true;
    } catch (error) {
      console.error('[QwenSessionReader] Failed to rename session:', error);
      return false;
    }
  }
}
