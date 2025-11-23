/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { AcpConnection } from '../acp/AcpConnection.js';
import type {
  AcpSessionUpdate,
  AcpPermissionRequest,
} from '../shared/acpTypes.js';
import {
  QwenSessionReader,
  type QwenSession,
} from '../services/QwenSessionReader.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export class QwenAgentManager {
  private connection: AcpConnection;
  private sessionReader: QwenSessionReader;
  private onMessageCallback?: (message: ChatMessage) => void;
  private onStreamChunkCallback?: (chunk: string) => void;
  private onPermissionRequestCallback?: (
    request: AcpPermissionRequest,
  ) => Promise<string>;
  private currentWorkingDir: string = process.cwd();

  constructor() {
    this.connection = new AcpConnection();
    this.sessionReader = new QwenSessionReader();

    // Setup session update handler
    this.connection.onSessionUpdate = (data: AcpSessionUpdate) => {
      this.handleSessionUpdate(data);
    };

    // Setup permission request handler
    this.connection.onPermissionRequest = async (
      data: AcpPermissionRequest,
    ) => {
      if (this.onPermissionRequestCallback) {
        const optionId = await this.onPermissionRequestCallback(data);
        return { optionId };
      }
      return { optionId: 'allow_once' };
    };

    // Setup end turn handler
    this.connection.onEndTurn = () => {
      // Notify UI that response is complete
    };
  }

  async connect(workingDir: string): Promise<void> {
    this.currentWorkingDir = workingDir;
    const config = vscode.workspace.getConfiguration('qwenCode');
    const cliPath = config.get<string>('qwen.cliPath', 'qwen');
    const openaiApiKey = config.get<string>('qwen.openaiApiKey', '');
    const openaiBaseUrl = config.get<string>('qwen.openaiBaseUrl', '');
    const model = config.get<string>('qwen.model', '');
    const proxy = config.get<string>('qwen.proxy', '');

    // Build additional CLI arguments
    const extraArgs: string[] = [];
    if (openaiApiKey) {
      extraArgs.push('--openai-api-key', openaiApiKey);
    }
    if (openaiBaseUrl) {
      extraArgs.push('--openai-base-url', openaiBaseUrl);
    }
    if (model) {
      extraArgs.push('--model', model);
    }
    if (proxy) {
      extraArgs.push('--proxy', proxy);
      console.log('[QwenAgentManager] Using proxy:', proxy);
    }

    await this.connection.connect('qwen', cliPath, workingDir, extraArgs);

    // Determine auth method based on configuration
    const authMethod = openaiApiKey ? 'openai' : 'qwen-oauth';

    // Since session/list is not supported, try to get sessions from local files
    console.log('[QwenAgentManager] Reading local session files...');
    try {
      const sessions = await this.sessionReader.getAllSessions(workingDir);

      if (sessions.length > 0) {
        // Use the most recent session
        console.log(
          '[QwenAgentManager] Found existing sessions:',
          sessions.length,
        );
        const lastSession = sessions[0]; // Already sorted by lastUpdated

        // Try to switch to it (this may fail if not supported)
        try {
          await this.connection.switchSession(lastSession.sessionId);
          console.log(
            '[QwenAgentManager] Restored session:',
            lastSession.sessionId,
          );
        } catch (_switchError) {
          console.log(
            '[QwenAgentManager] session/switch not supported, creating new session',
          );
          await this.connection.authenticate(authMethod);
          await this.connection.newSession(workingDir);
        }
      } else {
        // No sessions, authenticate and create a new one
        console.log(
          '[QwenAgentManager] No existing sessions, creating new session',
        );
        await this.connection.authenticate(authMethod);
        await this.connection.newSession(workingDir);
      }
    } catch (error) {
      // If reading local sessions fails, fall back to creating new session
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.log(
        '[QwenAgentManager] Failed to read local sessions, creating new session:',
        errorMessage,
      );
      await this.connection.authenticate(authMethod);
      await this.connection.newSession(workingDir);
    }
  }

  async sendMessage(message: string): Promise<void> {
    await this.connection.sendPrompt(message);
  }

  async getSessionList(): Promise<Array<Record<string, unknown>>> {
    try {
      // Read from local session files instead of ACP protocol
      // Get all sessions from all projects
      const sessions = await this.sessionReader.getAllSessions(undefined, true);
      console.log(
        '[QwenAgentManager] Session list from files (all projects):',
        sessions.length,
      );

      // Transform to UI-friendly format
      return sessions.map(
        (session: QwenSession): Record<string, unknown> => ({
          id: session.sessionId,
          sessionId: session.sessionId,
          title: this.sessionReader.getSessionTitle(session),
          name: this.sessionReader.getSessionTitle(session),
          startTime: session.startTime,
          lastUpdated: session.lastUpdated,
          messageCount: session.messages.length,
          projectHash: session.projectHash,
        }),
      );
    } catch (error) {
      console.error('[QwenAgentManager] Failed to get session list:', error);
      return [];
    }
  }

  async getSessionMessages(sessionId: string): Promise<ChatMessage[]> {
    try {
      const session = await this.sessionReader.getSession(
        sessionId,
        this.currentWorkingDir,
      );
      if (!session) {
        return [];
      }

      // Convert Qwen messages to ChatMessage format
      return session.messages.map(
        (msg: { type: string; content: string; timestamp: string }) => ({
          role:
            msg.type === 'user' ? ('user' as const) : ('assistant' as const),
          content: msg.content,
          timestamp: new Date(msg.timestamp).getTime(),
        }),
      );
    } catch (error) {
      console.error(
        '[QwenAgentManager] Failed to get session messages:',
        error,
      );
      return [];
    }
  }

  async createNewSession(workingDir: string): Promise<void> {
    console.log('[QwenAgentManager] Creating new session...');
    await this.connection.newSession(workingDir);
  }

  async switchToSession(sessionId: string): Promise<void> {
    await this.connection.switchSession(sessionId);
  }

  private handleSessionUpdate(data: AcpSessionUpdate): void {
    const update = data.update;

    if (update.sessionUpdate === 'agent_message_chunk') {
      if (update.content?.text && this.onStreamChunkCallback) {
        this.onStreamChunkCallback(update.content.text);
      }
    } else if (update.sessionUpdate === 'tool_call') {
      // Handle tool call updates
      const toolCall = update as { title?: string; status?: string };
      const title = toolCall.title || 'Tool Call';
      const status = toolCall.status || 'pending';

      if (this.onStreamChunkCallback) {
        this.onStreamChunkCallback(`\n🔧 ${title} [${status}]\n`);
      }
    }
  }

  onMessage(callback: (message: ChatMessage) => void): void {
    this.onMessageCallback = callback;
  }

  onStreamChunk(callback: (chunk: string) => void): void {
    this.onStreamChunkCallback = callback;
  }

  onPermissionRequest(
    callback: (request: AcpPermissionRequest) => Promise<string>,
  ): void {
    this.onPermissionRequestCallback = callback;
  }

  disconnect(): void {
    this.connection.disconnect();
  }

  get isConnected(): boolean {
    return this.connection.isConnected;
  }
}
