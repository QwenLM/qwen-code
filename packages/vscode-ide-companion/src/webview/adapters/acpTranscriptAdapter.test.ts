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
import { reduceSessionNotification } from './acpTranscriptAdapter.js';

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
