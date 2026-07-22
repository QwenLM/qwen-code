/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  OwnerEventBus,
  ReviewLifecycleEventType,
  ReviewLifecyclePayload,
} from '../ownerEvents.js';
import type { ReviewRegistry, ReviewRecord } from './reviewRegistry.js';

/**
 * Drives review status transitions off the gateway's own event plumbing and
 * emits `review_*` lifecycle frames (design: "reviewLifecycle.ts", mirrors
 * `agentLifecycle.ts`) — OWNER STREAM ONLY. A review has no parent session
 * (unlike an agent), so there is no second fan-out surface here.
 *
 *  - `session_died` on the review's session        → `failed`   + review_failed
 *  - terminal prompt completion (onPromptSettled)   → `completed`/`failed` +
 *    review_completed/review_failed (report resolved first, best-effort)
 *  - cancel route calls `onCancelled` after its own `setStatus('cancelled')`
 *    to emit `review_cancelled`
 *  - `setBlocked`/`setRunning` are bridge callbacks (permission bridge, C.2):
 *    they transition status with NO frame, mirroring AgentLifecycle's
 *    `session_update`-while-blocked case (blocked/running are non-terminal,
 *    so `blocked → running` is an allowed `setStatus` transition).
 */
export class ReviewLifecycle {
  constructor(
    private readonly registry: ReviewRegistry,
    private readonly ownerEvents: OwnerEventBus,
    /** Read-time cost rollup keyed by sessionId (routes read this directly). */
    private readonly costFor?: (sessionId: string) => number | undefined,
    private readonly resolveReport?: (rec: ReviewRecord) => Promise<{
      reportPath: string | null;
      summary: ReviewRecord['summary'];
    }>,
  ) {}

  /** Build the wire payload for a record. */
  private payloadFor(rec: ReviewRecord): ReviewLifecyclePayload {
    return {
      reviewId: rec.reviewId,
      sessionId: rec.sessionId,
      target: rec.target,
      status: rec.status,
      reportPath: rec.reportPath,
      summary: rec.summary,
    };
  }

  /** Emit one lifecycle frame on the owner events stream. */
  emit(type: ReviewLifecycleEventType, record: ReviewRecord): void {
    this.ownerEvents.publish({ type, review: this.payloadFor(record) });
  }

  /**
   * Called by routes/reviews.ts when the review's daemon prompt settles:
   * resolve → completed (report resolved first, best-effort), reject → failed.
   */
  async onPromptSettled(
    reviewId: string,
    outcome: 'completed' | 'failed',
  ): Promise<void> {
    if (outcome === 'completed' && this.resolveReport) {
      const rec = this.registry.get(reviewId);
      if (rec) {
        try {
          const { reportPath, summary } = await this.resolveReport(rec);
          await this.registry.setReport(reviewId, reportPath, summary);
        } catch {
          // Best-effort; a missing report leaves the fields null.
        }
      }
    }
    if (await this.registry.setStatus(reviewId, outcome)) {
      this.emit(
        outcome === 'completed' ? 'review_completed' : 'review_failed',
        this.registry.get(reviewId)!,
      );
    }
  }

  /**
   * Feed one daemon session event through the transition table. Wired into
   * SessionEventPump's `onEvent` by the boot wiring (cli.ts, E.2). No-op for
   * sessions that back no review.
   */
  async handleSessionEvent(
    sessionId: string,
    ev: { type: string; data: unknown },
  ): Promise<void> {
    const rec = this.registry.findBySessionId(sessionId);
    if (!rec) return;
    if (ev.type === 'session_died') {
      if (await this.registry.setStatus(rec.reviewId, 'failed')) {
        this.emit('review_failed', this.registry.get(rec.reviewId)!);
      }
    }
  }

  /** Bridge callback (C.2): an outstanding permission request. No frame. */
  async setBlocked(sessionId: string): Promise<void> {
    const rec = this.registry.findBySessionId(sessionId);
    if (rec && rec.status === 'running') {
      await this.registry.setStatus(rec.reviewId, 'blocked');
    }
  }

  /** Bridge callback (C.2): permission resolved, flowing again. No frame. */
  async setRunning(sessionId: string): Promise<void> {
    const rec = this.registry.findBySessionId(sessionId);
    if (rec && rec.status === 'blocked') {
      await this.registry.setStatus(rec.reviewId, 'running');
    }
  }

  /** Called by the cancel route after its own `setStatus('cancelled')`. */
  async onCancelled(reviewId: string): Promise<void> {
    this.emit('review_cancelled', this.registry.get(reviewId)!);
  }
}
