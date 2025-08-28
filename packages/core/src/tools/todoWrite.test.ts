/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TodoWriteTool, TodoWriteParams, TodoItem } from './todoWrite.js';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { Config } from '../config/config.js';

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
      expect(result).toContain('must NOT have fewer than 1 characters');
    });

    it('should reject todos with empty id', () => {
      const params: TodoWriteParams = {
        todos: [
          { id: '', content: 'Task 1', status: 'pending' },
          { id: '2', content: 'Task 2', status: 'pending' },
        ],
      };

      const result = tool.validateToolParams(params);
      expect(result).toContain('non-empty "id"');
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
      expect(result).toContain('must be equal to one of the allowed values');
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
      mockFs.writeFile.mockResolvedValue(undefined);

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('success');
      expect(result.returnDisplay).toEqual({
        type: 'todo_list',
        todos: [
          { id: '1', content: 'Task 1', status: 'pending' },
          { id: '2', content: 'Task 2', status: 'in_progress' },
        ],
      });
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('test-session-123.json'),
        expect.stringContaining('"todos"'),
        'utf-8',
      );
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
      mockFs.writeFile.mockResolvedValue(undefined);

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('success');
      expect(result.returnDisplay).toEqual({
        type: 'todo_list',
        todos: [
          { id: '1', content: 'Updated Task', status: 'completed' },
          { id: '2', content: 'New Task', status: 'pending' },
        ],
      });
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('test-session-123.json'),
        expect.stringMatching(/"Updated Task"/),
        'utf-8',
      );
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
      mockFs.writeFile.mockRejectedValue(new Error('Write failed'));

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('"success":false');
      expect(result.returnDisplay).toContain('Error writing todos');
    });

    it('should handle empty todos array', async () => {
      const params: TodoWriteParams = {
        todos: [],
      };

      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      const invocation = tool.build(params);
      const result = await invocation.execute(mockAbortSignal);

      expect(result.llmContent).toContain('success');
      expect(result.returnDisplay).toEqual({
        type: 'todo_list',
        todos: [],
      });
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('test-session-123.json'),
        expect.stringContaining('"todos"'),
        'utf-8',
      );
    });
  });

  describe('tool properties', () => {
    it('should have correct tool name', () => {
      expect(TodoWriteTool.Name).toBe('todo_write');
      expect(tool.name).toBe('todo_write');
    });

    it('should have correct display name', () => {
      expect(tool.displayName).toBe('Todo Write');
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
