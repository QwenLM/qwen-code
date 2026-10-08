/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import {
  buildWorkflowResultPreview,
  isWorkflowResultPreview,
  MAX_WORKFLOW_RESULT_PREVIEW_CHARS,
} from './workflow-result-preview.js';
import { MAX_FAILURE_LINE_CHARS } from './workflow-failure-lines.js';

const MARKER = '… (truncated)';

describe('buildWorkflowResultPreview', () => {
  it.each([
    [undefined, '(workflow returned no value)'],
    [null, 'null'],
    [false, 'false'],
    [0, '0'],
    ['', '""'],
    ['plain text', 'plain text'],
  ])('keeps %j distinct', (value, text) => {
    expect(buildWorkflowResultPreview(value)).toEqual({
      text,
      truncated: false,
      reportedFailures: [],
    });
  });

  it('pretty-prints objects across lines', () => {
    expect(buildWorkflowResultPreview({ a: 1, b: [2] }).text).toBe(
      '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}',
    );
  });

  // Workflow scripts run in their own VM context, where instanceof fails.
  it('keeps the name and message of Errors and the contents of Maps and Sets from another context', () => {
    const value = vm.runInNewContext(
      '({ err: new TypeError("boom"), map: new Map([["k", 1]]), set: new Set(["v"]), errors: [new Error("lost")] })',
    );
    const preview = buildWorkflowResultPreview(value);
    expect(JSON.parse(preview.text)).toEqual({
      err: 'TypeError: boom',
      map: [['k', 1]],
      set: ['v'],
      errors: ['Error: lost'],
    });
    expect(preview.reportedFailures).toEqual([
      'Reported errors: ["Error: lost"]',
    ]);
  });

  it('still extracts reported failures from a value it cannot stringify', () => {
    const value = vm.runInNewContext(
      'const o = { errors: [new Error("cycle")], failed: ["a"] }; o.self = o; o',
    );
    const preview = buildWorkflowResultPreview(value);
    expect(preview.text).toMatch(/non-JSON-serializable/);
    expect(preview.reportedFailures).toEqual([
      'Reported failed: ["a"]',
      'Reported errors: ["Error: cycle"]',
    ]);
  });

  it('degrades a BigInt to a placeholder', () => {
    expect(buildWorkflowResultPreview({ n: 10n }).text).toMatch(
      /non-JSON-serializable/,
    );
  });

  it('degrades a value whose formatting throws instead of throwing', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(buildWorkflowResultPreview(proxy)).toEqual({
      text: expect.any(String),
      truncated: false,
      reportedFailures: [],
    });
    const hostile = {
      toJSON() {
        throw new Error('no');
      },
      get failed() {
        throw new Error('no');
      },
    };
    expect(buildWorkflowResultPreview(hostile)).toEqual({
      text: expect.stringMatching(/non-JSON-serializable/),
      truncated: false,
      reportedFailures: [],
    });
  });

  it('removes terminal and bidi controls but keeps lines and indentation', () => {
    expect(
      buildWorkflowResultPreview('\x1b[31mred\x1b[0m\ttab‮bidi\nline2\x07')
        .text,
    ).toBe('red  tabbidi\nline2');
  });

  it('keeps a result at the limit whole and bounds one past it, marker included', () => {
    const exact = 'a'.repeat(MAX_WORKFLOW_RESULT_PREVIEW_CHARS);
    expect(buildWorkflowResultPreview(exact)).toMatchObject({
      text: exact,
      truncated: false,
    });
    const over = buildWorkflowResultPreview(`${exact}b`);
    expect(over.truncated).toBe(true);
    expect(over.text).toHaveLength(MAX_WORKFLOW_RESULT_PREVIEW_CHARS);
    expect(over.text.endsWith(MARKER)).toBe(true);
  });

  it('does not split a surrogate pair at the cut', () => {
    const cut = MAX_WORKFLOW_RESULT_PREVIEW_CHARS - MARKER.length;
    const preview = buildWorkflowResultPreview(
      `${'a'.repeat(cut - 1)}😀${'b'.repeat(100)}`,
    );
    expect(preview.text).toBe(`${'a'.repeat(cut - 1)}${MARKER}`);
    expect(preview.text).not.toMatch(/[\uD800-\uDFFF]/);
  });
});

describe('isWorkflowResultPreview', () => {
  const valid = { text: 'x', truncated: false, reportedFailures: ['r'] };

  it('accepts what buildWorkflowResultPreview produces', () => {
    expect(isWorkflowResultPreview(valid)).toBe(true);
    expect(
      isWorkflowResultPreview(
        buildWorkflowResultPreview({
          failed: ['x'.repeat(1000)],
          errors: 'y'.repeat(1000),
          error: 'z',
          rest: 'r'.repeat(MAX_WORKFLOW_RESULT_PREVIEW_CHARS),
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ['not an object', 'text'],
    ['an array', []],
    ['a text that is not a string', { ...valid, text: 1 }],
    [
      'a text past the bound',
      { ...valid, text: 'x'.repeat(MAX_WORKFLOW_RESULT_PREVIEW_CHARS + 1) },
    ],
    ['a truncated flag that is not boolean', { ...valid, truncated: 'no' }],
    ['missing failures', { text: 'x', truncated: false }],
    ['too many failures', { ...valid, reportedFailures: ['a', 'b', 'c', 'd'] }],
    ['a failure that is not a string', { ...valid, reportedFailures: [{}] }],
    [
      'a failure past the bound',
      {
        ...valid,
        reportedFailures: ['x'.repeat(MAX_FAILURE_LINE_CHARS + 1)],
      },
    ],
  ])('rejects %s', (_label, value) => {
    expect(isWorkflowResultPreview(value)).toBe(false);
  });
});
