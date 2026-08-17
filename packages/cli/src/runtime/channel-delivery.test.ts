/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_CHANNEL_DELIVERY_TEXT_LENGTH,
  normalizeChannelDelivery,
  normalizeChannelDeliveryText,
  parseChannelDelivery,
} from './channel-delivery.js';

const delivery = {
  kind: 'channel' as const,
  target: {
    channelName: 'dingtalk',
    type: 'user' as const,
    id: 'user-1',
  },
};

describe('channel delivery contract', () => {
  it('parses the exact public target shape', () => {
    expect(parseChannelDelivery(delivery)).toEqual(delivery);
  });

  it.each([
    null,
    {},
    { ...delivery, kind: 'webhook' },
    { kind: 'channel', channelName: 'dingtalk', target: delivery.target },
    { ...delivery, extra: true },
    { ...delivery, target: { ...delivery.target, channelName: ' ' } },
    { ...delivery, target: { ...delivery.target, type: 'topic' } },
    { ...delivery, target: { ...delivery.target, id: '' } },
    { ...delivery, target: { ...delivery.target, threadId: 'thread-1' } },
  ])('rejects malformed public delivery %#', (value) => {
    expect(() => parseChannelDelivery(value)).toThrow(
      'Invalid channel delivery.',
    );
  });

  it('normalizes and safely bounds delivery text for worker IPC', () => {
    const baseline = normalizeChannelDeliveryText(
      'x'.repeat(MAX_CHANNEL_DELIVERY_TEXT_LENGTH + 1),
    );
    const prefixLimit = baseline.indexOf('\n\n[Channel delivery truncated');
    const oversized = `${'x'.repeat(prefixLimit - 1)}😀${'x'.repeat(MAX_CHANNEL_DELIVERY_TEXT_LENGTH)}`;
    const request = normalizeChannelDelivery('prompt-1', delivery, oversized);

    expect(request).toMatchObject({
      deliveryId: 'prompt-1',
      channelName: 'dingtalk',
      target: { type: 'user', id: 'user-1' },
    });
    expect(request.text.length).toBeLessThanOrEqual(
      MAX_CHANNEL_DELIVERY_TEXT_LENGTH,
    );
    expect(request.text).toContain('[Channel delivery truncated');
    const suffixStart = request.text.indexOf('\n\n[Channel delivery truncated');
    expect(request.text.charCodeAt(suffixStart - 1)).not.toBe(0xd83d);
  });

  it('rejects empty text before worker IPC', () => {
    expect(() => normalizeChannelDelivery('prompt-1', delivery, '  ')).toThrow(
      'Channel delivery text is empty.',
    );
  });
});
