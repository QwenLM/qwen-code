/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  AgentViewLaunchFile,
  AgentViewSessionSnapshot,
  AgentViewSessionState,
  AgentViewSessionStateFile,
  AgentViewWorkerFile,
} from '../../agent-view/protocol.js';
import type { SessionRegistryRecord } from '@qwen-code/qwen-code-core';
import type { AgentViewTaskState } from '../../agent-view/presentation.js';

const isPidAlive = vi.fn((pid: number) => pid > 0);
/** The start token the OS would report for a pid right now. */
const currentProcStart = vi.fn((pid: number): string | null => `start-${pid}`);
const pidNamespaceId = vi.fn((): number | null => null);
/** The boot id this machine reports; null models an unreadable boot id. */
const localBootId = vi.fn((): string | null => 'boot-local');

vi.mock('@qwen-code/qwen-code-core', () => ({
  isPidAlive: (...args: unknown[]) => isPidAlive(...(args as [number])),
  readProcStartToken: (...args: unknown[]) =>
    currentProcStart(...(args as [number])),
  readPidNamespaceId: () => pidNamespaceId(),
  readLocalBootId: () => localBootId(),
  // Mirrors the real degradation contract rather than stubbing a verdict,
  // so a test that records no token exercises the same fall-through to a
  // bare liveness check that a pre-identity worker file gets in
  // production: `procStart == null` and an unreadable current token both
  // mean "no identity available", never "mismatch".
  isSameProcess: (pid: number, procStart?: string | null) => {
    if (!isPidAlive(pid)) return false;
    if (procStart == null) return true;
    const current = currentProcStart(pid);
    if (current === null) return true;
    return current === procStart;
  },
}));

const { managedSessionRows, mergeSessionRows } = await import(
  './managed-rows.js'
);

const NOW = Date.parse('2026-09-04T12:00:00Z');

beforeEach(() => {
  isPidAlive.mockReset();
  isPidAlive.mockImplementation((pid: number) => pid > 0);
  currentProcStart.mockReset();
  currentProcStart.mockImplementation((pid: number) => `start-${pid}`);
  pidNamespaceId.mockReset();
  pidNamespaceId.mockImplementation(() => null);
  localBootId.mockReset();
  localBootId.mockImplementation(() => 'boot-local');
});

function state(
  over: Partial<AgentViewSessionStateFile> = {},
): AgentViewSessionStateFile {
  return {
    schemaVersion: 1,
    sessionId: 'managed-1',
    ownership: 'managed',
    sessionState: 'working',
    processState: 'alive',
    attachState: 'detached',
    projectCwd: '/w/app',
    originalCwd: '/w/app',
    activeCwd: '/w/app',
    createdAt: '2026-09-04T11:58:00Z',
    updatedAt: '2026-09-04T11:59:00Z',
    worktree: { mode: 'none' },
    ...over,
  };
}

function snapshot(
  over: Partial<AgentViewSessionSnapshot> = {},
): AgentViewSessionSnapshot {
  const base = over.state ?? state();
  return { sessionId: base.sessionId, state: base, ...over };
}

function workerFile(
  over: Partial<AgentViewWorkerFile> = {},
): AgentViewWorkerFile {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    platform: 'linux',
    recentOutputBytes: 0,
    ...over,
  };
}

function launchFile(
  over: Partial<AgentViewLaunchFile> = {},
): AgentViewLaunchFile {
  return {
    schemaVersion: 1,
    sessionId: 'managed-1',
    argv: [],
    env: {},
    entrypoint: 'qwen',
    projectCwd: '/w/app',
    activeCwd: '/w/app',
    includeDirectories: [],
    terminal: { columns: 80, rows: 24 },
    ...over,
  };
}

function record(
  over: Partial<SessionRegistryRecord> = {},
): SessionRegistryRecord {
  return {
    schemaVersion: 1,
    pid: 4242,
    procStart: '123',
    pidNs: null,
    sessionId: 'sess-1',
    cwd: '/w/app',
    name: 'app-ab',
    startedAt: NOW - 90_000,
    qwenVersion: '1.0.0',
    ...over,
  };
}

describe('managedSessionRows', () => {
  it('carries the presentation layer’s own task state, not a label', () => {
    // The row reaches `--json`, so this field is a machine contract. It
    // stays the stable token; `ps.ts` turns it into English at the one
    // place that renders a table.
    const cases: Array<[AgentViewSessionState, AgentViewTaskState]> = [
      ['working', 'running'],
      ['starting', 'running'],
      ['needs_input', 'waiting'],
      ['idle', 'ready'],
      ['completed', 'ready'],
      ['stopped', 'stopped'],
      ['failed', 'failed'],
    ];
    for (const [sessionState, expected] of cases) {
      const [row] = managedSessionRows(
        [snapshot({ state: state({ sessionState }) })],
        NOW,
      );
      expect(row.taskState).toBe(expected);
    }
  });

  it('never reports a failed session as ready', () => {
    // The roster's display group folds ready/stopped/failed together, so
    // a consumer reading the group cannot tell a failure from a clean
    // finish. The task state can, and this is the field that reaches
    // both the table and `--json`.
    const [row] = managedSessionRows(
      [snapshot({ state: state({ sessionState: 'failed' }) })],
      NOW,
    );
    expect(row.taskState).toBe('failed');
  });

  it('leaves a registry row with no task state at all', () => {
    // A registry record knows a process is alive and nothing more;
    // inventing a task state for it would be a claim nobody made.
    const rows = mergeSessionRows([record()], []);
    expect(rows[0].taskState).toBeUndefined();
  });

  it('reports the worker pid, falling back to the host that owns the PTY', () => {
    const withWorker = managedSessionRows(
      [snapshot({ worker: workerFile({ hostPid: 100, workerPid: 200 }) })],
      NOW,
    );
    expect(withWorker[0].pid).toBe(200);

    const hostOnly = managedSessionRows(
      [snapshot({ worker: workerFile({ hostPid: 100 }) })],
      NOW,
    );
    expect(hostOnly[0].pid).toBe(100);
  });

  it('drops a recorded pid that no longer resolves to a live process', () => {
    // The store outlives the supervisor; after a crash or a reboot a
    // recorded pid is dead or recycled to an unrelated process, and
    // printing it would point a kill at the wrong target.
    isPidAlive.mockImplementation(() => false);
    const [row] = managedSessionRows(
      [snapshot({ worker: workerFile({ hostPid: 100, workerPid: 200 }) })],
      NOW,
    );
    expect(row.pid).toBeUndefined();
  });

  it('falls back to the PTY host only while the host still lives', () => {
    isPidAlive.mockImplementation((pid: number) => pid === 100);
    const [row] = managedSessionRows(
      [snapshot({ worker: workerFile({ hostPid: 100, workerPid: 200 }) })],
      NOW,
    );
    expect(row.pid).toBe(100);
  });

  it('drops a live pid the recorded identity does not vouch for', () => {
    // The half of the blocker liveness cannot see. After a SIGKILL or a
    // reboot nothing clears the durable worker file, and the OS is free to
    // hand 200 to something unrelated: `kill(200, 0)` then says "alive"
    // about a process that has nothing to do with this session, and a
    // script reading `--json` would kill a stranger.
    const [row] = managedSessionRows(
      [
        snapshot({
          worker: workerFile({
            workerPid: 200,
            workerProcStart: 'start-200-before-the-reboot',
          }),
        }),
      ],
      NOW,
    );
    expect(isPidAlive(200)).toBe(true);
    expect(row.pid).toBeUndefined();
  });

  it('refuses pids from a worker file written in another PID namespace', () => {
    // One `~/.qwen` shared across machines or namespaces — an NFS home, a
    // devcontainer with the home mounted — needs no recycling to break
    // this: the foreign file's pids get probed here, where low numbers
    // routinely belong to live local processes.
    pidNamespaceId.mockImplementation(() => 4026531999);
    const [row] = managedSessionRows(
      [
        snapshot({
          worker: workerFile({
            workerPid: 200,
            workerProcStart: 'start-200',
            pidNs: 4026531837,
          }),
        }),
      ],
      NOW,
    );
    expect(row.pid).toBeUndefined();
  });

  it('still reports a pid when either side’s namespace is unreadable', () => {
    // The guard fires only on a known disagreement. `/proc` being
    // unreadable must not blank the pid of a worker that is really there.
    pidNamespaceId.mockImplementation(() => null);
    const [row] = managedSessionRows(
      [
        snapshot({
          worker: workerFile({
            workerPid: 200,
            workerProcStart: 'start-200',
            pidNs: 4026531837,
          }),
        }),
      ],
      NOW,
    );
    expect(row.pid).toBe(200);
  });

  it('keeps reporting pids from a worker file written before identity existed', () => {
    // `AgentViewWorkerFile` is a durable schemaVersion 1 record. A file
    // written by an older supervisor carries no token, and that must
    // degrade to the liveness check this command already did — not blank
    // the pid of every session that predates the field.
    const [row] = managedSessionRows(
      [snapshot({ worker: workerFile({ hostPid: 100, workerPid: 200 }) })],
      NOW,
    );
    expect(row.pid).toBe(200);
  });

  it('refuses a pid recorded under another boot when ours is unreadable', () => {
    // Two machines sharing one `~/.qwen` both live in the initial PID
    // namespace, whose inode is a kernel constant, so the namespace guard
    // never fires between them — the boot-id prefix is the only
    // cross-machine identity. The guard must not depend on our own boot
    // id being readable: during the same outage `isSameProcess` degrades
    // to a bare liveness check (the current token is unreadable too),
    // which vouches for whatever local process holds the number — here
    // pid 87, alive locally but nobody's worker.
    localBootId.mockImplementation(() => null);
    currentProcStart.mockImplementation(() => null);
    const [row] = managedSessionRows(
      [
        snapshot({
          worker: workerFile({ workerPid: 87, workerProcStart: 'bootA:1234' }),
        }),
      ],
      NOW,
    );
    expect(isPidAlive(87)).toBe(true);
    expect(row.pid).toBeUndefined();
  });

  it('refuses a pid whose recorded boot prefix differs from the local one', () => {
    localBootId.mockImplementation(() => 'bootB');
    currentProcStart.mockImplementation(() => null);
    const [row] = managedSessionRows(
      [
        snapshot({
          worker: workerFile({ workerPid: 87, workerProcStart: 'bootA:1234' }),
        }),
      ],
      NOW,
    );
    expect(row.pid).toBeUndefined();
  });

  it('still reports a pid recorded under the local boot', () => {
    // The boot guard skips only foreign boots; a matching prefix hands
    // the candidate to the identity check as before.
    localBootId.mockImplementation(() => 'bootA');
    currentProcStart.mockImplementation(() => 'bootA:1234');
    const [row] = managedSessionRows(
      [
        snapshot({
          worker: workerFile({ workerPid: 87, workerProcStart: 'bootA:1234' }),
        }),
      ],
      NOW,
    );
    expect(row.pid).toBe(87);
  });

  it('falls back to the host pid when the worker pid is from another boot', () => {
    // The guard is per candidate: a foreign worker token must not blank
    // a host pid recorded under the local boot.
    localBootId.mockImplementation(() => 'bootA');
    currentProcStart.mockImplementation((pid: number) =>
      pid === 100 ? 'bootA:55' : null,
    );
    const [row] = managedSessionRows(
      [
        snapshot({
          worker: workerFile({
            hostPid: 100,
            hostProcStart: 'bootA:55',
            workerPid: 87,
            workerProcStart: 'bootB:1234',
          }),
        }),
      ],
      NOW,
    );
    expect(row.pid).toBe(100);
  });

  it('leaves the pid unset when no process is recorded, rather than reporting 0', () => {
    // A managed session that has not spawned a worker yet, or whose
    // worker has exited, has no pid to point at. Zero is a real pid.
    const [row] = managedSessionRows([snapshot()], NOW);
    expect(row.pid).toBeUndefined();
  });

  it('prefers the roster display name, then the activity summary', () => {
    const named = managedSessionRows(
      [snapshot({ rosterEntry: rosterEntry('release audit') })],
      NOW,
    );
    expect(named[0].name).toBe('release audit');

    const summarized = managedSessionRows(
      [
        snapshot({
          activity: {
            schemaVersion: 1,
            summary: 'bisecting the flake',
            lastActivityAt: '2026-09-04T11:59:00Z',
            capabilities: [],
          },
        }),
      ],
      NOW,
    );
    expect(summarized[0].name).toBe('bisecting the flake');
  });

  it('falls back to the session id when nothing has produced a title yet', () => {
    const [row] = managedSessionRows([snapshot()], NOW);
    expect(row.name).toBe('managed-1');
  });

  it('reports the resumable spelling, not the sanitized store id', () => {
    // The store files the session under the lowercased directory name,
    // but adoption preserves the raw spelling as resumeSessionId because
    // the native session store is case-sensitive. The merge dedupes away
    // the registry record that carried the raw spelling, so this row is
    // the only id a script can pipe into `qwen --resume`.
    const [row] = managedSessionRows(
      [
        snapshot({
          state: state({ sessionId: 'managed-1' }),
          launch: launchFile({ resumeSessionId: 'Managed-1' }),
        }),
      ],
      NOW,
    );
    expect(row.sessionId).toBe('Managed-1');
  });

  it('falls back to the store id when no resume spelling is recorded', () => {
    // A session created rather than adopted has no resumeSessionId in its
    // launch file; the sanitized store id is the resumable one then.
    const [row] = managedSessionRows([snapshot({ launch: launchFile() })], NOW);
    expect(row.sessionId).toBe('managed-1');
  });

  it('shows the resumable spelling when the id doubles as the name', () => {
    // The name fallback is what a user reads and acts on in the table;
    // it must match the id the row reports.
    const [row] = managedSessionRows(
      [
        snapshot({
          state: state({ sessionId: 'managed-1' }),
          launch: launchFile({ resumeSessionId: 'Managed-1' }),
        }),
      ],
      NOW,
    );
    expect(row.name).toBe('Managed-1');
  });

  it('drops an unparseable createdAt instead of dating the row to 1970', () => {
    const [row] = managedSessionRows(
      [snapshot({ state: state({ createdAt: 'not-a-date' }) })],
      NOW,
    );
    expect(row.startedAt).toBeUndefined();
  });

  it('lists only snapshots the supervisor owns', () => {
    // A removed session lingers as an unmanaged tombstone for a retention
    // window, a removal can be mid-flight, and adoption reuses the id of
    // a session that is still live and registered. Listing any of those
    // would show a ghost, or shadow a live registry row with a pid-less
    // one during the adopting window.
    for (const ownership of ['unmanaged', 'adopting', 'removing'] as const) {
      const rows = managedSessionRows(
        [snapshot({ state: state({ ownership }) })],
        NOW,
      );
      expect(rows).toHaveLength(0);
    }
  });

  it('carries the created stamp through as epoch milliseconds', () => {
    const [row] = managedSessionRows([snapshot()], NOW);
    expect(row.startedAt).toBe(Date.parse('2026-09-04T11:58:00Z'));
  });
});

function rosterEntry(displayName: string) {
  return {
    sessionId: 'managed-1',
    projectCwd: '/w/app',
    activeCwd: '/w/app',
    displayName,
    createdAt: '2026-09-04T11:58:00Z',
    updatedAt: '2026-09-04T11:59:00Z',
  };
}

describe('mergeSessionRows', () => {
  it('lists managed sessions before interactive ones', () => {
    const rows = mergeSessionRows(
      [record()],
      managedSessionRows([snapshot()], NOW),
    );
    expect(rows.map((row) => row.managed)).toEqual([true, false]);
  });

  it('lists a session once when it is both managed and registered', () => {
    // A managed worker is a Qwen Code session and can register like any
    // other. Listing it twice — once as `interactive`, once with its real
    // state — is the bug this dedupe exists for.
    const rows = mergeSessionRows(
      [record({ sessionId: 'managed-1', name: 'app-ab' })],
      managedSessionRows([snapshot()], NOW),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].managed).toBe(true);
    expect(rows[0].taskState).toBe('running');
  });

  it('lists a mixed-case session once, though the two sources spell it differently', () => {
    // The store files a session under a sanitized, lowercased directory
    // name and reports that as the id; the registry keeps the raw spelling
    // the worker registered with, which adoption preserves on purpose
    // because the native session store is case-sensitive. A raw string
    // comparison lets this record through and the table lists one session
    // twice — once with its real state, once as `interactive`. The
    // record's raw spelling still survives the dedupe: with no launch
    // file to read it from, the row had degraded to the sanitized store
    // id, and the record is the only carrier left of the spelling the
    // case-sensitive native store needs for `--resume`.
    const rows = mergeSessionRows(
      [record({ sessionId: 'Managed-1', name: 'app-ab' })],
      managedSessionRows([snapshot({ state: state() })], NOW),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].managed).toBe(true);
    expect(rows[0].sessionId).toBe('Managed-1');
  });

  it('keeps the resumable spelling when it dedupes a mixed-case session', () => {
    // The deduped registry record was the only other carrier of the raw
    // spelling, so the surviving managed row must keep reporting it —
    // the comparison stays sanitized on both sides, only the emitted
    // value carries the raw spelling.
    const rows = mergeSessionRows(
      [record({ sessionId: 'Managed-1', name: 'app-ab' })],
      managedSessionRows(
        [
          snapshot({
            state: state({ sessionId: 'managed-1' }),
            launch: launchFile({ resumeSessionId: 'Managed-1' }),
          }),
        ],
        NOW,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].managed).toBe(true);
    expect(rows[0].sessionId).toBe('Managed-1');
  });

  it('carries the deduped record’s verified pid onto a worker-less managed row', () => {
    // The store fails soft on an unreadable worker file, so the managed
    // row has no pid while the session is still live and owned. The
    // registry record it dedupes against verified that very pid under the
    // same identity contract every registry row answers to, so the
    // surviving row reports it instead of `-`.
    const rows = mergeSessionRows(
      [record({ sessionId: 'managed-1', pid: 4242 })],
      managedSessionRows([snapshot()], NOW),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].managed).toBe(true);
    expect(rows[0].pid).toBe(4242);
  });

  it('keeps the managed row’s own live pid over the deduped record’s', () => {
    // The carry only fills what the degraded row lost: a pid the worker
    // file still vouches for outranks the record's.
    const rows = mergeSessionRows(
      [record({ sessionId: 'managed-1', pid: 4242 })],
      managedSessionRows(
        [
          snapshot({
            worker: workerFile({
              workerPid: 200,
              workerProcStart: 'start-200',
            }),
          }),
        ],
        NOW,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].pid).toBe(200);
  });

  it('lets a live registry record survive the adopting window', () => {
    // Adoption reuses the live session's id before ownership flips to
    // managed. Until it flips, the registry record is the only row that
    // knows a live pid, so the merge must not drop it for an adopting
    // snapshot.
    const rows = mergeSessionRows(
      [record({ sessionId: 'managed-1' })],
      managedSessionRows(
        [snapshot({ state: state({ ownership: 'adopting' }) })],
        NOW,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].managed).toBe(false);
    expect(rows[0].pid).toBe(4242);
  });

  it('keeps registry rows whose session id no supervisor claims', () => {
    const rows = mergeSessionRows(
      [record({ sessionId: 'sess-1' }), record({ sessionId: 'sess-2' })],
      managedSessionRows([snapshot()], NOW),
    );
    expect(rows.map((row) => row.sessionId)).toEqual([
      'managed-1',
      'sess-1',
      'sess-2',
    ]);
  });

  it('marks every interactive row as unmanaged and carries its record', () => {
    // The record rides along so `--json` can emit it verbatim: two
    // records can share a session id, and looking one back up by id
    // would emit it twice and drop the other.
    const rec = record();
    const rows = mergeSessionRows([rec], []);
    expect(rows).toEqual([
      {
        name: 'app-ab',
        pid: 4242,
        startedAt: NOW - 90_000,
        cwd: '/w/app',
        sessionId: 'sess-1',
        managed: false,
        record: rec,
      },
    ]);
  });

  it('emits both records when two of them share a session id', () => {
    // A stale writer or a restored transcript can duplicate an id.
    const first = record({ pid: 1 });
    const second = record({ pid: 2 });
    const rows = mergeSessionRows([first, second], []);
    expect(rows.map((row) => row.record)).toEqual([first, second]);
  });
});
