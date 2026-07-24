/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { OwnerEventBus, type OwnerEvent } from '../ownerEvents.js';
import { forwardApprovalModeChange } from './approvalModeForward.js';

describe('forwardApprovalModeChange', () => {
  it('publishes exactly one approval_mode_changed owner frame (no notify — the pump owns the push)', () => {
    const bus = new OwnerEventBus();
    const received: OwnerEvent[] = [];
    bus.subscribe((event) => {
      received.push(event);
    });

    forwardApprovalModeChange(
      's1',
      { previous: 'default', next: 'plan', persisted: false },
      bus,
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
  });

  it('never throws and applies the defensive reads (non-string previous/next -> "", persisted strict-true)', () => {
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

    const approvalFrames = received.filter(
      (e) => e.type === 'approval_mode_changed',
    );
    expect(approvalFrames).toHaveLength(1);
    const frame = approvalFrames[0];
    if (frame.type !== 'approval_mode_changed') throw new Error('unreachable');
    expect(frame.mode.sessionId).toBe('s2');
    expect(frame.mode.previous).toBe('plan');
    expect(frame.mode.next).toBe('default');
    expect(frame.mode.persisted).toBe(true);
  });

  it('treats non-string previous/next and a non-true persisted as defaults', () => {
    const bus = new OwnerEventBus();
    const received: OwnerEvent[] = [];
    bus.subscribe((event) => received.push(event));

    forwardApprovalModeChange(
      's3',
      { previous: 42, next: null, persisted: 'yes' },
      bus,
    );

    const approvalFrames = received.filter(
      (e) => e.type === 'approval_mode_changed',
    );
    expect(approvalFrames).toHaveLength(1);
    const frame = approvalFrames[0];
    if (frame.type !== 'approval_mode_changed') throw new Error('unreachable');
    expect(frame.mode.previous).toBe('');
    expect(frame.mode.next).toBe('');
    expect(frame.mode.persisted).toBe(false);
  });
});
