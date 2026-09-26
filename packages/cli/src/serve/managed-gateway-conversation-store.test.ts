/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileManagedGatewayConversationStore } from './managed-gateway-conversation-store.js';

describe('FileManagedGatewayConversationStore', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function filePath(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-managed-history-'));
    roots.push(root);
    return path.join(root, 'conversations.jsonl');
  }

  it('restores the latest committed history and makes exact commits idempotent', async () => {
    const file = await filePath();
    const store = await FileManagedGatewayConversationStore.open(file);
    const history = [
      { role: 'user' as const, parts: [{ text: 'first prompt' }] },
      { role: 'model' as const, parts: [{ text: 'first answer' }] },
    ];

    const first = await store.commit('session-1', 'message-1', history);
    const retry = await store.commit('session-1', 'message-1', history);
    expect(retry).toEqual(first);
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o077).toBe(0);
    }

    const restored = await FileManagedGatewayConversationStore.open(file);
    expect(restored.get('session-1')).toEqual(first);
    await expect(
      restored.commit('session-1', 'message-1', [
        ...history,
        { role: 'user', parts: [{ text: 'different' }] },
      ]),
    ).rejects.toThrow('reused with different history');
  });

  it('truncates an incomplete trailing record without discarding durable history', async () => {
    const file = await filePath();
    const store = await FileManagedGatewayConversationStore.open(file);
    await store.commit('session-1', 'message-1', [
      { role: 'model', parts: [{ text: 'durable answer' }] },
    ]);
    await appendFile(file, '{"v":1,"type":"managed.gateway');

    const restored = await FileManagedGatewayConversationStore.open(file);
    expect(restored.get('session-1')?.messageId).toBe('message-1');
    expect((await readFile(file, 'utf8')).endsWith('\n')).toBe(true);
  });
});
