/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ConversationStore, type Conversation } from './conversationStore.js';

function createStore(initialConversations: Conversation[]) {
  let conversations = initialConversations.map((conversation) => ({
    ...conversation,
    messages: conversation.messages.map((message) => ({ ...message })),
  }));
  const update = vi.fn(
    async (_key: string, value: Conversation[] | undefined) => {
      conversations = value ?? [];
    },
  );
  const context = {
    globalState: {
      get: vi.fn(() => conversations),
      update,
    },
  } as unknown as vscode.ExtensionContext;

  return {
    store: new ConversationStore(context),
    update,
    get conversations() {
      return conversations;
    },
  };
}

describe('ConversationStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replaceMessages replaces messages with cloned entries', async () => {
    const replacement = [
      { role: 'user' as const, content: 'replacement', timestamp: 3 },
    ];
    const { store, update, conversations } = createStore([
      {
        id: 'conversation-1',
        title: 'Conversation',
        messages: [
          { role: 'user' as const, content: 'original', timestamp: 1 },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    await expect(
      store.replaceMessages('conversation-1', replacement),
    ).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith('conversations', conversations);
    expect(conversations[0]?.messages).toEqual(replacement);
    expect(conversations[0]?.messages[0]).not.toBe(replacement[0]);
  });

  it('replaceMessages returns false when the conversation is missing', async () => {
    const { store, update } = createStore([]);

    await expect(store.replaceMessages('missing', [])).resolves.toBe(false);

    expect(update).not.toHaveBeenCalled();
  });

  it('renameConversationId updates a conversation id and current id', async () => {
    const { store, update, conversations } = createStore([
      {
        id: 'conversation-1',
        title: 'Conversation',
        messages: [{ role: 'user' as const, content: 'first', timestamp: 1 }],
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    store.setCurrentConversationId('conversation-1');

    await expect(
      store.renameConversationId('conversation-1', 'session-1'),
    ).resolves.toBe(true);

    expect(conversations[0]?.id).toBe('session-1');
    expect(store.getCurrentConversationId()).toBe('session-1');
    expect(update).toHaveBeenCalledWith('conversations', conversations);
  });

  it('renameConversationId returns false when the target id already exists', async () => {
    const { store, update, conversations } = createStore([
      {
        id: 'conversation-1',
        title: 'Conversation',
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'session-1',
        title: 'Existing Session',
        messages: [],
        createdAt: 2,
        updatedAt: 2,
      },
    ]);

    await expect(
      store.renameConversationId('conversation-1', 'session-1'),
    ).resolves.toBe(false);

    expect(conversations.map((conversation) => conversation.id)).toEqual([
      'conversation-1',
      'session-1',
    ]);
    expect(update).not.toHaveBeenCalled();
  });

  it('upsertConversation inserts a missing conversation with cloned messages', async () => {
    const messages = [
      { role: 'user' as const, content: 'first', timestamp: 1 },
    ];
    const { store, update, conversations } = createStore([]);

    await store.upsertConversation({
      id: 'session-1',
      title: 'Session',
      messages,
      createdAt: 1,
      updatedAt: 1,
    });

    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.id).toBe('session-1');
    expect(conversations[0]?.messages).toEqual(messages);
    expect(conversations[0]?.messages[0]).not.toBe(messages[0]);
    expect(store.getCurrentConversationId()).toBe('session-1');
    expect(update).toHaveBeenCalledWith('conversations', conversations);
  });

  it('upsertConversation replaces an existing conversation', async () => {
    const { store, update, conversations } = createStore([
      {
        id: 'session-1',
        title: 'Old',
        messages: [{ role: 'user' as const, content: 'old', timestamp: 1 }],
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    await store.upsertConversation({
      id: 'session-1',
      title: 'New',
      messages: [{ role: 'assistant' as const, content: 'new', timestamp: 2 }],
      createdAt: 1,
      updatedAt: 2,
    });

    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toBe('New');
    expect(conversations[0]?.messages).toEqual([
      { role: 'assistant', content: 'new', timestamp: 2 },
    ]);
    expect(update).toHaveBeenCalledWith('conversations', conversations);
  });

  it('truncateFromUserTurn truncates from the matching user turn', async () => {
    const { store, update, conversations } = createStore([
      {
        id: 'conversation-1',
        title: 'Conversation',
        messages: [
          { role: 'user' as const, content: 'first', timestamp: 1 },
          { role: 'assistant' as const, content: 'reply', timestamp: 2 },
          { role: 'user' as const, content: 'second', timestamp: 3 },
          { role: 'assistant' as const, content: 'second reply', timestamp: 4 },
        ],
        createdAt: 1,
        updatedAt: 4,
      },
    ]);

    await expect(store.truncateFromUserTurn('conversation-1', 1)).resolves.toBe(
      true,
    );

    expect(conversations[0]?.messages).toEqual([
      { role: 'user', content: 'first', timestamp: 1 },
      { role: 'assistant', content: 'reply', timestamp: 2 },
    ]);
    expect(update).toHaveBeenCalledWith('conversations', conversations);
  });

  it('truncateFromUserTurn returns false when the target turn is missing', async () => {
    const { store, update, conversations } = createStore([
      {
        id: 'conversation-1',
        title: 'Conversation',
        messages: [
          { role: 'user' as const, content: 'first', timestamp: 1 },
          { role: 'assistant' as const, content: 'reply', timestamp: 2 },
        ],
        createdAt: 1,
        updatedAt: 2,
      },
    ]);

    await expect(store.truncateFromUserTurn('conversation-1', 4)).resolves.toBe(
      false,
    );

    expect(conversations[0]?.messages).toEqual([
      { role: 'user', content: 'first', timestamp: 1 },
      { role: 'assistant', content: 'reply', timestamp: 2 },
    ]);
    expect(update).not.toHaveBeenCalled();
  });
});
