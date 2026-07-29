/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ChannelDeliveryAuthorizationStore } from './channel-delivery-authorization.js';

const workspace = '/workspace/project';
const target = {
  channelName: 'dingtalk',
  type: 'user' as const,
  id: 'user-1',
};

describe('ChannelDeliveryAuthorizationStore', () => {
  it('accepts an authorized prompt target exactly once', () => {
    const store = new ChannelDeliveryAuthorizationStore();
    store.authorizePrompt(workspace, {
      sessionId: 'session-1',
      deliveryId: 'prompt-1',
      target,
    });

    const delivery = {
      sessionId: 'session-1',
      deliveryId: 'prompt-1',
      source: 'prompt' as const,
      promptId: 'prompt-1',
      target,
    };
    expect(store.consume(workspace, delivery)).toBe(true);
    expect(store.consume(workspace, delivery)).toBe(false);
  });

  it('rejects an unregistered prompt and preserves authorization after a target mismatch', () => {
    const store = new ChannelDeliveryAuthorizationStore();
    const base = {
      sessionId: 'session-1',
      deliveryId: 'prompt-1',
      source: 'prompt' as const,
      promptId: 'prompt-1',
    };
    expect(store.consume(workspace, { ...base, target })).toBe(false);

    store.authorizePrompt(workspace, {
      sessionId: 'session-1',
      deliveryId: 'prompt-1',
      target,
    });
    expect(
      store.consume(workspace, {
        ...base,
        target: { ...target, id: 'user-2' },
      }),
    ).toBe(false);
    expect(store.consume(workspace, { ...base, target })).toBe(true);
  });

  it('accepts monotonic recurring fires and rejects replay or target changes', () => {
    const store = new ChannelDeliveryAuthorizationStore();
    store.registerScheduledTask(workspace, {
      sessionId: 'session-1',
      taskId: 'task-1',
      target,
      recurring: true,
      lastFiredAt: 1_000,
    });

    const fire = {
      sessionId: 'session-1',
      deliveryId: 'task-1:2000',
      source: 'scheduled' as const,
      taskId: 'task-1',
      firedAt: 2_000,
      target,
    };
    expect(store.consume(workspace, fire)).toBe(true);
    store.registerScheduledTask(workspace, {
      sessionId: 'session-1',
      taskId: 'task-1',
      target,
      recurring: true,
      lastFiredAt: 1_000,
    });
    expect(store.consume(workspace, fire)).toBe(false);
    expect(
      store.consume(workspace, {
        ...fire,
        deliveryId: 'task-1:3000',
        firedAt: 3_000,
        target: { ...target, id: 'user-2' },
      }),
    ).toBe(false);
    expect(
      store.consume(workspace, {
        ...fire,
        deliveryId: 'task-1:3000',
        firedAt: 3_000,
      }),
    ).toBe(true);
  });

  it('consumes a one-shot scheduled authorization once', () => {
    const store = new ChannelDeliveryAuthorizationStore();
    store.registerScheduledTask(workspace, {
      sessionId: 'session-1',
      taskId: 'task-1',
      target,
      recurring: false,
      lastFiredAt: 1_000,
    });

    const fire = {
      sessionId: 'session-1',
      deliveryId: 'task-1:2000',
      source: 'scheduled' as const,
      taskId: 'task-1',
      firedAt: 2_000,
      target,
    };
    expect(store.consume(workspace, fire)).toBe(true);
    expect(
      store.consume(workspace, {
        ...fire,
        deliveryId: 'task-1:3000',
        firedAt: 3_000,
      }),
    ).toBe(false);
  });
});
