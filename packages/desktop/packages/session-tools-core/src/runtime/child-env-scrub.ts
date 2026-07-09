/**
 * Shared child-process environment scrubbing for desktop-side subprocesses.
 */

/**
 * Narrow denylist for daemon/internal Qwen env vars. Keep this aligned with
 * packages/core/src/utils/child-env-scrub.ts. User-managed credentials such as
 * GH_TOKEN, AWS_ACCESS_KEY_ID, and NPM_TOKEN are intentionally preserved.
 */
const INTERNAL_QWEN_ENV_KEY_PATTERN =
  /^(?:QWEN_SERVER_TOKEN|QWEN_CODE_SIMPLE|QWEN_CUSTOM_API_KEY_.+)$/;

export function collectSensitiveChildEnvKeys(
  env: NodeJS.ProcessEnv,
): Set<string> {
  const keys = new Set<string>();
  for (const key of Object.keys(env)) {
    if (INTERNAL_QWEN_ENV_KEY_PATTERN.test(key)) keys.add(key);
  }
  return keys;
}

export function scrubChildEnv(
  source: NodeJS.ProcessEnv,
  scrubbed: ReadonlySet<string>,
  overrides?: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...source };
  for (const key of scrubbed) {
    delete childEnv[key];
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (scrubbed.has(key)) continue;
      if (value === undefined) {
        delete childEnv[key];
      } else {
        childEnv[key] = value;
      }
    }
  }
  return childEnv;
}

export function createSanitizedChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  overrides?: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  return scrubChildEnv(baseEnv, collectSensitiveChildEnvKeys(baseEnv), overrides);
}
