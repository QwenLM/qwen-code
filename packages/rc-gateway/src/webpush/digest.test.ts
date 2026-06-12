/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { PushDigest } from './digest.js';

describe('PushDigest', () => {
  it('accumulates per (subscription, kind) and summarizes totals', () => {
    const d = new PushDigest();
    d.record('s1', 'task.completed');
    d.record('s1', 'task.completed');
    d.record('s1', 'permission.required');
    d.record('s2', 'task.completed');
    const sum = d
      .summary()
      .sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId));
    expect(sum).toEqual([
      {
        subscriptionId: 's1',
        total: 3,
        byKind: { 'task.completed': 2, 'permission.required': 1 },
      },
      { subscriptionId: 's2', total: 1, byKind: { 'task.completed': 1 } },
    ]);
  });

  it('summary is empty when nothing has been recorded', () => {
    expect(new PushDigest().summary()).toEqual([]);
  });

  it('forget drops a subscription from the summary', () => {
    const d = new PushDigest();
    d.record('s1', 'k');
    d.record('s2', 'k');
    d.forget('s1');
    expect(d.summary()).toEqual([
      { subscriptionId: 's2', total: 1, byKind: { k: 1 } },
    ]);
  });

  it('summaryFor returns one subscription, null when nothing pending', () => {
    const d = new PushDigest();
    d.record('s1', 'task.completed');
    d.record('s1', 'permission.required');
    expect(d.summaryFor('s1')).toEqual({
      subscriptionId: 's1',
      total: 2,
      byKind: { 'task.completed': 1, 'permission.required': 1 },
    });
    expect(d.summaryFor('absent')).toBeNull();
    d.forget('s1');
    expect(d.summaryFor('s1')).toBeNull();
  });
});
