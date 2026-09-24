/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  INTERNAL_SECRET_ENV_VARS,
  isInternalSecretEnvVar,
  sanitizeChildEnv,
} from './sanitize-child-env.js';

describe('sanitizeChildEnv', () => {
  it('removes Qwen-internal secrets', () => {
    const result = sanitizeChildEnv({
      QWEN_SERVER_TOKEN: 'super-secret',
      QWEN_DAEMON_TOKEN: 'also-secret',
      QWEN_CODE_PRIVATE_ACP_CAPABILITY: 'private-capability',
      PATH: '/usr/bin',
    });
    expect(result['QWEN_SERVER_TOKEN']).toBeUndefined();
    expect(result['QWEN_DAEMON_TOKEN']).toBeUndefined();
    expect(result['QWEN_CODE_PRIVATE_ACP_CAPABILITY']).toBeUndefined();
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
      'QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN',
      'QWEN_CODE_PRIVATE_ACP_CAPABILITY',
      'QWEN_DAEMON_TOKEN',
      'QWEN_SERVER_TOKEN',
    ]);
  });

  it('removes internal secrets regardless of key casing', () => {
    // process.env is case-insensitive on Windows, so a lower- or mixed-case
    // key reads the same value there; the copy must not keep it either.
    const result = sanitizeChildEnv({
      qwen_server_token: 'super-secret',
      Qwen_Daemon_Token: 'also-secret',
      QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN: 'guard',
      PATH: '/usr/bin',
    });
    expect(result).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps an own __proto__ variable like any other (computed key, not a prototype literal)', () => {
    const result = sanitizeChildEnv({
      ['__proto__']: 'keep',
      QWEN_SERVER_TOKEN: 'super-secret',
      PATH: '/usr/bin',
    });
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(
      true,
    );
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toBe(
      'keep',
    );
    expect(result['QWEN_SERVER_TOKEN']).toBeUndefined();
  });
});

describe('isInternalSecretEnvVar', () => {
  it('matches every denylisted name in any casing', () => {
    for (const name of INTERNAL_SECRET_ENV_VARS) {
      expect(isInternalSecretEnvVar(name)).toBe(true);
      expect(isInternalSecretEnvVar(name.toLowerCase())).toBe(true);
    }
  });

  it('does not match benign or third-party variables', () => {
    for (const name of [
      'PATH',
      'HOME',
      'GH_TOKEN',
      'QWEN_HOME',
      'OPENAI_API_KEY',
    ]) {
      expect(isInternalSecretEnvVar(name)).toBe(false);
    }
  });
});
