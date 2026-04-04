/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MailboxMessage } from './mailbox.js';
import {
  getInboxPath,
  readInbox,
  writeMessage,
  consumeUnread,
  consumeUnreadByType,
  clearInbox,
  clearAllInboxes,
  sendStructuredMessage,
} from './mailbox.js';

vi.mock('../../config/storage.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../config/storage.js')>();
  let mockGlobalDir = '';
  return {
    ...original,
    Storage: {
      ...original.Storage,
      getGlobalQwenDir: () => mockGlobalDir,
      __setMockGlobalDir: (dir: string) => {
        mockGlobalDir = dir;
      },
    },
  };
});

import { Storage } from '../../config/storage.js';

function setMockDir(dir: string): void {
  (
    Storage as unknown as {
      __setMockGlobalDir: (d: string) => void;
    }
  ).__setMockGlobalDir(dir);
}

function makeMessage(overrides?: Partial<MailboxMessage>): MailboxMessage {
  return {
    from: 'leader',
    text: 'hello',
    timestamp: new Date().toISOString(),
    read: false,
    ...overrides,
  };
}

describe('mailbox', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-test-'));
    setMockDir(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── getInboxPath ──────────────────────────────────────────

  it('returns correct inbox path', () => {
    const p = getInboxPath('my-team', 'worker');
    expect(p).toBe(
      path.join(tmpDir, 'teams', 'my-team', 'inboxes', 'worker.json'),
    );
  });

  // ─── readInbox ─────────────────────────────────────────────

  it('returns empty array for nonexistent inbox', async () => {
    const messages = await readInbox('team', 'nobody');
    expect(messages).toEqual([]);
  });

  // ─── writeMessage + readInbox ──────────────────────────────

  it('writes and reads a message', async () => {
    const msg = makeMessage({ text: 'task assigned' });
    await writeMessage('team', 'worker', msg);

    const messages = await readInbox('team', 'worker');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe('task assigned');
    expect(messages[0]!.read).toBe(false);
  });

  it('appends multiple messages', async () => {
    await writeMessage('team', 'worker', makeMessage({ text: 'first' }));
    await writeMessage('team', 'worker', makeMessage({ text: 'second' }));

    const messages = await readInbox('team', 'worker');
    expect(messages).toHaveLength(2);
    expect(messages[0]!.text).toBe('first');
    expect(messages[1]!.text).toBe('second');
  });

  // ─── consumeUnread ─────────────────────────────────────────

  it('returns unread messages and marks them read', async () => {
    await writeMessage('team', 'worker', makeMessage({ text: 'a' }));
    await writeMessage('team', 'worker', makeMessage({ text: 'b' }));

    const unread = await consumeUnread('team', 'worker');
    expect(unread).toHaveLength(2);
    expect(unread[0]!.text).toBe('a');

    // All should now be read
    const remaining = await readInbox('team', 'worker');
    expect(remaining.every((m) => m.read)).toBe(true);
  });

  it('returns empty when all messages already read', async () => {
    await writeMessage('team', 'worker', makeMessage({ read: true }));
    const unread = await consumeUnread('team', 'worker');
    expect(unread).toEqual([]);
  });

  it('returns empty for nonexistent inbox', async () => {
    // Ensure the inbox directory exists so ensureInboxFile
    // can create the file.
    const unread = await consumeUnread('team', 'nobody');
    expect(unread).toEqual([]);
  });

  // ─── consumeUnreadByType ───────────────────────────────────

  it('only consumes messages of matching type', async () => {
    await writeMessage(
      'team',
      'worker',
      makeMessage({
        text: 'shutdown',
        type: 'shutdown_request',
      }),
    );
    await writeMessage(
      'team',
      'worker',
      makeMessage({ text: 'task', type: 'task_assignment' }),
    );

    const shutdowns = await consumeUnreadByType(
      'team',
      'worker',
      'shutdown_request',
    );
    expect(shutdowns).toHaveLength(1);
    expect(shutdowns[0]!.text).toBe('shutdown');

    // The task_assignment should still be unread
    const remaining = await readInbox('team', 'worker');
    const unreadRemaining = remaining.filter((m) => !m.read);
    expect(unreadRemaining).toHaveLength(1);
    expect(unreadRemaining[0]!.type).toBe('task_assignment');
  });

  // ─── clearInbox ────────────────────────────────────────────

  it('clears an inbox', async () => {
    await writeMessage('team', 'worker', makeMessage());
    await clearInbox('team', 'worker');

    const messages = await readInbox('team', 'worker');
    expect(messages).toEqual([]);
  });

  it('does not throw when clearing nonexistent inbox', async () => {
    await expect(clearInbox('team', 'nobody')).resolves.not.toThrow();
  });

  // ─── clearAllInboxes ───────────────────────────────────────

  it('clears all inboxes for a team', async () => {
    await writeMessage('team', 'w1', makeMessage());
    await writeMessage('team', 'w2', makeMessage());

    await clearAllInboxes('team');

    expect(await readInbox('team', 'w1')).toEqual([]);
    expect(await readInbox('team', 'w2')).toEqual([]);
  });

  // ─── sendStructuredMessage ─────────────────────────────────

  it('sends a structured message with type', async () => {
    await sendStructuredMessage('team', 'worker', {
      from: 'leader',
      type: 'shutdown_request',
      text: 'please shut down',
      color: '#FF0000',
      summary: 'shutdown requested',
    });

    const messages = await readInbox('team', 'worker');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe('shutdown_request');
    expect(messages[0]!.color).toBe('#FF0000');
    expect(messages[0]!.summary).toBe('shutdown requested');
    expect(messages[0]!.read).toBe(false);
    expect(messages[0]!.timestamp).toBeDefined();
  });

  // ─── Concurrent writes ────────────────────────────────────

  it('handles concurrent writes without corruption', async () => {
    const count = 10;
    const promises = Array.from({ length: count }, (_, i) =>
      writeMessage('team', 'worker', makeMessage({ text: `msg-${i}` })),
    );
    await Promise.all(promises);

    const messages = await readInbox('team', 'worker');
    expect(messages).toHaveLength(count);
    // All messages should be present (order may vary).
    const texts = messages.map((m) => m.text).sort();
    const expected = Array.from({ length: count }, (_, i) => `msg-${i}`).sort();
    expect(texts).toEqual(expected);
  });
});
