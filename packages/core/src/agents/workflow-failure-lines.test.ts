/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildFailureLines,
  reportedFailureLines,
  MAX_FAILURE_LINE_CHARS,
  MAX_FAILURE_LINES,
} from './workflow-failure-lines.js';

describe('buildFailureLines', () => {
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
          { status: 'failed', label: '\u001b[31mbad', error: 'boom\u0000' },
        ],
      }),
    ).toEqual(['[bad] boom']);
  });
});

describe('reportedFailureLines', () => {
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
