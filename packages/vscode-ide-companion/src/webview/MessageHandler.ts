/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QwenAgentManager } from '../services/qwenAgentManager.js';
import type { ConversationStore } from '../services/conversationStore.js';
import { MessageRouter } from './handlers/MessageRouter.js';

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
    handler: (message: { type: string; data: { optionId: string } }) => void,
  ): void {
    this.router.setPermissionHandler(handler);
  }

  /**
   * Set login handler
   */
  setLoginHandler(handler: () => Promise<void>): void {
    this.router.setLoginHandler(handler);
  }

  /**
   * Append stream content
   */
  appendStreamContent(chunk: string): void {
    this.router.appendStreamContent(chunk);
  }

  /**
   * Check if saving checkpoint
   */
  getIsSavingCheckpoint(): boolean {
    return this.router.getIsSavingCheckpoint();
  }
}
