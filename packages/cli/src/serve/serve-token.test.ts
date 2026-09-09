/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveServeToken, resolveRemoteServeToken } from './serve-token.js';

// Passing `undefined` as the environmentToken argument falls through to the
// default parameter, which reads the real process env; pin it empty so an
// ambient QWEN_SERVER_TOKEN cannot flip the generation decisions.
afterEach(() => {
  vi.unstubAllEnvs();
});

it('generates fresh strong credentials only for remote binds with absent sources', () => {
  vi.stubEnv('QWEN_SERVER_TOKEN', undefined);
  const first = resolveRemoteServeToken(undefined, false, undefined);
  expect(first.generated).toBe(true);
  expect(first.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(resolveRemoteServeToken(undefined, false, undefined).token).not.toBe(
    first.token,
  );
  expect(resolveRemoteServeToken(undefined, true, undefined)).toEqual({
    token: undefined,
    generated: false,
  });
  expect(resolveRemoteServeToken('', false, 'env')).toEqual({
    token: undefined,
    generated: false,
  });
  expect(resolveRemoteServeToken(undefined, false, ' ')).toEqual({
    token: undefined,
    generated: false,
  });
  expect(resolveRemoteServeToken(' flag ', false, 'env')).toEqual({
    token: 'flag',
    generated: false,
  });
});

it('passes a supplied environment token through without generating', () => {
  expect(resolveRemoteServeToken(undefined, false, ' env-token ')).toEqual({
    token: 'env-token',
    generated: false,
  });
});

describe('resolveServeToken', () => {
  it('prefers and trims the CLI option', () => {
    expect(resolveServeToken('  from-option  ', 'from-env')).toBe(
      'from-option',
    );
  });

  it('trims the environment fallback', () => {
    expect(resolveServeToken(undefined, '  from-env\n')).toBe('from-env');
  });

  it('keeps an explicitly empty option ahead of the environment', () => {
    expect(resolveServeToken('', 'from-env')).toBeUndefined();
    expect(resolveServeToken('   ', 'from-env')).toBeUndefined();
  });
});
