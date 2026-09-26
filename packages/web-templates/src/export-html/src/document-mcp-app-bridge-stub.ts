/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Exported documents do not provide `mcpAppBaseUrl`. McpApp therefore renders
 * its recorded fallback text without creating an iframe or bridge. Only the
 * document IIFE build resolves the interactive bridge to these stubs; public
 * Web Shell entries keep the real dependency external for their consumers.
 * Throw if that document-mode invariant changes instead of silently dropping
 * an attempted interactive connection.
 */
export class AppBridge {
  constructor() {
    throw new Error(
      'MCP App bridges are unavailable in read-only exported documents.',
    );
  }
}

export class PostMessageTransport {
  constructor() {
    throw new Error(
      'MCP App transports are unavailable in read-only exported documents.',
    );
  }
}
