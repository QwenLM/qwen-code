/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TodoWriteParams, TodoItem } from './todoWrite.js';
import { TodoWriteTool } from './todoWrite.js';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import type { Config } from '../config/config.js';

// Mock fs modules
vi.mock('fs/promises');
vi.mock('fs');

const mockFs = vi.mocked(fs);
const mockFsSync = vi.mocked(fsSync);

describe('TodoWriteTool', () => {
  let tool: TodoWriteTool;
  let mockAbortSignal: AbortSignal;
  let mockConfig: Config;

  beforeEach(() => {
    mockConfig = {
      getSessionId: () => 'test-session-123',
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

    it('should accept todos with Claude-compatible timestamp fields', () => {
      const params: TodoWriteParams = {
        todos: [
          {
            id: '1',
            content: 'Task 1',
            status: 'pending',
            created_at: new Date().toISOString(),
            completed_at: null,
          },
          {
            id: '2',
            content: 'Task 2',
            status: 'completed',
            created_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
          },
        ],
      };

      const result = tool.validateToolParams(params);
      expect(result).toBeNull();
    });

    it('should reject todos with invalid created_at timestamp', () => {
      const params: TodoWriteParams = {
        todos: [
          {
            id: '1',
            content: 'Task 1',
            status: 'pending',
            created_at: 123 as unknown as string, // Invalid type
          },
        ],
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('created_at" field must be a string');
    });

    it('should reject todos with invalid completed_at timestamp', () => {
      const params: TodoWriteParams = {
        todos: [
          {
            id: '1',
            content: 'Task 1',
            status: 'pending',
            completed_at: 123 as unknown as string, // Invalid type
          },
        ],
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('completed_at" field must be a string');
    });

    it('should accept todos with completed_at as null', () => {
      const params: TodoWriteParams = {
        todos: [
          {
            id: '1',
            content: 'Task 1',
            status: 'completed',
            completed_at: null,
            created_at: new Date().toISOString(),
          },
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
  });

  describe('execute', () => {
    it('should create new todos file when none exists', async () => {
      const params: TodoWriteParams = {
        todos: [
          { id: '1', content: 'Task 1', status: 'pending' },
          { id: '2', content: 'Task 2', status: 'in_progress' },
        ],
      };

      // Mock file not existing
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });
      mockFs.mkdir.mockResolvedValue(undefined);
      const writeFileSpy = vi
        .spyOn(mockFs, 'writeFile')
        .mockResolvedValue(undefined);

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain(
        'Todos have been modified successfully',
      );
      expect(result.llmContent).toContain('<system-reminder>');
      expect(result.llmContent).toContain('Your todo list has changed');
      expect(result.llmContent).toContain(JSON.stringify(params.todos));
      expect(result.returnDisplay).toEqual({
        type: 'todo_list',
        todos: [
          { id: '1', content: 'Task 1', status: 'pending' },
          { id: '2', content: 'Task 2', status: 'in_progress' },
        ],
      });
      expect(writeFileSpy).toHaveBeenCalledWith(
        expect.stringContaining('test-session-123.json'),
        expect.stringContaining('"todos"'),
        'utf-8',
      );
      writeFileSpy.mockRestore();
    });

    it('should add Claude-compatible timestamps to todos when saving', async () => {
      const params: TodoWriteParams = {
        todos: [
          { id: '1', content: 'Task 1', status: 'pending' },
          { id: '2', content: 'Task 2', status: 'completed' },
        ],
      };

      // Mock file not existing
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });
      mockFs.mkdir.mockResolvedValue(undefined);

      // Mock writeFile and capture the arguments
      const writeFileSpy = vi.spyOn(mockFs, 'writeFile');

      const invocation = tool.build(params);
      await invocation.execute(mockAbortSignal);

      // Verify that the timestamp fields were added
      expect(writeFileSpy).toHaveBeenCalledTimes(1);
      const [_filePath, content] = writeFileSpy.mock.calls[0];
      const parsedContent = JSON.parse(content as string);
      const todos = parsedContent.todos;

      expect(todos).toHaveLength(2);

      // Check the first todo (pending status)
      expect(todos[0].id).toBe('1');
      expect(todos[0].status).toBe('pending');
      expect(todos[0].created_at).toBeDefined();
      expect(new Date(todos[0].created_at).toISOString()).toBe(
        todos[0].created_at,
      ); // Valid ISO string
      expect(todos[0].completed_at).toBeNull(); // Should be null for pending tasks

      // Check the second todo (completed status)
      expect(todos[1].id).toBe('2');
      expect(todos[1].status).toBe('completed');
      expect(todos[1].created_at).toBeDefined();
      expect(new Date(todos[1].created_at).toISOString()).toBe(
        todos[1].created_at,
      ); // Valid ISO string
      expect(todos[1].completed_at).toBeDefined(); // Should be set for completed tasks
      expect(new Date(todos[1].completed_at).toISOString()).toBe(
        todos[1].completed_at,
      ); // Valid ISO string

      writeFileSpy.mockRestore();
    });

    it('should preserve existing Claude-compatible timestamp fields when updating', async () => {
      const existingTodos = [
        {
          id: '1',
          content: 'Existing Task',
          status: 'completed',
          created_at: '2023-01-01T00:00:00.000Z',
          completed_at: '2023-01-02T00:00:00.000Z',
        },
      ];

      const params: TodoWriteParams = {
        todos: [
          {
            id: '1',
            content: 'Updated Task',
            status: 'completed',
            created_at: '2023-01-01T00:00:00.000Z',
            completed_at: '2023-01-02T00:00:00.000Z',
          },
          {
            id: '2',
            content: 'New Task',
            status: 'pending',
          },
        ],
      };

      // Mock existing file
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ todos: existingTodos }),
      );
      mockFs.mkdir.mockResolvedValue(undefined);

      // Mock writeFile and capture the arguments
      const writeFileSpy = vi.spyOn(mockFs, 'writeFile');

      const invocation = tool.build(params);
      await invocation.execute(mockAbortSignal);

      // Verify that the timestamp fields were preserved or appropriately set
      expect(writeFileSpy).toHaveBeenCalledTimes(1);
      const [_filePath, content] = writeFileSpy.mock.calls[0];
      const parsedContent = JSON.parse(content as string);
      const todos = parsedContent.todos;

      expect(todos).toHaveLength(2);

      // Check the first todo (existing, completed status)
      expect(todos[0].id).toBe('1');
      expect(todos[0].status).toBe('completed');
      expect(todos[0].created_at).toBe('2023-01-01T00:00:00.000Z');
      expect(todos[0].completed_at).toBe('2023-01-02T00:00:00.000Z'); // Should preserve existing completed_at

      // Check the second todo (new, pending status)
      expect(todos[1].id).toBe('2');
      expect(todos[1].status).toBe('pending');
      expect(todos[1].created_at).toBeDefined();
      expect(new Date(todos[1].created_at).toISOString()).toBe(
        todos[1].created_at,
      ); // Valid ISO string
      expect(todos[1].completed_at).toBeNull(); // Should be null for pending tasks

      writeFileSpy.mockRestore();
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
      const writeFileSpy = vi
        .spyOn(mockFs, 'writeFile')
        .mockResolvedValue(undefined);

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain(
        'Todos have been modified successfully',
      );
      expect(result.llmContent).toContain('<system-reminder>');
      expect(result.llmContent).toContain('Your todo list has changed');
      expect(result.llmContent).toContain(JSON.stringify(params.todos));
      expect(result.returnDisplay).toEqual({
        type: 'todo_list',
        todos: [
          { id: '1', content: 'Updated Task', status: 'completed' },
          { id: '2', content: 'New Task', status: 'pending' },
        ],
      });
      expect(writeFileSpy).toHaveBeenCalledWith(
        expect.stringContaining('test-session-123.json'),
        expect.stringMatching(/"Updated Task"/),
        'utf-8',
      );
      writeFileSpy.mockRestore();
    });

    it('should handle file write errors', async () => {
      const params: TodoWriteParams = {
        todos: [
          { id: '1', content: 'Task 1', status: 'pending' },
          { id: '2', content: 'Task 2', status: 'pending' },
        ],
      };

      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });
      mockFs.mkdir.mockResolvedValue(undefined);
      const writeFileSpy = vi
        .spyOn(mockFs, 'writeFile')
        .mockRejectedValue(new Error('Write failed'));

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('Failed to modify todos');
      expect(result.llmContent).toContain('<system-reminder>');
      expect(result.llmContent).toContain('Todo list modification failed');
      expect(result.llmContent).toContain('Write failed');
      expect(result.returnDisplay).toContain('Error writing todos');
      writeFileSpy.mockRestore();
    });

    it('should handle empty todos array', async () => {
      const params: TodoWriteParams = {
        todos: [],
      };

      mockFs.mkdir.mockResolvedValue(undefined);
      const writeFileSpy = vi
        .spyOn(mockFs, 'writeFile')
        .mockResolvedValue(undefined);

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('Todo list has been cleared');
      expect(result.llmContent).toContain('<system-reminder>');
      expect(result.llmContent).toContain('Your todo list is now empty');
      expect(result.llmContent).toContain('no pending tasks');
      expect(result.returnDisplay).toEqual({
        type: 'todo_list',
        todos: [],
      });
      expect(writeFileSpy).toHaveBeenCalledWith(
        expect.stringContaining('test-session-123.json'),
        expect.stringContaining('"todos"'),
        'utf-8',
      );
      writeFileSpy.mockRestore();
    });
  });

  describe('tool properties', () => {
    it('should have correct tool name', () => {
      expect(TodoWriteTool.Name).toBe('todo_write');
      expect(tool.name).toBe('todo_write');
    });

    it('should have correct display name', () => {
      expect(tool.displayName).toBe('TodoWrite');
    });

    it('should have correct kind', () => {
      expect(tool.kind).toBe('think');
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
