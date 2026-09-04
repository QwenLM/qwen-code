/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseToolCallArguments } from './tool-call-arguments.js';

describe('parseToolCallArguments', () => {
  it('returns a parsed JSON object', () => {
    expect(parseToolCallArguments('{"path":"a.sql"}')).toEqual({
      ok: true,
      value: { path: 'a.sql' },
    });
  });

  it.each(['', '{"path":'])('classifies malformed JSON: %s', (json) => {
    expect(parseToolCallArguments(json)).toEqual({
      ok: false,
      reason: 'MALFORMED_JSON',
    });
  });

  it.each(['[]', 'null', '42', 'true', '"text"'])(
    'classifies a non-object JSON root: %s',
    (json) => {
      expect(parseToolCallArguments(json)).toEqual({
        ok: false,
        reason: 'NON_OBJECT',
      });
    },
  );
});
