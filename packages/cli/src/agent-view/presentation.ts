/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentViewActivityFile,
  AgentViewLaunchFile,
  AgentViewProcessState,
  AgentViewRosterEntry,
  AgentViewSessionSnapshot,
  AgentViewSessionStateFile,
} from './protocol.js';

export type AgentViewTaskState =
  | 'running'
  | 'waiting'
  | 'ready'
  | 'stopped'
  | 'failed';

export type AgentViewInputState =
  | 'none'
  | 'soft_question'
  | 'permission'
  | 'confirmation'
  | 'external_dialog'
  | 'auth_or_settings';

export type AgentViewRuntimeState =
  | 'starting'
  | 'alive'
  | 'hibernated'
  | 'exited'
  | 'restarting';

export type AgentViewPresentationGroup =
  | 'needs_input'
  | 'working'
  | 'completed';

export type AgentViewRecoverability = 'live' | 'restartable' | 'blocked';

export type AgentViewIconShape = 'alive' | 'exited' | 'sleeping';

export type AgentViewIconTone =
  | 'working'
  | 'needs_input'
  | 'ready'
  | 'stopped'
  | 'failed';

export interface AgentViewPresentationActions {
  canAttach: boolean;
  canPeek: boolean;
  canReply: boolean;
  canStop: boolean;
  canRemove: boolean;
  canRespawn: boolean;
  canHibernate: boolean;
  needsBlockingAnswer: boolean;
}

export interface AgentViewPresentation {
  sessionId: string;
  taskState: AgentViewTaskState;
  inputState: AgentViewInputState;
  runtimeState: AgentViewRuntimeState;
  recoverability: AgentViewRecoverability;
  group: AgentViewPresentationGroup;
  iconShape: AgentViewIconShape;
  iconTone: AgentViewIconTone;
  title: string;
  subtitle: string;
  ageLabel: string;
  actions: AgentViewPresentationActions;
}

export interface AgentViewPresentationInput {
  state: AgentViewSessionStateFile;
  rosterEntry?: AgentViewRosterEntry;
  launch?: AgentViewLaunchFile;
  activity?: AgentViewActivityFile;
  now?: Date | string;
}

export function deriveAgentViewPresentation(
  input: AgentViewPresentationInput | AgentViewSessionSnapshot,
): AgentViewPresentation {
  // Keep UI grouping capability-driven while the persisted state remains split.
  const state = input.state;
  const activity = input.activity;
  const now = 'now' in input ? input.now : undefined;
  const runtimeState = deriveRuntimeState(state.processState);
  const inputState = deriveInputState(activity);
  const taskState = deriveTaskState(state, inputState);
  const recoverability = deriveRecoverability(state, taskState, inputState);
  const actions = deriveActions(
    state,
    taskState,
    inputState,
    recoverability,
    Boolean(input.rosterEntry?.pinned),
  );
  const createdAt = toTime(state.createdAt);

  return {
    sessionId: state.sessionId,
    taskState,
    inputState,
    runtimeState,
    recoverability,
    group: deriveGroup(taskState),
    iconShape: deriveIconShape(runtimeState),
    iconTone: deriveIconTone(taskState),
    title: deriveTitle(input.rosterEntry, input.launch, activity),
    subtitle: deriveSubtitle(activity, taskState),
    // An unparseable createdAt must not surface as a ~56-year duration.
    ageLabel: Number.isNaN(createdAt)
      ? ''
      : formatDuration(Math.max(0, toTime(now ?? new Date()) - createdAt)),
    actions,
  };
}

export function getAgentViewActivityInputState(
  activity: AgentViewActivityFile | undefined,
): AgentViewInputState {
  return deriveInputState(activity);
}

export function canAgentViewQueueFollowUp(
  state: AgentViewSessionStateFile,
  activity: AgentViewActivityFile | undefined,
): boolean {
  const inputState = deriveInputState(activity);
  const taskState = deriveTaskState(state, inputState);
  const recoverability = deriveRecoverability(state, taskState, inputState);
  return deriveActions(state, taskState, inputState, recoverability, false)
    .canReply;
}

export function canAgentViewHibernate(
  snapshot: AgentViewSessionSnapshot,
): boolean {
  return deriveAgentViewPresentation(snapshot).actions.canHibernate;
}

function deriveTaskState(
  state: AgentViewSessionStateFile,
  _inputState: AgentViewInputState,
): AgentViewTaskState {
  switch (state.sessionState) {
    case 'starting':
    case 'working':
      return 'running';
    case 'needs_input':
      return 'waiting';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    case 'idle':
    case 'completed':
      return 'ready';
    default:
      return assertNever(state.sessionState);
  }
}

function deriveRuntimeState(
  processState: AgentViewProcessState,
): AgentViewRuntimeState {
  switch (processState) {
    case 'starting':
      return 'starting';
    case 'alive':
      return 'alive';
    case 'hibernating':
    case 'hibernated':
      return 'hibernated';
    case 'restarting':
      return 'restarting';
    case 'exited':
      return 'exited';
    default:
      return assertNever(processState);
  }
}

function deriveInputState(
  activity: AgentViewActivityFile | undefined,
): AgentViewInputState {
  // The explicit structured kind a worker reported is authoritative; the
  // waitingFor text rules only infer a kind the worker did not state. A
  // soft question without a waitingFor phrase must stay answerable.
  const inputKind = activity?.inputKind;
  if (inputKind === 'soft') {
    return 'soft_question';
  }
  const waitingFor = activity?.waitingFor?.toLowerCase();
  if (!waitingFor) {
    return inputKind === 'blocking' ? 'confirmation' : 'none';
  }
  if (inputKind !== 'blocking' && waitingFor === 'response') {
    return 'soft_question';
  }
  if (waitingFor.includes('permission') || waitingFor.includes('approval')) {
    return 'permission';
  }
  if (waitingFor.includes('auth') || waitingFor.includes('setting')) {
    return 'auth_or_settings';
  }
  if (waitingFor.includes('confirm')) {
    return 'confirmation';
  }
  return inputKind === 'blocking' ? 'confirmation' : 'external_dialog';
}

function deriveRecoverability(
  state: AgentViewSessionStateFile,
  taskState: AgentViewTaskState,
  inputState: AgentViewInputState,
): AgentViewRecoverability {
  if (state.attachState === 'attached') {
    return 'blocked';
  }
  if (state.processState === 'alive') {
    return 'live';
  }
  if (
    state.processState === 'starting' ||
    state.processState === 'restarting' ||
    state.processState === 'hibernating'
  ) {
    return 'blocked';
  }
  if (taskState === 'waiting' && inputState !== 'soft_question') {
    return 'blocked';
  }
  return 'restartable';
}

function deriveGroup(
  taskState: AgentViewTaskState,
): AgentViewPresentationGroup {
  switch (taskState) {
    case 'waiting':
      return 'needs_input';
    case 'running':
      return 'working';
    case 'ready':
    case 'stopped':
    case 'failed':
      return 'completed';
    default:
      return assertNever(taskState);
  }
}

function deriveIconShape(
  runtimeState: AgentViewRuntimeState,
): AgentViewIconShape {
  if (runtimeState === 'alive' || runtimeState === 'starting') return 'alive';
  if (runtimeState === 'hibernated') return 'sleeping';
  return 'exited';
}

function deriveIconTone(taskState: AgentViewTaskState): AgentViewIconTone {
  switch (taskState) {
    case 'running':
      return 'working';
    case 'waiting':
      return 'needs_input';
    case 'ready':
      return 'ready';
    case 'stopped':
      return 'stopped';
    case 'failed':
      return 'failed';
    default:
      return assertNever(taskState);
  }
}

function deriveActions(
  state: AgentViewSessionStateFile,
  taskState: AgentViewTaskState,
  inputState: AgentViewInputState,
  recoverability: AgentViewRecoverability,
  pinned: boolean,
): AgentViewPresentationActions {
  const detached = state.attachState === 'detached';
  const needsBlockingAnswer =
    taskState === 'waiting' && inputState !== 'soft_question';
  const canRecover = detached && recoverability !== 'blocked';
  return {
    canAttach: canRecover,
    canPeek: true,
    canReply:
      canRecover &&
      (taskState === 'ready' ||
        taskState === 'stopped' ||
        taskState === 'failed' ||
        (taskState === 'waiting' && inputState === 'soft_question')),
    canStop: detached && taskState === 'running',
    canRemove: detached,
    canRespawn: canRecover && recoverability === 'restartable',
    canHibernate:
      !pinned &&
      detached &&
      (taskState === 'ready' ||
        (taskState === 'waiting' && inputState === 'soft_question')) &&
      state.processState === 'alive',
    needsBlockingAnswer,
  };
}

function deriveTitle(
  rosterEntry: AgentViewRosterEntry | undefined,
  launch: AgentViewLaunchFile | undefined,
  activity: AgentViewActivityFile | undefined,
): string {
  return (
    cleanText(rosterEntry?.displayName) ??
    cleanRuntimeSummary(activity?.summary) ??
    cleanText(launch?.initialPrompt) ??
    'Untitled session'
  );
}

function deriveSubtitle(
  activity: AgentViewActivityFile | undefined,
  taskState: AgentViewTaskState,
): string {
  const result = cleanText(activity?.lastResult);
  if (result) return result;
  if (taskState === 'stopped') return 'Stopped by user';
  if (taskState === 'failed') return 'Session failed';
  return '';
}

function cleanRuntimeSummary(value: string | undefined): string | undefined {
  const text = cleanText(value);
  if (!text) return undefined;
  if (
    text === 'Working' ||
    text === 'Idle' ||
    text === 'Completed' ||
    text === 'Stopped' ||
    text === 'Failed' ||
    text === 'Needs Input' ||
    text.startsWith('Running ') ||
    text.startsWith('Waiting for ')
  ) {
    return undefined;
  }
  return text;
}

function cleanText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function toTime(value: Date | string): number {
  const date = value instanceof Date ? value : new Date(value);
  return date.getTime();
}

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
