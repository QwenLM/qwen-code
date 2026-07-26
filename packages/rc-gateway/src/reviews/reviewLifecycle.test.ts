/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewRegistry } from './reviewRegistry.js';
import { ReviewLifecycle } from './reviewLifecycle.js';
import { OwnerEventBus, type OwnerEvent } from '../ownerEvents.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'rl-'));
  const reg = await ReviewRegistry.open(join(dir, 'r.json'), () => 1);
  const bus = new OwnerEventBus();
  const seen: OwnerEvent[] = [];
  bus.subscribe((e) => seen.push(e));
  return { reg, bus, seen };
}

describe('ReviewLifecycle', () => {
  it('emits review_completed with resolved report + cost', async () => {
    const { reg, bus, seen } = await fixture();
    const rec = await reg.register({
      sessionId: 's',
      target: { kind: 'pr', number: 7 },
      comment: false,
      autofix: false,
      approvalLeg: 'auto',
      triggeredByTokenId: 'x',
    });
    const lc = new ReviewLifecycle(
      reg,
      bus,
      () => 4242,
      async () => ({
        reportPath: '/p/.qwen/reviews/x-pr-7.md',
        summary: { findingsCount: 3, verdict: 'ok' },
      }),
    );
    await lc.onPromptSettled(rec.reviewId, 'completed');
    const frame = seen.find((e) => e.type === 'review_completed') as Extract<
      OwnerEvent,
      { type: 'review_completed' }
    >;
    expect(frame.review.reportPath).toBe('/p/.qwen/reviews/x-pr-7.md');
    expect(frame.review.summary?.findingsCount).toBe(3);
    expect(reg.get(rec.reviewId)?.status).toBe('completed');
  });

  it('notifies the notifier sink on review_completed with the sessionId', async () => {
    const { reg, bus } = await fixture();
    const rec = await reg.register({
      sessionId: 's3',
      target: { kind: 'local' },
      comment: false,
      autofix: false,
      approvalLeg: 'auto',
      triggeredByTokenId: 'x',
    });
    const notified: Array<{
      event: { type: string; data: unknown };
      ctx: { sessionId: string; sessionName?: string };
    }> = [];
    const fakeNotifier = {
      notify: async (
        event: { type: string; data: unknown },
        ctx: { sessionId: string; sessionName?: string },
      ) => {
        notified.push({ event, ctx });
      },
    };
    const lc = new ReviewLifecycle(
      reg,
      bus,
      undefined,
      undefined,
      fakeNotifier,
    );
    await lc.onPromptSettled(rec.reviewId, 'completed');
    expect(notified).toHaveLength(1);
    expect(notified[0]!.event.type).toBe('review_completed');
    expect(notified[0]!.ctx.sessionId).toBe('s3');
    expect((notified[0]!.event.data as { reviewId?: string }).reviewId).toBe(
      rec.reviewId,
    );
  });

  it('session_died → failed + review_failed', async () => {
    const { reg, bus, seen } = await fixture();
    const rec = await reg.register({
      sessionId: 's2',
      target: { kind: 'local' },
      comment: false,
      autofix: false,
      approvalLeg: 'vote',
      triggeredByTokenId: 'x',
    });
    const lc = new ReviewLifecycle(reg, bus);
    await lc.handleSessionEvent('s2', { type: 'session_died', data: {} });
    expect(seen.some((e) => e.type === 'review_failed')).toBe(true);
    expect(reg.get(rec.reviewId)?.status).toBe('failed');
  });

  it('owner-stream frame never carries a path target raw path', async () => {
    const { reg, bus, seen } = await fixture();
    const rec = await reg.register({
      sessionId: 's4',
      target: { kind: 'path', path: '/secret/xyz' },
      comment: false,
      autofix: false,
      approvalLeg: 'vote',
      triggeredByTokenId: 'x',
    });
    const lc = new ReviewLifecycle(reg, bus);
    await lc.handleSessionEvent('s4', { type: 'session_died', data: {} });
    const frame = seen.find((e) => e.type === 'review_failed') as Extract<
      OwnerEvent,
      { type: 'review_failed' }
    >;
    expect(frame).toBeDefined();
    expect(JSON.stringify(frame)).not.toContain('/secret/xyz');
    expect(frame.review.target).not.toHaveProperty('path');
    expect(frame.review.target.kind).toBe('path');
    expect(reg.get(rec.reviewId)?.target).toEqual({
      kind: 'path',
      path: '/secret/xyz',
    });
  });
});
