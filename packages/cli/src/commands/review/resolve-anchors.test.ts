/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { validateRequests } from './resolve-anchors.js';

const ok = { id: 'f1', path: 'src/a.ts', anchor: 'const x = 1;' };

describe('validateRequests', () => {
  it('accepts a well-formed batch and keeps an optional claimed line', () => {
    expect(validateRequests([ok, { ...ok, id: 'f2', line: 7 }])).toEqual([
      { id: 'f1', path: 'src/a.ts', anchor: 'const x = 1;' },
      { id: 'f2', path: 'src/a.ts', anchor: 'const x = 1;', line: 7 },
    ]);
  });

  it('rejects duplicate ids rather than resolving them into a wrong answer', () => {
    // The report splits into `resolved` and `unmatched`, so the caller cannot
    // re-join by position — it joins by id. Two findings sharing an id means one
    // of them gets the other's line, and a comment lands on code it is not
    // about. That failure is silent and looks exactly like success, so the
    // duplicate is refused at the door.
    expect(() => validateRequests([ok, { ...ok, anchor: 'other();' }])).toThrow(
      /Duplicate finding id\(s\): f1/,
    );
  });

  it('rejects a missing or empty anchor', () => {
    expect(() => validateRequests([{ id: 'f1', path: 'src/a.ts' }])).toThrow(
      /"anchor"/,
    );
    expect(() => validateRequests([{ ...ok, anchor: '' }])).toThrow(/"anchor"/);
  });

  it('rejects a non-numeric claimed line', () => {
    expect(() => validateRequests([{ ...ok, line: '42' }])).toThrow(
      /non-numeric "line"/,
    );
  });

  it('rejects input that is not an array', () => {
    expect(() => validateRequests({ id: 'f1' })).toThrow(/JSON array/);
  });
});
