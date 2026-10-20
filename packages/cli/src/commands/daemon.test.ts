/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Argv } from 'yargs';

vi.mock('../ui/utils/textUtils.js', () => ({
  sanitizeTerminalText: (value: string) => value,
}));

// A record only names a process inside the namespace it was written in, so
// the decision table is pinned against a fixed local namespace here.
vi.mock('../serve/daemon-discovery.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../serve/daemon-discovery.js')>();
  return {
    ...actual,
    currentPidNamespace: () => 'pid:[1]',
    isProcessAlive: () => false,
  };
});

import {
  daemonCommand,
  formatDaemonAge,
  followFile,
  pidResolvableHere,
  probeHealth,
  processStartMatchesRecord,
  processStartTime,
  selectDaemonEntries,
  tailLines,
  terminateTree,
} from './daemon.js';
import type { DaemonDiscoveryEntry } from '../serve/daemon-discovery.js';

function entry(port: number): DaemonDiscoveryEntry {
  return {
    path: `/tmp/daemon-${port}.json`,
    record: {
      v: 1,
      pid: 1000 + port,
      port,
      hostname: '127.0.0.1',
      url: `http://127.0.0.1:${port}`,
      workspaces: [`/tmp/project-${port}`],
      primaryWorkspace: `/tmp/project-${port}`,
      startedAt: '2026-10-19T00:00:00.000Z',
      auth: 'none',
    },
  };
}

describe('qwen daemon command', () => {
  it('declares the daemon namespace', () => {
    expect(daemonCommand.command).toBe('daemon');
    expect(typeof daemonCommand.builder).toBe('function');
    expect(typeof daemonCommand.handler).toBe('function');
  });

  it('registers status, logs and stop subcommands', () => {
    const mockYargs = {
      command: vi.fn().mockReturnThis(),
      demandCommand: vi.fn().mockReturnThis(),
      version: vi.fn().mockReturnThis(),
    };
    const builder = daemonCommand.builder;
    if (typeof builder !== 'function') {
      throw new Error('daemon command builder must be a function');
    }
    builder(mockYargs as unknown as Argv);

    expect(mockYargs.command.mock.calls.map((call) => call[0].command)).toEqual(
      ['status', 'logs', 'stop'],
    );
  });

  it('selects exactly one daemon only when the choice is unambiguous', () => {
    const one = entry(4170);
    const two = entry(4171);

    expect(selectDaemonEntries([one], {})).toEqual([one]);
    expect(selectDaemonEntries([one, two], {})).toEqual([]);
    expect(selectDaemonEntries([one, two], { port: 4171 })).toEqual([two]);
    expect(selectDaemonEntries([one, two], { all: true })).toEqual([one, two]);
  });

  it('formats ages for humans', () => {
    expect(formatDaemonAge(0)).toBe('0s');
    expect(formatDaemonAge(65_000)).toBe('1m');
    expect(formatDaemonAge(3_600_000)).toBe('1h');
    expect(formatDaemonAge(86_400_000)).toBe('1d');
  });

  it('treats a process that started after the record as a reused pid', () => {
    const recorded = '2026-10-19T00:00:00.000Z';
    const at = Date.parse(recorded);
    // A slow start may predate the record, but a much older process cannot
    // be the daemon (e.g. a pid reused across a namespace).
    expect(processStartMatchesRecord(recorded, at - 60_000)).toBe(true);
    expect(processStartMatchesRecord(recorded, at - 3_600_000)).toBe(false);
    // Clock precision inside the tolerance is still the recorded daemon.
    expect(processStartMatchesRecord(recorded, at + 1_000)).toBe(true);
    // A later start cannot be the daemon that wrote the record.
    expect(processStartMatchesRecord(recorded, at + 60_000)).toBe(false);
    expect(processStartMatchesRecord(recorded, undefined)).toBe(true);
    expect(processStartMatchesRecord('not-a-date', at)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'reads a live process start time that matches a record written now',
    () => {
      const started = processStartTime(process.pid);
      expect(started).toBeTypeOf('number');
      expect(processStartMatchesRecord(new Date().toISOString(), started)).toBe(
        true,
      );
    },
  );

  it('returns the trailing lines of a log', () => {
    expect(tailLines('a\nb\nc\n', 2)).toEqual(['b', 'c']);
    expect(tailLines('a\nb\nc', 10)).toEqual(['a', 'b', 'c']);
    expect(tailLines('', 5)).toEqual([]);
  });

  it('resolves a pid only inside the namespace that wrote the record', () => {
    const record = entry(4170).record;
    expect(pidResolvableHere(record, 'pid:[1]')).toBe(true);
    expect(
      pidResolvableHere({ ...record, pidNamespace: 'pid:[1]' }, 'pid:[1]'),
    ).toBe(true);
    // A record from a container sharing the runtime dir names another process.
    expect(
      pidResolvableHere({ ...record, pidNamespace: 'pid:[2]' }, 'pid:[1]'),
    ).toBe(false);
    // The writing kernel is not this one, so its pid means nothing here.
    expect(
      pidResolvableHere({ ...record, pidNamespace: 'pid:[1]' }, undefined),
    ).toBe(false);
  });

  it('does not read a foreign pid as death when the listener answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    try {
      // A private PID namespace hides the daemon's pid, which is not evidence
      // that the daemon is gone: the answered listener is the proof.
      await expect(
        probeHealth({ ...entry(4170).record, pidNamespace: 'pid:[2]' }),
      ).resolves.toBe('running');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still calls a recycled port stale inside one namespace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    try {
      // Another application may hold the port; inside the namespace the
      // recorded pid is addressable, so its absence still vetoes the answer.
      await expect(
        probeHealth({ ...entry(4170).record, pidNamespace: 'pid:[1]' }),
      ).resolves.toBe('stale');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps a foreign record when its listener does not answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    try {
      // Removing the record here would lose a daemon that is merely
      // unreachable from this namespace.
      await expect(
        probeHealth({ ...entry(4170).record, pidNamespace: 'pid:[2]' }),
      ).resolves.toBe('unreachable');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'sends SIGTERM to a POSIX daemon',
    () => {
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        terminateTree(999_998, false);
        expect(kill).toHaveBeenCalledWith(999_998, 'SIGTERM');
      } finally {
        kill.mockRestore();
      }
    },
  );

  it('never signals on Windows, where the kill is unconditional', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    try {
      // process.kill there is TerminateProcess: it runs no handler and leaves
      // the daemon's children behind, so the tree goes through taskkill.
      terminateTree(999_998, false);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
      kill.mockRestore();
    }
  });

  it('ends a follow once the reader closed the pipe', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qws-follow-'));
    const file = path.join(dir, 'daemon.log');
    await fsp.writeFile(file, 'line one\n');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' });
    });
    let settled = false;
    try {
      void followFile(file, 0).then(() => {
        settled = true;
      });
      // A reader that exits (`| head`) closes the pipe; the follow must end
      // instead of re-reading the same bytes forever.
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 });
    } finally {
      write.mockRestore();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
