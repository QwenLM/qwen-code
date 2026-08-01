/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single source of truth for whether the daemon's HTTP ACP surface is enabled.
 *
 * The HTTP ACP surface — `/acp`, the Phase 4 `/workspaces/:workspace/acp`, the
 * reverse client-MCP/CDP WS, and the `/voice/stream` WS — is on by default and
 * opts out only when `QWEN_SERVE_ACP_HTTP=0`. Several call sites (mount, voice
 * advertisement, CDP-MCP gating, capability advertisement) each interpreted
 * this env var independently; routing them through this helper keeps the
 * interpretation identical everywhere.
 */
export function resolveAcpHttpEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env['QWEN_SERVE_ACP_HTTP'] !== '0';
}
