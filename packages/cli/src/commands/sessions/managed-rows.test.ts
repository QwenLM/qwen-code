/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type {
  AgentViewSessionSnapshot,
  AgentViewSessionState,
  AgentViewSessionStateFile,
} from '../../agent-view/protocol.js';
import type { SessionRegistryRecord } from '@qwen-code/qwen-code-core';
import { managedSessionRows, mergeSessionRows } from './managed-rows.js';

const NOW = Date.parse('2026-09-04T12:00:00Z');

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
  it('labels each task state in the roster’s own vocabulary', () => {
    const cases: Array<[AgentViewSessionState, string]> = [
      ['working', 'working'],
      ['starting', 'working'],
      ['needs_input', 'needs input'],
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
      expect(row.state).toBe(expected);
    }
  });

  it('never prints "ready" for a session that failed', () => {
    // The roster's display group folds ready/stopped/failed together. A
    // one-line table has no icon to carry the difference, so the label
    // must: a failed session reported as ready is unrecoverable for a
    // user reading only this output.
    const [row] = managedSessionRows(
      [snapshot({ state: state({ sessionState: 'failed' }) })],
      NOW,
    );
    expect(row.state).toBe('failed');
  });

  it('reports the worker pid, falling back to the host that owns the PTY', () => {
    const withWorker = managedSessionRows(
      [
        snapshot({
          worker: {
            schemaVersion: 1,
            hostPid: 100,
            workerPid: 200,
            protocolVersion: 1,
            platform: 'linux',
            recentOutputBytes: 0,
          },
        }),
      ],
      NOW,
    );
    expect(withWorker[0].pid).toBe(200);

    const hostOnly = managedSessionRows(
      [
        snapshot({
          worker: {
            schemaVersion: 1,
            hostPid: 100,
            protocolVersion: 1,
            platform: 'linux',
            recentOutputBytes: 0,
          },
        }),
      ],
      NOW,
    );
    expect(hostOnly[0].pid).toBe(100);
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
    expect(rows[0].state).toBe('working');
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
        state: 'interactive',
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
