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
 * question nobody has answered — but the registry alone cannot describe
 * its supervisor-owned state, so the command could not report it accurately.
 *
 * This module turns both sources into one row shape. It is deliberately
 * pure: the readers stay in the command, so the merge and the labelling
 * are testable without a filesystem or a supervisor. The probes it makes
 * — the process-identity checks that decide whether a recorded pid may
 * still be printed — are inputs the tests control like any other.
 *
 * Both sources describe the same sessions, and both had their own idea of
 * what a session's identity is. That is the bug class this module has to
 * keep closed:
 *
 * - the store files a session under a sanitized (lowercased) directory
 *   name and reports that as the id, while the registry keeps the raw
 *   spelling the worker registered with, so the merge canonicalizes
 *   through `sanitizeSessionId` before comparing;
 * - the registry verifies a pid with a recorded start token plus
 *   namespace and boot-id guards, so a managed pid is held to the same
 *   standard rather than to a bare liveness probe.
 */

import {
  isSameProcess,
  readLocalBootId,
  readPidNamespaceId,
  type SessionRegistryRecord,
} from '@qwen-code/qwen-code-core';
import { sanitizeSessionId } from '../../agent-view/protocol.js';
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
  /** Epoch milliseconds, or undefined when the source's stamp is unusable. */
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
   * The registry record this row was built from, absent for a managed
   * session. Carried rather than looked up again: session ids are not
   * guaranteed unique across records (a stale writer, a restored
   * transcript), and a lookup by id would then emit one record twice and
   * drop the other. `--json` emits this verbatim for registry rows.
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
 * not. The supervisor's own listing skips unmanaged and removing snapshots; it
 * shows sessions mid-adoption, which this listing must not, because the merge
 * below would trade their live registry pid for none.
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
        pid: liveWorkerPid(snapshot.worker),
        startedAt: Number.isNaN(createdAt) ? undefined : createdAt,
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
 * two-pid liveness idiom.
 *
 * Liveness alone is not enough to print a number a user or a script may
 * `kill`. The store is durable and nothing reaps it while no supervisor
 * runs, so a crash or a reboot leaves recorded pids behind; once the OS
 * recycles one, a bare `kill(pid, 0)` says "alive" about a process that
 * has nothing to do with this session. A `~/.qwen` shared between
 * machines or PID namespaces — an NFS home, a devcontainer with the home
 * mounted — reaches the same end without any recycling, because a foreign
 * file's pids get probed here, where low numbers routinely belong to live
 * local processes. So each candidate is checked with `isSameProcess`
 * against the start token the supervisor recorded beside it, which is the
 * contract the registry rows in this very table already answer to.
 *
 * Degradation is deliberate in two places. A worker file written before
 * those tokens existed carries none, and `isSameProcess` reads that as
 * "no identity recorded" and falls through to a liveness check — the
 * behaviour this command had before, rather than a blanked pid on every
 * pre-existing session. And the namespace guard only fires when both
 * sides are known and disagree; an unreadable namespace on either side
 * must not blank a real worker's pid.
 *
 * The boot-id prefix of a recorded token gets the same treatment the
 * registry gives it: two machines sharing one `~/.qwen` both live in the
 * initial PID namespace, whose inode is a kernel constant, so the
 * namespace guard never fires between them and the boot prefix is the
 * only cross-machine identity. A candidate recorded under another boot —
 * or under any boot while our own boot id is unreadable, because during
 * the same outage `isSameProcess` degrades to a bare liveness check that
 * vouches for whatever local process holds the number — is skipped. A
 * candidate with no boot prefix keeps the liveness fall-through.
 *
 * When nothing qualifies the row prints `-`, exactly like a session that
 * never had a worker.
 */
function liveWorkerPid(
  worker: AgentViewWorkerFile | undefined,
): number | undefined {
  if (!worker) return undefined;
  const ownNamespace = readPidNamespaceId();
  if (
    worker.pidNs != null &&
    ownNamespace != null &&
    worker.pidNs !== ownNamespace
  ) {
    return undefined;
  }
  const ownBootId = readLocalBootId();
  const candidates = [
    [worker.workerPid, worker.workerProcStart],
    [worker.hostPid, worker.hostProcStart],
  ] as const;
  for (const [pid, procStart] of candidates) {
    if (pid === undefined) continue;
    // Mirrors the guard `listLiveSessions` applies to registry records:
    // it must fire on an unreadable local boot id as well, not only on a
    // positive mismatch, and it must leave token-less candidates to the
    // liveness fall-through.
    const recordBootId = procStart == null ? null : bootIdOf(procStart);
    if (recordBootId !== null && recordBootId !== ownBootId) continue;
    if (isSameProcess(pid, procStart)) return pid;
  }
  return undefined;
}

/** The boot-id prefix of a `<boot_id>:<starttime>` token, or null. */
function bootIdOf(procStart: string): string | null {
  const sep = procStart.indexOf(':');
  return sep === -1 ? null : procStart.slice(0, sep);
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
  // Canonicalized on both sides rather than compared raw. The two
  // sources spell one id differently: the store reports the sanitized
  // directory name it files the session under, while the registry keeps
  // the raw spelling the worker registered with — adoption keeps both on
  // purpose, because the native session store is case-sensitive. Comparing
  // the spellings would let any managed session whose id contains an
  // uppercase letter through this filter, and the table would list it
  // twice: once with its real state, once as `interactive`.
  const managedIds = new Set(
    managed.map((row) => sanitizeSessionId(row.sessionId)),
  );
  return [
    ...managed,
    ...records
      .filter((record) => !managedIds.has(sanitizeSessionId(record.sessionId)))
      .map(registryRow),
  ];
}
