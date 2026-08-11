/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkAnchorsCommand } from './check-anchors.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import type { FilesPlan } from './lib/files-plan.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
}));

let dir: string;
let planPath: string;
let reportPath: string;
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  dir = mkdtempSync(join(tmpdir(), 'audit-check-anchors-'));
  writeFileSync(join(dir, 'unique.ts'), 'export const uniqueToken = 42;\n');
  const plan: FilesPlan = {
    kind: 'audit-plan',
    targetPathAbsolute: dir,
    effort: 'medium',
    roster: ['1a'],
    subjectFiles: [{ path: 'unique.ts', kind: 'source', lines: 1, chars: 0 }],
    testCorpus: [],
    uncoverable: [],
    excludedDirs: [],
    residue: [],
    subjectLines: 1,
    testLines: 0,
    estimate: null,
    eventModule: { detected: false, callSites: 0, files: 0 },
    deepReadQuota: 10,
    lowTier: null,
    fileGroups: null,
    agentBound: null,
    artifacts: { reportSlug: 'mod', fallbackRoot: '' },
  };
  planPath = join(dir, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan));
  reportPath = join(dir, 'report.md');
  vi.mocked(writeStdoutLine).mockClear();
});

afterEach(() => {
  process.exitCode = originalExitCode;
  rmSync(dir, { recursive: true, force: true });
});

const run = (argv: Record<string, unknown>) =>
  (checkAnchorsCommand.handler as (a: unknown) => void)({
    _: ['audit', 'check-anchors'],
    ...argv,
  });

describe('checkAnchorsCommand handler', () => {
  it('exits 0 when every anchor resolves', () => {
    writeFileSync(
      reportPath,
      [
        '### [Critical] ok',
        '- Location: unique.ts:1',
        '- Anchor: export const uniqueToken = 42;',
      ].join('\n'),
    );
    run({ plan: planPath, report: reportPath });
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 4 when any anchor needs handling', () => {
    writeFileSync(
      reportPath,
      [
        '### [Critical] missing',
        '- Location: unique.ts:1',
        '- Anchor: not in the file',
      ].join('\n'),
    );
    run({ plan: planPath, report: reportPath });
    expect(process.exitCode).toBe(4);
  });

  it('exits 4 for a caller cited with a relative path', () => {
    writeFileSync(
      reportPath,
      [
        '### [Critical] rel caller',
        '- Location: index.ts:1',
        '- Anchor: anything',
      ].join('\n'),
    );
    const callersPath = join(dir, 'callers.json');
    writeFileSync(callersPath, JSON.stringify(['index.ts']));
    // A relative caller must be refused at the read site — it would
    // otherwise resolve against the invocation cwd and bind arbitrarily.
    expect(() =>
      run({ plan: planPath, report: reportPath, callers: callersPath }),
    ).toThrow(/absolute path strings/);
  });

  it('surfaces a corrupt plan as a clean regenerate error', () => {
    const corrupt = join(dir, 'corrupt-plan.json');
    writeFileSync(corrupt, '{"subjectFiles": ');
    writeFileSync(reportPath, '### [Critical] x\n- Anchor: y\n');
    expect(() => run({ plan: corrupt, report: reportPath })).toThrow(
      /not valid JSON/,
    );
  });

  it('surfaces a stale non-plan JSON as a clean regenerate error', () => {
    const stale = join(dir, 'stale-plan.json');
    writeFileSync(stale, JSON.stringify({ hello: 'world' }));
    writeFileSync(reportPath, '### [Critical] x\n- Anchor: y\n');
    expect(() => run({ plan: stale, report: reportPath })).toThrow(
      /not a plan written by/,
    );
  });

  it('surfaces a missing report draft with its path', () => {
    expect(() => run({ plan: planPath, report: join(dir, 'nope.md') })).toThrow(
      /cannot read/,
    );
  });
});
