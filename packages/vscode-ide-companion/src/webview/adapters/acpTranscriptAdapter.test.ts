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
      },
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
