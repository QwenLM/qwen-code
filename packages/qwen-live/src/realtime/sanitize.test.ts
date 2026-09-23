/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { escapeAnsiCtrlCodes } from './sanitize.js';

describe('escapeAnsiCtrlCodes', () => {
  it('escapes ANSI escape sequences into their JSON-escaped form', () => {
    expect(escapeAnsiCtrlCodes('\u001b[31mred\u001b[0m')).toBe(
      '\\u001b[31mred\\u001b[0m',
    );
  });

  it('escapes consistently on repeated calls despite the shared global regex', () => {
    // The module holds one global regex whose lastIndex must be reset
    // between uses; a stale lastIndex would skip leading matches.
    expect(escapeAnsiCtrlCodes('\u001b[2Jcleared')).toBe('\\u001b[2Jcleared');
    expect(escapeAnsiCtrlCodes('\u001b[2Jcleared')).toBe('\\u001b[2Jcleared');
  });

  it('returns clean strings unchanged', () => {
    const clean = 'Realtime provider rejected the request (429).';
    expect(escapeAnsiCtrlCodes(clean)).toBe(clean);
    expect(escapeAnsiCtrlCodes('')).toBe('');
  });
});
