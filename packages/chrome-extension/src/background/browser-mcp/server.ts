/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface BrowserToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface BrowserToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
}

export interface BrowserToolHandler {
  readonly tools: readonly BrowserToolDefinition[];
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<BrowserToolResult>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export class BrowserMcpServer {
  constructor(private readonly handler: BrowserToolHandler) {}

  async handleMessage(message: unknown): Promise<JsonRpcResponse | null> {
    if (!isRecord(message) || message['jsonrpc'] !== '2.0') {
      return errorResponse(null, -32600, 'Invalid JSON-RPC request');
    }
    const request = message as unknown as JsonRpcRequest;
    if (typeof request.method !== 'string') {
      return errorResponse(request.id ?? null, -32600, 'Missing method');
    }

    const isNotification = request.id === undefined;
    if (request.method === 'notifications/initialized') return null;

    try {
      switch (request.method) {
        case 'initialize': {
          if (isNotification) return null;
          const params = isRecord(request.params) ? request.params : {};
          return {
            jsonrpc: '2.0',
            id: request.id!,
            result: {
              protocolVersion:
                typeof params['protocolVersion'] === 'string'
                  ? params['protocolVersion']
                  : '2024-11-05',
              capabilities: { tools: { listChanged: false } },
              serverInfo: {
                name: 'qwen-browser-tools',
                version: chrome.runtime.getManifest().version,
              },
            },
          };
        }
        case 'ping':
          return isNotification
            ? null
            : { jsonrpc: '2.0', id: request.id!, result: {} };
        case 'tools/list':
          return isNotification
            ? null
            : {
                jsonrpc: '2.0',
                id: request.id!,
                result: { tools: this.handler.tools },
              };
        case 'tools/call': {
          if (isNotification) return null;
          if (!isRecord(request.params)) {
            return errorResponse(request.id!, -32602, 'Invalid tool call');
          }
          const name = request.params['name'];
          const rawArgs = request.params['arguments'];
          if (typeof name !== 'string' || !isRecord(rawArgs ?? {})) {
            return errorResponse(request.id!, -32602, 'Invalid tool call');
          }
          const result = await this.handler.callTool(
            name,
            (rawArgs ?? {}) as Record<string, unknown>,
          );
          return { jsonrpc: '2.0', id: request.id!, result };
        }
        default:
          return isNotification
            ? null
            : errorResponse(
                request.id!,
                -32601,
                `Method not found: ${request.method}`,
              );
      }
    } catch (error) {
      return isNotification
        ? null
        : errorResponse(
            request.id!,
            -32603,
            error instanceof Error ? error.message : String(error),
          );
    }
  }
}
