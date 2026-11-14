/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWriteFile } from '@qwen-code/qwen-code-core/atomicFileWrite';
import { logger } from '../utils/logger.js';
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
  // Providers in the same extension host can update the same conversation.
  private static pending: Promise<void> = Promise.resolve();
  private currentConversationId: string | null = null;
  private draft: Conversation | null = null;
  private readonly directory: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.directory = path.join(
      context.globalStorageUri.fsPath,
      'conversations',
    );
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = ConversationStore.pending.then(async () => {
      await this.migrate();
      return operation();
    });
    ConversationStore.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private filePath(id: string): string {
    return path.join(
      this.directory,
      `${createHash('sha256').update(id).digest('hex')}.json`,
    );
  }

  private async migrate(): Promise<void> {
    const legacy =
      this.context.globalState.get<Conversation[]>('conversations');
    if (!legacy) return;
    for (const conversation of legacy) {
      await this.writeConversation(conversation, false);
    }
    await this.context.globalState.update('conversations', undefined);
  }

  private async readConversation(id: string): Promise<Conversation | null> {
    if (this.draft?.id === id) return structuredClone(this.draft);
    try {
      return JSON.parse(await fs.readFile(this.filePath(id), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async writeConversation(
    conversation: Conversation,
    overwrite = true,
  ): Promise<boolean> {
    await fs.mkdir(this.directory, { recursive: true });
    const destination = this.filePath(conversation.id);
    if (overwrite) {
      await atomicWriteFile(destination, JSON.stringify(conversation), {
        mode: 0o600,
        noFollow: true,
      });
      return true;
    }
    const existing = await this.readConversation(conversation.id);
    if (existing) {
      if (existing.id !== conversation.id) {
        throw new Error('Conversation storage ID mismatch');
      }
      return false;
    }
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(conversation), {
        flag: 'wx',
        mode: 0o600,
        flush: true,
      });
      // Publish a complete record without clobbering a concurrent migration.
      try {
        await fs.link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          const existing: Conversation = JSON.parse(
            await fs.readFile(destination, 'utf8'),
          );
          if (existing.id !== conversation.id) {
            throw new Error('Conversation storage ID mismatch');
          }
          return false;
        }
        throw error;
      }
      return true;
    } finally {
      await this.removeObsoleteFile(temporary);
    }
  }

  private async removeObsoleteFile(file: string): Promise<void> {
    await fs.rm(file, { force: true }).catch((error: unknown) => {
      logger.warn('[ConversationStore] Failed to remove obsolete file:', error);
    });
  }

  private async saveConversation(conversation: Conversation): Promise<void> {
    if (this.draft?.id === conversation.id && !conversation.messages.length) {
      this.draft = structuredClone(conversation);
      return;
    }
    await this.writeConversation(conversation);
    if (this.draft?.id === conversation.id) this.draft = null;
  }

  async createConversation(title: string = 'New Chat'): Promise<Conversation> {
    return this.run(async () => {
      const conversation: Conversation = {
        id: `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        title,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.draft = conversation;
      this.currentConversationId = conversation.id;
      return structuredClone(conversation);
    });
  }

  async getAllConversations(): Promise<Conversation[]> {
    return this.run(async () => {
      let files: string[];
      try {
        files = await fs.readdir(this.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        files = [];
      }
      const conversations: Conversation[] = [];
      for (const file of files.filter((name) => name.endsWith('.json'))) {
        conversations.push(
          JSON.parse(
            await fs.readFile(path.join(this.directory, file), 'utf8'),
          ),
        );
      }
      if (this.draft) conversations.push(structuredClone(this.draft));
      return conversations;
    });
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.run(() => this.readConversation(id));
  }

  async addMessage(
    conversationId: string,
    message: ChatMessage,
  ): Promise<void> {
    return this.run(async () => {
      const conversation = await this.readConversation(conversationId);
      if (conversation) {
        conversation.messages.push(message);
        conversation.updatedAt = Date.now();
        await this.saveConversation(conversation);
      }
    });
  }

  async replaceMessages(
    conversationId: string,
    messages: ChatMessage[],
  ): Promise<boolean> {
    return this.run(async () => {
      const conversation = await this.readConversation(conversationId);
      if (!conversation) {
        logger.warn(
          '[ConversationStore] replaceMessages: conversation not found:',
          conversationId,
        );
        return false;
      }
      conversation.messages = messages.map((message) => ({ ...message }));
      conversation.updatedAt = Date.now();
      await this.saveConversation(conversation);
      return true;
    });
  }

  async renameConversationId(
    fromConversationId: string,
    toConversationId: string,
  ): Promise<boolean> {
    return this.run(async () => {
      if (fromConversationId === toConversationId) return true;
      const source = await this.readConversation(fromConversationId);
      if (!source) {
        logger.warn(
          '[ConversationStore] renameConversationId: source conversation not found:',
          fromConversationId,
        );
        return false;
      }
      if (await this.readConversation(toConversationId)) {
        logger.warn(
          '[ConversationStore] renameConversationId: target conversation already exists:',
          toConversationId,
        );
        return false;
      }
      const renamed = {
        ...source,
        id: toConversationId,
        updatedAt: Date.now(),
      };
      if (this.draft?.id === fromConversationId) {
        this.draft = renamed;
      } else {
        if (!(await this.writeConversation(renamed, false))) return false;
        await this.removeObsoleteFile(this.filePath(fromConversationId));
      }
      if (this.currentConversationId === fromConversationId) {
        this.currentConversationId = toConversationId;
      }
      return true;
    });
  }

  async upsertConversation(conversation: Conversation): Promise<void> {
    return this.run(async () => {
      await this.saveConversation(conversation);
      this.currentConversationId = conversation.id;
    });
  }

  async truncateFromUserTurn(
    conversationId: string,
    targetTurnIndex: number,
  ): Promise<boolean> {
    return this.run(async () => {
      const conversation = await this.readConversation(conversationId);
      if (!conversation) {
        logger.warn(
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
        logger.warn(
          '[ConversationStore] truncateFromUserTurn: target turn not found:',
          targetTurnIndex,
        );
        return false;
      }
      conversation.messages = conversation.messages.slice(0, truncateAt);
      conversation.updatedAt = Date.now();
      await this.saveConversation(conversation);
      return true;
    });
  }

  async deleteConversation(id: string): Promise<void> {
    return this.run(async () => {
      await fs.rm(this.filePath(id), { force: true });
      if (this.draft?.id === id) this.draft = null;
      if (this.currentConversationId === id) this.currentConversationId = null;
    });
  }

  getCurrentConversationId(): string | null {
    return this.currentConversationId;
  }

  setCurrentConversationId(id: string): void {
    this.currentConversationId = id;
  }
}
