/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as vscode from 'vscode';
import type { ChatMessage } from './qwenAgentManager.js';

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export class ConversationStore {
  private context: vscode.ExtensionContext;
  private currentConversationId: string | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  async createConversation(title: string = 'New Chat'): Promise<Conversation> {
    const conversation: Conversation = {
      id: `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const conversations = await this.getAllConversations();
    conversations.push(conversation);
    await this.context.globalState.update('conversations', conversations);

    this.currentConversationId = conversation.id;
    return conversation;
  }

  async getAllConversations(): Promise<Conversation[]> {
    return this.context.globalState.get<Conversation[]>('conversations', []);
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const conversations = await this.getAllConversations();
    return conversations.find((c) => c.id === id) || null;
  }

  async addMessage(
    conversationId: string,
    message: ChatMessage,
  ): Promise<void> {
    const conversations = await this.getAllConversations();
    const conversation = conversations.find((c) => c.id === conversationId);

    if (conversation) {
      conversation.messages.push(message);
      conversation.updatedAt = Date.now();
      await this.context.globalState.update('conversations', conversations);
    }
  }

  async replaceMessages(
    conversationId: string,
    messages: ChatMessage[],
  ): Promise<boolean> {
    const conversations = await this.getAllConversations();
    const conversation = conversations.find((c) => c.id === conversationId);

    if (!conversation) {
      console.warn(
        '[ConversationStore] replaceMessages: conversation not found:',
        conversationId,
      );
      return false;
    }

    conversation.messages = messages.map((message) => ({ ...message }));
    conversation.updatedAt = Date.now();
    await this.context.globalState.update('conversations', conversations);
    return true;
  }

  async renameConversationId(
    fromConversationId: string,
    toConversationId: string,
  ): Promise<boolean> {
    if (fromConversationId === toConversationId) {
      return true;
    }

    const conversations = await this.getAllConversations();
    const sourceIndex = conversations.findIndex(
      (c) => c.id === fromConversationId,
    );

    if (sourceIndex < 0) {
      console.warn(
        '[ConversationStore] renameConversationId: source conversation not found:',
        fromConversationId,
      );
      return false;
    }

    if (conversations.some((c) => c.id === toConversationId)) {
      console.warn(
        '[ConversationStore] renameConversationId: target conversation already exists:',
        toConversationId,
      );
      return false;
    }

    const source = conversations[sourceIndex];
    if (!source) {
      return false;
    }

    conversations[sourceIndex] = {
      ...source,
      id: toConversationId,
      updatedAt: Date.now(),
    };

    await this.context.globalState.update('conversations', conversations);

    if (this.currentConversationId === fromConversationId) {
      this.currentConversationId = toConversationId;
    }

    return true;
  }

  async upsertConversation(conversation: Conversation): Promise<void> {
    const conversations = await this.getAllConversations();
    const storedConversation: Conversation = {
      ...conversation,
      messages: conversation.messages.map((message) => ({ ...message })),
    };
    const existingIndex = conversations.findIndex(
      (c) => c.id === conversation.id,
    );

    if (existingIndex >= 0) {
      conversations[existingIndex] = storedConversation;
    } else {
      conversations.push(storedConversation);
    }

    await this.context.globalState.update('conversations', conversations);
    this.currentConversationId = conversation.id;
  }

  async truncateFromUserTurn(
    conversationId: string,
    targetTurnIndex: number,
  ): Promise<boolean> {
    const conversations = await this.getAllConversations();
    const conversation = conversations.find((c) => c.id === conversationId);

    if (!conversation) {
      console.warn(
        '[ConversationStore] truncateFromUserTurn: conversation not found:',
        conversationId,
      );
      return false;
    }

    let userTurnIndex = 0;
    let truncateAt = -1;
    for (let i = 0; i < conversation.messages.length; i++) {
      if (conversation.messages[i]?.role !== 'user') {
        continue;
      }

      if (userTurnIndex === targetTurnIndex) {
        truncateAt = i;
        break;
      }
      userTurnIndex += 1;
    }

    if (truncateAt < 0) {
      console.warn(
        '[ConversationStore] truncateFromUserTurn: target turn not found:',
        targetTurnIndex,
      );
      return false;
    }

    conversation.messages = conversation.messages.slice(0, truncateAt);
    conversation.updatedAt = Date.now();
    await this.context.globalState.update('conversations', conversations);
    return true;
  }

  async deleteConversation(id: string): Promise<void> {
    const conversations = await this.getAllConversations();
    const filtered = conversations.filter((c) => c.id !== id);
    await this.context.globalState.update('conversations', filtered);

    if (this.currentConversationId === id) {
      this.currentConversationId = null;
    }
  }

  getCurrentConversationId(): string | null {
    return this.currentConversationId;
  }

  setCurrentConversationId(id: string): void {
    this.currentConversationId = id;
  }
}
