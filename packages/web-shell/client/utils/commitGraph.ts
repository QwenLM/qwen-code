/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** A line segment drawn across one row, addressed by lane index. */
export interface CommitGraphLine {
  column: number;
  color: number;
}

export interface CommitGraphRow {
  /** Lane holding this commit's node. */
  column: number;
  /** Colour index of the node and of the lane it continues. */
  color: number;
  /** Lanes entering the node from the row above (own lane and merged children). */
  incoming: CommitGraphLine[];
  /** Lanes leaving the node toward the row below (one per parent). */
  outgoing: CommitGraphLine[];
  /** Lanes that cross this row without touching the node. */
  through: CommitGraphLine[];
  /** Lanes still open below this row; drawn straight through expanded rows. */
  after: CommitGraphLine[];
  /** Highest lane index touched on this row plus one. */
  width: number;
}

interface Lane {
  sha: string;
  color: number;
}

function firstFree(lanes: Array<Lane | null>): number {
  const free = lanes.indexOf(null);
  return free === -1 ? lanes.length : free;
}

/**
 * Lay out commits (newest first, parents never before children) into lanes.
 *
 * Each lane waits for one commit. A commit takes the lowest lane waiting for
 * it, or a fresh lane when none is; every other lane waiting for it merges in
 * at its node, so a mainline never jogs sideways to meet a fork. Its first
 * parent continues the lane; further parents each get the lane already
 * waiting for them or a new one.
 */
export function layoutCommitGraph(
  entries: ReadonlyArray<{ sha: string; parents: string[] }>,
): CommitGraphRow[] {
  const lanes: Array<Lane | null> = [];
  let nextColor = 0;
  const rows: CommitGraphRow[] = [];

  for (const entry of entries) {
    const found = lanes.findIndex((lane) => lane?.sha === entry.sha);
    const column = found === -1 ? firstFree(lanes) : found;
    const color = found === -1 ? nextColor++ : lanes[found]!.color;

    const incoming: CommitGraphLine[] = [];
    const through: CommitGraphLine[] = [];
    lanes.forEach((lane, index) => {
      if (!lane) return;
      if (lane.sha === entry.sha) {
        incoming.push({ column: index, color: lane.color });
        lanes[index] = null;
      } else {
        through.push({ column: index, color: lane.color });
      }
    });

    const outgoing: CommitGraphLine[] = [];
    entry.parents.forEach((parent, parentIndex) => {
      if (parentIndex === 0) {
        lanes[column] = { sha: parent, color };
        outgoing.push({ column, color });
        return;
      }
      const existing = lanes.findIndex((lane) => lane?.sha === parent);
      if (existing !== -1) {
        outgoing.push({ column: existing, color: lanes[existing]!.color });
      } else {
        const fresh = firstFree(lanes);
        const freshColor = nextColor++;
        lanes[fresh] = { sha: parent, color: freshColor };
        outgoing.push({ column: fresh, color: freshColor });
      }
    });

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    const after: CommitGraphLine[] = [];
    lanes.forEach((lane, index) => {
      if (lane) after.push({ column: index, color: lane.color });
    });
    const width =
      1 +
      Math.max(
        column,
        ...incoming.map((l) => l.column),
        ...outgoing.map((l) => l.column),
        ...through.map((l) => l.column),
      );
    rows.push({ column, color, incoming, outgoing, through, after, width });
  }
  return rows;
}
