/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  buildFailureLines,
  reportedFailureLines,
  MAX_FAILURE_LINE_CHARS,
  MAX_FAILURE_LINES,
} from './workflow-failure-lines.js';

describe('buildFailureLines', () => {
  it('keeps a dispatch failure Unicode pair intact at the line limit', () => {
    const [line] = buildFailureLines({
      runId: 'wf_reporting',
      dispatches: [
        { status: 'failed', label: 'a', error: 'x'.repeat(395) + '🙂' },
      ],
    });
    expect(line.length).toBeLessThanOrEqual(MAX_FAILURE_LINE_CHARS);
    expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(line).toContain('… (truncated)');
  });

  it('bounds each rendered failure and reports an honest omitted count', () => {
    const lines = buildFailureLines({
      runId: 'wf_1',
      dispatches: Array.from({ length: MAX_FAILURE_LINES + 2 }, (_, index) => ({
        status: 'failed',
        label: `agent-${index}`,
        error: 'x'.repeat(4_096),
      })),
    });

    expect(lines).toHaveLength(MAX_FAILURE_LINES + 1);
    expect(
      lines
        .slice(0, MAX_FAILURE_LINES)
        .every((line) => line.length === MAX_FAILURE_LINE_CHARS),
    ).toBe(true);
    expect(lines.at(-1)).toBe('… and 2 more failures omitted');
  });

  it('sanitizes labels and errors before rendering', () => {
    expect(
      buildFailureLines({
        runId: 'wf_1',
        dispatches: [
          {
            status: 'failed',
            label: '\u001b[31mbad',
            error: 'boom\n\tat run\u0000',
          },
        ],
      }),
    ).toEqual(['[bad] boom\n  at run']);
  });
});

describe('reportedFailureLines', () => {
  it('retains a VM Error message in the reported failure field', () => {
    const failure: unknown = runInContext(
      'new Error("disk full")',
      createContext({}),
    );
    expect(reportedFailureLines({ error: failure })[0]).toContain('disk full');
    expect(reportedFailureLines({ errors: [failure] })[0]).toContain(
      'disk full',
    );
  });

  it('retains each VM Error reason within the failure-field budget', () => {
    const errors: unknown = runInContext(
      `['agent A: rate limited', 'agent B: timeout', 'agent C: oom'].map(message => new Error(message))`,
      createContext({}),
    );
    expect(reportedFailureLines({ errors })).toEqual([
      'Reported errors: ["Error: agent A: rate limited","Error: agent B: timeout","Error: agent C: oom"]',
    ]);
  });

  it.each([
    [
      'Map',
      `new Map([['agent-1', 'rate limited']])`,
      '[["agent-1","rate limited"]]',
    ],
    ['Set', `new Set(['agent-1: rate limited'])`, '["agent-1: rate limited"]'],
  ])(
    'retains a populated VM %s failure value',
    (_name, expression, expected) => {
      const failure: unknown = runInContext(expression, createContext({}));
      expect(reportedFailureLines({ failed: failure })).toEqual([
        `Reported failed: ${expected}`,
      ]);
    },
  );

  it.each([
    ['plain object', {}],
    ['null-prototype object', Object.create(null) as object],
    ['Map', new Map()],
    ['Set', new Set()],
  ])('omits an empty %s failure value', (_name, failure) => {
    expect(reportedFailureLines({ rows: 1, failed: failure })).toEqual([]);
  });

  it.each([
    ['ANSI', '\u001b[31m\u001b[0m'],
    ['newline', '\n'],
    ['bell', '\u0007'],
  ])('omits a %s-only error value', (_name, error) => {
    expect(reportedFailureLines({ error })).toEqual([]);
  });

  it('keeps nonempty failures when another field has no visible content', () => {
    expect(reportedFailureLines({ failed: ['fr'], error: '\n' })).toEqual([
      'Reported failed: ["fr"]',
    ]);
  });

  it('retains stack-trace line breaks and separates tabbed columns', () => {
    expect(
      reportedFailureLines({ error: 'Error: boom\nat run (wf.js:3)\na\tb' }),
    ).toEqual(['Reported error: Error: boom\nat run (wf.js:3)\na  b']);
  });

  it('retains serialized failure details and literal JSON-looking strings', () => {
    class FailureRecord {
      toJSON() {
        return { reason: 'disk full' };
      }
    }
    expect(
      reportedFailureLines({ errors: new FailureRecord(), error: '{}' }),
    ).toEqual([
      'Reported errors: {"reason":"disk full"}',
      'Reported error: {}',
    ]);
  });

  it('bounds script-reported failures inside the shared formatter', () => {
    const lines = reportedFailureLines({
      failed: Array(5_000).fill('x'.repeat(200)),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Reported failed:');
    expect(lines[0]).toContain('… (truncated)');
    expect(lines[0].length).toBeLessThanOrEqual(MAX_FAILURE_LINE_CHARS);
  });

  it('preserves the other fields when a getter throws and escapes terminal controls', () => {
    expect(
      reportedFailureLines({
        failed: ['fr'],
        get errors() {
          throw new Error('unreadable');
        },
        error: '\u001b[31mboom\u001b[0m\u0007',
      }),
    ).toEqual(['Reported failed: ["fr"]', 'Reported error: boom']);
  });
});
