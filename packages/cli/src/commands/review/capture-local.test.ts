/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `captureLocalDiff` is tested against a real git; this is the layer above it —
// output assembly, the stderr disclosures, the zero-diff branch, the control-
// character escaping. That is the I/O boundary where a regression hides behind a
// green library suite: the capture could go on working perfectly while the
// command that reports it stopped saying a file was skipped.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const captureMock = vi.hoisted(() => vi.fn());
vi.mock('./lib/local-diff.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  captureLocalDiff: captureMock,
}));

const { captureLocalCommand } = await import('./capture-local.js');

const DIFF = [
  'diff --git a/src/pay.ts b/src/pay.ts',
  '--- /dev/null',
  '+++ b/src/pay.ts',
  '@@ -0,0 +1,2 @@',
  '+export function pay() {}',
  '+',
  '',
].join('\n');

let dir: string;
let cwd: string;
let errs: string[];

function run(out: string, over: Record<string, unknown> = {}): void {
  (captureLocalCommand.handler as (a: unknown) => void)({
    out,
    target: 'local',
    untracked: true,
    ...over,
  });
}

/** What the capture would have returned; the git layer is tested elsewhere. */
function capture(over: Record<string, unknown> = {}) {
  captureMock.mockReturnValue({
    diff: Buffer.from(DIFF, 'utf8'),
    untracked: ['src/pay.ts'],
    skipped: [],
    unbornHead: false,
    ...over,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'capture-local-'));
  cwd = process.cwd();
  process.chdir(dir);
  errs = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errs.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  captureMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('capture-local (command boundary)', () => {
  it('writes the diff and a plan the review can read', () => {
    capture();
    run('plan.json');

    const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
    expect(plan.chunks.length).toBeGreaterThan(0);
    expect(plan.untrackedFiles).toEqual(['src/pay.ts']);
    expect(existsSync(plan.diffPathAbsolute)).toBe(true);
    expect(readFileSync(plan.diffPathAbsolute, 'utf8')).toBe(DIFF);
  });

  it('creates the output directory the caller chose', () => {
    // It created `.qwen/tmp` — its own — and then wrote to the caller's path,
    // which may be elsewhere. `--out reports/plan.json` answered with ENOENT.
    capture();
    run(join('reports', 'nested', 'plan.json'));

    expect(existsSync(join(dir, 'reports', 'nested', 'plan.json'))).toBe(true);
  });

  it('names every skipped file, with its reason, on stderr', () => {
    capture({
      untracked: ['src/pay.ts'],
      skipped: [
        { path: 'huge.csv', bytes: 2_000_000, reason: 'exceeds the cap' },
        { path: 'nested/', bytes: null, reason: 'is a directory' },
      ],
    });
    run('plan.json');

    const out = errs.join('');
    expect(out).toContain('huge.csv');
    expect(out).toContain('exceeds the cap');
    expect(out).toContain('nested/');
    expect(out).toContain('is a directory');
    // And the report carries them for the review to put under "Not reviewed".
    const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
    expect(plan.skippedFiles.map((s: { path: string }) => s.path)).toEqual([
      'huge.csv',
      'nested/',
    ]);
  });

  it('does not call an empty-but-skipping capture a clean tree', () => {
    // An oversized blob as the ONLY change: zero diff lines, and a skip list.
    // Reporting "the working tree is clean" here hands the review a green
    // verdict over work it explicitly could not read.
    captureMock.mockReturnValue({
      diff: Buffer.alloc(0),
      untracked: [],
      skipped: [{ path: 'huge.bin', bytes: 9e6, reason: 'exceeds the cap' }],
      unbornHead: false,
    });
    run('plan.json');

    const out = errs.join('');
    expect(out).toContain('SKIPPED');
    expect(out).toContain('not a clean tree');
    expect(out).not.toContain('the working tree is clean');
  });

  it('says the tree is clean when it genuinely is', () => {
    captureMock.mockReturnValue({
      diff: Buffer.alloc(0),
      untracked: [],
      skipped: [],
      unbornHead: false,
    });
    run('plan.json');

    expect(errs.join('')).toContain('the working tree is clean');
  });

  it('escapes a filename carrying terminal control characters', () => {
    // A filename is workspace-controlled, and git permits an ESC or a newline in
    // one. Printed raw it can forge a second warning line or drive the user's
    // terminal.
    capture({ untracked: ['evil[2Kfake.ts'], skipped: [] });
    run('plan.json');

    const out = errs.join('');
    expect(out).not.toContain('[2K');
    expect(out).toContain('\\u001b');
  });
});
