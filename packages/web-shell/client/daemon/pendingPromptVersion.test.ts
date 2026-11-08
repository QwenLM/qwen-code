/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

async function loadModule() {
  vi.resetModules();
  return await import('./pendingPromptVersion.js');
}

function pendingEvent(type: string, promptId = 'p-1', state?: string) {
  return {
    v: 1,
    type,
    data: {
      sessionId: 's-1',
      promptId,
      ...(state ? { state } : {}),
      ...(type === 'pending_prompt_added'
        ? { text: 'hello', queuedAt: 1 }
        : {}),
      ...(type === 'pending_prompt_started' ? { text: 'hello' } : {}),
    },
  };
}

beforeEach(() => {
  vi.resetModules();
});

describe('pending prompt sidechannel', () => {
  it('bumps queue version for pending-prompt queue events', async () => {
    const sidechannel = await loadModule();
    const listener = vi.fn();
    sidechannel.subscribePendingPromptVersion(listener);

    sidechannel.publishPendingPromptEvent(pendingEvent('pending_prompt_added'));
    sidechannel.publishPendingPromptEvent(
      pendingEvent('pending_prompt_started'),
    );
    sidechannel.publishPendingPromptEvent(
      pendingEvent('pending_prompt_completed', 'p-1', 'completed'),
    );

    expect(listener).toHaveBeenCalledTimes(3);
    expect(sidechannel.getPendingPromptVersion()).toBe(3);
  });

  it.each(['turn_complete', 'turn_error'] as const)(
    'notifies event subscribers without bumping version for %s events',
    async (type) => {
      const sidechannel = await loadModule();
      const versionListener = vi.fn();
      const eventListener = vi.fn();
      sidechannel.subscribePendingPromptVersion(versionListener);
      sidechannel.subscribePendingPromptEvents(eventListener);

      sidechannel.publishPendingPromptEvent({
        v: 1,
        type,
        data: { sessionId: 's-1', promptId: 'p-1' },
      });

      expect(eventListener).toHaveBeenCalledTimes(1);
      expect(versionListener).not.toHaveBeenCalled();
      expect(sidechannel.getPendingPromptVersion()).toBe(0);
    },
  );

  it('stops notifying unsubscribed listeners', async () => {
    const sidechannel = await loadModule();
    const versionListener = vi.fn();
    const eventListener = vi.fn();
    const unsubscribeVersion =
      sidechannel.subscribePendingPromptVersion(versionListener);
    const unsubscribeEvents =
      sidechannel.subscribePendingPromptEvents(eventListener);

    unsubscribeVersion();
    unsubscribeEvents();

    sidechannel.publishPendingPromptEvent({
      v: 1,
      type: 'pending_prompt_added',
      data: { sessionId: 's-1', promptId: 'p-1' },
    });

    expect(eventListener).not.toHaveBeenCalled();
    expect(versionListener).not.toHaveBeenCalled();
    expect(sidechannel.getPendingPromptVersion()).toBe(1);
  });

  it('rejects malformed pending prompt events', async () => {
    const sidechannel = await loadModule();

    expect(
      sidechannel.isPendingPromptEvent({ type: 'pending_prompt_added' }),
    ).toBe(false);
    expect(
      sidechannel.isPendingPromptEvent({
        type: 'pending_prompt_added',
        data: { sessionId: 's-1' },
      }),
    ).toBe(false);
    expect(
      sidechannel.isPendingPromptEvent({
        type: 'pending_prompt_started',
        data: { sessionId: 's-1', promptId: 'p-1' },
      }),
    ).toBe(true);
  });

  it('consume removes only handled event identities', async () => {
    const sidechannel = await loadModule();
    const first = pendingEvent('pending_prompt_added', 'p-1');
    const second = pendingEvent('pending_prompt_started', 'p-2');
    sidechannel.publishPendingPromptEvent(first);
    sidechannel.publishPendingPromptEvent(second);
    const snapshot = sidechannel.getPendingPromptEvents();

    sidechannel.consumePendingPromptEvents([snapshot[0]!]);

    expect(sidechannel.getPendingPromptEvents()).toEqual([second]);
  });

  it('caps the event buffer and evicts oldest events', async () => {
    const sidechannel = await loadModule();
    for (let i = 0; i < 205; i++) {
      sidechannel.publishPendingPromptEvent(
        pendingEvent('pending_prompt_added', `p-${i}`),
      );
    }

    const events = sidechannel.getPendingPromptEvents();
    expect(events).toHaveLength(200);
    expect(events[0]?.data.promptId).toBe('p-5');
    expect(events[199]?.data.promptId).toBe('p-204');
  });
});
