/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseWireRows } from './wire-rows.js';

describe('parseWireRows', () => {
  it('returns no rows for an empty buffer', () => {
    expect(parseWireRows('')).toEqual([]);
  });

  it('returns no rows when the only row has no trailing newline yet', () => {
    expect(parseWireRows('{"kind":"a"}')).toEqual([]);
  });

  it('drops an unterminated tail and keeps the complete rows', () => {
    // Two complete rows keep lastIndexOf -> indexOf observable; with a single
    // complete row that mutant survives.
    expect(parseWireRows('{"kind":"a"}\n{"kind":"b"}\n{"kind":"c"')).toEqual([
      { kind: 'a' },
      { kind: 'b' },
    ]);
  });

  it('returns one row for a single terminated row', () => {
    expect(parseWireRows('{"kind":"a"}\n')).toEqual([{ kind: 'a' }]);
  });

  it('returns no rows for a buffer that is only a newline', () => {
    expect(parseWireRows('\n')).toEqual([]);
  });

  it('still throws on a malformed complete row', () => {
    expect(() => parseWireRows('{"kind":"a"}\n{"kind":\n')).toThrow(
      SyntaxError,
    );
  });
});
