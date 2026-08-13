/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { driftCheckCommand, snapshotCommand } from './snapshot.js';
import { buildFilesPlan, collectAuditFiles } from './lib/files-plan.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
}));

describe('snapshotCommand handler', () => {
  let dir: string;
  let planPath: string;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    dir = mkdtempSync(join(tmpdir(), 'audit-snapshot-'));
    writeFileSync(join(dir, 'a.ts'), 'const a = 1;\n');
    const plan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    planPath = join(dir, 'plan.json');
    writeFileSync(planPath, JSON.stringify(plan));
    vi.mocked(writeStdoutLine).mockClear();
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (argv: Record<string, unknown>) =>
    (snapshotCommand.handler as (a: unknown) => void)({
      _: ['audit', 'snapshot'],
      ...argv,
    });

  const printedReport = () =>
    JSON.parse(vi.mocked(writeStdoutLine).mock.calls[0][0]) as Record<
      string,
      unknown
    >;

  it('prints a fresh-capture report and saves it to --out', () => {
    const out = join(dir, 'audit-x.sidecar');
    run({ plan: planPath, out });
    expect(process.exitCode).toBeUndefined();
    const report = printedReport();
    expect(report['capturedAt']).toBeTruthy();
    expect(report['noVcs']).toBe(true);
    expect(report['vcsProbeFailed']).toBe(false);
    expect(report['captureDegraded']).toEqual([]);
    expect(report['recaptured']).toBeNull();
    expect(report['headSha']).toBeNull();
    expect(report['headUnborn']).toBe(false);
    expect(report['hashedFiles']).toBe(1);
    expect(report['callers']).toBe(0);
    // The saved sidecar is what the report describes.
    const saved = JSON.parse(readFileSync(join(out, 'sidecar.json'), 'utf8'));
    expect(saved.meta.capturedAt).toBe(report['capturedAt']);
  });

  it('extends the caller set via --callers', () => {
    const out = join(dir, 'audit-x.sidecar');
    run({ plan: planPath, out });
    const caller = join(dir, 'caller.ts');
    writeFileSync(caller, 'call();\n');
    const callersFile = join(dir, 'callers.json');
    writeFileSync(callersFile, JSON.stringify([caller]));
    vi.mocked(writeStdoutLine).mockClear();
    run({ plan: planPath, out, callers: callersFile });
    const report = printedReport();
    expect(report['callers']).toBe(1);
    // The extension preserves the run-start baseline.
    expect(report['recaptured']).toBeNull();
  });

  it('drift-check reports content drift against the saved sidecar', () => {
    const out = join(dir, 'audit-x.sidecar');
    run({ plan: planPath, out });
    // A fresh capture is self-aligned.
    vi.mocked(writeStdoutLine).mockClear();
    (driftCheckCommand.handler as (a: unknown) => void)({
      _: ['audit', 'drift-check'],
      plan: planPath,
      sidecar: out,
    });
    const clean = JSON.parse(
      vi.mocked(writeStdoutLine).mock.calls[0][0],
    ) as Record<string, unknown>;
    expect(clean['driftedFiles']).toEqual([]);
    expect(clean['deletedFiles']).toEqual([]);
    expect(clean['headMoved']).toBe(false);
    // Content drift surfaces at the next checkpoint.
    writeFileSync(join(dir, 'a.ts'), 'const a = 2;\n');
    vi.mocked(writeStdoutLine).mockClear();
    (driftCheckCommand.handler as (a: unknown) => void)({
      _: ['audit', 'drift-check'],
      plan: planPath,
      sidecar: out,
    });
    const drifted = JSON.parse(
      vi.mocked(writeStdoutLine).mock.calls[0][0],
    ) as Record<string, unknown>;
    expect(drifted['driftedFiles']).toEqual(['a.ts']);
  });

  it('rejects a callers file with a relative path at the read site', () => {
    const out = join(dir, 'audit-x.sidecar');
    const callersFile = join(dir, 'callers.json');
    writeFileSync(callersFile, JSON.stringify(['relative/caller.ts']));
    expect(() => run({ plan: planPath, out, callers: callersFile })).toThrow(
      /absolute path strings/,
    );
  });
});
