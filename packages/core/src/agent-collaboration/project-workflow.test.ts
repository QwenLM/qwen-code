/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../config/config.js';
import {
  createAndExecuteProjectWorkflow,
  ProjectWorkflowOrchestrator,
} from './project-workflow.js';

// Mock the DynamicAgentManager to avoid actual agent execution during tests
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
        _context?: Record<string, unknown>,
      ) {
        // Simulate a successful execution with mock results specific to each agent type
        const agentResults: Record<string, string> = {
          'general-purpose': `Supervisor ${name} completed oversight task: ${task.substring(0, 50)}...`,
          'deep-web-search': `Researcher ${name} completed web search on: ${task.substring(0, 50)}...`,
          'project-manager': `PM ${name} completed project task: ${task.substring(0, 50)}...`,
          'deep-planner': `Planner ${name} completed planning for: ${task.substring(0, 50)}...`,
          'deep-researcher': `Deep researcher ${name} completed research: ${task.substring(0, 50)}...`,
          'software-architecture': `Architect ${name} completed design for: ${task.substring(0, 50)}...`,
          'software-engineer': `Engineer ${name} completed implementation: ${task.substring(0, 50)}...`,
          'software-tester': `Tester ${name} completed validation: ${task.substring(0, 50)}...`,
        };

        return (
          agentResults[name] ||
          `Agent ${name} completed task: ${task.substring(0, 50)}...`
        );
      }
    },
  };
});

describe('ProjectWorkflowOrchestrator', () => {
  let mockConfig: Config;

  beforeEach(() => {
    // Create a mock config for testing
    const mockToolRegistry = {
      registerTool: vi.fn(),
    };

    const mockSubagentManager = {
      listSubagents: vi.fn().mockResolvedValue([]),
    };

    mockConfig = {
      getToolRegistry: vi.fn().mockReturnValue(mockToolRegistry),
      getGeminiClient: vi.fn(),
      getModel: vi.fn(),
      getWorkspaceContext: vi.fn(),
      getSubagentManager: vi.fn().mockReturnValue(mockSubagentManager),
      // Add other required methods as needed
    } as unknown as Config;
  });

  it('should create a ProjectWorkflowOrchestrator instance', () => {
    const options = {
      projectName: 'test-project',
      projectGoal: 'Build a test application',
    };

    const orchestrator = new ProjectWorkflowOrchestrator(mockConfig, options);

    expect(orchestrator).toBeDefined();
  });

  it('should execute complete workflow successfully', async () => {
    const options = {
      projectName: 'test-project',
      projectGoal: 'Build a test application',
      timeline: '3 months',
      stakeholders: ['client', 'dev-team'],
      constraints: ['budget', 'deadline'],
    };

    const result = await createAndExecuteProjectWorkflow(mockConfig, options);

    // Check that all phases are represented in the results
    expect(result).toHaveProperty('projectPhase');
    expect(result).toHaveProperty('planningPhase');
    expect(result).toHaveProperty('researchPhase');
    expect(result).toHaveProperty('designPhase');
    expect(result).toHaveProperty('implementationPhase');
    expect(result).toHaveProperty('testingPhase');
    expect(result).toHaveProperty('review');

    // Verify that the results contain expected content
    expect(typeof result['projectPhase']).toBe('string');
    expect(typeof result['planningPhase']).toBe('string');
    expect(typeof result['researchPhase']).toBe('object'); // Since research combines two agents
    expect(typeof result['designPhase']).toBe('string');
    expect(typeof result['implementationPhase']).toBe('string');
    expect(typeof result['testingPhase']).toBe('string');
    expect(typeof result['review']).toBe('string');
  });

  it('should create the correct workflow steps', async () => {
    const options = {
      projectName: 'test-project',
      projectGoal: 'Build a test application',
    };

    const orchestrator = new ProjectWorkflowOrchestrator(mockConfig, options);
    const workflowSteps = await orchestrator.createProjectWorkflow();

    expect(workflowSteps).toHaveLength(8); // 8 phases including web research and final review

    // Check the order of steps
    expect(workflowSteps[0].agent).toBe('project-manager');
    expect(workflowSteps[1].agent).toBe('deep-planner');
    expect(workflowSteps[2].agent).toBe('deep-researcher');
    expect(workflowSteps[3].agent).toBe('deep-web-search');
    expect(workflowSteps[4].agent).toBe('software-architecture');
    expect(workflowSteps[5].agent).toBe('software-engineer');
    expect(workflowSteps[6].agent).toBe('software-tester');
    expect(workflowSteps[7].agent).toBe('general-purpose');
  });

  it('should execute workflow using orchestration system', async () => {
    const options = {
      projectName: 'test-project',
      projectGoal: 'Build a test application',
    };

    const orchestrator = new ProjectWorkflowOrchestrator(mockConfig, options);

    // We're testing that the method executes without errors
    // In a real test, we would verify the workflow execution
    const result = await orchestrator.executeAsWorkflow();

    // The result would be the output of the orchestration execution
    expect(result).toBeDefined();
  });
});
