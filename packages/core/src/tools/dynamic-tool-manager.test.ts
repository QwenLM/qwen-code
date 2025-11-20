import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DynamicToolManager,
  type DynamicToolDefinition,
} from './dynamic-tool-manager.js';
import type { Config } from '../config/config.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

describe('DynamicToolManager', () => {
  let mockConfig: Config;
  let mockToolRegistry: ToolRegistry;
  let toolManager: DynamicToolManager;

  beforeEach(() => {
    mockToolRegistry = {
      registerTool: vi.fn(),
    } as unknown as ToolRegistry;

    mockConfig = {
      getToolRegistry: vi.fn().mockReturnValue(mockToolRegistry),
    } as unknown as Config;

    toolManager = new DynamicToolManager(mockConfig);
  });

  it('should initialize with the provided config', () => {
    expect(toolManager).toBeDefined();
    expect(mockConfig.getToolRegistry).toHaveBeenCalled();
  });

  it('should register a new dynamic tool', async () => {
    const toolDefinition: DynamicToolDefinition = {
      name: 'test-tool',
      description: 'A test tool',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string' },
        },
        required: ['input'],
      },
      execute: async (params: Record<string, unknown>, _config: Config) =>
        `Processed: ${params['input']}`,
    };

    await toolManager.registerTool(toolDefinition);

    expect(mockToolRegistry.registerTool).toHaveBeenCalled();
    expect(toolManager.getToolDefinition('test-tool')).toEqual(toolDefinition);
  });

  it('should allow unregistering a tool', async () => {
    const toolDefinition: DynamicToolDefinition = {
      name: 'test-tool',
      description: 'A test tool',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string' },
        },
        required: ['input'],
      },
      execute: async (params: Record<string, unknown>, _config: Config) =>
        `Processed: ${params['input']}`,
    };

    await toolManager.registerTool(toolDefinition);
    const result = await toolManager.unregisterTool('test-tool');

    expect(result).toBe(true);
    expect(toolManager.getToolDefinition('test-tool')).toBeUndefined();
  });

  it('should return false when unregistering a non-existent tool', async () => {
    const result = await toolManager.unregisterTool('non-existent-tool');
    expect(result).toBe(false);
  });

  it('should return all registered tool names', async () => {
    const toolDefinition1: DynamicToolDefinition = {
      name: 'test-tool-1',
      description: 'First test tool',
      parameters: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input'],
      },
      execute: async (params: Record<string, unknown>, _config: Config) =>
        `Processed: ${params['input']}`,
    };

    const toolDefinition2: DynamicToolDefinition = {
      name: 'test-tool-2',
      description: 'Second test tool',
      parameters: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input'],
      },
      execute: async (params: Record<string, unknown>, _config: Config) =>
        `Processed: ${params['input']}`,
    };

    await toolManager.registerTool(toolDefinition1);
    await toolManager.registerTool(toolDefinition2);

    const toolNames = toolManager.getAllToolNames();
    expect(toolNames).toContain('test-tool-1');
    expect(toolNames).toContain('test-tool-2');
    expect(toolNames).toHaveLength(2);
  });

  it('should validate tool definition', async () => {
    // Test with invalid name
    await expect(
      toolManager.registerTool({
        name: '', // Invalid name
        description: 'A test tool',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
        },
        execute: async (params: Record<string, unknown>, _config: Config) =>
          `Processed: ${params['input']}`,
      } as DynamicToolDefinition),
    ).rejects.toThrow('Tool name is required and must be a string');

    // Test with invalid description
    await expect(
      toolManager.registerTool({
        name: 'test-tool',
        description: '', // Invalid description
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
        },
        execute: async (params: Record<string, unknown>, _config: Config) =>
          `Processed: ${params['input']}`,
      } as DynamicToolDefinition),
    ).rejects.toThrow('Tool description is required and must be a string');

    // Test with invalid parameters
    await expect(
      toolManager.registerTool({
        name: 'test-tool',
        description: 'A test tool',
        parameters: null as {
          type: 'object';
          properties: Record<string, unknown>;
          required: string[];
        }, // Invalid parameters
        execute: async (params: Record<string, unknown>, _config: Config) =>
          `Processed: ${params['input']}`,
      }),
    ).rejects.toThrow(
      'Tool parameters definition is required and must be an object',
    );
  });
});
