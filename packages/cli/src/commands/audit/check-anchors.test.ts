/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkAnchorsCommand } from './check-anchors.js';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import type { FilesPlan } from './lib/files-plan.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
}));

let dir: string;
let planPath: string;
let reportPath: string;
let findingsPath: string;
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
    lowTier: null,
    fileGroups: null,
    agentBound: null,
    artifacts: { reportSlug: 'mod' },
  };
  planPath = join(dir, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan));
  reportPath = join(dir, 'report.md');
  findingsPath = join(dir, 'findings.json');
  vi.mocked(writeStdoutLine).mockClear();
  vi.mocked(writeStderrLine).mockClear();
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

/** Write the two write-time artifacts: the manifest the gate resolves and
 *  the report whose markers must match it. */
function writeArtifacts(
  findings: Array<Record<string, unknown>>,
  reportBody?: string,
): void {
  writeFileSync(
    findingsPath,
    JSON.stringify({ version: 1, findings }, null, 2),
  );
  writeFileSync(
    reportPath,
    reportBody ??
      findings
        .map(
          (f) =>
            `<!-- audit-finding: ${f['id']} -->\n### [${f['severity']}] ${f['title']}\n`,
        )
        .join('\n'),
  );
}

const okFinding = {
  id: 'f1',
  title: 'ok',
  severity: 'Critical',
  locations: ['unique.ts'],
  anchor: 'export const uniqueToken = 42;',
};

function payload(): Record<string, unknown> {
  return JSON.parse(vi.mocked(writeStdoutLine).mock.calls[0][0]) as Record<
    string,
    unknown
  >;
}

describe('checkAnchorsCommand handler', () => {
  it('exits 0 when every anchor resolves and the markers agree', () => {
    writeArtifacts([okFinding]);
    run({ plan: planPath, findings: findingsPath, report: reportPath });
    expect(process.exitCode).toBeUndefined();
    // The exit-0 payload is the skill's verdict input: assert the shape
    // it parses, not just the exit code.
    const out = payload();
    expect(out['markerProblems']).toEqual([]);
    const results = out['results'] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]['verdict']).toBe('resolved');
    expect(results[0]['matchCount']).toBe(1);
    expect(results[0]['finding']).toMatchObject({
      id: 'f1',
      title: 'ok',
      severity: 'Critical',
      locations: ['unique.ts'],
    });
  });

  it('exits 0 for an empty manifest — a clean audit clears the gate', () => {
    // Exit 0 has to be reachable, or the code teaches its operator nothing.
    writeArtifacts([], '# Audit report\n\nNo findings.\n');
    run({ plan: planPath, findings: findingsPath, report: reportPath });
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 4 when any anchor needs handling', () => {
    writeArtifacts([{ ...okFinding, anchor: 'not in the file' }]);
    run({ plan: planPath, findings: findingsPath, report: reportPath });
    expect(process.exitCode).toBe(4);
    const results = payload()['results'] as Array<Record<string, unknown>>;
    expect(results[0]['verdict']).toBe('unresolved');
    expect(results[0]['matchCount']).toBe(0);
  });

  it('exits 4 when the report ships a finding the manifest never resolved', () => {
    // The fail-open this gate exists to close: a block reaching the report
    // without a manifest entry was never checked against any file.
    writeArtifacts(
      [okFinding],
      [
        '<!-- audit-finding: f1 -->',
        '### [Critical] ok',
        '<!-- audit-finding: f2 -->',
        '### [Critical] snuck in',
      ].join('\n'),
    );
    run({ plan: planPath, findings: findingsPath, report: reportPath });
    expect(process.exitCode).toBe(4);
    expect(payload()['markerProblems']).toEqual([
      expect.stringContaining('"f2"'),
    ]);
  });

  it('exits 4 with a named reason for a manifest that is not a manifest', () => {
    // Not "some findings need handling" — nothing could be resolved at all.
    // It must still land on the handled exit code, not a raw stack.
    writeFileSync(findingsPath, '{"version": 1, "findings": [{"id": "f1"}]}');
    writeFileSync(reportPath, '<!-- audit-finding: f1 -->\n');
    run({ plan: planPath, findings: findingsPath, report: reportPath });
    expect(process.exitCode).toBe(4);
    expect(vi.mocked(writeStderrLine).mock.calls[0][0]).toMatch(
      /findings\[0\]\./,
    );
  });

  it('throws for a callers file containing a relative path', () => {
    writeArtifacts([okFinding]);
    const callersPath = join(dir, 'callers.json');
    writeFileSync(callersPath, JSON.stringify(['index.ts']));
    // A relative caller must be refused at the read site — it would
    // otherwise resolve against the invocation cwd and bind arbitrarily.
    expect(() =>
      run({
        plan: planPath,
        findings: findingsPath,
        report: reportPath,
        callers: callersPath,
      }),
    ).toThrow(/absolute path strings/);
  });

  it('surfaces a plan with a relative targetPathAbsolute as stale', () => {
    // read-json's absolute guard is load-bearing: a relative root would
    // resolve anchors against the invocation cwd and bind arbitrarily.
    const relPlan = join(dir, 'rel-plan.json');
    const parsed = JSON.parse(readFileSync(planPath, 'utf8')) as Record<
      string,
      unknown
    >;
    parsed['targetPathAbsolute'] = 'relative/mod';
    writeFileSync(relPlan, JSON.stringify(parsed));
    writeArtifacts([okFinding]);
    expect(() =>
      run({ plan: relPlan, findings: findingsPath, report: reportPath }),
    ).toThrow(/not a plan written by/);
  });

  it('surfaces a plan root carrying .. as stale', () => {
    // Absolute is not enough: the root is the base every element path joins
    // against, so a '..' in it re-binds every read outside the audited tree.
    const escapePlan = join(dir, 'escape-plan.json');
    const parsed = JSON.parse(readFileSync(planPath, 'utf8')) as Record<
      string,
      unknown
    >;
    // String-built, not join()ed: join collapses the '..' itself.
    parsed['targetPathAbsolute'] = `${dir}/sub/..`;
    writeFileSync(escapePlan, JSON.stringify(parsed));
    writeArtifacts([okFinding]);
    expect(() =>
      run({ plan: escapePlan, findings: findingsPath, report: reportPath }),
    ).toThrow(/not a plan written by/);
  });

  it('surfaces a corrupt plan as a clean regenerate error', () => {
    const corrupt = join(dir, 'corrupt-plan.json');
    writeFileSync(corrupt, '{"subjectFiles": ');
    writeArtifacts([okFinding]);
    expect(() =>
      run({ plan: corrupt, findings: findingsPath, report: reportPath }),
    ).toThrow(/not valid JSON/);
  });

  it('surfaces a stale non-plan JSON as a clean regenerate error', () => {
    const stale = join(dir, 'stale-plan.json');
    writeFileSync(stale, JSON.stringify({ hello: 'world' }));
    writeArtifacts([okFinding]);
    expect(() =>
      run({ plan: stale, findings: findingsPath, report: reportPath }),
    ).toThrow(/not a plan written by/);
  });

  it('surfaces a missing report draft with its path', () => {
    // The path in the message is the operator's handle for fixing it;
    // a bare "cannot read" without the name sends the operator guessing.
    writeArtifacts([okFinding]);
    expect(() =>
      run({
        plan: planPath,
        findings: findingsPath,
        report: join(dir, 'nope.md'),
      }),
    ).toThrow(
      new RegExp(
        `cannot read .*${join(dir, 'nope.md').replace(/[\\.]/g, '\\$&')}`,
      ),
    );
  });
});
