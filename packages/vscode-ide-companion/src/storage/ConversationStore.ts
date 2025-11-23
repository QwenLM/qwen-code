/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as vscode from 'vscode';
import type { ChatMessage } from '../agents/QwenAgentManager.js';

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
