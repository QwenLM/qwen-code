/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildFailureLines,
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
