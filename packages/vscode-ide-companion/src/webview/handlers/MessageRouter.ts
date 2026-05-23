/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as vscode from 'vscode';
import type { IMessageHandler } from './BaseMessageHandler.js';
import type { QwenAgentManager } from '../../services/qwenAgentManager.js';
import type { ConversationStore } from '../../services/conversationStore.js';
import type {
  PermissionResponseMessage,
  AskUserQuestionResponseMessage,
} from '../../types/webviewMessageTypes.js';
import { SessionMessageHandler } from './SessionMessageHandler.js';
import { FileMessageHandler } from './FileMessageHandler.js';
import { EditorMessageHandler } from './EditorMessageHandler.js';
import { AuthMessageHandler } from './AuthMessageHandler.js';

/**
 * Message Router
 * Routes messages to appropriate handlers
 */
export class MessageRouter {
  private handlers: IMessageHandler[] = [];
  private sessionHandler: SessionMessageHandler;
  private authHandler: AuthMessageHandler;
  private fileHandler: FileMessageHandler;
  private currentConversationId: string | null = null;
  private permissionHandler:
    | ((message: PermissionResponseMessage) => void)
    | null = null;
  private askUserQuestionHandler:
    | ((message: AskUserQuestionResponseMessage) => void)
    | null = null;

  constructor(
    agentManager: QwenAgentManager,
    conversationStore: ConversationStore,
    currentConversationId: string | null,
    sendToWebView: (message: unknown) => void,
  ) {
    this.currentConversationId = currentConversationId;

    // Initialize all handlers
    this.sessionHandler = new SessionMessageHandler(
      agentManager,
      conversationStore,
      currentConversationId,
      sendToWebView,
      (id) => this.setCurrentConversationId(id),
    );

    this.fileHandler = new FileMessageHandler(
      agentManager,
      conversationStore,
      currentConversationId,
      sendToWebView,
    );

    const editorHandler = new EditorMessageHandler(
      agentManager,
      conversationStore,
      currentConversationId,
      sendToWebView,
    );

    this.authHandler = new AuthMessageHandler(
      agentManager,
      conversationStore,
      currentConversationId,
      sendToWebView,
    );

    // Register handlers in order of priority
    this.handlers = [
      this.sessionHandler,
      this.fileHandler,
      editorHandler,
      this.authHandler,
    ];
  }

  setupFileWatchers(): vscode.Disposable {
    return this.fileHandler.setupFileWatchers();
  }

  /**
   * Route message to appropriate handler
   */
  async route(message: { type: string; data?: unknown }): Promise<void> {
    console.log('[MessageRouter] Routing message:', message.type);

    // Handle permission response specially
    if (message.type === 'permissionResponse') {
      if (this.permissionHandler) {
        this.permissionHandler(message as PermissionResponseMessage);
      }
      return;
    }

    // Handle ask user question response specially
    if (message.type === 'askUserQuestionResponse') {
      if (this.askUserQuestionHandler) {
        this.askUserQuestionHandler(message as AskUserQuestionResponseMessage);
      }
      return;
    }

    // Find appropriate handler
    const handler = this.handlers.find((h) => h.canHandle(message.type));

    if (handler) {
      try {
        await handler.handle(message);
      } catch (error) {
        console.error('[MessageRouter] Handler error:', error);
        throw error;
      }
    } else {
      console.warn(
        '[MessageRouter] No handler found for message type:',
        message.type,
      );
    }
  }

  /**
   * Set current conversation ID
   */
  setCurrentConversationId(id: string | null): void {
    this.currentConversationId = id;
    // Update all handlers
    this.handlers.forEach((handler) => {
      if ('setCurrentConversationId' in handler) {
        (
          handler as { setCurrentConversationId: (id: string | null) => void }
        ).setCurrentConversationId(id);
      }
    });
  }

  /**
   * Get current conversation ID
   */
  getCurrentConversationId(): string | null {
    return this.currentConversationId;
  }

  /**
   * Set permission handler
   */
  setPermissionHandler(
    handler: (message: PermissionResponseMessage) => void,
  ): void {
    this.permissionHandler = handler;
  }

  /**
   * Set ask user question handler
   */
  setAskUserQuestionHandler(
    handler: (message: AskUserQuestionResponseMessage) => void,
  ): void {
    this.askUserQuestionHandler = handler;
  }

  /**
   * Set auth interactive handler — interactive auth flow.
   * Also registers the handler on the session handler so
   * "Configure" prompts in session flows trigger the interactive flow.
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
    this.authHandler.setAuthInteractiveHandler(handler);
    // SessionMessageHandler's authHandler is a simple () => Promise<void>.
    // Wrap so "Configure" prompts trigger the full interactive auth QuickPick.
    this.sessionHandler?.setAuthHandler?.(() =>
      this.authHandler.handle({ type: 'auth' }),
    );
  }

  /**
   * Append stream content
   */
  appendStreamContent(chunk: string): void {
    this.sessionHandler.appendStreamContent(chunk);
  }
}
