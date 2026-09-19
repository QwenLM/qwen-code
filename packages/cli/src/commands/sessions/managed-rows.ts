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
 * question nobody has answered — but the registry knows only that a
 * process is alive: not the session's title, not its task state, and
 * nothing at all about one whose worker has exited or has not spawned yet.
 * The supervisor's store knows all three, so the command reads both.
 *
 * This module turns both sources into one row shape. It is deliberately
 * pure: the readers stay in the command, so the merge and the labelling
 * are testable without a filesystem or a supervisor. The one probe it
 * makes — `isPidAlive`, which decides whether a recorded pid may still
 * be printed — is an input the tests control like any other.
 */

import { isPidAlive } from '@qwen-code/qwen-code-core/utils/process-liveness.js';
import type { SessionRegistryRecord } from '@qwen-code/qwen-code-core';
import type {
  AgentViewSessionSnapshot,
  AgentViewWorkerFile,
} from '../../agent-view/protocol.js';
import {
  AGENT_VIEW_UNTITLED_TITLE,
  deriveAgentViewPresentation,
  type AgentViewTaskState,
} from '../../agent-view/presentation.js';

/** One line of `qwen sessions ps`, from either source. */
export interface SessionRow {
  name: string;
  /**
   * Absent when a managed session has no process to point at — it has
   * exited, or has not spawned a worker yet. The table prints `-`; a
   * missing pid is not the same as pid 0.
   */
  pid?: number;
  /**
   * Epoch milliseconds, or undefined when there is nothing to date: an
   * unusable stamp, or a managed row with no process behind it.
   */
  startedAt?: number;
  cwd: string;
  /**
   * What the session is doing, for a managed row; absent for a registry
   * row, which only knows that a process is alive.
   *
   * Deliberately the presentation layer's own token rather than the
   * label the table prints: this field reaches `--json`, and pinning a
   * machine contract to display wording means rewording the column
   * breaks every script silently. The table maps it at the render site.
   */
  taskState?: AgentViewTaskState;
  sessionId: string;
  /** True for an Agent View session, false for a registry record. */
  managed: boolean;
  /**
   * The registry record for this session id, when one exists.
   *
   * Carried rather than looked up again: session ids are not
   * guaranteed unique across records (a stale writer, a restored
   * transcript), and a lookup by id would then emit one record twice and
   * drop the other. `--json` emits a record's fields verbatim, so a
   * managed session whose worker also registered keeps the fields only a
   * record carries — `ipcPath`, `procStart`, `pidNs`, `qwenVersion`.
   */
  record?: SessionRegistryRecord;
}

/**
 * Rows for the managed sessions a supervisor knows about.
 *
 * Only a snapshot the supervisor owns qualifies. The store also holds
 * unmanaged tombstones (a removed session persists for a retention
 * window), sessions mid-removal, and sessions mid-adoption — and an
 * adopting snapshot reuses the id of a session that is still live and
 * registered. Mapping any of those would list a ghost, or let the merge
 * below replace a registry row that knows a live pid with one that does
 * not. The supervisor's own listing skips the same shapes.
 *
 * The name and the state both come from `deriveAgentViewPresentation`, so
 * this listing and the roster UI cannot drift into describing the same
 * session two different ways.
 */
export function managedSessionRows(
  snapshots: readonly AgentViewSessionSnapshot[],
  now: number = Date.now(),
): SessionRow[] {
  return snapshots
    .filter((snapshot) => snapshot.state.ownership === 'managed')
    .map((snapshot) => {
      // Passed field by field rather than spread: the parameter is a
      // union of the snapshot and the presentation input, and only the
      // latter carries `now`.
      const presentation = deriveAgentViewPresentation({
        state: snapshot.state,
        rosterEntry: snapshot.rosterEntry,
        launch: snapshot.launch,
        activity: snapshot.activity,
        now: new Date(now),
      });
      const pid = liveWorkerPid(snapshot.worker);
      const createdAt = Date.parse(snapshot.state.createdAt);
      return {
        // `title` is derived from the roster entry, the activity file
        // and the launch record in that order, so it is the same label
        // the roster shows. Its placeholder is the one case to override:
        // the roster can afford identical "Untitled session" rows because
        // a user arrows onto one, while here the id is the only thing
        // that tells two of them apart — and the only thing they can be
        // acted on by.
        name:
          presentation.title === AGENT_VIEW_UNTITLED_TITLE ||
          !presentation.title
            ? snapshot.state.sessionId
            : presentation.title,
        pid,
        // Dated only while a process is behind it: AGE prints beside PID,
        // and counting a session's age next to a `-` would date a row that
        // has nothing running. For a live worker the creation stamp is
        // when it was spawned.
        startedAt:
          pid === undefined || Number.isNaN(createdAt) ? undefined : createdAt,
        cwd: snapshot.state.activeCwd,
        taskState: presentation.taskState,
        sessionId: snapshot.state.sessionId,
        managed: true,
      };
    });
}

/**
 * The recorded pid a row may point at, or none.
 *
 * The worker is the process doing the work; the host only owns the PTY —
 * report whichever lives, worker first, matching the supervisor's own
 * two-pid liveness idiom. The store is durable and nothing reaps it when
 * no supervisor runs, so a crash or a reboot leaves recorded pids behind
 * that are dead, or recycled to an unrelated process; printing one would
 * point a `kill` at the wrong target. When neither lives, the row prints
 * `-`, exactly like a session that never had a worker.
 */
function liveWorkerPid(
  worker: AgentViewWorkerFile | undefined,
): number | undefined {
  for (const pid of [worker?.workerPid, worker?.hostPid]) {
    if (pid !== undefined && isPidAlive(pid)) return pid;
  }
  return undefined;
}

/** Row for one live registry record. */
function registryRow(record: SessionRegistryRecord): SessionRow {
  return {
    name: record.name,
    pid: record.pid,
    startedAt: record.startedAt,
    cwd: record.cwd,
    sessionId: record.sessionId,
    managed: false,
    record,
  };
}

/**
 * One listing from both sources, managed sessions first.
 *
 * A managed worker is a Qwen Code session like any other, so it also
 * writes a registry record — and then the same session would be listed
 * twice, once as `interactive` and once with its real state. One row
 * survives, carrying both halves: the managed side contributes the title
 * and the task state, the record contributes the process facts it alone
 * knows. Ids are matched case-insensitively because the store keys a
 * session by its directory name, which `sanitizeSessionId` lowercases,
 * while a record keeps the spelling the session was launched with.
 *
 * A record is claimed by at most one managed row, so two records sharing
 * an id still both surface: the second stays a registry row rather than
 * being dropped for a session already listed.
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
  const keyOf = (sessionId: string): string => sessionId.toLowerCase();
  const claimed = new Set<number>();

  const merged = managed.map((row) => {
    const match = records.findIndex(
      (record, candidateIndex) =>
        !claimed.has(candidateIndex) &&
        keyOf(record.sessionId) === keyOf(row.sessionId),
    );
    if (match === -1) return row;
    claimed.add(match);
    const record = records[match]!;
    return {
      ...row,
      // The registry half has just proven a process is alive, so a
      // managed row whose worker pid is not recorded yet must not lose it
      // — nor the record's own start stamp, which is that process's.
      pid: row.pid ?? record.pid,
      startedAt: row.startedAt ?? record.startedAt,
      record,
    };
  });

  return [
    ...merged,
    ...records.filter((_record, index) => !claimed.has(index)).map(registryRow),
  ];
}

/** The task states that claim a process is doing something right now. */
const LIVE_TASK_STATES: readonly AgentViewTaskState[] = ['running', 'waiting'];

/**
 * The verdict on a managed row whose process is gone.
 *
 * The store outlives the supervisor and nothing reaps it, so a row can
 * still say `working` long after its worker exited. The supervisor's own
 * heal turns `starting`, `working` and `needs_input` into `failed` with a
 * `stale_worker` reason when no recorded pid runs; a reader with no
 * supervisor to ask applies the same verdict rather than printing
 * `working` beside a `PID -` that contradicts it. A session the store
 * already reports as finished keeps its own state — `ready` beside no pid
 * is a finished session, not a stale one.
 *
 * Runs after the merge, so a pid the registry half contributed counts.
 */
export function reconcileRowLiveness(
  rows: readonly SessionRow[],
): SessionRow[] {
  return rows.map((row) =>
    row.pid === undefined &&
    row.taskState !== undefined &&
    LIVE_TASK_STATES.includes(row.taskState)
      ? { ...row, taskState: 'failed' as const }
      : row,
  );
}
