import { describe, it, expect, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSanitizedEnv, createScriptRuntimeEnv } from './sandbox-env.ts';

describe('sandbox-env', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips Qwen internal vars and keeps user credentials', () => {
    const base: NodeJS.ProcessEnv = {
      SAFE_VAR: 'ok',
      QWEN_SERVER_TOKEN: 'daemon-bearer',
      LLM_API_KEY: 'llm-key',
      QWEN_API_KEY: 'qwen-key',
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      AWS_SESSION_TOKEN: 'aws-session',
      GITHUB_TOKEN: 'gh-token',
      GH_TOKEN: 'gh-token',
      GOOGLE_API_KEY: 'google-key',
      STRIPE_SECRET_KEY: 'stripe-key',
      NPM_TOKEN: 'npm-token',
      DB_PASSWORD: 'db-password',
      SSH_PRIVATE_KEY: 'private-key',
    };

    const sanitized = createSanitizedEnv(base);

    expect(sanitized.SAFE_VAR).toBe('ok');
    expect(sanitized.QWEN_SERVER_TOKEN).toBeUndefined();
    expect(sanitized.LLM_API_KEY).toBe('llm-key');
    expect(sanitized.QWEN_API_KEY).toBe('qwen-key');
    expect(sanitized.AWS_ACCESS_KEY_ID).toBe('AKIAEXAMPLE');
    expect(sanitized.AWS_SECRET_ACCESS_KEY).toBe('aws-secret');
    expect(sanitized.AWS_SESSION_TOKEN).toBe('aws-session');
    expect(sanitized.GITHUB_TOKEN).toBe('gh-token');
    expect(sanitized.GH_TOKEN).toBe('gh-token');
    expect(sanitized.GOOGLE_API_KEY).toBe('google-key');
    expect(sanitized.STRIPE_SECRET_KEY).toBe('stripe-key');
    expect(sanitized.NPM_TOKEN).toBe('npm-token');
    expect(sanitized.DB_PASSWORD).toBe('db-password');
    expect(sanitized.SSH_PRIVATE_KEY).toBe('private-key');
  });

  it('sets python/uv cache and temp dirs inside data directory', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sandbox-env-python-'));
    createdDirs.push(dataDir);

    const env = createScriptRuntimeEnv({
      language: 'python3',
      dataDir,
    }, {
      SAFE_VAR: 'ok',
      QWEN_API_KEY: 'secret',
    });

    expect(env.SAFE_VAR).toBe('ok');
    expect(env.QWEN_API_KEY).toBe('secret');

    expect(env.TMPDIR).toBe(join(dataDir, '.tmp'));
    expect(env.TMP).toBe(join(dataDir, '.tmp'));
    expect(env.TEMP).toBe(join(dataDir, '.tmp'));
    expect(env.UV_CACHE_DIR).toBe(join(dataDir, '.uv-cache'));
    expect(env.XDG_CACHE_HOME).toBe(join(dataDir, '.cache'));
    expect(env.PYTHONPYCACHEPREFIX).toBe(join(dataDir, '.pycache'));

    expect(existsSync(env.TMPDIR!)).toBe(true);
    expect(existsSync(env.UV_CACHE_DIR!)).toBe(true);
    expect(existsSync(env.XDG_CACHE_HOME!)).toBe(true);
    expect(existsSync(env.PYTHONPYCACHEPREFIX!)).toBe(true);
  });

  it('does not add python-specific cache vars for node runtime', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sandbox-env-node-'));
    createdDirs.push(dataDir);

    const env = createScriptRuntimeEnv({
      language: 'node',
      dataDir,
    });

    expect(env.TMPDIR).toBe(join(dataDir, '.tmp'));
    expect(env.UV_CACHE_DIR).toBeUndefined();
    expect(env.XDG_CACHE_HOME).toBeUndefined();
    expect(env.PYTHONPYCACHEPREFIX).toBeUndefined();
  });
});
