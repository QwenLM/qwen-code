/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { parseSubagentsSnapshot } from './types.js';

const task = {
  id: 'job:1',
  kind: 'harness',
  status: 'running',
  title: 'Task',
  request: 'Request',
  createdAt: 0,
  updatedAt: 0,
  activity: '',
  output: '',
  events: [],
};
const snapshot = {
  revision: 1,
  omitted: 0,
  counts: {
    running: 1,
    completed: 0,
    needsAttention: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
  },
  tasks: [task],
};
describe('subagent snapshot identity and value validation', () => {
  it('rejects coerced enums and duplicate task ids', () => {
    expect(parseSubagentsSnapshot(snapshot)).toBeDefined();
    for (const invalid of [
      { ...task, kind: ['harness'] },
      { ...task, notification: ['delivered'] },
      { ...task, events: [{ at: 0, text: 'x', kind: ['status'] }] },
    ])
      expect(
        parseSubagentsSnapshot({ ...snapshot, tasks: [invalid] }),
      ).toBeUndefined();
    expect(
      parseSubagentsSnapshot({
        ...snapshot,
        tasks: [task, { ...task, title: 'Other task' }],
      }),
    ).toBeUndefined();
  });
});
