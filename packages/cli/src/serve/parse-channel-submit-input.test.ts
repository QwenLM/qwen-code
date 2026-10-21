/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseChannelSubmitInput } from './hosted-harness-session.js';

// The closed guard of the channel operations route: it is the last place a
// malformed `submit_input` can be refused before staging side-effects.

function body(replyContext: unknown): Record<string, unknown> {
  return {
    inputId: 'chin-001',
    channelInstanceId: 'mail-1',
    accountId: 'agent@example.com',
    accountGeneration: 1,
    platformEventId: '1700:42',
    semanticRevision: 1,
    scope: {
      kind: 'chat_thread',
      senderId: null,
      chatId: 'alice@example.com',
      threadId: 'thread-1',
    },
    policy: {
      adapter: 'email',
      senderPolicy: 'allowlist',
      allowedSenders: ['alice@example.com'],
      dispatchMode: 'followup',
    },
    senderId: 'alice@example.com',
    chatId: 'alice@example.com',
    threadId: 'thread-1',
    subject: 'Build status',
    text: 'please check',
    attachments: [],
    replyContext,
  };
}

describe('parseChannelSubmitInput reply context bound', () => {
  it('refuses a reply context over the bound before anything side-effects', () => {
    expect(
      parseChannelSubmitInput(body({ pad: 'p'.repeat(9000) })),
    ).toBeUndefined();
  });

  it('admits a reply context inside the bound, including the boundary', () => {
    const inside = { parent: '<a@b>', pad: 'p'.repeat(8_000) };
    const parsed = parseChannelSubmitInput(body(inside));
    expect(parsed).toMatchObject({
      inputId: 'chin-001',
      replyContext: inside,
    });
    expect(parseChannelSubmitInput(body(null))).toMatchObject({
      replyContext: null,
    });
  });
});

describe('parseChannelSubmitInput over the Java control plane wire', () => {
  it('admits the body the Java client sends, whose null members are dropped', () => {
    // HostedHarnessClient encodes with fastjson2, which omits null map
    // values: scope.senderId, subject and replyContext never arrive.
    const wire = body(null);
    wire['scope'] = {
      kind: 'chat_thread',
      chatId: 'alice@example.com',
      threadId: 'thread-1',
    };
    delete wire['replyContext'];
    expect(parseChannelSubmitInput(wire)).toMatchObject({
      scope: {
        kind: 'chat_thread',
        senderId: null,
        chatId: 'alice@example.com',
        threadId: 'thread-1',
      },
      replyContext: null,
    });
  });

  it('still refuses a scope with a key outside the closed shape', () => {
    const wire = body(null);
    wire['scope'] = { kind: 'chat_thread', chatId: 'a', extra: 1 };
    expect(parseChannelSubmitInput(wire)).toBeUndefined();
  });
});
