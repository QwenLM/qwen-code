/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Env vars that carry Qwen-internal daemon/server bearer credentials. These
 * must never be inherited by a child process the agent launches on the user's
 * behalf — shell commands, the monitor tool, or a stdio MCP server — because
 * no legitimate user command needs them and leaking them to arbitrary
 * agent-run commands is a credential-exposure gap (issue #6601).
 *
 * `QWEN_SERVER_TOKEN` is the serve-daemon bearer token and `QWEN_DAEMON_TOKEN`
 * is the channel-daemon worker token; the daemon worker already scrubs both
 * from its own `process.env` after reading them.
 *
 * This denylist is intentionally NARROW: it strips only Qwen-internal secrets,
 * NOT third-party credentials such as `GH_TOKEN`, `AWS_*`, or `NPM_TOKEN`.
 * Real shell workflows legitimately depend on inheriting those (`gh`, the AWS
 * CLI, `npm publish`, …), so stripping them here would break user commands.
 * Broader third-party-credential stripping stays scoped to the sandbox / MCP
 * infrastructure paths where it already lives.
 */
export const INTERNAL_SECRET_ENV_VARS: readonly string[] = [
  'QWEN_SERVER_TOKEN',
  'QWEN_DAEMON_TOKEN',
];

/**
 * Return a shallow copy of `env` with Qwen-internal daemon/server secrets
 * removed, so it is safe to pass to a child process spawned on the user's
 * behalf. Does not mutate the input.
 *
 * @param env The source environment (defaults to `process.env`).
 */
export function sanitizeChildEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...env };
  for (const key of INTERNAL_SECRET_ENV_VARS) {
    delete sanitized[key];
  }
  return sanitized;
}
