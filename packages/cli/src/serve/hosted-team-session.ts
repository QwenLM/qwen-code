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
import { managedChildTaskId } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-projection.js';
import {
  memberPlanModeRequired,
  hostedOpenTeamChainMember,
  teamMemberPreamble,
} from './hosted-member-chain.js';
import type { HostedChildAgentSession } from './hosted-child-agent-session.js';
import {
  decodeChildLaunchEnvelope,
  encodeChildLaunchEnvelope,
  MANAGED_CHILD_LIMITS,
  type ChildLaunchEnvelope,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-operations.js';
import { escapeXml } from '@qwen-code/qwen-code-core/utils/xml.js';
import {
  assertManagedSessionDomainEnabled,
  ManagedSessionRecordError,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { ManagedSessionConflictError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
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
  parseTeamPlan,
  type TeamPlan,
  type TeamPlanDecision,
  type TeamState,
  type TeamTask,
  type TeamTaskStatus,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-team-record.js';
import {
  teamJoinBody,
  teamLifecycleBody,
  teamOpenBody,
  teamPlanOpenBody,
  teamPlanDecisionBody,
  teamPlanWithdrawBody,
  teamTaskOpenBlockers,
  teamTaskOpenBody,
  teamTaskRevisionBody,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-team-operations.js';
import { stripAnsiAndControl } from '@qwen-code/qwen-code-core/utils/textUtils.js';
import {
  HostedChildChains,
  givenWorkThisTurn,
  hasCompletedRun,
  hostedMemberView,
  hostedNeverStarted,
  isEndedMember,
  isRunningMember,
  neverStartedAction,
  neverStartedClause,
  outboundChildMessages,
  type HostedMemberView,
} from './hosted-member-chain.js';

// H4e-b1 of #12827: the lead Session's team funnel. The lead alone writes
// its team: the roster and lifecycle (team_state) and the board
// (team_task), each verb validating against the committed records and
// committing through one serial chain under command ids derived from the
// tool call, so a replayed call finds what it committed and adds nothing
// twice. Members are H4b child agents; this funnel only names them. See
// docs/design/2026-10-10-managed-agent-team-lead-runtime.md. H4e-b2 reads
// each member through its continuation chain: the roster names the
// chain's first run, and the member is the chain's head (see
// docs/design/2026-10-11-managed-agent-team-mailbox.md).

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

/**
 * The stop a lead tool requests of a member's head. A user's H4f cancel
 * commits the same revision (H4e-b3 decision 10), so the lead's request
 * goes through the child funnel, never through this funnel's store: the
 * two funnels each own their writes chain. A lane whose Shell profile
 * suppresses child agents attaches no such funnel; the team surface
 * there is read-only, and a member it may carry refuses shutdowns. The
 * command id a `request_shutdown` stop commits under names the call that
 * asked, so an interrupted turn's recovery tells it apart from someone
 * else's stop.
 */
export interface HostedTeamStops {
  sendToChild?: HostedChildAgentSession['sendToChild'];
  requestStop(
    childRunId: string,
    evidence?: { readonly operation: string; readonly commandId: string },
  ): Promise<void>;
}

/** The Legacy board tools' schema bounds, in characters. */
export const SUBJECT_CHARS = 200;
export const DESCRIPTION_CHARS = 10_000;
export const ACTIVE_FORM_CHARS = 200;
export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'deleted'];
const UNSAFE_METADATA_KEYS = ['__proto__', 'constructor', 'prototype'];
const TRUSTED: ManagedSessionActor = { class: 'trusted_entry' };

export const HOSTED_TEAM_PLAN_TOOL: FunctionDeclaration = {
  name: 'team_plan_approval',
  description:
    'Show a member plan, or approve or reject it after its run settles. Decisions continue the member with the quoted plan.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      request_id: { type: 'string' },
      action: { type: 'string', enum: ['approve', 'reject', 'show'] },
      message: {
        type: 'string',
        description: 'Feedback, at most 4096 UTF-8 bytes.',
      },
    },
    required: ['request_id', 'action'],
    additionalProperties: false,
  },
};

export interface HostedTeamDeliveryContext {
  readonly closing: boolean;
  readonly childWorkspaces?: boolean;
}

export function teamPlanInstruction(
  plan: string,
  decision: TeamPlanDecision,
  feedback: string,
): string {
  return `Your plan was ${decision}. ${decision === 'approved' ? 'Carry out the plan.' : 'Revise the plan and call exit_plan_mode again.'}\n<plan>\n${escapeXml(plan)}\n</plan>\n<feedback>${escapeXml(feedback)}</feedback>`;
}

/** The largest feedback a decision may carry, escaped at its worst. */
const PLAN_FEEDBACK_RESERVE = '"'.repeat(4096);

/**
 * A plan over its continuation bound is refused with its size and the
 * room left, both in envelope bytes: the plan as XML-escaped and then
 * JSON-encoded inside the prompt, and the bound less the envelope with an
 * empty plan. Both escapes map code point by code point and the plan sits
 * between newlines, so its bytes add exactly to the empty-plan envelope:
 * the plan fits exactly when the first figure is at most the second.
 */
function planBoundRefusal(
  launch: ChildLaunchEnvelope,
  preamble: string,
  plan: string,
): string {
  const refusal =
    'Plan exceeds its continuation envelope including escaped feedback reserve (byte_limit)';
  let fixed: number;
  try {
    fixed = encodeChildLaunchEnvelope({
      ...launch,
      prompt:
        preamble + teamPlanInstruction('', 'rejected', PLAN_FEEDBACK_RESERVE),
    }).byteLength;
  } catch (cause) {
    if (!(cause instanceof ManagedSessionRecordError)) throw cause;
    // No plan fits: there is no room to name, so no size to shorten to.
    return `${refusal}.`;
  }
  const needed = Buffer.byteLength(JSON.stringify(escapeXml(plan)), 'utf8') - 2;
  return `${refusal}: it needs ${needed} bytes after XML and JSON escaping and ${MANAGED_CHILD_LIMITS.maxEnvelopeBytes - fixed} fit. Shorten it and call exit_plan_mode again.`;
}

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
      "Delete this Session's team. Refused while a member is still running: stop it first with request_shutdown and wait until task_list shows it ended.",
    parametersJsonSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'request_shutdown',
    description:
      'Stop a team member: its current run settles as if its task were cancelled, and it is not asked. A member that already finished is not touched: it takes no work unless you send it some. Delete the team with team_delete once task_list shows every member ended.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'The name of the team member to stop.',
        },
      },
      required: ['to'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_create',
    description:
      'Create a pending task on the team board. Members are not told about board changes: give a member its work in its launch prompt or with send_message to its name, which continues a member that has finished.',
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
      'Update a board task: status, owner, subject, description, active form, metadata and dependencies. Set status to "deleted" to remove it. A task in progress needs an owner: "leader", a member that is still running and not being stopped, or a member you gave work with send_message earlier in this turn. A member that completed work can otherwise be the owner only of a completed task, so a task whose owner has finished moves to another open status only with a new owner or new work sent first. Dependencies only grow, and a completed or deleted blocker stops blocking. Members are not told about the update: to give a member new work, send_message it the work by name first, then update the task in the same turn.',
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
      'List the team board, optionally filtered, followed by each member with the state of its current run, which is its newest one that did not fail to start (and why a failed or cancelled run ended), its task id while it can still take work, and a newer continuation that never started, with the messages that did not reach it. Address a member with send_message to its name.',
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
  request_shutdown: ['to'],
  team_plan_approval: ['request_id', 'action', 'message'],
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
  if (toolName === 'team_plan_approval') {
    if (typeof args['request_id'] !== 'string' || !args['request_id'])
      return 'request_id must be a nonempty string.';
    if (!['approve', 'reject', 'show'].includes(args['action'] as string))
      return 'action must be approve, reject or show.';
    if (
      args['message'] !== undefined &&
      (typeof args['message'] !== 'string' ||
        Buffer.byteLength(args['message'], 'utf8') > 4096)
    )
      return 'message must be at most 4096 UTF-8 bytes.';
  }
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
  if (toolName === 'request_shutdown' && typeof args['to'] !== 'string')
    return 'to must be a string.';
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

/** A team is open while active, or closing until it is deleted. */
function isOpenTeam(team: TeamState): boolean {
  return team.lifecycle !== 'deleted';
}

/** The roster entry naming one child run, among a Session's team records. */
export function hostedTeamMembership(
  teams: ReadonlyArray<{ readonly record: unknown }>,
  childRunId: string,
): HostedTeamMembership | undefined {
  return membershipAmong(teams, childRunId, () => true);
}

function membershipAmong(
  teams: ReadonlyArray<{ readonly record: unknown }>,
  childRunId: string,
  admits: (team: TeamState) => boolean,
): HostedTeamMembership | undefined {
  for (const entry of teams) {
    const team = parseTeamState(entry.record);
    if (!admits(team)) continue;
    const member = team.members.find((each) => each.childRunId === childRunId);
    if (member !== undefined)
      return { teamId: team.teamId, teamName: team.name, name: member.name };
  }
  return undefined;
}

export class HostedTeamSession {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: HostedTeamStore,
    private readonly key: ManagedSessionKey,
    private readonly stops?: HostedTeamStops,
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
      .find(isOpenTeam);
  }

  /** The member a child run joined as, in any team of this Session. */
  membership(childRunId: string): HostedTeamMembership | undefined {
    return hostedTeamMembership(
      this.store.authority.extensionRecordsInDomain('team_state'),
      childRunId,
    );
  }

  /**
   * H4e-b2 decision 2: a member read through its continuation chain. The
   * roster entry names the chain's first run; the member is the chain's
   * head, the newest continuation that did not prove it never started.
   * A caller reading several members passes one index for all of them.
   */
  memberView(
    rootChildRunId: string,
    chains: HostedChildChains = this.chains(),
  ): HostedMemberView {
    return hostedMemberView(chains, rootChildRunId);
  }

  /**
   * Whether a call committed any part of its team write before its Turn
   * died: the interrupted Turn's settlement must not answer such a call
   * as one that never ran. H4e-b3 decision 14's stop evidence is keyed to
   * the call that requested it — `shutdown:${callKey}` — never to the
   * member-head bit, so a stop someone else requested is not credited to
   * a call that never ran, and the keyed evidence survives a continuation
   * that later never started.
   */
  committedBy(toolName: string, callKey: string): boolean {
    if (toolName === 'team_plan_approval')
      return (
        this.committed('decideTeamPlan', callKey) !== undefined ||
        this.plans().some(
          (plan) =>
            this.committed(
              'withdrawTeamPlan',
              `decision:${callKey}:${plan.requestId}`,
            ) !== undefined,
        )
      );
    if (toolName === 'request_shutdown') {
      return (
        this.committed('commitChildRunRecord', `shutdown:${callKey}`) !==
          undefined ||
        this.plans().some(
          (plan) =>
            this.committed(
              'withdrawTeamPlan',
              `shutdown:${callKey}:${plan.requestId}`,
            ) !== undefined,
        )
      );
    }
    const commands: ReadonlyArray<readonly [string, string]> =
      toolName === 'team_create'
        ? [['createTeam', callKey]]
        : toolName === 'task_create'
          ? [['createTeamTask', callKey]]
          : toolName === 'team_delete'
            ? [
                ['deleteTeam', `${callKey}:closing`],
                ['deleteTeam', `${callKey}:deleted`],
                ...this.plans().map(
                  (plan) =>
                    [
                      'withdrawTeamPlan',
                      `delete:${callKey}:${plan.requestId}`,
                    ] as const,
                ),
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
    /**
     * H4e-b2 decision 7: the current Turn's call-key prefix,
     * `${promptKey}:`. The tool turn, the one production caller, always
     * passes it; a caller outside a model Turn has no work given in one.
     */
    turnPrefix?: string,
    delivery: HostedTeamDeliveryContext = { closing: false },
  ): Promise<string> {
    return this.serial(() => {
      switch (toolName) {
        case 'team_plan_approval':
          return this.decidePlan(callKey, args, delivery);
        case 'team_create':
          return this.createTeam(callKey, args['team_name'] as string);
        case 'team_delete':
          return this.deleteTeam(callKey);
        case 'task_create':
          return this.createTask(callKey, args);
        case 'task_update':
          return this.updateTask(callKey, args, turnPrefix);
        case 'task_list':
          return Promise.resolve(this.listTasks(args));
        case 'request_shutdown':
          return this.requestShutdown(callKey, args['to'] as string);
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
    // H4e-b3 decision 7: `parent` is how a member addresses its leader, so
    // no member may take the word other members address their leader with.
    if (name === 'parent')
      throw new HostedTeamRefusal(
        `"parent" is reserved for the Session that accepts the members' messages. Choose a different teammate name.`,
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
    readonly planModeRequired?: boolean;
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
            planModeRequired: params.planModeRequired ?? false,
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

  plan(requestId: string): TeamPlan | undefined {
    const record = this.store.authority.extensionRecord('team_plan', requestId);
    return record === undefined ? undefined : parseTeamPlan(record.record);
  }

  plans(teamId?: string): TeamPlan[] {
    return this.store.authority
      .extensionRecordsInDomain('team_plan')
      .map((entry) => parseTeamPlan(entry.record))
      .filter((plan) => teamId === undefined || plan.teamId === teamId);
  }

  async showPlan(requestId: string): Promise<string> {
    const plan = this.plan(requestId);
    if (plan === undefined)
      throw new HostedTeamRefusal(`No plan ${requestId}.`);
    const feedback =
      plan.feedbackRef === null
        ? ''
        : (await this.store.resources.read(plan.feedbackRef)).toString('utf8');
    return `Plan ${requestId}, member ${plan.member}, revision ${plan.planRevision}: ${plan.decision ?? plan.run.state}\n${(await this.store.resources.read(plan.planRef)).toString('utf8')}${feedback ? `\nFeedback: ${feedback}` : ''}`;
  }

  submitPlan(
    commandId: string,
    childRunId: string,
    text: string,
  ): Promise<string> {
    return this.serial(async () => {
      const prior = this.plan(commandId);
      if (prior !== undefined) return this.submissionAnswer(prior);
      const superseded = this.supersededPlan(commandId);
      if (superseded !== undefined)
        return this.finishSupersede(commandId, superseded, text);
      assertManagedSessionDomainEnabled('team_plan');
      const chains = this.chains();
      const member = hostedOpenTeamChainMember(
        this.store.authority.extensionRecordsInDomain('team_state'),
        chains,
        childRunId,
      );
      if (member === undefined || member.team.lifecycle !== 'active')
        throw new HostedTeamRefusal(
          'Plan submission requires an active team membership.',
        );
      const view = hostedMemberView(chains, member.rootChildRunId);
      if (
        !isRunningMember(view) ||
        view.stopping ||
        view.head?.childRunId !== childRunId
      )
        throw new HostedTeamRefusal(
          'Only the running, unstopped member head may submit a plan.',
        );
      if (
        !member.team.members.find((entry) => entry.name === member.name)!
          .planModeRequired
      )
        throw new HostedTeamRefusal(
          'This member does not require plan approval.',
        );
      if (!text.trim())
        throw new HostedTeamRefusal('A plan must not be empty.');
      const launch = decodeChildLaunchEnvelope(
        await this.store.resources.read(view.head.inputRef),
      );
      const preamble = teamMemberPreamble(
        { name: member.name, teamName: member.team.name },
        true,
      );
      try {
        encodeChildLaunchEnvelope({
          ...launch,
          prompt:
            preamble +
            teamPlanInstruction(text, 'rejected', PLAN_FEEDBACK_RESERVE),
        });
      } catch (cause) {
        if (!(cause instanceof ManagedSessionRecordError)) throw cause;
        throw new HostedTeamRefusal(planBoundRefusal(launch, preamble, text));
      }
      const planRef = await this.store.resources.publish(
        'managed-team-content',
        Buffer.from(text, 'utf8'),
      );
      const checkHead = () => {
        const current = this.memberView(member.rootChildRunId);
        if (
          current.head?.childRunId !== childRunId ||
          !isRunningMember(current) ||
          current.stopping ||
          this.team(member.team.teamId)?.lifecycle !== 'active'
        )
          throw new HostedTeamRefusal(
            'The submitting member is no longer the running, unstopped head.',
          );
      };
      checkHead();
      const plans = this.plans(member.team.teamId).filter(
        (plan) => plan.member === member.name,
      );
      await this.withdrawPlans(
        member.team.teamId,
        member.name,
        `supersede:${commandId}`,
      );
      // A committed cancellation owes its successor even if the run settled.
      // Without that evidence this is still a fresh admission.
      if (this.supersededPlan(commandId) === undefined) checkHead();
      const plan = teamPlanOpenBody({
        teamId: member.team.teamId,
        requestId: commandId,
        member: member.name,
        planRevision:
          Math.max(0, ...plans.map((entry) => entry.planRevision)) + 1,
        planRef,
      });
      await this.commit('team_plan', plan, 'submitTeamPlan', commandId);
      return this.submissionAnswer(plan);
    });
  }

  supersededPlan(commandId: string): TeamPlan | undefined {
    return this.plans()
      .filter(
        (plan) =>
          this.committed(
            'withdrawTeamPlan',
            `supersede:${commandId}:${plan.requestId}`,
          ) !== undefined,
      )
      .sort((a, b) => b.planRevision - a.planRevision)[0];
  }

  private async finishSupersede(
    commandId: string,
    previous: TeamPlan,
    text: string,
  ): Promise<string> {
    const revision = previous.planRevision + 1;
    const newer = this.plans(previous.teamId).find(
      (plan) =>
        plan.member === previous.member && plan.planRevision >= revision,
    );
    if (newer !== undefined)
      return `This submission was superseded by plan ${newer.requestId} revision ${newer.planRevision}; it is not pending approval. End your turn.`;
    const planRef = await this.store.resources.publish(
      'managed-team-content',
      Buffer.from(text, 'utf8'),
    );
    const plan = teamPlanOpenBody({
      teamId: previous.teamId,
      member: previous.member,
      requestId: commandId,
      planRevision: revision,
      planRef,
    });
    await this.commit('team_plan', plan, 'submitTeamPlan', commandId);
    return this.submissionAnswer(plan);
  }

  private submissionAnswer(plan: TeamPlan): string {
    return `Your plan was submitted as revision ${plan.planRevision}. End your turn now; the leader's decision arrives as your next instruction.`;
  }

  private async withdrawPlans(
    teamId: string,
    member: string | undefined,
    callKey: string,
  ): Promise<void> {
    try {
      assertManagedSessionDomainEnabled('team_plan');
    } catch (cause) {
      if (!(cause instanceof ManagedSessionRecordError)) throw cause;
      return;
    }
    for (const plan of this.plans(teamId)) {
      if (
        plan.run.state !== 'waiting' ||
        (member !== undefined && plan.member !== member)
      )
        continue;
      await this.commit(
        'team_plan',
        teamPlanWithdrawBody(plan),
        'withdrawTeamPlan',
        `${callKey}:${plan.requestId}`,
      );
    }
  }

  /** Recovery reads only this call's settlement and continuation, never another decision. */
  async planDecisionEvidence(callKey: string): Promise<string | undefined> {
    const requestId = this.committed('decideTeamPlan', callKey);
    if (requestId === undefined) {
      const withdrawn = this.plans().filter(
        (plan) =>
          this.committed(
            'withdrawTeamPlan',
            `decision:${callKey}:${plan.requestId}`,
          ) !== undefined,
      );
      if (withdrawn.length === 0) return undefined;
      return withdrawn
        .map(
          (plan) =>
            `Plan ${plan.requestId} was withdrawn because ${plan.member} ended or was stopped.`,
        )
        .join('\n');
    }
    const plan = this.plan(requestId)!;
    const continued = this.committed('continueChildRun', callKey);
    if (continued !== undefined) {
      const run = this.childRun(continued)!;
      if (run.run.execution === 'not_started_proven')
        return `The decision on ${plan.member}'s plan ${requestId} revision ${plan.planRevision} was recorded (${plan.decision}), but its continuation never started. Send the decision again with send_message, quoting the plan (team_plan_approval action "show", request_id "${requestId}").`;
      return `The decision on ${plan.member}'s plan ${requestId} revision ${plan.planRevision} was recorded (${plan.decision}) and the member was continued.`;
    }
    return `The decision on ${plan.member}'s plan ${requestId} revision ${plan.planRevision} was recorded (${plan.decision}). The call stopped before ${plan.member} was continued; send the decision with send_message, quoting the plan (team_plan_approval with action "show", request_id "${requestId}" returns it).`;
  }

  private async decidePlan(
    callKey: string,
    args: Record<string, unknown>,
    delivery: HostedTeamDeliveryContext,
  ): Promise<string> {
    const evidence = await this.planDecisionEvidence(callKey);
    if (evidence !== undefined) return evidence;
    const error = hostedTeamArgumentError('team_plan_approval', args);
    if (error !== undefined) throw new HostedTeamRefusal(error);
    const requestId = args['request_id'] as string;
    if (args['action'] === 'show') return this.showPlan(requestId);
    assertManagedSessionDomainEnabled('team_plan');
    const plan = this.plan(requestId);
    if (plan === undefined)
      throw new HostedTeamRefusal(`No plan ${requestId}.`);
    if (plan.run.state !== 'waiting')
      return `Plan ${requestId} is ${plan.decision ?? plan.run.state}.`;
    const team = this.team(plan.teamId)!;
    const member = team.members.find((entry) => entry.name === plan.member)!;
    const view = this.memberView(member.childRunId);
    if (isEndedMember(view) || view.stopping) {
      await this.withdrawPlans(team.teamId, member.name, `decision:${callKey}`);
      return `Plan ${requestId} was withdrawn because ${member.name} ended or was stopped.`;
    }
    if (team.lifecycle !== 'active')
      throw new HostedTeamRefusal('The team is not active.');
    if (
      this.plans(team.teamId).some(
        (entry) =>
          entry.member === member.name &&
          entry.planRevision > plan.planRevision,
      )
    )
      throw new HostedTeamRefusal(
        'Only the newest waiting plan may be decided.',
      );
    if (!view.continuable || view.head === undefined)
      throw new HostedTeamRefusal(`Decide after ${member.name}'s run settles.`);
    if (this.stops?.sendToChild === undefined)
      throw new HostedTeamRefusal(
        'This Session cannot continue a plan member.',
      );
    const feedback = (args['message'] as string | undefined) ?? '';
    const decision: TeamPlanDecision =
      args['action'] === 'approve' ? 'approved' : 'rejected';
    const text = teamPlanInstruction(
      (await this.store.resources.read(plan.planRef)).toString('utf8'),
      decision,
      feedback,
    );
    const route = {
      taskId: managedChildTaskId(this.key.sessionId, view.head.childRunId),
      text,
      messageId: `plan:${callKey}`,
      continuationRunId: callKey,
      executionCallId: callKey,
      ...delivery,
      continuationOnly: true,
      planDecision: { requestId, decision, childRunId: view.head.childRunId },
    };
    const feedbackRef = feedback
      ? await this.store.resources.publish(
          'managed-team-content',
          Buffer.from(feedback, 'utf8'),
        )
      : null;
    const preflight = await this.stops.sendToChild({
      ...route,
      preflight: true,
    });
    if (preflight.kind === 'refused')
      throw new HostedTeamRefusal(preflight.reason);
    const current = this.memberView(member.childRunId);
    if (
      !current.continuable ||
      current.head?.childRunId !== view.head.childRunId
    )
      throw new HostedTeamRefusal(`Decide after ${member.name}'s run settles.`);
    await this.commit(
      'team_plan',
      teamPlanDecisionBody(plan, decision, feedbackRef),
      'decideTeamPlan',
      callKey,
    );
    // The child chain rechecks after settlement; races return the split answer.
    await this.stops.sendToChild(route);
    return (await this.planDecisionEvidence(callKey))!;
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
      // H4e-b2: a continued member runs in its chain's head.
      const chains = this.chains();
      const running = team.members
        .filter((member) =>
          isRunningMember(hostedMemberView(chains, member.childRunId)),
        )
        .map((member) => member.name);
      if (running.length > 0)
        throw new HostedTeamRefusal(
          `Team "${team.name}" still has running members: ${running.join(', ')}. Stop them with request_shutdown and wait until task_list shows them ended, then delete the team.`,
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
    await this.withdrawPlans(team.teamId, undefined, `delete:${callKey}`);
    await this.commit(
      'team_state',
      teamLifecycleBody(closing, 'deleted'),
      'deleteTeam',
      `${callKey}:deleted`,
    );
    return `Team "${team.name}" deleted.`;
  }

  /**
   * H4e-b3 decision 10: the lead stops a member. A running head takes the
   * same stop a user's H4f cancel commits — the member is never asked —
   * and the child result relay's stop arm settles it. Every answer reads
   * the head's state, so a re-driven call answers its committed stop
   * instead of committing a second one. A finished head is not touched:
   * it takes no work unless the lead sends it some.
   */
  private async requestShutdown(
    callKey: string,
    rawName: string,
  ): Promise<string> {
    const team = this.openTeam();
    if (team === undefined)
      throw new HostedTeamRefusal('No active team. Create a team first.');
    const name = sanitizeName(rawName);
    if (!name)
      throw new HostedTeamRefusal(
        `Teammate name "${rawName}" sanitizes to an empty string. Choose a name with at least one alphanumeric character.`,
      );
    const member = team.members.find((each) => each.name === name);
    if (member === undefined)
      throw new HostedTeamRefusal(
        `"${name}" is not a member of team "${team.name}".`,
      );
    let view = hostedMemberView(this.chains(), member.childRunId);
    const checkWithdrawal = () => {
      if (
        !isRunningMember(view) &&
        !isEndedMember(view) &&
        this.plans(team.teamId).some(
          (plan) => plan.member === name && plan.run.state === 'waiting',
        )
      ) {
        try {
          assertManagedSessionDomainEnabled('team_plan');
        } catch (cause) {
          if (!(cause instanceof ManagedSessionRecordError)) throw cause;
          throw new HostedTeamRefusal(
            `${name}'s waiting plan cannot be withdrawn while team_plan is disabled. No shutdown barrier was recorded; the plan can still be decided after reenablement.`,
          );
        }
      }
    };
    checkWithdrawal();
    await this.withdrawPlans(team.teamId, name, `shutdown:${callKey}`);
    if (isRunningMember(view) && !view.stopping && view.head !== undefined) {
      // A lane without the child funnel has nothing to stop through, and
      // can only carry members read-only; refusing here costs the merge
      // shape that attaches the surface without the funnel.
      if (this.stops === undefined)
        throw new HostedTeamRefusal(
          `${name} cannot be stopped from this Session.`,
        );
      try {
        // The stop commits on the child funnel's chain, so a settlement
        // can beat the view it just read: the run ends without a stop
        // landing, and the winner's answer reads from the new state
        // rather than crashing as a conflict.
        await this.stops.requestStop(view.head.childRunId, {
          operation: 'commitChildRunRecord',
          commandId: `shutdown:${callKey}`,
        });
        return `${name} is being stopped. Delete the team once task_list shows it ended.`;
      } catch (cause) {
        if (!(cause instanceof ManagedSessionConflictError)) throw cause;
        view = hostedMemberView(this.chains(), member.childRunId);
        if (view.state === 'running' && !view.stopping) throw cause;
        checkWithdrawal();
      }
    }
    if (view.stoppingBeforeStart)
      return `${name} is already being stopped, before its latest continuation started: it may end without starting, and ${name} then goes back to its predecessor run. Check task_list once it settles; do not read the member as ended on this stop alone.`;
    if (view.stopping)
      return `${name} is already being stopped. Delete the team once task_list shows it ended.`;
    if (view.state === 'completed' && !view.stopRequestedCompletion)
      return `${name} has finished: it takes no work unless you send it some, so nothing needed stopping. Its run was not touched.`;
    const ended = view.stopRequestedCompletion
      ? 'completed after a stop was requested'
      : view.state === 'cancelled'
        ? 'was cancelled'
        : `has ${view.state}`;
    return `${name} ${ended}; there is nothing left to stop.`;
  }

  /**
   * H4e-b3 decision 9's composition rule, read through the open team:
   * whether a continuation of this member composes in plan mode.
   */
  memberPlanMode(member: HostedTeamMembership): boolean {
    const team = this.team(member.teamId);
    if (team === undefined) return false;
    return memberPlanModeRequired(
      team,
      this.store.authority.extensionRecordsInDomain('team_plan'),
      member.name,
    );
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
    turnPrefix: string | undefined,
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
      this.validateUpdate(
        team,
        board,
        number,
        args,
        owner,
        blocks,
        blockedBy,
        turnPrefix,
      );
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
    // H4e-b2 decision 7: the board is a record, never a delivery. The
    // answer never asks for a send outright: the launch prompt or a send
    // earlier in the Turn may already have given this work, and when such
    // a send exists it says so. A call that restates its task's owner and
    // status is not checked again, so the answer reads the member itself:
    // work that never arrived is asked for again, and a member that has
    // ended is never pointed to a send.
    let notice = '';
    const member =
      owner != null && owner !== MANAGED_TEAM_LEADER
        ? team.members.find((each) => each.name === owner)
        : undefined;
    if (member !== undefined && task.status !== 'completed') {
      const chains = this.chains();
      const view = hostedMemberView(chains, member.childRunId);
      const recorded = ` "${owner}" was not notified: task_update records the board only.`;
      if (view.stoppingBeforeStart) {
        notice = `${recorded} ${owner}'s latest continuation is being stopped before it started; if it ends without starting, ${owner} can take work again. Check task_list once it settles.`;
      } else if (isEndedMember(view)) {
        notice = `${recorded} ${owner} cannot take more work: it ${view.stopping ? 'is being stopped' : view.stopRequestedCompletion ? 'completed after a stop was requested' : `has ${view.state}`}.`;
      } else if (view.neverStarted !== undefined) {
        const neverStarted = hostedNeverStarted(
          view.neverStarted,
          this.messagesTo(view.neverStarted.childRunId),
        );
        notice = `${recorded} Its latest continuation ${neverStartedClause(neverStarted)}. ${neverStartedAction(neverStarted, member.name)}.`;
      } else if (
        turnPrefix !== undefined &&
        givenWorkThisTurn(
          chains,
          member.childRunId,
          outboundChildMessages(
            this.store.authority.extensionRecordsInDomain('session_message'),
          ),
          turnPrefix,
        )
      ) {
        notice = `${recorded} A send_message earlier in this turn gave ${owner} work; if it did not carry this task, give it with send_message to "${owner}".`;
      } else {
        notice = `${recorded} If ${owner} does not already have this work, give it with send_message to "${owner}".`;
      }
    }
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
    turnPrefix: string | undefined,
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
    // A task keeps an owner whose run ended, so the lead can complete, edit
    // or delete it; a new owner is checked, and so is a kept owner when the
    // call moves the task to another open status, so a member that ended
    // never lands on open work.
    if (owner != null && owner !== task.owner) {
      this.assertOwner(team, owner, status === 'completed', turnPrefix);
    } else if (
      (owner === undefined || owner === task.owner) &&
      task.owner !== null &&
      status !== task.status &&
      status !== 'completed'
    ) {
      this.assertOwner(team, task.owner, false, turnPrefix, number);
    }
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
    const chains = this.chains();
    return [
      ...(lines.length > 0 ? lines : ['No tasks found.']),
      '',
      `--- Team "${team.name}" members ---`,
      ...(team.members.length > 0
        ? team.members.map((member) => this.rosterLine(member, chains))
        : ['No members yet.']),
      ...this.plans(team.teamId)
        .filter((plan) => plan.run.state === 'waiting')
        .map((plan) => {
          const member = team.members.find(
            (entry) => entry.name === plan.member,
          )!;
          const view = this.memberView(member.childRunId, chains);
          return `Pending plan: ${plan.member}, request ${plan.requestId}, revision ${plan.planRevision}, ${plan.planRef.byteLength} bytes${isEndedMember(view) || view.stopping ? ' (member ended/stopped)' : ''}`;
        }),
    ].join('\n');
  }

  /**
   * One member's roster line, read from its chain head (H4e-b2 decision 2).
   * A failed or cancelled head says why, so the lead can tell a member the
   * host never started (an isolated member whose Workspace was not
   * prepared) from one that failed its work. The head's task id shows only
   * while the member can still take work. A continuation that never started
   * says so, with how many messages to it never arrived — a failed child
   * sends no notification, so this line is how the lead learns of it — but
   * not its own task id, which names no live run: the head's reaches the
   * member.
   */
  private rosterLine(
    member: { readonly name: string; readonly childRunId: string },
    chains: HostedChildChains,
  ): string {
    const view = this.memberView(member.childRunId, chains);
    const head = view.head;
    const label = view.stopping
      ? 'running (stopping)'
      : view.stopRequestedCompletion
        ? 'completed (stop requested)'
        : view.state;
    const reason =
      (view.state === 'failed' || view.state === 'cancelled') && head
        ? head.stopReason
        : null;
    const reachable =
      head !== undefined &&
      ((view.state === 'running' && !view.stopping) || view.continuable);
    const note =
      view.neverStarted === undefined
        ? ''
        : ` (its latest continuation ${neverStartedClause(
            hostedNeverStarted(
              view.neverStarted,
              this.messagesTo(view.neverStarted.childRunId),
            ),
          )})`;
    return (
      `${member.name}: ${label}` +
      (reason ? ` (${reason})` : '') +
      (reachable
        ? ` — ${managedChildTaskId(this.key.sessionId, head.childRunId)}`
        : '') +
      note +
      (view.neverStarted !== undefined &&
      this.committed('decideTeamPlan', view.neverStarted.childRunId) !==
        undefined
        ? ` Send the decision again with send_message, quoting the plan (team_plan_approval action "show", request_id "${this.committed('decideTeamPlan', view.neverStarted.childRunId)}").`
        : '')
    );
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
   * An owner is the leader or a member that can hold the work. H4e-b2 reads
   * the member's chain head (decision 2) and decision 7's notion of work
   * given in this Turn:
   * - a running member may own any task, and so may a member that an
   *   earlier call of this Turn gave work — a continuation of its chain that
   *   did not prove it never started, or a message to it that was not
   *   cancelled or rejected — even when it has completed since: the relay
   *   settles a child while the lead's Turn runs, so one batch cannot keep
   *   it running until task_update lands;
   * - a completed member may otherwise own only a task the call leaves
   *   completed, so the board records who did the work (#13846), and so
   *   may an ended member any run of whose chain completed;
   * - a member that failed, was cancelled, is stopping, or completed after
   *   a stop request has ended: it never lands on open work.
   * No refusal claims which task a past send carried, since no record ties
   * a send to a task, and none offers to skip a send for work that never
   * arrived.
   */
  private assertOwner(
    team: TeamState,
    owner: string,
    completing: boolean,
    turnPrefix: string | undefined,
    keptOn?: number,
  ): void {
    if (owner === MANAGED_TEAM_LEADER) return;
    const member = team.members.find((each) => each.name === owner);
    if (member === undefined)
      throw new HostedTeamRefusal(
        `"${owner}" is not a member of team "${team.name}". An owner is "leader" or a member name.`,
      );
    const chains = this.chains();
    const view = hostedMemberView(chains, member.childRunId);
    const kept = keptOn !== undefined;
    // "Member X has finished", or for a kept owner "Member X cannot keep
    // task #N open: it has finished".
    const who = (state: string) =>
      kept
        ? `Member "${owner}" cannot keep task #${keptOn} open: it ${state}`
        : `Member "${owner}" ${state}`;
    const unassign = kept ? ', or set owner "" to unassign it' : '';
    if (isEndedMember(view)) {
      // A run of the chain that completed may have done this task's work,
      // so the member may still be recorded on the task the call completes,
      // whatever a later run did — a head that settled after a stop request
      // among them.
      if (completing && hasCompletedRun(chains, member.childRunId)) return;
      if (view.stopRequestedCompletion)
        throw new HostedTeamRefusal(
          `${who('completed after a stop was requested, so it cannot be continued')}. If it did this task's work, set status "completed" with this owner; otherwise launch a new member for it${unassign}.`,
        );
      // A continuation stopped before it attached may end without
      // starting, which hands the member back to its predecessor.
      if (view.stoppingBeforeStart)
        throw new HostedTeamRefusal(
          `${who('is being stopped before its latest continuation started')}. If that continuation ends without starting, the member can take work again: check task_list once it settles${kept ? ', set owner "" to unassign the task, or assign "leader"' : ''}.`,
        );
      const ended = view.stopping
        ? 'is being stopped'
        : view.state === 'cancelled'
          ? 'was cancelled'
          : `has ${view.state}`;
      if (completing && view.stopping)
        throw new HostedTeamRefusal(
          `Member "${owner}" is being stopped and has not completed a run yet. Complete the task with this owner only after task_list shows its run completed; otherwise record the member that did it, or "leader".`,
        );
      // No settled run of an ended member could have done the task's work.
      if (completing)
        throw new HostedTeamRefusal(
          `Member "${owner}" ${ended} without completing a run, so it did not do this task's work. Record the member that did it, or "leader".`,
        );
      throw new HostedTeamRefusal(
        kept
          ? `${who(ended)}. Launch a new member for this work, set owner "" to unassign it, or assign "leader".`
          : `Member "${owner}" ${ended} and cannot own a task. Launch a new member for this work.`,
      );
    }
    if (view.state === 'running' || completing) return;
    // The head's newest continuation never started, so the newest work
    // sent to the member did not arrive, whatever an earlier send of this
    // Turn gave: no later started run exists, or it would be the head.
    // One cancelled at a user's request is resent only if still wanted.
    if (view.neverStarted !== undefined) {
      const neverStarted = hostedNeverStarted(
        view.neverStarted,
        this.messagesTo(view.neverStarted.childRunId),
      );
      throw new HostedTeamRefusal(
        `${who(`has finished, and its latest continuation ${neverStartedClause(neverStarted)}`)}. ${neverStartedAction(neverStarted, owner)}. Then update the task in the same turn${unassign}.`,
      );
    }
    if (
      turnPrefix !== undefined &&
      givenWorkThisTurn(
        chains,
        member.childRunId,
        outboundChildMessages(
          this.store.authority.extensionRecordsInDomain('session_message'),
        ),
        turnPrefix,
      )
    )
      return;
    throw new HostedTeamRefusal(
      `${who('has finished')}. If it already did this task's work, from its launch prompt or a message you sent it, set status "completed" with this owner once its report is in. Otherwise give it the work with send_message to "${owner}" first, which continues it, and then update the task in the same turn${unassign}.`,
    );
  }

  /**
   * H4e-b3: the member's view of the board for `task_list`. The board
   * carries everything the lead's view does, minus the child task ids
   * behind each roster name — a member reads names, states and task
   * numbers, never the run another member is attached to.
   */
  async memberBoardList(
    _memberName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    return this.serial(async () => this.memberListIn(args));
  }

  private memberListIn(args: Record<string, unknown>): string {
    const team = this.openTeam();
    if (team === undefined)
      throw new HostedTeamRefusal(
        'You are not a member of an open team. Ask the leader how the team ended.',
      );
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
    const chains = this.chains();
    return [
      ...(lines.length > 0 ? lines : ['No tasks found.']),
      '',
      `--- Team "${team.name}" members ---`,
      ...(team.members.length > 0
        ? team.members.map((member) => this.memberRosterLine(member, chains))
        : ['No members yet.']),
    ].join('\n');
  }

  /** The roster line a member sees: state only, never the child task id. */
  private memberRosterLine(
    member: { readonly name: string; readonly childRunId: string },
    chains: HostedChildChains,
  ): string {
    const view = this.memberView(member.childRunId, chains);
    const head = view.head;
    const label = view.stopping
      ? 'running (stopping)'
      : view.stopRequestedCompletion
        ? 'completed (stop requested)'
        : view.state;
    const reason =
      (view.state === 'failed' || view.state === 'cancelled') && head
        ? head.stopReason
        : null;
    const note =
      view.neverStarted === undefined ? '' : ` (its latest task did not start)`;
    return `${member.name}: ${label}` + (reason ? ` (${reason})` : '') + note;
  }

  /**
   * H4e-b3 decision 6: a member's `task_create`. One write, replay-stable
   * under `${commandId}:create` so a TaskCreateCommand re-run of
   * `execute` finds it and takes no second task. Refuses on a closing
   * team or any rule violation, with the member-facing texts.
   */
  async memberTaskCreate(
    commandId: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    return this.serial(async () => {
      const created = this.committed('createTeamTask', `${commandId}:create`);
      if (created !== undefined) {
        const task = this.task(created);
        return `Task #${task.number} created: "${task.subject}"`;
      }
      const team = this.openTeam();
      if (team === undefined)
        throw new HostedTeamRefusal(
          'You are not a member of an open team. Ask the leader how the team ended.',
        );
      if (team.lifecycle !== 'active')
        throw new HostedTeamRefusal(
          `Team "${team.name}" is closing and takes no new tasks.`,
        );
      const number =
        Math.max(0, ...this.tasksOf(team.teamId).map((task) => task.number)) +
        1;
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
      await this.commit(
        'team_task',
        task,
        'createTeamTask',
        `${commandId}:create`,
      );
      return `Task #${number} created: "${task.subject}"`;
    });
  }

  /**
   * H4e-b3 decision 6: a member's `task_update`, the Legacy teammate
   * rules. Status/owner/subject/description, addBlockedBy, addBlocks and
   * delete are writes the member may do only on its own or unowned tasks;
   * activeForm and metadata are free for any task; owner resolves to the
   * member's own name or `""`. An unowned task moved to `in_progress`
   * takes the member as its owner. Deleting freezes tasks just like the
   * lead's flow. Each write place is replay-stable under
   * `${commandId}:${place + 1}`.
   */
  async memberTaskUpdate(
    memberName: string,
    commandId: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    return this.serial(async () => {
      const team = this.openTeam();
      if (team === undefined)
        throw new HostedTeamRefusal(
          'You are not a member of an open team. Ask the leader how the team ended.',
        );
      const number = taskNumber(args['taskId'] as string);
      const deleting = args['status'] === 'deleted';
      const blocks = deleting
        ? []
        : ((args['addBlocks'] as string[] | undefined) ?? []).map(taskNumber);
      const blockedBy = deleting
        ? []
        : ((args['addBlockedBy'] as string[] | undefined) ?? []).map(
            taskNumber,
          );
      const board = new Map(
        this.tasksOf(team.teamId).map((task) => [task.number, task]),
      );
      const commandId_ = (place: number) => `${commandId}:${place + 1}`;
      const pending = [number, ...blocks]
        .map((_, place) => place)
        .filter(
          (place) =>
            this.committed('updateTeamTask', commandId_(place)) === undefined,
        );
      const replaying = pending.length < blocks.length + 1;
      if (!replaying)
        this.validateMemberUpdate(
          team,
          board,
          memberName,
          number,
          args,
          blocks,
          blockedBy,
        );
      const notCommitted: string[] = [];
      for (const place of pending) {
        // Each remaining place is re-validated against the board as it
        // stands now — the board may have moved since the place before
        // it committed: a target can be gone, and an edge the original
        // validation allowed can now close a cycle. Deterministic
        // refusals ride the receipt; they never escape as faults.
        const liveBoard = this.memberBoardOf(team.teamId);
        if (place > 0) {
          const targetNumber = blocks[place - 1]!;
          const target = liveBoard.get(targetNumber);
          if (target === undefined) {
            notCommitted.push(`#${targetNumber} not found`);
            continue;
          }
          if (!this.memberMayWrite(target, memberName)) {
            notCommitted.push(
              `#${target.number} is owned by ${target.owner ?? 'someone'} (not unowned for you)`,
            );
            continue;
          }
          const selfTask = liveBoard.get(number);
          if (selfTask === undefined) {
            notCommitted.push(`#${number} not found`);
            continue;
          }
          const cycle = dependencyCycle(liveBoard, number, [targetNumber], []);
          if (cycle !== null) {
            notCommitted.push(
              `#${targetNumber} would create a dependency cycle (${cycle
                .map((each) => `#${each}`)
                .join(' → ')})`,
            );
            continue;
          }
          const current = this.task(target.taskId);
          const nextBlocks = new Set([...current.blockedBy, selfTask.taskId]);
          if (nextBlocks.size > MANAGED_TEAM_LIMITS.maxBlockers) {
            notCommitted.push(
              `#${targetNumber} would exceed ${MANAGED_TEAM_LIMITS.maxBlockers} blockers`,
            );
            continue;
          }
          try {
            await this.commit(
              'team_task',
              teamTaskRevisionBody(current, {
                addBlockedBy: [selfTask.taskId],
              }),
              'updateTeamTask',
              commandId_(place),
            );
          } catch (cause) {
            // Inside this serial scope the authority's conflict is the
            // board's own verdict for this shape: fold it like the
            // checks above, never a rotate-and-fault.
            if (cause instanceof ManagedSessionConflictError) {
              notCommitted.push(cause.message);
              continue;
            }
            throw cause;
          }
          continue;
        }
        try {
          this.validateMemberUpdate(
            team,
            liveBoard,
            memberName,
            number,
            args,
            blocks,
            blockedBy,
            true,
          );
        } catch (cause) {
          if (!(cause instanceof HostedTeamRefusal)) throw cause;
          notCommitted.push(cause.message);
          continue;
        }
        const current = this.task(board.get(number)!.taskId);
        const revision = deleting
          ? teamTaskRevisionBody(current, { status: 'deleted' })
          : await this.memberUpdatedTask(
              current,
              memberName,
              args,
              blockedBy,
              board,
            );
        await this.commit(
          'team_task',
          revision,
          'updateTeamTask',
          commandId_(place),
        );
      }
      const task = this.task(board.get(number)!.taskId);
      if (deleting) return `Task #${number} deleted.`;
      const done = `Task #${number} updated (status: ${task.status}${task.owner ? `, owner: ${task.owner}` : ''}).`;
      if (notCommitted.length === 0) return done;
      return `${done} Not committed: ${notCommitted.join('; ')}.`;
    });
  }

  private memberBoardOf(teamId: string): ReadonlyMap<number, TeamTask> {
    return new Map(
      this.tasksOf(teamId).map((each) => [each.number, each] as const),
    );
  }

  private memberMayWrite(task: TeamTask, memberName: string): boolean {
    return task.owner === null || task.owner === memberName;
  }

  /**
   * The member rules of decision 6 for one board write: status, owner,
   * subject, description, addBlockedBy and delete all require the task to
   * be the member's own or unowned; addBlocks also requires every named
   * task to be the member's own or unowned; activeForm and metadata are
   * unrestricted.
   */
  private validateMemberUpdate(
    team: TeamState,
    board: ReadonlyMap<number, TeamTask>,
    memberName: string,
    number: number,
    args: Record<string, unknown>,
    blocks: readonly number[],
    blockedBy: readonly number[],
    _revisited = false,
  ): void {
    const task = board.get(number);
    if (task === undefined || task.status === 'deleted') {
      throw new HostedTeamRefusal(`Task #${number} not found.`);
    }
    const deleting = args['status'] === 'deleted';
    const touchesOwnerTaskRules =
      args['status'] !== undefined ||
      args['owner'] !== undefined ||
      args['subject'] !== undefined ||
      args['description'] !== undefined ||
      (args['addBlockedBy'] as unknown[] | undefined)?.length !== undefined;
    if (touchesOwnerTaskRules && !this.memberMayWrite(task, memberName)) {
      throw new HostedTeamRefusal(
        `Task #${number} is owned by ${task.owner}; you can change only tasks you own or that are unowned.`,
      );
    }
    // Existence comes before ownership: the probe below reads the tasks
    // this gate proves present, and an absent number is a refusal,
    // never an undefined read.
    const live = (eachNumber: number) => {
      const each = board.get(eachNumber);
      return each !== undefined && each.status !== 'deleted';
    };
    const missing = [...new Set([...blocks, ...blockedBy])]
      .filter((each) => !live(each))
      .sort((left, right) => left - right);
    if (missing.length > 0)
      throw new HostedTeamRefusal(
        `Cannot update task #${number}: referenced task${missing.length === 1 ? '' : 's'} ${missing.map((each) => `#${each}`).join(', ')} not found.`,
      );
    if (blocks.length > 0) {
      const held = blocks
        .map((each) => board.get(each)!)
        .find((each) => !this.memberMayWrite(each, memberName));
      if (held)
        throw new HostedTeamRefusal(
          `Task #${held.number} is owned by ${held.owner}; you can block only tasks you own or that are unowned.`,
        );
    }
    if (
      args['owner'] !== undefined &&
      args['owner'] !== '' &&
      sanitizeName(args['owner'] as string) !== memberName
    ) {
      throw new HostedTeamRefusal(
        'Task owner must be your own name or "". Assign work to another member instead with send_message.',
      );
    }
    if (deleting) return;
    if (blocks.includes(number) || blockedBy.includes(number))
      throw new HostedTeamRefusal(
        `Cannot update task #${number}: a task cannot block or be blocked by itself.`,
      );
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
    const status =
      (args['status'] as TeamTaskStatus | undefined) ?? task.status;
    const resultingOwner =
      args['owner'] === undefined
        ? status === 'in_progress' && task.owner === null
          ? memberName
          : task.owner
        : args['owner'] === ''
          ? null
          : memberName;
    if (status === 'in_progress' && resultingOwner === null)
      throw new HostedTeamRefusal(
        'Cannot move a task to in_progress without an owner. Set owner to your own name, or leave the task pending.',
      );
    // The lead's owner rule still applies wherever the final owner is named.
    if (resultingOwner !== null && resultingOwner !== MANAGED_TEAM_LEADER) {
      const member = team.members.find((each) => each.name === resultingOwner);
      if (member === undefined && resultingOwner === memberName)
        throw new HostedTeamRefusal(
          "You are not on this team's roster, so you cannot own a task here.",
        );
    }
  }

  private async memberUpdatedTask(
    task: TeamTask,
    memberName: string,
    args: Record<string, unknown>,
    blockedBy: readonly number[],
    board: ReadonlyMap<number, TeamTask>,
  ): Promise<TeamTask> {
    const status =
      (args['status'] as TeamTaskStatus | undefined) ?? task.status;
    const owner =
      args['owner'] === undefined
        ? status === 'in_progress' && task.owner === null
          ? memberName
          : undefined
        : args['owner'] === ''
          ? null
          : memberName;
    return teamTaskRevisionBody(task, {
      subject: args['subject'] as string | undefined,
      descriptionRef:
        args['description'] === undefined
          ? undefined
          : await this.publishText(args['description'] as string),
      activeForm: args['activeForm'] as string | undefined,
      metadataRef:
        args['metadata'] === undefined
          ? undefined
          : await this.publishMetadata(
              metadataBytes(
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
              ),
            ),
      owner,
      status: args['status'] as TeamTaskStatus | undefined,
      addBlockedBy: blockedBy.map((each) => board.get(each)!.taskId),
    });
  }

  /** The lead's child Session runs, indexed for one call. */
  private chains(): HostedChildChains {
    return new HostedChildChains(
      this.store.authority.extensionRecordsInDomain('child_run'),
    );
  }

  /** The lead's messages to one child run. */
  private messagesTo(childRunId: string) {
    return outboundChildMessages(
      this.store.authority.extensionRecordsInDomain('session_message'),
    ).filter((message) => message.childRunId === childRunId);
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
   * The command funnel's `execute` half-applied-write probe (decision 3):
   * whether one board write this command derived is already committed —
   * a create's `:create` or one update place. When any is, `execute`
   * answers from what is committed and re-validates what remains instead
   * of running the fresh admission gates again.
   */
  commandWriteCommitted(recordId: string): boolean {
    return (
      this.committed('createTeamTask', recordId) !== undefined ||
      this.committed('updateTeamTask', recordId) !== undefined
    );
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
    domain: 'team_state' | 'team_task' | 'team_plan',
    record: TeamState | TeamTask | TeamPlan,
    operation: string,
    commandId: string,
  ): Promise<void> {
    const existing = this.store.authority.extensionRecord(
      domain,
      domain === 'team_state'
        ? (record as TeamState).teamId
        : domain === 'team_plan'
          ? (record as TeamPlan).requestId
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
