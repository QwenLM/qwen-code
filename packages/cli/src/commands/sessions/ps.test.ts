/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import stringWidth from 'string-width';
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
    pidNs: null,
    sessionId: 'sess-1',
    cwd: '/w/app',
    name: 'app-ab',
    startedAt: Date.now() - 90_000,
    qwenVersion: '1.0.0',
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
});

afterEach(() => {
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

  it('changes unit exactly at the boundary, never one step late', () => {
    expect(formatAge(59_999)).toBe('59s');
    expect(formatAge(60_000)).toBe('1m');
    expect(formatAge(3_599_000)).toBe('59m');
    expect(formatAge(3_600_000)).toBe('1h');
    expect(formatAge(24 * 3_600_000 - 1_000)).toBe('23h');
    expect(formatAge(24 * 3_600_000)).toBe('1d');
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

  it('puts every column at its declared offset', async () => {
    // `toContain` cannot tell a laid-out table from four values joined by
    // one space, and it cannot see the age at all. Pin the whole row.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      listLiveSessions.mockResolvedValue([
        record({ startedAt: Date.now() - 5_000 }),
      ]);
      await run({ json: false });
    } finally {
      vi.useRealTimers();
    }

    expect(stdout[0]).toBe(
      'NAME'.padEnd(NAME_COL) +
        'PID'.padEnd(PID_COL) +
        'AGE'.padEnd(AGE_COL) +
        'DIRECTORY',
    );
    expect(stdout[1]).toBe(
      'app-ab'.padEnd(NAME_COL) +
        '4242'.padEnd(PID_COL) +
        '5s'.padEnd(AGE_COL) +
        '/w/app',
    );
    expect([NAME_COL, PID_COL, AGE_COL]).toEqual([22, 9, 10]);
  });

  it('says so plainly when nothing else is running', async () => {
    listLiveSessions.mockResolvedValue([]);
    await run({ json: false });
    expect(stdout).toEqual([
      'No other interactive Qwen Code sessions are running.',
    ]);
  });

  it('emits one JSON object per line with no header', async () => {
    listLiveSessions.mockResolvedValue([record(), record({ pid: 7 })]);
    await run({ json: true });

    expect(stdout).toHaveLength(2);
    expect(JSON.parse(stdout[0]).pid).toBe(4242);
    expect(JSON.parse(stdout[1]).pid).toBe(7);
  });

  it('emits each record as one whole line of JSON Lines', async () => {
    // JSON Lines is line-delimited by definition: a pretty-printed record
    // still round-trips through JSON.parse but breaks every consumer that
    // reads it a line at a time, and drops no field on the way.
    const rec = record();
    // Snapshotted before the run: the mock hands the handler the object
    // itself, so computing the expectation afterwards would observe the
    // very object the handler (mutatingly) emitted and could never catch
    // an in-place field deletion.
    const expected = JSON.stringify(rec);
    listLiveSessions.mockResolvedValue([rec]);
    await run({ json: true });

    expect(stdout).toEqual([expected]);
    expect(stdout[0]).not.toContain('\n');
  });

  it('strips the inbox auth token from the JSON output', async () => {
    listLiveSessions.mockResolvedValue([
      record({ ipcPath: '/tmp/a.sock', ipcToken: 'secret-token' }),
    ]);
    await run({ json: true });

    const emitted = JSON.parse(stdout[0]);
    expect(emitted.ipcPath).toBe('/tmp/a.sock');
    expect(emitted).not.toHaveProperty('ipcToken');
    expect(stdout[0]).not.toContain('secret-token');
  });

  it('prints nothing on stdout for an empty JSON listing', async () => {
    listLiveSessions.mockResolvedValue([]);
    await run({ json: true });
    expect(stdout).toEqual([]);
  });

  it('neutralizes control sequences coming from another process record', async () => {
    listLiveSessions.mockResolvedValue([
      record({ name: 'ev\x1b[31mil\r', cwd: '/w/a\nb\tc' }),
    ]);
    await run({ json: false });

    const row = stdout[1];
    expect(row).not.toContain('\x1b');
    expect(row).not.toContain('\r');
    expect(row).not.toContain('\n');
    // sanitizeTerminalText deliberately preserves TAB for multi-line
    // render sites; the one-line table cell drops it on top — a literal
    // TAB in a cwd (legal in POSIX filenames) would otherwise expand to
    // the next tab stop and misalign every column after AGE.
    expect(row).not.toContain('\t');
  });

  it('strips bidi overrides that would reorder the rendered row', async () => {
    listLiveSessions.mockResolvedValue([
      record({ name: 'a\u202Eb', cwd: '/w/\u202Dsafe\u2069' }),
    ]);
    await run({ json: false });

    expect(stdout[1]).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    expect(stdout[1]).toContain('/w/safe');
  });

  it('emits --json values raw, leaving terminal sanitization to the consumer', async () => {
    // The contract the docs state: JSON output is data, not display.
    // Bidi overrides that the table path strips must round-trip here —
    // sanitizing them would rewrite the recorded path for every tooling
    // consumer and diverge from the sibling `sessions list --json`.
    listLiveSessions.mockResolvedValue([record({ cwd: '/w/\u202Ereorder' })]);
    await run({ json: true });

    expect(JSON.parse(stdout[0]).cwd).toBe('/w/\u202Ereorder');
  });

  it('truncates an over-long name instead of breaking the columns', async () => {
    listLiveSessions.mockResolvedValue([record({ name: 'x'.repeat(80) })]);
    await run({ json: false });
    expect(stdout[1]).toContain('\u2026');
    expect(stdout[1]).toContain('4242');
  });

  it('truncates the name two cells short of its column, leaving a gutter', async () => {
    // The gutter is what keeps a maximally long name from touching the PID
    // beside it; truncating to the full column width would remove it.
    listLiveSessions.mockResolvedValue([record({ name: 'x'.repeat(80) })]);
    await run({ json: false });

    expect(stdout[1].slice(0, NAME_COL)).toBe(`${'x'.repeat(19)}\u2026  `);
  });

  it('declares --json as a boolean that is off by default', async () => {
    const options: Record<string, unknown> = {};
    const yargs = {
      option: vi.fn((key: string, config: unknown) => {
        options[key] = config;
        return yargs;
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (psCommand.builder as any)(yargs);

    expect(psCommand.command).toBe('ps');
    expect(options['json']).toMatchObject({ type: 'boolean', default: false });
  });

  it('keeps a CJK name inside its column instead of shifting the row', async () => {
    listLiveSessions.mockResolvedValue([record({ name: '项目'.repeat(20) })]);
    await run({ json: false });

    // Padding is measured in terminal cells, not code units: a 2-cell CJK
    // character must not push the PID column one cell right per character.
    const row = stdout[1];
    expect(stringWidth(row.slice(0, row.indexOf('4242')))).toBe(22);
  });
});
