/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  INHERITED_LOADER_ENV_KEYS,
  PROJECT_ENV_HARDCODED_EXCLUSIONS,
  scrubAndReportInheritedLoaderEnv,
  scrubInheritedLoaderEnv,
} from './shared-env-keys.js';

describe('PROJECT_ENV_HARDCODED_EXCLUSIONS', () => {
  // Security guard: a project `.env` must never be able to disable TLS
  // certificate verification. Removing this key would let an untrusted repo
  // silently turn off MITM protection for all API connections.
  it('excludes QWEN_TLS_INSECURE so a project .env cannot disable TLS', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain('QWEN_TLS_INSECURE');
  });

  // isTlsVerificationDisabled() also honors NODE_TLS_REJECT_UNAUTHORIZED=0, and
  // the initial .env load only consults this list, so it must be blocked here
  // too — otherwise a project .env could bypass TLS via the Node-native var.
  it('excludes NODE_TLS_REJECT_UNAUTHORIZED so a project .env cannot disable TLS', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(
      'NODE_TLS_REJECT_UNAUTHORIZED',
    );
  });
});

describe('scrubInheritedLoaderEnv', () => {
  // Regression for #8653: loader vars inherited from the daemon's launch
  // shell must not reach session subprocesses of other workspaces.
  it('removes every loader-affecting key and keeps the rest', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_OPTIONS: '--import file:///other-checkout/register.mjs',
      npm_config_node_options: '--import file:///other-checkout/hook.mjs',
      NODE_PATH: '/other-checkout/node_modules',
      LD_PRELOAD: '/evil.so',
      LD_AUDIT: '/evil-audit.so',
      LD_LIBRARY_PATH: '/evil-lib',
      DYLD_INSERT_LIBRARIES: '/evil.dylib',
      DYLD_LIBRARY_PATH: '/evil-lib',
      BASH_ENV: '/tmp/hook.sh',
      ENV: '/tmp/shrc',
      PATH: '/other-checkout/node_modules/.bin:/usr/bin',
      HOME: '/home/user',
      QWEN_SERVER_TOKEN: 'leave-secret-scrubbing-to-other-layers',
    };

    const removedKeys = scrubInheritedLoaderEnv(env);

    for (const key of INHERITED_LOADER_ENV_KEYS) {
      expect(env[key]).toBeUndefined();
    }
    // The removed-key list backs the startup breadcrumb and must only name
    // keys that were actually present.
    expect(removedKeys).toEqual([
      'NODE_OPTIONS',
      'npm_config_node_options',
      'NODE_PATH',
      'LD_PRELOAD',
      'LD_AUDIT',
      'LD_LIBRARY_PATH',
      'DYLD_INSERT_LIBRARIES',
      'DYLD_LIBRARY_PATH',
      'BASH_ENV',
      'ENV',
    ]);
    expect(scrubInheritedLoaderEnv(env)).toEqual([]);
    // PATH/HOME are launch-environment facts the session still needs; only
    // loader-class keys are scrubbed.
    expect(env['PATH']).toBe('/other-checkout/node_modules/.bin:/usr/bin');
    expect(env['HOME']).toBe('/home/user');
    expect(env['QWEN_SERVER_TOKEN']).toBe(
      'leave-secret-scrubbing-to-other-layers',
    );
  });

  it('pins the exact loader-key list so silent edits fail', () => {
    expect([...INHERITED_LOADER_ENV_KEYS].sort()).toEqual([
      'BASH_ENV',
      'DYLD_INSERT_LIBRARIES',
      'DYLD_LIBRARY_PATH',
      'ENV',
      'LD_AUDIT',
      'LD_LIBRARY_PATH',
      'LD_PRELOAD',
      'NODE_OPTIONS',
      'NODE_PATH',
      'npm_config_node_options',
    ]);
  });
});

describe('scrubAndReportInheritedLoaderEnv', () => {
  function captureStderr(run: () => void): string {
    const writes: string[] = [];
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      run();
    } finally {
      write.mockRestore();
    }
    return writes.join('');
  }

  it('scrubs and reports the removed keys with the boundary labels', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_OPTIONS: '--import file:///other-checkout/register.mjs',
      LD_PRELOAD: '/evil.so',
      HOME: '/home/user',
    };

    let removedKeys: string[] = [];
    const breadcrumb = captureStderr(() => {
      removedKeys = scrubAndReportInheritedLoaderEnv(
        env,
        'qwen serve',
        'daemon',
      );
    });

    expect(removedKeys).toEqual(['NODE_OPTIONS', 'LD_PRELOAD']);
    expect(env['HOME']).toBe('/home/user');
    expect(breadcrumb).toContain(
      'qwen serve: scrubbed inherited loader env vars from the daemon ' +
        'process; session subprocesses will not inherit them: ' +
        'NODE_OPTIONS, LD_PRELOAD',
    );
  });

  it('stays silent when there is nothing to scrub', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/home/user' };

    const breadcrumb = captureStderr(() => {
      expect(
        scrubAndReportInheritedLoaderEnv(env, 'qwen', 'ACP child'),
      ).toEqual([]);
    });

    expect(breadcrumb).toBe('');
  });
});
