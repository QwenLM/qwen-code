import { describe, expect, it } from 'vitest';
import {
  CHANNEL_DELIVERY_IPC_TIMEOUT_MS,
  ChannelDeliveryError,
  createChannelDeliveryMessage,
  isChannelDeliveryError,
  isChannelDeliveryErrorCode,
  isChannelDeliveryMessage,
  isChannelDeliveryResultMessage,
} from './channel-delivery-ipc.js';

const request = {
  deliveryId: 'delivery-1',
  channelName: 'dingtalk-main',
  target: {
    type: 'chat' as const,
    id: 'group-1',
  },
  text: 'inspection result',
};

describe('channel delivery IPC', () => {
  it('creates a bounded request message', () => {
    const before = Date.now();
    const message = createChannelDeliveryMessage(request);

    expect(message).toMatchObject({
      type: 'channel_delivery',
      request,
    });
    expect(message.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(message.expiresAt).toBeGreaterThanOrEqual(
      before + CHANNEL_DELIVERY_IPC_TIMEOUT_MS,
    );
    expect(message.expiresAt).toBeLessThanOrEqual(
      Date.now() + CHANNEL_DELIVERY_IPC_TIMEOUT_MS,
    );
    expect(isChannelDeliveryMessage(message)).toBe(true);
  });

  it.each([
    null,
    {},
    { type: 'other', id: 'ipc-1', expiresAt: 1, request },
    { type: 'channel_delivery', id: '', expiresAt: 1, request },
    {
      type: 'channel_delivery',
      id: 'ipc-1',
      expiresAt: Number.POSITIVE_INFINITY,
      request,
    },
    {
      type: 'channel_delivery',
      id: 'ipc-1',
      expiresAt: 1,
      request: { ...request, deliveryId: '' },
    },
    {
      type: 'channel_delivery',
      id: 'ipc-1',
      expiresAt: 1,
      request: { ...request, text: '   ' },
    },
    {
      type: 'channel_delivery',
      id: 'ipc-1',
      expiresAt: 1,
      request: {
        ...request,
        target: { ...request.target, id: '' },
      },
    },
    {
      type: 'channel_delivery',
      id: 'ipc-1',
      expiresAt: 1,
      request: {
        ...request,
        target: { ...request.target, type: 'topic' },
      },
    },
    {
      type: 'channel_delivery',
      id: 'ipc-1',
      expiresAt: 1,
      request: {
        ...request,
        target: { ...request.target, threadId: 'thread-1' },
      },
    },
    {
      type: 'channel_delivery',
      id: 'ipc-1',
      expiresAt: 1,
      request: {
        ...request,
        target: { ...request.target, topicId: 'topic-1' },
      },
    },
    {
      type: 'channel_delivery',
      id: 'ipc-1',
      expiresAt: 1,
      request: {
        ...request,
        target: { ...request.target, chatId: 'group-1' },
      },
    },
    {
      type: 'channel_delivery',
      id: 'ipc-1',
      expiresAt: 1,
      request: {
        ...request,
        target: { ...request.target, isGroup: true },
      },
    },
  ])('rejects malformed request messages %#', (message) => {
    expect(isChannelDeliveryMessage(message)).toBe(false);
  });

  it('accepts success and typed failure result messages', () => {
    expect(
      isChannelDeliveryResultMessage({
        type: 'channel_delivery_result',
        id: 'ipc-1',
        ok: true,
      }),
    ).toBe(true);
    expect(
      isChannelDeliveryResultMessage({
        type: 'channel_delivery_result',
        id: 'ipc-1',
        ok: false,
        code: 'channel_delivery_failed',
        error: 'Platform send failed.',
      }),
    ).toBe(true);
  });

  it.each([
    {
      type: 'channel_delivery_result',
      id: '',
      ok: true,
    },
    {
      type: 'channel_delivery_result',
      id: 'ipc-1',
      ok: false,
    },
    {
      type: 'channel_delivery_result',
      id: 'ipc-1',
      ok: false,
      code: 'unknown',
      error: 'nope',
    },
    {
      type: 'channel_delivery_result',
      id: 'ipc-1',
      ok: false,
      code: 'channel_delivery_failed',
      error: 42,
    },
  ])('rejects malformed result messages %#', (message) => {
    expect(isChannelDeliveryResultMessage(message)).toBe(false);
  });

  it('recognizes only public delivery error codes and errors', () => {
    expect(isChannelDeliveryErrorCode('channel_delivery_timeout')).toBe(true);
    expect(isChannelDeliveryErrorCode('unknown')).toBe(false);

    const error = new ChannelDeliveryError(
      'channel_delivery_failed',
      'Platform send failed.',
    );
    expect(isChannelDeliveryError(error)).toBe(true);
    expect(
      isChannelDeliveryError({
        code: 'channel_worker_unavailable',
        message: 'Worker stopped.',
      }),
    ).toBe(true);
    expect(isChannelDeliveryError({ code: 'unknown', message: 'nope' })).toBe(
      false,
    );
  });
});
