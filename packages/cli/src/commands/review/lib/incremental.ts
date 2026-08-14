/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The `incremental` block an incrementally-scoped plan carries. Two producers
// write it — `rescope` (PR flow, commit anchor) and `capture-local` (local
// flow, content anchor) — and every consumer (chunk briefs, whole-diff briefs,
// the orchestrator's summary) reads one shape, so the block lives here rather
// than in either producer.

export interface IncrementalScope {
  /**
   * What the scope is measured FROM: a commit sha on the PR flow, a
   * content-addressed state id on the local flow. Display-only downstream —
   * briefs render its first 12 characters.
   */
  anchor: string;
  /** Files changed since the anchor — reviewed on their hunks, in full. */
  deltaFiles: string[];
  /**
   * Still-clean files pulled back in by the one-hop widening, each with the
   * changed files it imports — the seam its brief directs the agent at.
   */
  interaction: Array<{ path: string; importsChanged: string[] }>;
  /**
   * How many still-clean files this scope leaves out. A count, not a list:
   * nothing downstream reads the names, and on a large plan the list alone
   * measured 23 KB against the plan's one-read budget.
   */
  contextFileCount: number;
  /** Where the full-range diff still is, for a reader who needs all of it. */
  fullDiffPath: string | null;
}
