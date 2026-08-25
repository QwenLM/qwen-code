/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionNotification } from '@agentclientprotocol/sdk';
import {
  createDaemonTranscriptState,
  selectTranscriptBlocks,
} from '@qwen-code/sdk/daemon';
import { describe, expect, it } from 'vitest';
import {
  cachedMessageToNotification,
  reduceSessionNotification,
} from './acpTranscriptAdapter.js';

function userTextNotification(text: string): SessionNotification {
  return {
    sessionId: 'session-1',
    update: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text },
    },
  };
}

describe('reduceSessionNotification', () => {
  it('wraps an ACP notification into a daemon event and reduces it', () => {
    const state = reduceSessionNotification(
      createDaemonTranscriptState(),
      userTextNotification('hello world'),
    );

    const blocks = selectTranscriptBlocks(state);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'user', text: 'hello world' });
  });

  it('merges consecutive user text chunks into one block', () => {
    let state = createDaemonTranscriptState();
    state = reduceSessionNotification(state, userTextNotification('hello '));
    state = reduceSessionNotification(state, userTextNotification('world'));

    const blocks = selectTranscriptBlocks(state);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'user', text: 'hello world' });
  });
});

function seedCachedRows(
  rows: ReadonlyArray<{ role?: string; content?: string }>,
) {
  let state = createDaemonTranscriptState();
  for (const row of rows) {
    const notification = cachedMessageToNotification(row, 'session-1');
    if (notification) {
      state = reduceSessionNotification(state, notification);
    }
  }
  return selectTranscriptBlocks(state);
}

describe('cachedMessageToNotification', () => {
  it('converts a cached row with renderable text into a notification', () => {
    expect(
      cachedMessageToNotification(
        { role: 'user', content: 'hello' },
        'session-1',
      ),
    ).toEqual({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'hello' },
        _meta: { qwenDiscreteMessage: true },
      },
    });
  });

  it('strips persisted image references from restored user text', () => {
    expect(
      cachedMessageToNotification(
        {
          role: 'user',
          content: 'look at this\n\n@/tmp/clipboard/clipboard-1.png',
        },
        'session-1',
      ),
    ).toMatchObject({
      update: {
        content: { type: 'text', text: 'look at this' },
      },
    });

    expect(
      cachedMessageToNotification(
        { role: 'user', content: '@/tmp/clipboard/clipboard-1.png' },
        'session-1',
      ),
    ).toBeNull();
  });

  it('stamps every cached role as a discrete message', () => {
    for (const role of ['user', 'assistant', 'thinking']) {
      const notification = cachedMessageToNotification(
        { role, content: 'text' },
        's',
      );
      expect(notification).not.toBeNull();
      expect((notification as SessionNotification).update).toMatchObject({
        _meta: { qwenDiscreteMessage: true },
      });
    }
  });

  it('keeps consecutive same-role cached rows as discrete blocks', () => {
    const blocks = seedCachedRows([
      { role: 'assistant', content: "I'll check the file." },
      { role: 'assistant', content: 'Tool Result (call_1): success' },
      { role: 'assistant', content: 'Tool Call: read_file - completed (12ms)' },
    ]);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({
      kind: 'assistant',
      text: "I'll check the file.",
    });
    expect(blocks[1]).toMatchObject({
      kind: 'assistant',
      text: 'Tool Result (call_1): success',
    });
    expect(blocks[2]).toMatchObject({
      kind: 'assistant',
      text: 'Tool Call: read_file - completed (12ms)',
    });
  });

  it('does not fuse turns across a dropped whitespace-only row', () => {
    const blocks = seedCachedRows([
      { role: 'assistant', content: 'turn 1 answer' },
      { role: 'user', content: '   ' },
      { role: 'assistant', content: 'turn 2 answer' },
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      kind: 'assistant',
      text: 'turn 1 answer',
    });
    expect(blocks[1]).toMatchObject({
      kind: 'assistant',
      text: 'turn 2 answer',
    });
  });

  it('returns null for whitespace-only content instead of an empty block', () => {
    expect(
      cachedMessageToNotification({ role: 'user', content: '   ' }, 's'),
    ).toBeNull();
    expect(
      cachedMessageToNotification({ role: 'assistant', content: '\n\t ' }, 's'),
    ).toBeNull();
  });

  it('returns null for empty, missing, or non-string content', () => {
    expect(
      cachedMessageToNotification({ role: 'user', content: '' }, 's'),
    ).toBeNull();
    expect(cachedMessageToNotification({ role: 'user' }, 's')).toBeNull();
  });
});
