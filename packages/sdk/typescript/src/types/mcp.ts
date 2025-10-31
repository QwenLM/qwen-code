/**
 * MCP integration types for SDK
 */

/**
 * JSON Schema definition
 * Used for tool input validation
 */
export type JSONSchema = {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  description?: string;
  [key: string]: unknown;
};

/**
 * Tool definition for SDK-embedded MCP servers
 *
 * @template TInput - Type of tool input (inferred from handler)
 * @template TOutput - Type of tool output (inferred from handler return)
 */
export type ToolDefinition<TInput = unknown, TOutput = unknown> = {
  /** Unique tool name */
  name: string;
  /** Human-readable description (helps agent decide when to use it) */
  description: string;
  /** JSON Schema for input validation */
  inputSchema: JSONSchema;
  /** Async handler function that executes the tool */
  handler: (input: TInput) => Promise<TOutput>;
};
