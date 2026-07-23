/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TodoWriteParams } from './todoWrite.js';
import { TodoWriteTool, listTodoSessions } from './todoWrite.js';
import { DefaultHookOutput, HookPhase, type TodoItem } from '../hooks/types.js';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import type { AggregatedHookResult } from '../hooks/hookAggregator.js';
import { Storage } from '../config/storage.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';

// Mock fs modules
vi.mock('fs/promises');
vi.mock('fs');

vi.mock('../utils/atomicFileWrite.js', () => ({
  atomicWriteFile: vi.fn(),
}));

const mockFs = vi.mocked(fs);
const mockFsSync = vi.mocked(fsSync);
const mockAtomicWrite = vi.mocked(atomicWriteFile);

describe('TodoWriteTool', () => {
  let tool: TodoWriteTool;
  let mockAbortSignal: AbortSignal;
  let mockConfig: Config;

  beforeEach(() => {
    mockConfig = {
      getSessionId: () => 'test-session-123',
      getHookSystem: () => undefined,
    } as Config;
    tool = new TodoWriteTool(mockConfig);
    mockAbortSignal = new AbortController().signal;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validateToolParams', () => {
    it('should validate correct parameters', () => {
      const params: TodoWriteParams = {
        todos: [
          { id: '1', content: 'Task 1', status: 'pending' },
          { id: '2', content: 'Task 2', status: 'in_progress' },
        ],
      };

      const result = tool.validateToolParams(params);
      expect(result).toBeNull();
    });

    it('should accept empty todos array', () => {
      const params: TodoWriteParams = {
        todos: [],
      };

      const result = tool.validateToolParams(params);
      expect(result).toBeNull();
    });

    it('should accept single todo', () => {
      const params: TodoWriteParams = {
        todos: [{ id: '1', content: 'Task 1', status: 'pending' }],
      };

      const result = tool.validateToolParams(params);
      expect(result).toBeNull();
    });

    it('should reject todos with empty content', () => {
      const params: TodoWriteParams = {
        todos: [
          { id: '1', content: '', status: 'pending' },
          { id: '2', content: 'Task 2', status: 'pending' },
        ],
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain(
        'Each todo must have a non-empty "content" string',
      );
    });

    it('should reject todos with empty id', () => {
      const params: TodoWriteParams = {
        todos: [
          { id: '', content: 'Task 1', status: 'pending' },
          { id: '2', content: 'Task 2', status: 'pending' },
        ],
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('non-empty "id" string');
    });

    it('should reject oversized todo and dependency ids', () => {
      expect(
        tool.validateToolParams({
          todos: [{ id: 'x'.repeat(501), content: 'Task', status: 'pending' }],
        }),
      ).toContain('at most 500 characters');
      expect(
        tool.validateToolParams({
          todos: [
            {
              id: 'task',
              content: 'Task',
              status: 'pending',
              blockedBy: ['x'.repeat(501)],
            },
          ],
        }),
      ).toContain('at most 500 characters');
    });

    it('should reject todos with invalid status', () => {
      const params: TodoWriteParams = {
        todos: [
          {
            id: '1',
            content: 'Task 1',
            status: 'invalid' as TodoItem['status'],
          },
          { id: '2', content: 'Task 2', status: 'pending' },
        ],
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain(
        'Each todo must have a valid "status" (pending, in_progress, completed)',
      );
    });

    it('should reject todos with duplicate IDs', () => {
      const params: TodoWriteParams = {
        todos: [
          { id: '1', content: 'Task 1', status: 'pending' },
          { id: '1', content: 'Task 2', status: 'pending' },
        ],
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('unique');
    });

    it('should accept a valid dependency graph', () => {
      expect(
        tool.validateToolParams({
          todos: [
            { id: 'design', content: 'Design', status: 'completed' },
            {
              id: 'build',
              content: 'Build',
              status: 'pending',
              blockedBy: ['design'],
            },
          ],
        }),
      ).toBeNull();
    });

    it('should validate deep dependency chains without recursive traversal', () => {
      const todos = Array.from({ length: 3_000 }, (_, index) => ({
        id: `todo-${index}`,
        content: `Todo ${index}`,
        status: 'pending' as const,
        ...(index === 0 ? {} : { blockedBy: [`todo-${index - 1}`] }),
      }));

      expect(tool.validateToolParams({ todos })).toBeNull();
    });

    it.each([
      {
        name: 'duplicate dependency',
        todos: [
          { id: 'a', content: 'A', status: 'pending' as const },
          {
            id: 'b',
            content: 'B',
            status: 'pending' as const,
            blockedBy: ['a', 'a'],
          },
        ],
        error: 'duplicate blockedBy',
      },
      {
        name: 'unknown dependency',
        todos: [
          {
            id: 'a',
            content: 'A',
            status: 'pending' as const,
            blockedBy: ['missing'],
          },
        ],
        error: 'unknown dependency',
      },
      {
        name: 'self dependency',
        todos: [
          {
            id: 'a',
            content: 'A',
            status: 'pending' as const,
            blockedBy: ['a'],
          },
        ],
        error: 'must not depend on itself',
      },
      {
        name: 'cycle',
        todos: [
          {
            id: 'a',
            content: 'A',
            status: 'pending' as const,
            blockedBy: ['b'],
          },
          {
            id: 'b',
            content: 'B',
            status: 'pending' as const,
            blockedBy: ['a'],
          },
        ],
        error: 'must not contain a cycle',
      },
    ])('should reject a $name', ({ todos, error }) => {
      expect(tool.validateToolParams({ todos })).toContain(error);
    });
  });

  describe('execute', () => {
    it('should create new todos file when none exists', async () => {
      const params: TodoWriteParams = {
        todos: [
          { id: '1', content: 'Task 1', status: 'pending' },
          { id: '2', content: 'Task 2', status: 'in_progress' },
        ],
      };

      // Mock file not existing (use proper Error object)
      const enoentError = new Error('ENOENT') as Error & { code: string };
      enoentError.code = 'ENOENT';
      mockFs.readFile.mockRejectedValue(enoentError);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockAtomicWrite.mockResolvedValue(undefined);

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain(
        'Todos have been modified successfully',
      );
      expect(result.llmContent).toContain('<system-reminder>');
      expect(result.llmContent).toContain('Your todo list has changed');
      expect(result.llmContent).toContain(JSON.stringify(params.todos));
      expect(result.returnDisplay).toMatchObject({
        type: 'todo_list',
        planId: expect.any(String),
        todos: [
          { id: '1', content: 'Task 1', status: 'pending' },
          { id: '2', content: 'Task 2', status: 'in_progress' },
        ],
      });
      expect(mockAtomicWrite).toHaveBeenCalledWith(
        expect.stringContaining('test-session-123.json'),
        expect.stringContaining('"todos"'),
        { encoding: 'utf-8' },
      );
      expect(
        JSON.parse(mockAtomicWrite.mock.calls[0][1] as string),
      ).toMatchObject({ planId: expect.any(String), todos: params.todos });
    });

    it('should retain the plan ID while an active plan is revised', async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({
          planId: 'plan-1',
          todos: [{ id: '1', content: 'Task', status: 'in_progress' }],
        }),
      );
      mockFs.mkdir.mockResolvedValue(undefined);
      mockAtomicWrite.mockResolvedValue(undefined);

      const result = await tool
        .build({
          todos: [{ id: '1', content: 'Task', status: 'completed' }],
        })
        .execute(mockAbortSignal);

      expect(result.returnDisplay).toMatchObject({ planId: 'plan-1' });
      expect(
        JSON.parse(mockAtomicWrite.mock.calls[0][1] as string),
      ).toMatchObject({ planId: 'plan-1' });
    });

    it('should retain the plan ID for a repeated terminal snapshot', async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({
          planId: 'finished-plan',
          todos: [{ id: '1', content: 'Done', status: 'completed' }],
        }),
      );
      mockFs.mkdir.mockResolvedValue(undefined);
      mockAtomicWrite.mockResolvedValue(undefined);

      const result = await tool
        .build({
          todos: [{ id: '1', content: 'Still done', status: 'completed' }],
        })
        .execute(mockAbortSignal);

      expect(result.returnDisplay).toMatchObject({ planId: 'finished-plan' });
      expect(
        JSON.parse(mockAtomicWrite.mock.calls[0][1] as string),
      ).toMatchObject({ planId: 'finished-plan' });
    });

    it('should start a new plan after the previous plan completed', async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({
          planId: 'finished-plan',
          todos: [{ id: '1', content: 'Done', status: 'completed' }],
        }),
      );
      mockFs.mkdir.mockResolvedValue(undefined);
      mockAtomicWrite.mockResolvedValue(undefined);

      const result = await tool
        .build({ todos: [{ id: '2', content: 'New', status: 'pending' }] })
        .execute(mockAbortSignal);
      const display = result.returnDisplay as { planId?: string };

      expect(display.planId).toEqual(expect.any(String));
      expect(display.planId).not.toBe('finished-plan');
    });

    it('should clear persisted plan identity while identifying the cleared plan', async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({
          planId: 'plan-to-clear',
          todos: [{ id: '1', content: 'Task', status: 'in_progress' }],
        }),
      );
      mockFs.mkdir.mockResolvedValue(undefined);
      mockAtomicWrite.mockResolvedValue(undefined);

      const result = await tool.build({ todos: [] }).execute(mockAbortSignal);
      const persisted = JSON.parse(mockAtomicWrite.mock.calls[0][1] as string);

      expect(result.returnDisplay).toMatchObject({
        type: 'todo_list',
        planId: 'plan-to-clear',
        todos: [],
      });
      expect(persisted).not.toHaveProperty('planId');
    });

    it('should replace todos with new ones', async () => {
      const existingTodos = [
        { id: '1', content: 'Existing Task', status: 'completed' },
      ];

      const params: TodoWriteParams = {
        todos: [
          { id: '1', content: 'Updated Task', status: 'completed' },
          { id: '2', content: 'New Task', status: 'pending' },
        ],
      };

      // Mock existing file
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ todos: existingTodos }),
      );
      mockFs.mkdir.mockResolvedValue(undefined);
      mockAtomicWrite.mockResolvedValue(undefined);

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain(
        'Todos have been modified successfully',
      );
      expect(result.llmContent).toContain('<system-reminder>');
      expect(result.llmContent).toContain('Your todo list has changed');
      expect(result.llmContent).toContain(JSON.stringify(params.todos));
      expect(result.returnDisplay).toMatchObject({
        type: 'todo_list',
        todos: [
          { id: '1', content: 'Updated Task', status: 'completed' },
          { id: '2', content: 'New Task', status: 'pending' },
        ],
      });
      expect(mockAtomicWrite).toHaveBeenCalledWith(
        expect.stringContaining('test-session-123.json'),
        expect.stringMatching(/"Updated Task"/),
        { encoding: 'utf-8' },
      );
    });

    it('should handle file write errors', async () => {
      const params: TodoWriteParams = {
        todos: [
          { id: '1', content: 'Task 1', status: 'pending' },
          { id: '2', content: 'Task 2', status: 'pending' },
        ],
      };

      // Mock readTodosFromFile returning empty array (file not existing)
      const enoentError = new Error('ENOENT') as Error & { code: string };
      enoentError.code = 'ENOENT';
      mockFs.readFile.mockRejectedValue(enoentError);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockAtomicWrite.mockRejectedValue(new Error('Write failed'));

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('Failed to modify todos');
      expect(result.llmContent).toContain('<system-reminder>');
      expect(result.llmContent).toContain('Todo list modification failed');
      expect(result.llmContent).toContain('Write failed');
      expect(result.returnDisplay).toContain('Error writing todos');
    });

    it('should handle empty todos array', async () => {
      const params: TodoWriteParams = {
        todos: [],
      };

      mockFs.mkdir.mockResolvedValue(undefined);
      mockAtomicWrite.mockResolvedValue(undefined);
      // Mock readTodosFromFile returning existing todos
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({
          todos: [{ id: '1', content: 'Old Task', status: 'pending' }],
        }),
      );

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('Todo list has been cleared');
      expect(result.llmContent).toContain('<system-reminder>');
      expect(result.llmContent).toContain('Your todo list is now empty');
      expect(result.llmContent).toContain('no pending tasks');
      expect(result.returnDisplay).toMatchObject({
        type: 'todo_list',
        todos: [],
      });
      expect(mockAtomicWrite).toHaveBeenCalledWith(
        expect.stringContaining('test-session-123.json'),
        expect.stringContaining('"todos"'),
        { encoding: 'utf-8' },
      );
    });

    it('should block todo creation when validation hook returns block', async () => {
      const hookResult: AggregatedHookResult = {
        success: true,
        allOutputs: [
          new DefaultHookOutput({
            decision: 'block',
            reason: 'Creation denied',
          }),
        ],
        errors: [],
        totalDuration: 10,
        finalOutput: new DefaultHookOutput({
          decision: 'block',
          reason: 'Creation denied',
        }),
      };
      const mockHookSystem = {
        fireTodoCreatedEvent: vi.fn().mockResolvedValue(hookResult),
        fireTodoCompletedEvent: vi.fn(),
      };
      mockConfig = {
        getSessionId: () => 'test-session-123',
        getHookSystem: () => mockHookSystem,
      } as unknown as Config;
      tool = new TodoWriteTool(mockConfig);

      const params: TodoWriteParams = {
        todos: [{ id: '1', content: 'Task 1', status: 'pending' }],
      };

      const enoentError = new Error('ENOENT') as Error & { code: string };
      enoentError.code = 'ENOENT';
      mockFs.readFile.mockRejectedValue(enoentError);

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(mockHookSystem.fireTodoCreatedEvent).toHaveBeenCalledWith(
        '1',
        'Task 1',
        'pending',
        params.todos,
        HookPhase.Validation,
        mockAbortSignal,
      );
      expect(mockAtomicWrite).not.toHaveBeenCalled();
      expect(result.llmContent).toContain(
        'Todo creation blocked: Creation denied',
      );
      expect(result.returnDisplay).toBe(
        'Todo creation blocked: Creation denied',
      );
    });

    it('should block todo completion when validation hook returns block', async () => {
      const hookResult: AggregatedHookResult = {
        success: true,
        allOutputs: [
          new DefaultHookOutput({
            decision: 'block',
            reason: 'Completion denied',
          }),
        ],
        errors: [],
        totalDuration: 10,
        finalOutput: new DefaultHookOutput({
          decision: 'block',
          reason: 'Completion denied',
        }),
      };
      const mockHookSystem = {
        fireTodoCreatedEvent: vi.fn(),
        fireTodoCompletedEvent: vi.fn().mockResolvedValue(hookResult),
      };
      mockConfig = {
        getSessionId: () => 'test-session-123',
        getHookSystem: () => mockHookSystem,
      } as unknown as Config;
      tool = new TodoWriteTool(mockConfig);

      const existingTodos = [
        { id: '1', content: 'Task 1', status: 'in_progress' },
      ];
      const params: TodoWriteParams = {
        todos: [{ id: '1', content: 'Task 1', status: 'completed' }],
      };

      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ todos: existingTodos }),
      );

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(mockHookSystem.fireTodoCompletedEvent).toHaveBeenCalledWith(
        '1',
        'Task 1',
        'in_progress',
        params.todos,
        HookPhase.Validation,
        mockAbortSignal,
      );
      expect(mockAtomicWrite).not.toHaveBeenCalled();
      expect(result.llmContent).toContain(
        'Todo completion blocked: Completion denied',
      );
      expect(result.returnDisplay).toBe(
        'Todo completion blocked: Completion denied',
      );
    });

    it('should ignore postWrite block decisions after persistence', async () => {
      const hookResult: AggregatedHookResult = {
        success: true,
        allOutputs: [
          new DefaultHookOutput({
            decision: 'block',
            reason: 'Ignored after write',
          }),
        ],
        errors: [],
        totalDuration: 10,
        finalOutput: new DefaultHookOutput({
          decision: 'block',
          reason: 'Ignored after write',
        }),
      };
      const mockHookSystem = {
        fireTodoCreatedEvent: vi
          .fn()
          .mockResolvedValueOnce({
            success: true,
            allOutputs: [new DefaultHookOutput({ decision: 'allow' })],
            errors: [],
            totalDuration: 10,
            finalOutput: new DefaultHookOutput({ decision: 'allow' }),
          })
          .mockResolvedValueOnce(hookResult),
        fireTodoCompletedEvent: vi.fn(),
      };
      mockConfig = {
        getSessionId: () => 'test-session-123',
        getHookSystem: () => mockHookSystem,
      } as unknown as Config;
      tool = new TodoWriteTool(mockConfig);

      const params: TodoWriteParams = {
        todos: [{ id: '1', content: 'Task 1', status: 'pending' }],
      };

      const enoentError = new Error('ENOENT') as Error & { code: string };
      enoentError.code = 'ENOENT';
      mockFs.readFile.mockRejectedValue(enoentError);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockAtomicWrite.mockResolvedValue(undefined);

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(mockAtomicWrite).toHaveBeenCalled();
      expect(mockHookSystem.fireTodoCreatedEvent).toHaveBeenNthCalledWith(
        1,
        '1',
        'Task 1',
        'pending',
        params.todos,
        HookPhase.Validation,
        mockAbortSignal,
      );
      expect(mockHookSystem.fireTodoCreatedEvent).toHaveBeenNthCalledWith(
        2,
        '1',
        'Task 1',
        'pending',
        params.todos,
        HookPhase.PostWrite,
        mockAbortSignal,
      );
      expect(result.llmContent).toContain(
        'Todos have been modified successfully',
      );
    });

    it('should dispatch post-write completion hooks sequentially in list order for a batched completion', async () => {
      // Regression: a single todo_write can complete several items at once, and
      // post-write TodoCompleted hooks run side effects. They must fire one at a
      // time, in list order, so a shared stateful/external-sync hook can't
      // interleave across sibling items. (Promise.all dispatch would overlap.)
      const allow: AggregatedHookResult = {
        success: true,
        allOutputs: [new DefaultHookOutput({ decision: 'allow' })],
        errors: [],
        totalDuration: 1,
        finalOutput: new DefaultHookOutput({ decision: 'allow' }),
      };
      const postWriteOrder: string[] = [];
      let activePostWrite = 0;
      let maxConcurrentPostWrite = 0;
      const mockHookSystem = {
        fireTodoCreatedEvent: vi.fn().mockResolvedValue(allow),
        fireTodoCompletedEvent: vi
          .fn()
          .mockImplementation(
            async (
              id: string,
              _content: string,
              _previousStatus: string,
              _todos: TodoItem[],
              phase: HookPhase,
            ) => {
              if (phase === HookPhase.PostWrite) {
                activePostWrite++;
                maxConcurrentPostWrite = Math.max(
                  maxConcurrentPostWrite,
                  activePostWrite,
                );
                // Yield to the event loop so overlapping dispatch would be
                // observable as maxConcurrentPostWrite > 1.
                await new Promise((resolve) => setTimeout(resolve, 5));
                postWriteOrder.push(id);
                activePostWrite--;
              }
              return allow;
            },
          ),
      };
      mockConfig = {
        getSessionId: () => 'test-session-123',
        getHookSystem: () => mockHookSystem,
      } as unknown as Config;
      tool = new TodoWriteTool(mockConfig);

      const existingTodos = [
        { id: '1', content: 'Task 1', status: 'in_progress' },
        { id: '2', content: 'Task 2', status: 'in_progress' },
      ];
      const params: TodoWriteParams = {
        todos: [
          { id: '1', content: 'Task 1', status: 'completed' },
          { id: '2', content: 'Task 2', status: 'completed' },
        ],
      };

      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ todos: existingTodos }),
      );
      mockAtomicWrite.mockResolvedValue(undefined);

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain(
        'Todos have been modified successfully',
      );
      // Both completions ran their post-write side effects, in list order, and
      // never overlapped.
      expect(postWriteOrder).toEqual(['1', '2']);
      expect(maxConcurrentPostWrite).toBe(1);
    });

    it('should validate created todos concurrently and stop before writing when one blocks', async () => {
      let releaseSlowHook: (() => void) | undefined;
      const slowValidation = new Promise<AggregatedHookResult>((resolve) => {
        releaseSlowHook = () =>
          resolve({
            success: true,
            allOutputs: [new DefaultHookOutput({ decision: 'allow' })],
            errors: [],
            totalDuration: 10,
            finalOutput: new DefaultHookOutput({ decision: 'allow' }),
          });
      });

      const mockHookSystem = {
        fireTodoCreatedEvent: vi
          .fn()
          .mockImplementationOnce(() => slowValidation)
          .mockResolvedValueOnce({
            success: true,
            allOutputs: [
              new DefaultHookOutput({
                decision: 'block',
                reason: 'Second todo denied',
              }),
            ],
            errors: [],
            totalDuration: 10,
            finalOutput: new DefaultHookOutput({
              decision: 'block',
              reason: 'Second todo denied',
            }),
          }),
        fireTodoCompletedEvent: vi.fn(),
      };
      mockConfig = {
        getSessionId: () => 'test-session-123',
        getHookSystem: () => mockHookSystem,
      } as unknown as Config;
      tool = new TodoWriteTool(mockConfig);

      const params: TodoWriteParams = {
        todos: [
          { id: '1', content: 'Task 1', status: 'pending' },
          { id: '2', content: 'Task 2', status: 'pending' },
        ],
      };

      const enoentError = new Error('ENOENT') as Error & { code: string };
      enoentError.code = 'ENOENT';
      mockFs.readFile.mockRejectedValue(enoentError);

      const invocation = tool.build(params);
      const executionPromise = invocation.execute(mockAbortSignal);

      await vi.waitFor(() => {
        expect(mockHookSystem.fireTodoCreatedEvent).toHaveBeenCalledTimes(2);
      });

      releaseSlowHook?.();
      const result = await executionPromise;

      expect(mockAtomicWrite).not.toHaveBeenCalled();
      expect(result.llmContent).toContain(
        'Todo creation blocked: Second todo denied',
      );
    });

    it('should report success when postWrite hooks fail after persistence', async () => {
      const postWriteError = new Error('Hook timeout');
      const validationAllow: AggregatedHookResult = {
        success: true,
        allOutputs: [new DefaultHookOutput({ decision: 'allow' })],
        errors: [],
        totalDuration: 10,
        finalOutput: new DefaultHookOutput({ decision: 'allow' }),
      };

      const mockHookSystem = {
        fireTodoCreatedEvent: vi
          .fn()
          .mockResolvedValueOnce(validationAllow)
          .mockRejectedValueOnce(postWriteError),
        fireTodoCompletedEvent: vi.fn(),
      };
      mockConfig = {
        getSessionId: () => 'test-session-123',
        getHookSystem: () => mockHookSystem,
      } as unknown as Config;
      tool = new TodoWriteTool(mockConfig);

      const params: TodoWriteParams = {
        todos: [{ id: '1', content: 'Task 1', status: 'pending' }],
      };

      const enoentError = new Error('ENOENT') as Error & { code: string };
      enoentError.code = 'ENOENT';
      mockFs.readFile.mockRejectedValue(enoentError);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockAtomicWrite.mockResolvedValue(undefined);

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(mockAtomicWrite).toHaveBeenCalled();
      expect(result.llmContent).toContain(
        'Todos have been modified successfully',
      );
      expect(result.llmContent).toContain(
        'Todos were persisted successfully, but post-write hooks failed with error: Hook timeout.',
      );
      expect(result.returnDisplay).toMatchObject({
        type: 'todo_list',
        todos: params.todos,
      });
    });

    it('should run postWrite hooks concurrently after persistence', async () => {
      let postWriteReleaseCount = 0;
      const postWriteStarted: string[] = [];
      const validationAllow: AggregatedHookResult = {
        success: true,
        allOutputs: [new DefaultHookOutput({ decision: 'allow' })],
        errors: [],
        totalDuration: 10,
        finalOutput: new DefaultHookOutput({ decision: 'allow' }),
      };

      const mockHookSystem = {
        fireTodoCreatedEvent: vi
          .fn()
          .mockImplementation((id, _content, _status, _allTodos, phase) => {
            if (phase === HookPhase.Validation) {
              return Promise.resolve(validationAllow);
            }

            postWriteStarted.push(id as string);
            return new Promise<AggregatedHookResult>((resolve) => {
              setTimeout(() => {
                postWriteReleaseCount += 1;
                resolve({
                  success: true,
                  allOutputs: [new DefaultHookOutput({ decision: 'allow' })],
                  errors: [],
                  totalDuration: 10,
                  finalOutput: new DefaultHookOutput({ decision: 'allow' }),
                });
              }, 0);
            });
          }),
        fireTodoCompletedEvent: vi.fn(),
      };
      mockConfig = {
        getSessionId: () => 'test-session-123',
        getHookSystem: () => mockHookSystem,
      } as unknown as Config;
      tool = new TodoWriteTool(mockConfig);

      const params: TodoWriteParams = {
        todos: [
          { id: '1', content: 'Task 1', status: 'pending' },
          { id: '2', content: 'Task 2', status: 'pending' },
        ],
      };

      const enoentError = new Error('ENOENT') as Error & { code: string };
      enoentError.code = 'ENOENT';
      mockFs.readFile.mockRejectedValue(enoentError);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockAtomicWrite.mockResolvedValue(undefined);

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(mockAtomicWrite).toHaveBeenCalled();
      expect(postWriteStarted).toEqual(['1', '2']);
      expect(postWriteReleaseCount).toBe(2);
      expect(result.llmContent).toContain(
        'Todos have been modified successfully',
      );
    });
  });

  describe('tool properties', () => {
    it('should have correct tool name', () => {
      expect(TodoWriteTool.Name).toBe('todo_write');
      expect(tool.name).toBe('todo_write');
    });

    it('should have correct display name', () => {
      expect(tool.displayName).toBe('TodoList');
    });

    it('should have correct kind', () => {
      expect(tool.kind).toBe('think');
    });

    it('should describe selective, outcome-oriented task tracking', () => {
      expect(tool.description).toContain('complex, ambiguous, or multi-phase');
      expect(tool.description).toContain(
        'Do not use it for simple or single-step work',
      );
      expect(tool.description).toContain(
        'unless the user explicitly requests a todo list',
      );
      expect(tool.description).toContain('short and outcome-oriented');
      expect(tool.description).toContain(
        'Do not create a separate todo for every error, file, command, or minor edit',
      );
      expect(tool.description).not.toContain(
        'After receiving new instructions',
      );
      expect(tool.description).not.toContain('When in doubt, use this tool');
    });

    it('should have schema with required properties', () => {
      const schema = tool.schema;
      expect(schema.name).toBe('todo_write');
      expect(schema.parametersJsonSchema).toHaveProperty('properties.todos');
      expect(schema.parametersJsonSchema).not.toHaveProperty(
        'properties.merge',
      );
    });
  });

  describe('getDescription', () => {
    it('should return "Create todos" when no todos file exists', () => {
      // Mock existsSync to return false (file doesn't exist)
      mockFsSync.existsSync.mockReturnValue(false);

      const params = {
        todos: [{ id: '1', content: 'Test todo', status: 'pending' as const }],
      };
      const invocation = tool.build(params);
      expect(invocation.getDescription()).toBe('Create todos');
    });

    it('should return "Update todos" when todos file exists', () => {
      // Mock existsSync to return true (file exists)
      mockFsSync.existsSync.mockReturnValue(true);

      const params = {
        todos: [
          { id: '1', content: 'Updated todo', status: 'completed' as const },
        ],
      };
      const invocation = tool.build(params);
      expect(invocation.getDescription()).toBe('Update todos');
    });
  });
});

describe('TodoWriteTool – runtime output directory', () => {
  let tool: TodoWriteTool;
  let mockAbortSignal: AbortSignal;
  let mockConfig: Config;
  const originalRuntimeEnv = process.env['QWEN_RUNTIME_DIR'];

  beforeEach(() => {
    mockConfig = {
      getSessionId: () => 'runtime-session',
      getHookSystem: () => undefined,
    } as Config;
    tool = new TodoWriteTool(mockConfig);
    mockAbortSignal = new AbortController().signal;
    Storage.setRuntimeBaseDir(null);
    delete process.env['QWEN_RUNTIME_DIR'];
    vi.clearAllMocks();
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    if (originalRuntimeEnv !== undefined) {
      process.env['QWEN_RUNTIME_DIR'] = originalRuntimeEnv;
    } else {
      delete process.env['QWEN_RUNTIME_DIR'];
    }
    vi.restoreAllMocks();
  });

  it('should write todos to custom runtime dir when setRuntimeBaseDir is set', async () => {
    const customRuntimeDir = path.resolve('custom', 'runtime');
    Storage.setRuntimeBaseDir(customRuntimeDir);

    const params: TodoWriteParams = {
      todos: [{ id: '1', content: 'Task 1', status: 'pending' }],
    };

    // Use proper Error object for ENOENT
    const enoentError = new Error('ENOENT') as Error & { code: string };
    enoentError.code = 'ENOENT';
    mockFs.readFile.mockRejectedValue(enoentError);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockAtomicWrite.mockResolvedValue(undefined);

    const invocation = tool.build(params);
    await invocation.execute(mockAbortSignal);

    // Verify the file path starts with the custom runtime dir
    const writePath = mockAtomicWrite.mock.calls[0]?.[0] as string;
    expect(writePath).toContain(path.join(customRuntimeDir, 'todos'));
    expect(writePath).toContain('runtime-session.json');
  });

  it('should write todos to env var dir when QWEN_RUNTIME_DIR is set', async () => {
    const envRuntimeDir = path.resolve('env', 'runtime');
    process.env['QWEN_RUNTIME_DIR'] = envRuntimeDir;

    const params: TodoWriteParams = {
      todos: [{ id: '1', content: 'Task 1', status: 'pending' }],
    };

    // Use proper Error object for ENOENT
    const enoentError = new Error('ENOENT') as Error & { code: string };
    enoentError.code = 'ENOENT';
    mockFs.readFile.mockRejectedValue(enoentError);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockAtomicWrite.mockResolvedValue(undefined);

    const invocation = tool.build(params);
    await invocation.execute(mockAbortSignal);

    const writePath = mockAtomicWrite.mock.calls[0]?.[0] as string;
    expect(writePath).toContain(path.join(envRuntimeDir, 'todos'));
  });

  it('should use default ~/.qwen path when no custom dir is configured', async () => {
    const params: TodoWriteParams = {
      todos: [{ id: '1', content: 'Task 1', status: 'pending' }],
    };

    // Use proper Error object for ENOENT
    const enoentError = new Error('ENOENT') as Error & { code: string };
    enoentError.code = 'ENOENT';
    mockFs.readFile.mockRejectedValue(enoentError);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockAtomicWrite.mockResolvedValue(undefined);

    const invocation = tool.build(params);
    await invocation.execute(mockAbortSignal);

    const writePath = mockAtomicWrite.mock.calls[0]?.[0] as string;
    expect(writePath).toContain(path.join('.qwen', 'todos'));
  });

  it('should check file existence in custom runtime dir for getDescription', () => {
    const customRuntimeDir = path.resolve('custom', 'runtime');
    Storage.setRuntimeBaseDir(customRuntimeDir);
    mockFsSync.existsSync.mockReturnValue(false);

    const params: TodoWriteParams = {
      todos: [{ id: '1', content: 'Task', status: 'pending' }],
    };
    const invocation = tool.build(params);

    // Verify existsSync was called with a path under the custom dir
    const checkedPath = mockFsSync.existsSync.mock.calls[0]?.[0] as string;
    expect(checkedPath).toContain(path.join(customRuntimeDir, 'todos'));
    expect(invocation.getDescription()).toBe('Create todos');
  });

  it('should list todo sessions from custom runtime dir', async () => {
    const customRuntimeDir = path.resolve('custom', 'runtime');
    Storage.setRuntimeBaseDir(customRuntimeDir);
    mockFs.readdir.mockResolvedValue([
      'a.json',
      'b.json',
      'README.md',
    ] as never);

    const sessions = await listTodoSessions();

    expect(mockFs.readdir).toHaveBeenCalledWith(
      path.join(customRuntimeDir, 'todos'),
    );
    expect(sessions).toEqual(['a', 'b']);
  });
});
