/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseToolInput,
  hasUnparsedToolInput,
  toolInputFailureMessage,
} from '../tool-input.js';

describe('strict tool input', () => {
  it.each(['{"a":', '{a: 1}', "{'a':1}", '{"a":1,}', '{"a":"\u0000"}'])(
    'never repairs %s',
    (raw) => {
      const input = parseToolInput(raw);
      expect(hasUnparsedToolInput(JSON.parse(JSON.stringify(input)))).toBe(
        true,
      );
      expect(toolInputFailureMessage(input)).toContain('JSON_PARSE');
    },
  );
  it.each(['null', '[]', '1', 'true', '"text"'])(
    'distinguishes invalid root shape %s',
    (raw) => {
      expect(toolInputFailureMessage(parseToolInput(raw))).toContain(
        'INVALID_TOOL_PARAMS',
      );
    },
  );
  it('keeps valid objects, escaped NUL, Unicode and empty inputs', () => {
    expect(parseToolInput(' {"text":"中文\\u0000"} ')).toEqual({
      text: '中文\0',
    });
    expect(parseToolInput(' \n')).toEqual({});
  });
  it('bounds malformed evidence and rejects even a malformed reserved marker', () => {
    const input = parseToolInput('x'.repeat(10_000));
    expect(JSON.stringify(input).length).toBeLessThan(2200);
    expect(
      toolInputFailureMessage({ __qwen_unparsed_tool_input: null, other: 1 }),
    ).toContain('JSON_PARSE');
  });
});
