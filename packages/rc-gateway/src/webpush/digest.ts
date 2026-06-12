/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** A per-subscription summary of pushes suppressed while in quiet hours. */
export interface DigestSummary {
  subscriptionId: string;
  /** Total suppressed across all kinds. */
  total: number;
  /** Per-kind suppressed counts. */
  byKind: Record<string, number>;
}

/**
 * Tracks pushes suppressed during a subscription's quiet hours, per
 * `(subscriptionId, kind)` — the "what you missed while away" accumulation
 * behind design D4. PURE in-memory bookkeeping: `record` only counts, it never
 * suppresses anything (the suppression already happened in the notifier), so
 * unlike the coalescer this is ALWAYS-ON with no fail-closed risk. Every method
 * is total (no I/O, never throws).
 *
 * Bounded by (#subscriptions x #kinds), and `forget` drops a subscription on
 * unsubscribe, so it never grows without bound.
 */
export class PushDigest {
  private readonly counts = new Map<string, Map<string, number>>();

  /** Increment the suppressed-during-quiet count for (subId, kind). */
  record(subId: string, kind: string): void {
    let byKind = this.counts.get(subId);
    if (!byKind) {
      byKind = new Map();
      this.counts.set(subId, byKind);
    }
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }

  /** One summary per subscription with a pending count (empty when nothing pending). */
  summary(): DigestSummary[] {
    const out: DigestSummary[] = [];
    for (const [subscriptionId, byKindMap] of this.counts) {
      const byKind: Record<string, number> = {};
      let total = 0;
      for (const [kind, n] of byKindMap) {
        byKind[kind] = n;
        total += n;
      }
      if (total > 0) out.push({ subscriptionId, total, byKind });
    }
    return out;
  }

  /** Pending summary for ONE subscription, or null when nothing is pending. */
  summaryFor(subId: string): DigestSummary | null {
    const byKindMap = this.counts.get(subId);
    if (!byKindMap) return null;
    const byKind: Record<string, number> = {};
    let total = 0;
    for (const [kind, n] of byKindMap) {
      byKind[kind] = n;
      total += n;
    }
    if (total <= 0) return null;
    return { subscriptionId: subId, total, byKind };
  }

  /** Drop a subscription's pending counts (on unsubscribe). */
  forget(subId: string): void {
    this.counts.delete(subId);
  }
}
