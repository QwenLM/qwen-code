/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  stringifyWorkflowResult,
  truncateWorkflowText,
} from './workflow-result-format.js';

describe('workflow result formatting', () => {
  it('shares result semantics between compact notifications and pretty tool cards', () => {
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
