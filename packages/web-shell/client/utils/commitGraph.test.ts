/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { layoutCommitGraph } from './commitGraph';

const c = (sha: string, ...parents: string[]) => ({ sha, parents });

describe('layoutCommitGraph', () => {
  it('keeps a linear history in one lane with one colour', () => {
    const rows = layoutCommitGraph([c('c', 'b'), c('b', 'a'), c('a')]);
    expect(rows.map((r) => r.column)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.color)).toEqual([0, 0, 0]);
    expect(rows[0].incoming).toEqual([]);
    expect(rows[0].outgoing).toEqual([{ column: 0, color: 0 }]);
    expect(rows[1].incoming).toEqual([{ column: 0, color: 0 }]);
    expect(rows[2].outgoing).toEqual([]);
    expect(rows[2].after).toEqual([]);
    expect(rows.every((r) => r.width === 1)).toBe(true);
  });

  it('opens a second lane for a merge and closes it at the fork point', () => {
    // m merges f into main; both descend from base.
    const rows = layoutCommitGraph([
      c('m', 'main1', 'f'),
      c('f', 'base'),
      c('main1', 'base'),
      c('base'),
    ]);
    const [merge, feature, main1, base] = rows;
    expect(merge.column).toBe(0);
    expect(merge.outgoing).toEqual([
      { column: 0, color: 0 },
      { column: 1, color: 1 },
    ]);
    expect(merge.width).toBe(2);
    expect(feature.column).toBe(1);
    expect(feature.color).toBe(1);
    expect(feature.through).toEqual([{ column: 0, color: 0 }]);
    expect(feature.outgoing).toEqual([{ column: 1, color: 1 }]);
    expect(main1.column).toBe(0);
    expect(main1.through).toEqual([{ column: 1, color: 1 }]);
    expect(main1.width).toBe(2);
    // Both lanes wait for base; they converge on the lowest one at its node.
    expect(base.column).toBe(0);
    expect(base.incoming).toEqual([
      { column: 0, color: 0 },
      { column: 1, color: 1 },
    ]);
    expect(base.after).toEqual([]);
  });

  it('merges every lane waiting for a commit into its node', () => {
    // Two branch tips share the same parent.
    const rows = layoutCommitGraph([c('x', 'p'), c('y', 'p'), c('p')]);
    expect(rows[1].column).toBe(1);
    expect(rows[1].outgoing).toEqual([{ column: 1, color: 1 }]);
    expect(rows[2].column).toBe(0);
    expect(rows[2].incoming).toEqual([
      { column: 0, color: 0 },
      { column: 1, color: 1 },
    ]);
    expect(rows[2].through).toEqual([]);
  });

  it('reuses freed lanes before opening new ones', () => {
    const rows = layoutCommitGraph([
      c('a', 'b'),
      c('t1', 'old'),
      c('b', 'c'),
      c('t2', 'old2'),
      c('c'),
    ]);
    expect(rows.map((r) => r.column)).toEqual([0, 1, 0, 2, 0]);
    // c has no parents: lane 0 closes and the trailing lanes stay open.
    expect(rows[4].after).toEqual([
      { column: 1, color: 1 },
      { column: 2, color: 2 },
    ]);
  });

  it('gives an unseen parent of a merge a fresh lane and colour', () => {
    const rows = layoutCommitGraph([c('m', 'a', 'b'), c('a'), c('b')]);
    expect(rows[0].outgoing).toEqual([
      { column: 0, color: 0 },
      { column: 1, color: 1 },
    ]);
    expect(rows[2].column).toBe(1);
    expect(rows[2].color).toBe(1);
  });
});
