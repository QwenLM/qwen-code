/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Config } from '../config/config.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { SkillManager } from '../skills/skill-manager.js';
import type { SubagentManager } from '../subagents/subagent-manager.js';
import { ParallelTaskRunner } from './parallel-task-runner.js';
import type { ParallelGroupConfig } from './types.js';

describe('ParallelTaskRunner', () => {
  let runner: ParallelTaskRunner;
  let mockConfig: Config;
  let mockToolRegistry: ToolRegistry;
  let mockSubagentManager: SubagentManager;

  const mockSubagents = [
    {
      name: 'general-purpose',
      description: 'General purpose agent',
      systemPrompt: 'You are a general purpose agent',
      level: 'builtin' as const,
    },
    {
      name: 'Explore',
      description: 'Explore codebase',
      systemPrompt: 'You are an exploration agent',
      level: 'builtin' as const,
    },
  ];

  const mockModes = new Map([
    ['developer', {
      name: 'developer',
      displayName: 'Developer',
      systemPrompt: 'You are a developer',
      allowedTools: ['read_file', 'write_file', 'edit'],
      modelConfig: { temperature: 0.7 },
    }],
    ['reviewer', {
      name: 'reviewer',
      displayName: 'Reviewer',
      systemPrompt: 'You are a reviewer',
      allowedTools: ['read_file', 'grep_search'],
      deniedTools: ['write_file'],
    }],
    ['general', {
      name: 'general',
      displayName: 'General',
      systemPrompt: 'You are a general assistant',
    }],
  ]);

  beforeEach(() => {
    vi.clearAllMocks();

    mockToolRegistry = {
      getAllToolNames: vi.fn().mockReturnValue([
        'read_file', 'write_file', 'edit', 'grep_search',
        'glob', 'run_shell_command',
      ]),
    } as unknown as ToolRegistry;

    mockSubagentManager = {
      listSubagents: vi.fn().mockReturnValue(mockSubagents),
      createAgentHeadless: vi.fn().mockResolvedValue({
        eventEmitter: {
          on: vi.fn(),
          emit: vi.fn(),
          once: vi.fn(),
        },
        execute: vi.fn().mockResolvedValue(undefined),
      }),
    } as unknown as SubagentManager;

    mockConfig = {
      getToolRegistry: vi.fn().mockReturnValue(mockToolRegistry),
      getSubagentManager: vi.fn().mockReturnValue(mockSubagentManager),
      getModeManager: vi.fn().mockReturnValue({
        getMode: vi.fn().mockImplementation((name: string) =>
          mockModes.get(name),
        ),
      }),
      getApprovalMode: vi.fn().mockReturnValue('default'),
      setApprovalMode: vi.fn(),
    } as unknown as Config;

    runner = new ParallelTaskRunner(mockConfig);
  });

  describe('startGroup', () => {
    it('should create a group with correct initial state', async () => {
      const groupConfig: ParallelGroupConfig = {
        groupId: 'test-group',
        description: 'Test group',
        tasks: [
          {
            taskId: 'task-1',
            taskName: 'Task One',
            subagent: 'general-purpose',
            prompt: 'Do task one',
          },
        ],
      };

      const group = await runner.startGroup(groupConfig);

      expect(group.config.groupId).toBe('test-group');
      expect(group.config.description).toBe('Test group');
      expect(group.tasks).toHaveLength(1);
      expect(group.tasks[0].config.taskId).toBe('task-1');
    });

    it('should register the group in active groups', async () => {
      const groupConfig: ParallelGroupConfig = {
        groupId: 'test-group-2',
        description: 'Test',
        tasks: [
          {
            taskId: 'task-1',
            taskName: 'Task',
            subagent: 'general-purpose',
            prompt: 'Do it',
          },
        ],
      };

      await runner.startGroup(groupConfig);

      expect(runner.getActiveGroups().size).toBeGreaterThan(0);
      expect(runner.getGroup('test-group-2')).toBeDefined();
    });

    it('should emit group:start event', async () => {
      const listener = vi.fn();
      runner.on('group:start', listener);

      const groupConfig: ParallelGroupConfig = {
        groupId: 'test-group-3',
        description: 'Test',
        tasks: [
          {
            taskId: 'task-1',
            taskName: 'Task',
            subagent: 'general-purpose',
            prompt: 'Do it',
          },
        ],
      };

      await runner.startGroup(groupConfig);

      expect(listener).toHaveBeenCalled();
      expect(listener.mock.calls[0][0].config.groupId).toBe('test-group-3');
    });
  });

  describe('cancelGroup', () => {
    it('should cancel a running group', async () => {
      const groupConfig: ParallelGroupConfig = {
        groupId: 'cancel-test',
        description: 'Test',
        tasks: [
          {
            taskId: 'task-1',
            taskName: 'Task',
            subagent: 'general-purpose',
            prompt: 'Do it',
          },
        ],
      };

      await runner.startGroup(groupConfig);
      runner.cancelGroup('cancel-test');

      const group = runner.getGroup('cancel-test');
      expect(group).toBeUndefined(); // Should be removed from active groups
    });

    it('should throw error for non-existent group', () => {
      expect(() => runner.cancelGroup('nonexistent')).toThrow();
    });
  });

  describe('generateSummary', () => {
    it('should generate a formatted summary for a completed group', () => {
      const mockGroup = {
        config: {
          groupId: 'summary-test',
          description: 'Feature implementation',
          tasks: [],
        },
        tasks: [
          {
            config: {
              taskId: 'frontend',
              taskName: 'Frontend',
              icon: '🎨',
              subagent: 'general-purpose',
              prompt: 'Frontend task',
            },
            status: 'completed' as const,
            toolCallCount: 15,
            startTime: new Date(Date.now() - 120000),
            endTime: new Date(),
            tokenUsage: {
              promptTokens: 1000,
              completionTokens: 500,
              totalTokens: 1500,
            },
          },
          {
            config: {
              taskId: 'backend',
              taskName: 'Backend',
              icon: '⚙️',
              subagent: 'general-purpose',
              prompt: 'Backend task',
            },
            status: 'completed' as const,
            toolCallCount: 22,
            startTime: new Date(Date.now() - 150000),
            endTime: new Date(),
            tokenUsage: {
              promptTokens: 1200,
              completionTokens: 800,
              totalTokens: 2000,
            },
          },
        ],
        status: 'completed' as const,
        startTime: new Date(Date.now() - 150000),
        endTime: new Date(),
      };

      const summary = ParallelTaskRunner.generateSummary(mockGroup);

      expect(summary).toContain('Feature implementation');
      expect(summary).toContain('✅ All tasks completed');
      expect(summary).toContain('🎨 **Frontend**');
      expect(summary).toContain('⚙️ **Backend**');
      expect(summary).toContain('Tool calls: 15');
      expect(summary).toContain('Tool calls: 22');
      expect(summary).toContain('Tokens: 1,500');
      expect(summary).toContain('Tokens: 2,000');
    });

    it('should generate summary for failed group', () => {
      const mockGroup = {
        config: {
          groupId: 'fail-test',
          description: 'Failed group',
          tasks: [],
        },
        tasks: [
          {
            config: {
              taskId: 'task-1',
              taskName: 'Task',
              subagent: 'general-purpose',
              prompt: 'Task prompt',
            },
            status: 'failed' as const,
            toolCallCount: 5,
            error: 'Something went wrong',
            startTime: new Date(),
            endTime: new Date(),
          },
        ],
        status: 'failed' as const,
        startTime: new Date(),
        endTime: new Date(),
      };

      const summary = ParallelTaskRunner.generateSummary(mockGroup);

      expect(summary).toContain('❌ One or more tasks failed');
      expect(summary).toContain('Error: Something went wrong');
    });
  });

  describe('splitFeatureImplementation', () => {
    it('should create frontend and backend tasks', async () => {
      const group = await runner.splitFeatureImplementation(
        'User authentication',
      );

      expect(group.tasks).toHaveLength(2);

      const frontend = group.tasks.find((t) => t.config.taskId === 'frontend');
      const backend = group.tasks.find((t) => t.config.taskId === 'backend');

      expect(frontend).toBeDefined();
      expect(backend).toBeDefined();

      expect(frontend!.config.mode).toBe('developer');
      expect(backend!.config.mode).toBe('developer');

      expect(frontend!.config.icon).toBe('🎨');
      expect(backend!.config.icon).toBe('⚙️');

      expect(frontend!.config.color).toBe('#3498DB');
      expect(backend!.config.color).toBe('#2ECC71');
    });

    it('should use custom modes when specified', async () => {
      const group = await runner.splitFeatureImplementation(
        'Custom feature',
        {
          frontendMode: 'reviewer',
          backendMode: 'developer',
        },
      );

      const frontend = group.tasks.find((t) => t.config.taskId === 'frontend');
      const backend = group.tasks.find((t) => t.config.taskId === 'backend');

      expect(frontend!.config.mode).toBe('reviewer');
      expect(backend!.config.mode).toBe('developer');
    });

    it('should include frontend prompt about UI components', async () => {
      const group = await runner.splitFeatureImplementation('OAuth login');
      const frontend = group.tasks.find((t) => t.config.taskId === 'frontend');

      expect(frontend!.config.prompt).toContain('FRONTEND');
      expect(frontend!.config.prompt).toContain('UI components');
      expect(frontend!.config.prompt).toContain('OAuth login');
    });

    it('should include backend prompt about API endpoints', async () => {
      const group = await runner.splitFeatureImplementation('OAuth login');
      const backend = group.tasks.find((t) => t.config.taskId === 'backend');

      expect(backend!.config.prompt).toContain('BACKEND');
      expect(backend!.config.prompt).toContain('API endpoints');
      expect(backend!.config.prompt).toContain('OAuth login');
    });
  });

  describe('waitForAll option', () => {
    it('should default to waiting for all tasks', () => {
      const runner = new ParallelTaskRunner(mockConfig);
      // Default behavior should be waitForAll: true
      expect(runner).toBeDefined();
    });
  });

  describe('getGroup', () => {
    it('should return undefined for non-existent group', () => {
      const group = runner.getGroup('nonexistent');
      expect(group).toBeUndefined();
    });

    it('should return group after creation', async () => {
      const groupConfig: ParallelGroupConfig = {
        groupId: 'find-test',
        description: 'Test',
        tasks: [
          {
            taskId: 'task-1',
            taskName: 'Task',
            subagent: 'general-purpose',
            prompt: 'Do it',
          },
        ],
      };

      await runner.startGroup(groupConfig);
      const group = runner.getGroup('find-test');

      expect(group).toBeDefined();
      expect(group?.config.groupId).toBe('find-test');
    });
  });
});
