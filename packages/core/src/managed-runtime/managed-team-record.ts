/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isExtensionRunSuccessor,
  parseExtensionRun,
  type ExtensionRun,
} from './managed-extension-record.js';
import {
  assertManagedSessionDigest,
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
  boundedString,
  MANAGED_SESSION_LIMITS,
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';

// The four team record bodies, schema version 1 (H4e of #12827): a team's
// roster and lifecycle (`managed-team_state`), its board
// (`managed-team_task`), its mailbox (`managed-team_message`) and its plan
// approvals (`managed-team_plan`), all held by the lead Session. They keep
// the Legacy team vocabulary of packages/core/src/agents/team. The shared
// fixtures in contracts/managed-team-record-v1.fixtures.json pin them, and
// ManagedTeamRecords in packages/sdk-java/managed-agent-server replays the
// same cases. See docs/design/2026-10-10-managed-agent-teams.md.

export const MANAGED_TEAM_LIMITS = Object.freeze({
  /** Legacy `MAX_TEAMMATES`; the lead is not a member. */
  maxMembers: 10,
  maxNameLength: 64,
  maxBlockers: 64,
  /** Bytes of a description, a message, a plan or its feedback. */
  maxContentBytes: 64 * 1024,
  /** Legacy `MAX_METADATA_BYTES`. */
  maxMetadataBytes: 32 * 1024,
} as const);

/** The name `leader` stands for the lead wherever a record names a participant. */
export const MANAGED_TEAM_LEADER = 'leader';

export type TeamLifecycle = 'active' | 'closing' | 'deleted';
export type TeamTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'deleted';
export type TeamMessageKind =
  | 'message'
  | 'task_assignment'
  | 'plan_approval_request'
  | 'plan_approval_response'
  | 'shutdown_request'
  | 'shutdown_approved'
  | 'shutdown_rejected';
export type TeamPlanDecision = 'approved' | 'rejected';

export interface TeamMember {
  readonly name: string;
  /** The member's child Session run in the lead's journal. */
  readonly childRunId: string;
  readonly planModeRequired: boolean;
}

/** The body of a `managed-team_state` schema version 1 record. */
export interface TeamState {
  readonly teamId: string;
  readonly name: string;
  readonly leadSessionId: string;
  readonly lifecycle: TeamLifecycle;
  /** One more than the member count: each membership fact is one step. */
  readonly membershipRevision: number;
  readonly members: readonly TeamMember[];
  readonly run: ExtensionRun;
}

/** The body of a `managed-team_task` schema version 1 record. */
export interface TeamTask {
  readonly teamId: string;
  readonly taskId: string;
  /** The board's `#N`, unique in the team. */
  readonly number: number;
  readonly subject: string;
  readonly descriptionRef: ManagedSessionDurableRef;
  readonly activeForm: string | null;
  readonly metadataRef: ManagedSessionDurableRef | null;
  readonly owner: string | null;
  readonly status: TeamTaskStatus;
  /** The one stored direction of each dependency; `blocks` is its reverse. */
  readonly blockedBy: readonly string[];
  readonly run: ExtensionRun;
}

/** The body of a `managed-team_message` schema version 1 record. */
export interface TeamMessage {
  readonly teamId: string;
  readonly messageId: string;
  readonly kind: TeamMessageKind;
  readonly from: string;
  readonly to: string;
  readonly contentRef: ManagedSessionDurableRef;
  readonly contentDigest: string;
  /** Fixed at handover. */
  readonly targetSessionId: string | null;
  /** The input that carries the message in the target Session. */
  readonly inputId: string | null;
  readonly run: ExtensionRun;
}

/** The body of a `managed-team_plan` schema version 1 record. */
export interface TeamPlan {
  readonly teamId: string;
  /** The D6 action that asks the leader to decide. */
  readonly requestId: string;
  readonly member: string;
  readonly planRevision: number;
  readonly planRef: ManagedSessionDurableRef;
  readonly decision: TeamPlanDecision | null;
  readonly feedbackRef: ManagedSessionDurableRef | null;
  readonly run: ExtensionRun;
}

const STATE_KEYS = [
  'lifecycle',
  'leadSessionId',
  'members',
  'membershipRevision',
  'name',
  'run',
  'teamId',
] as const;
const MEMBER_KEYS = ['childRunId', 'name', 'planModeRequired'] as const;
const TASK_KEYS = [
  'activeForm',
  'blockedBy',
  'descriptionRef',
  'metadataRef',
  'number',
  'owner',
  'run',
  'status',
  'subject',
  'taskId',
  'teamId',
] as const;
const MESSAGE_KEYS = [
  'contentDigest',
  'contentRef',
  'from',
  'inputId',
  'kind',
  'messageId',
  'run',
  'targetSessionId',
  'teamId',
  'to',
] as const;
const PLAN_KEYS = [
  'decision',
  'feedbackRef',
  'member',
  'planRef',
  'planRevision',
  'requestId',
  'run',
  'teamId',
] as const;
const STATE_FIXED_KEYS = ['leadSessionId', 'name', 'teamId'] as const;
const TASK_FIXED_KEYS = ['number', 'taskId', 'teamId'] as const;
/** Every message key but the run is fixed, except the two set once. */
const MESSAGE_FIXED_KEYS = [
  'contentDigest',
  'contentRef',
  'from',
  'kind',
  'messageId',
  'teamId',
  'to',
] as const;
const PLAN_FIXED_KEYS = [
  'member',
  'planRef',
  'planRevision',
  'requestId',
  'teamId',
] as const;

const LIFECYCLES: readonly TeamLifecycle[] = ['active', 'closing', 'deleted'];
const TASK_STATUSES: readonly TeamTaskStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'deleted',
];
/** Who may send each kind: a member to the leader, or the reverse. */
const TO_LEADER: readonly TeamMessageKind[] = [
  'plan_approval_request',
  'shutdown_approved',
  'shutdown_rejected',
];
const FROM_LEADER: readonly TeamMessageKind[] = [
  'plan_approval_response',
  'shutdown_request',
];
const MESSAGE_KINDS: readonly TeamMessageKind[] = [
  'message',
  'task_assignment',
  ...TO_LEADER,
  ...FROM_LEADER,
];
/** Legacy `sanitizeName` output: dash-separated lowercase runs. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The largest integer both validators read exactly. */
const MAX_COUNT = 9_007_199_254_740_990;

function fail(message: string): never {
  throw new ManagedSessionRecordError(message);
}

function closed<Key extends string>(
  label: string,
  value: unknown,
  keys: readonly Key[],
): Record<Key, ManagedSessionJsonValue> {
  if (
    typeof value !== 'object' ||
    value === null ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key as Key))
  )
    fail(`${label} must have exactly the keys ${keys.join(', ')}.`);
  return { ...value } as Record<Key, ManagedSessionJsonValue>;
}

function oneOf<T extends string>(
  value: ManagedSessionJsonValue,
  allowed: readonly T[],
  message: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(message);
  return value as T;
}

function count(
  value: ManagedSessionJsonValue,
  label: string,
  min: number,
  max = MAX_COUNT,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    fail(`${label} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function bool(value: ManagedSessionJsonValue, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be boolean.`);
  return value;
}

function name(value: ManagedSessionJsonValue, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length > MANAGED_TEAM_LIMITS.maxNameLength ||
    !NAME.test(value)
  ) {
    fail(
      `${label} must be dash-separated lowercase letters and digits, at most ${MANAGED_TEAM_LIMITS.maxNameLength} characters.`,
    );
  }
  return value;
}

function ref(
  value: ManagedSessionJsonValue,
  label: string,
  maxBytes: number,
): ManagedSessionDurableRef {
  const parsed = Object.freeze(assertManagedSessionDurableRef(value, label));
  if (parsed.byteLength > maxBytes) fail(`${label} exceeds ${maxBytes} bytes.`);
  return parsed;
}

function nullable<T>(
  value: ManagedSessionJsonValue,
  parse: (value: ManagedSessionJsonValue) => T,
): T | null {
  return value === null ? null : parse(value);
}

/**
 * A purely logical lifecycle in one of `states`: nothing runs for a team
 * record, so it pins no definition and names no physical identity.
 */
function logicalRun(
  value: ManagedSessionJsonValue,
  label: string,
  states: readonly string[],
): ExtensionRun {
  const run = parseExtensionRun(value);
  if (
    run.definition !== null ||
    run.executionCallId !== null ||
    run.effectId !== null ||
    run.dispatchId !== null ||
    run.deliveryId !== null ||
    run.execution !== null ||
    run.runtime !== null ||
    run.delivery !== null
  ) {
    fail(`${label} run must be purely logical.`);
  }
  if (!states.includes(run.state)) {
    fail(`${label} run must be ${states.join(' or ')}.`);
  }
  return run;
}

function accepts(check: () => boolean): boolean {
  try {
    return check();
  } catch (error) {
    if (error instanceof ManagedSessionRecordError) return false;
    throw error;
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fixed<T>(before: T, after: T, keys: ReadonlyArray<keyof T>): boolean {
  return keys.every((key) => same(before[key], after[key]));
}

function prefix(before: readonly unknown[], after: readonly unknown[]) {
  return before.every((each, index) => same(each, after[index]));
}

function parseMember(value: ManagedSessionJsonValue): TeamMember {
  const member = closed('Team member', value, MEMBER_KEYS);
  const memberName = name(member.name, 'Team member name');
  if (memberName === MANAGED_TEAM_LEADER) {
    fail('Team member cannot be named leader.');
  }
  return Object.freeze({
    name: memberName,
    childRunId: assertManagedSessionStableId(
      member.childRunId,
      'members.childRunId',
    ),
    planModeRequired: bool(member.planModeRequired, 'members.planModeRequired'),
  });
}

/**
 * Parses the body of a `managed-team_state` schema version 1 record: the
 * append-only roster and the lifecycle. The run is `admitted` while the
 * team lives and `cancelled` once it is deleted.
 */
export function parseTeamState(value: unknown): TeamState {
  const body = closed('Team state', value, STATE_KEYS);
  const lifecycle = oneOf(
    body.lifecycle,
    LIFECYCLES,
    'Team lifecycle must be active, closing or deleted.',
  );
  const run = logicalRun(body.run, 'Team', ['admitted', 'cancelled']);
  if ((lifecycle === 'deleted') !== (run.state === 'cancelled')) {
    fail('Team run must be cancelled exactly once the team is deleted.');
  }
  if (!Array.isArray(body.members)) fail('Team members must be an array.');
  if (body.members.length > MANAGED_TEAM_LIMITS.maxMembers) {
    fail(`Team members exceed ${MANAGED_TEAM_LIMITS.maxMembers} entries.`);
  }
  const members = Object.freeze(body.members.map(parseMember));
  if (
    new Set(members.map((member) => member.name)).size !== members.length ||
    new Set(members.map((member) => member.childRunId)).size !== members.length
  ) {
    fail('Team members must have distinct names and child runs.');
  }
  const membershipRevision = count(
    body.membershipRevision,
    'membershipRevision',
    1,
  );
  if (membershipRevision !== members.length + 1) {
    fail('Team membershipRevision must be one more than its member count.');
  }
  return Object.freeze({
    teamId: assertManagedSessionStableId(body.teamId, 'teamId'),
    name: name(body.name, 'Team name'),
    leadSessionId: assertManagedSessionStableId(
      body.leadSessionId,
      'leadSessionId',
    ),
    lifecycle,
    membershipRevision,
    members,
    run,
  });
}

/** Whether `value` may open a team: active, with no members yet. */
export function isTeamStateStart(value: unknown): boolean {
  return accepts(() => {
    const team = parseTeamState(value);
    return team.lifecycle === 'active' && team.members.length === 0;
  });
}

/**
 * Whether `next` may follow `previous`: the team's identity and lead never
 * change, the lifecycle stays or takes one step, and an active team that
 * stays active may gain one member, appended. A deleted team is frozen.
 */
export function isTeamStateSuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  return accepts(() => {
    const before = parseTeamState(previous);
    const after = parseTeamState(next);
    if (
      !fixed(before, after, STATE_FIXED_KEYS) ||
      !isExtensionRunSuccessor(before.run, after.run)
    ) {
      return false;
    }
    const step = LIFECYCLES.indexOf(after.lifecycle);
    const from = LIFECYCLES.indexOf(before.lifecycle);
    if (step !== from && step !== from + 1) return false;
    if (!prefix(before.members, after.members)) return false;
    const joined = after.members.length - before.members.length;
    return (
      joined === 0 ||
      (joined === 1 &&
        before.lifecycle === 'active' &&
        after.lifecycle === 'active')
    );
  });
}

/**
 * Parses the body of a `managed-team_task` schema version 1 record: one
 * board item of the Legacy task model. Its run is `admitted` until the
 * task is deleted and `cancelled` after.
 */
export function parseTeamTask(value: unknown): TeamTask {
  const body = closed('Team task', value, TASK_KEYS);
  const status = oneOf(
    body.status,
    TASK_STATUSES,
    'Team task status must be pending, in_progress, completed or deleted.',
  );
  const run = logicalRun(body.run, 'Team task', ['admitted', 'cancelled']);
  if ((status === 'deleted') !== (run.state === 'cancelled')) {
    fail('Team task run must be cancelled exactly once the task is deleted.');
  }
  const taskId = assertManagedSessionStableId(body.taskId, 'taskId');
  const owner = nullable(body.owner, (each) => name(each, 'Team task owner'));
  if (status === 'in_progress' && owner === null) {
    fail('Team task in progress must have an owner.');
  }
  if (!Array.isArray(body.blockedBy)) {
    fail('Team task blockedBy must be an array.');
  }
  if (body.blockedBy.length > MANAGED_TEAM_LIMITS.maxBlockers) {
    fail(
      `Team task blockedBy exceeds ${MANAGED_TEAM_LIMITS.maxBlockers} entries.`,
    );
  }
  const blockedBy = Object.freeze(
    body.blockedBy.map((each) =>
      assertManagedSessionStableId(each, 'blockedBy'),
    ),
  );
  if (
    new Set(blockedBy).size !== blockedBy.length ||
    blockedBy.includes(taskId)
  ) {
    fail('Team task blockedBy must name distinct other tasks.');
  }
  return Object.freeze({
    teamId: assertManagedSessionStableId(body.teamId, 'teamId'),
    taskId,
    number: count(body.number, 'number', 1),
    subject: boundedString(
      body.subject,
      'subject',
      MANAGED_SESSION_LIMITS.maxTextBytes,
    ),
    descriptionRef: ref(
      body.descriptionRef,
      'descriptionRef',
      MANAGED_TEAM_LIMITS.maxContentBytes,
    ),
    activeForm: nullable(body.activeForm, (each) =>
      boundedString(each, 'activeForm', MANAGED_SESSION_LIMITS.maxTextBytes),
    ),
    metadataRef: nullable(body.metadataRef, (each) =>
      ref(each, 'metadataRef', MANAGED_TEAM_LIMITS.maxMetadataBytes),
    ),
    owner,
    status,
    blockedBy,
    run,
  });
}

/** Whether `value` may open a task: any status but deleted. */
export function isTeamTaskStart(value: unknown): boolean {
  return accepts(() => parseTeamTask(value).status !== 'deleted');
}

/**
 * Whether `next` may follow `previous`: the task's identity and number
 * never change, its dependencies only grow, and every other field moves
 * freely until the task is deleted, which freezes it.
 */
export function isTeamTaskSuccessor(previous: unknown, next: unknown): boolean {
  return accepts(() => {
    const before = parseTeamTask(previous);
    const after = parseTeamTask(next);
    if (
      !fixed(before, after, TASK_FIXED_KEYS) ||
      !isExtensionRunSuccessor(before.run, after.run) ||
      !prefix(before.blockedBy, after.blockedBy)
    ) {
      return false;
    }
    return before.status !== 'deleted' || same(before, after);
  });
}

/**
 * Parses the body of a `managed-team_message` schema version 1 record: one
 * mailbox message to one recipient, held as the lead's outbox entry. As
 * with a Session message, the send is an act completed by the commit, so
 * the run is settled from its first revision and only its session delivery
 * moves.
 */
export function parseTeamMessage(value: unknown): TeamMessage {
  const body = closed('Team message', value, MESSAGE_KEYS);
  const kind = oneOf(
    body.kind,
    MESSAGE_KINDS,
    `Team message kind must be one of ${MESSAGE_KINDS.join(', ')}.`,
  );
  const from = name(body.from, 'Team message from');
  const to = name(body.to, 'Team message to');
  if (from === to) fail('Team message cannot address its own sender.');
  if (
    TO_LEADER.includes(kind) &&
    (from === MANAGED_TEAM_LEADER || to !== MANAGED_TEAM_LEADER)
  ) {
    fail(`Team message of kind ${kind} must go from a member to the leader.`);
  }
  if (
    FROM_LEADER.includes(kind) &&
    (from !== MANAGED_TEAM_LEADER || to === MANAGED_TEAM_LEADER)
  ) {
    fail(`Team message of kind ${kind} must go from the leader to a member.`);
  }
  if (kind === 'task_assignment' && to === MANAGED_TEAM_LEADER) {
    fail('Team message of kind task_assignment must go to a member.');
  }
  const run = parseExtensionRun(body.run);
  if (
    run.definition !== null ||
    run.effectId !== null ||
    run.dispatchId !== null ||
    run.deliveryId !== null ||
    run.execution !== null ||
    run.runtime !== null
  ) {
    fail('Team message run must be purely logical.');
  }
  if (run.state !== 'settled') fail('Team message run must be settled.');
  if (run.executionCallId === null) {
    fail('Team message run must name its sending call.');
  }
  const delivery = run.delivery;
  // The run carries no deliveryId, so the delivery is a session one.
  if (delivery === null) {
    fail('Team message delivery must be a session delivery.');
  }
  const contentRef = ref(
    body.contentRef,
    'contentRef',
    MANAGED_TEAM_LIMITS.maxContentBytes,
  );
  const contentDigest = assertManagedSessionDigest(
    body.contentDigest,
    'contentDigest',
  );
  if (contentDigest !== contentRef.digest) {
    fail("Team message contentDigest must name the content's digest.");
  }
  const targetSessionId = nullable(body.targetSessionId, (each) =>
    assertManagedSessionStableId(each, 'targetSessionId'),
  );
  const inputId = nullable(body.inputId, (each) =>
    assertManagedSessionStableId(each, 'inputId'),
  );
  if (
    targetSessionId === null &&
    delivery.state !== 'planned' &&
    delivery.state !== 'cancelled'
  ) {
    fail('Team message must fix its target once its delivery is claimed.');
  }
  if (
    (inputId !== null) !==
    (delivery.state === 'accepted' || delivery.state === 'consumed')
  ) {
    fail("Team message names its target's input exactly once accepted.");
  }
  return Object.freeze({
    teamId: assertManagedSessionStableId(body.teamId, 'teamId'),
    messageId: assertManagedSessionStableId(body.messageId, 'messageId'),
    kind,
    from,
    to,
    contentRef,
    contentDigest,
    targetSessionId,
    inputId,
    run,
  });
}

/** Whether `value` may open a message: its delivery is still planned. */
export function isTeamMessageStart(value: unknown): boolean {
  return accepts(
    () => parseTeamMessage(value).run.delivery?.state === 'planned',
  );
}

/**
 * Whether `next` may follow `previous`: the message, its parties and its
 * content never change, the target and the input are set once, and the
 * delivery takes one shared step at a time.
 */
export function isTeamMessageSuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  return accepts(() => {
    const before = parseTeamMessage(previous);
    const after = parseTeamMessage(next);
    return (
      fixed(before, after, MESSAGE_FIXED_KEYS) &&
      (before.targetSessionId === null ||
        before.targetSessionId === after.targetSessionId) &&
      (before.inputId === null || before.inputId === after.inputId) &&
      isExtensionRunSuccessor(before.run, after.run)
    );
  });
}

/**
 * Parses the body of a `managed-team_plan` schema version 1 record: one
 * plan a member submitted for the leader's approval. Its run waits for the
 * decision, settles with it, or is cancelled when the plan is withdrawn or
 * superseded.
 */
export function parseTeamPlan(value: unknown): TeamPlan {
  const body = closed('Team plan', value, PLAN_KEYS);
  const run = logicalRun(body.run, 'Team plan', [
    'waiting',
    'settled',
    'cancelled',
  ]);
  const member = name(body.member, 'Team plan member');
  if (member === MANAGED_TEAM_LEADER) {
    fail('Team plan member cannot be the leader.');
  }
  const decision = nullable(body.decision, (each) =>
    oneOf<TeamPlanDecision>(
      each,
      ['approved', 'rejected'],
      'Team plan decision must be approved or rejected.',
    ),
  );
  if ((decision !== null) !== (run.state === 'settled')) {
    fail('Team plan has a decision exactly once its run settled.');
  }
  const feedbackRef = nullable(body.feedbackRef, (each) =>
    ref(each, 'feedbackRef', MANAGED_TEAM_LIMITS.maxContentBytes),
  );
  if (feedbackRef !== null && decision === null) {
    fail('Team plan feedback comes only with a decision.');
  }
  return Object.freeze({
    teamId: assertManagedSessionStableId(body.teamId, 'teamId'),
    requestId: assertManagedSessionStableId(body.requestId, 'requestId'),
    member,
    planRevision: count(body.planRevision, 'planRevision', 1),
    planRef: ref(body.planRef, 'planRef', MANAGED_TEAM_LIMITS.maxContentBytes),
    decision,
    feedbackRef,
    run,
  });
}

/** Whether `value` may open a plan request: it waits for its decision. */
export function isTeamPlanStart(value: unknown): boolean {
  return accepts(() => parseTeamPlan(value).run.state === 'waiting');
}

/**
 * Whether `next` may follow `previous`: the request, its member and its
 * plan never change, and the run ends once, which fixes the decision.
 */
export function isTeamPlanSuccessor(previous: unknown, next: unknown): boolean {
  return accepts(() => {
    const before = parseTeamPlan(previous);
    const after = parseTeamPlan(next);
    return (
      fixed(before, after, PLAN_FIXED_KEYS) &&
      isExtensionRunSuccessor(before.run, after.run) &&
      (before.run.state === 'waiting' || same(before, after))
    );
  });
}
