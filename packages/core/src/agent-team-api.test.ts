import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgentTeamAPI } from './agent-team-api.js';
import type { Config } from './config/config.js';

describe('AgentTeamAPI', () => {
  let mockConfig: Config;
  let api: ReturnType<typeof createAgentTeamAPI>;

  beforeEach(() => {
    // Create a mock config for testing
    const mockToolRegistry = {
      registerTool: vi.fn(),
    };

    mockConfig = {
      getToolRegistry: vi.fn().mockReturnValue(mockToolRegistry),
      getGeminiClient: vi.fn(),
      getModel: vi.fn(),
      getWorkspaceContext: vi.fn(),
      // Add other required methods as needed
    } as unknown as Config;

    api = createAgentTeamAPI(mockConfig);
  });

  it('should create API with tools and agents managers', () => {
    expect(api).toBeDefined();
    expect(api.tools).toBeDefined();
    expect(api.agents).toBeDefined();
  });

  it('should allow registering a simple tool', async () => {
    await api.tools.registerTool({
      name: 'test-tool',
      description: 'A test tool',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string' },
        },
        required: ['input'],
      },
      execute: async (params) => `Processed: ${params['input']}`,
    });

    expect(mockConfig.getToolRegistry().registerTool).toHaveBeenCalled();
  });
});
