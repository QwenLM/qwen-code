/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createModelContent as createSdkModelContent,
  createUserContent as createSdkUserContent,
  FinishReason as SdkFinishReason,
  FunctionCallingConfigMode as SdkFunctionCallingConfigMode,
} from '@google/genai';
import {
  createModelContent,
  createUserContent,
  FinishReason,
  FunctionCallingConfigMode,
} from './genai-compat.js';

describe('genai compatibility values', () => {
  it('matches the SDK values used by core orchestration', () => {
    expect(FinishReason).toEqual({
      STOP: SdkFinishReason.STOP,
      MAX_TOKENS: SdkFinishReason.MAX_TOKENS,
    });
    expect(FunctionCallingConfigMode).toEqual({
      ANY: SdkFunctionCallingConfigMode.ANY,
    });
  });

  it.each([
    'hello',
    { text: 'hello' },
    ['hello', { inlineData: { mimeType: 'text/plain', data: 'aGVsbG8=' } }],
  ])('matches SDK content conversion for %j', (value) => {
    expect(createUserContent(value)).toEqual(createSdkUserContent(value));
    expect(createModelContent(value)).toEqual(createSdkModelContent(value));
  });

  it.each([
    [[], 'partOrString cannot be an empty array'],
    [{ role: 'user', parts: [] }, 'partOrString must be a Part object'],
    [[{ invalid: true }], 'element in PartUnion must be a Part object'],
  ])('matches SDK validation for %j', (value, message) => {
    expect(() => createUserContent(value as never)).toThrow(message);
    expect(() => createSdkUserContent(value as never)).toThrow(message);
  });
});
