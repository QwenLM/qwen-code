/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { detectPermissionError } from './permission-detector.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

function textErrorResult(text: string): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

describe('detectPermissionError', () => {
  it('returns "none" when isError is false', () => {
    expect(
      detectPermissionError({
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    ).toBe('none');
  });

  it('detects accessibility missing (cua-driver "Accessibility: NOT granted")', () => {
    expect(
      detectPermissionError(textErrorResult('❌ Accessibility: NOT granted.')),
    ).toBe('accessibility');
  });

  it('detects screen recording missing (cua-driver "Screen Recording: missing")', () => {
    expect(
      detectPermissionError(
        textErrorResult(
          '✅ Accessibility: granted.\n❌ Screen Recording: missing.',
        ),
      ),
    ).toBe('screenRecording');
  });

  it('detects via the generic "needs your permission" fallback', () => {
    expect(
      detectPermissionError(
        textErrorResult(
          'cua-driver needs your permission before `serve` can start.',
        ),
      ),
    ).toBe('unknown_permission');
  });

  it('detects via the generic "Missing TCC grant" fallback', () => {
    expect(
      detectPermissionError(
        textErrorResult('Missing TCC grant(s) for this process.'),
      ),
    ).toBe('unknown_permission');
  });

  it('returns "other" for unrelated errors', () => {
    expect(
      detectPermissionError(textErrorResult('appNotFound("ImaginaryApp")')),
    ).toBe('other');
  });
});
