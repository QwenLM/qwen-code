/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  CHANNEL_WORKFLOW_ORIGIN_META_KEY,
  parseBackgroundResponseContext,
  parseChannelWorkflowOrigin,
} from './ChannelAgentBridge.js';

describe('parseBackgroundResponseContext', () => {
  // A context this parser rejects is delivered to the channel without one,
  // which costs the message its header and its turn grouping. Every kind a
  // session can produce has to be listed here as well as in the type.
  it.each([
    'agent',
    'monitor',
    'shell',
    'workflow',
    'peer',
    'teammate',
  ] as const)('carries a %s context through', (kind) => {
    expect(
      parseBackgroundResponseContext({
        taskId: 'k1',
        status: 'completed',
        kind,
        label: 'a label',
      }),
    ).toEqual({
      taskId: 'k1',
      status: 'completed',
      kind,
      label: 'a label',
    });
  });

  // A workflow result is delivered only to the chat that launched it, so a
  // workflow context must keep its origin; an origin that fails to parse
  // leaves the result undeliverable.
  const origin = {
    channelName: 'dingtalk',
    chatId: 'launch-chat',
    senderId: 'alice',
    threadId: 'thread-1',
    isGroup: true,
    messageRoute: 'route-1',
    userInitiated: true,
  };

  it('carries the launch origin of a workflow context', () => {
    expect(
      parseBackgroundResponseContext({
        taskId: 'wf_1',
        status: 'completed',
        kind: 'workflow',
        [CHANNEL_WORKFLOW_ORIGIN_META_KEY]: origin,
      }),
    ).toEqual({
      taskId: 'wf_1',
      status: 'completed',
      kind: 'workflow',
      channelWorkflowOrigin: origin,
    });
    // Other kinds route by session and ignore the field.
    expect(
      parseBackgroundResponseContext({
        taskId: 'k1',
        status: 'completed',
        kind: 'agent',
        [CHANNEL_WORKFLOW_ORIGIN_META_KEY]: origin,
      }),
    ).not.toHaveProperty('channelWorkflowOrigin');
  });

  it.each([
    ['no chat', { ...origin, chatId: '' }],
    ['no sender', { ...origin, senderId: undefined }],
    ['a non-boolean isGroup', { ...origin, isGroup: 'yes' }],
    ['an empty thread', { ...origin, threadId: '' }],
    ['userInitiated other than true', { ...origin, userInitiated: false }],
    ['a list', [origin]],
  ])('drops a workflow origin with %s', (_label, value) => {
    expect(parseChannelWorkflowOrigin(value)).toBeUndefined();
    expect(
      parseBackgroundResponseContext({
        taskId: 'wf_1',
        status: 'completed',
        kind: 'workflow',
        [CHANNEL_WORKFLOW_ORIGIN_META_KEY]: value,
      }),
    ).not.toHaveProperty('channelWorkflowOrigin');
  });

  it('keeps only the known origin fields', () => {
    expect(
      parseChannelWorkflowOrigin({
        ...origin,
        backgroundWorkflowBlocked: true,
        extra: 'ignored',
      }),
    ).toEqual({ ...origin, backgroundWorkflowBlocked: true });
  });

  it('drops a kind it does not know', () => {
    expect(
      parseBackgroundResponseContext({
        taskId: 'k1',
        status: 'completed',
        kind: 'something-else',
      }),
    ).toBeUndefined();
  });
});
