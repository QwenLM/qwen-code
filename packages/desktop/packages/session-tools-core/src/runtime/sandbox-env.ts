/**
 * Shared environment sanitization for script-execution tools.
 */

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ScriptRuntimeLanguage } from './resolve-script-runtime.ts';
import {
  collectSensitiveChildEnvKeys,
  scrubChildEnv,
} from './child-env-scrub.ts';

export const BLOCKED_ENV_VARS = [
  'LLM_API_KEY',
  'QWEN_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GOOGLE_API_KEY',
  'STRIPE_SECRET_KEY',
  'NPM_TOKEN',
] as const;

/**
 * Return a shallow-copied environment with credentials and daemon-internal
 * variables removed before running untrusted scripts.
 */
export function createSanitizedEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return scrubChildEnv(
    baseEnv,
    new Set([
      ...BLOCKED_ENV_VARS,
      ...collectSensitiveChildEnvKeys(baseEnv),
    ]),
  );
}

export interface ScriptRuntimeEnvOptions {
  language: ScriptRuntimeLanguage;
  dataDir: string;
}

/**
 * Build a sanitized subprocess env with runtime-local cache/temp paths.
 *
 * For Python/uv, redirect caches away from home-directory defaults (e.g. ~/.cache/uv)
 * into the writable session data directory so sandboxed execution remains reliable.
 */
export function createScriptRuntimeEnv(
  options: ScriptRuntimeEnvOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = createSanitizedEnv(baseEnv);
  const dataDir = resolve(options.dataDir);

  const tmpDir = join(dataDir, '.tmp');
  mkdirSync(tmpDir, { recursive: true });

  // Shared temp override (helps avoid host temp paths that may be blocked by FS isolation)
  env.TMPDIR = tmpDir;
  env.TMP = tmpDir;
  env.TEMP = tmpDir;

  if (options.language === 'python3') {
    const uvCacheDir = join(dataDir, '.uv-cache');
    const xdgCacheHome = join(dataDir, '.cache');
    const pythonPyCachePrefix = join(dataDir, '.pycache');

    mkdirSync(uvCacheDir, { recursive: true });
    mkdirSync(xdgCacheHome, { recursive: true });
    mkdirSync(pythonPyCachePrefix, { recursive: true });

    env.UV_CACHE_DIR = uvCacheDir;
    env.XDG_CACHE_HOME = xdgCacheHome;
    env.PYTHONPYCACHEPREFIX = pythonPyCachePrefix;
  }

  return env;
}
