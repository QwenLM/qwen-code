/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionTranscriptWriterImpl } from './session-transcript-writer-impl.js';
import { buildMessage } from '../../../factory/message-factory.js';
import type { AppendChannelLease } from '../../../infra/writer/append-channel-lease.js';
import type { TranscriptEntry } from '../../../infra/entry/transcript-entry.js';

function createMockLease(): AppendChannelLease & { entries: TranscriptEntry[] } {
  const entries: TranscriptEntry[] = [];
  return {
    filePath: '/tmp/s.jsonl',
    entries,
    append: vi.fn(async (e) => {
      entries.push(...e);
    }),
    barrier: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
    readTail: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    readAll: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    release: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SessionTranscriptWriterImpl', () => {
  it('records user and assistant messages as transcript entries', async () => {
    const lease = createMockLease();
    const writer = new SessionTranscriptWriterImpl({
      channel: lease,
      sessionId: 's1',
      cwd: '/project',
      entrypoint: 'cli',
    });

    await writer.recordMessages([
      buildMessage({
        uuid: 'u1',
        role: 'user',
        promptId: 'p1',
        payload: { content: 'hello' },
      }),
      buildMessage({
        uuid: 'a1',
        role: 'assistant',
        promptId: 'p1',
        payload: { content: 'hi there' },
      }),
    ]);
    await writer.flush();

    const messageEntries = lease.entries.filter(
      (e) => e.type === 'user' || e.type === 'assistant',
    );
    expect(messageEntries).toHaveLength(2);
    expect(messageEntries[0]).toMatchObject({
      type: 'user',
      uuid: 'u1',
      sessionId: 's1',
      promptId: 'p1',
    });
    expect(messageEntries[1]).toMatchObject({
      type: 'assistant',
      uuid: 'a1',
      sessionId: 's1',
      promptId: 'p1',
      parentUuid: 'u1',
    });
  });

  it('writes metadata entries and refreshes them after assistant message', async () => {
    const lease = createMockLease();
    const writer = new SessionTranscriptWriterImpl({
      channel: lease,
      sessionId: 's1',
      cwd: '/project',
      entrypoint: 'cli',
    });

    await writer.recordCustomTitle('my title');
    await writer.recordLastPrompt('last prompt');
    await writer.recordTag('todo');
    await writer.recordWorkspaceDirectories(['/a', '/b']);
    await writer.recordMessages([
      buildMessage({
        uuid: 'u1',
        role: 'user',
        promptId: 'p1',
        payload: { content: 'hello' },
      }),
      buildMessage({
        uuid: 'a1',
        role: 'assistant',
        promptId: 'p1',
        payload: { content: 'ok' },
      }),
    ]);
    await writer.flush();

    const types = lease.entries.map((e) => e.type);
    expect(types).toContain('custom-title');
    expect(types).toContain('last-prompt');
    expect(types).toContain('tag');
    expect(types).toContain('workspace-directories');

    const lastPromptEntries = lease.entries.filter(
      (e): e is { type: 'last-prompt'; sessionId: string; lastPrompt: string } =>
        e.type === 'last-prompt',
    );
    expect(lastPromptEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('deduplicates already recorded message uuids', async () => {
    const lease = createMockLease();
    const writer = new SessionTranscriptWriterImpl({
      channel: lease,
      sessionId: 's1',
      cwd: '/project',
      entrypoint: 'cli',
    });

    await writer.recordMessages([
      buildMessage({ uuid: 'u1', role: 'user', payload: { content: 'a' } }),
    ]);
    await writer.recordMessages([
      buildMessage({ uuid: 'u1', role: 'user', payload: { content: 'a' } }),
    ]);
    await writer.flush();

    const userEntries = lease.entries.filter((e) => e.type === 'user');
    expect(userEntries).toHaveLength(1);
  });

  it('closes the channel on close', async () => {
    const lease = createMockLease();
    const writer = new SessionTranscriptWriterImpl({
      channel: lease,
      sessionId: 's1',
      cwd: '/project',
      entrypoint: 'cli',
    });

    await writer.close();
    expect(lease.release).toHaveBeenCalled();
  });
});
