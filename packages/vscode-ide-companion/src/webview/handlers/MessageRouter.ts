/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageHandler } from './BaseMessageHandler.js';
import type { QwenAgentManager } from '../../services/qwenAgentManager.js';
import type { ConversationStore } from '../../services/conversationStore.js';
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
  private currentConversationId: string | null = null;
  private permissionHandler:
    | ((message: { type: string; data: { optionId: string } }) => void)
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
    );

    const fileHandler = new FileMessageHandler(
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
      fileHandler,
      editorHandler,
      this.authHandler,
    ];
  }

  /**
   * Route message to appropriate handler
   */
  async route(message: { type: string; data?: unknown }): Promise<void> {
    console.log('[MessageRouter] Routing message:', message.type);

    // Handle permission response specially
    if (message.type === 'permissionResponse') {
      if (this.permissionHandler) {
        this.permissionHandler(
          message as { type: string; data: { optionId: string } },
        );
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
    handler: (message: { type: string; data: { optionId: string } }) => void,
  ): void {
    this.permissionHandler = handler;
  }

  /**
   * Set login handler
   */
  setLoginHandler(handler: () => Promise<void>): void {
    this.authHandler.setLoginHandler(handler);
    this.sessionHandler?.setLoginHandler?.(handler);
  }

  /**
   * Append stream content
   */
  appendStreamContent(chunk: string): void {
    this.sessionHandler.appendStreamContent(chunk);
  }
}
