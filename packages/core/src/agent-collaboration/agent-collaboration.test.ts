import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../config/config.js';
import {
  createAgentCollaborationAPI,
  executeCollaborativeTask,
  createAgentTeam,
} from './index.js';

// Mock the DynamicAgentManager
vi.mock('../subagents/dynamic-agent-manager.js', async () => {
  const actual = await vi.importActual('../subagents/dynamic-agent-manager.js');
  return {
    ...actual,
    DynamicAgentManager: class MockDynamicAgentManager {
      async executeAgent(
        name: string,
        systemPrompt: string,
        task: string,
        _tools?: string[],
      ) {
        // Simulate a successful execution with mock results
        return `Agent ${name} completed task: ${task}`;
      }
    },
  };
});

describe('Agent Collaboration API', () => {
  let mockConfig: Config;

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
  });

  it('should create collaboration API with all systems', () => {
    const api = createAgentCollaborationAPI(mockConfig);

    expect(api).toBeDefined();
    expect(api.coordination).toBeDefined();
    expect(api.communication).toBeDefined();
    expect(api.orchestration).toBeDefined();
    expect(api.memory).toBeDefined();
  });

  it('should execute a collaborative task in parallel', async () => {
    const agents = ['agent1', 'agent2', 'agent3'];
    const task = 'Perform a simple calculation';
    const strategy = 'parallel';

    const results = await executeCollaborativeTask(
      mockConfig,
      agents,
      task,
      strategy,
    );

    expect(results).toBeDefined();
    expect(Object.keys(results)).toEqual(agents);
    // All agents should have results
    for (const agent of agents) {
      expect(results[agent]).toBeDefined();
    }
  });

  it('should execute a collaborative task sequentially', async () => {
    const agents = ['agent1', 'agent2'];
    const task = 'Perform a sequential task';
    const strategy = 'sequential';

    const results = await executeCollaborativeTask(
      mockConfig,
      agents,
      task,
      strategy,
    );

    expect(results).toBeDefined();
    expect(Object.keys(results)).toEqual(agents);
    // Both agents should have results
    for (const agent of agents) {
      expect(results[agent]).toBeDefined();
    }
  });

  it('should execute a collaborative task with round-robin strategy', async () => {
    const agents = ['agent1', 'agent2', 'agent3'];
    const task = 'Process data in round-robin fashion';
    const strategy = 'round-robin';

    const results = await executeCollaborativeTask(
      mockConfig,
      agents,
      task,
      strategy,
    );

    expect(results).toBeDefined();
    expect(Object.keys(results)).toEqual(agents);
    // All agents should have results
    for (const agent of agents) {
      expect(results[agent]).toBeDefined();
    }
  });

  it('should create an agent team', async () => {
    const teamName = 'test-team';
    const agents = [
      { name: 'researcher', role: 'research specialist' },
      { name: 'architect', role: 'system designer' },
    ];
    const task = 'Design a new system architecture';

    const api = await createAgentTeam(mockConfig, teamName, agents, task);

    expect(api).toBeDefined();

    // Check if team info is stored in memory
    const teamInfo = await api.memory.get(`team:${teamName}`);
    expect(teamInfo).toBeDefined();
    const typedTeamInfo = teamInfo as {
      name: string;
      agents: Array<{ name: string; role: string }>;
    };
    expect(typedTeamInfo.name).toBe(teamName);
    expect(typedTeamInfo.agents).toEqual(agents);
  });
});
