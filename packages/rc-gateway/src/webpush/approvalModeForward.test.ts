/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { OwnerEventBus, type OwnerEvent } from '../ownerEvents.js';
import { forwardApprovalModeChange } from './approvalModeForward.js';

describe('forwardApprovalModeChange', () => {
  it('publishes exactly one approval_mode_changed owner frame and notifies once', async () => {
    const bus = new OwnerEventBus();
    const received: OwnerEvent[] = [];
    bus.subscribe((event) => {
      received.push(event);
    });
    const notify = vi.fn().mockResolvedValue(undefined);
    const notifier = { notify };

    forwardApprovalModeChange(
      's1',
      { previous: 'default', next: 'plan', persisted: false },
      bus,
      notifier,
    );

    const approvalFrames = received.filter(
      (e) => e.type === 'approval_mode_changed',
    );
    expect(approvalFrames).toHaveLength(1);
    const frame = approvalFrames[0];
    if (frame.type !== 'approval_mode_changed') throw new Error('unreachable');
    expect(frame.mode.next).toBe('plan');
    expect(frame.mode.previous).toBe('default');
    expect(frame.mode.sessionId).toBe('s1');
    expect(frame.mode.persisted).toBe(false);

    expect(notify).toHaveBeenCalledTimes(1);
    const [event, ctx] = notify.mock.calls[0];
    expect(event).toMatchObject({ type: 'approval_mode_changed' });
    expect(ctx).toMatchObject({ sessionId: 's1' });
  });

  it('never throws when the notifier is undefined', () => {
    const bus = new OwnerEventBus();
    const received: OwnerEvent[] = [];
    bus.subscribe((event) => received.push(event));

    expect(() =>
      forwardApprovalModeChange(
        's2',
        { previous: 'plan', next: 'default', persisted: true },
        bus,
      ),
    ).not.toThrow();
    expect(received).toHaveLength(1);
  });

  it('a rejecting notifier never throws (fire-and-forget .catch)', async () => {
    const bus = new OwnerEventBus();
    const notify = vi.fn().mockRejectedValue(new Error('push failed'));
    const notifier = { notify };

    expect(() =>
      forwardApprovalModeChange(
        's3',
        { previous: 'default', next: 'auto', persisted: false },
        bus,
        notifier,
      ),
    ).not.toThrow();
    // Let the rejected promise's .catch(() => {}) settle before the test ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
