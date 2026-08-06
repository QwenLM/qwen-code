/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseReportFindings, resolveAnchors } from './anchors.js';
import { buildFilesPlan, collectAuditFiles } from './files-plan.js';

let dir: string;

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
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const report = `## Critical

### [Critical] first finding
- Location: unique.ts:1
- Anchor: export const uniqueToken = 42;
- Issue: x
- Failure scenario: y

### [Suggestion] second finding
- Location: dup.ts:2
- Anchor: const y = x;
- Issue: a
- Failure scenario: b
`;

describe('parseReportFindings', () => {
  it('parses finding blocks with location and anchor', () => {
    const findings = parseReportFindings(report);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      title: 'first finding',
      severity: 'Critical',
      location: 'unique.ts',
      anchor: 'export const uniqueToken = 42;',
    });
    expect(findings[1].location).toBe('dup.ts');
  });

  it('collects a multi-line anchor up to the next field', () => {
    const multi = `### [Critical] multi
- Location: dup.ts:1
- Anchor: const x = 1;
const y = x;
- Issue: a
`;
    const findings = parseReportFindings(multi);
    expect(findings[0].anchor).toBe('const x = 1;\nconst y = x;');
  });

  it('skips blocks without a resolvable location or anchor', () => {
    expect(
      parseReportFindings('### [Critical] no fields\n- Issue: x\n'),
    ).toEqual([]);
  });
});

describe('resolveAnchors', () => {
  it('resolves a unique anchor, refuses a missing one, flags an ambiguous one', () => {
    const plan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const results = resolveAnchors(
      [
        {
          title: 'a',
          severity: 'Critical',
          location: 'unique.ts',
          anchor: 'export const uniqueToken = 42;',
        },
        {
          title: 'b',
          severity: 'Critical',
          location: 'unique.ts',
          anchor: 'not in the file',
        },
        {
          title: 'c',
          severity: 'Suggestion',
          location: 'dup.ts',
          anchor: '= x;',
        },
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

  it('refuses anchors citing files outside the audited set as out-of-scope', () => {
    const plan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const results = resolveAnchors(
      [
        {
          title: 'd',
          severity: 'Critical',
          location: '../elsewhere.ts',
          anchor: 'anything',
        },
      ],
      plan,
    );
    expect(results[0].verdict).toBe('out-of-scope');
  });

  it('resolves against registered deep-read callers outside the path', () => {
    const caller = join(dir, '..', `caller-${Date.now()}.ts`);
    writeFileSync(caller, 'callerOnlyToken();\n');
    try {
      const plan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
      const results = resolveAnchors(
        [
          {
            title: 'e',
            severity: 'Critical',
            location: caller,
            anchor: 'callerOnlyToken();',
          },
        ],
        plan,
        [caller],
      );
      expect(results[0].verdict).toBe('resolved');
    } finally {
      rmSync(caller, { force: true });
    }
  });
});
