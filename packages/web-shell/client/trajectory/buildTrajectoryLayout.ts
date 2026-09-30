/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Trajectory, TrajectoryRow, TrajectoryTurn } from './types';

export type TrajectoryVisualRow =
  | { kind: 'turn'; key: string; turn: TrajectoryTurn }
  | { kind: 'row'; key: string; row: TrajectoryRow };

export interface TrajectoryLayout {
  rows: TrajectoryVisualRow[];
  ancestors: Map<string, string[]>;
  groups: Set<string>;
  unresolvedParents: Set<string>;
}

export function buildTrajectoryLayout(
  trajectory: Trajectory,
): TrajectoryLayout {
  const rows: TrajectoryVisualRow[] = [];
  const ancestors = new Map<string, string[]>();
  const groups = new Set<string>();
  const unresolvedParents = new Set<string>();
  const byKey = new Map(trajectory.rows.map((row) => [row.key, row]));
  for (const turn of trajectory.turns) {
    const turnKey = `turn:${turn.userRowKey ?? `ordinal:${turn.index}`}`;
    const members = turn.rowKeys.flatMap((key) => {
      const row = byKey.get(key);
      return row ? [row] : [];
    });
    const requests = members.filter(
      (row) => row.kind === 'request' && row.depth === 0,
    );
    const groupOf = (row: TrajectoryRow): string | undefined => {
      if (row.requestIndex === undefined) return undefined;
      const candidates = requests.filter(
        (request) => request.requestIndex === row.requestIndex,
      );
      return candidates.length === 1 ? candidates[0]!.key : undefined;
    };
    const mainTools = members.filter(
      (row) =>
        row.kind === 'tool' &&
        row.depth === 0 &&
        row.block.parentToolCallId === undefined &&
        row.block.parentBlockId === undefined,
    );
    rows.push({ kind: 'turn', key: turnKey, turn });
    if (members.length > 0) groups.add(turnKey);
    for (const row of members) {
      let requestKey: string | undefined;
      const callId =
        row.kind === 'request'
          ? row.parentToolCallId
          : 'parentToolCallId' in row.block
            ? row.block.parentToolCallId
            : undefined;
      const blockId =
        row.kind !== 'request' && 'parentBlockId' in row.block
          ? row.block.parentBlockId
          : undefined;
      if (callId !== undefined || blockId !== undefined || row.depth > 0) {
        const candidates = mainTools.filter(
          (parent) =>
            parent.kind === 'tool' &&
            (callId === undefined || parent.block.toolCallId === callId) &&
            (blockId === undefined || parent.block.id === blockId),
        );
        if (
          (callId !== undefined || blockId !== undefined) &&
          candidates.length === 1
        ) {
          requestKey = groupOf(candidates[0]!);
        }
        if (requestKey === undefined) unresolvedParents.add(row.key);
      } else if (row.kind !== 'user') {
        requestKey = groupOf(row);
      }
      const parents = [turnKey];
      if (requestKey !== undefined && requestKey !== row.key) {
        parents.push(requestKey);
        groups.add(requestKey);
      }
      ancestors.set(row.key, parents);
      rows.push({ kind: 'row', key: row.key, row });
    }
  }
  return { rows, ancestors, groups, unresolvedParents };
}

/** Range context is computed before collapse, so hiding never changes a hit. */
export function trajectoryRowsInRange(
  layout: TrajectoryLayout,
  inRange: ReadonlySet<string> | undefined,
): TrajectoryVisualRow[] {
  if (inRange === undefined) return layout.rows;
  const keep = new Set(inRange);
  for (const key of inRange) {
    for (const parent of layout.ancestors.get(key) ?? []) keep.add(parent);
  }
  for (const entry of layout.rows) {
    if (entry.kind === 'turn' && keep.has(entry.key) && entry.turn.userRowKey) {
      keep.add(entry.turn.userRowKey);
    }
  }
  return layout.rows.filter((entry) => keep.has(entry.key));
}

export function visibleTrajectoryRows(
  layout: TrajectoryLayout,
  rangeRows: TrajectoryVisualRow[],
  collapsed: ReadonlySet<string>,
): TrajectoryVisualRow[] {
  return rangeRows.filter(
    (entry) =>
      !(layout.ancestors.get(entry.key) ?? []).some((key) =>
        collapsed.has(key),
      ),
  );
}

export function visibleTrajectoryAncestor(
  layout: TrajectoryLayout,
  key: string,
  visible: ReadonlySet<string>,
): string | undefined {
  if (visible.has(key)) return key;
  return [...(layout.ancestors.get(key) ?? [])]
    .reverse()
    .find((parent) => visible.has(parent));
}
