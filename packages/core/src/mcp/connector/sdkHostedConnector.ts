/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SdkControlClientTransport } from './transport/sdk-control.js';
import type { SendMcpMessageCallback } from './transport/sdk-control.js';
import type {
  McpConnectOutcome,
  McpConnectRequest,
  McpConnector,
  McpConnectorContext,
} from './types.js';

/**
 * SDK-hosted connector: no process to spawn and no URL to dial. JSON-RPC is
 * ferried back to the SDK process over the existing control-protocol channel.
 */
export class SdkHostedMcpConnector implements McpConnector {
  constructor(private readonly sdkBridge?: SendMcpMessageCallback) {}

  async connect(
    request: McpConnectRequest,
    _ctx: McpConnectorContext,
  ): Promise<McpConnectOutcome> {
    if (!this.sdkBridge) {
      throw new Error(
        `MCP server '${request.serverName}' is SDK-hosted but no control-protocol bridge is available`,
      );
    }
    return {
      transport: new SdkControlClientTransport(
        request.serverName,
        this.sdkBridge,
      ),
    };
  }
}
