/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { WriteTodosTool, type WriteTodosToolParams } from './write-todos.js';

describe('WriteTodosTool', () => {
  const tool = new WriteTodosTool();
  const signal = new AbortController().signal;

  describe('validation', () => {
    it('should not throw for valid parameters', async () => {
      const params: WriteTodosToolParams = {
        todos: [
          { description: 'Task 1', status: 'pending' },
          { description: 'Task 2', status: 'in_progress' },
          { description: 'Task 3', status: 'completed' },
          { description: 'Task 4', status: 'blocked' },
        ],
      };
      await expect(tool.buildAndExecute(params, signal)).resolves.toBeDefined();
    });

    it('should not throw for an empty list', async () => {
      const params: WriteTodosToolParams = {
        todos: [],
      };
      await expect(tool.buildAndExecute(params, signal)).resolves.toBeDefined();
    });

    it('should accept a JSON string todos array and write back an array', () => {
      const params = {
        todos: JSON.stringify([
          { description: 'Task 1', status: 'pending' },
          { description: 'Task 2', status: 'in_progress' },
        ]),
      } as unknown as WriteTodosToolParams;

      expect(tool.validateToolParams(params)).toBeNull();
      expect(params.todos).toEqual([
        { description: 'Task 1', status: 'pending' },
        { description: 'Task 2', status: 'in_progress' },
      ]);
    });

    it('should drop activeForm from todo items before validation', () => {
      const originalTodo = {
        description: 'Task 1',
        status: 'pending',
        activeForm: 'Working on task 1',
      };
      const params = {
        todos: [originalTodo],
      } as unknown as WriteTodosToolParams;

      expect(tool.validateToolParams(params)).toBeNull();
      expect(params.todos).toEqual([
        { description: 'Task 1', status: 'pending' },
      ]);
      expect(originalTodo).toEqual({
        description: 'Task 1',
        status: 'pending',
        activeForm: 'Working on task 1',
      });
    });

    it('should drop activeForm from JSON string todos after container coercion', () => {
      const params = {
        todos: JSON.stringify([
          {
            description: 'Task 1',
            status: 'pending',
            activeForm: 'Working on task 1',
          },
        ]),
      } as unknown as WriteTodosToolParams;

      expect(tool.validateToolParams(params)).toBeNull();
      expect(params.todos).toEqual([
        { description: 'Task 1', status: 'pending' },
      ]);
    });

    it('should map content to description in JSON string todos', () => {
      const params = {
        todos: JSON.stringify([{ content: 'Task 1', status: 'pending' }]),
      } as unknown as WriteTodosToolParams;

      expect(tool.validateToolParams(params)).toBeNull();
      expect(params.todos).toEqual([
        { description: 'Task 1', status: 'pending' },
      ]);
    });

    it('should map content to description when description is missing', () => {
      const params = {
        todos: [{ content: 'Task 1', status: 'pending' }],
      } as unknown as WriteTodosToolParams;

      expect(tool.validateToolParams(params)).toBeNull();
      expect(params.todos).toEqual([
        { description: 'Task 1', status: 'pending' },
      ]);
    });

    it('should preserve description when both description and content are present', () => {
      const params = {
        todos: [
          {
            description: 'Preferred task',
            content: 'Fallback task',
            status: 'pending',
          },
        ],
      } as unknown as WriteTodosToolParams;

      expect(tool.validateToolParams(params)).toBeNull();
      expect(params.todos).toEqual([
        { description: 'Preferred task', status: 'pending' },
      ]);
    });

    it('should drop unknown todo item fields', () => {
      const params = {
        todos: [
          {
            description: 'Task 1',
            status: 'pending',
            priority: 'high',
          },
        ],
      } as unknown as WriteTodosToolParams;

      expect(tool.validateToolParams(params)).toBeNull();
      expect(params.todos).toEqual([
        { description: 'Task 1', status: 'pending' },
      ]);
    });

    it('should return a readable status enum error', () => {
      const params = {
        todos: [{ description: 'Task 1', status: 'doing' }],
      } as unknown as WriteTodosToolParams;

      expect(tool.validateToolParams(params)).toBe(
        'Invalid TodoWrite `status`. Use one of: pending, in_progress, completed, cancelled, blocked.',
      );
    });

    it('should return a readable missing description error', () => {
      const params = {
        todos: [{ status: 'pending' }],
      } as unknown as WriteTodosToolParams;

      expect(tool.validateToolParams(params)).toContain(
        'Each TodoWrite item requires a non-empty `description` string.',
      );
    });

    it('should return a readable missing status error', () => {
      const params = {
        todos: [{ description: 'Task 1' }],
      } as unknown as WriteTodosToolParams;

      expect(tool.validateToolParams(params)).toContain(
        'Each TodoWrite item requires `status` with one of: pending, in_progress, completed, cancelled, blocked.',
      );
    });

    it('should return a readable top-level extra key error', () => {
      const params = {
        todos: [{ description: 'Task 1', status: 'pending' }],
        notes: 'not supported',
      } as unknown as WriteTodosToolParams;

      expect(tool.validateToolParams(params)).toContain(
        'TodoWrite parameters only accept a top-level `todos` field.',
      );
    });

    it('should throw an error if todos is not an array', async () => {
      const params = {
        todos: 'not-an-array',
      } as unknown as WriteTodosToolParams;
      await expect(tool.buildAndExecute(params, signal)).rejects.toThrow(
        'TodoWrite expected `todos` to be an array of todo objects.',
      );
    });

    it('should throw an error if a todo item is not an object', async () => {
      const params = {
        todos: ['not-an-object'],
      } as unknown as WriteTodosToolParams;
      await expect(tool.buildAndExecute(params, signal)).rejects.toThrow(
        'Each TodoWrite item must be an object with `description` and `status`.',
      );
    });

    it('should throw an error if a todo description is missing or empty', async () => {
      const params: WriteTodosToolParams = {
        todos: [{ description: '  ', status: 'pending' }],
      };
      await expect(tool.buildAndExecute(params, signal)).rejects.toThrow(
        'Each TodoWrite item requires a non-empty `description` string.',
      );
    });

    it('should throw an error if a todo status is invalid', async () => {
      const params = {
        todos: [{ description: 'Task 1', status: 'invalid-status' }],
      } as unknown as WriteTodosToolParams;
      await expect(tool.buildAndExecute(params, signal)).rejects.toThrow(
        'Invalid TodoWrite `status`. Use one of: pending, in_progress, completed, cancelled, blocked.',
      );
    });

    it('should throw an error if more than one task is in_progress', async () => {
      const params: WriteTodosToolParams = {
        todos: [
          { description: 'Task 1', status: 'in_progress' },
          { description: 'Task 2', status: 'in_progress' },
        ],
      };
      await expect(tool.buildAndExecute(params, signal)).rejects.toThrow(
        'Invalid parameters: Only one task can be "in_progress" at a time. Set the other active tasks to pending or blocked.',
      );
    });
  });

  describe('execute', () => {
    it('should return a success message for clearing the list', async () => {
      const params: WriteTodosToolParams = {
        todos: [],
      };
      const result = await tool.buildAndExecute(params, signal);
      expect(result.llmContent).toBe('Successfully cleared the todo list.');
      expect(result.returnDisplay).toEqual({ todos: [] });
    });

    it('should return a formatted todo list on success', async () => {
      const params: WriteTodosToolParams = {
        todos: [
          { description: 'First task', status: 'completed' },
          { description: 'Second task', status: 'in_progress' },
          { description: 'Third task', status: 'pending' },
          { description: 'Fourth task', status: 'blocked' },
        ],
      };
      const result = await tool.buildAndExecute(params, signal);
      const expectedOutput = `Successfully updated the todo list. The current list is now:
1. [completed] First task
2. [in_progress] Second task
3. [pending] Third task
4. [blocked] Fourth task`;
      expect(result.llmContent).toBe(expectedOutput);
      expect(result.returnDisplay).toEqual(params);
    });

    it('should persist the cleared todo list when all tasks are completed', async () => {
      const params: WriteTodosToolParams = {
        todos: [
          { description: 'First task', status: 'completed' },
          { description: 'Second task', status: 'completed' },
        ],
      };
      const result = await tool.buildAndExecute(params, signal);
      expect(result.llmContent).toBe(
        'All tasks completed. Todo list has been cleared.',
      );
      expect(result.returnDisplay).toEqual({ todos: [] });
      expect(result.toolUseResult).toEqual({
        oldTodos: [],
        newTodos: [],
      });
    });
  });
});
