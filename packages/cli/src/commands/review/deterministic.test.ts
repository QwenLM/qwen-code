/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Direct unit tests for the per-tool parsers in `deterministic.ts`.
// The end-to-end `runDeterministic` path is hard to mock because it
// shells out to real tool binaries; these tests pin the data-extraction
// layer to fixture outputs so a regex regression or JSON shape shift
// surfaces here instead of silently dropping findings in production.

import { describe, it, expect } from 'vitest';
import {
  parseTscOutput,
  parseEslintJson,
  parseRuffJson,
  parseCargoClippyNdjson,
  parseGoVetOutput,
  parseGolangciJson,
} from './deterministic.js';

const WORKTREE = '/work/tree';
const CHANGED = new Set(['src/a.ts', 'src/b.ts', 'lib/c.py', 'main.rs', 'cmd/x.go']);

describe('parseTscOutput', () => {
  it('parses tsc errors with line/column and maps error→Critical', () => {
    const out = `src/a.ts(10,5): error TS2304: Cannot find name 'foo'.
src/a.ts(12,1): warning TS6133: 'bar' is declared but never read.`;
    const findings = parseTscOutput(out, WORKTREE, CHANGED);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      tool: 'tsc',
      file: 'src/a.ts',
      line: 10,
      column: 5,
      severity: 'Critical',
      ruleId: 'TS2304',
      message: "Cannot find name 'foo'.",
      source: 'typecheck',
    });
    expect(findings[1].severity).toBe('Nice to have');
  });

  it('returns empty for empty input', () => {
    expect(parseTscOutput('', WORKTREE, CHANGED)).toEqual([]);
  });

  it('filters findings to changed files only', () => {
    const out = `src/a.ts(1,1): error TS1: m
src/unrelated.ts(1,1): error TS1: m`;
    const findings = parseTscOutput(out, WORKTREE, CHANGED);
    expect(findings.map((f) => f.file)).toEqual(['src/a.ts']);
  });

  it('strips a leading worktree prefix when tsc emits absolute paths', () => {
    const out = `${WORKTREE}/src/a.ts(1,1): error TS1: msg`;
    const findings = parseTscOutput(out, WORKTREE, CHANGED);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('src/a.ts');
  });
});

describe('parseEslintJson', () => {
  it('parses eslint JSON with severity mapping (2=Critical, 1=Nice to have)', () => {
    const json = JSON.stringify([
      {
        filePath: '/work/tree/src/a.ts',
        messages: [
          { ruleId: 'no-unused-vars', severity: 2, message: 'unused', line: 3, column: 4 },
          { ruleId: 'prefer-const', severity: 1, message: 'use const', line: 5 },
        ],
      },
    ]);
    const findings = parseEslintJson(json, WORKTREE, CHANGED);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      tool: 'eslint',
      file: 'src/a.ts',
      severity: 'Critical',
      ruleId: 'no-unused-vars',
      line: 3,
      column: 4,
    });
    expect(findings[1].severity).toBe('Nice to have');
    expect(findings[1].column).toBeUndefined();
  });

  it('returns empty array on JSON parse failure (fallback)', () => {
    // eslint may print warnings before its JSON payload; the fallback
    // must drop findings silently rather than crash the subcommand.
    expect(parseEslintJson('warning: foo\n[invalid json', WORKTREE, CHANGED))
      .toEqual([]);
  });

  it('filters by changed-files set', () => {
    const json = JSON.stringify([
      { filePath: '/work/tree/src/a.ts', messages: [{ ruleId: 'x', severity: 2, message: 'm', line: 1 }] },
      { filePath: '/work/tree/src/skipped.ts', messages: [{ ruleId: 'x', severity: 2, message: 'm', line: 1 }] },
    ]);
    const findings = parseEslintJson(json, WORKTREE, CHANGED);
    expect(findings.map((f) => f.file)).toEqual(['src/a.ts']);
  });

  it('maps null ruleId to undefined', () => {
    const json = JSON.stringify([
      { filePath: '/work/tree/src/a.ts', messages: [{ ruleId: null, severity: 2, message: 'syntax', line: 1 }] },
    ]);
    const findings = parseEslintJson(json, WORKTREE, CHANGED);
    expect(findings[0].ruleId).toBeUndefined();
  });
});

describe('parseRuffJson', () => {
  it('parses ruff JSON with row/column from location', () => {
    const json = JSON.stringify([
      { code: 'E501', message: 'line too long', filename: '/work/tree/lib/c.py', location: { row: 12, column: 80 } },
    ]);
    const findings = parseRuffJson(json, WORKTREE, CHANGED);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      tool: 'ruff',
      source: 'linter',
      file: 'lib/c.py',
      line: 12,
      column: 80,
      severity: 'Critical',
      ruleId: 'E501',
    });
  });

  it('returns empty array on JSON parse failure', () => {
    expect(parseRuffJson('not json', WORKTREE, CHANGED)).toEqual([]);
  });

  it('filters by changed-files set', () => {
    const json = JSON.stringify([
      { code: 'E1', message: 'x', filename: '/work/tree/lib/c.py', location: { row: 1, column: 1 } },
      { code: 'E1', message: 'x', filename: '/work/tree/lib/skipped.py', location: { row: 1, column: 1 } },
    ]);
    expect(parseRuffJson(json, WORKTREE, CHANGED).map((f) => f.file))
      .toEqual(['lib/c.py']);
  });
});

describe('parseCargoClippyNdjson', () => {
  it('parses ndjson, picks primary span, drops non-compiler-message rows', () => {
    const lines = [
      JSON.stringify({ reason: 'build-script-executed', package_id: 'x' }),
      JSON.stringify({
        reason: 'compiler-message',
        message: {
          level: 'warning',
          message: 'unused variable: x',
          code: { code: 'unused_variables' },
          spans: [
            { is_primary: false, file_name: '/work/tree/main.rs', line_start: 5, column_start: 1 },
            { is_primary: true, file_name: '/work/tree/main.rs', line_start: 10, column_start: 3 },
          ],
        },
      }),
      JSON.stringify({
        reason: 'compiler-message',
        message: { level: 'note', message: 'note', spans: [] },
      }),
    ].join('\n');
    const findings = parseCargoClippyNdjson(lines, WORKTREE, CHANGED);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      tool: 'cargo-clippy',
      file: 'main.rs',
      line: 10,
      column: 3,
      severity: 'Nice to have',
      ruleId: 'unused_variables',
    });
  });

  it('skips lines that do not start with `{` and unparseable JSON rows', () => {
    const lines = 'plain stderr line\n{not-json\n';
    expect(parseCargoClippyNdjson(lines, WORKTREE, CHANGED)).toEqual([]);
  });

  it('returns empty for empty stdout', () => {
    expect(parseCargoClippyNdjson('', WORKTREE, CHANGED)).toEqual([]);
  });

  it('maps error level to Critical (companion to the warning→Nice to have case)', () => {
    const line = JSON.stringify({
      reason: 'compiler-message',
      message: {
        level: 'error',
        message: 'borrow of moved value',
        code: { code: 'E0382' },
        spans: [
          { is_primary: true, file_name: '/work/tree/main.rs', line_start: 7, column_start: 5 },
        ],
      },
    });
    const findings = parseCargoClippyNdjson(line, WORKTREE, CHANGED);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('Critical');
    expect(findings[0].ruleId).toBe('E0382');
  });
});

describe('parseGoVetOutput', () => {
  it('parses go vet line:col form', () => {
    const out = 'cmd/x.go:10:5: error msg';
    const findings = parseGoVetOutput(out, WORKTREE, CHANGED);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      tool: 'go-vet',
      file: 'cmd/x.go',
      line: 10,
      column: 5,
      severity: 'Critical',
      message: 'error msg',
    });
  });

  it('parses go vet line-only form (no column) — column is undefined', () => {
    const out = 'cmd/x.go:42: missing return at end of function';
    const findings = parseGoVetOutput(out, WORKTREE, CHANGED);
    expect(findings).toHaveLength(1);
    expect(findings[0].column).toBeUndefined();
    expect(findings[0].line).toBe(42);
  });

  it('returns empty for empty input', () => {
    expect(parseGoVetOutput('', WORKTREE, CHANGED)).toEqual([]);
  });

  it('filters by changed-files set', () => {
    const out = 'cmd/x.go:1:1: msg\ncmd/skipped.go:1:1: msg';
    const findings = parseGoVetOutput(out, WORKTREE, CHANGED);
    expect(findings.map((f) => f.file)).toEqual(['cmd/x.go']);
  });
});

describe('parseGolangciJson', () => {
  it('parses Issues array and maps severity', () => {
    const json = JSON.stringify({
      Issues: [
        {
          FromLinter: 'errcheck',
          Text: 'unchecked error',
          Severity: 'error',
          Pos: { Filename: '/work/tree/cmd/x.go', Line: 7, Column: 2 },
        },
        {
          FromLinter: 'lint',
          Text: 'style nit',
          Severity: 'warning',
          Pos: { Filename: '/work/tree/cmd/x.go', Line: 9, Column: 1 },
        },
      ],
    });
    const findings = parseGolangciJson(json, WORKTREE, CHANGED);
    expect(findings.map((f) => f.severity)).toEqual([
      'Critical',
      'Nice to have',
    ]);
  });

  it('treats a missing Issues key as zero findings (not a crash)', () => {
    // Older golangci-lint versions / cleanly-passing runs emit `{}`
    // instead of `{Issues: []}`. The optional-chain `parsed.Issues ?? []`
    // must handle that without throwing.
    expect(parseGolangciJson('{}', WORKTREE, CHANGED)).toEqual([]);
  });

  it('returns empty array on JSON parse failure', () => {
    expect(parseGolangciJson('not json', WORKTREE, CHANGED)).toEqual([]);
  });

  it('filters by changed-files set', () => {
    const json = JSON.stringify({
      Issues: [
        { FromLinter: 'x', Text: 'a', Pos: { Filename: '/work/tree/cmd/x.go', Line: 1, Column: 1 } },
        { FromLinter: 'x', Text: 'b', Pos: { Filename: '/work/tree/cmd/skipped.go', Line: 1, Column: 1 } },
      ],
    });
    expect(parseGolangciJson(json, WORKTREE, CHANGED).map((f) => f.file))
      .toEqual(['cmd/x.go']);
  });
});

