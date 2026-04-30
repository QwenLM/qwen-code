import { describe, it, expect, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLOCKED_ENV_VARS, createSanitizedEnv, createScriptRuntimeEnv } from './sandbox-env.ts';

describe('sandbox-env', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips all blocked credential vars', () => {
    const base: NodeJS.ProcessEnv = {
      SAFE_VAR: 'ok',
    };

    for (const key of BLOCKED_ENV_VARS) {
      base[key] = `${key.toLowerCase()}-secret`;
    }

    const sanitized = createSanitizedEnv(base);

    expect(sanitized.SAFE_VAR).toBe('ok');
    for (const key of BLOCKED_ENV_VARS) {
      expect(sanitized[key]).toBeUndefined();
    }
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
    expect(env.QWEN_API_KEY).toBeUndefined();

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
