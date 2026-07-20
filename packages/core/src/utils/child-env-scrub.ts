/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared child-process environment scrubbing.
 *
 * ACP children are agent processes. They need provider API keys such as
 * `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` so they can call models directly,
 * but they must not inherit daemon-owned credentials such as
 * `QWEN_SERVER_TOKEN` or `QWEN_DAEMON_TOKEN`.
 *
 * Shell/MCP/tool subprocesses also strip daemon-owned Qwen secrets. They keep
 * user-managed credentials such as `GH_TOKEN`, `AWS_ACCESS_KEY_ID`, or
 * `NPM_TOKEN` unless the caller explicitly overrides or deletes them.
 */

/**
 * Build the env for a child process from a source env, a denylist of keys to
 * strip, and an optional overrides map.
 *
 * Behavior (byte-identical to the original `spawnChannel.ts` implementation,
 * lifted here so both the ACP-child and shell-tool paths share one scrub):
 *
 *   1. Shallow-clone `source` (no aliasing into the caller's `process.env`).
 *   2. Delete every key in `scrubbed` (and case variants on Windows).
 *   3. Apply `overrides` per-handle: `undefined` deletes the key (lets a
 *      caller scrub a stale inherited var without mutating the global env);
 *      any other value assigns. **`overrides` CANNOT re-introduce a scrubbed
 *      key** - defense in depth so an operator passing
 *      `{ QWEN_SERVER_TOKEN: 'x' }` can't smuggle the daemon's bearer token
 *      back into the child.
 *
 * `scrubbed` is a parameter because ACP children preserve provider credentials
 * while other subprocesses choose their own caller-specific policy.
 */
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

/**
 * Daemon/internal Qwen env vars that must not flow into child processes.
 * Do not add generic credential-name patterns here: user-managed credentials
 * are expected to flow through shell and MCP subprocesses by default.
 */
const INTERNAL_QWEN_ENV_KEY_PATTERN =
  /^(?:QWEN_SERVER_TOKEN|QWEN_DAEMON_TOKEN|QWEN_CODE_SIMPLE|QWEN_CUSTOM_API_KEY_.+)$/;

function isScrubbedKey(key: string, scrubbed: ReadonlySet<string>): boolean {
  if (scrubbed.has(key)) return true;
  if (process.platform !== 'win32') return false;
  const normalizedKey = key.toUpperCase();
  for (const scrubbedKey of scrubbed) {
    if (scrubbedKey.toUpperCase() === normalizedKey) return true;
  }
  return false;
}

/**
 * Collect the set of env-var names present in `env` that match the internal
 * Qwen denylist above. Returns exact key names so the result can be
 * handed to {@link scrubChildEnv} (which takes a `ReadonlySet<string>` of
 * exact keys, shared with the ACP-child path).
 */
export function collectSensitiveShellEnvKeys(
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
