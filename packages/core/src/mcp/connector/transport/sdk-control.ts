/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview SDK MCP transport — CLI side.
 *
 * Bridges an in-process MCP server hosted by the SDK (e.g. registered via
 * `createSdkMcpServer({tools})` in the SDK consumer) to a normal MCP
 * `Client` running inside the CLI process.
 *
 * Every JSON-RPC request the client wants to send is wrapped in a
 * `control_request{subtype:'mcp_message', server_name, message}` envelope
 * and shipped over stdout to the SDK process. The SDK runs the message
 * against its `McpServer` instance and replies with
 * `control_response{response: { mcp_response: <JSONRPCMessage> }}`. The
 * caller-supplied `sendMcpMessage` callback handles the request/response
 * correlation (typically via `PendingRequestManager`).
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SchemaCompatibleMcpClient } from '../../schema-compatible-client.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import {
  createSdkMcpServerConfig,
  type MCPServerConfig,
  type McpToolRuntimeOverride,
} from '../../../config/config.js';
import type { DiscoveredMCPTool, McpToolCaller } from '../../tools/mcp-tool.js';
import { discoverTools } from '../../tools/mcp-tool.js';
import type { McpClientContext } from '../../mcpClientContext.js';
import { runLogger } from '../../../utils/runLogger.js';
import { BRAND_FIXED_CLI_BIN } from '../../../config/brand.js';

/**
 * Callback used by {@link SdkControlClientTransport} to ship a JSON-RPC
 * message to the SDK process and await its response. Implementations
 * typically build a `control_request{subtype:'mcp_message'}` envelope and
 * resolve when the matching `control_response` arrives on stdin.
 */
export type SendMcpMessageCallback = (
  serverName: string,
  message: JSONRPCMessage,
) => Promise<JSONRPCMessage>;

/**
 * CLI-side transport for an SDK-hosted MCP server.
 *
 * Implements the MCP `Transport` interface but does not own a socket or a
 * subprocess — every `send()` is a request/response round-trip over the
 * structured-IO control protocol, completed by `sendMcpMessage`.
 */
export class SdkControlClientTransport implements Transport {
  private isClosed = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly serverName: string,
    private readonly sendMcpMessage: SendMcpMessageCallback,
  ) {}

  async start(): Promise<void> {
    // No-op: the underlying transport is the parent process's stdio,
    // which is already open by the time we're constructed.
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.isClosed) {
      throw new Error('SdkControlClientTransport is closed');
    }

    let response: JSONRPCMessage;
    try {
      response = await this.sendMcpMessage(this.serverName, message);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.onerror?.(err);
      throw err;
    }

    // The MCP Client expects responses (and notifications) to arrive via
    // onmessage. Notifications from the server side would also flow here.
    this.onmessage?.(response);
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.onclose?.();
  }
}

/**
 * Result of {@link setupSdkMcpClients}.
 */
export interface SdkMcpClientSetupResult {
  /** Tools discovered from each connected SDK MCP server, ready for the registry. */
  tools: DiscoveredMCPTool[];
  /** Per-server connection record (for status/disconnect bookkeeping). */
  connections: SdkMcpConnection[];
}

export interface SdkMcpConnection {
  serverName: string;
  config: MCPServerConfig;
  client: Client;
  transport: SdkControlClientTransport;
  cleanup: () => Promise<void>;
}

interface SetupOptions {
  clientVersion: string;
  cliConfig: McpClientContext;
  toolOverridesByServer?: Record<
    string,
    Record<string, McpToolRuntimeOverride>
  >;
}

/**
 * Connect an MCP `Client` to each named SDK-hosted server, then discover its
 * tools so they can be merged into the CLI's tool registry.
 *
 * Failures for any individual server are logged and skipped — the rest still come up.
 */
export async function setupSdkMcpClients(
  serverNames: string[],
  sendMcpMessage: SendMcpMessageCallback,
  options: SetupOptions,
): Promise<SdkMcpClientSetupResult> {
  const tools: DiscoveredMCPTool[] = [];
  const connections: SdkMcpConnection[] = [];

  const results = await Promise.allSettled(
    serverNames.map(async (serverName) => {
      const startedAt = Date.now();
      runLogger.log('[SdkMcp]', {
        server: serverName,
        phase: 'connect',
        event: 'started',
      });
      const transport = new SdkControlClientTransport(
        serverName,
        sendMcpMessage,
      );
      const client = new SchemaCompatibleMcpClient(
        {
          name: `${BRAND_FIXED_CLI_BIN}-sdk-bridge`,
          version: options.clientVersion,
        },
        {
          capabilities: {},
        },
      );

      await client.connect(transport);

      const config = createSdkMcpServerConfig(
        options.toolOverridesByServer?.[serverName],
      );
      const toolCaller: McpToolCaller = {
        callMcpTool: (params, callOpts) =>
          client.callTool(
            params as Parameters<Client['callTool']>[0],
            undefined,
            callOpts,
          ),
      };

      let discovered: DiscoveredMCPTool[] = [];
      const capabilities = client.getServerCapabilities();
      if (capabilities?.tools) {
        discovered = await discoverTools(
          serverName,
          config,
          client,
          toolCaller,
          options.cliConfig,
        );
      }

      const connection: SdkMcpConnection = {
        serverName,
        config,
        client,
        transport,
        cleanup: async () => {
          try {
            await client.close();
          } catch (error) {
            runLogger.warn(
              `[SdkMcp] Error closing client for "${serverName}":`,
              error,
            );
          }
        },
      };

      runLogger.log('[SdkMcp]', {
        server: serverName,
        phase: 'connect',
        event: 'finished',
        durationMs: Date.now() - startedAt,
        status: 'connected',
        tools: discovered.length,
      });
      return { connection, discoveredTools: discovered };
    }),
  );

  for (const [index, result] of results.entries()) {
    const name = serverNames[index];
    if (result.status === 'fulfilled') {
      connections.push(result.value.connection);
      tools.push(...result.value.discoveredTools);
    } else {
      runLogger.warn(
        `[SdkMcp] Failed to connect SDK MCP server "${name}":`,
        result.reason,
      );
    }
  }

  return { tools, connections };
}
