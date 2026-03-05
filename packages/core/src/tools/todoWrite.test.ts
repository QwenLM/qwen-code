/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TodoWriteParams, TodoItem } from './todoWrite.js';
import { TodoWriteTool, listTodoSessions } from './todoWrite.js';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';

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
      mockFs.writeFile.mockResolvedValue(undefined);

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
      mockFs.writeFile.mockResolvedValue(undefined);

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

describe('TodoWriteTool – runtime output directory', () => {
  let tool: TodoWriteTool;
  let mockAbortSignal: AbortSignal;
  let mockConfig: Config;
  const originalRuntimeEnv = process.env['QWEN_RUNTIME_DIR'];

  beforeEach(() => {
    mockConfig = {
      getSessionId: () => 'runtime-session',
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

    mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);

    const invocation = tool.build(params);
    await invocation.execute(mockAbortSignal);

    // Verify the file path starts with the custom runtime dir
    const writePath = mockFs.writeFile.mock.calls[0]?.[0] as string;
    expect(writePath).toContain(path.join(customRuntimeDir, 'todos'));
    expect(writePath).toContain('runtime-session.json');
  });

  it('should write todos to env var dir when QWEN_RUNTIME_DIR is set', async () => {
    const envRuntimeDir = path.resolve('env', 'runtime');
    process.env['QWEN_RUNTIME_DIR'] = envRuntimeDir;

    const params: TodoWriteParams = {
      todos: [{ id: '1', content: 'Task 1', status: 'pending' }],
    };

    mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);

    const invocation = tool.build(params);
    await invocation.execute(mockAbortSignal);

    const writePath = mockFs.writeFile.mock.calls[0]?.[0] as string;
    expect(writePath).toContain(path.join(envRuntimeDir, 'todos'));
  });

  it('should use default ~/.qwen path when no custom dir is configured', async () => {
    const params: TodoWriteParams = {
      todos: [{ id: '1', content: 'Task 1', status: 'pending' }],
    };

    mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);

    const invocation = tool.build(params);
    await invocation.execute(mockAbortSignal);

    const writePath = mockFs.writeFile.mock.calls[0]?.[0] as string;
    expect(writePath).toContain('.qwen/todos/');
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
