/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AUDIT_ANCHOR_MAX_LINES,
  checkReportMarkers,
  ManifestError,
  parseFindingsManifest,
  resolveAnchors,
  type AuditFinding,
} from './anchors.js';
import { buildFilesPlan, collectAuditFiles } from './files-plan.js';
import type { FilesPlan } from './files-plan.js';

let dir: string;
let plan: FilesPlan;

beforeEach(() => {
  dir = join(
    tmpdir(),
    `audit-anchors-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'unique.ts'), 'export const uniqueToken = 42;\n');
  writeFileSync(
    join(dir, 'dup.ts'),
    'const x = 1;\nconst y = x;\nconst z = x;\n',
  );
  plan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function finding(over: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id: 'f1',
    title: 'a finding',
    severity: 'Critical',
    locations: ['unique.ts'],
    anchor: 'export const uniqueToken = 42;',
    ...over,
  };
}

function manifestJson(findings: AuditFinding[]): string {
  return JSON.stringify({ version: 1, findings });
}

describe('parseFindingsManifest', () => {
  it('parses a well-formed manifest verbatim', () => {
    const parsed = parseFindingsManifest(
      manifestJson([
        finding(),
        finding({
          id: 'f2',
          severity: 'Suggestion',
          locations: ['dup.ts', 'unique.ts'],
          anchor: 'const y = x;\nconst z = x;',
        }),
      ]),
    );
    expect(parsed).toHaveLength(2);
    // The anchor is not peeled, split, dedented, or otherwise interpreted:
    // whatever the author wrote is what gets matched against the file.
    expect(parsed[1].anchor).toBe('const y = x;\nconst z = x;');
    expect(parsed[1].locations).toEqual(['dup.ts', 'unique.ts']);
  });

  it('refuses a manifest that is not JSON, not an object, or unversioned', () => {
    expect(() => parseFindingsManifest('not json')).toThrow(ManifestError);
    expect(() => parseFindingsManifest('[]')).toThrow(ManifestError);
    expect(() =>
      parseFindingsManifest(JSON.stringify({ findings: [] })),
    ).toThrow(/version/);
    expect(() => parseFindingsManifest(JSON.stringify({ version: 1 }))).toThrow(
      /findings/,
    );
  });

  it('accepts an empty findings list — a clean audit is a valid manifest', () => {
    // Exit 0 must be structurally REACHABLE: a gate no honest report can
    // clear teaches its operator to ignore the exit code.
    expect(parseFindingsManifest(manifestJson([]))).toEqual([]);
  });

  it.each([
    ['a missing id', { id: undefined }],
    ['an id outside the marker space', { id: 'has space' }],
    ['a missing title', { title: '' }],
    ['an unknown severity', { severity: 'Blocker' }],
    ['empty locations', { locations: [] }],
    ['a non-string location', { locations: [42] }],
    ['a missing anchor', { anchor: '' }],
  ])('refuses %s', (_name, override) => {
    const entry = { ...finding(), ...override };
    expect(() =>
      parseFindingsManifest(JSON.stringify({ version: 1, findings: [entry] })),
    ).toThrow(ManifestError);
  });

  it('refuses duplicate ids — the marker check could not tell them apart', () => {
    expect(() =>
      parseFindingsManifest(manifestJson([finding(), finding()])),
    ).toThrow(/duplicated/);
  });
});

describe('checkReportMarkers', () => {
  const findings = [finding(), finding({ id: 'f2' })];

  it('accepts a report carrying exactly one marker per finding', () => {
    const report = [
      '# Audit report',
      '<!-- audit-finding: f1 -->',
      '### [Critical] a',
      '<!-- audit-finding: f2 -->',
      '### [Critical] b',
    ].join('\n');
    expect(checkReportMarkers(report, findings)).toEqual([]);
  });

  it('reports a manifest finding with no block in the report', () => {
    const report = '<!-- audit-finding: f1 -->\n### [Critical] a\n';
    expect(checkReportMarkers(report, findings)).toEqual([
      expect.stringContaining('"f2" is in the manifest'),
    ]);
  });

  it('reports a shipped block the manifest does not list', () => {
    const report = [
      '<!-- audit-finding: f1 -->',
      '<!-- audit-finding: f2 -->',
      '<!-- audit-finding: f3 -->',
    ].join('\n');
    // f3's snippet was never resolved against anything — exactly the
    // fail-open the gate exists to refuse.
    expect(checkReportMarkers(report, findings)).toEqual([
      expect.stringContaining('marker for "f3"'),
    ]);
  });

  it('reports a duplicated marker', () => {
    const report = [
      '<!-- audit-finding: f1 -->',
      '<!-- audit-finding: f1 -->',
      '<!-- audit-finding: f2 -->',
    ].join('\n');
    expect(checkReportMarkers(report, findings)).toEqual([
      expect.stringContaining('2 markers for finding "f1"'),
    ]);
  });

  it('is indifferent to rendering, section layout, and output language', () => {
    // The shapes that broke the previous markdown parser — bold headers,
    // fenced blocks, a rejected-findings appendix, non-English headings —
    // are all just prose to the marker check.
    const report = [
      '# 审计报告',
      '## 严重',
      '<!-- audit-finding: f1 -->',
      '**[严重] 第一个发现**',
      '```',
      '### [Critical] a fenced quote of some other report',
      '```',
      '<!-- audit-finding: f2 -->',
      '#### [严重] 第二个发现',
      '## 附录：已驳回的发现',
      '### [Critical] a rejected finding, shipping nowhere',
      '- Location: unique.ts:1',
    ].join('\n');
    expect(checkReportMarkers(report, findings)).toEqual([]);
  });

  it('accepts a schema-legal hyphenated id in the report marker', () => {
    // Hyphens are legal in the id grammar; the marker capture is built
    // from the same grammar, so a hyphenated report can satisfy the
    // marker check instead of failing it forever.
    const hyphenFindings = [finding({ id: 'auth-bypass' })];
    const report = [
      '<!-- audit-finding: auth-bypass -->',
      '### [Critical] a',
    ].join('\n');
    expect(checkReportMarkers(report, hyphenFindings)).toEqual([]);
  });
});

describe('resolveAnchors', () => {
  it('resolves a unique anchor, refuses a missing one, flags an ambiguous one', () => {
    const results = resolveAnchors(
      [
        finding(),
        finding({ id: 'f2', anchor: 'not in the file' }),
        finding({
          id: 'f3',
          severity: 'Suggestion',
          locations: ['dup.ts'],
          anchor: '= x;',
        }),
      ],
      plan,
    );
    expect(results.map((r) => r.verdict)).toEqual([
      'resolved',
      'unresolved',
      'ambiguous',
    ]);
    expect(results[2].matchCount).toBe(2); // "= x;" in lines 2 and 3
  });

  it('resolves anchors inside the test corpus', () => {
    writeFileSync(join(dir, 'unique.test.ts'), 'export const tested = 1;\n');
    const corpusPlan = buildFilesPlan(
      dir,
      dir,
      'medium',
      collectAuditFiles(dir),
    );
    const results = resolveAnchors(
      [
        finding({
          locations: ['unique.test.ts'],
          anchor: 'export const tested = 1;',
        }),
      ],
      corpusPlan,
    );
    expect(results[0].verdict).toBe('resolved');
  });

  it('refuses anchors citing files outside the audited set as out-of-scope', () => {
    const results = resolveAnchors(
      [finding({ locations: ['../elsewhere.ts'], anchor: 'anything' })],
      plan,
    );
    expect(results[0].verdict).toBe('out-of-scope');
  });

  it('refuses a pair whose second location is out of scope', () => {
    const results = resolveAnchors(
      [
        finding({
          locations: ['dup.ts', '../elsewhere.ts'],
          anchor: 'const x = 1;',
        }),
      ],
      plan,
    );
    expect(results[0].verdict).toBe('out-of-scope');
  });

  it('resolves a multi-line anchor against a CRLF file', () => {
    writeFileSync(join(dir, 'crlf.ts'), 'line one\r\nline two\r\n');
    const crlfPlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const results = resolveAnchors(
      [finding({ locations: ['crlf.ts'], anchor: 'line one\nline two' })],
      crlfPlan,
    );
    expect(results[0].verdict).toBe('resolved');
  });

  it('resolves a multi-line anchor against a file carrying a BOM', () => {
    writeFileSync(join(dir, 'bom.ts'), '\uFEFFfirst line\nsecond line\n');
    const bomPlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const results = resolveAnchors(
      [finding({ locations: ['bom.ts'], anchor: 'first line\nsecond line' })],
      bomPlan,
    );
    expect(results[0].verdict).toBe('resolved');
  });

  it('resolves against registered deep-read callers outside the path', () => {
    const caller = join(dir, '..', `caller-${Date.now()}.ts`);
    writeFileSync(caller, 'callerOnlyToken();\n');
    try {
      const results = resolveAnchors(
        [finding({ locations: [caller], anchor: 'callerOnlyToken();' })],
        plan,
        [caller],
      );
      expect(results[0].verdict).toBe('resolved');
    } finally {
      rmSync(caller, { force: true });
    }
  });

  it('resolves a snippet quoted verbatim from indented code', () => {
    writeFileSync(
      join(dir, 'indented.ts'),
      'function f() {\n  const a = 1;\n  const b = a;\n  return b;\n}\n',
    );
    const indentedPlan = buildFilesPlan(
      dir,
      dir,
      'medium',
      collectAuditFiles(dir),
    );
    const results = resolveAnchors(
      [
        finding({
          locations: ['indented.ts'],
          anchor: '  const a = 1;\n  const b = a;',
        }),
      ],
      indentedPlan,
    );
    expect(results[0].verdict).toBe('resolved');
  });

  it('resolves a snippet quoted with the block indent removed', () => {
    writeFileSync(
      join(dir, 'indented2.ts'),
      'function f() {\n  const a = 1;\n  const b = a;\n  return b;\n}\n',
    );
    const indentedPlan = buildFilesPlan(
      dir,
      dir,
      'medium',
      collectAuditFiles(dir),
    );
    // Quoting a function body without its leading indent is the common
    // shape; matching must stay indent-tolerant or it is unanchorable.
    const results = resolveAnchors(
      [
        finding({
          locations: ['indented2.ts'],
          anchor: 'const a = 1;\nconst b = a;',
        }),
      ],
      indentedPlan,
    );
    expect(results[0].verdict).toBe('resolved');
  });

  it('matches a tab-indented file from a tab-indented quote', () => {
    writeFileSync(join(dir, 'tabs.ts'), 'function g() {\n\tconst t = 1;\n}\n');
    const tabPlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const results = resolveAnchors(
      [finding({ locations: ['tabs.ts'], anchor: '\tconst t = 1;' })],
      tabPlan,
    );
    expect(results[0].verdict).toBe('resolved');
  });

  it('refuses a single-line anchor that only fuses into a longer token', () => {
    writeFileSync(
      join(dir, 'fuse.ts'),
      'export const uniqueTokenLonger = 1;\n',
    );
    const fusePlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    // 'uniqueToken' occurs inside 'uniqueTokenLonger'; certifying it would
    // bind the finding to a line that does not exist.
    const results = resolveAnchors(
      [finding({ locations: ['fuse.ts'], anchor: 'const uniqueToken' })],
      fusePlan,
    );
    expect(results[0].verdict).toBe('unresolved');
  });

  it('grades an over-long anchor unresolved instead of scanning it', () => {
    const results = resolveAnchors(
      [
        finding({
          anchor: Array.from(
            { length: AUDIT_ANCHOR_MAX_LINES + 1 },
            (_, i) => `line ${i}`,
          ).join('\n'),
        }),
      ],
      plan,
    );
    expect(results[0].verdict).toBe('unresolved');
  });

  it('grades a citation whose file cannot be read unresolved', () => {
    const results = resolveAnchors(
      [
        finding({
          locations: ['unique.ts'],
          anchor: 'export const uniqueToken = 42;',
        }),
      ],
      { ...plan, targetPathAbsolute: join(dir, 'nowhere') },
    );
    expect(results[0].verdict).toBe('unresolved');
  });

  it('resolves an anchor quoted with a trailing newline like the bare quote', () => {
    writeFileSync(join(dir, 'trail.ts'), 'foo();\n}\n');
    const trailPlan = buildFilesPlan(
      dir,
      dir,
      'medium',
      collectAuditFiles(dir),
    );
    // A code-block copy routinely carries the trailing newline; the
    // verdict must not depend on a line outside the quoted block.
    const bare = resolveAnchors(
      [finding({ locations: ['trail.ts'], anchor: 'foo();' })],
      trailPlan,
    );
    const trailing = resolveAnchors(
      [finding({ locations: ['trail.ts'], anchor: 'foo();\n' })],
      trailPlan,
    );
    expect(bare[0]).toMatchObject({ verdict: 'resolved', matchCount: 1 });
    expect(trailing[0]).toMatchObject({ verdict: 'resolved', matchCount: 1 });
  });

  it('does not certify a multi-line quote whose first line exists only mid-line', () => {
    writeFileSync(
      join(dir, 'midline.ts'),
      '// TODO: check if (user.isAdmin) {\n return secret;\n',
    );
    const midPlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    // The first quoted line is a suffix of a longer file line; certifying
    // it would ship a snippet whose first line does not exist as a line.
    const results = resolveAnchors(
      [
        finding({
          locations: ['midline.ts'],
          anchor: 'if (user.isAdmin) {\n return secret;',
        }),
      ],
      midPlan,
    );
    expect(results[0].verdict).toBe('unresolved');
  });

  it('does not fuse a URL fragment or glob into a trailing comment', () => {
    writeFileSync(join(dir, 'frag.ts'), 'const home = "a.html#top";\n');
    writeFileSync(join(dir, 'glob.sh'), 'rm -rf /build/*;\n');
    const fusePlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const results = resolveAnchors(
      [
        finding({ locations: ['frag.ts'], anchor: 'const home = "a.html' }),
        finding({ id: 'f2', locations: ['glob.sh'], anchor: 'rm -rf /build' }),
      ],
      fusePlan,
    );
    // '#top' and '/*' sit inside a token here, not after it: accepting
    // them as comment introducers would certify a line that does not exist.
    expect(results[0].verdict).toBe('unresolved');
    expect(results[1].verdict).toBe('unresolved');
  });

  it('still resolves a snippet ending before a spaced trailing comment', () => {
    writeFileSync(join(dir, 'cmt.ts'), 'const x = 1; // TODO\n');
    const cmtPlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const results = resolveAnchors(
      [finding({ locations: ['cmt.ts'], anchor: 'const x = 1;' })],
      cmtPlan,
    );
    expect(results[0].verdict).toBe('resolved');
  });
});
