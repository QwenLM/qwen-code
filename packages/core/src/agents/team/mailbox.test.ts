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

  // ─── consumeUnread (type filter) ───────────────────────────

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

    const shutdowns = await consumeUnread('team', 'worker', 'shutdown_request');
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

  // ─── Corrupt inbox handling ────────────────────────────────

  it('writeMessage quarantines a corrupt inbox and keeps delivering', async () => {
    // A corrupt inbox used to fail every subsequent writeMessage /
    // consumeUnread on the same file — the teammate could never
    // receive another message, including shutdown requests. The fix
    // mirrors the leader path: the corrupt file is renamed to
    // `.corrupt-{ts}` (preserved for forensics, never clobbered)
    // and delivery continues on a fresh inbox.
    await writeMessage('team', 'worker', makeMessage({ text: 'preserved-1' }));

    // Truncate the file mid-array to simulate a kill during write.
    const inboxPath = getInboxPath('team', 'worker');
    await fs.writeFile(inboxPath, '[ {"from":"leader","te', 'utf-8');

    await writeMessage('team', 'worker', makeMessage({ text: 'new' }));

    // The corrupt content survives in the quarantine file.
    const dir = path.dirname(inboxPath);
    const entries = await fs.readdir(dir);
    const quarantined = entries.find((e) =>
      e.startsWith('worker.json.corrupt-'),
    );
    expect(quarantined).toBeDefined();
    const raw = await fs.readFile(path.join(dir, quarantined!), 'utf-8');
    expect(raw).toBe('[ {"from":"leader","te');

    // The fresh inbox carries the new message and stays usable.
    const messages = await readInbox('team', 'worker');
    expect(messages.map((m) => m.text)).toEqual(['new']);
    const consumed = await consumeUnread('team', 'worker');
    expect(consumed.map((m) => m.text)).toEqual(['new']);
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

  // ─── Lockless reads during concurrent writes ──────────────
  //
  // Regression: `writeMessage` previously did `fs.writeFile`
  // (open with O_TRUNC) under a `proper-lockfile` write lock,
  // but `readInbox` does not take that lock — the leader's
  // 500ms inbox poll therefore could observe a 0-byte or
  // partially-written file during the brief truncate→write
  // window. `JSON.parse` would throw and
  // `readLeaderInboxOrQuarantine` would rename the inbox to
  // `.corrupt-{ts}`, dropping unread teammate messages.
  //
  // The fix replaces O_TRUNC writes with tmp-file + rename;
  // POSIX rename is atomic so a lockless reader either sees
  // the pre-write or post-write file, never a partial one.
  // This test stresses the race: many writers + many readers
  // running concurrently, none of the reads should throw.
  it('lockless readInbox never sees a partial file mid-write', async () => {
    const writeCount = 10;
    const readCount = 200;

    // Seed the inbox so the first reads have something to parse.
    await writeMessage('team', 'worker', makeMessage({ text: 'seed' }));

    const writes = Array.from({ length: writeCount }, (_, i) =>
      writeMessage('team', 'worker', makeMessage({ text: `w-${i}` })),
    );
    const reads = Array.from({ length: readCount }, () =>
      readInbox('team', 'worker'),
    );

    // Promise.all rejects on the first failure, which is exactly
    // what we want: any parse or I/O error should fail this test.
    const [, readResults] = await Promise.all([
      Promise.all(writes),
      Promise.all(reads),
    ]);

    // Every read returned a parseable array — no quarantine, no
    // dropped messages.
    for (const result of readResults) {
      expect(Array.isArray(result)).toBe(true);
    }

    const finalMessages = await readInbox('team', 'worker');
    expect(finalMessages).toHaveLength(writeCount + 1);
  });
});
