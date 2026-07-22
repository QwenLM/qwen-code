/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  INTERNAL_SECRET_ENV_VARS,
  sanitizeChildEnv,
} from './sanitize-child-env.js';

describe('sanitizeChildEnv', () => {
  it('removes Qwen-internal daemon/server secrets', () => {
    const result = sanitizeChildEnv({
      QWEN_SERVER_TOKEN: 'super-secret',
      QWEN_DAEMON_TOKEN: 'also-secret',
      PATH: '/usr/bin',
    });
    expect(result['QWEN_SERVER_TOKEN']).toBeUndefined();
    expect(result['QWEN_DAEMON_TOKEN']).toBeUndefined();
  });

  it('preserves benign vars and third-party credentials that shell workflows need', () => {
    const result = sanitizeChildEnv({
      QWEN_SERVER_TOKEN: 'super-secret',
      PATH: '/usr/bin',
      GH_TOKEN: 'gh-abc',
      GITHUB_TOKEN: 'gh-def',
      AWS_ACCESS_KEY_ID: 'aws-key',
      NPM_TOKEN: 'npm-tok',
      HOME: '/home/user',
    });
    expect(result['PATH']).toBe('/usr/bin');
    expect(result['GH_TOKEN']).toBe('gh-abc');
    expect(result['GITHUB_TOKEN']).toBe('gh-def');
    expect(result['AWS_ACCESS_KEY_ID']).toBe('aws-key');
    expect(result['NPM_TOKEN']).toBe('npm-tok');
    expect(result['HOME']).toBe('/home/user');
  });

  it('does not mutate the input environment', () => {
    const source: NodeJS.ProcessEnv = {
      QWEN_SERVER_TOKEN: 'super-secret',
      PATH: '/usr/bin',
    };
    sanitizeChildEnv(source);
    expect(source['QWEN_SERVER_TOKEN']).toBe('super-secret');
  });

  it('returns a fresh object each call', () => {
    const source: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const a = sanitizeChildEnv(source);
    const b = sanitizeChildEnv(source);
    expect(a).not.toBe(source);
    expect(a).not.toBe(b);
  });

  it('is a no-op for an env without internal secrets', () => {
    const result = sanitizeChildEnv({ PATH: '/usr/bin', GH_TOKEN: 'x' });
    expect(result).toEqual({ PATH: '/usr/bin', GH_TOKEN: 'x' });
  });

  it('keeps the denylist scoped to internal secrets only', () => {
    // Guardrail: this list must not grow to include third-party credentials,
    // which the shell tool legitimately inherits (see #6601 discussion).
    expect([...INTERNAL_SECRET_ENV_VARS].sort()).toEqual([
      'QWEN_DAEMON_TOKEN',
      'QWEN_SERVER_TOKEN',
    ]);
  });
});
