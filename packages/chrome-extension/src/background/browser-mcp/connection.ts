/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserMcpServer } from './server.js';

export const BROWSER_MCP_SERVER_NAME = 'qwen-browser-tools';

export type BrowserMcpSend = (frame: Record<string, unknown>) => void;

export function registerBrowserMcp(send: BrowserMcpSend): void {
  send({ type: 'mcp_register', server: BROWSER_MCP_SERVER_NAME });
}

export async function routeBrowserMcpFrame(
  server: BrowserMcpServer,
  frame: Record<string, unknown>,
  send: BrowserMcpSend,
): Promise<boolean> {
  if (
    frame['type'] !== 'mcp_message' ||
    frame['server'] !== BROWSER_MCP_SERVER_NAME ||
    typeof frame['id'] !== 'string'
  ) {
    return false;
  }
  const response = await server.handleMessage(frame['payload']);
  if (response) {
    send({
      type: 'mcp_message',
      id: frame['id'],
      server: BROWSER_MCP_SERVER_NAME,
      payload: response,
    });
  }
  return true;
}
