/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionDeclaration } from '@google/genai';
import { isTerminalRunState } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import {
  MANAGED_TEAM_LEADER,
  MANAGED_TEAM_LIMITS,
  type TeamState,
  type TeamTask,
  type TeamTaskStatus,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-team-record.js';
import {
  MANAGED_TEAM_TOOL_LIMITS,
  openTeamTaskBlockers,
  sanitizeTeamName,
  teamTaskReaches,
  teamTaskRecordId,
  type TeamTaskChange,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-team-operations.js';
import type { ChildAgentRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import type {
  HostedTeamSession,
  HostedTeamTaskStep,
} from './hosted-team-session.js';

// H4e-b1 of #12827: the lead-side team tools of a Hosted Session. They
// follow the Legacy team tools' schemas and messages where the Managed
// path can keep them, and say so where it cannot (a member is one-shot,
// assignments reach no member yet, a running member cannot be stopped).
// See docs/design/2026-10-10-managed-agent-team-lead-runtime.md.

export const HOSTED_TEAM_TOOL_NAMES = [
  'team_create',
  'team_delete',
  'task_create',
  'task_update',
  'task_list',
] as const;
export type HostedTeamToolName = (typeof HOSTED_TEAM_TOOL_NAMES)[number];

export function isHostedTeamTool(name: string): name is HostedTeamToolName {
  return (HOSTED_TEAM_TOOL_NAMES as readonly string[]).includes(name);
}

const STATUSES = ['pending', 'in_progress', 'completed'] as const;

export const HOSTED_TEAM_TOOLS: readonly FunctionDeclaration[] = [
  {
    name: 'team_create',
    description:
      'Create the team this Session leads. A Session leads at most one team at a time. Spawn members with the agent tool\'s "name" parameter: each member runs one turn in the background and reports back by notification.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        team_name: {
          type: 'string',
          description: 'Name for the team (alphanumeric and hyphens).',
        },
      },
      required: ['team_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_delete',
    description:
      "Delete the team this Session leads. Refused while any member is still running: a member cannot be stopped yet, so wait for every member's result before deleting the team.",
    parametersJsonSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'task_create',
    description:
      "Create a task on the team's board. It starts pending and unowned.",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: 'A brief, single-line title for the task.',
        },
        description: {
          type: 'string',
          description: 'What needs to be done.',
        },
        activeForm: {
          type: 'string',
          description:
            'Present continuous form shown while the task is in progress (e.g., "Running tests").',
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary metadata to attach to the task.',
        },
      },
      required: ['subject', 'description'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_update',
    description:
      'Update a task on the team\'s board: its status, owner, content or dependencies. Set status to "deleted" to remove it. Members are not notified of assignments yet; tell a member its work in its launch prompt.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The task number, such as "3" or "#3".',
        },
        status: {
          type: 'string',
          enum: [...STATUSES, 'deleted'],
          description: 'The new status.',
        },
        owner: {
          type: 'string',
          description:
            'The new owner: "leader" or a member name. Set to empty string to unassign.',
        },
        subject: { type: 'string', description: 'A new subject.' },
        description: { type: 'string', description: 'A new description.' },
        activeForm: { type: 'string', description: 'A new active form.' },
        metadata: {
          type: 'object',
          description: 'Metadata to merge. Set a key to null to delete it.',
        },
        addBlocks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tasks that cannot start until this one completes.',
        },
        addBlockedBy: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tasks that must complete before this one can start.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_list',
    description:
      "List the team's board and its members' run states. Filters are optional.",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: [...STATUSES],
          description: 'Only tasks with this status.',
        },
        owner: { type: 'string', description: 'Only tasks with this owner.' },
        blockedBy: {
          type: 'string',
          description: 'Only tasks blocked by this task number.',
        },
      },
      additionalProperties: false,
    },
  },
];

/** The Agent tool's `name`, declared only while teams are admitted. */
export const HOSTED_AGENT_NAME_PROPERTY = {
  type: 'string',
  description:
    'Spawn the child as a named member of the team this Session leads. Members always run in the background (omit run_in_background or set it true), run one turn, and report back by notification labeled with their name. Requires a team; omit "name" for an ordinary child agent.',
} as const;

const TASK_ID = /^[1-9]\d*$/;

/**
 * The optional arguments of each team tool. Legacy reads the blank
 * placeholder a model fills an optional parameter with (`null`, `""`) as
 * not given; `task_update`'s `owner` keeps `""`, which unassigns, so only
 * its `null` is not given.
 */
const OPTIONAL_ARGS: Readonly<Record<HostedTeamToolName, readonly string[]>> = {
  team_create: [],
  team_delete: [],
  task_create: ['activeForm', 'metadata'],
  task_update: [
    'status',
    'subject',
    'description',
    'activeForm',
    'metadata',
    'addBlocks',
    'addBlockedBy',
  ],
  task_list: ['status', 'owner', 'blockedBy'],
};

function blank(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.trim() === '');
}

function withoutBlankOptionals(
  name: HostedTeamToolName,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const present = Object.entries(args).filter(
    ([key, value]) =>
      !(OPTIONAL_ARGS[name].includes(key) && blank(value)) &&
      // `owner: ""` unassigns, so only a null owner is not given.
      !(name === 'task_update' && key === 'owner' && value === null),
  );
  return present.length === Object.keys(args).length
    ? args
    : Object.fromEntries(present);
}

/** The Agent tool's `name`, or undefined when absent or a blank placeholder. */
export function hostedTeammateArg(args: Record<string, unknown>): unknown {
  const raw = args['name'];
  return raw === undefined || blank(raw) ? undefined : raw;
}

function singleLine(value: string): boolean {
  // The record's bounded text admits no control character.
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function knownKeys(
  args: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined {
  const unknown = Object.keys(args).find((key) => !allowed.includes(key));
  return unknown === undefined
    ? undefined
    : `Unsupported argument ${JSON.stringify(unknown)}.`;
}

function taskNumber(value: unknown): number | undefined {
  const text =
    typeof value === 'number'
      ? String(value)
      : typeof value === 'string'
        ? value.trim().replace(/^#/, '')
        : '';
  return TASK_ID.test(text) ? Number(text) : undefined;
}

function invalidTaskId(value: unknown): string {
  return `Invalid task ID ${JSON.stringify(String(value))}. Task IDs must be positive integers.`;
}

function metadataError(value: unknown): string | undefined {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Buffer.byteLength(JSON.stringify(value), 'utf8') >
      MANAGED_TEAM_TOOL_LIMITS.maxMetadataBytes
  )
    return `metadata must be an object of at most ${MANAGED_TEAM_TOOL_LIMITS.maxMetadataBytes} bytes.`;
  return undefined;
}

function textError(
  value: unknown,
  label: string,
  maxChars: number,
  options: { readonly required: boolean; readonly line: boolean },
): string | undefined {
  if (value === undefined && !options.required) return undefined;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maxChars ||
    (options.line && !singleLine(value))
  )
    return `${label} must be nonempty ${options.line ? 'single-line ' : ''}text of at most ${maxChars} characters.`;
  return undefined;
}

/**
 * The argument check of one team tool call, before anything runs. The
 * state checks (an open team, a known task) run at execution.
 */
export function hostedTeamToolArgsError(
  name: HostedTeamToolName,
  raw: Record<string, unknown>,
): string | undefined {
  const limits = MANAGED_TEAM_TOOL_LIMITS;
  const args = withoutBlankOptionals(name, raw);
  switch (name) {
    case 'team_create':
      return (
        knownKeys(args, ['team_name']) ??
        (typeof args['team_name'] === 'string'
          ? undefined
          : 'team_name must be text.')
      );
    case 'team_delete':
      return knownKeys(args, []);
    case 'task_create':
      return (
        knownKeys(args, ['subject', 'description', 'activeForm', 'metadata']) ??
        textError(args['subject'], 'subject', limits.maxSubjectChars, {
          required: true,
          line: true,
        }) ??
        textError(
          args['description'],
          'description',
          limits.maxDescriptionChars,
          { required: true, line: false },
        ) ??
        textError(args['activeForm'], 'activeForm', limits.maxActiveFormChars, {
          required: false,
          line: true,
        }) ??
        (args['metadata'] === undefined
          ? undefined
          : metadataError(args['metadata']))
      );
    case 'task_update': {
      const keyError = knownKeys(args, [
        'taskId',
        'status',
        'owner',
        'subject',
        'description',
        'activeForm',
        'metadata',
        'addBlocks',
        'addBlockedBy',
      ]);
      if (keyError) return keyError;
      if (taskNumber(args['taskId']) === undefined)
        return invalidTaskId(args['taskId']);
      if (
        args['status'] !== undefined &&
        ![...STATUSES, 'deleted'].includes(args['status'] as string)
      )
        return 'status must be pending, in_progress, completed or deleted.';
      if (args['owner'] !== undefined && typeof args['owner'] !== 'string')
        return 'owner must be text.';
      for (const key of ['addBlocks', 'addBlockedBy']) {
        const list = args[key];
        if (list === undefined) continue;
        if (
          !Array.isArray(list) ||
          list.length > MANAGED_TEAM_LIMITS.maxBlockers
        )
          return `${key} must be a list of at most ${MANAGED_TEAM_LIMITS.maxBlockers} task IDs.`;
        const bad = list.find((each) => taskNumber(each) === undefined);
        if (bad !== undefined) return invalidTaskId(bad);
      }
      return (
        textError(args['subject'], 'subject', limits.maxSubjectChars, {
          required: false,
          line: true,
        }) ??
        textError(
          args['description'],
          'description',
          limits.maxDescriptionChars,
          { required: false, line: false },
        ) ??
        textError(args['activeForm'], 'activeForm', limits.maxActiveFormChars, {
          required: false,
          line: true,
        }) ??
        (args['metadata'] === undefined
          ? undefined
          : metadataError(args['metadata']))
      );
    }
    case 'task_list': {
      const keyError = knownKeys(args, ['status', 'owner', 'blockedBy']);
      if (keyError) return keyError;
      if (
        args['status'] !== undefined &&
        !STATUSES.includes(args['status'] as (typeof STATUSES)[number])
      )
        return 'status must be pending, in_progress or completed.';
      if (
        args['owner'] !== undefined &&
        (typeof args['owner'] !== 'string' ||
          sanitizeTeamName(args['owner']) === '')
      )
        return 'Cannot filter by owner: owner must include at least one letter, number, or hyphen.';
      if (
        args['blockedBy'] !== undefined &&
        taskNumber(args['blockedBy']) === undefined
      )
        return 'Cannot filter by blockedBy: blockedBy must be a task ID, optionally prefixed with #.';
      return undefined;
    }
    default: {
      const exhaustive: never = name;
      return exhaustive;
    }
  }
}

/** A team or member name in its record form, or why it has none. */
export function hostedTeamName(
  raw: unknown,
  what: 'Team' | 'Teammate',
): { readonly name?: string; readonly error?: string } {
  if (typeof raw !== 'string') return { error: `${what} name must be text.` };
  const name = sanitizeTeamName(raw);
  if (name === '')
    return {
      error:
        what === 'Team'
          ? 'Team name is required.'
          : `Teammate name ${JSON.stringify(raw)} sanitizes to an empty string. Choose a name with at least one alphanumeric character.`,
    };
  if (name.length > MANAGED_TEAM_LIMITS.maxNameLength)
    return {
      error: `${what} name must be at most ${MANAGED_TEAM_LIMITS.maxNameLength} characters after sanitizing.`,
    };
  if (what === 'Teammate' && name === MANAGED_TEAM_LEADER)
    return {
      error:
        '"leader" is reserved for the team leader. Choose a different teammate name.',
    };
  return { name };
}

/** Why a member cannot join the open team now, if anything stops it. */
export function hostedTeammateAdmissionError(
  team: TeamState | undefined,
  name: string,
): string | undefined {
  if (team === undefined)
    return 'No active team. Create one with team_create first, or omit "name" for an ordinary child agent.';
  if (team.lifecycle !== 'active')
    return `Team "${team.name}" is being deleted and takes no new members.`;
  if (team.members.some((member) => member.name === name))
    return `A teammate named "${name}" already exists in this team (existing: ${team.members.map((member) => member.name).join(', ')}). Choose a different name.`;
  if (team.members.length >= MANAGED_TEAM_LIMITS.maxMembers)
    return `Maximum number of teammates (${MANAGED_TEAM_LIMITS.maxMembers}) reached.`;
  return undefined;
}

/**
 * The answer of a background launch with `name`: the member started, or it
 * launched as an ordinary child without joining (`joinRefusal` says why).
 */
export function hostedTeammateStartedText(
  taskId: string,
  teammate: string,
  joinRefusal?: string,
): string {
  return joinRefusal === undefined
    ? `Teammate "${teammate}" started in the background as ${taskId}. It runs one turn, and its result arrives as a notification labeled with its name; it cannot take further work afterwards. A failed or cancelled teammate produces no notification — task_list shows each teammate's state.`
    : `Child agent started in the background as ${taskId}, but it did not join the team as "${teammate}": ${joinRefusal} It reports like an ordinary background child.`;
}

/**
 * The answer of a named launch whose run failed or was cancelled before it
 * joined: no notification follows, and the name stays free.
 */
export function hostedTeammateRunEndedText(
  teammate: string,
  run: ChildAgentRun,
): string {
  return `Child agent run ${run.run.state} (${run.stopReason ?? 'unknown'}) before it could join the team as "${teammate}". It produces no notification, and the name "${teammate}" stays free.`;
}

/** A member's run state as the board shows it. */
function memberState(run: ChildAgentRun | undefined): string {
  if (run === undefined) return 'unknown';
  switch (run.run.state) {
    case 'settled':
      return 'completed';
    case 'failed':
    case 'cancelled':
      return run.run.state;
    default:
      return 'running';
  }
}

export interface HostedTeamToolContext {
  readonly teams: HostedTeamSession;
  /** The child run of a member, read from the child-agent funnel. */
  readonly childRun: (childRunId: string) => ChildAgentRun | undefined;
  /** The call's replay-stable key, the base of every command it commits. */
  readonly callKey: string;
}

/** What a team tool answers: its text, and whether it is a refusal. */
export interface HostedTeamToolAnswer {
  readonly text: string;
  readonly error: boolean;
}

function refuse(text: string): HostedTeamToolAnswer {
  return { text, error: true };
}

function answer(text: string): HostedTeamToolAnswer {
  return { text, error: false };
}

function memberRunning(
  context: HostedTeamToolContext,
  childRunId: string,
): boolean {
  const run = context.childRun(childRunId);
  return run === undefined || !isTerminalRunState(run.run.state);
}

/** Runs one admitted team tool call against the lead's funnel. */
export async function runHostedTeamTool(
  context: HostedTeamToolContext,
  name: HostedTeamToolName,
  raw: Record<string, unknown>,
): Promise<HostedTeamToolAnswer> {
  const args = withoutBlankOptionals(name, raw);
  switch (name) {
    case 'team_create':
      return teamCreate(context, args);
    case 'team_delete':
      return teamDelete(context);
    case 'task_create':
      return taskCreate(context, args);
    case 'task_update':
      return taskUpdate(context, args);
    case 'task_list':
      return taskList(context, args);
    default: {
      const exhaustive: never = name;
      return exhaustive;
    }
  }
}

async function teamCreate(
  context: HostedTeamToolContext,
  args: Record<string, unknown>,
): Promise<HostedTeamToolAnswer> {
  const { teams, callKey } = context;
  if (!teams.committed('createTeam', callKey)) {
    const parsed = hostedTeamName(args['team_name'], 'Team');
    if (parsed.error !== undefined) return refuse(parsed.error);
    const open = teams.openTeam();
    if (open?.lifecycle === 'closing')
      return refuse(
        `Team "${open.name}" is still being deleted. Call team_delete to finish it before creating a new one.`,
      );
    if (open !== undefined)
      return refuse(
        'A team is already active. Delete it before creating a new one.',
      );
    await teams.createTeam(callKey, parsed.name!);
  }
  const team = teams.team(callKey)!;
  return answer(
    `Team "${team.name}" created. Spawn members with the agent tool's "name" parameter; each member runs one turn in the background and reports back by notification.`,
  );
}

async function teamDelete(
  context: HostedTeamToolContext,
): Promise<HostedTeamToolAnswer> {
  const { teams, callKey } = context;
  const resumed =
    teams.committedRecordId('closeTeam', `${callKey}:closing`) ??
    teams.committedRecordId('deleteTeam', `${callKey}:deleted`);
  const team = resumed === undefined ? teams.openTeam() : teams.team(resumed);
  if (team === undefined) return refuse('No active team to delete.');
  if (resumed === undefined) {
    const running = team.members.filter((member) =>
      memberRunning(context, member.childRunId),
    );
    if (running.length > 0)
      return refuse(
        `Team "${team.name}" still has running members: ${running.map((member) => member.name).join(', ')}. A member cannot be stopped yet; wait for their results, which arrive as notifications, then delete the team.`,
      );
  }
  await teams.deleteTeam(callKey, team.teamId);
  return answer(`Team "${team.name}" deleted.`);
}

async function taskCreate(
  context: HostedTeamToolContext,
  args: Record<string, unknown>,
): Promise<HostedTeamToolAnswer> {
  const { teams, callKey } = context;
  const committed = teams.committedRecordId('createTeamTask', callKey);
  let task: TeamTask;
  if (committed !== undefined) {
    task = teams.task(committed)!;
  } else {
    const team = teams.openTeam();
    if (team === undefined)
      return refuse('No active team. Create a team first.');
    if (team.lifecycle !== 'active')
      return refuse(
        `Team "${team.name}" is being deleted and takes no new tasks.`,
      );
    task = await teams.createTask(callKey, {
      teamId: team.teamId,
      subject: args['subject'] as string,
      description: args['description'] as string,
      activeForm: (args['activeForm'] as string | undefined) ?? null,
      metadata:
        (args['metadata'] as Record<string, unknown> | undefined) ?? null,
    });
  }
  return answer(`Task #${task.number} created: "${task.subject}"`);
}

/** The step count of one update: the task, then one per `addBlocks`. */
const MAX_UPDATE_STEPS = 1 + MANAGED_TEAM_LIMITS.maxBlockers;

async function taskUpdate(
  context: HostedTeamToolContext,
  args: Record<string, unknown>,
): Promise<HostedTeamToolAnswer> {
  const { teams, callKey } = context;
  const team = teams.openTeam();
  if (team === undefined) return refuse('No active team. Create a team first.');
  const number = taskNumber(args['taskId'])!;
  const taskId = teamTaskRecordId(team.teamId, number);
  const all = teams.tasksOf(team.teamId);
  const live = all.filter((task) => task.status !== 'deleted');
  const byNumber = new Map(live.map((task) => [task.number, task]));
  const task = byNumber.get(number);
  // A replay whose first step deleted the task still finishes the call.
  const resumed = teams.committed('updateTeamTask', `${callKey}:0`);
  if (task === undefined && !resumed)
    return refuse(`Task #${number} not found.`);
  if (args['status'] === 'deleted') {
    await teams.updateTasks(callKey, [
      { taskId, change: { status: 'deleted' } },
    ]);
    return answer(`Task #${number} deleted.`);
  }
  const current = task ?? teams.task(taskId)!;
  const change: {
    -readonly [Key in keyof TeamTaskChange]: TeamTaskChange[Key];
  } = {};
  if (args['subject'] !== undefined) change.subject = args['subject'] as string;
  if (args['activeForm'] !== undefined)
    change.activeForm = args['activeForm'] as string;
  if (args['status'] !== undefined)
    change.status = args['status'] as TeamTaskStatus;
  if (args['owner'] !== undefined) {
    const raw = args['owner'] as string;
    if (raw === '') {
      change.owner = null;
    } else {
      const owner = sanitizeTeamName(raw);
      if (owner === '')
        return refuse(
          `Cannot assign task #${number}: owner must include at least one letter, number, or hyphen.`,
        );
      // Only a new owner is checked: a task keeps the owner it has after
      // that member's one-shot run ends (decision 5).
      if (owner !== current.owner && owner !== MANAGED_TEAM_LEADER) {
        const member = team.members.find((each) => each.name === owner);
        if (member === undefined)
          return refuse(
            `Cannot assign to "${owner}": no teammate by that name. Spawn the teammate first or choose an existing one.`,
          );
        if (!memberRunning(context, member.childRunId))
          return refuse(
            `Cannot assign to "${owner}": that teammate's run has ended and cannot take assignments.`,
          );
      }
      change.owner = owner;
    }
  }
  const owner = change.owner === undefined ? current.owner : change.owner;
  if ((change.status ?? current.status) === 'in_progress' && owner === null)
    return refuse(
      `Cannot move task #${number} to in_progress without an owner. Specify the "owner" parameter.`,
    );
  const blockedBy = ((args['addBlockedBy'] as unknown[] | undefined) ?? []).map(
    (each) => taskNumber(each)!,
  );
  const blocks = ((args['addBlocks'] as unknown[] | undefined) ?? []).map(
    (each) => taskNumber(each)!,
  );
  if ([...blockedBy, ...blocks].includes(number))
    return refuse(
      `Cannot update task #${number}: a task cannot block or be blocked by itself.`,
    );
  const missing = [...new Set([...blockedBy, ...blocks])].filter(
    (each) => !byNumber.has(each),
  );
  if (missing.length > 0)
    return refuse(
      `Cannot update task #${number}: referenced task(s) ${missing.map((each) => `#${each}`).join(', ')} not found.`,
    );
  // The graph after this call: every new edge reads as `X blockedBy Y`.
  // A deleted task keeps its edges, and the record rule walks them too.
  const edges = new Map(all.map((each) => [each.taskId, [...each.blockedBy]]));
  const added: Array<[string, string]> = [
    ...blockedBy.map(
      (each) =>
        [taskId, teamTaskRecordId(team.teamId, each)] as [string, string],
    ),
    ...blocks.map(
      (each) =>
        [teamTaskRecordId(team.teamId, each), taskId] as [string, string],
    ),
  ];
  for (const [from, to] of added) {
    const list = edges.get(from) ?? [];
    if (!list.includes(to)) list.push(to);
    edges.set(from, list);
  }
  if (
    added.some(([from, to]) =>
      teamTaskReaches(to, from, (each) => edges.get(each) ?? []),
    )
  )
    return refuse(
      `Cannot update task #${number}: this would create a dependency cycle.`,
    );
  const crowded = [...new Set(added.map(([from]) => from))].find(
    (each) => (edges.get(each) ?? []).length > MANAGED_TEAM_LIMITS.maxBlockers,
  );
  if (crowded !== undefined)
    return refuse(
      `Cannot update task #${number}: task #${all.find((each) => each.taskId === crowded)?.number ?? number} would be blocked by more than ${MANAGED_TEAM_LIMITS.maxBlockers} tasks (completed and deleted blockers stay on a task and count).`,
    );
  if (blockedBy.length > 0)
    change.addBlockedBy = blockedBy.map((each) =>
      teamTaskRecordId(team.teamId, each),
    );
  if (args['description'] !== undefined)
    change.descriptionRef = await teams.publishText(
      args['description'] as string,
    );
  if (args['metadata'] !== undefined) {
    // A Map keeps every key a plain data key: an assignment would treat
    // `__proto__` as the object's prototype and drop it silently.
    const entries = new Map(
      Object.entries(
        current.metadataRef === null
          ? {}
          : await teams.readJson(current.metadataRef),
      ),
    );
    for (const [key, value] of Object.entries(
      args['metadata'] as Record<string, unknown>,
    )) {
      if (value === null) entries.delete(key);
      else entries.set(key, value);
    }
    const merged = Object.fromEntries(entries);
    const tooLarge = metadataError(merged);
    if (Object.keys(merged).length > 0 && tooLarge) return refuse(tooLarge);
    change.metadataRef =
      Object.keys(merged).length === 0 ? null : await teams.publishJson(merged);
  }
  const steps: HostedTeamTaskStep[] = [
    { taskId, change },
    ...blocks.map((each) => ({
      taskId: teamTaskRecordId(team.teamId, each),
      change: { addBlockedBy: [taskId] },
    })),
  ];
  await teams.updateTasks(callKey, steps);
  const updated = teams.task(taskId)!;
  const notice =
    change.owner !== undefined &&
    change.owner !== null &&
    change.owner !== MANAGED_TEAM_LEADER
      ? ' The teammate was not notified: members learn of assignments once the team mailbox lands, so tell a member its work in its launch prompt.'
      : '';
  return answer(
    `Task #${number} updated (status: ${updated.status}${updated.owner ? `, owner: ${updated.owner}` : ''}).${notice}`,
  );
}

function taskList(
  context: HostedTeamToolContext,
  args: Record<string, unknown>,
): HostedTeamToolAnswer {
  const { teams } = context;
  const team = teams.openTeam();
  if (team === undefined) return refuse('No active team. Create a team first.');
  const live = teams
    .tasksOf(team.teamId)
    .filter((task) => task.status !== 'deleted');
  const byId = new Map(live.map((task) => [task.taskId, task]));
  const owner =
    args['owner'] === undefined
      ? undefined
      : sanitizeTeamName(args['owner'] as string);
  const blocker =
    args['blockedBy'] === undefined
      ? undefined
      : teamTaskRecordId(team.teamId, taskNumber(args['blockedBy'])!);
  // Legacy drops a blocker from its dependents once it completes or is
  // deleted; the board keeps every edge, so only an open blocker matches.
  const lines = live
    .map((task) => ({ task, open: openTeamTaskBlockers(task, byId) }))
    .filter(
      ({ task, open }) =>
        (args['status'] === undefined || task.status === args['status']) &&
        (owner === undefined || task.owner === owner) &&
        (blocker === undefined || open.some((each) => each.taskId === blocker)),
    )
    .map(
      ({ task, open }) =>
        `#${task.number} [${task.status}] @${task.owner ?? 'unassigned'} — ${task.subject}${open.length > 0 ? ` (blocked by ${open.map((each) => `#${each.number}`).join(', ')})` : ''}`,
    );
  const roster =
    team.members.length === 0
      ? 'Members: none yet.'
      : [
          'Members:',
          ...team.members.map(
            (member) =>
              `- ${member.name}: ${memberState(context.childRun(member.childRunId))}`,
          ),
        ].join('\n');
  return answer(
    `${lines.length > 0 ? lines.join('\n') : 'No tasks found.'}\n\n${roster}`,
  );
}

/**
 * What an interrupted team call answers when recovery settles its turn
 * instead of running it again: a call that committed says what the
 * records hold, and one stopped part-way leaves the rest to the model.
 * Undefined when the call committed nothing — it never ran.
 */
export function hostedTeamCallRecoveredAnswer(
  teams: HostedTeamSession,
  name: string,
  callKey: string,
): HostedTeamToolAnswer | undefined {
  const interrupted = 'The turn was interrupted after this call committed.';
  switch (name) {
    case 'team_create': {
      const team = teams.committed('createTeam', callKey)
        ? teams.team(callKey)
        : undefined;
      return team === undefined
        ? undefined
        : answer(`${interrupted} Team "${team.name}" created.`);
    }
    case 'team_delete': {
      const deleted = teams.committedRecordId(
        'deleteTeam',
        `${callKey}:deleted`,
      );
      if (deleted !== undefined)
        return answer(
          `${interrupted} Team "${teams.team(deleted)!.name}" deleted.`,
        );
      const closing = teams.committedRecordId(
        'closeTeam',
        `${callKey}:closing`,
      );
      return closing === undefined
        ? undefined
        : refuse(
            `The turn was interrupted part-way through deleting team "${teams.team(closing)!.name}": it takes no new members or tasks. Call team_delete again to finish the deletion.`,
          );
    }
    case 'task_create': {
      const created = teams.committedRecordId('createTeamTask', callKey);
      const task = created === undefined ? undefined : teams.task(created);
      return task === undefined
        ? undefined
        : answer(
            `${interrupted} Task #${task.number} created: "${task.subject}"`,
          );
    }
    case 'task_update':
      return hostedTeamCallCommitted(teams, name, callKey)
        ? refuse(
            'The turn was interrupted while this update was committing, and some or all of its changes landed. Read task_list for the board as it stands before retrying.',
          )
        : undefined;
    default:
      return undefined;
  }
}

/** Whether a team call left any commit, so a resumed turn can tell it ran. */
export function hostedTeamCallCommitted(
  teams: HostedTeamSession,
  name: string,
  callKey: string,
): boolean {
  switch (name) {
    case 'team_create':
      return teams.committed('createTeam', callKey);
    case 'team_delete':
      return (
        teams.committed('closeTeam', `${callKey}:closing`) ||
        teams.committed('deleteTeam', `${callKey}:deleted`)
      );
    case 'task_create':
      return teams.committed('createTeamTask', callKey);
    case 'task_update':
      for (let step = 0; step < MAX_UPDATE_STEPS; step++)
        if (teams.committed('updateTeamTask', `${callKey}:${step}`))
          return true;
      return false;
    default:
      return false;
  }
}
