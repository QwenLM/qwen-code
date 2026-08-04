/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  collectSensitiveShellEnvKeys,
  scrubChildEnv,
} from './child-env-scrub.js';

describe('collectSensitiveShellEnvKeys', () => {
  it('collects Qwen daemon/internal keys only', () => {
    const keys = collectSensitiveShellEnvKeys({
      QWEN_SERVER_TOKEN: 'bearer',
      QWEN_DAEMON_TOKEN: 'daemon-bearer',
      QWEN_CODE_SIMPLE: '1',
      OPENAI_API_KEY: 'sk-1',
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      GITHUB_TOKEN: 'ghp',
      GH_TOKEN: 'gh',
      NPM_TOKEN: 'npm',
      DB_PASSWORD: 'pw',
    });
    expect(keys).toEqual(
      new Set(['QWEN_SERVER_TOKEN', 'QWEN_DAEMON_TOKEN', 'QWEN_CODE_SIMPLE']),
    );
  });

  it('collects mixed-case internal keys on Windows', () => {
    const platformSpy = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('win32');
    try {
      const keys = collectSensitiveShellEnvKeys({
        qwen_daemon_token: 'daemon-bearer',
        Qwen_Server_Token: 'server-bearer',
        PATH: '/usr/bin',
      });
      expect(keys).toEqual(new Set(['qwen_daemon_token', 'Qwen_Server_Token']));
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('collects Qwen custom provider keys because they are internal env storage', () => {
    const keys = collectSensitiveShellEnvKeys({
      QWEN_CUSTOM_API_KEY_API_EXAMPLE_COM_AB12CD34EF56: 'tok',
    });
    expect(keys).toEqual(
      new Set(['QWEN_CUSTOM_API_KEY_API_EXAMPLE_COM_AB12CD34EF56']),
    );
  });

  it('does NOT collect shell-tool override keys the daemon injects', () => {
    // These are set by getShellContextEnvVars / the shell env overrides and
    // must survive scrubbing (they are tracing IDs, not secrets).
    const keys = collectSensitiveShellEnvKeys({
      QWEN_CODE: '1',
      QWEN_CODE_SESSION_ID: 'sid',
      QWEN_CODE_AGENT_ID: 'aid',
      QWEN_CODE_PROMPT_ID: 'pid',
      TERM: 'xterm-256color',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      TRACEPARENT: '00-..-..-01',
      TRACESTATE: '',
      PATH: '/usr/bin',
      HOME: '/home/user',
    });
    expect(keys).toEqual(new Set());
  });
});

describe('scrubChildEnv (shell-tool env policy)', () => {
  // Mirrors the spawnChannel.test.ts canary pattern: a hand-rolled scrub
  // set so the primitive is tested independently of the production
  // sensitive-key collector.
  const SCRUBBED = new Set<string>(['QWEN_SERVER_TOKEN']);

  it('shallow-clones source — never aliases into the live process.env', () => {
    const source = { FOO: 'bar' };
    const result = scrubChildEnv(source, SCRUBBED);
    result['MUTATED'] = 'yes';
    expect(source).not.toHaveProperty('MUTATED');
  });

  it('strips QWEN_SERVER_TOKEN from the child env', () => {
    const source = { QWEN_SERVER_TOKEN: 'super-secret', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED);
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(result['PATH']).toBe('/usr/bin');
  });

  it('passes through non-scrubbed env vars unchanged', () => {
    const source = { OPENAI_API_KEY: 'sk-test', HOME: '/home/user' };
    const result = scrubChildEnv(source, SCRUBBED);
    expect(result).toEqual(source);
  });

  it('overrides with undefined DELETE the key (defense-in-depth escape hatch)', () => {
    const source = { STALE_VAR: 'leftover', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, { STALE_VAR: undefined });
    expect(result).not.toHaveProperty('STALE_VAR');
    expect(result['PATH']).toBe('/usr/bin');
  });

  it('overrides CANNOT re-introduce a scrubbed key (denylist always wins)', () => {
    const source = { PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, {
      QWEN_SERVER_TOKEN: 'sneaky-attempt-via-override',
    });
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
  });

  it('integration: collector + scrub strips internal env, keeps user credentials and shell overrides', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      QWEN_SERVER_TOKEN: 'daemon-bearer',
      QWEN_DAEMON_TOKEN: 'channel-daemon-bearer',
      OPENAI_API_KEY: 'sk-leak',
      ANTHROPIC_API_KEY: 'sk-ant-leak',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      GITHUB_TOKEN: 'ghp-leak',
      QWEN_CUSTOM_API_KEY_API_EXAMPLE_COM_AB12CD34EF56: 'custom-tok',
      GOOGLE_APPLICATION_CREDENTIALS: '/sa.json',
      DB_PASSWORD: 'db-pw-leak',
      SSH_PRIVATE_KEY: '-----BEGIN LEAK...',
      // Legit inherited vars the shell may want:
      LANG: 'en_US.UTF-8',
      SHELL: '/bin/bash',
    };

    const result = scrubChildEnv(source, collectSensitiveShellEnvKeys(source), {
      QWEN_CODE: '1',
      TERM: 'xterm-256color',
      PAGER: 'cat',
      QWEN_CODE_SESSION_ID: 'sid-123',
      QWEN_CODE_AGENT_ID: 'aid-1',
      QWEN_CODE_PROMPT_ID: 'pid-1',
    });

    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(result).not.toHaveProperty('QWEN_DAEMON_TOKEN');
    expect(result).not.toHaveProperty(
      'QWEN_CUSTOM_API_KEY_API_EXAMPLE_COM_AB12CD34EF56',
    );

    expect(result['OPENAI_API_KEY']).toBe('sk-leak');
    expect(result['ANTHROPIC_API_KEY']).toBe('sk-ant-leak');
    expect(result['AWS_SECRET_ACCESS_KEY']).toBe('aws-secret');
    expect(result['AWS_ACCESS_KEY_ID']).toBe('AKIAEXAMPLE');
    expect(result['GITHUB_TOKEN']).toBe('ghp-leak');
    expect(result['GOOGLE_APPLICATION_CREDENTIALS']).toBe('/sa.json');
    expect(result['DB_PASSWORD']).toBe('db-pw-leak');
    expect(result['SSH_PRIVATE_KEY']).toBe('-----BEGIN LEAK...');
    expect(result['PATH']).toBe('/usr/bin');
    expect(result['HOME']).toBe('/home/user');
    expect(result['LANG']).toBe('en_US.UTF-8');
    expect(result['SHELL']).toBe('/bin/bash');

    // Overrides applied:
    expect(result['QWEN_CODE']).toBe('1');
    expect(result['TERM']).toBe('xterm-256color');
    expect(result['PAGER']).toBe('cat');
    expect(result['QWEN_CODE_SESSION_ID']).toBe('sid-123');
    expect(result['QWEN_CODE_AGENT_ID']).toBe('aid-1');
    expect(result['QWEN_CODE_PROMPT_ID']).toBe('pid-1');
  });

  it('integration: printenv QWEN_SERVER_TOKEN would see nothing', () => {
    // The exact exploit from the bug report: an auto-allowed read-only
    // `printenv QWEN_SERVER_TOKEN` must not return the daemon bearer token
    // because the var is gone from the shell subprocess env entirely.
    const source: NodeJS.ProcessEnv = {
      QWEN_SERVER_TOKEN: 'daemon-bearer-secret',
      PATH: '/usr/bin',
    };
    const result = scrubChildEnv(source, collectSensitiveShellEnvKeys(source));
    expect(result['QWEN_SERVER_TOKEN']).toBeUndefined();
    expect(Object.keys(result)).not.toContain('QWEN_SERVER_TOKEN');
  });
});
