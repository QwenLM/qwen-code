/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatRecord } from '../services/chatRecordingService.js';

/**
 * A break in the persisted parentUuid chain: a record whose `parentUuid` is
 * non-null but points at a uuid that does not exist anywhere in the file.
 *
 * This happens when a middle segment of the session log is physically lost
 * (storage rollback, relocation, or a dropped write) while later turns keep
 * referencing the now-missing tail. Walking the chain from the newest leaf
 * stops dead at such a break, silently dropping every record before it.
 *
 * When gap bridging is enabled, {@link buildOrderedUuidChain} stitches the
 * newest still-present *earlier* island back on and records the break here so
 * the surface can render a visible "history gap" marker instead of pretending
 * the two halves are contiguous.
 */
export interface HistoryGap {
  /** The record whose parent was missing (the UI anchors the divider here). */
  childUuid: string;
  /** The parentUuid value that could not be found in the file. */
  missingParentUuid: string;
  /** Leaf uuid of the island we bridged onto, or null if none was available. */
  bridgedToUuid: string | null;
  /** Absolute time delta between the two islands, for UI copy. */
  approxLostMs?: number;
}

export interface OrderedChainResult {
  /** Uuids in root→leaf order. */
  uuids: string[];
  /** Detected chain breaks, in root→leaf order. Empty for healthy sessions. */
  gaps: HistoryGap[];
}

export interface BuildOrderedChainOptions {
  /** Start the walk from this uuid instead of the last physical record. */
  leafUuid?: string;
  /**
   * When true, a walk that terminates on a *missing* parent is repaired by
   * stitching the newest still-present earlier connected component on, rather
   * than truncating. Off by default so callers that want the raw active
   * branch (e.g. fork) keep today's behavior exactly.
   */
  bridgeGaps?: boolean;
}

/**
 * Linearizes tree-structured session records into an ordered uuid chain by
 * walking `parentUuid` back from the newest leaf.
 *
 * The healthy path is byte-for-byte identical to the historical walk: start at
 * the last physical record (= newest append), follow `parentUuid` to a null
 * root. Connected components are only computed if a gap is actually hit, so
 * there is zero added cost for well-formed sessions.
 *
 * Safety (only stitches genuine data-loss gaps, never rewind branches):
 *  - Stitching triggers ONLY when the walk stops on a non-null parent that is
 *    absent from the record set. A rewind abandoned-branch's records are all
 *    present, so the walk reaches a null root and never enters this path.
 *  - The stitch target must live in a *different connected component* than the
 *    tail. Abandoned rewind branches share an ancestor with the tail (same
 *    component) and are therefore excluded.
 *  - Selection is by file position (append order), consistent with the
 *    last-physical-record leaf choice and immune to clock skew.
 */
export function buildOrderedUuidChain(
  records: ChatRecord[],
  opts?: BuildOrderedChainOptions,
): OrderedChainResult {
  if (records.length === 0) return { uuids: [], gaps: [] };

  const bridgeGaps = opts?.bridgeGaps ?? false;

  // First record per uuid (matches the historical `recordsForUuid[0]`
  // semantics) and the file position of each uuid (append order → highest
  // index is the most recent write).
  const firstByUuid = new Map<string, ChatRecord>();
  const posByUuid = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!firstByUuid.has(r.uuid)) firstByUuid.set(r.uuid, r);
    posByUuid.set(r.uuid, i);
  }

  const uuids: string[] = [];
  const gaps: HistoryGap[] = [];
  const visited = new Set<string>();

  // Lazily computed on the first gap; healthy sessions never pay for this.
  let components: Map<string, number> | null = null;
  const stitchedComps = new Set<number>();

  let currentUuid: string | null =
    opts?.leafUuid ?? records[records.length - 1].uuid;

  // The tail's sidechain-ness. Stitch targets must match it (see
  // pickStitchTarget) so a main session never bridges onto a subagent leaf,
  // while a pure-sidechain transcript (e.g. a background-agent JSONL, where
  // every record is isSidechain) can still bridge within itself.
  const leafIsSidechain = !!firstByUuid.get(currentUuid)?.isSidechain;

  while (currentUuid) {
    if (visited.has(currentUuid)) break; // cycle guard (partial transcript)
    visited.add(currentUuid);
    uuids.push(currentUuid);

    const rec = firstByUuid.get(currentUuid);
    if (!rec) break; // leaf uuid not backed by a record (e.g. bad leafUuid)

    const parent = rec.parentUuid;
    if (!parent) break; // reached a real root

    if (firstByUuid.has(parent)) {
      currentUuid = parent; // normal step
      continue;
    }

    // GAP: parent is set but physically missing from the file.
    if (!bridgeGaps) break;

    // A `rewind` record deliberately re-roots the chain. If a rewind is
    // performed on an already-corrupted session, the rewind record can inherit
    // the missing parentUuid and itself become the gap child. Bridging here
    // would stitch the previous physical branch — i.e. resurrect exactly the
    // turns the user rewound away. Treat a rewind gap child as a clean barrier
    // instead: stop without stitching and without emitting a gap marker (the
    // re-root is intentional, not lost history).
    if (rec.subtype === 'rewind') break;

    if (components === null) {
      components = computeComponents(records, firstByUuid);
      const tailComp = components.get(uuids[0]);
      if (tailComp !== undefined) stitchedComps.add(tailComp);
    }

    const childPos = posByUuid.get(currentUuid) ?? records.length;
    const targetUuid = pickStitchTarget(
      records,
      components,
      stitchedComps,
      childPos,
      leafIsSidechain,
    );

    if (!targetUuid) {
      gaps.push({
        childUuid: currentUuid,
        missingParentUuid: parent,
        bridgedToUuid: null,
      });
      break;
    }

    const targetRec = firstByUuid.get(targetUuid)!;
    gaps.push({
      childUuid: currentUuid,
      missingParentUuid: parent,
      bridgedToUuid: targetUuid,
      approxLostMs: absTimeDeltaMs(targetRec, rec),
    });

    const targetComp = components.get(targetUuid);
    if (targetComp !== undefined) stitchedComps.add(targetComp);
    currentUuid = targetUuid; // walk into the stitched island
  }

  uuids.reverse();
  gaps.reverse();
  return { uuids, gaps };
}

/**
 * Highest-position record strictly below `childPos` whose connected component
 * has not already been consumed. Because everything between that record and
 * the child is in an already-stitched (or tail) component, this record is
 * exactly the preceding island's tail. Only records whose sidechain-ness
 * matches the tail are eligible, so a main session never bridges onto a
 * subagent leaf, while a pure-sidechain transcript can still bridge internally.
 */
function pickStitchTarget(
  records: ChatRecord[],
  components: Map<string, number>,
  stitchedComps: Set<number>,
  childPos: number,
  leafIsSidechain: boolean,
): string | null {
  for (let i = Math.min(childPos, records.length) - 1; i >= 0; i--) {
    const r = records[i];
    if (!!r.isSidechain !== leafIsSidechain) continue;
    const comp = components.get(r.uuid);
    if (comp === undefined || stitchedComps.has(comp)) continue;
    return r.uuid;
  }
  return null;
}

/**
 * Union-find over present parent edges. Two records are in the same component
 * iff they are connected through parentUuid links that both exist in the file.
 * Returns a uuid→componentId map.
 */
function computeComponents(
  records: ChatRecord[],
  firstByUuid: Map<string, ChatRecord>,
): Map<string, number> {
  const parent = new Map<string, string>();
  for (const r of records) {
    if (!parent.has(r.uuid)) parent.set(r.uuid, r.uuid);
  }

  const find = (x: string): string => {
    let root = x;
    let hop = parent.get(root)!;
    while (hop !== root) {
      root = hop;
      hop = parent.get(root)!;
    }
    // Path compression.
    let cur = x;
    while (parent.get(cur)! !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };

  for (const r of records) {
    if (r.parentUuid && firstByUuid.has(r.parentUuid)) {
      const ra = find(r.uuid);
      const rb = find(r.parentUuid);
      if (ra !== rb) parent.set(ra, rb);
    }
  }

  const comp = new Map<string, number>();
  const idByRoot = new Map<string, number>();
  let nextId = 0;
  for (const r of records) {
    const root = find(r.uuid);
    let id = idByRoot.get(root);
    if (id === undefined) {
      id = nextId++;
      idByRoot.set(root, id);
    }
    comp.set(r.uuid, id);
  }
  return comp;
}

function absTimeDeltaMs(a: ChatRecord, b: ChatRecord): number | undefined {
  const ta = Date.parse(a.timestamp);
  const tb = Date.parse(b.timestamp);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return undefined;
  return Math.abs(tb - ta);
}
