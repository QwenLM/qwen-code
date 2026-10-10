/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FunctionDeclaration } from '@google/genai';
import { sanitizeName } from '@qwen-code/qwen-code-core/agents/team/teamHelpers.js';
import {
  isChildSessionRun,
  parseChildRun,
  type ChildSessionRun,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import { isTerminalRunState } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import type {
  CommittedExtensionOperation,
  ManagedSessionActor,
  ManagedSessionCommand,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import type {
  ManagedSessionDomain,
  ManagedSessionDurableRef,
  ManagedSessionKey,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  MANAGED_TEAM_LEADER,
  MANAGED_TEAM_LIMITS,
  parseTeamState,
  parseTeamTask,
  type TeamState,
  type TeamTask,
  type TeamTaskStatus,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-team-record.js';
import {
  teamJoinBody,
  teamLifecycleBody,
  teamOpenBody,
  teamTaskOpenBlockers,
  teamTaskOpenBody,
  teamTaskRevisionBody,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-team-operations.js';
import { stripAnsiAndControl } from '@qwen-code/qwen-code-core/utils/textUtils.js';

// H4e-b1 of #12827: the lead Session's team funnel. The lead alone writes
// its team: the roster and lifecycle (team_state) and the board
// (team_task), each verb validating against the committed records and
// committing through one serial chain under command ids derived from the
// tool call, so a replayed call finds what it committed and adds nothing
// twice. Members are H4b child agents; this funnel only names them. See
// docs/design/2026-10-10-managed-agent-team-lead-runtime.md.

/** The narrow authority/resource pair a HostedTeamSession commits through. */
export interface HostedTeamStore {
  readonly authority: {
    extensionRecord(
      domain: ManagedSessionDomain,
      recordId: string,
    ): { readonly record: unknown; readonly revision: number } | undefined;
    extensionRecordsInDomain(
      domain: ManagedSessionDomain,
    ): ReadonlyArray<{ readonly record: unknown }>;
    committedExtensionOperation(
      operation: string,
      commandId: string,
    ): CommittedExtensionOperation | undefined;
    commitExtensionRecord(
      command: ManagedSessionCommand,
      request: {
        readonly domain: ManagedSessionDomain;
        readonly record: unknown;
      },
      actor: ManagedSessionActor,
    ): Promise<unknown>;
  };
  readonly resources: {
    publish(kind: string, bytes: Buffer): Promise<ManagedSessionDurableRef>;
    read(ref: ManagedSessionDurableRef): Promise<Buffer>;
  };
}

/** A model-facing refusal: the call answers with it and commits nothing. */
export class HostedTeamRefusal extends Error {}

export type HostedTeamMemberState =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** The Legacy board tools' schema bounds, in characters. */
const SUBJECT_CHARS = 200;
const DESCRIPTION_CHARS = 10_000;
const ACTIVE_FORM_CHARS = 200;
const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'deleted'];
const UNSAFE_METADATA_KEYS = ['__proto__', 'constructor', 'prototype'];
const TRUSTED: ManagedSessionActor = { class: 'trusted_entry' };

export const HOSTED_TEAM_TOOLS: readonly FunctionDeclaration[] = [
  {
    name: 'team_create',
    description:
      "Create this Session's team: named child agents (members) and a shared task board. A Session leads one team at a time. Spawn members with the agent tool's name parameter, keep the work on the board with task_create, task_update and task_list, and delete the team with team_delete once its members have finished.",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        team_name: {
          type: 'string',
          description:
            'The team name; it is lowercased, and runs of other characters become single hyphens.',
        },
      },
      required: ['team_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_delete',
    description:
      "Delete this Session's team. Refused while a member is still running: a running member cannot be stopped from here, so wait until task_list shows every member ended.",
    parametersJsonSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'task_create',
    description:
      'Create a pending task on the team board. Members are not told about board changes; give a member its work in its launch prompt.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          maxLength: SUBJECT_CHARS,
          description: 'Short title for the task.',
        },
        description: {
          type: 'string',
          maxLength: DESCRIPTION_CHARS,
          description: 'Detailed description of the task.',
        },
        activeForm: {
          type: 'string',
          maxLength: ACTIVE_FORM_CHARS,
          description: 'Present tense label for UI (e.g., "Running tests").',
        },
        metadata: {
          type: 'object',
          description: 'Optional arbitrary metadata.',
        },
      },
      required: ['subject', 'description'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_update',
    description:
      'Update a board task: status, owner, subject, description, active form, metadata and dependencies. Set status to "deleted" to remove it. A task in progress needs an owner: "leader" or a member that is still running; a member that has finished can own only a completed task. Dependencies only grow, and a completed or deleted blocker stops blocking. Members are not told about the update.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Number of the task to update, as "3" or "#3".',
        },
        status: {
          type: 'string',
          enum: TASK_STATUSES,
          description: 'New task status.',
        },
        owner: {
          type: 'string',
          description:
            'New owner: "leader" or a member name. Set to an empty string to unassign.',
        },
        subject: {
          type: 'string',
          maxLength: SUBJECT_CHARS,
          description: 'Updated task title.',
        },
        description: {
          type: 'string',
          maxLength: DESCRIPTION_CHARS,
          description: 'Updated task description.',
        },
        activeForm: {
          type: 'string',
          maxLength: ACTIVE_FORM_CHARS,
          description: 'Present tense label for UI.',
        },
        metadata: {
          type: 'object',
          description: 'Metadata to merge. Set a key to null to delete it.',
        },
        addBlocks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Numbers of the tasks this task blocks.',
        },
        addBlockedBy: {
          type: 'array',
          items: { type: 'string' },
          description: 'Numbers of the tasks that block this task.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_list',
    description:
      'List the team board, optionally filtered, followed by each member and the state of its run.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'Filter by task status.',
        },
        owner: {
          type: 'string',
          description: 'Filter by owner name.',
        },
        blockedBy: {
          type: 'string',
          description: 'Filter for tasks still blocked by this task number.',
        },
      },
      additionalProperties: false,
    },
  },
];

export const HOSTED_TEAM_TOOL_NAMES: readonly string[] = HOSTED_TEAM_TOOLS.map(
  (tool) => tool.name!,
);

const ALLOWED_KEYS: Readonly<Record<string, readonly string[]>> = {
  team_create: ['team_name'],
  team_delete: [],
  task_create: ['subject', 'description', 'activeForm', 'metadata'],
  task_update: [
    'taskId',
    'status',
    'owner',
    'subject',
    'description',
    'activeForm',
    'metadata',
    'addBlocks',
    'addBlockedBy',
  ],
  task_list: ['status', 'owner', 'blockedBy'],
};

function lineError(
  value: unknown,
  label: string,
  maxChars: number,
): string | undefined {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maxChars ||
    stripAnsiAndControl(value) !== value
  )
    return `${label} must be one line of at most ${maxChars} characters.`;
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * The argument shape of one team tool call, checked before the batch runs:
 * a malformed call refuses the batch, while what the committed team and
 * board decide answers the call alone when it runs.
 */
export function hostedTeamArgumentError(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  const unsupported = Object.keys(args).find(
    (key) => !ALLOWED_KEYS[toolName]!.includes(key),
  );
  if (unsupported !== undefined)
    return `Hosted ${toolName} received unsupported argument ${JSON.stringify(unsupported)}.`;
  if (toolName === 'team_create') {
    if (typeof args['team_name'] !== 'string')
      return 'team_name must be a string.';
    return undefined;
  }
  if (toolName === 'task_create' || toolName === 'task_update') {
    if (toolName === 'task_create' || args['subject'] !== undefined) {
      const error = lineError(args['subject'], 'subject', SUBJECT_CHARS);
      if (error) return error;
    }
    if (
      (toolName === 'task_create' || args['description'] !== undefined) &&
      (typeof args['description'] !== 'string' ||
        args['description'].length > DESCRIPTION_CHARS)
    )
      return `description must be a string of at most ${DESCRIPTION_CHARS} characters.`;
    if (args['activeForm'] !== undefined) {
      const error = lineError(
        args['activeForm'],
        'activeForm',
        ACTIVE_FORM_CHARS,
      );
      if (error) return error;
    }
    if (args['metadata'] !== undefined && !isPlainObject(args['metadata']))
      return 'metadata must be an object.';
  }
  if (toolName === 'task_update') {
    if (typeof args['taskId'] !== 'string') return 'taskId must be a string.';
    if (
      args['status'] !== undefined &&
      !TASK_STATUSES.includes(args['status'] as string)
    )
      return `status must be one of ${TASK_STATUSES.join(', ')}.`;
    if (args['owner'] !== undefined && typeof args['owner'] !== 'string')
      return 'owner must be a string.';
    for (const key of ['addBlocks', 'addBlockedBy']) {
      const value = args[key];
      if (
        value !== undefined &&
        (!Array.isArray(value) ||
          value.length > MANAGED_TEAM_LIMITS.maxBlockers ||
          value.some((each) => typeof each !== 'string'))
      )
        return `${key} must be an array of at most ${MANAGED_TEAM_LIMITS.maxBlockers} task numbers.`;
    }
  }
  if (toolName === 'task_list') {
    if (
      args['status'] !== undefined &&
      !['pending', 'in_progress', 'completed'].includes(
        args['status'] as string,
      )
    )
      return 'status must be pending, in_progress or completed.';
    for (const key of ['owner', 'blockedBy'])
      if (args[key] !== undefined && typeof args[key] !== 'string')
        return `${key} must be a string.`;
  }
  return undefined;
}

function digest(record: unknown): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

/** A Legacy task number, as "3" or "#3". */
function taskNumber(raw: string): number {
  const id = raw.trim().replace(/^#/, '');
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
    throw new HostedTeamRefusal(
      `Invalid task ID "${raw}". Task IDs must be positive integers.`,
    );
  return Number(id);
}

export interface HostedTeamMembership {
  readonly teamId: string;
  readonly teamName: string;
  readonly name: string;
}

/** The roster entry naming one child run, among a Session's team records. */
export function hostedTeamMembership(
  teams: ReadonlyArray<{ readonly record: unknown }>,
  childRunId: string,
): HostedTeamMembership | undefined {
  for (const entry of teams) {
    const team = parseTeamState(entry.record);
    const member = team.members.find((each) => each.childRunId === childRunId);
    if (member !== undefined)
      return { teamId: team.teamId, teamName: team.name, name: member.name };
  }
  return undefined;
}

function memberRunState(
  child: ChildSessionRun | undefined,
): HostedTeamMemberState {
  if (child?.run.state === 'settled') return 'completed';
  if (child?.run.state === 'failed' || child?.run.state === 'cancelled')
    return child.run.state;
  return 'running';
}

export class HostedTeamSession {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: HostedTeamStore,
    private readonly key: ManagedSessionKey,
  ) {}

  team(teamId: string): TeamState | undefined {
    const existing = this.store.authority.extensionRecord('team_state', teamId);
    return existing === undefined ? undefined : parseTeamState(existing.record);
  }

  /** The lead's one open team: active, or closing until it is deleted. */
  openTeam(): TeamState | undefined {
    return this.store.authority
      .extensionRecordsInDomain('team_state')
      .map((entry) => parseTeamState(entry.record))
      .find((team) => team.lifecycle !== 'deleted');
  }

  /** The member a child run joined as, in any team of this Session. */
  membership(childRunId: string): HostedTeamMembership | undefined {
    return hostedTeamMembership(
      this.store.authority.extensionRecordsInDomain('team_state'),
      childRunId,
    );
  }

  /** A member's liveness: the state of its child run. */
  memberState(childRunId: string): HostedTeamMemberState {
    return memberRunState(this.childRun(childRunId));
  }

  /**
   * Whether a call committed any part of its team write before its Turn
   * died: the interrupted Turn's settlement must not answer such a call
   * as one that never ran.
   */
  committedBy(toolName: string, callKey: string): boolean {
    const commands: ReadonlyArray<readonly [string, string]> =
      toolName === 'team_create'
        ? [['createTeam', callKey]]
        : toolName === 'task_create'
          ? [['createTeamTask', callKey]]
          : toolName === 'team_delete'
            ? [
                ['deleteTeam', `${callKey}:closing`],
                ['deleteTeam', `${callKey}:deleted`],
              ]
            : toolName === 'task_update'
              ? Array.from(
                  { length: MANAGED_TEAM_LIMITS.maxBlockers + 1 },
                  (_, place) =>
                    ['updateTeamTask', `${callKey}:${place + 1}`] as const,
                )
              : [];
    return commands.some(
      ([operation, commandId]) =>
        this.committed(operation, commandId) !== undefined,
    );
  }

  /**
   * Runs one team tool call against the committed team and board and
   * answers its text; a refusal throws HostedTeamRefusal and commits
   * nothing. `callKey` is the call's replay-stable key.
   */
  run(
    toolName: string,
    args: Record<string, unknown>,
    callKey: string,
  ): Promise<string> {
    return this.serial(() => {
      switch (toolName) {
        case 'team_create':
          return this.createTeam(callKey, args['team_name'] as string);
        case 'team_delete':
          return this.deleteTeam(callKey);
        case 'task_create':
          return this.createTask(callKey, args);
        case 'task_update':
          return this.updateTask(callKey, args);
        case 'task_list':
          return Promise.resolve(this.listTasks(args));
        default:
          throw new Error(`${toolName} is not a team tool.`);
      }
    });
  }

  /**
   * The team checks of a new member, before its launch commits anything:
   * the open team must be active, and the sanitized name new to its
   * roster, which must still have room. Returns the member it would be.
   */
  admitMember(rawName: string): HostedTeamMembership {
    const team = this.openTeam();
    if (team === undefined)
      throw new HostedTeamRefusal(
        'Hosted child agent name joins the team, and this Session has none. Create one with team_create first, or omit name to launch an unnamed child agent.',
      );
    if (team.lifecycle !== 'active')
      throw new HostedTeamRefusal(
        `Team "${team.name}" is closing and takes no new members. Finish it with team_delete.`,
      );
    const name = sanitizeName(rawName);
    if (!name)
      throw new HostedTeamRefusal(
        `Teammate name "${rawName}" sanitizes to an empty string. Choose a name with at least one alphanumeric character.`,
      );
    if (name === MANAGED_TEAM_LEADER)
      throw new HostedTeamRefusal(
        `"${MANAGED_TEAM_LEADER}" is reserved for the team leader. Choose a different teammate name.`,
      );
    if (name.length > MANAGED_TEAM_LIMITS.maxNameLength)
      throw new HostedTeamRefusal(
        `Teammate name "${name}" is longer than ${MANAGED_TEAM_LIMITS.maxNameLength} characters.`,
      );
    if (team.members.some((member) => member.name === name))
      throw new HostedTeamRefusal(
        `A teammate named "${name}" already exists in this team (existing: ${team.members.map((member) => member.name).join(', ')}). Choose a different name.`,
      );
    if (team.members.length >= MANAGED_TEAM_LIMITS.maxMembers)
      throw new HostedTeamRefusal(
        `Team "${team.name}" already has ${MANAGED_TEAM_LIMITS.maxMembers} members. A member keeps its place after it ends, so no more can join.`,
      );
    return { teamId: team.teamId, teamName: team.name, name };
  }

  /**
   * The roster join that follows a member's launch. A committed join is
   * the replay; a run that ended first never joins, and the ended run is
   * returned for the call to answer with.
   */
  join(params: {
    readonly teamId: string;
    readonly name: string;
    readonly childRunId: string;
  }): Promise<{ readonly joined: true } | { readonly ended: ChildSessionRun }> {
    return this.serial(async () => {
      const commandId = `${params.childRunId}:join`;
      if (this.committed('joinTeam', commandId) !== undefined)
        return { joined: true };
      try {
        await this.commit(
          'team_state',
          teamJoinBody(this.team(params.teamId)!, {
            name: params.name,
            childRunId: params.childRunId,
            planModeRequired: false,
          }),
          'joinTeam',
          commandId,
        );
      } catch (cause) {
        // The relay runs on its own, so the run can end at any moment
        // before the join; the authority then refuses it, as it admits
        // only a live run to the roster.
        const child = this.childRun(params.childRunId);
        if (child !== undefined && isTerminalRunState(child.run.state))
          return { ended: child };
        throw cause;
      }
      return { joined: true };
    });
  }

  private async createTeam(teamId: string, rawName: string): Promise<string> {
    if (this.committed('createTeam', teamId) !== undefined)
      return `Team "${this.team(teamId)!.name}" created.`;
    const name = sanitizeName(rawName);
    if (!name) throw new HostedTeamRefusal('Team name is required.');
    if (name.length > MANAGED_TEAM_LIMITS.maxNameLength)
      throw new HostedTeamRefusal(
        `Team name "${name}" is longer than ${MANAGED_TEAM_LIMITS.maxNameLength} characters.`,
      );
    if (this.openTeam() !== undefined)
      throw new HostedTeamRefusal(
        'A team is already active. Delete it before creating a new one.',
      );
    await this.commit(
      'team_state',
      teamOpenBody({ teamId, name, leadSessionId: this.key.sessionId }),
      'createTeam',
      teamId,
    );
    return `Team "${name}" created.`;
  }

  private async deleteTeam(callKey: string): Promise<string> {
    const deleted = this.committed('deleteTeam', `${callKey}:deleted`);
    if (deleted !== undefined)
      return `Team "${this.team(deleted)!.name}" deleted.`;
    // A call that already closed its team checked the members then.
    const closed = this.committed('deleteTeam', `${callKey}:closing`);
    const team = closed === undefined ? this.openTeam() : this.team(closed);
    if (team === undefined)
      throw new HostedTeamRefusal('No active team to delete.');
    let closing = team;
    if (closed === undefined) {
      const running = team.members
        .filter((member) => this.memberState(member.childRunId) === 'running')
        .map((member) => member.name);
      if (running.length > 0)
        throw new HostedTeamRefusal(
          `Team "${team.name}" still has running members: ${running.join(', ')}. A running member cannot be stopped from this Session yet; wait until task_list shows it ended, then delete the team.`,
        );
      if (team.lifecycle === 'active') {
        closing = teamLifecycleBody(team, 'closing');
        await this.commit(
          'team_state',
          closing,
          'deleteTeam',
          `${callKey}:closing`,
        );
      }
    }
    await this.commit(
      'team_state',
      teamLifecycleBody(closing, 'deleted'),
      'deleteTeam',
      `${callKey}:deleted`,
    );
    return `Team "${team.name}" deleted.`;
  }

  private async createTask(
    callKey: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    // The number is allocated only for a call that has not committed its
    // task, so a replay answers with the number it already took.
    const created = this.committed('createTeamTask', callKey);
    if (created !== undefined) {
      const task = this.task(created);
      return `Task #${task.number} created: "${task.subject}"`;
    }
    const team = this.activeTeam();
    const number =
      Math.max(0, ...this.tasksOf(team.teamId).map((task) => task.number)) + 1;
    const metadata = metadataBytes(mergeMetadata({}, args['metadata']));
    const task = teamTaskOpenBody({
      teamId: team.teamId,
      taskId: `${team.teamId}#${number}`,
      number,
      subject: args['subject'] as string,
      descriptionRef: await this.publishText(args['description'] as string),
      activeForm: (args['activeForm'] as string | undefined) ?? null,
      metadataRef: await this.publishMetadata(metadata),
    });
    await this.commit('team_task', task, 'createTeamTask', callKey);
    return `Task #${number} created: "${task.subject}"`;
  }

  /**
   * One call commits the updated task, then one revision of each task it
   * now blocks, at fixed places in its plan. A replay skips the places
   * that committed and computes only the rest from the current records;
   * the call was validated before its first commit.
   */
  private async updateTask(
    callKey: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const team = this.openTeam();
    if (team === undefined)
      throw new HostedTeamRefusal('No active team. Create a team first.');
    const board = new Map(
      this.tasksOf(team.teamId).map((task) => [task.number, task]),
    );
    const number = taskNumber(args['taskId'] as string);
    const deleting = args['status'] === 'deleted';
    const blocks = deleting
      ? []
      : ((args['addBlocks'] as string[] | undefined) ?? []).map(taskNumber);
    const blockedBy = deleting
      ? []
      : ((args['addBlockedBy'] as string[] | undefined) ?? []).map(taskNumber);
    const commandId = (place: number) => `${callKey}:${place + 1}`;
    const pending = [number, ...blocks]
      .map((_, place) => place)
      .filter(
        (place) =>
          this.committed('updateTeamTask', commandId(place)) === undefined,
      );
    const replaying = pending.length < blocks.length + 1;
    const owner =
      args['owner'] === undefined
        ? undefined
        : args['owner'] === ''
          ? null
          : sanitizeName(args['owner'] as string);
    if (!replaying)
      this.validateUpdate(team, board, number, args, owner, blocks, blockedBy);
    for (const place of pending) {
      const target = board.get(place === 0 ? number : blocks[place - 1]!)!;
      // Re-read: an earlier place of this call may have revised it.
      const current = this.task(target.taskId);
      const revision =
        place > 0
          ? teamTaskRevisionBody(current, {
              addBlockedBy: [board.get(number)!.taskId],
            })
          : deleting
            ? teamTaskRevisionBody(current, { status: 'deleted' })
            : await this.updatedTask(current, args, owner, blockedBy, board);
      await this.commit(
        'team_task',
        revision,
        'updateTeamTask',
        commandId(place),
      );
    }
    const task = this.task(board.get(number)!.taskId);
    if (deleting) return `Task #${number} deleted.`;
    const notice =
      owner != null && owner !== MANAGED_TEAM_LEADER
        ? ` "${owner}" was not notified: members learn of board changes only once the team mailbox lands, so give a member its work in its launch prompt.`
        : '';
    return (
      `Task #${number} updated (status: ${task.status}` +
      (task.owner ? `, owner: ${task.owner}` : '') +
      `).${notice}`
    );
  }

  /** Every refusal of a task_update, before its first commit. */
  private validateUpdate(
    team: TeamState,
    board: ReadonlyMap<number, TeamTask>,
    number: number,
    args: Record<string, unknown>,
    owner: string | null | undefined,
    blocks: readonly number[],
    blockedBy: readonly number[],
  ): void {
    const live = (each: number) => {
      const task = board.get(each);
      return task !== undefined && task.status !== 'deleted';
    };
    if (!live(number))
      throw new HostedTeamRefusal(`Task #${number} not found.`);
    if (args['status'] === 'deleted') return;
    const task = board.get(number)!;
    if (blocks.includes(number) || blockedBy.includes(number))
      throw new HostedTeamRefusal(
        `Cannot update task #${number}: a task cannot block or be blocked by itself.`,
      );
    const missing = [...new Set([...blocks, ...blockedBy])]
      .filter((each) => !live(each))
      .sort((left, right) => left - right);
    if (missing.length > 0)
      throw new HostedTeamRefusal(
        `Cannot update task #${number}: referenced task${missing.length === 1 ? '' : 's'} ${missing.map((each) => `#${each}`).join(', ')} not found.`,
      );
    // The record bounds every task's stored blockers, deleted ones
    // included, so a call that would grow one past the bound is refused
    // here rather than by the commit.
    const crowded = [
      [number, blockedBy] as const,
      ...blocks.map((each) => [each, [number]] as const),
    ].find(
      ([each, added]) =>
        new Set([
          ...board.get(each)!.blockedBy,
          ...added.map((other) => board.get(other)!.taskId),
        ]).size > MANAGED_TEAM_LIMITS.maxBlockers,
    );
    if (crowded)
      throw new HostedTeamRefusal(
        `Cannot update task #${number}: task #${crowded[0]} would have more than ${MANAGED_TEAM_LIMITS.maxBlockers} blockers.`,
      );
    const cycle = dependencyCycle(board, number, blocks, blockedBy);
    if (cycle)
      throw new HostedTeamRefusal(
        `Cannot update task #${number}: this would create a dependency cycle (${cycle.map((each) => `#${each}`).join(' → ')}).`,
      );
    if (owner === '')
      throw new HostedTeamRefusal(
        `Cannot assign task #${number}: owner must include at least one letter, number, or hyphen.`,
      );
    const status =
      (args['status'] as TeamTaskStatus | undefined) ?? task.status;
    // A task keeps an owner whose run ended; only a new owner is checked.
    if (owner != null && owner !== task.owner)
      this.assertOwner(team, owner, status === 'completed');
    if (
      status === 'in_progress' &&
      (owner === undefined ? task.owner : owner) === null
    )
      throw new HostedTeamRefusal(
        `Cannot move task #${number} to in_progress without an owner. Specify the "owner" parameter.`,
      );
  }

  /** The updated task's own revision; its metadata is merged first. */
  private async updatedTask(
    task: TeamTask,
    args: Record<string, unknown>,
    owner: string | null | undefined,
    blockedBy: readonly number[],
    board: ReadonlyMap<number, TeamTask>,
  ): Promise<TeamTask> {
    const metadata =
      args['metadata'] === undefined
        ? undefined
        : metadataBytes(
            mergeMetadata(
              task.metadataRef === null
                ? {}
                : (JSON.parse(
                    (
                      await this.store.resources.read(task.metadataRef)
                    ).toString('utf8'),
                  ) as Record<string, unknown>),
              args['metadata'],
            ),
          );
    return teamTaskRevisionBody(task, {
      subject: args['subject'] as string | undefined,
      descriptionRef:
        args['description'] === undefined
          ? undefined
          : await this.publishText(args['description'] as string),
      activeForm: args['activeForm'] as string | undefined,
      metadataRef:
        metadata === undefined
          ? undefined
          : await this.publishMetadata(metadata),
      owner,
      status: args['status'] as TeamTaskStatus | undefined,
      addBlockedBy: blockedBy.map((each) => board.get(each)!.taskId),
    });
  }

  private listTasks(args: Record<string, unknown>): string {
    const team = this.openTeam();
    if (team === undefined)
      throw new HostedTeamRefusal('No active team. Create a team first.');
    let owner: string | undefined;
    if (typeof args['owner'] === 'string' && args['owner'].trim()) {
      owner = sanitizeName(args['owner']);
      if (!owner)
        throw new HostedTeamRefusal(
          'Cannot filter by owner: owner must include at least one letter, number, or hyphen.',
        );
    }
    const tasks = this.tasksOf(team.teamId);
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    const blocker =
      typeof args['blockedBy'] === 'string' && args['blockedBy'].trim()
        ? `${team.teamId}#${taskNumber(args['blockedBy'])}`
        : undefined;
    const lines = tasks
      .filter(
        (task) =>
          task.status !== 'deleted' &&
          (args['status'] === undefined || task.status === args['status']) &&
          (owner === undefined || task.owner === owner) &&
          (blocker === undefined ||
            teamTaskOpenBlockers(task, byId).includes(blocker)),
      )
      .map((task) => {
        const open = teamTaskOpenBlockers(task, byId).map(
          (each) => `#${byId.get(each)!.number}`,
        );
        return (
          `#${task.number} [${task.status}]` +
          (task.owner ? ` @${task.owner}` : '') +
          ` — ${task.subject}` +
          (open.length > 0 ? ` (blocked by ${open.join(', ')})` : '')
        );
      });
    return [
      ...(lines.length > 0 ? lines : ['No tasks found.']),
      '',
      `--- Team "${team.name}" members ---`,
      ...(team.members.length > 0
        ? team.members.map(
            (member) =>
              `${member.name}: ${this.memberState(member.childRunId)}`,
          )
        : ['No members yet.']),
    ].join('\n');
  }

  private activeTeam(): TeamState {
    const team = this.openTeam();
    if (team === undefined)
      throw new HostedTeamRefusal('No active team. Create a team first.');
    if (team.lifecycle !== 'active')
      throw new HostedTeamRefusal(
        `Team "${team.name}" is closing and takes no new tasks. Finish it with team_delete.`,
      );
    return team;
  }

  /**
   * An owner is the leader or a member whose run has not ended. A member
   * whose run completed may also be named on a task the call leaves
   * completed: a one-shot member usually finishes before the lead's next
   * call lands, and the board should still record who did the work.
   */
  private assertOwner(
    team: TeamState,
    owner: string,
    completing: boolean,
  ): void {
    if (owner === MANAGED_TEAM_LEADER) return;
    const member = team.members.find((each) => each.name === owner);
    if (member === undefined)
      throw new HostedTeamRefusal(
        `"${owner}" is not a member of team "${team.name}". An owner is "leader" or a member name.`,
      );
    const state = this.memberState(member.childRunId);
    if (state === 'running' || (state === 'completed' && completing)) return;
    throw new HostedTeamRefusal(
      state === 'completed'
        ? `Member "${owner}" has finished, so it can own only a completed task. Set status "completed" to record it as the owner.`
        : `Member "${owner}" has ${state} and cannot own a task.`,
    );
  }

  private tasksOf(teamId: string): TeamTask[] {
    return this.store.authority
      .extensionRecordsInDomain('team_task')
      .map((entry) => parseTeamTask(entry.record))
      .filter((task) => task.teamId === teamId)
      .sort((left, right) => left.number - right.number);
  }

  private childRun(childRunId: string): ChildSessionRun | undefined {
    const existing = this.store.authority.extensionRecord(
      'child_run',
      childRunId,
    );
    if (existing === undefined) return undefined;
    const child = parseChildRun(existing.record);
    return isChildSessionRun(child) ? child : undefined;
  }

  private publishText(text: string): Promise<ManagedSessionDurableRef> {
    return this.store.resources.publish(
      'managed-team-content',
      Buffer.from(JSON.stringify({ text }), 'utf8'),
    );
  }

  private async publishMetadata(
    bytes: Buffer | null,
  ): Promise<ManagedSessionDurableRef | null> {
    return bytes === null
      ? null
      : this.store.resources.publish('managed-team-metadata', bytes);
  }

  /**
   * The record a call's command already committed (decision 11): such a
   * command is done, and a write is computed only for one that is not.
   */
  private committed(operation: string, commandId: string): string | undefined {
    const prior = this.store.authority.committedExtensionOperation(
      operation,
      commandId,
    );
    if (prior === undefined) return undefined;
    return prior.kind === 'record' ? prior.result.recordId : prior.recordId;
  }

  private task(taskId: string): TeamTask {
    return parseTeamTask(
      this.store.authority.extensionRecord('team_task', taskId)!.record,
    );
  }

  /** Commits one revision unless the record already holds it (the replay). */
  private async commit(
    domain: 'team_state' | 'team_task',
    record: TeamState | TeamTask,
    operation: string,
    commandId: string,
  ): Promise<void> {
    const existing = this.store.authority.extensionRecord(
      domain,
      domain === 'team_state'
        ? (record as TeamState).teamId
        : (record as TeamTask).taskId,
    );
    if (existing !== undefined && isDeepStrictEqual(existing.record, record))
      return;
    await this.store.authority.commitExtensionRecord(
      {
        operation,
        commandId,
        sessionKey: this.key,
        contentDigest: digest(record),
      },
      { domain, record },
      TRUSTED,
    );
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(work);
    this.writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** The bytes of merged metadata, null when empty, refused past its cap. */
function metadataBytes(metadata: Record<string, unknown>): Buffer | null {
  if (Object.keys(metadata).length === 0) return null;
  const bytes = Buffer.from(JSON.stringify(metadata), 'utf8');
  if (bytes.byteLength > MANAGED_TEAM_LIMITS.maxMetadataBytes)
    throw new HostedTeamRefusal(
      `Task metadata is too large (${bytes.byteLength} bytes; max ${MANAGED_TEAM_LIMITS.maxMetadataBytes}).`,
    );
  return bytes;
}

/** Legacy metadata merge: a null value deletes its key. */
function mergeMetadata(
  base: Record<string, unknown>,
  changes: unknown,
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(
    (changes as Record<string, unknown> | undefined) ?? {},
  )) {
    if (UNSAFE_METADATA_KEYS.includes(key)) continue;
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/**
 * The cycle the new edges would close, as task numbers from `number` back
 * to itself, or null. The board is acyclic, so only a path through a new
 * edge can return to `number`.
 */
function dependencyCycle(
  board: ReadonlyMap<number, TeamTask>,
  number: number,
  blocks: readonly number[],
  blockedBy: readonly number[],
): number[] | null {
  const numberOf = new Map(
    [...board.values()].map((task) => [task.taskId, task.number]),
  );
  // Edges run from a blocker to the task it blocks.
  const next = new Map<number, Set<number>>();
  const edge = (from: number, to: number) => {
    const set = next.get(from) ?? new Set<number>();
    set.add(to);
    next.set(from, set);
  };
  for (const task of board.values())
    for (const blocker of task.blockedBy)
      edge(numberOf.get(blocker)!, task.number);
  for (const each of blocks) edge(number, each);
  for (const each of blockedBy) edge(each, number);
  const path: number[] = [];
  const visited = new Set<number>([number]);
  const walk = (node: number): number[] | null => {
    path.push(node);
    for (const following of next.get(node) ?? []) {
      if (following === number) return [...path, number];
      if (visited.has(following)) continue;
      visited.add(following);
      const found = walk(following);
      if (found) return found;
    }
    path.pop();
    return null;
  };
  return walk(number);
}
