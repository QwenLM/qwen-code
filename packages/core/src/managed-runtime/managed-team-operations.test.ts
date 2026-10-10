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
  type TeamTask,
} from './managed-team-record.js';
import {
  teamJoinBody,
  teamLifecycleBody,
  teamOpenBody,
  teamTaskOpenBlockers,
  teamTaskOpenBody,
  teamTaskRevisionBody,
} from './managed-team-operations.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';

const ref = (resourceId: string): ManagedSessionDurableRef => ({
  resourceId,
  kind: 'managed-team-content',
  schemaVersion: 1,
  byteLength: 12,
  digest: 'a'.repeat(64),
});

function openTask(number: number): TeamTask {
  return teamTaskOpenBody({
    teamId: 'team-1',
    taskId: `team-1#${number}`,
    number,
    subject: `Task ${number}`,
    descriptionRef: ref(`description-${number}`),
    activeForm: null,
    metadataRef: null,
  });
}

describe('team state bodies', () => {
  it('opens, joins one member per step, closes and deletes lawfully', () => {
    const opened = teamOpenBody({
      teamId: 'team-1',
      name: 'review',
      leadSessionId: 'session-1',
    });
    expect(isTeamStateStart(opened)).toBe(true);
    const alice = teamJoinBody(opened, {
      name: 'alice',
      childRunId: 'run-1',
      planModeRequired: false,
    });
    expect(alice).toMatchObject({
      membershipRevision: 2,
      members: [{ name: 'alice' }],
    });
    expect(isTeamStateSuccessor(opened, alice)).toBe(true);
    const bob = teamJoinBody(alice, {
      name: 'bob',
      childRunId: 'run-2',
      planModeRequired: false,
    });
    expect(isTeamStateSuccessor(alice, bob)).toBe(true);
    const closing = teamLifecycleBody(bob, 'closing');
    expect(closing.run.state).toBe('admitted');
    expect(isTeamStateSuccessor(bob, closing)).toBe(true);
    const deleted = teamLifecycleBody(closing, 'deleted');
    expect(deleted.run.state).toBe('cancelled');
    expect(isTeamStateSuccessor(closing, deleted)).toBe(true);
    expect(isTeamStateSuccessor(bob, deleted)).toBe(false);
  });
});

describe('team task bodies', () => {
  it('opens a pending task and revises only the given fields', () => {
    const task = openTask(1);
    expect(isTeamTaskStart(task)).toBe(true);
    expect(task).toMatchObject({
      status: 'pending',
      owner: null,
      blockedBy: [],
    });
    const started = teamTaskRevisionBody(task, {
      status: 'in_progress',
      owner: 'alice',
      subject: undefined,
    });
    expect(started).toMatchObject({
      subject: 'Task 1',
      status: 'in_progress',
      owner: 'alice',
    });
    expect(isTeamTaskSuccessor(task, started)).toBe(true);
    const unassigned = teamTaskRevisionBody(started, {
      status: 'pending',
      owner: null,
    });
    expect(unassigned.owner).toBeNull();
    expect(isTeamTaskSuccessor(started, unassigned)).toBe(true);
  });

  it('appends each new blocker once and keeps the stored ones first', () => {
    const task = teamTaskRevisionBody(openTask(3), {
      addBlockedBy: ['team-1#1'],
    });
    const next = teamTaskRevisionBody(task, {
      addBlockedBy: ['team-1#2', 'team-1#1', 'team-1#2'],
    });
    expect(next.blockedBy).toEqual(['team-1#1', 'team-1#2']);
    expect(isTeamTaskSuccessor(task, next)).toBe(true);
    expect(teamTaskRevisionBody(next, { addBlockedBy: ['team-1#2'] })).toEqual(
      next,
    );
  });

  it('ends the run on deletion, which freezes the task', () => {
    const task = openTask(1);
    const deleted = teamTaskRevisionBody(task, { status: 'deleted' });
    expect(deleted.run.state).toBe('cancelled');
    expect(isTeamTaskSuccessor(task, deleted)).toBe(true);
    expect(
      isTeamTaskSuccessor(
        deleted,
        teamTaskRevisionBody(deleted, { subject: 'Revived' }),
      ),
    ).toBe(false);
  });

  it('derives the open blockers from the blockers themselves', () => {
    const first = openTask(1);
    const second = openTask(2);
    const third = openTask(3);
    const blocked = teamTaskRevisionBody(openTask(4), {
      addBlockedBy: [first.taskId, second.taskId, third.taskId],
    });
    const board = new Map(
      [
        teamTaskRevisionBody(first, { status: 'completed' }),
        teamTaskRevisionBody(second, { status: 'deleted' }),
        third,
      ].map((task) => [task.taskId, task]),
    );
    expect(teamTaskOpenBlockers(blocked, board)).toEqual([third.taskId]);
  });
});
