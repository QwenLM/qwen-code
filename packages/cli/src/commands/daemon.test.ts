/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Argv } from 'yargs';

vi.mock('../ui/utils/textUtils.js', () => ({
  sanitizeTerminalText: (value: string) => value,
}));

import {
  daemonCommand,
  formatDaemonAge,
  processStartMatchesRecord,
  processStartTime,
  selectDaemonEntries,
  tailLines,
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
    // A slow start may predate the record by any amount.
    expect(processStartMatchesRecord(recorded, at - 60_000)).toBe(true);
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
});
