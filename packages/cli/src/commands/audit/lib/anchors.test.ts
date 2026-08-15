/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AUDIT_ANCHOR_MAX_LINES,
  parseReportFindings,
  resolveAnchors,
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
      locations: ['unique.ts'],
      anchor: 'export const uniqueToken = 42;',
    });
    expect(findings[1]).toMatchObject({
      severity: 'Suggestion',
      locations: ['dup.ts'],
    });
  });

  it('collects a multi-line anchor up to the next field', () => {
    const multi = `### [Critical] multi
- Location: dup.ts:1
- Anchor: const x = 1;
const y = x;
- Issue: a
- Failure scenario: b
`;
    const findings = parseReportFindings(multi);
    expect(findings[0].anchor).toBe('const x = 1;\nconst y = x;');
  });

  it('fails closed on a block whose location or anchor field is missing', () => {
    const findings = parseReportFindings(
      '### [Critical] no fields\n- Issue: x\n',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      title: 'no fields',
      locations: [],
      anchor: '',
    });
    expect(resolveAnchors(findings, plan)[0].verdict).toBe('unresolved');
  });

  it('parses deviated headers: indentation, hash count, severity case', () => {
    const deviated = [
      '  #### [critical] indented and lowercase',
      '  - Location: unique.ts:1',
      '  - Anchor: export const uniqueToken = 42;',
    ].join('\n');
    const findings = parseReportFindings(deviated);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      title: 'indented and lowercase',
      severity: 'Critical',
      locations: ['unique.ts'],
    });
  });

  it('fails closed on a header-shaped line that does not parse', () => {
    const findings = parseReportFindings('##### [Bug] stray severity\n');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      title: '##### [Bug] stray severity',
      severity: '',
      locations: [],
      anchor: '',
    });
    expect(resolveAnchors(findings, plan)[0].verdict).toBe('unresolved');
  });

  it('keeps collecting an anchor across snippet list items', () => {
    const yaml = [
      '### [Critical] yaml anchor',
      '- Location: dup.ts:1',
      '- Anchor: const x = 1;',
      '- const y = x;',
      '- Issue: a',
      '- Failure scenario: b',
    ].join('\n');
    // "- const y = x;" is snippet content, not a finding field: collection
    // ends only on a recognized field name.
    expect(parseReportFindings(yaml)[0].anchor).toBe(
      'const x = 1;\n- const y = x;',
    );
  });

  it('does not clobber the location on a field-shaped line inside the anchor', () => {
    const quoted = [
      '### [Critical] quoted yaml',
      '- Location: unique.ts:1',
      '- Anchor: offices:',
      '  - Location: remote',
      '- Issue: a',
    ].join('\n');
    const findings = parseReportFindings(quoted);
    expect(findings[0].locations).toEqual(['unique.ts']);
    expect(findings[0].anchor).toContain('- Location: remote');
  });

  it('does not truncate an anchor on an indented field-shaped snippet line', () => {
    const embedded = [
      '### [Critical] embedded field shape',
      '- Location: dup.ts:1',
      '- Anchor: const x = 1;',
      '   - Issue: quoted, not a field',
      'const z = x;',
      '- Issue: the real issue',
      '- Failure scenario: b',
    ].join('\n');
    expect(parseReportFindings(embedded)[0].anchor).toBe(
      'const x = 1;\n   - Issue: quoted, not a field\nconst z = x;',
    );
  });

  it('ends anchor collection on a recognized field without an Issue field', () => {
    const noIssue = [
      '### [Critical] no issue field',
      '- Location: dup.ts:1',
      '- Anchor: const x = 1;',
      '- Failure scenario: trigger',
      '### [Suggestion] next finding',
    ].join('\n');
    expect(parseReportFindings(noIssue)[0].anchor).toBe('const x = 1;');
  });

  it('does not split an anchor on a header-shaped snippet line', () => {
    const rust = [
      '### [Critical] rust attr in snippet',
      '- Location: dup.ts:1',
      '- Anchor: const x = 1;',
      '#[cfg(test)]',
      '- Issue: a',
    ].join('\n');
    const findings = parseReportFindings(rust);
    expect(findings).toHaveLength(1);
    expect(findings[0].anchor).toContain('#[cfg(test)]');
  });

  it('dedents multi-line anchors by the Anchor field indentation', () => {
    const indented = [
      '  ### [Critical] indented multi-line',
      '  - Location: dup.ts:1',
      '  - Anchor: const x = 1;',
      '  const y = x;',
      '  - Issue: a',
      '- Failure scenario: b',
    ].join('\n');
    expect(parseReportFindings(indented)[0].anchor).toBe(
      'const x = 1;\nconst y = x;',
    );
  });

  it('strips a fence pair wrapped around a multi-line anchor', () => {
    const fenced = [
      '### [Critical] fenced anchor',
      '- Location: dup.ts:1',
      '- Anchor: ```ts',
      'const x = 1;',
      'const y = x;',
      '```',
      '- Issue: a',
      '- Failure scenario: b',
    ].join('\n');
    expect(parseReportFindings(fenced)[0].anchor).toBe(
      'const x = 1;\nconst y = x;',
    );
  });

  it('accepts case-deviated field names', () => {
    const deviated = [
      '### [Critical] case-deviated fields',
      '- location: unique.ts:1',
      '- ANCHOR: export const uniqueToken = 42;',
      '- Failure Scenario: x',
      '- severity: s',
    ].join('\n');
    const findings = parseReportFindings(deviated);
    expect(findings[0].locations).toEqual(['unique.ts']);
    expect(findings[0].anchor).toBe('export const uniqueToken = 42;');
  });

  it('strips line, column, and range suffixes from locations', () => {
    const block = (location: string) =>
      `### [Critical] suffixes\n- Location: ${location}\n- Anchor: x\n`;
    expect(parseReportFindings(block('unique.ts:1'))[0].locations).toEqual([
      'unique.ts',
    ]);
    expect(parseReportFindings(block('unique.ts:1:5'))[0].locations).toEqual([
      'unique.ts',
    ]);
    expect(parseReportFindings(block('unique.ts:1-3'))[0].locations).toEqual([
      'unique.ts',
    ]);
    // The four-part editor form peels whole, not to a residual ':1'.
    expect(parseReportFindings(block('unique.ts:1:5-10'))[0].locations).toEqual(
      ['unique.ts'],
    );
    // Agents habitually emit a leading './'.
    expect(parseReportFindings(block('./unique.ts:1'))[0].locations).toEqual([
      'unique.ts',
    ]);
  });

  it('fails closed on bracket-less and bold finding headers', () => {
    const bracketless = parseReportFindings(
      '### Critical: no brackets\n- Issue: x\n',
    );
    expect(bracketless).toHaveLength(1);
    expect(bracketless[0]).toMatchObject({
      title: '### Critical: no brackets',
      severity: '',
      locations: [],
      anchor: '',
    });
    const bold = parseReportFindings('**[Suggestion] bold header**\n');
    expect(bold).toHaveLength(1);
    expect(bold[0]).toMatchObject({ severity: '', anchor: '' });
    // The report's own section headings are not findings — bare or with
    // trailing text.
    expect(parseReportFindings('## Critical\n\n## Suggestion\n')).toEqual([]);
    expect(
      parseReportFindings('## Critical Findings\n\n## Suggestion\n'),
    ).toEqual([]);
  });

  it('synthesizes an entry when fields follow a bare severity heading', () => {
    // The bare heading stays invisible as a section heading would — but its
    // FIELDS belong to a finding and must fire the gate, not drop silently
    // into a zero-finding parse.
    const findings = parseReportFindings(
      '### Critical\n- Location: unique.ts:1\n- Anchor: export const uniqueToken = 42;\n',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: '',
      locations: ['unique.ts'],
    });
    // A finding whose header did not parse is uncertifiable even when its
    // anchor resolves.
    expect(resolveAnchors(findings, plan)[0].verdict).toBe('unresolved');
  });

  it('ends anchor collection on the next finding header', () => {
    const two = [
      '### [Critical] first',
      '- Location: dup.ts:1',
      '- Anchor: const x = 1;',
      '',
      '### [Suggestion] second',
      '- Location: unique.ts:1',
      '- Anchor: export const uniqueToken = 42;',
    ].join('\n');
    const findings = parseReportFindings(two);
    expect(findings).toHaveLength(2);
    expect(findings[0].anchor).toBe('const x = 1;');
    expect(findings[1]).toMatchObject({
      title: 'second',
      locations: ['unique.ts'],
    });
  });

  it('parses a reordered Anchor-before-Location block', () => {
    const reordered = [
      '### [Critical] reordered',
      '- Anchor: const x = 1;',
      '- Location: dup.ts:1',
      '- Issue: a',
    ].join('\n');
    const findings = parseReportFindings(reordered);
    expect(findings[0].locations).toEqual(['dup.ts']);
    expect(findings[0].anchor).toBe('const x = 1;');
    expect(resolveAnchors(findings, plan)[0].verdict).toBe('resolved');
  });

  it('starts over on a second Anchor field after a field gap', () => {
    const headerless = [
      '### [Critical] doubled',
      '- Location: dup.ts:1',
      '- Anchor: ```',
      'const x = 1;',
      '```',
      '- Location: unique.ts:1',
      '- Anchor: export const uniqueToken = 42;',
    ].join('\n');
    const findings = parseReportFindings(headerless);
    expect(findings).toHaveLength(1);
    // The second pair wins whole — the fence-wrapped first anchor shields
    // its interior, so the second pair is a confirmed pair-wise rewrite:
    // no merged location, no concatenated anchor bleeding across blocks.
    expect(findings[0].locations).toEqual(['unique.ts']);
    expect(findings[0].anchor).toBe('export const uniqueToken = 42;');
  });

  it('fails closed when an UNFENCED anchor is followed by a second pair', () => {
    // An unfenced anchor cannot rule out the quoted-pair reading (a
    // snippet quoting a prior round's fields), so neither binding may
    // win: the block downgrades instead of silently rebinding.
    const quoted = [
      '### [Critical] quoted pair',
      '- Location: dup.ts:1',
      '- Anchor: the previous round said',
      '- Location: unique.ts:1',
      '- Anchor: export const uniqueToken = 42;',
    ].join('\n');
    const findings = parseReportFindings(quoted);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('');
    expect(resolveAnchors(findings, plan)[0].verdict).toBe('unresolved');
  });

  it('does not leak the fence state into the next block', () => {
    // A fenced FIRST finding must not certify an UNFENCED second block's
    // pair-wise rebind: the quoted-pair reading is open again there.
    const two = [
      '### [Critical] fenced first',
      '- Location: dup.ts:1',
      '- Anchor: ```',
      'const x = 1;',
      '```',
      '- Issue: a',
      '',
      '### [Critical] unfenced second',
      '- Location: dup.ts:1',
      '- Anchor: the previous round said',
      '- Location: unique.ts:1',
      '- Anchor: export const uniqueToken = 42;',
    ].join('\n');
    const findings = parseReportFindings(two);
    expect(findings).toHaveLength(2);
    expect(findings[1].severity).toBe('');
    expect(resolveAnchors(findings, plan)[1].verdict).toBe('unresolved');
  });

  it('does not restart on an isolated quoted second Anchor line', () => {
    // No held second Location precedes it, so the line is a quote, not a
    // rewrite: the original anchor stands (and fails to resolve) instead
    // of rebinding onto the quoted content.
    const quoted = [
      '### [Critical] isolated quote',
      '- Location: dup.ts:1',
      '- Anchor: the other finding read',
      '- Anchor: const x = 1;',
    ].join('\n');
    const findings = parseReportFindings(quoted);
    expect(findings).toHaveLength(1);
    expect(findings[0].anchor).toContain('the other finding read');
    expect(findings[0].locations).toEqual(['dup.ts']);
    expect(resolveAnchors(findings, plan)[0].verdict).toBe('unresolved');
  });

  it('keeps collecting past a quoted column-0 field line followed by content', () => {
    // The field-shaped line is followed by a non-field line, so it is a
    // quote inside the anchor, not the finding's next field: truncating
    // there could certify the misquoted snippet tail.
    const quoted = [
      '### [Critical] quoted issue line',
      '- Location: dup.ts:1',
      '- Anchor: const x = 1;',
      '- Issue: quoted line',
      'const y = x;',
    ].join('\n');
    const findings = parseReportFindings(quoted);
    expect(findings).toHaveLength(1);
    expect(findings[0].anchor).toBe(
      'const x = 1;\n- Issue: quoted line\nconst y = x;',
    );
    expect(resolveAnchors(findings, plan)[0].verdict).toBe('unresolved');
  });

  it('resolves a pair whose anchor binds exactly once at each end', () => {
    writeFileSync(join(dir, 'dup2.ts'), 'const x = 1;\n');
    const pairPlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const pair = [
      '### [Critical] pair',
      '- Location: dup.ts:1, dup2.ts:1',
      '- Anchor: const x = 1;',
    ].join('\n');
    const findings = parseReportFindings(pair);
    expect(findings[0].locations).toEqual(['dup.ts', 'dup2.ts']);
    // The canonical pair: the snippet appears once in EACH cited file. The
    // total is two matches, yet every location binds uniquely, so the
    // finding resolves — a cross-location sum would grade it ambiguous.
    const result = resolveAnchors(findings, pairPlan)[0];
    expect(result.verdict).toBe('resolved');
    expect(result.matchCount).toBe(2);
  });

  it('grades a pair ambiguous when its anchor binds at only one end', () => {
    const pair = [
      '### [Critical] half-bound pair',
      '- Location: dup.ts:1, unique.ts:1',
      '- Anchor: const x = 1;',
    ].join('\n');
    const findings = parseReportFindings(pair);
    expect(findings[0].locations).toEqual(['dup.ts', 'unique.ts']);
    // The snippet exists only in dup.ts: the unique.ts citation does not
    // bind, so the pair claim is not verified as reported.
    expect(resolveAnchors(findings, plan)[0].verdict).toBe('ambiguous');
  });

  it('keeps "and"-containing filenames whole when splitting locations', () => {
    writeFileSync(
      join(dir, 'drag-and-drop.tsx'),
      'export const uniqueToken = 42;\n',
    );
    const andPlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const block = [
      '### [Critical] hyphenated filename',
      '- Location: drag-and-drop.tsx:1 and unique.ts:1',
      '- Anchor: export const uniqueToken = 42;',
    ].join('\n');
    const findings = parseReportFindings(block);
    // An unanchored \band\b split cut inside the filename and both
    // fragments resolved out-of-scope; 'and' splits only between words.
    expect(findings[0].locations).toEqual(['drag-and-drop.tsx', 'unique.ts']);
    expect(resolveAnchors(findings, andPlan)[0].verdict).toBe('resolved');
  });

  it('strips single-line inline-code wrapping from anchors', () => {
    const inline = [
      '### [Critical] inline backticks',
      '- Location: dup.ts:1',
      '- Anchor: `const x = 1;`',
    ].join('\n');
    const findings = parseReportFindings(inline);
    expect(findings[0].anchor).toBe('const x = 1;');
    expect(resolveAnchors(findings, plan)[0].verdict).toBe('resolved');
  });

  it('accepts bold-markdown field labels', () => {
    const bold = [
      '### [Critical] bold fields',
      '- **Location:** unique.ts:1',
      '- **Anchor:** export const uniqueToken = 42;',
    ].join('\n');
    const findings = parseReportFindings(bold);
    expect(findings[0].locations).toEqual(['unique.ts']);
    expect(findings[0].anchor).toBe('export const uniqueToken = 42;');
    expect(resolveAnchors(findings, plan)[0].verdict).toBe('resolved');
  });

  it('drops trailing whitespace on interior anchor lines', () => {
    const trailing = [
      '### [Critical] trailing space',
      '- Location: dup.ts:1',
      '- Anchor: const x = 1; ',
      'const y = x;',
      '- Issue: a',
      '- Failure scenario: b',
    ].join('\n');
    const findings = parseReportFindings(trailing);
    expect(findings[0].anchor).toBe('const x = 1;\nconst y = x;');
    expect(resolveAnchors(findings, plan)[0].verdict).toBe('resolved');
  });

  it('dedents deeper-indented fence continuations by their own minimum', () => {
    const indentedFence = [
      '### [Critical] indented fence',
      '- Location: dup.ts:1',
      '- Anchor: ```',
      '  const x = 1;',
      '  const y = x;',
      '  ```',
      '- Issue: a',
      '- Failure scenario: b',
    ].join('\n');
    const findings = parseReportFindings(indentedFence);
    expect(findings[0].anchor).toBe('const x = 1;\nconst y = x;');
    expect(resolveAnchors(findings, plan)[0].verdict).toBe('resolved');
  });

  it('ignores field-shaped lines inside an open fence', () => {
    const fencedYaml = [
      '### [Critical] fenced field shape',
      '- Location: dup.ts:1',
      '- Anchor: ```yaml',
      '- location: /var/run',
      'key: value',
      '```',
      '- Issue: a',
      '- Failure scenario: b',
    ].join('\n');
    const findings = parseReportFindings(fencedYaml);
    expect(findings).toHaveLength(1);
    expect(findings[0].anchor).toBe('- location: /var/run\nkey: value');
    expect(findings[0].locations).toEqual(['dup.ts']);
  });

  it('does not latch a self-closing inline fence', () => {
    // A fence that opens AND closes on the Anchor field line must not
    // swallow the following fields and findings into this anchor.
    const selfClosing = [
      '### [Critical] first',
      '- Location: dup.ts:1',
      '- Anchor: ```const x = 1;```',
      '- Issue: a',
      '### [Suggestion] second',
      '- Location: unique.ts:1',
      '- Anchor: export const uniqueToken = 42;',
    ].join('\n');
    const findings = parseReportFindings(selfClosing);
    expect(findings).toHaveLength(2);
    expect(findings[0].anchor).toBe('const x = 1;');
    expect(findings[1]).toMatchObject({
      title: 'second',
      locations: ['unique.ts'],
    });
  });

  it('synthesizes a fail-closed block for orphan non-anchor fields', () => {
    // A deviant header invisible to all three nets followed only by
    // Issue/Failure scenario/Severity lines must not parse to zero
    // findings — the gate must rule on it instead of exiting 0.
    const orphan = [
      '## Critical Findings',
      '- Issue: something wrong',
      '- Failure scenario: when x',
      '- Severity: Critical',
    ].join('\n');
    const findings = parseReportFindings(orphan);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: '',
      locations: [],
      anchor: '',
    });
  });

  it('names an unclosed fence at EOF as a truncation', () => {
    const truncated = [
      '### [Critical] truncated',
      '- Location: dup.ts:1',
      '- Anchor: ```',
      'const x = 1;',
    ].join('\n');
    const findings = parseReportFindings(truncated);
    expect(findings).toHaveLength(2);
    expect(findings[1].title).toContain('unclosed anchor fence');
    expect(findings[1].severity).toBe('');
  });

  it('accepts bold labels with the colon outside the bold', () => {
    const boldOutside = [
      '### [Critical] bold outside',
      '- **Location**: unique.ts:1',
      '- **Anchor**: export const uniqueToken = 42;',
    ].join('\n');
    const findings = parseReportFindings(boldOutside);
    expect(findings[0].locations).toEqual(['unique.ts']);
    expect(findings[0].anchor).toBe('export const uniqueToken = 42;');
    expect(resolveAnchors(findings, plan)[0].verdict).toBe('resolved');
  });
});

describe('resolveAnchors', () => {
  it('resolves a unique anchor, refuses a missing one, flags an ambiguous one', () => {
    const results = resolveAnchors(
      [
        {
          title: 'a',
          severity: 'Critical',
          locations: ['unique.ts'],
          anchor: 'export const uniqueToken = 42;',
        },
        {
          title: 'b',
          severity: 'Critical',
          locations: ['unique.ts'],
          anchor: 'not in the file',
        },
        {
          title: 'c',
          severity: 'Suggestion',
          locations: ['dup.ts'],
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

  it('refuses a finding whose header never parsed even if it resolves', () => {
    const results = resolveAnchors(
      [
        {
          title: '',
          severity: '',
          locations: ['unique.ts'],
          anchor: 'export const uniqueToken = 42;',
        },
      ],
      plan,
    );
    expect(results[0].verdict).toBe('unresolved');
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
        {
          title: 't',
          severity: 'Suggestion',
          locations: ['unique.test.ts'],
          anchor: 'export const tested = 1;',
        },
      ],
      corpusPlan,
    );
    expect(results[0].verdict).toBe('resolved');
  });

  it('refuses anchors citing files outside the audited set as out-of-scope', () => {
    const results = resolveAnchors(
      [
        {
          title: 'd',
          severity: 'Critical',
          locations: ['../elsewhere.ts'],
          anchor: 'anything',
        },
      ],
      plan,
    );
    expect(results[0].verdict).toBe('out-of-scope');
  });

  it('refuses a pair whose second location is out of scope', () => {
    const results = resolveAnchors(
      [
        {
          title: 'p',
          severity: 'Critical',
          locations: ['dup.ts', '../elsewhere.ts'],
          anchor: 'const x = 1;',
        },
      ],
      plan,
    );
    expect(results[0].verdict).toBe('out-of-scope');
  });

  it('resolves a multi-line anchor against a CRLF file', () => {
    writeFileSync(join(dir, 'crlf.ts'), 'line one\r\nline two\r\n');
    const crlfPlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const results = resolveAnchors(
      [
        {
          title: 'crlf',
          severity: 'Critical',
          locations: ['crlf.ts'],
          anchor: 'line one\nline two',
        },
      ],
      crlfPlan,
    );
    expect(results[0].verdict).toBe('resolved');
  });

  it('resolves against registered deep-read callers outside the path', () => {
    const caller = join(dir, '..', `caller-${Date.now()}.ts`);
    writeFileSync(caller, 'callerOnlyToken();\n');
    try {
      const results = resolveAnchors(
        [
          {
            title: 'e',
            severity: 'Critical',
            locations: [caller],
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

  it('resolves a multi-line anchor quoted from indented code', () => {
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
    const findings = parseReportFindings(
      [
        '### [Critical] indented quote',
        '- Location: indented.ts:2',
        '- Anchor:',
        '  const a = 1;',
        '  const b = a;',
        '- Issue: a',
        '- Failure scenario: b',
      ].join('\n'),
    );
    // push() dedents the needle to column 0; the file keeps its indent —
    // matching must stay indent-tolerant or the common case (a snippet
    // from a function body) is unanchorable by construction.
    expect(findings[0].anchor).toBe('const a = 1;\nconst b = a;');
    expect(resolveAnchors(findings, indentedPlan)[0].verdict).toBe('resolved');
  });

  it('binds a whole Location whose filename contains a comma', () => {
    writeFileSync(join(dir, 'a,b.ts'), 'export const commaFile = 1;\n');
    const commaPlan = buildFilesPlan(
      dir,
      dir,
      'medium',
      collectAuditFiles(dir),
    );
    const findings = parseReportFindings(
      [
        '### [Critical] comma file',
        '- Location: a,b.ts:1',
        '- Anchor: export const commaFile = 1;',
      ].join('\n'),
    );
    // The comma split shreds 'a,b.ts' into fragments that match nothing;
    // the raw whole value must bind when it names a known file.
    expect(resolveAnchors(findings, commaPlan)[0].verdict).toBe('resolved');
  });

  it('grades a fence-residue-only anchor unresolved, whatever the file holds', () => {
    // The cited file carries a stray backtick — the old slice(1,-1)
    // turned the residue into a needle matching it, certifying an empty
    // snippet.
    writeFileSync(join(dir, 'stray.ts'), 'prose with one ` backtick\n');
    const strayPlan = buildFilesPlan(
      dir,
      dir,
      'medium',
      collectAuditFiles(dir),
    );
    const findings = parseReportFindings(
      [
        '### [Critical] residue',
        '- Location: stray.ts:1',
        '- Anchor: ```',
      ].join('\n'),
    );
    expect(findings[0].anchor).toBe('');
    expect(resolveAnchors(findings, strayPlan)[0].verdict).toBe('unresolved');
  });

  it.skipIf(process.platform === 'win32')(
    'grades a FIFO swapped into a cited subject unresolved without hanging',
    () => {
      // The cited path is agent-authored: a writer-less FIFO swapped in
      // between plan and resolution must not hang the write gate.
      const pipePlan = buildFilesPlan(
        dir,
        dir,
        'medium',
        collectAuditFiles(dir),
      );
      rmSync(join(dir, 'unique.ts'));
      execFileSync('mkfifo', [join(dir, 'unique.ts')]);
      const findings = parseReportFindings(
        [
          '### [Critical] fifo citation',
          '- Location: unique.ts:1',
          '- Anchor: anything',
        ].join('\n'),
      );
      expect(resolveAnchors(findings, pipePlan)[0].verdict).toBe('unresolved');
    },
  );

  it('parses a two-hash finding header (the FINDING_RE lower bound)', () => {
    // FINDING_RE accepts 2-4 hashes; the 2-hash arm needs its own pin.
    const findings = parseReportFindings(
      '## [Suggestion] two-hash header\n- Location: unique.ts:1\n- Anchor: export const uniqueToken = 42;\n',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      title: 'two-hash header',
      severity: 'Suggestion',
      locations: ['unique.ts'],
    });
    expect(resolveAnchors(findings, plan)[0].verdict).toBe('resolved');
  });

  it('keeps the first Location when an unfenced snippet quotes a field-shaped Location line', () => {
    // The quoted line sits at anchor indent or shallower, so it ends
    // collection — but it must NOT overwrite the finding's real location
    // (the old overwrite mis-bound the finding to the quoted file).
    const quoted = [
      '### [Critical] quoted location',
      '- Location: unique.ts:1',
      '- Anchor:',
      'export const uniqueToken = 42;',
      '- Location: dup.ts',
      '- Issue: a',
    ].join('\n');
    const findings = parseReportFindings(quoted);
    expect(findings).toHaveLength(1);
    expect(findings[0].locations).toEqual(['unique.ts']);
    expect(resolveAnchors(findings, plan)[0].verdict).toBe('resolved');
  });

  it('ends anchor collection on a deviated severity heading inside an unfenced anchor', () => {
    // Without the split, the deviated header is swallowed as snippet
    // content and the two blocks merge into one finding.
    const merged = [
      '### [Critical] first',
      '- Location: unique.ts:1',
      '- Anchor: export const uniqueToken = 42;',
      '### Suggestion: leaked header',
      '- Location: unique.ts:1',
      '- Anchor: export const uniqueToken = 42;',
    ].join('\n');
    const findings = parseReportFindings(merged);
    expect(findings).toHaveLength(2);
    expect(findings[0].anchor).toBe('export const uniqueToken = 42;');
    expect(findings[1].title).toBe('### Suggestion: leaked header');
    expect(findings[1].severity).toBe('');
  });

  it('strips inline-code wrapping and trailing bold from Location values', () => {
    // FIELD_RE is lenient on the LABEL only; the value decorations an LLM
    // rendering adds must peel before the membership check.
    expect(
      parseReportFindings(
        '### [Critical] code-wrapped\n- Location: `unique.ts:1`\n- Anchor: x\n',
      )[0].locations,
    ).toEqual(['unique.ts']);
    expect(
      parseReportFindings(
        '### [Critical] bold tail\n- Location: unique.ts:1**\n- Anchor: x\n',
      )[0].locations,
    ).toEqual(['unique.ts']);
  });

  it('peels a spaced line suffix and the GitHub #L form from Location values', () => {
    expect(
      parseReportFindings(
        '### [Critical] spaced suffix\n- Location: unique.ts :1\n- Anchor: x\n',
      )[0].locations,
    ).toEqual(['unique.ts']);
    expect(
      parseReportFindings(
        '### [Critical] github form\n- Location: unique.ts#L1\n- Anchor: x\n',
      )[0].locations,
    ).toEqual(['unique.ts']);
    // Windows quoting arrives backslash-separated.
    expect(
      parseReportFindings(
        '### [Critical] backslash form\n- Location: .\\unique.ts:1\n- Anchor: x\n',
      )[0].locations,
    ).toEqual(['unique.ts']);
  });

  it('resolves a snippet whose first quoted line sits deeper than the snippet minimum', () => {
    writeFileSync(join(dir, 'deepfirst.ts'), 'if (ok) {\n    doIt();\n}\n');
    const deepPlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const findings = parseReportFindings(
      [
        '### [Critical] deep first line',
        '- Location: deepfirst.ts:2',
        '- Anchor:',
        '    doIt();',
        '}',
        '- Issue: a',
        '- Failure scenario: b',
      ].join('\n'),
    );
    expect(findings[0].anchor).toBe('    doIt();\n}');
    // The window base is the minimum indent across the window, not the
    // first line's — otherwise this shape is structurally unmatchable.
    expect(resolveAnchors(findings, deepPlan)[0].verdict).toBe('resolved');
  });

  it('resolves a snippet against file lines carrying trailing whitespace', () => {
    writeFileSync(join(dir, 'trail.ts'), 'const a = 1;\nconst b = 2;   \n');
    const trailPlan = buildFilesPlan(
      dir,
      dir,
      'medium',
      collectAuditFiles(dir),
    );
    const findings = parseReportFindings(
      [
        '### [Critical] trailing whitespace',
        '- Location: trail.ts:1',
        '- Anchor:',
        'const a = 1;',
        'const b = 2;',
        '- Issue: a',
        '- Failure scenario: b',
      ].join('\n'),
    );
    expect(resolveAnchors(findings, trailPlan)[0].verdict).toBe('resolved');
  });

  it('resolves a snippet whose last quoted line is a strict prefix of the file line', () => {
    // An agent trimming a trailing comment when quoting cites code that
    // IS present at the location; the last needle line compares by prefix.
    writeFileSync(
      join(dir, 'prefix.ts'),
      'const a = 1;\nconst b = 2; // TODO remove\n',
    );
    const prefixPlan = buildFilesPlan(
      dir,
      dir,
      'medium',
      collectAuditFiles(dir),
    );
    const findings = parseReportFindings(
      [
        '### [Critical] trimmed comment',
        '- Location: prefix.ts:1',
        '- Anchor:',
        'const a = 1;',
        'const b = 2;',
        '- Issue: a',
        '- Failure scenario: b',
      ].join('\n'),
    );
    expect(resolveAnchors(findings, prefixPlan)[0].verdict).toBe('resolved');
  });

  it('counts a raw occurrence that starts mid-line', () => {
    // The window matcher requires a line-start window; a snippet whose
    // first line sits after other content on the file line binds through
    // the raw-occurrence path instead.
    writeFileSync(
      join(dir, 'midline.ts'),
      'const head = 0;\nconst pre = 1; const x = 1;\nconst y = x;\n',
    );
    const midPlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const findings = parseReportFindings(
      [
        '### [Critical] mid-line start',
        '- Location: midline.ts:2',
        '- Anchor:',
        'const x = 1;',
        'const y = x;',
        '- Issue: a',
        '- Failure scenario: b',
      ].join('\n'),
    );
    expect(resolveAnchors(findings, midPlan)[0]).toMatchObject({
      verdict: 'resolved',
      matchCount: 1,
    });
  });

  it('refuses a shredded multi-location whose fragments lack line suffixes', () => {
    // Both fragment names exist in the plan: without the :line
    // requirement on every fragment, any delimiter inside an unknown name
    // would certify the finding against files the report never cited.
    const findings = parseReportFindings(
      [
        '### [Critical] shred bypass',
        '- Location: unique.ts, dup.ts',
        '- Anchor: const x = 1;',
      ].join('\n'),
    );
    expect(resolveAnchors(findings, plan)[0].verdict).toBe('out-of-scope');
  });

  it('resolves an anchor whose first line follows a UTF-8 BOM', () => {
    writeFileSync(join(dir, 'bom.ts'), '\uFEFFexport const bomToken = 1;\n');
    const bomPlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const findings = parseReportFindings(
      [
        '### [Critical] bom',
        '- Location: bom.ts:1',
        '- Anchor: export const bomToken = 1;',
      ].join('\n'),
    );
    expect(resolveAnchors(findings, bomPlan)[0].verdict).toBe('resolved');
  });

  it('strips a double-backtick wrap around a single-line anchor', () => {
    // CommonMark requires `` spans when the snippet itself carries
    // backticks; the generic single-backtick arm would leave a residue.
    const findings = parseReportFindings(
      [
        '### [Critical] double backticks',
        '- Location: unique.ts:1',
        '- Anchor: ``export const uniqueToken = 42;``',
      ].join('\n'),
    );
    expect(findings[0].anchor).toBe('export const uniqueToken = 42;');
    expect(resolveAnchors(findings, plan)[0].verdict).toBe('resolved');
  });

  it('grades a cited file deleted before resolution unresolved', () => {
    // Plan (Step 1) and resolution (Step 7) are separated by the whole
    // run — the cited file can vanish in between (TOCTOU); the read
    // failure branch must stay fail-closed.
    writeFileSync(join(dir, 'ephemeral.ts'), 'export const gone = 1;\n');
    const ephemeralPlan = buildFilesPlan(
      dir,
      dir,
      'medium',
      collectAuditFiles(dir),
    );
    rmSync(join(dir, 'ephemeral.ts'));
    const findings = parseReportFindings(
      [
        '### [Critical] deleted subject',
        '- Location: ephemeral.ts:1',
        '- Anchor: export const gone = 1;',
      ].join('\n'),
    );
    expect(resolveAnchors(findings, ephemeralPlan)[0].verdict).toBe(
      'unresolved',
    );
  });

  it('grades a last-line token fusion unresolved', () => {
    // The prefix tolerance exists for a dropped trailing comment; an
    // unbounded startsWith fuses tokens and certifies a final line that
    // does not exist in the file ('const b = 2' into 'const b = 22;').
    writeFileSync(
      join(dir, 'fuse.ts'),
      'const a = 1;\nconst b = 22;\nreturn x2;\n',
    );
    const fusePlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const results = resolveAnchors(
      [
        {
          title: 'fused',
          severity: 'Critical',
          locations: ['fuse.ts'],
          anchor: 'const a = 1;\nconst b = 2',
        },
        {
          title: 'fused return',
          severity: 'Critical',
          locations: ['fuse.ts'],
          anchor: 'const b = 22;\nreturn x',
        },
      ],
      fusePlan,
    );
    expect(results[0].verdict).toBe('unresolved');
    expect(results[1].verdict).toBe('unresolved');
  });

  it('counts an occurrence whose first line sits deeper than the window minimum', () => {
    // The window matcher's base is the window minimum, so an occurrence
    // with an indented FIRST line matches neither matcher unless the raw
    // loop counts it — two occurrences must grade ambiguous, not resolved.
    writeFileSync(join(dir, 'deep.ts'), 'alpha\nbeta\n alpha\nbeta\n');
    const deepPlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const result = resolveAnchors(
      [
        {
          title: 'deep first line',
          severity: 'Critical',
          locations: ['deep.ts'],
          anchor: 'alpha\nbeta',
        },
      ],
      deepPlan,
    )[0];
    expect(result.verdict).toBe('ambiguous');
    expect(result.matchCount).toBe(2);
  });

  it('peels trailing sentence punctuation before the line suffix', () => {
    // A prose citation ending 'unique.ts:1,' must bind like the unpunctuated
    // form instead of grading the unknown whole value out-of-scope.
    const findings = parseReportFindings(
      '### [Critical] trailing comma\n- Location: unique.ts:1,\n- Anchor: export const uniqueToken = 42;\n',
    );
    expect(findings[0].locations).toEqual(['unique.ts']);
    expect(resolveAnchors(findings, plan)[0].verdict).toBe('resolved');
  });

  it('resolves a pair cited in the GitHub #L form', () => {
    writeFileSync(join(dir, 'dup2.ts'), 'const x = 1;\n');
    const pairPlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const findings = parseReportFindings(
      [
        '### [Critical] github pair',
        '- Location: dup.ts#L1, dup2.ts#L1',
        '- Anchor: const x = 1;',
      ].join('\n'),
    );
    expect(findings[0].locations).toEqual(['dup.ts', 'dup2.ts']);
    expect(resolveAnchors(findings, pairPlan)[0].verdict).toBe('resolved');
  });

  it('keeps a binding field-shaped line quoted at EOF in the needle', () => {
    // EOF supplies no confirming line: a Location-shaped last line is the
    // misquoted/hallucinated quote class — dropping it grades the bare
    // prefix and certifies a snippet tail that exists in no file. The
    // finding's real location stays bound (the quoted line is held as
    // pending, never committed).
    writeFileSync(join(dir, 'template.ts'), 'template says\n');
    const templatePlan = buildFilesPlan(
      dir,
      dir,
      'medium',
      collectAuditFiles(dir),
    );
    const quoted = [
      '### [Critical] eof quote',
      '- Location: template.ts:1',
      '- Anchor: template says',
      '- Location: hallucinated line never in the file',
    ].join('\n');
    const findings = parseReportFindings(quoted);
    expect(findings[0].locations).toEqual(['template.ts']);
    expect(findings[0].anchor).toBe(
      'template says\n- Location: hallucinated line never in the file',
    );
    expect(resolveAnchors(findings, templatePlan)[0].verdict).toBe(
      'unresolved',
    );
  });

  it('counts an occurrence whose first line adds whitespace beyond the needle\u2019s own indent', () => {
    // The needle keeps its first line's relative indent (the snippet's
    // minimum sits on a later line); the occurrence adds further leading
    // whitespace on that first line, so neither the window-minimum nor the
    // first-line base dedents it onto the needle — the difference base
    // must.
    writeFileSync(join(dir, 'offset.ts'), 'const w = {\n    b: 2,\n};\n');
    const offsetPlan = buildFilesPlan(
      dir,
      dir,
      'medium',
      collectAuditFiles(dir),
    );
    const result = resolveAnchors(
      [
        {
          title: 'offset first line',
          severity: 'Critical',
          locations: ['offset.ts'],
          anchor: '  b: 2,\n};',
        },
      ],
      offsetPlan,
    )[0];
    expect(result.verdict).toBe('resolved');
    expect(result.matchCount).toBe(1);
  });

  it('counts an occurrence whose deepest line is a continuation line', () => {
    // The window-minimum and first-line bases both dedent by the shallow
    // first line, leaving the deep continuation line un-dedented; the last
    // line's own indent is the base that matches.
    writeFileSync(join(dir, 'deepest.ts'), ' step1();\n      step2();\n');
    const deepestPlan = buildFilesPlan(
      dir,
      dir,
      'medium',
      collectAuditFiles(dir),
    );
    const result = resolveAnchors(
      [
        {
          title: 'deepest continuation',
          severity: 'Critical',
          locations: ['deepest.ts'],
          anchor: 'step1();\nstep2();',
        },
      ],
      deepestPlan,
    )[0];
    expect(result.verdict).toBe('resolved');
    expect(result.matchCount).toBe(1);
  });

  it('grades a single-line token fusion unresolved', () => {
    // The no-fusion invariant pinned above for multi-line needles applies
    // to the single-line branch too: a bare indexOf counted 'return x'
    // inside 'return x2;' and certified a line that does not exist.
    writeFileSync(join(dir, 'fuse1.ts'), 'return x2;\n');
    const fusePlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const results = resolveAnchors(
      [
        {
          title: 'single-line fused',
          severity: 'Critical',
          locations: ['fuse1.ts'],
          anchor: 'return x',
        },
        {
          title: 'single-line exact',
          severity: 'Critical',
          locations: ['fuse1.ts'],
          anchor: 'return x2;',
        },
      ],
      fusePlan,
    );
    expect(results[0].verdict).toBe('unresolved');
    expect(results[1].verdict).toBe('resolved');
  });

  it('keeps every field-shaped line quoted at EOF in the needle', () => {
    // EOF supplies no confirming line for ANY field shape: a quoted
    // `- Issue:` / `- Failure scenario:` / `- Severity:` last line may be
    // snippet content, and dropping it certifies the truncated prefix —
    // the same fail-open the round-6 Location/Anchor arm closed.
    writeFileSync(join(dir, 'template2.ts'), 'template says\n');
    const templatePlan = buildFilesPlan(
      dir,
      dir,
      'medium',
      collectAuditFiles(dir),
    );
    for (const field of ['Issue', 'Failure scenario', 'Severity']) {
      const findings = parseReportFindings(
        [
          '### [Critical] eof quote',
          '- Location: template2.ts:1',
          '- Anchor: template says',
          `- ${field}: hallucinated line never in the file`,
        ].join('\n'),
      );
      expect(findings[0].anchor).toBe(
        `template says\n- ${field}: hallucinated line never in the file`,
      );
      expect(resolveAnchors(findings, templatePlan)[0].verdict).toBe(
        'unresolved',
      );
    }
  });

  it('counts an occurrence whose deepest line is a middle line', () => {
    // The window-minimum, first-, last-, and offset bases never equal a
    // MIDDLE line's depth: the max-indent base dedents the deepest line
    // exactly and clamps the shallower ones (which carry no needle indent
    // to preserve). Without it a wrapped call quoted from an indented body
    // escapes both matchers and a correctly-anchored finding is refused.
    writeFileSync(join(dir, 'middeep.ts'), ' a();\n  b();\n c();\n');
    writeFileSync(join(dir, 'wrapped.ts'), ' foo(\n  bar,\n baz);\n');
    const midPlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const results = resolveAnchors(
      [
        {
          title: 'middle deepest',
          severity: 'Critical',
          locations: ['middeep.ts'],
          anchor: 'a();\nb();\nc();',
        },
        {
          title: 'wrapped call',
          severity: 'Critical',
          locations: ['wrapped.ts'],
          anchor: 'foo(\nbar,\nbaz);',
        },
      ],
      midPlan,
    );
    expect(results[0]).toMatchObject({ verdict: 'resolved', matchCount: 1 });
    expect(results[1]).toMatchObject({ verdict: 'resolved', matchCount: 1 });
  });

  it('grades a needle over the line cap unresolved without scanning', () => {
    // The matcher is O((H-N)*N) on agent-authored input; uncapped, a 30k
    // line needle against a 60k line file stalled the synchronous gate for
    // 71 s and extrapolates to hours near the read cap.
    writeFileSync(
      join(dir, 'huge.ts'),
      `${Array.from({ length: 2500 }, () => 'x').join('\n')}\n`,
    );
    const hugePlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const result = resolveAnchors(
      [
        {
          title: 'oversized',
          severity: 'Critical',
          locations: ['huge.ts'],
          anchor: Array.from(
            { length: AUDIT_ANCHOR_MAX_LINES + 1 },
            () => 'x',
          ).join('\n'),
        },
      ],
      hugePlan,
    )[0];
    expect(result).toMatchObject({ verdict: 'unresolved', matchCount: 0 });
  });

  it('binds a caller registered with platform-native backslashes', () => {
    // Callers arrive absolute and platform-native (backslashed on Windows)
    // while the parser backslash-normalizes every citation; membership
    // compares both sides forward-slashed or no Windows caller binds. The
    // verdict must NOT be out-of-scope: the citation names a registered
    // caller (unreadable here, so the read arm grades it unresolved).
    const result = resolveAnchors(
      [
        {
          title: 'win caller',
          severity: 'Critical',
          locations: ['C:/repo/caller.ts'],
          anchor: 'anything',
        },
      ],
      plan,
      ['C:\\repo\\caller.ts'],
    )[0];
    expect(result.verdict).not.toBe('out-of-scope');
  });

  it('guards the leading edge of a quoted line, not just the tail', () => {
    // The follow rule guards the needle's trailing edge; an unguarded
    // leading edge fuses 'bar()' into 'foobar()' and certifies a quoted
    // line that is not in the file. The multi-line mid-line raw scan gets
    // both edges: a hit whose preceding character is an identifier char or
    // whose last line fuses into the file line is refused.
    writeFileSync(join(dir, 'lead.ts'), 'foobar()\n');
    writeFileSync(join(dir, 'leadmid1.ts'), 'x = bar() + 1;\n');
    writeFileSync(join(dir, 'leadmid2.ts'), 'const z = obj.bar()\n');
    writeFileSync(join(dir, 'leadmulti.ts'), 'xfoo()\nreturn x2;\n');
    writeFileSync(join(dir, 'leadmultifuse.ts'), 'a foo()\nreturn x2;\n');
    writeFileSync(join(dir, 'leadmultiok.ts'), 'a = foo()\nreturn x // r\n');
    const leadPlan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
    const results = resolveAnchors(
      [
        {
          title: 'leading fusion',
          severity: 'Critical',
          locations: ['lead.ts'],
          anchor: 'bar()',
        },
        {
          title: 'leading boundary after space',
          severity: 'Critical',
          locations: ['leadmid1.ts'],
          anchor: 'bar()',
        },
        {
          title: 'leading boundary after dot',
          severity: 'Critical',
          locations: ['leadmid2.ts'],
          anchor: 'bar()',
        },
        {
          title: 'multi-line leading fusion',
          severity: 'Critical',
          locations: ['leadmulti.ts'],
          anchor: 'foo()\nreturn x',
        },
        {
          title: 'multi-line trailing fusion',
          severity: 'Critical',
          locations: ['leadmultifuse.ts'],
          anchor: 'foo()\nreturn x',
        },
        {
          title: 'multi-line mid-line clean',
          severity: 'Critical',
          locations: ['leadmultiok.ts'],
          anchor: 'foo()\nreturn x',
        },
      ],
      leadPlan,
    );
    expect(results[0].verdict).toBe('unresolved');
    // Space- and dot-preceded hits are non-identifier boundaries and stay
    // countable ('x = bar() + 1;' and 'const z = obj.bar()').
    expect(results[1]).toMatchObject({ verdict: 'resolved', matchCount: 1 });
    expect(results[2]).toMatchObject({ verdict: 'resolved', matchCount: 1 });
    expect(results[3].verdict).toBe('unresolved');
    expect(results[4].verdict).toBe('unresolved');
    expect(results[5]).toMatchObject({ verdict: 'resolved', matchCount: 1 });
  });
});
