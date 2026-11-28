/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { validateReadOnlyBuiltin } from './shellBuiltinValidation.js';

describe('validateReadOnlyBuiltin', () => {
  it('allows echo with literal arguments', () => {
    expect(validateReadOnlyBuiltin(['echo', '---'])).toEqual({
      matched: true,
      readOnly: true,
    });
    expect(validateReadOnlyBuiltin(['echo', '--', '-n'])).toEqual({
      matched: true,
      readOnly: true,
    });
  });

  it('allows printf with a literal format and arguments', () => {
    expect(validateReadOnlyBuiltin(['printf', '%s\\n', 'hello'])).toEqual({
      matched: true,
      readOnly: true,
    });
    expect(validateReadOnlyBuiltin(['printf', '--', '%s', '-value'])).toEqual({
      matched: true,
      readOnly: true,
    });
  });

  it('rejects printf options that can mutate shell state', () => {
    expect(
      validateReadOnlyBuiltin(['printf', '-v', 'result', '%s', 'value']),
    ).toEqual({ matched: true, readOnly: false });
  });

  it('requires literal numeric arguments for arithmetic conversions', () => {
    expect(validateReadOnlyBuiltin(['printf', '%d', '42'])).toEqual({
      matched: true,
      readOnly: true,
    });
    expect(validateReadOnlyBuiltin(['printf', '%d', 'items[index]'])).toEqual({
      matched: true,
      readOnly: false,
    });
  });

  it('rejects the variable-writing %n conversion', () => {
    expect(validateReadOnlyBuiltin(['printf', '%n', 'target'])).toEqual({
      matched: true,
      readOnly: false,
    });
    expect(validateReadOnlyBuiltin(['printf', '%n', '42'])).toEqual({
      matched: true,
      readOnly: false,
    });
    expect(validateReadOnlyBuiltin(['printf', '%%n'])).toEqual({
      matched: true,
      readOnly: true,
    });
  });

  it('rejects printf format escapes that require extra interpretation', () => {
    expect(validateReadOnlyBuiltin(['printf', '%\\123'])).toEqual({
      matched: true,
      readOnly: false,
    });
    expect(validateReadOnlyBuiltin(['printf', '\\u0041'])).toEqual({
      matched: true,
      readOnly: false,
    });
  });

  it('delegates commands covered by existing validators', () => {
    expect(validateReadOnlyBuiltin(['help', '-d', 'cd'])).toEqual({
      matched: false,
    });
    expect(validateReadOnlyBuiltin(['pwd'])).toEqual({ matched: false });
    expect(validateReadOnlyBuiltin(['type', 'node'])).toEqual({
      matched: false,
    });
    expect(validateReadOnlyBuiltin(['eval', 'pwd'])).toEqual({
      matched: false,
    });
    expect(validateReadOnlyBuiltin(['git', 'status'])).toEqual({
      matched: false,
    });
  });
});
