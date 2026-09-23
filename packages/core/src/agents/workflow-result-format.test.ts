/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  stringifyWorkflowResult,
  truncateWorkflowText,
} from './workflow-result-format.js';

describe('workflow result formatting', () => {
  it('retains the message of an Error created in a different VM realm', () => {
    const failure: unknown = runInContext(
      'new Error("disk full")',
      createContext({}),
    );
    expect(failure).not.toBeInstanceOf(Error);
    expect(Object.prototype.toString.call(failure)).toBe('[object Error]');
    expect(stringifyWorkflowResult(failure)).toContain('disk full');
  });

  it('retains nested VM Error messages in compact and pretty results', () => {
    const failure: unknown = runInContext(
      'new Error("disk full")',
      createContext({}),
    );
    for (const pretty of [false, true]) {
      expect(stringifyWorkflowResult({ errors: [failure] }, pretty)).toContain(
        'disk full',
      );
    }
  });

  it('keeps the fallback for a circular result containing an Error', () => {
    const result: { error: Error; self?: unknown } = {
      error: new Error('disk full'),
    };
    result.self = result;
    expect(stringifyWorkflowResult(result)).toBe(
      '(workflow returned a non-JSON-serializable value of type object)',
    );
  });

  it('renders an Error without a stack using its name and message', () => {
    const error = new TypeError('invalid input');
    error.stack = undefined;
    expect(stringifyWorkflowResult(error)).toBe('TypeError: invalid input');
  });

  it('shares result semantics between compact notifications and pretty tool results', () => {
    for (const pretty of [false, true]) {
      expect(stringifyWorkflowResult(undefined, pretty)).toBe(
        '(workflow returned no value)',
      );
      expect(stringifyWorkflowResult('plain', pretty)).toBe('plain');
      expect(stringifyWorkflowResult(null, pretty)).toBe('null');
      expect(stringifyWorkflowResult(1n, pretty)).toContain(
        'non-JSON-serializable',
      );
    }
    expect(stringifyWorkflowResult({ ok: true })).toBe('{"ok":true}');
    expect(stringifyWorkflowResult({ ok: true }, true)).toBe(
      '{\n  "ok": true\n}',
    );
  });

  it('includes the marker in the cap and never splits a Unicode pair', () => {
    const text =
      'x'.repeat(399 - '… (truncated)'.length) + '🙂' + 'tail'.repeat(20);
    const preview = truncateWorkflowText(text, 400);
    expect(preview).toHaveLength(399);
    expect(preview).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(preview).toMatch(/… \(truncated\)$/);
    expect(truncateWorkflowText('hello', 400)).toBe('hello');
  });
});
