/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { classifyApiError } from './classify-api-error.js';

describe('classifyApiError', () => {
  it('should classify rate limit errors by status code 429', () => {
    expect(classifyApiError({ message: 'error', status: 429 })).toBe(
      'rate_limit',
    );
  });

  it('should classify rate limit errors by message', () => {
    expect(classifyApiError({ message: 'Rate limit exceeded' })).toBe(
      'rate_limit',
    );
  });

  it('should classify authentication errors by status code 401', () => {
    expect(classifyApiError({ message: 'error', status: 401 })).toBe(
      'authentication_failed',
    );
  });

  it('should classify authentication errors by message', () => {
    expect(classifyApiError({ message: 'Unauthorized access' })).toBe(
      'authentication_failed',
    );
  });

  it('should classify billing errors by status code 402', () => {
    expect(classifyApiError({ message: 'error', status: 402 })).toBe(
      'billing_error',
    );
  });

  it('should classify billing errors by status code 403', () => {
    expect(classifyApiError({ message: 'error', status: 403 })).toBe(
      'billing_error',
    );
  });

  it('should classify billing errors by message containing billing', () => {
    expect(classifyApiError({ message: 'Billing issue detected' })).toBe(
      'billing_error',
    );
  });

  it('should classify billing errors by message containing quota', () => {
    expect(classifyApiError({ message: 'Quota exceeded' })).toBe(
      'billing_error',
    );
  });

  it('should classify invalid request errors by status code 400', () => {
    expect(classifyApiError({ message: 'error', status: 400 })).toBe(
      'invalid_request',
    );
  });

  it('should classify invalid request errors by message', () => {
    expect(classifyApiError({ message: 'Invalid request format' })).toBe(
      'invalid_request',
    );
  });

  it('should classify server errors by status code 500', () => {
    expect(classifyApiError({ message: 'error', status: 500 })).toBe(
      'server_error',
    );
  });

  it('should classify server errors by status code 502', () => {
    expect(classifyApiError({ message: 'error', status: 502 })).toBe(
      'server_error',
    );
  });

  it('should classify server errors by status code 503', () => {
    expect(classifyApiError({ message: 'error', status: 503 })).toBe(
      'server_error',
    );
  });

  it('should classify max output tokens errors by message', () => {
    expect(classifyApiError({ message: 'max_tokens limit reached' })).toBe(
      'max_output_tokens',
    );
  });

  it('should classify token limit errors by message', () => {
    expect(classifyApiError({ message: 'Token limit exceeded' })).toBe(
      'max_output_tokens',
    );
  });

  it('should return unknown for unrecognized errors', () => {
    expect(classifyApiError({ message: 'Some random error' })).toBe('unknown');
  });

  it('should return unknown for empty message', () => {
    expect(classifyApiError({ message: '' })).toBe('unknown');
  });

  it('should handle case insensitive matching', () => {
    expect(classifyApiError({ message: 'RATE LIMIT exceeded' })).toBe(
      'rate_limit',
    );
    expect(classifyApiError({ message: 'UNAUTHORIZED' })).toBe(
      'authentication_failed',
    );
    expect(classifyApiError({ message: 'BILLING error' })).toBe(
      'billing_error',
    );
  });
});
