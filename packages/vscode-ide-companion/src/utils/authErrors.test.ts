/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { extractAuthMethodsFromError } from './authErrors.js';

describe('extractAuthMethodsFromError', () => {
  it('returns null for null/undefined', () => {
    expect(extractAuthMethodsFromError(null)).toBeNull();
    expect(extractAuthMethodsFromError(undefined)).toBeNull();
  });

  it('returns null for non-object', () => {
    expect(extractAuthMethodsFromError('string error')).toBeNull();
    expect(extractAuthMethodsFromError(42)).toBeNull();
  });

  it('extracts from top-level data.authMethods', () => {
    const methods = [{ id: 'oauth', name: 'OAuth' }];
    const error = { data: { authMethods: methods } };
    expect(extractAuthMethodsFromError(error)).toBe(methods);
  });

  it('extracts from nested error.data.authMethods', () => {
    const methods = [{ id: 'coding-plan', name: 'Coding Plan' }];
    const error = { error: { data: { authMethods: methods } } };
    expect(extractAuthMethodsFromError(error)).toBe(methods);
  });

  it('returns null when authMethods is not an array', () => {
    const error = { data: { authMethods: 'not-an-array' } };
    expect(extractAuthMethodsFromError(error)).toBeNull();
  });

  it('returns null when data has no authMethods', () => {
    const error = { data: { otherField: 'value' } };
    expect(extractAuthMethodsFromError(error)).toBeNull();
  });

  it('prefers top-level data over nested error.data', () => {
    const topMethods = [{ id: 'top' }];
    const nestedMethods = [{ id: 'nested' }];
    const error = {
      data: { authMethods: topMethods },
      error: { data: { authMethods: nestedMethods } },
    };
    expect(extractAuthMethodsFromError(error)).toBe(topMethods);
  });
});
