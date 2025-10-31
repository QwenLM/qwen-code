/**
 * Tool definition helper for SDK-embedded MCP servers
 *
 * Provides type-safe tool definitions with generic input/output types.
 */

import type { ToolDefinition } from '../types/config.js';

/**
 * Create a type-safe tool definition
 *
 * Validates the tool definition and provides type inference for input/output types.
 *
 * @param def - Tool definition with handler
 * @returns The same tool definition (for type safety)
 *
 * @example
 * ```typescript
 * const weatherTool = tool<{ location: string }, { temperature: number }>({
 *   name: 'get_weather',
 *   description: 'Get weather for a location',
 *   inputSchema: {
 *     type: 'object',
 *     properties: {
 *       location: { type: 'string' }
 *     },
 *     required: ['location']
 *   },
 *   handler: async (input) => {
 *     return { temperature: await fetchWeather(input.location) };
 *   }
 * });
 * ```
 */
export function tool<TInput = unknown, TOutput = unknown>(
  def: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  // Validate tool definition
  if (!def.name || typeof def.name !== 'string') {
    throw new Error('Tool definition must have a name (string)');
  }

  if (!def.description || typeof def.description !== 'string') {
    throw new Error(
      `Tool definition for '${def.name}' must have a description (string)`,
    );
  }

  if (!def.inputSchema || typeof def.inputSchema !== 'object') {
    throw new Error(
      `Tool definition for '${def.name}' must have an inputSchema (object)`,
    );
  }

  if (!def.handler || typeof def.handler !== 'function') {
    throw new Error(
      `Tool definition for '${def.name}' must have a handler (function)`,
    );
  }

  // Return definition (pass-through for type safety)
  return def;
}

/**
 * Validate tool name
 *
 * Tool names must:
 * - Start with a letter
 * - Contain only letters, numbers, and underscores
 * - Be between 1 and 64 characters
 *
 * @param name - Tool name to validate
 * @throws Error if name is invalid
 */
export function validateToolName(name: string): void {
  if (!name) {
    throw new Error('Tool name cannot be empty');
  }

  if (name.length > 64) {
    throw new Error(
      `Tool name '${name}' is too long (max 64 characters): ${name.length}`,
    );
  }

  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(
      `Tool name '${name}' is invalid. Must start with a letter and contain only letters, numbers, and underscores.`,
    );
  }
}

/**
 * Validate tool input schema (JSON Schema compliance)
 *
 * @param schema - Input schema to validate
 * @throws Error if schema is invalid
 */
export function validateInputSchema(schema: unknown): void {
  if (!schema || typeof schema !== 'object') {
    throw new Error('Input schema must be an object');
  }

  const schemaObj = schema as Record<string, unknown>;

  if (!schemaObj.type) {
    throw new Error('Input schema must have a type field');
  }

  // For object schemas, validate properties
  if (schemaObj.type === 'object') {
    if (schemaObj.properties && typeof schemaObj.properties !== 'object') {
      throw new Error('Input schema properties must be an object');
    }

    if (schemaObj.required && !Array.isArray(schemaObj.required)) {
      throw new Error('Input schema required must be an array');
    }
  }
}

/**
 * Create tool definition with strict validation
 *
 * @param def - Tool definition
 * @returns Validated tool definition
 */
export function createTool<TInput = unknown, TOutput = unknown>(
  def: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  // Validate via tool() function
  const validated = tool(def);

  // Additional validation
  validateToolName(validated.name);
  validateInputSchema(validated.inputSchema);

  return validated;
}
