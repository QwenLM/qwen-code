/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type ReviewStatus =
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned';

/** Statuses a record can never leave. `setStatus` refuses transitions out. */
export const TERMINAL_REVIEW_STATUSES: ReadonlySet<ReviewStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'orphaned',
]);

/**
 * The reviewed scope. Kept structurally identical to
 * `ReviewLifecyclePayload['target']` in ownerEvents.ts (Task B.1) — the two
 * types are defined independently (no shared import) but MUST stay in sync.
 */
export type ReviewTarget =
  | { kind: 'pr'; number: number }
  | { kind: 'path'; path: string }
  | { kind: 'local' };

/**
 * Metadata-safe view of a `ReviewTarget` for any sink OUTSIDE the daemon that
 * ran the review — the owner events stream and the audit log. A `pr` target's
 * number is not sensitive and is kept; a `path` target's raw, caller-supplied
 * filesystem path is dropped, leaving only its `kind` (mirrors
 * `webpush/payload.ts`'s review branch, which likewise never lets a `path`
 * target's path reach a push payload). Shared by reviewLifecycle.ts's `emit`
 * (owner-stream frame) and routes/review.ts's `review_started` audit record so
 * the two sinks can't drift apart.
 */
export function sanitizeReviewTarget(
  target: ReviewTarget,
): { kind: 'pr'; number: number } | { kind: 'path' } | { kind: 'local' } {
  if (target.kind === 'pr') return { kind: 'pr', number: target.number };
  if (target.kind === 'path') return { kind: 'path' };
  return { kind: 'local' };
}

/**
 * One `/review` run, backed 1:1 by a daemon session (mirrors AgentRecord's
 * agents-as-sessions approach). Shape mirrors the approved design doc.
 */
export interface ReviewRecord {
  reviewId: string; // uuid
  sessionId: string; // the daemon session backing this review
  target: ReviewTarget;
  comment: boolean;
  autofix: boolean;
  approvalLeg: 'vote' | 'auto';
  status: ReviewStatus;
  reportPath: string | null;
  summary: { findingsCount?: number; verdict?: string } | null;
  triggeredByTokenId: string;
  triggeredAt: string;
  finishedAt: string | null;
}

interface PersistShape {
  reviews: ReviewRecord[];
}

/**
 * Persisted review registry — JSON file store, same pattern as AgentRegistry
 * (agentRegistry.ts): private constructor, `open()` reads-or-starts-empty,
 * every mutation awaits `persist()` (0600 file inside an ensured dir).
 */
export class ReviewRegistry {
  private constructor(
    private readonly filePath: string,
    private records: ReviewRecord[],
    private readonly nowFn: () => number,
  ) {}

  static async open(
    filePath: string,
    nowFn: () => number = Date.now,
  ): Promise<ReviewRegistry> {
    let records: ReviewRecord[] = [];
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistShape;
      if (Array.isArray(parsed.reviews)) records = parsed.reviews;
    } catch {
      // Missing/corrupt file → start empty. First register() persists it.
    }
    return new ReviewRegistry(filePath, records, nowFn);
  }

  async register(input: {
    sessionId: string;
    target: ReviewTarget;
    comment: boolean;
    autofix: boolean;
    approvalLeg: 'vote' | 'auto';
    triggeredByTokenId: string;
  }): Promise<ReviewRecord> {
    const rec: ReviewRecord = {
      reviewId: randomUUID(),
      sessionId: input.sessionId,
      target: input.target,
      comment: input.comment,
      autofix: input.autofix,
      approvalLeg: input.approvalLeg,
      status: 'running',
      reportPath: null,
      summary: null,
      triggeredByTokenId: input.triggeredByTokenId,
      triggeredAt: new Date(this.nowFn()).toISOString(),
      finishedAt: null,
    };
    this.records.push(rec);
    await this.persist();
    return { ...rec };
  }

  get(reviewId: string): ReviewRecord | undefined {
    const r = this.records.find((x) => x.reviewId === reviewId);
    return r ? { ...r } : undefined;
  }

  /**
   * The record backing `sessionId`. When a session id was reused (an earlier
   * review on it already terminal), the non-terminal record wins so lifecycle
   * events land on the live review.
   */
  findBySessionId(sessionId: string): ReviewRecord | undefined {
    const matches = this.records.filter((r) => r.sessionId === sessionId);
    const live = matches.find((r) => !TERMINAL_REVIEW_STATUSES.has(r.status));
    const r = live ?? matches[matches.length - 1];
    return r ? { ...r } : undefined;
  }

  list(filter: { status?: ReviewStatus } = {}): ReviewRecord[] {
    return this.records
      .filter((r) => filter.status === undefined || r.status === filter.status)
      .map((r) => ({ ...r }));
  }

  /**
   * Transition a record's status. Returns false (and changes nothing) when
   * the id is unknown OR the record is already terminal, so callers can gate
   * frame emission on the return value. Stamps `finishedAt` when entering a
   * terminal status.
   */
  async setStatus(reviewId: string, status: ReviewStatus): Promise<boolean> {
    const r = this.records.find((x) => x.reviewId === reviewId);
    if (!r || TERMINAL_REVIEW_STATUSES.has(r.status)) return false;
    r.status = status;
    if (TERMINAL_REVIEW_STATUSES.has(status)) {
      r.finishedAt = new Date(this.nowFn()).toISOString();
    }
    await this.persist();
    return true;
  }

  async setReport(
    reviewId: string,
    reportPath: string | null,
    summary: ReviewRecord['summary'],
  ): Promise<void> {
    const r = this.records.find((x) => x.reviewId === reviewId);
    if (!r) return;
    r.reportPath = reportPath;
    r.summary = summary;
    await this.persist();
  }

  /**
   * Startup reconciliation: every `running` or `blocked` record whose
   * session is NOT in `liveSessionIds` becomes `orphaned` (surfaced, never
   * silently dropped). Returns the orphaned review ids. Single persist after
   * all stamps.
   */
  async reconcile(liveSessionIds: readonly string[]): Promise<string[]> {
    const live = new Set(liveSessionIds);
    const orphaned: string[] = [];
    const finishedAt = new Date(this.nowFn()).toISOString();
    for (const r of this.records) {
      if (TERMINAL_REVIEW_STATUSES.has(r.status)) continue;
      if (live.has(r.sessionId)) continue;
      r.status = 'orphaned';
      r.finishedAt = finishedAt;
      orphaned.push(r.reviewId);
    }
    if (orphaned.length > 0) await this.persist();
    return orphaned;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const body: PersistShape = { reviews: this.records };
    await writeFile(this.filePath, JSON.stringify(body, null, 2), {
      mode: 0o600,
    });
  }
}
