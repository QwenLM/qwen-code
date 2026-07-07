/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Stdio MCP adapter command used by the optional CDP browser automation bridge. */
export const QWEN_CDP_MCP_COMMAND_ENV = 'QWEN_CDP_MCP_COMMAND';

export function resolveCdpMcpCommand(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const command = env[QWEN_CDP_MCP_COMMAND_ENV]?.trim();
  return command ? command : undefined;
}

export function isBrowserAutomationMcpAvailable(opts: {
  cdpTunnelOverWs?: boolean;
  token?: string;
}): boolean {
  return (
    opts.cdpTunnelOverWs === true &&
    !opts.token &&
    resolveCdpMcpCommand() !== undefined
  );
}
