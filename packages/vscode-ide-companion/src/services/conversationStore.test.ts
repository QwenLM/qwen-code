/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as atomicWriter from '@qwen-code/qwen-code-core/atomicFileWrite';
import type * as vscode from 'vscode';
import { ConversationStore, type Conversation } from './conversationStore.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

vi.mock(
  '@qwen-code/qwen-code-core/atomicFileWrite',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@qwen-code/qwen-code-core/atomicFileWrite')
    >()),
  }),
);

let directory: string;

function conversation(id = 'session-1'): Conversation {
  return {
    id,
    title: 'Conversation',
    messages: [{ role: 'user', content: 'first', timestamp: 1 }],
    createdAt: 1,
    updatedAt: 1,
  };
}

function filePath(id: string): string {
  return path.join(
    directory,
    'conversations',
    `${createHash('sha256').update(id).digest('hex')}.json`,
  );
}

function createStore(legacy?: Conversation[]) {
  const state = new Map<string, unknown>([['qwenCodeInfoMessageShown', true]]);
  if (legacy) state.set('conversations', structuredClone(legacy));
  const update = vi.fn(async (key: string, value: unknown) => {
    if (value === undefined) state.delete(key);
    else state.set(key, structuredClone(value));
  });
  const context = {
    globalStorageUri: { fsPath: directory },
    globalState: {
      get: (key: string) => structuredClone(state.get(key)),
      update,
    },
  } as unknown as vscode.ExtensionContext;
  return { store: new ConversationStore(context), context, state, update };
}

describe('ConversationStore', () => {
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-conversations-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('migrates existing records and preserves flags', async () => {
    const saved = conversation();
    const { store, context, state, update } = createStore([
      saved,
      { ...conversation('empty'), messages: [] },
    ]);

    expect(await store.getAllConversations()).toEqual(
      expect.arrayContaining([
        saved,
        { ...conversation('empty'), messages: [] },
      ]),
    );
    expect(JSON.parse(await fs.readFile(filePath(saved.id), 'utf8'))).toEqual(
      saved,
    );
    expect(update).toHaveBeenCalledExactlyOnceWith('conversations', undefined);
    expect(state.get('qwenCodeInfoMessageShown')).toBe(true);
    expect(
      await new ConversationStore(context).getConversation(saved.id),
    ).toEqual(saved);
  });

  it('retains legacy data on migration failure and retries without replacing newer files', async () => {
    const first = conversation('first');
    const second = conversation('second');
    const { store, state, update } = createStore([first, second]);
    const link = fs.link;
    const publish = vi
      .spyOn(fs, 'link')
      .mockImplementation(async (source, target) => {
        if (target === filePath('second')) throw new Error('disk full');
        return link(source, target);
      });

    await expect(store.getAllConversations()).rejects.toThrow('disk full');
    expect(state.get('conversations')).toEqual([first, second]);
    expect(update).not.toHaveBeenCalled();
    expect(
      await fs.readdir(path.join(directory, 'conversations')),
    ).toHaveLength(1);
    publish.mockRestore();

    const newer = { ...first, title: 'updated by another window' };
    await fs.writeFile(filePath('first'), JSON.stringify(newer));
    expect(await store.getAllConversations()).toEqual(
      expect.arrayContaining([newer, second]),
    );
    expect(state.has('conversations')).toBe(false);
  });

  it('keeps legacy messages when a migration destination is corrupt', async () => {
    const { store, state } = createStore([conversation()]);
    await fs.mkdir(path.join(directory, 'conversations'));
    await fs.writeFile(filePath('session-1'), '{broken');
    await expect(store.getAllConversations()).rejects.toThrow();
    expect(state.get('conversations')).toEqual([conversation()]);
  });

  it('can retry when clearing the legacy key fails', async () => {
    const { store, update, state } = createStore([conversation()]);
    const write = vi.spyOn(fs, 'writeFile');
    update.mockRejectedValueOnce(new Error('state write failed'));
    await expect(store.getConversation('session-1')).rejects.toThrow(
      'state write failed',
    );
    expect(state.has('conversations')).toBe(true);
    expect(await store.getConversation('session-1')).toEqual(conversation());
    expect(state.has('conversations')).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('preserves an empty legacy session for messages after upgrading', async () => {
    const record = { ...conversation(), messages: [] };
    const { store, context, state } = createStore([record]);
    await store.addMessage(record.id, conversation().messages[0]!);
    expect(state.has('conversations')).toBe(false);
    expect(
      await new ConversationStore(context).getConversation(record.id),
    ).toEqual(expect.objectContaining({ messages: conversation().messages }));
  });

  it('keeps only the current empty draft and persists its first message on disk', async () => {
    const { store, context, update } = createStore();
    for (let i = 0; i < 10; i++) await store.createConversation();
    const draft = await store.createConversation();
    expect(await store.getAllConversations()).toEqual([draft]);
    expect(await fs.readdir(directory)).toEqual([]);

    await store.addMessage(draft.id, {
      role: 'user',
      content: 'x'.repeat(1024 * 1024),
      timestamp: 1,
    });
    await store.addMessage(draft.id, {
      role: 'assistant',
      content: 'done',
      timestamp: 2,
    });
    expect(update).not.toHaveBeenCalled();
    const reopened = await new ConversationStore(context).getAllConversations();
    expect(reopened).toHaveLength(1);
    expect(
      reopened[0]?.messages.map((message) => message.content.length),
    ).toEqual([1024 * 1024, 4]);
  });

  it('updates only the selected conversation and serializes concurrent store mutations', async () => {
    const { store, context } = createStore();
    await store.upsertConversation(conversation('other'));
    await store.upsertConversation(conversation());
    const otherBefore = await fs.stat(filePath('other'));
    const secondStore = new ConversationStore(context);
    await Promise.all([
      store.addMessage('session-1', {
        role: 'assistant',
        content: 'reply',
        timestamp: 2,
      }),
      secondStore.addMessage('session-1', {
        role: 'user',
        content: 'next',
        timestamp: 3,
      }),
    ]);
    expect(
      (await store.getConversation('session-1'))?.messages.map(
        (message) => message.content,
      ),
    ).toEqual(['first', 'reply', 'next']);
    expect(await fs.stat(filePath('other'))).toEqual(otherBefore);
  });

  it('preserves the previous disk record and can retry after a failed atomic replacement', async () => {
    const { store } = createStore();
    await store.upsertConversation(conversation());
    const rename = vi
      .spyOn(atomicWriter, 'atomicWriteFile')
      .mockRejectedValueOnce(new Error('write failed'));
    await expect(
      store.addMessage('session-1', {
        role: 'assistant',
        content: 'reply',
        timestamp: 2,
      }),
    ).rejects.toThrow('write failed');
    rename.mockRestore();
    expect(await store.getConversation('session-1')).toEqual(conversation());
    expect(
      await fs.readdir(path.join(directory, 'conversations')),
    ).toHaveLength(1);
    await store.addMessage('session-1', {
      role: 'assistant',
      content: 'retry',
      timestamp: 3,
    });
    expect((await store.getConversation('session-1'))?.messages).toHaveLength(
      2,
    );
  });

  it('replaces messages without retaining caller references', async () => {
    const { store } = createStore([conversation()]);
    const replacement = [
      { role: 'user' as const, content: 'replacement', timestamp: 3 },
    ];
    expect(await store.replaceMessages('session-1', replacement)).toBe(true);
    replacement[0]!.content = 'mutated';
    expect(
      (await store.getConversation('session-1'))?.messages[0]?.content,
    ).toBe('replacement');
    expect(await store.replaceMessages('missing', [])).toBe(false);
  });

  it('renames a persisted ID, preserving messages and current ID', async () => {
    const { store } = createStore([conversation('draft')]);
    store.setCurrentConversationId('draft');
    expect(await store.renameConversationId('draft', 'session-1')).toBe(true);
    expect(await store.getConversation('draft')).toBeNull();
    expect((await store.getConversation('session-1'))?.messages).toEqual(
      conversation().messages,
    );
    expect(store.getCurrentConversationId()).toBe('session-1');
    expect(await store.renameConversationId('session-1', 'session-1')).toBe(
      true,
    );
    expect(await store.renameConversationId('missing', 'new')).toBe(false);
  });

  it('does not overwrite an existing rename target or remove the source on failure', async () => {
    const { store } = createStore([
      conversation('source'),
      conversation('target'),
    ]);
    store.setCurrentConversationId('source');
    expect(await store.renameConversationId('source', 'target')).toBe(false);
    const publish = vi
      .spyOn(fs, 'link')
      .mockRejectedValueOnce(new Error('disk full'));
    await expect(store.renameConversationId('source', 'new')).rejects.toThrow(
      'disk full',
    );
    publish.mockRestore();
    expect(await store.getConversation('source')).toEqual(
      conversation('source'),
    );
    expect(await store.getConversation('target')).toEqual(
      conversation('target'),
    );
    expect(store.getCurrentConversationId()).toBe('source');
  });

  it.each(['temporary', 'source'])(
    'completes an ID rename when %s file cleanup fails',
    async (failure) => {
      const { store } = createStore([conversation('source')]);
      await store.getConversation('source');
      store.setCurrentConversationId('source');
      const remove = fs.rm;
      vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
        if (
          failure === 'temporary'
            ? String(target).endsWith('.tmp')
            : target === filePath('source')
        ) {
          throw new Error('file busy');
        }
        return remove(target, options);
      });
      expect(await store.renameConversationId('source', 'target')).toBe(true);
      expect(store.getCurrentConversationId()).toBe('target');
      expect((await store.getConversation('target'))?.messages).toEqual(
        conversation().messages,
      );
      expect(await store.getConversation('source')).toEqual(
        failure === 'source' ? conversation('source') : null,
      );
    },
  );

  it('renames an empty draft without persisting it and keeps ID paths contained', async () => {
    const { store } = createStore();
    const draft = await store.createConversation();
    expect(await store.renameConversationId(draft.id, '../../escape')).toBe(
      true,
    );
    expect(await fs.readdir(directory)).toEqual([]);
    await store.addMessage('../../escape', conversation().messages[0]!);
    expect((await store.getConversation('../../escape'))?.id).toBe(
      '../../escape',
    );
    expect(await fs.readdir(path.join(directory, 'conversations'))).toEqual([
      path.basename(filePath('../../escape')),
    ]);
  });

  it('upserts and deletes persisted conversations', async () => {
    const { store, context } = createStore();
    const record = conversation();
    await store.upsertConversation(record);
    record.title = 'new title';
    record.messages = [{ role: 'assistant', content: 'new', timestamp: 2 }];
    await store.upsertConversation(record);
    record.title = 'mutated';
    expect((await store.getConversation('session-1'))?.title).toBe('new title');
    expect(await store.getAllConversations()).toHaveLength(1);
    await store.deleteConversation('session-1');
    expect(store.getCurrentConversationId()).toBeNull();
    expect(await new ConversationStore(context).getAllConversations()).toEqual(
      [],
    );
    await store.deleteConversation('missing');
  });

  it('truncates user turns and preserves an empty persisted record for first-turn rollback', async () => {
    const record = conversation();
    record.messages.push(
      { role: 'assistant', content: 'reply', timestamp: 2 },
      { role: 'user', content: 'second', timestamp: 3 },
      { role: 'assistant', content: 'second reply', timestamp: 4 },
    );
    const { store, context } = createStore([record]);
    expect(await store.truncateFromUserTurn(record.id, 1)).toBe(true);
    expect((await store.getConversation(record.id))?.messages).toEqual(
      record.messages.slice(0, 2),
    );
    expect(await store.truncateFromUserTurn(record.id, 4)).toBe(false);
    expect(await store.truncateFromUserTurn(record.id, 0)).toBe(true);
    expect(
      (await new ConversationStore(context).getConversation(record.id))
        ?.messages,
    ).toEqual([]);
    expect(await store.replaceMessages(record.id, record.messages)).toBe(true);
    expect((await store.getConversation(record.id))?.messages).toEqual(
      record.messages,
    );
    expect(await store.truncateFromUserTurn('missing', 0)).toBe(false);
  });

  it('reports corrupt JSON instead of overwriting it with empty history', async () => {
    const { store } = createStore([conversation()]);
    await store.getConversation('session-1');
    await fs.writeFile(filePath('session-1'), '{broken');
    await expect(
      store.addMessage('session-1', conversation().messages[0]!),
    ).rejects.toThrow();
    expect(await fs.readFile(filePath('session-1'), 'utf8')).toBe('{broken');
  });
});
