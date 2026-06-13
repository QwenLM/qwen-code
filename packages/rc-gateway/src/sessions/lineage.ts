/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ForkRecord } from './forkTranscript.js';

/** One node in a lineage chain — just the session id (no name/event stored). */
export interface LineageNode {
  sessionId: string;
  /** Human title (core `custom_title`), when set. Enriched by the route. */
  title?: string;
}

/**
 * The chain from a queried session up to its root ancestor. `chain[0]` is the
 * queried session itself, then its parent, grandparent, ... root. `truncated`
 * is true when the walk stopped early (depth cap, a cycle, an invalid parent
 * id, or a referenced-but-missing parent transcript) rather than reaching a
 * genuine root.
 */
export interface LineageResult {
  sessionId: string;
  chain: LineageNode[];
  truncated: boolean;
}

/** Hard cap on how many ancestors a single walk will follow (design threat model). */
export const MAX_LINEAGE_DEPTH = 100;

/**
 * Extract a session's parent id from its transcript: the FIRST record's
 * `forkedFrom.sessionId`. Our fork writer (`forkTranscript.forkRecords`, which
 * replicates core `SessionService.forkSession`) stamps `forkedFrom` on every
 * record uniformly, so the first record is authoritative — its absence means
 * the session is a root. Returns null for a root, a missing/empty transcript,
 * or a malformed `forkedFrom` (no string `sessionId`).
 */
export function parentOf(records: ForkRecord[] | null): string | null {
  if (!records || records.length === 0) return null;
  const forkedFrom = records[0]['forkedFrom'];
  if (forkedFrom && typeof forkedFrom === 'object') {
    const sid = (forkedFrom as Record<string, unknown>)['sessionId'];
    if (typeof sid === 'string') return sid;
  }
  return null;
}

export interface WalkLineageOpts {
  /** Reads a session's parsed transcript records; null = transcript absent. */
  readRecords: (id: string) => Promise<ForkRecord[] | null>;
  /** Session-id shape guard; an id failing this never reaches the filesystem. */
  isValidId: (id: string) => boolean;
  /** Ancestor cap; defaults to {@link MAX_LINEAGE_DEPTH}. */
  maxDepth?: number;
}

/**
 * Walk a session's fork lineage to its root by following each transcript's
 * first-record `forkedFrom.sessionId`. Pure over an injected `readRecords` so
 * the cap/cycle/truncate/root logic is unit-tested without touching disk.
 *
 * Returns null when the START transcript is missing (the route maps that to a
 * 404). Otherwise returns the chain (self first). A node is appended only after
 * its transcript reads successfully, so a `forkedFrom` pointing at a deleted
 * parent truncates the walk WITHOUT fabricating the missing id into the chain
 * (design D4). A `visited` set + the depth cap bound a hand-edited cyclic or
 * pathologically deep chain; both set `truncated: true`.
 */
export async function walkLineage(
  startId: string,
  opts: WalkLineageOpts,
): Promise<LineageResult | null> {
  const maxDepth = opts.maxDepth ?? MAX_LINEAGE_DEPTH;
  const startRecords = await opts.readRecords(startId);
  if (startRecords === null) return null;

  const chain: LineageNode[] = [{ sessionId: startId }];
  const visited = new Set<string>([startId]);
  let truncated = false;
  let parent = parentOf(startRecords);

  while (parent !== null) {
    // Stop (truncated) before any filesystem touch on a malformed/cyclic id...
    if (!opts.isValidId(parent) || visited.has(parent)) {
      truncated = true;
      break;
    }
    // ...or once the chain has reached the cap but at least one ancestor remains.
    if (chain.length >= maxDepth) {
      truncated = true;
      break;
    }
    const records = await opts.readRecords(parent);
    if (records === null) {
      // Referenced parent transcript is gone -> truncate, don't fabricate it.
      truncated = true;
      break;
    }
    chain.push({ sessionId: parent });
    visited.add(parent);
    parent = parentOf(records);
  }

  return { sessionId: startId, chain, truncated };
}
