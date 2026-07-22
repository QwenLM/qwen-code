/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import type { AgentStateStore } from './state-store.js';

const LATEST_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LATEST_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
]);
const MAX_MESSAGE_BYTES = 256 * 1024;

const requestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().min(1).max(128),
    params: z.unknown().optional(),
  })
  .passthrough();
const initializeSchema = z
  .object({ protocolVersion: z.string().min(1).max(64) })
  .passthrough();
const callToolSchema = z
  .object({
    name: z.string().min(1).max(128),
    arguments: z.record(z.unknown()).default({}),
  })
  .strict();
const searchSchema = z.object({ query: z.string().min(1).max(2_000) }).strict();
const getSchema = z.object({ memoryId: z.string().uuid() }).strict();
const proposalSchema = z
  .object({
    summary: z.string().min(1).max(1_000),
    references: z.array(z.string().min(1).max(500)).max(10).default([]),
  })
  .strict();
const feedbackSchema = z
  .object({
    memoryId: z.string().uuid(),
    signal: z.enum(['helpful', 'not_helpful', 'stale', 'unsafe']),
  })
  .strict();

export interface McpGatewayClient {
  post<T>(path: string, value: unknown, operationId: string): Promise<T>;
  get<T>(path: string, operationId: string): Promise<T>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const tools = [
  {
    name: 'memory_search',
    description: 'Search authorized enterprise memory reference data.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, maxLength: 2_000 } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_get',
    description: 'Get one authorized canonical memory by opaque ID.',
    inputSchema: {
      type: 'object',
      properties: { memoryId: { type: 'string', format: 'uuid' } },
      required: ['memoryId'],
      additionalProperties: false,
    },
  },
  ...(['personal', 'repository'] as const).map((scope) => ({
    name: `memory_propose_${scope}`,
    description: `Propose a ${scope} memory candidate for governed review. This never approves or activates it.`,
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 1_000 },
        references: {
          type: 'array',
          maxItems: 10,
          items: { type: 'string', minLength: 1, maxLength: 500 },
          default: [],
        },
      },
      required: ['summary'],
      additionalProperties: false,
    },
  })),
  {
    name: 'memory_feedback',
    description:
      'Submit advisory feedback for review; it cannot change memory authority or state.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', format: 'uuid' },
        signal: { enum: ['helpful', 'not_helpful', 'stale', 'unsafe'] },
      },
      required: ['memoryId', 'signal'],
      additionalProperties: false,
    },
  },
] as const;

export async function runMcpServer(
  gateway: McpGatewayClient,
  states: AgentStateStore,
): Promise<void> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, value]);
    let lineEnd = buffer.indexOf(0x0a);
    while (lineEnd >= 0) {
      const line = buffer.subarray(0, lineEnd);
      buffer = buffer.subarray(lineEnd + 1);
      if (line.byteLength > MAX_MESSAGE_BYTES) {
        await writeResponse(errorResponse(null, -32600, 'Request too large'));
      } else if (line.byteLength > 0) {
        await processLine(line, gateway, states);
      }
      lineEnd = buffer.indexOf(0x0a);
    }
    if (buffer.byteLength > MAX_MESSAGE_BYTES) {
      await writeResponse(errorResponse(null, -32600, 'Request too large'));
      buffer = Buffer.alloc(0);
    }
  }
  if (buffer.byteLength > 0) {
    await writeResponse(errorResponse(null, -32700, 'Invalid JSON'));
  }
}

export async function handleMcpMessage(
  value: unknown,
  gateway: McpGatewayClient,
  states: AgentStateStore,
): Promise<JsonRpcResponse | null> {
  const request = requestSchema.parse(value);
  if (request.id === undefined) {
    return null;
  }
  const id = request.id;
  try {
    if (request.method === 'initialize') {
      const input = initializeSchema.parse(request.params);
      return successResponse(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(input.protocolVersion)
          ? input.protocolVersion
          : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'qwen-enterprise-memory', version: '0.1.0' },
      });
    }
    if (request.method === 'ping') {
      return successResponse(id, {});
    }
    if (request.method === 'tools/list') {
      return successResponse(id, { tools });
    }
    if (request.method === 'tools/call') {
      const input = callToolSchema.parse(request.params);
      try {
        return successResponse(
          id,
          await callTool(input.name, input.arguments, gateway, states),
        );
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof UnknownToolError) {
          throw error;
        }
        return successResponse(id, {
          content: [
            { type: 'text', text: 'Enterprise memory is unavailable.' },
          ],
          isError: true,
        });
      }
    }
    return errorResponse(id, -32601, 'Method not found');
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof UnknownToolError) {
      return errorResponse(id, -32602, 'Invalid parameters');
    }
    return errorResponse(id, -32603, 'Internal error');
  }
}

async function processLine(
  line: Buffer,
  gateway: McpGatewayClient,
  states: AgentStateStore,
): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(line.toString('utf8')) as unknown;
  } catch {
    await writeResponse(errorResponse(null, -32700, 'Invalid JSON'));
    return;
  }
  try {
    const response = await handleMcpMessage(value, gateway, states);
    if (response) {
      await writeResponse(response);
    }
  } catch {
    await writeResponse(errorResponse(null, -32600, 'Invalid request'));
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  gateway: McpGatewayClient,
  states: AgentStateStore,
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  if (name === 'memory_search') {
    const input = searchSchema.parse(args);
    return textResult(
      await withOperation(states, (operationId) =>
        gateway.post('/v1/runtime/search', input, operationId),
      ),
    );
  }
  if (name === 'memory_get') {
    const input = getSchema.parse(args);
    return textResult(
      await withOperation(states, (operationId) =>
        gateway.get(
          `/v1/runtime/memories/${encodeURIComponent(input.memoryId)}`,
          operationId,
        ),
      ),
    );
  }
  if (
    name === 'memory_propose_personal' ||
    name === 'memory_propose_repository'
  ) {
    const input = proposalSchema.parse(args);
    const scope =
      name === 'memory_propose_personal' ? 'personal' : 'repository';
    return textResult(
      await withOperation(states, (operationId) =>
        gateway.post('/v1/runtime/proposals', { scope, ...input }, operationId),
      ),
    );
  }
  if (name === 'memory_feedback') {
    const input = feedbackSchema.parse(args);
    return textResult(
      await withOperation(states, (operationId) =>
        gateway.post(
          '/v1/runtime/feedback',
          {
            event_id: operationId,
            session_id: process.env['QWEN_SESSION_ID'] ?? `mcp-${process.pid}`,
            occurred_at: new Date().toISOString(),
            memory_id: input.memoryId,
            signal: input.signal,
          },
          operationId,
        ),
      ),
    );
  }
  throw new UnknownToolError();
}

async function withOperation<T>(
  states: AgentStateStore,
  operation: (operationId: string) => Promise<T>,
): Promise<T> {
  const operationId = await states.beginOperation('mcp');
  const result = await operation(operationId);
  await states.completeOperation('mcp', operationId);
  return result;
}

function textResult(value: unknown): {
  content: [{ type: 'text'; text: string }];
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) ?? 'null' }],
  };
}

function successResponse(
  id: string | number,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function writeResponse(response: JsonRpcResponse): Promise<void> {
  const value = `${JSON.stringify(response)}\n`;
  if (!process.stdout.write(value)) {
    await new Promise<void>((resolve) => process.stdout.once('drain', resolve));
  }
}

class UnknownToolError extends Error {}
