/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Trajectory,
  TrajectoryRow,
  TrajectoryTurn,
  TrajectoryToolRow,
  TrajectoryRequestRow,
} from './types';

export type TrajectoryVisualRow =
  | { kind: 'turn'; key: string; turn: TrajectoryTurn }
  | { kind: 'row'; key: string; row: TrajectoryRow };

export interface TrajectoryLayout {
  rows: TrajectoryVisualRow[];
  ancestors: Map<string, string[]>;
  groups: Set<string>;
  groupIdentities: Map<string, string>;
  unresolvedParents: Set<string>;
}

function persistentIdentity(row: TrajectoryRow): string | undefined {
  if (row.kind === 'request') {
    if (row.recordId !== undefined) return `request-record:${row.recordId}`;
    if (row.responseId !== undefined)
      return `request-response:${row.responseId}`;
  }
  if (row.kind === 'user') {
    if (row.block.segmentId !== undefined)
      return `user-segment:${row.block.segmentId}`;
    const recordId = row.block.sourceRecordIds?.[0];
    if (recordId !== undefined) return `user-record:${recordId}`;
  }
  return undefined;
}

function parentReferences(
  row: TrajectoryRow,
): [string | undefined, string | undefined] {
  return [
    row.kind === 'request'
      ? row.parentToolCallId
      : 'parentToolCallId' in row.block
        ? row.block.parentToolCallId
        : undefined,
    row.kind !== 'request' && 'parentBlockId' in row.block
      ? row.block.parentBlockId
      : undefined,
  ];
}

export function buildTrajectoryLayout(
  trajectory: Trajectory,
): TrajectoryLayout {
  const rows: TrajectoryVisualRow[] = [];
  const ancestors = new Map<string, string[]>();
  const groups = new Set<string>();
  const groupIdentities = new Map<string, string>();
  const unresolvedParents = new Set<string>();
  const byKey = new Map(trajectory.rows.map((row) => [row.key, row]));
  const uniqueIdentities = new Map<string, string | undefined>();
  for (const row of trajectory.rows) {
    const identity = persistentIdentity(row);
    if (identity !== undefined)
      uniqueIdentities.set(
        identity,
        uniqueIdentities.has(identity) ? undefined : row.key,
      );
  }
  for (const turn of trajectory.turns) {
    const turnKey = `turn:${turn.userRowKey ?? `ordinal:${turn.index}`}`;
    const members = turn.rowKeys.flatMap((key) => {
      const row = byKey.get(key);
      return row ? [row] : [];
    });
    const requests = new Map<number, TrajectoryRequestRow | undefined>();
    const toolsByCall = new Map<string, TrajectoryToolRow[]>();
    const toolsByBlock = new Map<string, TrajectoryToolRow[]>();
    for (const row of members) {
      if (
        row.kind === 'request' &&
        row.depth === 0 &&
        row.requestIndex !== undefined
      )
        requests.set(
          row.requestIndex,
          requests.has(row.requestIndex) ? undefined : row,
        );
      if (row.kind === 'tool') {
        const call = row.block.toolCallId;
        const calls = toolsByCall.get(call);
        if (calls) calls.push(row);
        else toolsByCall.set(call, [row]);
        const block = row.block.id;
        const blocks = toolsByBlock.get(block);
        if (blocks) blocks.push(row);
        else toolsByBlock.set(block, [row]);
      }
    }
    const groupOf = (row: TrajectoryRow): string | undefined =>
      row.requestIndex === undefined
        ? undefined
        : requests.get(row.requestIndex)?.key;
    const parentOf = (
      callId: string | undefined,
      blockId: string | undefined,
    ): TrajectoryToolRow | undefined => {
      const candidates =
        callId !== undefined
          ? (toolsByCall.get(callId) ?? [])
          : blockId !== undefined
            ? (toolsByBlock.get(blockId) ?? [])
            : [];
      const matching =
        blockId !== undefined && callId !== undefined
          ? candidates.filter((tool) => tool.block.id === blockId)
          : candidates;
      return matching.length === 1 ? matching[0] : undefined;
    };
    const toolGroups = new Map<string, string | undefined>();
    const resolveGroup = (row: TrajectoryRow): string | undefined => {
      const path: TrajectoryToolRow[] = [];
      const visited = new Set<string>();
      let current: TrajectoryRow | undefined = row;
      let group: string | undefined;
      while (current) {
        if (current.kind === 'tool' && toolGroups.has(current.key)) {
          group = toolGroups.get(current.key);
          break;
        }
        if (visited.has(current.key)) break;
        visited.add(current.key);
        if (current.kind === 'tool') path.push(current);
        const [callId, blockId] = parentReferences(current);
        const hasParent = callId !== undefined || blockId !== undefined;
        if (!hasParent) {
          if (current.depth === 0) group = groupOf(current);
          break;
        }
        current = parentOf(callId, blockId);
      }
      for (const tool of path) toolGroups.set(tool.key, group);
      return group;
    };
    rows.push({ kind: 'turn', key: turnKey, turn });
    if (members.length > 0) groups.add(turnKey);
    for (const row of members) {
      const requestKey = row.kind === 'user' ? undefined : resolveGroup(row);
      if (
        requestKey === undefined &&
        (row.depth > 0 || parentReferences(row).some((id) => id !== undefined))
      )
        unresolvedParents.add(row.key);
      const parents = [turnKey];
      if (requestKey !== undefined && requestKey !== row.key) {
        parents.push(requestKey);
        groups.add(requestKey);
      }
      ancestors.set(row.key, parents);
      rows.push({ kind: 'row', key: row.key, row });
    }
    for (const row of members) {
      const identity = persistentIdentity(row);
      if (identity === undefined || uniqueIdentities.get(identity) !== row.key)
        continue;
      const key = row.key === turn.userRowKey ? turnKey : row.key;
      if (groups.has(key)) groupIdentities.set(key, identity);
    }
  }
  return { rows, ancestors, groups, groupIdentities, unresolvedParents };
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
