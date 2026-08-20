/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { isFunctionCall, isFunctionResponse } from './messageInspectors.js';

describe('isFunctionResponse', () => {
  it('is true when every user part is a function response', () => {
    const content: Content = {
      role: 'user',
      parts: [{ functionResponse: { name: 'f', response: {} } }],
    };
    expect(isFunctionResponse(content)).toBe(true);
  });

  it('is false when a user part is not a function response', () => {
    const content: Content = { role: 'user', parts: [{ text: 'hi' }] };
    expect(isFunctionResponse(content)).toBe(false);
  });

  it('is false for a user message with no parts', () => {
    // [].every(...) is vacuously true, so an empty user turn would otherwise be
    // misread as a function-response turn — it carries no function responses.
    expect(isFunctionResponse({ role: 'user', parts: [] })).toBe(false);
  });
});

describe('isFunctionCall', () => {
  it('is true when every model part is a function call', () => {
    const content: Content = {
      role: 'model',
      parts: [{ functionCall: { name: 'f', args: {} } }],
    };
    expect(isFunctionCall(content)).toBe(true);
  });

  it('is false for a model message with no parts', () => {
    expect(isFunctionCall({ role: 'model', parts: [] })).toBe(false);
  });
});
