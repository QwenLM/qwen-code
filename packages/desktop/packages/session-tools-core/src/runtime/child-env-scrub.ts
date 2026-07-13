/**
 * Shared child-process environment scrubbing for desktop-side subprocesses.
 *
 * Desktop MCP/sandbox children must not inherit daemon-owned credentials.
 * This package intentionally keeps a local copy of the tiny scrub primitive
 * because it does not depend on the CLI core package; tests lock the internal
 * Qwen key policy against the core sanitizer.
 */

export const DESKTOP_CHILD_CREDENTIAL_ENV_KEYS = [
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
 * Daemon/internal Qwen env vars. Keep this aligned with
 * packages/core/src/utils/child-env-scrub.ts.
 */
const INTERNAL_QWEN_ENV_KEY_PATTERN =
  /^(?:QWEN_SERVER_TOKEN|QWEN_DAEMON_TOKEN|QWEN_CODE_SIMPLE|QWEN_CUSTOM_API_KEY_.+)$/;

export function collectSensitiveChildEnvKeys(
  env: NodeJS.ProcessEnv,
): Set<string> {
  const keys = new Set<string>();
  for (const key of Object.keys(env)) {
    const normalizedKey =
      process.platform === 'win32' ? key.toUpperCase() : key;
    if (INTERNAL_QWEN_ENV_KEY_PATTERN.test(normalizedKey)) keys.add(key);
  }
  return keys;
}

export function scrubChildEnv(
  source: NodeJS.ProcessEnv,
  scrubbed: ReadonlySet<string>,
  overrides?: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(childEnv)) {
    if (isScrubbedKey(key, scrubbed)) delete childEnv[key];
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (isScrubbedKey(key, scrubbed)) continue;
      if (value === undefined) {
        delete childEnv[key];
      } else {
        childEnv[key] = value;
      }
    }
  }
  return childEnv;
}

function isScrubbedKey(key: string, scrubbed: ReadonlySet<string>): boolean {
  if (scrubbed.has(key)) return true;
  if (process.platform !== 'win32') return false;
  const normalizedKey = key.toUpperCase();
  for (const scrubbedKey of scrubbed) {
    if (scrubbedKey.toUpperCase() === normalizedKey) return true;
  }
  return false;
}

export function createSanitizedChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  overrides?: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  return scrubChildEnv(
    baseEnv,
    new Set([
      ...DESKTOP_CHILD_CREDENTIAL_ENV_KEYS,
      ...collectSensitiveChildEnvKeys(baseEnv),
    ]),
    overrides,
  );
}
