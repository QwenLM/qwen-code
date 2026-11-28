/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';

/** A configured MCP server that did not end up CONNECTED, plus why. */
export interface FailedMcpServer {
  name: string;
  reason?: string;
}

/**
 * Failed MCP servers for the startup warning, each carrying the reason its
 * last discovery attempt recorded (`connect failed: ...`, `timeout: ...`,
 * `budget: ...`).
 *
 * The name alone tells an operator that a server is missing, not whether the
 * endpoint refused the connection, rejected the token or exceeded the
 * discovery budget — and the underlying error only reaches `debugLogger`,
 * which a daemon / stream-json run does not enable.
 *
 * Falls back to the name-only API for `Config` stubs that predate
 * `getFailedMcpServerDetails`.
 */
export function collectFailedMcpServers(config: Config): FailedMcpServer[] {
  if (typeof config.getFailedMcpServerDetails === 'function') {
    return config.getFailedMcpServerDetails();
  }
  if (typeof config.getFailedMcpServerNames === 'function') {
    return config.getFailedMcpServerNames().map((name) => ({ name }));
  }
  return [];
}

/** Single-line rendering: `server-a (connect failed: boom), server-b`. */
export function formatFailedMcpServers(
  servers: readonly FailedMcpServer[],
): string {
  return servers
    .map(({ name, reason }) => (reason ? `${name} (${reason})` : name))
    .join(', ');
}
