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
import { parseReportFindings, resolveAnchors } from './anchors.js';
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
      '- Anchor: const x = 1;',
      '- Location: unique.ts:1',
      '- Anchor: export const uniqueToken = 42;',
    ].join('\n');
    const findings = parseReportFindings(headerless);
    expect(findings).toHaveLength(1);
    // The second pair wins whole — no merged location, no concatenated
    // anchor bleeding across blocks.
    expect(findings[0].locations).toEqual(['unique.ts']);
    expect(findings[0].anchor).toBe('export const uniqueToken = 42;');
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
});
