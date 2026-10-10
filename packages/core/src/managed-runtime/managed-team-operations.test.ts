/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isTeamStateStart,
  isTeamStateSuccessor,
  isTeamTaskStart,
  isTeamTaskSuccessor,
} from './managed-team-record.js';
import {
  openTeamTaskBlockers,
  sanitizeTeamName,
  teamJoinBody,
  teamLifecycleBody,
  teamOpenBody,
  teamTaskOpenBody,
  teamTaskReaches,
  teamTaskRecordId,
  teamTaskReviseBody,
} from './managed-team-operations.js';

const REF = {
  resourceId: 'description-1',
  kind: 'managed-team-content',
  schemaVersion: 1,
  byteLength: 5,
  digest: 'a'.repeat(64),
};

describe('managed team operations (H4e-b1)', () => {
  it('sanitizes names with the Legacy rule', () => {
    expect(sanitizeTeamName('Review Team!')).toBe('review-team');
    expect(sanitizeTeamName('--a__b--')).toBe('a-b');
    expect(sanitizeTeamName('!!!')).toBe('');
  });

  it('builds a team chain the record contract accepts step by step', () => {
    const opened = teamOpenBody({
      teamId: 'team-1',
      name: 'review',
      leadSessionId: 'session-lead',
    });
    expect(isTeamStateStart(opened)).toBe(true);
    const joined = teamJoinBody(opened, { name: 'alice', childRunId: 'run-1' });
    expect(joined).toMatchObject({
      membershipRevision: 2,
      members: [
        { name: 'alice', childRunId: 'run-1', planModeRequired: false },
      ],
    });
    const closing = teamLifecycleBody(joined, 'closing');
    const deleted = teamLifecycleBody(closing, 'deleted');
    expect(deleted.run.state).toBe('cancelled');
    for (const [before, after] of [
      [opened, joined],
      [joined, closing],
      [closing, deleted],
    ])
      expect(isTeamStateSuccessor(before, after)).toBe(true);
  });

  it('builds task revisions that keep edges once and freeze at deletion', () => {
    const task = teamTaskOpenBody({
      teamId: 'team-1',
      number: 2,
      subject: 'Fix',
      descriptionRef: REF,
      activeForm: null,
      metadataRef: null,
    });
    expect(task.taskId).toBe(teamTaskRecordId('team-1', 2));
    expect(isTeamTaskStart(task)).toBe(true);
    const blocked = teamTaskReviseBody(task, {
      addBlockedBy: ['team-1#1', 'team-1#1'],
    });
    expect(blocked.blockedBy).toEqual(['team-1#1']);
    // The same edge again is no change at all.
    expect(teamTaskReviseBody(blocked, { addBlockedBy: ['team-1#1'] })).toEqual(
      blocked,
    );
    const owned = teamTaskReviseBody(blocked, {
      status: 'in_progress',
      owner: 'alice',
    });
    const deleted = teamTaskReviseBody(owned, { status: 'deleted' });
    expect(deleted.run.state).toBe('cancelled');
    for (const [before, after] of [
      [task, blocked],
      [blocked, owned],
      [owned, deleted],
    ])
      expect(isTeamTaskSuccessor(before, after)).toBe(true);
    expect(() => teamTaskReviseBody(task, { status: 'in_progress' })).toThrow(
      'Team task in progress must have an owner',
    );
  });

  it('reads blocking from the blockers and finds a path along edges', () => {
    const open = (number: number, status: 'pending' | 'completed') =>
      teamTaskReviseBody(
        teamTaskOpenBody({
          teamId: 'team-1',
          number,
          subject: `T${number}`,
          descriptionRef: REF,
          activeForm: null,
          metadataRef: null,
        }),
        status === 'completed' ? { status } : {},
      );
    const first = open(1, 'completed');
    const second = open(2, 'pending');
    const third = teamTaskReviseBody(open(3, 'pending'), {
      addBlockedBy: [first.taskId, second.taskId],
    });
    const tasks = new Map(
      [first, second, third].map((each) => [each.taskId, each]),
    );
    expect(
      openTeamTaskBlockers(third, tasks).map((each) => each.number),
    ).toEqual([2]);
    const edges = new Map([[third.taskId, third.blockedBy]]);
    const blockedByOf = (taskId: string) => edges.get(taskId) ?? [];
    expect(teamTaskReaches(third.taskId, second.taskId, blockedByOf)).toBe(
      true,
    );
    expect(teamTaskReaches(second.taskId, third.taskId, blockedByOf)).toBe(
      false,
    );
  });
});
