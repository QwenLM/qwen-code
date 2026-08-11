/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionRegistryRecord } from '@qwen-code/qwen-code-core';

const listLiveSessions = vi.fn();

vi.mock('@qwen-code/qwen-code-core', () => ({
  listLiveSessions: (...args: unknown[]) => listLiveSessions(...args),
}));

const stdout: string[] = [];
const stderr: string[] = [];

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: (line: string) => stdout.push(line),
  writeStderrLine: (line: string) => stderr.push(line),
}));

const { psCommand, formatAge, NAME_COL, PID_COL, AGE_COL } = await import(
  './ps.js'
);

function record(
  over: Partial<SessionRegistryRecord> = {},
): SessionRegistryRecord {
  return {
    schemaVersion: 1,
    pid: 4242,
    procStart: '123',
    pidNamespace: '4026531836',
    machineId: 'test-machine',
    sessionId: 'sess-1',
    cwd: '/w/app',
    name: 'app-ab',
    kind: 'interactive',
    startedAt: Date.now() - 90_000,
    qwenVersion: '1.0.0',
    peerProtocol: 1,
    ...over,
  };
}

async function run(argv: Record<string, unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (psCommand.handler as any)(argv);
}

beforeEach(() => {
  stdout.length = 0;
  stderr.length = 0;
  listLiveSessions.mockReset();
  // Only Date: the age cell is rendered from `Date.now()` read inside the
  // handler, against a `startedAt` this file computes when it builds the
  // record, so any real delay between the two shifts the rendered age and
  // fails an exact-row assertion for a reason that has nothing to do with
  // what the test covers. Faking the timer queue too would stall the
  // handler's own awaits, so the fake is scoped to the clock.
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('formatAge', () => {
  it('scales the unit with the magnitude', () => {
    expect(formatAge(5_000)).toBe('5s');
    expect(formatAge(90_000)).toBe('1m');
    expect(formatAge(3 * 3600_000)).toBe('3h');
    expect(formatAge(50 * 3600_000)).toBe('2d');
  });

  it('clamps a record from the future to zero rather than showing a negative age', () => {
    expect(formatAge(-10_000)).toBe('0s');
  });
});

describe('qwen sessions ps', () => {
  it('prints a table of live sessions', async () => {
    listLiveSessions.mockResolvedValue([record()]);
    await run({ json: false });

    expect(stdout[0]).toMatch(/^NAME\s+PID\s+AGE\s+DIRECTORY$/);
    expect(stdout[1]).toContain('app-ab');
    expect(stdout[1]).toContain('4242');
    expect(stdout[1]).toContain('/w/app');
  });

  it('says so plainly when nothing else is running', async () => {
    listLiveSessions.mockResolvedValue([]);
    await run({ json: false });
    expect(stdout).toEqual(['No other Qwen Code sessions are running.']);
  });

  it('emits one JSON object per line with no header', async () => {
    listLiveSessions.mockResolvedValue([record(), record({ pid: 7 })]);
    await run({ json: true });

    expect(stdout).toHaveLength(2);
    expect(JSON.parse(stdout[0]).pid).toBe(4242);
    expect(JSON.parse(stdout[1]).pid).toBe(7);
  });

  it('prints nothing on stdout for an empty JSON listing', async () => {
    listLiveSessions.mockResolvedValue([]);
    await run({ json: true });
    expect(stdout).toEqual([]);
  });

  it('asks for the default listing, with no self-inclusion switch', async () => {
    listLiveSessions.mockResolvedValue([]);

    await run({ json: true });
    expect(listLiveSessions).toHaveBeenLastCalledWith();
  });

  it('exposes no flag that claims to include this process', () => {
    // `qwen sessions ps` runs and exits inside yargs' argument parsing, so
    // it never reaches `startInteractiveUI` and never registers itself.
    // A `--all` toggling `includeSelf` therefore had nothing to include:
    // both settings produced identical output. Pinned here so it cannot
    // come back without a registration to go with it.
    const options: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const yargsStub: any = {
      option(name: string, config: unknown) {
        options[name] = config;
        return yargsStub;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (psCommand.builder as any)(yargsStub);

    expect(Object.keys(options)).toEqual(['json']);
  });

  it('neutralizes control sequences coming from another process record', async () => {
    listLiveSessions.mockResolvedValue([
      record({ name: 'ev\x1b[31mil\r', cwd: '/w/a\nb' }),
    ]);
    await run({ json: false });

    const row = stdout[1];
    expect(row).not.toContain('\x1b');
    expect(row).not.toContain('\r');
    expect(row).not.toContain('\n');
  });

  it('truncates an over-long name instead of breaking the columns', async () => {
    listLiveSessions.mockResolvedValue([record({ name: 'x'.repeat(80) })]);
    await run({ json: false });
    expect(stdout[1]).toContain('...');
    expect(stdout[1]).toContain('4242');
  });

  it('renders a name that exactly fills the column without an ellipsis', async () => {
    // The band a budget of NAME_COL - 2 got wrong: a name this long fits
    // its cell, and ellipsizing it both claims a truncation that did not
    // happen and eats the hash suffix that distinguishes two sessions
    // started in the same directory.
    const name = 'a'.repeat(NAME_COL - 3) + '-7f';
    expect(name).toHaveLength(NAME_COL);
    listLiveSessions.mockResolvedValue([record({ name })]);
    await run({ json: false });

    expect(stdout[1]).toContain(name);
    expect(stdout[1]).not.toContain('...');
    // Still a column, not a collision: the cell keeps a separator from the
    // PID beside it even when the name uses every one of its columns.
    expect(stdout[1]).toContain(`${name} 4242`);
  });

  it('cuts a multi-width name on a character boundary, not a column one', async () => {
    // 15 full-width characters is 30 display columns against the NAME_COL
    // budget. Subtracting the three columns "..." costs leaves 19: the
    // ninth character ends at column 18, and a tenth would straddle the
    // limit, so the cut lands at nine characters. Asserting the cell
    // exactly is what pins the accumulation loop — "contains ..." survives
    // a loop that copies nothing at all.
    //
    // The sibling cells are derived from the exported widths rather than
    // spelled out: they have nothing to do with truncation, and hardcoding
    // their padding would fail this test for a column-width change it does
    // not test. The age is pinned by the frozen clock in `beforeEach`, not
    // by wall time — read from `Date.now()` inside the handler, a real
    // delay between the record's `startedAt` and that call would render
    // "2m" and fail here for a reason that is not truncation.
    listLiveSessions.mockResolvedValue([record({ name: '中'.repeat(15) })]);
    await run({ json: false });

    const cell = '中'.repeat(9) + '...';
    const pad = (text: string, width: number) =>
      text + ' '.repeat(width - text.length);
    expect(stdout[1]).toBe(
      [
        cell + ' '.repeat(NAME_COL - 21),
        pad('4242', PID_COL),
        pad('1m', AGE_COL),
        '/w/app',
      ].join(' '),
    );
  });

  it('reports a registry read failure on stderr and exits non-zero', async () => {
    listLiveSessions.mockRejectedValue(new Error('registry on fire'));
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await run({ json: false });

    expect(stderr).toEqual([
      'Error: failed to read the session registry: registry on fire',
    ]);
    expect(exit).toHaveBeenCalledWith(1);
    // Nothing is printed once the listing failed — not even the header.
    expect(stdout).toEqual([]);
  });
});
