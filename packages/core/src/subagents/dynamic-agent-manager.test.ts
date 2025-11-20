import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DynamicAgentManager } from './dynamic-agent-manager.js';
import type { Config } from '../config/config.js';

describe('DynamicAgentManager', () => {
  let mockConfig: Config;
  let agentManager: DynamicAgentManager;

  beforeEach(() => {
    mockConfig = {
      getToolRegistry: vi.fn(),
      getGeminiClient: vi.fn(),
      getModel: vi.fn(),
      getWorkspaceContext: vi.fn(),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      getSkipStartupContext: vi.fn().mockReturnValue(false),
      getDebugMode: vi.fn().mockReturnValue(false),
      getApprovalMode: vi.fn(),
      setApprovalMode: vi.fn(),
      getMcpServers: vi.fn(),
      getMcpServerCommand: vi.fn(),
      getPromptRegistry: vi.fn(),
      getWebSearchConfig: vi.fn(),
      getProxy: vi.fn(),
      getToolDiscoveryCommand: vi.fn(),
      getToolCallCommand: vi.fn(),
    } as unknown as Config;

    agentManager = new DynamicAgentManager(mockConfig);
  });

  it('should initialize correctly', () => {
    expect(agentManager).toBeDefined();
  });

  it('should validate agent definition', async () => {
    // Test with invalid name
    await expect(
      agentManager.registerAgent({
        name: '', // Invalid name
        description: 'A test agent',
        systemPrompt: 'Test system prompt',
      }),
    ).rejects.toThrow('Agent name is required and must be a string');

    // Test with invalid system prompt
    await expect(
      agentManager.registerAgent({
        name: 'test-agent',
        description: 'A test agent',
        systemPrompt: '', // Invalid system prompt
      }),
    ).rejects.toThrow('System prompt is required and must be a string');

    // Test with invalid description
    await expect(
      agentManager.registerAgent({
        name: 'test-agent',
        description: '', // Invalid description
        systemPrompt: 'Test system prompt',
      }),
    ).rejects.toThrow('Description is required and must be a string');
  });

  it('should create an agent instance without running it', async () => {
    const agent = await agentManager.createAgent({
      name: 'test-agent',
      description: 'A test agent',
      systemPrompt: 'You are a helpful assistant.',
    });

    expect(agent).toBeDefined();
    expect(agent.getFinalText()).toBe(''); // Should be empty since it hasn't run
  });
});
