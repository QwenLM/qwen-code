/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type {
  ToolInvocation,
  ToolResult,
  ToolResultDisplay,
} from '../tools/tools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
} from '../tools/tools.js';
import { ToolErrorType } from '../tools/tool-error.js';

export interface DynamicToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  execute: (
    params: Record<string, unknown>,
    _config: Config,
  ) => Promise<unknown>;
}

class DynamicToolInvocation extends BaseToolInvocation<
  Record<string, unknown>,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    private readonly definition: DynamicToolDefinition,
    params: Record<string, unknown>,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Dynamic tool: ${this.definition.name} - ${this.definition.description}`;
  }

  async execute(
    _signal: AbortSignal,
    _updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    try {
      const result = await this.definition.execute(this.params, this.config);
      const resultString =
        typeof result === 'string' ? result : JSON.stringify(result);

      return {
        llmContent: resultString,
        returnDisplay:
          typeof result === 'string' ? result : JSON.stringify(result),
      };
    } catch (error) {
      const errorMessage = `Error executing dynamic tool ${this.definition.name}: ${error instanceof Error ? error.message : String(error)}`;
      return {
        llmContent: errorMessage,
        returnDisplay: errorMessage,
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }
}

class DynamicTool extends BaseDeclarativeTool<
  Record<string, unknown>,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    private readonly definition: DynamicToolDefinition,
  ) {
    super(
      definition.name,
      definition.name,
      definition.description,
      Kind.Other,
      definition.parameters,
    );
  }

  protected createInvocation(
    params: Record<string, unknown>,
  ): ToolInvocation<Record<string, unknown>, ToolResult> {
    return new DynamicToolInvocation(this.config, this.definition, params);
  }
}

export class DynamicToolManager {
  private toolRegistry: ToolRegistry;
  private config: Config;
  private dynamicTools: Map<string, DynamicToolDefinition> = new Map();

  constructor(config: Config) {
    this.config = config;
    this.toolRegistry = config.getToolRegistry();
  }

  /**
   * Register a new dynamic tool with the system
   */
  async registerTool(definition: DynamicToolDefinition): Promise<void> {
    // Validate tool definition
    if (!definition.name || typeof definition.name !== 'string') {
      throw new Error('Tool name is required and must be a string');
    }

    if (!definition.description || typeof definition.description !== 'string') {
      throw new Error('Tool description is required and must be a string');
    }

    if (!definition.parameters || typeof definition.parameters !== 'object') {
      throw new Error(
        'Tool parameters definition is required and must be an object',
      );
    }

    if (this.dynamicTools.has(definition.name)) {
      console.warn(
        `Dynamic tool with name "${definition.name}" already exists. Overwriting.`,
      );
    }

    // Create and register the declarative tool
    const dynamicTool = new DynamicTool(this.config, definition);

    // Register with the main tool registry
    this.toolRegistry.registerTool(dynamicTool);

    // Store the definition for reference
    this.dynamicTools.set(definition.name, definition);
  }

  /**
   * Unregister a dynamic tool
   */
  async unregisterTool(name: string): Promise<boolean> {
    if (!this.dynamicTools.has(name)) {
      return false;
    }

    // Note: In a real implementation, we might need to tell the registry to remove the tool
    // For now, we'll just track it internally
    this.dynamicTools.delete(name);

    return true;
  }

  /**
   * Get a dynamic tool definition
   */
  getToolDefinition(name: string): DynamicToolDefinition | undefined {
    return this.dynamicTools.get(name);
  }

  /**
   * Get all dynamic tool names
   */
  getAllToolNames(): string[] {
    return Array.from(this.dynamicTools.keys());
  }

  /**
   * Check if a tool exists in the dynamic tool registry
   */
  hasTool(name: string): boolean {
    return this.dynamicTools.has(name);
  }
}
