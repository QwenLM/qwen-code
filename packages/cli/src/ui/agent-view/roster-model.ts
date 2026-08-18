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
  AgentViewSessionState,
  AgentViewSessionStateFile,
  AgentViewWorkerFile,
} from '../../agent-view/protocol.js';
import type {
  AgentViewIconShape,
  AgentViewIconTone,
  AgentViewInputState,
  AgentViewPresentationActions,
  AgentViewRecoverability,
  AgentViewRuntimeState,
  AgentViewTaskState,
} from '../../agent-view/presentation.js';
import { deriveAgentViewPresentation } from '../../agent-view/presentation.js';

export type AgentRosterStateGroup = 'needs_input' | 'working' | 'done';

export type AgentRosterAliveIndicator = 'alive' | 'hibernating' | 'offline';
export type AgentRosterGroupMode = 'state' | 'directory';

export interface BuildAgentRosterRowsOptions {
  sessions: AgentViewSessionStateFile[];
  rosterEntries?: AgentViewRosterEntry[];
  launches?: Record<string, AgentViewLaunchFile | undefined>;
  activities?: Record<string, AgentViewActivityFile | undefined>;
  workers?: Record<string, AgentViewWorkerFile | undefined>;
  filter?: string;
  now?: Date | string;
}

export interface AgentRosterRow {
  sessionId: string;
  displayName?: string;
  pinned?: boolean;
  state: AgentViewSessionState;
  stateLabel: string;
  stateGroup: AgentRosterStateGroup;
  taskState: AgentViewTaskState;
  inputState: AgentViewInputState;
  runtimeState: AgentViewRuntimeState;
  recoverability: AgentViewRecoverability;
  iconShape: AgentViewIconShape;
  iconTone: AgentViewIconTone;
  title: string;
  subtitle: string;
  actions: AgentViewPresentationActions;
  project: string;
  projectCwd: string;
  activeCwd: string;
  cwd: string;
  ageMs: number;
  ageLabel: string;
  updatedAt: string;
  alive: boolean;
  aliveIndicator: AgentRosterAliveIndicator;
  summary?: string;
  waitingFor?: string;
  inputKind?: AgentViewActivityFile['inputKind'];
  lastResult?: string;
  queuedPromptCount?: number;
  queuedPromptPreview?: string;
  lastActivityAt?: string;
  lastHeartbeatAt?: string;
}

export function buildAgentRosterRows(
  options: BuildAgentRosterRowsOptions,
): AgentRosterRow[] {
  const now = toTime(options.now ?? new Date());
  const rosterEntries = new Map(
    options.rosterEntries?.map((entry) => [entry.sessionId, entry]) ?? [],
  );
  const rows = options.sessions.map((session) =>
    toRosterRow(
      session,
      rosterEntries.get(session.sessionId),
      options.launches?.[session.sessionId],
      options.activities?.[session.sessionId],
      options.workers?.[session.sessionId],
      now,
    ),
  );

  return rows
    .filter((row) => matchesFilter(row, options.filter))
    .sort(compareRosterRows);
}

export function filterAgentRosterRows(
  rows: AgentRosterRow[],
  filter: string | undefined,
): AgentRosterRow[] {
  return rows.filter((row) => matchesFilter(row, filter));
}

function toRosterRow(
  session: AgentViewSessionStateFile,
  rosterEntry: AgentViewRosterEntry | undefined,
  launch: AgentViewLaunchFile | undefined,
  activity: AgentViewActivityFile | undefined,
  worker: AgentViewWorkerFile | undefined,
  now: number,
): AgentRosterRow {
  // An unparseable createdAt must not surface as a ~56-year duration.
  const createdAt = toTime(session.createdAt);
  const ageMs =
    Number.isNaN(now) || Number.isNaN(createdAt)
      ? 0
      : Math.max(0, now - createdAt);
  const stateLabel = formatStateLabel(session.sessionState);
  const presentation = deriveAgentViewPresentation({
    state: session,
    ...(rosterEntry ? { rosterEntry } : {}),
    ...(launch ? { launch } : {}),
    ...(activity ? { activity } : {}),
    ...(worker ? { worker } : {}),
    now: new Date(now).toISOString(),
  });
  const aliveIndicator = getAliveIndicator(session.processState);

  return {
    sessionId: session.sessionId,
    displayName: rosterEntry?.displayName,
    pinned: rosterEntry?.pinned,
    state: session.sessionState,
    stateLabel,
    stateGroup: getStateGroup(presentation.group),
    taskState: presentation.taskState,
    inputState: presentation.inputState,
    runtimeState: presentation.runtimeState,
    recoverability: presentation.recoverability,
    iconShape: presentation.iconShape,
    iconTone: presentation.iconTone,
    title: presentation.title,
    subtitle: presentation.subtitle,
    actions: presentation.actions,
    project: getProjectName(session.projectCwd),
    projectCwd: session.projectCwd,
    activeCwd: session.activeCwd,
    cwd: session.activeCwd || session.projectCwd,
    ageMs,
    ageLabel: formatDuration(ageMs),
    updatedAt: session.updatedAt,
    alive: aliveIndicator === 'alive',
    aliveIndicator,
    summary: cleanText(activity?.summary) ?? cleanText(launch?.initialPrompt),
    waitingFor: activity?.waitingFor,
    inputKind: activity?.inputKind,
    lastResult: activity?.lastResult,
    queuedPromptCount: activity?.queuedPromptCount,
    queuedPromptPreview: activity?.queuedPromptPreview,
    lastActivityAt: activity?.lastActivityAt,
    lastHeartbeatAt: worker?.lastHeartbeatAt,
  };
}

function cleanText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function compareRosterRows(
  left: AgentRosterRow,
  right: AgentRosterRow,
): number {
  if (Boolean(left.pinned) !== Boolean(right.pinned)) {
    return left.pinned ? -1 : 1;
  }

  const groupDelta =
    getStateGroupRank(left.stateGroup) - getStateGroupRank(right.stateGroup);
  if (groupDelta !== 0) {
    return groupDelta;
  }

  const ageDelta = left.ageMs - right.ageMs;
  if (ageDelta !== 0) {
    return ageDelta;
  }

  return left.sessionId.localeCompare(right.sessionId);
}

function matchesFilter(
  row: AgentRosterRow,
  rawFilter: string | undefined,
): boolean {
  const filter = rawFilter?.trim().toLowerCase();
  if (!filter) {
    return true;
  }

  const terms = filter.split(/\s+/);
  return terms.every((term) => {
    if (term.startsWith('s:')) {
      return matchesStateFilter(row, term.slice(2));
    }

    return getSearchText(row).includes(term);
  });
}

function matchesStateFilter(row: AgentRosterRow, stateFilter: string): boolean {
  switch (stateFilter) {
    case 'blocked':
      return row.stateGroup === 'needs_input';
    case 'working':
      // Group-level alias (like blocked/done) so starting sessions, which
      // render in the Working group, are not silently excluded.
      return row.stateGroup === 'working';
    case 'done':
      return row.stateGroup === 'done';
    default:
      return row.state === stateFilter || row.taskState === stateFilter;
  }
}

function getSearchText(row: AgentRosterRow): string {
  return [
    row.displayName,
    row.sessionId,
    row.state,
    row.stateLabel,
    row.taskState,
    row.inputState,
    row.project,
    row.projectCwd,
    row.activeCwd,
    row.cwd,
    row.summary,
    row.waitingFor,
    row.lastResult,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
}

function getStateGroup(
  group: ReturnType<typeof deriveAgentViewPresentation>['group'],
): AgentRosterStateGroup {
  switch (group) {
    case 'needs_input':
      return 'needs_input';
    case 'completed':
      return 'done';
    case 'working':
      return 'working';
    default:
      return assertNever(group);
  }
}

function getStateGroupRank(group: AgentRosterStateGroup): number {
  switch (group) {
    case 'needs_input':
      return 0;
    case 'working':
      return 1;
    case 'done':
      return 2;
    default:
      return assertNever(group);
  }
}

function getAliveIndicator(
  state: AgentViewProcessState,
): AgentRosterAliveIndicator {
  switch (state) {
    case 'starting':
    case 'alive':
    case 'restarting':
      return 'alive';
    case 'hibernating':
    case 'hibernated':
      return 'hibernating';
    case 'exited':
      return 'offline';
    default:
      return assertNever(state);
  }
}

function formatStateLabel(state: AgentViewSessionState): string {
  return state
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getProjectName(projectCwd: string): string {
  const trimmed = projectCwd.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || projectCwd;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function toTime(value: Date | string): number {
  const date = value instanceof Date ? value : new Date(value);
  // Callers must handle NaN explicitly; coercing here would turn an
  // unparseable timestamp into epoch 0 and a bogus ~56-year age.
  return date.getTime();
}

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
