import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@qwen-code/channel-base';

const baseHandleInbound = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/channel-base', () => ({
  ChannelBase: class {
    protected name: string;

    constructor(name: string) {
      this.name = name;
    }

    protected handleInbound(envelope: Envelope): Promise<void> {
      return baseHandleInbound.call(this, envelope) as Promise<void>;
    }

    protected getResponseMessageId(): string | undefined {
      return undefined;
    }

    protected formatAttributedText(text: string, sourceLabel?: string): string {
      return sourceLabel ? `${sourceLabel} ${text}` : text;
    }
  },
}));

vi.mock('ws', () => ({
  default: class MockWebSocket {
    static OPEN = 1;
  },
}));

import { MockPluginChannel } from './MockPluginChannel.js';

function deferredPromise() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function envelope(messageId: string): Envelope {
  return {
    channelName: 'mock',
    senderId: `sender-${messageId}`,
    senderName: messageId,
    chatId: 'shared-chat',
    text: messageId,
    messageId,
    isGroup: false,
    isMentioned: false,
    isReplyToBot: false,
  };
}

function createChannel() {
  const channel = new MockPluginChannel(
    'mock',
    {
      type: 'mock',
      token: 'test-token',
      serverWsUrl: 'ws://example.test',
      senderPolicy: 'open',
      allowedUsers: [],
      sessionScope: 'user',
      cwd: process.cwd(),
      groupPolicy: 'disabled',
      dmPolicy: 'open',
      groups: {},
    },
    new EventEmitter() as never,
  );
  const send = vi.fn();
  (channel as unknown as { ws: { readyState: number; send: typeof send } }).ws =
    { readyState: 1, send };
  return { channel, send };
}

describe('MockPluginChannel message correlation', () => {
  beforeEach(() => {
    baseHandleInbound.mockReset();
  });

  it('keeps overlapping inbound command replies bound to their own messages', async () => {
    const { channel, send } = createChannel();
    const first = deferredPromise();
    const second = deferredPromise();
    baseHandleInbound.mockImplementation(async function (
      this: MockPluginChannel,
      inbound: Envelope,
    ) {
      await (inbound.messageId === 'msg-a' ? first.promise : second.promise);
      await this.sendMessage(inbound.chatId, `reply-${inbound.messageId}`);
    });

    const pendingA = channel.handleInbound(envelope('msg-a'));
    const pendingB = channel.handleInbound(envelope('msg-b'));
    second.resolve();
    await pendingB;
    first.resolve();
    await pendingA;

    expect(send.mock.calls.map(([frame]) => JSON.parse(String(frame)))).toEqual(
      [
        {
          type: 'outbound',
          messageId: 'msg-b',
          chatId: 'shared-chat',
          text: 'reply-msg-b',
        },
        {
          type: 'outbound',
          messageId: 'msg-a',
          chatId: 'shared-chat',
          text: 'reply-msg-a',
        },
      ],
    );
  });

  it('uses output segment message IDs for chunks and final responses', async () => {
    const { channel, send } = createChannel();
    const output = channel as unknown as {
      onResponseChunk: (
        chatId: string,
        chunk: string,
        sessionId: string,
        segment: { messageId: string },
      ) => void;
      onResponseComplete: (
        chatId: string,
        text: string,
        sessionId: string,
        segment: { messageId: string },
      ) => Promise<void>;
    };

    output.onResponseChunk('shared-chat', 'chunk-a', 'session-a', {
      messageId: 'msg-a',
    });
    await output.onResponseComplete('shared-chat', 'final-b', 'session-b', {
      messageId: 'msg-b',
    });

    expect(send.mock.calls.map(([frame]) => JSON.parse(String(frame)))).toEqual(
      [
        {
          type: 'chunk',
          messageId: 'msg-a',
          chatId: 'shared-chat',
          text: 'chunk-a',
        },
        {
          type: 'outbound',
          messageId: 'msg-b',
          chatId: 'shared-chat',
          text: 'final-b',
        },
      ],
    );
  });

  it('attributes the first chunk and the final response for a segment', async () => {
    const { channel, send } = createChannel();
    const output = channel as unknown as {
      onResponseChunk: (
        chatId: string,
        chunk: string,
        sessionId: string,
        segment: { messageId: string; segmentId: string; sourceLabel: string },
      ) => void;
      onResponseComplete: (
        chatId: string,
        text: string,
        sessionId: string,
        segment: { messageId: string; segmentId: string; sourceLabel: string },
      ) => Promise<void>;
    };
    const segment = {
      messageId: 'msg-a',
      segmentId: 'segment-a',
      sourceLabel: '[review]',
    };

    output.onResponseChunk('shared-chat', 'first', 'session-a', segment);
    output.onResponseChunk('shared-chat', 'second', 'session-a', segment);
    await output.onResponseComplete(
      'shared-chat',
      'complete',
      'session-a',
      segment,
    );

    expect(send.mock.calls.map(([frame]) => JSON.parse(String(frame)))).toEqual(
      [
        expect.objectContaining({ type: 'chunk', text: '[review] first' }),
        expect.objectContaining({ type: 'chunk', text: 'second' }),
        expect.objectContaining({
          type: 'outbound',
          text: '[review] complete',
        }),
      ],
    );
  });
});
