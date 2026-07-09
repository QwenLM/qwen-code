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
 * 2. The shell-tool subprocess (`shellExecutionService.ts`) passes the BROAD
 *    set produced by {@link collectSensitiveShellEnvKeys}. The shell
 *    subprocess is where the model's own commands run — including auto-allowed
 *    read-only commands like `printenv`/`env`. Inheriting the daemon's env
 *    verbatim lets `printenv QWEN_SERVER_TOKEN` exfiltrate the daemon bearer
 *    token (and any provider key) straight into the tool result. So every
 *    secret-semantic var is stripped here regardless of whether the ACP child
 *    needs it; the shell subprocess is model-controlled and should never have
 *    relied on inherited secrets.
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
 * Pattern matching secret-semantic env-var names. Substring matching is
 * intentional — it catches both the suffix form (`OPENAI_API_KEY`,
 * `ANTHROPIC_API_KEY`, `DASHSCOPE_API_KEY`) and the prefix/middle form used
 * by custom providers (`QWEN_CUSTOM_API_KEY_<id>`). The `_TOKEN$` alternative
 * is anchored to the end so it catches `*_TOKEN` (`QWEN_SERVER_TOKEN`,
 * `GITHUB_TOKEN`, `AWS_SESSION_TOKEN`, …) without matching non-secret names
 * that merely contain "token" as a substring. `_PASSWORD` and `_PRIVATE_KEY`
 * cover the remaining common secret-bearing suffixes (`DB_PASSWORD`,
 * `GITLAB_DB_PASSWORD`, `SSH_PRIVATE_KEY`, `GCP_SERVICE_ACCOUNT_PRIVATE_KEY`,
 * …). `_ACCESS_KEY_ID` covers the AWS access-key-ID form
 * (`AWS_ACCESS_KEY_ID`, `GOOGLE_ACCESS_KEY_ID`); the matching secret access
 * key (`AWS_SECRET_ACCESS_KEY`) is already caught by `_SECRET`.
 *
 * Over-matching is safe here because the shell subprocess is model-controlled:
 * a benign var that happens to match a secret pattern simply isn't inherited,
 * and the model can pass it explicitly if a command genuinely needs it. The
 * daemon's own provider keys are never legitimately needed by a model-run
 * shell command.
 */
const SENSITIVE_ENV_KEY_PATTERN =
  /(?:_API_KEY|_SECRET|_CREDENTIAL|_TOKEN$|_PASSWORD|_PRIVATE_KEY|_ACCESS_KEY_ID)/i;

/**
 * Collect the set of env-var names present in `env` that match the
 * secret-semantic pattern above. Returns exact key names so the result can be
 * handed to {@link scrubChildEnv} (which takes a `ReadonlySet<string>` of
 * exact keys, shared with the ACP-child path).
 */
export function collectSensitiveShellEnvKeys(
  env: NodeJS.ProcessEnv,
): Set<string> {
  const keys = new Set<string>();
  for (const key of Object.keys(env)) {
    if (SENSITIVE_ENV_KEY_PATTERN.test(key)) keys.add(key);
  }
  return keys;
}
