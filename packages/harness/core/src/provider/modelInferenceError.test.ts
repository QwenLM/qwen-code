/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ClientError } from '../client/clientError.js';
import { classifyClientError } from './modelInferenceError.js';

describe('Provider prompt-too-long classification', () => {
  it.each([new Error('Too many tokens'), 'Prompt is too long', { status: 413 }])(
    'normalizes unclassified transport failures before consumption: %s', (error) => {
      expect(classifyClientError(error).kind).toBe('prompt_too_long');
    },
  );
  it.each([
    'Too many tokens in request',
    'Request payload size exceeds the limit',
    'Input tokens exceed the configured limit of 922000 tokens',
    'Prompt is too long',
    'Prompt exceeds max length',
    'Input is too long',
    'Maximum context length exceeded',
    'Content too large for model',
    'Range of input length should be [1, 983616]',
    'INVALID_ARGUMENT: requested token count is invalid',
  ])('classifies message: %s', (message) => {
    expect(classifyClientError(new ClientError(message, { statusCode: 400 })).kind)
      .toBe('prompt_too_long');
  });

  it('uses the upstream error.message and preserves diagnostic fields', () => {
    expect(classifyClientError(new ClientError('Request failed', {
      statusCode: 400,
      requestId: 'request-id',
      responseBody: JSON.stringify({ error: {
        code: 'invalid_parameter_error', message: 'Range of input length should be [1, 983616]',
      } }),
    }))).toMatchObject({ kind: 'prompt_too_long', status: 400,
      code: 'invalid_parameter_error', requestId: 'request-id' });
  });

  it('keeps explicit quota and authentication classifications ahead of text', () => {
    for (const [code, kind] of [['insufficient_quota', 'quota_exhausted'], ['authentication_error', 'auth']]) {
      expect(classifyClientError(new ClientError('Too many tokens', { code, statusCode: 400 })).kind).toBe(kind);
    }
  });

  it('classifies explicit PTL wire codes and HTTP 413 without keywords', () => {
    expect(classifyClientError(new ClientError('Rejected', { code: 'context_length_exceeded', statusCode: 400 })).kind).toBe('prompt_too_long');
    expect(classifyClientError(new ClientError('Rejected', { statusCode: 413 })).kind).toBe('prompt_too_long');
  });

  it('keeps unrelated validation failures as invalid_request', () => {
    expect(classifyClientError(new ClientError('Invalid tool schema', { statusCode: 400 })).kind).toBe('invalid_request');
  });
});
