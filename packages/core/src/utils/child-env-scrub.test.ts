/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  collectSensitiveShellEnvKeys,
  scrubChildEnv,
} from './child-env-scrub.js';

describe('collectSensitiveShellEnvKeys', () => {
  it('collects *_API_KEY (suffix form)', () => {
    const keys = collectSensitiveShellEnvKeys({
      OPENAI_API_KEY: 'sk-1',
      ANTHROPIC_API_KEY: 'sk-ant',
      DASHSCOPE_API_KEY: 'ds',
      GOOGLE_API_KEY: 'g',
    });
    expect(keys).toEqual(
      new Set([
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'DASHSCOPE_API_KEY',
        'GOOGLE_API_KEY',
      ]),
    );
  });

  it('collects the custom-provider prefix form QWEN_CUSTOM_API_KEY_<id>', () => {
    // custom-provider.ts derives QWEN_CUSTOM_API_KEY_<12hex> env keys;
    // these hold provider API tokens and must be stripped from the shell
    // subprocess even though they do not END in _API_KEY.
    const keys = collectSensitiveShellEnvKeys({
      QWEN_CUSTOM_API_KEY_API_EXAMPLE_COM_AB12CD34EF56: 'tok',
    });
    expect(keys).toEqual(
      new Set(['QWEN_CUSTOM_API_KEY_API_EXAMPLE_COM_AB12CD34EF56']),
    );
  });

  it('collects *_SECRET (incl. AWS_SECRET_ACCESS_KEY, CLIENT_SECRET)', () => {
    const keys = collectSensitiveShellEnvKeys({
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      JWT_SECRET: 'jwt',
      CLIENT_SECRET: 'cs',
    });
    expect(keys).toEqual(
      new Set(['AWS_SECRET_ACCESS_KEY', 'JWT_SECRET', 'CLIENT_SECRET']),
    );
  });

  it('collects *_CREDENTIAL(S) (incl. GOOGLE_APPLICATION_CREDENTIALS)', () => {
    const keys = collectSensitiveShellEnvKeys({
      GOOGLE_APPLICATION_CREDENTIALS: '/path/to/sa.json',
      DB_CREDENTIAL: 'c',
      AZURE_CREDENTIALS: 'az',
    });
    expect(keys).toEqual(
      new Set([
        'GOOGLE_APPLICATION_CREDENTIALS',
        'DB_CREDENTIAL',
        'AZURE_CREDENTIALS',
      ]),
    );
  });

  it('collects *_TOKEN (QWEN_SERVER_TOKEN, GITHUB_TOKEN, AWS_SESSION_TOKEN)', () => {
    const keys = collectSensitiveShellEnvKeys({
      QWEN_SERVER_TOKEN: 'bearer',
      GITHUB_TOKEN: 'ghp',
      GH_TOKEN: 'gh',
      GITLAB_TOKEN: 'gl',
      HF_TOKEN: 'hf',
      AWS_SESSION_TOKEN: 'aws-tok',
    });
    expect(keys).toEqual(
      new Set([
        'QWEN_SERVER_TOKEN',
        'GITHUB_TOKEN',
        'GH_TOKEN',
        'GITLAB_TOKEN',
        'HF_TOKEN',
        'AWS_SESSION_TOKEN',
      ]),
    );
  });

  it('collects *_PASSWORD (DB_PASSWORD, GITLAB_DB_PASSWORD, MYSQL_ROOT_PASSWORD)', () => {
    const keys = collectSensitiveShellEnvKeys({
      DB_PASSWORD: 'pw',
      GITLAB_DB_PASSWORD: 'glpw',
      MYSQL_ROOT_PASSWORD: 'mysql',
      REDIS_PASSWORD: 'redis',
    });
    expect(keys).toEqual(
      new Set([
        'DB_PASSWORD',
        'GITLAB_DB_PASSWORD',
        'MYSQL_ROOT_PASSWORD',
        'REDIS_PASSWORD',
      ]),
    );
  });

  it('does NOT match bare PASSWORD (no leading underscore) — pattern boundary', () => {
    // The pattern is `_PASSWORD` (requires a leading underscore), mirroring
    // the `_TOKEN$` anchoring rationale: avoid matching benign names that
    // merely contain "password" as a substring. `PGPASSWORD` (a real Postgres
    // env var with no underscore separator before PASSWORD) is therefore NOT
    // caught by the pattern. This is an accepted boundary, not a bug: the
    // shell subprocess is model-controlled, and the daemon should not be
    // relying on PGPASSWORD inheritance anyway (it should set it explicitly).
    const keys = collectSensitiveShellEnvKeys({
      PGPASSWORD: 'pg',
      PASSWORD: 'bare',
    });
    expect(keys).toEqual(new Set());
  });

  it('collects *_PRIVATE_KEY (SSH_PRIVATE_KEY, GCP_SERVICE_ACCOUNT_PRIVATE_KEY, GIT_SSH_PRIVATE_KEY)', () => {
    const keys = collectSensitiveShellEnvKeys({
      SSH_PRIVATE_KEY: '-----BEGIN...',
      GCP_SERVICE_ACCOUNT_PRIVATE_KEY: '-----BEGIN...',
      GIT_SSH_PRIVATE_KEY: 'k2',
    });
    expect(keys).toEqual(
      new Set([
        'SSH_PRIVATE_KEY',
        'GCP_SERVICE_ACCOUNT_PRIVATE_KEY',
        'GIT_SSH_PRIVATE_KEY',
      ]),
    );
  });

  it('collects AWS access-key-ID form (AWS_ACCESS_KEY_ID, GOOGLE_ACCESS_KEY_ID)', () => {
    // The matching secret access key (AWS_SECRET_ACCESS_KEY) is caught by
    // _SECRET; this covers the ID half, which also identifies the account.
    const keys = collectSensitiveShellEnvKeys({
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      GOOGLE_ACCESS_KEY_ID: 'GOOGEXAMPLE',
    });
    expect(keys).toEqual(
      new Set(['AWS_ACCESS_KEY_ID', 'GOOGLE_ACCESS_KEY_ID']),
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
      QWEN_CODE_SIMPLE: '1',
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

  // The end-to-end contract the shellExecutionService call site relies on:
  // feeding collectSensitiveShellEnvKeys(process.env) as the scrub set
  // strips every secret-semantic var while keeping the daemon's legitimate
  // shell-tool overrides (QWEN_CODE, TERM, PAGER, session/agent/prompt IDs).
  it('integration: collector + scrub strips secrets, keeps shell overrides', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      QWEN_SERVER_TOKEN: 'daemon-bearer',
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

    // All secret-semantic vars stripped:
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(result).not.toHaveProperty('OPENAI_API_KEY');
    expect(result).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(result).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(result).not.toHaveProperty('AWS_ACCESS_KEY_ID');
    expect(result).not.toHaveProperty('GITHUB_TOKEN');
    expect(result).not.toHaveProperty(
      'QWEN_CUSTOM_API_KEY_API_EXAMPLE_COM_AB12CD34EF56',
    );
    expect(result).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS');
    expect(result).not.toHaveProperty('DB_PASSWORD');
    expect(result).not.toHaveProperty('SSH_PRIVATE_KEY');

    // Legit inherited vars preserved:
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
