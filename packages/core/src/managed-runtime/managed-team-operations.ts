/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionRunState } from './managed-extension-record.js';
import {
  MANAGED_TEAM_LIMITS,
  parseTeamState,
  parseTeamTask,
  type TeamLifecycle,
  type TeamState,
  type TeamTask,
  type TeamTaskStatus,
} from './managed-team-record.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';

// H4e-b1 of #12827: the bodies the lead's team funnel commits. Each builder
// returns a parsed record, so a misuse fails here rather than at the
// authority. See docs/design/2026-10-10-managed-agent-team-lead-runtime.md.

function logicalRun(state: ExtensionRunState) {
  return {
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
  };
}

/**
 * The Legacy `sanitizeName` rule: lowercase, every character outside
 * `[a-z0-9-]` becomes a dash, dash runs collapse, edge dashes go.
 */
export function sanitizeTeamName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** The opening of a team: active, with no members yet. */
export function teamOpenBody(params: {
  readonly teamId: string;
  readonly name: string;
  readonly leadSessionId: string;
}): TeamState {
  return parseTeamState({
    teamId: params.teamId,
    name: params.name,
    leadSessionId: params.leadSessionId,
    lifecycle: 'active',
    membershipRevision: 1,
    members: [],
    run: logicalRun('admitted'),
  });
}

/** The next roster revision: one member appended. */
export function teamJoinBody(
  previous: TeamState,
  member: { readonly name: string; readonly childRunId: string },
): TeamState {
  return parseTeamState({
    ...previous,
    membershipRevision: previous.membershipRevision + 1,
    members: [
      ...previous.members,
      {
        name: member.name,
        childRunId: member.childRunId,
        planModeRequired: false,
      },
    ],
  });
}

/** The next lifecycle step: `closing`, then `deleted`, which ends the run. */
export function teamLifecycleBody(
  previous: TeamState,
  lifecycle: Exclude<TeamLifecycle, 'active'>,
): TeamState {
  return parseTeamState({
    ...previous,
    lifecycle,
    run: logicalRun(lifecycle === 'deleted' ? 'cancelled' : 'admitted'),
  });
}

/** A task's record id: unique in the journal, derived from its team. */
export function teamTaskRecordId(teamId: string, number: number): string {
  return `${teamId}#${number}`;
}

/** A new board task, `pending` and unowned. */
export function teamTaskOpenBody(params: {
  readonly teamId: string;
  readonly number: number;
  readonly subject: string;
  readonly descriptionRef: ManagedSessionDurableRef;
  readonly activeForm: string | null;
  readonly metadataRef: ManagedSessionDurableRef | null;
}): TeamTask {
  return parseTeamTask({
    teamId: params.teamId,
    taskId: teamTaskRecordId(params.teamId, params.number),
    number: params.number,
    subject: params.subject,
    descriptionRef: params.descriptionRef,
    activeForm: params.activeForm,
    metadataRef: params.metadataRef,
    owner: null,
    status: 'pending',
    blockedBy: [],
    run: logicalRun('admitted'),
  });
}

/** The changes one task_update makes to one task. Absent means unchanged. */
export interface TeamTaskChange {
  readonly subject?: string;
  readonly descriptionRef?: ManagedSessionDurableRef;
  readonly activeForm?: string | null;
  readonly metadataRef?: ManagedSessionDurableRef | null;
  readonly owner?: string | null;
  readonly status?: TeamTaskStatus;
  /** Appended in order, skipping any the task already names. */
  readonly addBlockedBy?: readonly string[];
}

/** The next revision of a task under one change. */
export function teamTaskReviseBody(
  previous: TeamTask,
  change: TeamTaskChange,
): TeamTask {
  const status = change.status ?? previous.status;
  const blockedBy = [...previous.blockedBy];
  for (const blocker of change.addBlockedBy ?? []) {
    if (!blockedBy.includes(blocker)) blockedBy.push(blocker);
  }
  return parseTeamTask({
    ...previous,
    subject: change.subject ?? previous.subject,
    descriptionRef: change.descriptionRef ?? previous.descriptionRef,
    activeForm:
      change.activeForm === undefined ? previous.activeForm : change.activeForm,
    metadataRef:
      change.metadataRef === undefined
        ? previous.metadataRef
        : change.metadataRef,
    owner: change.owner === undefined ? previous.owner : change.owner,
    status,
    blockedBy,
    run: logicalRun(status === 'deleted' ? 'cancelled' : 'admitted'),
  });
}

/**
 * The blockers that still block a task: a completed or deleted blocker no
 * longer does, so completing one needs no write to its dependents.
 */
export function openTeamTaskBlockers(
  task: TeamTask,
  tasks: ReadonlyMap<string, TeamTask>,
): readonly TeamTask[] {
  return task.blockedBy.flatMap((taskId) => {
    const blocker = tasks.get(taskId);
    return blocker === undefined ||
      blocker.status === 'completed' ||
      blocker.status === 'deleted'
      ? []
      : [blocker];
  });
}

/** Whether `from` reaches `to` along `blockedBy` edges. */
export function teamTaskReaches(
  from: string,
  to: string,
  blockedByOf: (taskId: string) => readonly string[],
): boolean {
  const pending = [from];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (next === to) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...blockedByOf(next));
  }
  return false;
}

export const MANAGED_TEAM_TOOL_LIMITS = Object.freeze({
  /** Legacy subject and active-form caps, in characters. */
  maxSubjectChars: 200,
  maxActiveFormChars: 200,
  /** Legacy description cap, in characters. */
  maxDescriptionChars: 10_000,
  maxMetadataBytes: MANAGED_TEAM_LIMITS.maxMetadataBytes,
  maxMembers: MANAGED_TEAM_LIMITS.maxMembers,
} as const);
