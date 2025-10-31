/**
 * TypeScript SDK for programmatic access to qwen-code CLI
 *
 * @example
 * ```typescript
 * import { query } from '@qwen-code/sdk-typescript';
 *
 * const q = query({
 *   prompt: 'What files are in this directory?',
 *   options: { cwd: process.cwd() },
 * });
 *
 * for await (const message of q) {
 *   if (message.type === 'assistant') {
 *     console.log(message.message.content);
 *   }
 * }
 *
 * await q.close();
 * ```
 */

// Main API
export { query } from './query/createQuery.js';

/** @deprecated Use query() instead */
export { createQuery } from './query/createQuery.js';

export { Query } from './query/Query.js';

// Configuration types
export type {
  CreateQueryOptions,
  PermissionMode,
  PermissionCallback,
  ExternalMcpServerConfig,
  TransportOptions,
} from './types/config.js';

export type { QueryOptions } from './query/createQuery.js';

// Protocol types
export type {
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  CLIUserMessage,
  CLIAssistantMessage,
  CLISystemMessage,
  CLIResultMessage,
  CLIPartialAssistantMessage,
  CLIMessage,
} from './types/protocol.js';

export {
  isCLIUserMessage,
  isCLIAssistantMessage,
  isCLISystemMessage,
  isCLIResultMessage,
  isCLIPartialAssistantMessage,
} from './types/protocol.js';

export type { JSONSchema } from './types/mcp.js';

export { AbortError, isAbortError } from './types/errors.js';

// Control Request Types
export {
  ControlRequestType,
  getAllControlRequestTypes,
  isValidControlRequestType,
} from './types/controlRequests.js';

// Transport
export { ProcessTransport } from './transport/ProcessTransport.js';
export type { Transport } from './transport/Transport.js';

// Utilities
export { Stream } from './utils/Stream.js';
export {
  serializeJsonLine,
  parseJsonLine,
  parseJsonLineSafe,
  isValidMessage,
  parseJsonLinesStream,
} from './utils/jsonLines.js';
export {
  findCliPath,
  resolveCliPath,
  prepareSpawnInfo,
} from './utils/cliPath.js';
export type { SpawnInfo } from './utils/cliPath.js';

// MCP helpers
export {
  createSdkMcpServer,
  createSimpleMcpServer,
} from './mcp/createSdkMcpServer.js';
export {
  tool,
  createTool,
  validateToolName,
  validateInputSchema,
} from './mcp/tool.js';

export type { ToolDefinition } from './types/config.js';
