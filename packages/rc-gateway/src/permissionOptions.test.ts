/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { selectAllowOnceOptionId } from './permissionOptions.js';

describe('selectAllowOnceOptionId', () => {
  it('picks the allow_once option, NOT options[0] (which is allow_always)', () => {
    expect(
      selectAllowOnceOptionId([
        { optionId: 'always', kind: 'allow_always' },
        { optionId: 'once', kind: 'allow_once' },
        { optionId: 'no', kind: 'reject_once' },
      ]),
    ).toBe('once');
  });

  it('returns undefined when there is NO allow_once option (fail-safe → caller must not vote)', () => {
    expect(
      selectAllowOnceOptionId([
        { optionId: 'always', kind: 'allow_always' },
        { optionId: 'no', kind: 'reject_once' },
      ]),
    ).toBeUndefined();
  });

  it('returns undefined for a non-array, empty, or malformed option list', () => {
    expect(selectAllowOnceOptionId(undefined)).toBeUndefined();
    expect(selectAllowOnceOptionId(null)).toBeUndefined();
    expect(selectAllowOnceOptionId('nope')).toBeUndefined();
    expect(selectAllowOnceOptionId([])).toBeUndefined();
    expect(selectAllowOnceOptionId([{ kind: 'allow_once' }])).toBeUndefined(); // no optionId
    expect(
      selectAllowOnceOptionId([{ optionId: 123, kind: 'allow_once' }]),
    ).toBeUndefined(); // non-string optionId
  });
});
