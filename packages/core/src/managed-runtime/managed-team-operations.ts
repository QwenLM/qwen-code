/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionRun } from './managed-extension-record.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';
import type {
  TeamLifecycle,
  TeamMember,
  TeamState,
  TeamTask,
  TeamTaskStatus,
} from './managed-team-record.js';

// H4e-b1 of #12827: the pure construction side of the lead-side team
// runtime — every team and board revision the team funnel
// (packages/cli/src/serve/hosted-team-session.ts) commits, and the blocked
// state a reader derives from a board. See
// docs/design/2026-10-10-managed-agent-team-lead-runtime.md.

function logicalRun(state: ExtensionRun['state']): ExtensionRun {
  return Object.freeze({
    state,
    reason: null,
    definition: null,
    executionCallId: null,
    effectId: null,
    dispatchId: null,
    deliveryId: null,
    execution: null,
    runtime: null,
    delivery: null,
  });
}

/** The opening of a team: active, led by this Session, with no members. */
export function teamOpenBody(params: {
  readonly teamId: string;
  readonly name: string;
  readonly leadSessionId: string;
}): TeamState {
  return Object.freeze({
    teamId: params.teamId,
    name: params.name,
    leadSessionId: params.leadSessionId,
    lifecycle: 'active',
    membershipRevision: 1,
    members: Object.freeze([]),
    run: logicalRun('admitted'),
  });
}

/** One membership fact: the member appended to the roster. */
export function teamJoinBody(
  previous: TeamState,
  member: TeamMember,
): TeamState {
  return Object.freeze({
    ...previous,
    membershipRevision: previous.membershipRevision + 1,
    members: Object.freeze([...previous.members, Object.freeze({ ...member })]),
  });
}

/** One lifecycle step; a deleted team's run is cancelled, which freezes it. */
export function teamLifecycleBody(
  previous: TeamState,
  lifecycle: Exclude<TeamLifecycle, 'active'>,
): TeamState {
  return Object.freeze({
    ...previous,
    lifecycle,
    run: logicalRun(lifecycle === 'deleted' ? 'cancelled' : 'admitted'),
  });
}

/** The opening of a board task: pending, unowned and unblocked. */
export function teamTaskOpenBody(params: {
  readonly teamId: string;
  readonly taskId: string;
  readonly number: number;
  readonly subject: string;
  readonly descriptionRef: ManagedSessionDurableRef;
  readonly activeForm: string | null;
  readonly metadataRef: ManagedSessionDurableRef | null;
}): TeamTask {
  return Object.freeze({
    ...params,
    owner: null,
    status: 'pending',
    blockedBy: Object.freeze([]),
    run: logicalRun('admitted'),
  });
}

/**
 * The next revision of a task: the given fields replaced, the new blockers
 * appended after the stored ones (an edge already stored is kept once),
 * and a deletion ending the run.
 */
export function teamTaskRevisionBody(
  previous: TeamTask,
  changes: {
    readonly subject?: string;
    readonly descriptionRef?: ManagedSessionDurableRef;
    readonly activeForm?: string | null;
    readonly metadataRef?: ManagedSessionDurableRef | null;
    readonly owner?: string | null;
    readonly status?: TeamTaskStatus;
    readonly addBlockedBy?: readonly string[];
  },
): TeamTask {
  const { addBlockedBy = [], ...fields } = changes;
  const status = fields.status ?? previous.status;
  return Object.freeze({
    ...previous,
    ...Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    ),
    blockedBy: Object.freeze([
      ...previous.blockedBy,
      ...addBlockedBy.filter(
        (blocker, index) =>
          !previous.blockedBy.includes(blocker) &&
          addBlockedBy.indexOf(blocker) === index,
      ),
    ]),
    run: logicalRun(status === 'deleted' ? 'cancelled' : 'admitted'),
  });
}

/**
 * The blockers that still block `task`: a dependency is stored once and
 * only grows, so whether it blocks is read from the blocker, which stops
 * blocking once it is completed or deleted.
 */
export function teamTaskOpenBlockers(
  task: TeamTask,
  tasks: ReadonlyMap<string, TeamTask>,
): string[] {
  return task.blockedBy.filter((blocker) => {
    const status = tasks.get(blocker)?.status;
    return status !== 'completed' && status !== 'deleted';
  });
}
