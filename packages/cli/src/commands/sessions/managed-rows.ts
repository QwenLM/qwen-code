/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Merging the two things that can be "a session running right now".
 *
 * `qwen sessions ps` has always walked the live-process registry, which
 * only a top-level interactive UI writes. A managed Agent View session is
 * just as live and considerably more interesting — it may be sitting on a
 * question nobody has answered — but it registers under a supervisor
 * rather than in that registry, so the command could not see it.
 *
 * This module turns both sources into one row shape. It is deliberately
 * pure: the readers stay in the command, so the merge and the labelling
 * are testable without a filesystem or a supervisor.
 */

import type { SessionRegistryRecord } from '@qwen-code/qwen-code-core';
import type { AgentViewSessionSnapshot } from '../../agent-view/protocol.js';
import {
  AGENT_VIEW_UNTITLED_TITLE,
  deriveAgentViewPresentation,
  type AgentViewTaskState,
} from '../../agent-view/presentation.js';

/** What the `STATE` column can say. */
export type SessionRowState =
  | 'interactive'
  | 'needs input'
  | 'working'
  | 'ready'
  | 'stopped'
  | 'failed';

/** One line of `qwen sessions ps`, from either source. */
export interface SessionRow {
  name: string;
  /**
   * Absent when a managed session has no process to point at — it has
   * exited, or has not spawned a worker yet. The table prints `-`; a
   * missing pid is not the same as pid 0.
   */
  pid?: number;
  /** Epoch milliseconds, or undefined when the source's stamp is unusable. */
  startedAt?: number;
  cwd: string;
  state: SessionRowState;
  sessionId: string;
  /** True for an Agent View session, false for a registry record. */
  managed: boolean;
  /**
   * The registry record this row was built from, absent for a managed
   * session. Carried rather than looked up again: session ids are not
   * guaranteed unique across records (a stale writer, a restored
   * transcript), and a lookup by id would then emit one record twice and
   * drop the other. `--json` emits this verbatim for registry rows.
   */
  record?: SessionRegistryRecord;
}

/**
 * Labelled by task state, not by the roster's display group.
 *
 * The group folds `ready`, `stopped` and `failed` into one
 * `completed` bucket, which the roster UI can afford because it also
 * paints an icon tone. A one-line table has no second channel, and
 * printing "completed" beside a session that failed would be a lie the
 * user has no way to see through.
 */
const TASK_STATE: Record<AgentViewTaskState, SessionRowState> = {
  running: 'working',
  waiting: 'needs input',
  ready: 'ready',
  stopped: 'stopped',
  failed: 'failed',
};

/**
 * Rows for the managed sessions a supervisor knows about.
 *
 * The name and the state both come from `deriveAgentViewPresentation`, so
 * this listing and the roster UI cannot drift into describing the same
 * session two different ways.
 */
export function managedSessionRows(
  snapshots: readonly AgentViewSessionSnapshot[],
  now: number = Date.now(),
): SessionRow[] {
  return snapshots.map((snapshot) => {
    // Passed field by field rather than spread: the parameter is a union
    // of the snapshot and the presentation input, and only the latter
    // carries `now`.
    const presentation = deriveAgentViewPresentation({
      state: snapshot.state,
      rosterEntry: snapshot.rosterEntry,
      launch: snapshot.launch,
      activity: snapshot.activity,
      now: new Date(now),
    });
    const createdAt = Date.parse(snapshot.state.createdAt);
    return {
      // `title` is derived from the roster entry, the activity file and
      // the launch record in that order, so it is the same label the
      // roster shows. Its placeholder is the one case to override: the
      // roster can afford identical "Untitled session" rows because a
      // user arrows onto one, while here the id is the only thing that
      // tells two of them apart — and the only thing they can be acted
      // on by.
      name:
        presentation.title === AGENT_VIEW_UNTITLED_TITLE || !presentation.title
          ? snapshot.state.sessionId
          : presentation.title,
      // The worker is the process doing the work; the host only owns the
      // PTY. Report whichever exists, worker first.
      pid: snapshot.worker?.workerPid ?? snapshot.worker?.hostPid,
      startedAt: Number.isNaN(createdAt) ? undefined : createdAt,
      cwd: snapshot.state.activeCwd,
      state: TASK_STATE[presentation.taskState],
      sessionId: snapshot.state.sessionId,
      managed: true,
    };
  });
}

/** Row for one live registry record. */
function registryRow(record: SessionRegistryRecord): SessionRow {
  return {
    name: record.name,
    pid: record.pid,
    startedAt: record.startedAt,
    cwd: record.cwd,
    state: 'interactive',
    sessionId: record.sessionId,
    managed: false,
    record,
  };
}

/**
 * One listing from both sources, managed sessions first.
 *
 * A managed worker is a Qwen Code session like any other, so it can also
 * write a registry record — and then the same session would be listed
 * twice, once as `interactive` and once with its real state. The managed
 * row wins: it knows the group, the supervisor and the session's title,
 * where the registry record knows only that a process is alive.
 *
 * Ordering is managed-before-interactive rather than by age, because the
 * reason to run this command is usually a session waiting on an answer.
 * Within each source the caller's order is preserved — both readers
 * already sort newest first.
 */
export function mergeSessionRows(
  records: readonly SessionRegistryRecord[],
  managed: readonly SessionRow[],
): SessionRow[] {
  const managedIds = new Set(managed.map((row) => row.sessionId));
  return [
    ...managed,
    ...records
      .filter((record) => !managedIds.has(record.sessionId))
      .map(registryRow),
  ];
}
