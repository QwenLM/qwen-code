/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as vscode from 'vscode';
import type { QwenAgentManager } from '../../services/qwenAgentManager.js';
import type { ConversationStore } from '../../services/conversationStore.js';
import type {
  PermissionResponseMessage,
  AskUserQuestionResponseMessage,
} from '../../types/webviewMessageTypes.js';
import { MessageRouter } from '../handlers/MessageRouter.js';

/**
 * MessageHandler (Refactored Version)
 * This is a lightweight wrapper class that internally uses MessageRouter and various sub-handlers
 * Maintains interface compatibility with the original code
 */
export class MessageHandler {
  private router: MessageRouter;

  constructor(
    agentManager: QwenAgentManager,
    conversationStore: ConversationStore,
    currentConversationId: string | null,
    sendToWebView: (message: unknown) => void,
  ) {
    this.router = new MessageRouter(
      agentManager,
      conversationStore,
      currentConversationId,
      sendToWebView,
    );
  }

  /**
   * Route messages to the corresponding handler
   */
  async route(message: { type: string; data?: unknown }): Promise<void> {
    await this.router.route(message);
  }

  /**
   * Set current session ID
   */
  setCurrentConversationId(id: string | null): void {
    this.router.setCurrentConversationId(id);
  }

  /**
   * Get current session ID
   */
  getCurrentConversationId(): string | null {
    return this.router.getCurrentConversationId();
  }

  /**
   * Set permission handler
   */
  setPermissionHandler(
    handler: (message: PermissionResponseMessage) => void,
  ): void {
    this.router.setPermissionHandler(handler);
  }

  /**
   * Set ask user question handler
   */
  setAskUserQuestionHandler(
    handler: (message: AskUserQuestionResponseMessage) => void,
  ): void {
    this.router.setAskUserQuestionHandler(handler);
  }

  /**
   * Set auth interactive handler — interactive auth flow.
   */
  setAuthInteractiveHandler(
    handler: (
      provider: string,
      region?: string,
      apiKey?: string,
      baseUrl?: string,
      model?: string,
      modelIds?: string,
    ) => Promise<void>,
  ): void {
    this.router.setAuthInteractiveHandler(handler);
  }

  /**
   * Set connect-with-settings handler.
   * Reads VSCode settings, writes to ~/.qwen/settings.json, and reconnects.
   */
  setConnectWithSettingsHandler(handler: () => Promise<void>): void {
    this.router.setConnectWithSettingsHandler(handler);
  }

  /**
   * Append stream content
   */
  appendStreamContent(chunk: string): void {
    this.router.appendStreamContent(chunk);
  }

  setupFileWatchers(): vscode.Disposable {
    return this.router.setupFileWatchers();
  }
}
