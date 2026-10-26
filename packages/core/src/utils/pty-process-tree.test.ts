/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync }));

import { collectPtyProcessTree } from './pty-process-tree.js';

const SCOPED = process.platform === 'linux' || process.platform === 'darwin';
const A = 'Tue Oct 21 10:00:00 2026';
const B = 'Tue Oct 21 10:00:01 2026';

// One `ps -A -o pid=,ppid=,<scope>=,lstart=` row.
const row = (pid: number, parentPid: number, scope: string, started = A) =>
  `${pid} ${parentPid} ${scope} ${started}`;
const answer = (...rows: string[]) => {
  spawnSync.mockReturnValueOnce({ status: 0, stdout: `${rows.join('\n')}\n` });
};

describe.skipIf(!SCOPED)('collectPtyProcessTree', () => {
  beforeEach(() => {
    spawnSync.mockReset();
    spawnSync.mockReturnValue({ status: 1, stdout: '' });
  });

  it('lists the root, its descendants and session members in other groups', () => {
    answer(
      row(1, 0, '1'),
      row(2, 0, '0'),
      row(42, 1, '42'),
      row(43, 42, '42'),
      row(44, 43, '42'),
      // A job that outlived its shell: reparented, found by session/tty.
      row(45, 1, '42'),
      row(99, 1, '99'),
    );
    const tree = collectPtyProcessTree(42);
    expect(tree.pids[0]).toBe(42);
    expect([...tree.pids].sort()).toEqual([42, 43, 44, 45]);
    expect(tree.scope).toBe('42');
    expect(tree.started.get(45)).toBe(A);
  });

  it('keeps an earlier member only while it is still the same process', () => {
    answer(row(42, 1, '42'), row(45, 42, '42'), row(46, 42, '42'));
    const first = collectPtyProcessTree(42);

    // 45 lost its tty but is the same process; 46 is a recycled pid now in
    // another session.
    answer(row(42, 1, '42'), row(45, 1, '??'), row(46, 1, '77', B));
    expect(collectPtyProcessTree(42, first).pids).toEqual([42, 45]);
  });

  it('drops a reaped root and reuses its scope only where it still names the session', () => {
    answer(row(42, 1, '42'), row(45, 1, '42'));
    const first = collectPtyProcessTree(42);

    // 47 joined the session during the grace period.
    answer(row(45, 1, '42'), row(47, 1, '42'));
    expect(collectPtyProcessTree(42, first, true).pids).toEqual(
      process.platform === 'linux' ? [45, 47] : [45],
    );

    // The root's pid now leads another process: its scope is not ours.
    answer(row(42, 1, '42', B), row(45, 1, '42'), row(47, 1, '42'));
    expect(collectPtyProcessTree(42, first, true).pids).toEqual([45]);
  });

  it('falls back to a scan without start times and then carries nothing over', () => {
    spawnSync.mockReturnValueOnce({ status: 1, stdout: '' });
    spawnSync.mockReturnValueOnce({ status: 0, stdout: '42 1 42\n45 1 42\n' });
    const tree = collectPtyProcessTree(42);
    expect(spawnSync.mock.calls.map((call) => call[1])).toEqual([
      ['-A', '-o', expect.stringMatching(/^pid=,ppid=,(sid|tdev)=,lstart=$/)],
      ['-A', '-o', expect.stringMatching(/^pid=,ppid=,(sid|tdev)=$/)],
    ]);
    expect(tree.pids).toEqual([42, 45]);
    expect(tree.started.size).toBe(0);

    // Without a start time a pid cannot be told from a recycled one.
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: `${row(45, 1, '??')}\n`,
    });
    expect(collectPtyProcessTree(42, tree, true).pids).toEqual([]);
  });

  it('lists only the root when ps cannot run', () => {
    expect(collectPtyProcessTree(42)).toEqual({
      pids: [42],
      scope: undefined,
      started: new Map(),
    });
  });
});
