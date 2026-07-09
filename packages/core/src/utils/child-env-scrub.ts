/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared child-process environment scrubbing.
 *
 * Two call sites consume this module, and they intentionally pass DIFFERENT
 * scrub sets — unifying them would reintroduce the bug this file exists to
 * fix (or break the ACP child). Read this before "consolidating":
 *
 * 1. {@link scrubChildEnv} — the pure clone+scrub+override primitive, shared
 *    with `packages/acp-bridge/src/spawnChannel.ts` (`qwen --acp` children).
 *    That call site passes a NARROW set (`QWEN_SERVER_TOKEN`, `QWEN_CODE_SIMPLE`)
 *    because the ACP child is itself a `qwen` agent that MUST inherit provider
 *    API keys (`OPENAI_API_KEY`, …) to call models. Scrubbing those would break
 *    the child. The narrow set is correct there *only because* the agent has
 *    unrestricted shell-tool access — see the WARNING on
 *    `SCRUBBED_CHILD_ENV_KEYS` in `spawnChannel.ts`.
 *
 * 2. Shell/MCP/tool subprocesses pass the narrow set produced by
 *    {@link collectSensitiveShellEnvKeys}. These children must not inherit
 *    daemon-internal Qwen secrets such as `QWEN_SERVER_TOKEN`, but user-managed
 *    credentials like `GH_TOKEN`, `AWS_ACCESS_KEY_ID`, or `NPM_TOKEN` are part
 *    of normal shell and MCP workflows and must remain available unless a
 *    caller explicitly overrides/deletes them.
 */

/**
 * Build the env for a child process from a source env, a denylist of keys to
 * strip, and an optional overrides map.
 *
 * Behavior (byte-identical to the original `spawnChannel.ts` implementation,
 * lifted here so both the ACP-child and shell-tool paths share one scrub):
 *
 *   1. Shallow-clone `source` (no aliasing into the caller's `process.env`).
 *   2. Delete every key in `scrubbed`.
 *   3. Apply `overrides` per-handle: `undefined` deletes the key (lets a
 *      caller scrub a stale inherited var without mutating the global env);
 *      any other value assigns. **`overrides` CANNOT re-introduce a scrubbed
 *      key** — defense in depth so an operator passing
 *      `{ QWEN_SERVER_TOKEN: 'x' }` can't smuggle the daemon's bearer token
 *      back into the child.
 *
 * `scrubbed` is a parameter (not a module constant) precisely because the two
 * call sites need different sets — see the file header.
 */
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

/**
 * Narrow denylist for daemon/internal Qwen env vars. Do not add broad
 * credential-name patterns here: user-managed credentials are expected to flow
 * through shell and MCP subprocesses by default.
 */
const INTERNAL_QWEN_ENV_KEY_PATTERN =
  /^(?:QWEN_SERVER_TOKEN|QWEN_CODE_SIMPLE|QWEN_CUSTOM_API_KEY_.+)$/;

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
    if (INTERNAL_QWEN_ENV_KEY_PATTERN.test(key)) keys.add(key);
  }
  return keys;
}
