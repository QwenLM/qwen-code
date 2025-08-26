/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach, Mock } from 'vitest';
import { TaskTool } from './taskTool.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock dependencies
vi.mock('fs/promises');

// Mock fs functions
const mockReadFile = fs.readFile as Mock;
const mockWriteFile = fs.writeFile as Mock;
const mockRename = fs.rename as Mock;
const mockUnlink = fs.unlink as Mock;

describe('TaskTool', () => {
  let taskTool: TaskTool;
  let mockCwd: string;

  beforeEach(() => {
    taskTool = new TaskTool();
    mockCwd = '/test/project';
    vi.spyOn(process, 'cwd').mockReturnValue(mockCwd);
    vi.clearAllMocks();
    
    // Default mock implementations
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Tool Initialization', () => {
    it('should have correct name and properties', () => {
      expect(TaskTool.Name).toBe('qwen_tasks');
      const declaration = taskTool.getDeclaration();
      expect(declaration.name).toBe('qwen_tasks');
      expect(declaration.description).toContain('persistent task lists');
    });
  });

  describe('Add Task Action', () => {
    it('should create new task file when none exists', async () => {
      mockReadFile.mockRejectedValue(new Error('File not found'));
      mockWriteFile.mockResolvedValue(undefined);

      const invocation = taskTool.createInvocation({
        action: 'add',
        task_name: 'Fix login bug',
        context: 'Critical issue affecting users'
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.returnDisplay).toContain('✅ Added task: "Fix login bug"');
      // Check direct write to tasks.json
      expect(mockWriteFile).toHaveBeenCalledWith(
        path.join(mockCwd, 'tasks.json'),
        expect.stringContaining('Fix login bug'),
        'utf-8'
      );

      // Check the JSON structure
      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenData.tasks).toHaveLength(1);
      expect(writtenData.tasks[0].name).toBe('Fix login bug');
      expect(writtenData.tasks[0].status).toBe('pending');
      expect(writtenData.tasks[0].context).toBe('Critical issue affecting users');
    });

    it('should add task to existing task list', async () => {
      const existingTasks = {
        tasks: [{
          id: '1',
          name: 'Existing task',
          status: 'pending',
          created: '2025-08-26T10:00:00.000Z',
          updated: '2025-08-26T10:00:00.000Z'
        }]
      };

      mockReadFile.mockResolvedValue(JSON.stringify(existingTasks));
      mockWriteFile.mockResolvedValue(undefined);

      const invocation = taskTool.createInvocation({
        action: 'add',
        task_name: 'New task'
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.returnDisplay).toContain('✅ Added task: "New task"');
      
      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenData.tasks).toHaveLength(2);
      expect(writtenData.tasks[1].name).toBe('New task');
    });

    it('should return error when task_name is missing', async () => {
      const invocation = taskTool.createInvocation({
        action: 'add'
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.returnDisplay).toContain('❌ Error: task_name is required');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('Complete Task Action', () => {
    it('should mark task as complete', async () => {
      const existingTasks = {
        tasks: [{
          id: '1',
          name: 'Test task',
          status: 'pending',
          created: '2025-08-26T10:00:00.000Z',
          updated: '2025-08-26T10:00:00.000Z'
        }]
      };

      mockReadFile.mockResolvedValue(JSON.stringify(existingTasks));
      mockWriteFile.mockResolvedValue(undefined);

      const invocation = taskTool.createInvocation({
        action: 'complete',
        task_name: 'Test task'
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.returnDisplay).toContain('✅ Completed task: "Test task"');
      
      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenData.tasks[0].status).toBe('complete');
    });

    it('should find task with partial name match', async () => {
      const existingTasks = {
        tasks: [{
          id: '1',
          name: 'Fix authentication bug in login system',
          status: 'pending',
          created: '2025-08-26T10:00:00.000Z',
          updated: '2025-08-26T10:00:00.000Z'
        }]
      };

      mockReadFile.mockResolvedValue(JSON.stringify(existingTasks));
      mockWriteFile.mockResolvedValue(undefined);

      const invocation = taskTool.createInvocation({
        action: 'complete',
        task_name: 'authentication'
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.returnDisplay).toContain('✅ Completed task: "Fix authentication bug in login system"');
    });

    it('should return error when task not found', async () => {
      const existingTasks = { tasks: [] };
      mockReadFile.mockResolvedValue(JSON.stringify(existingTasks));

      const invocation = taskTool.createInvocation({
        action: 'complete',
        task_name: 'Nonexistent task'
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.returnDisplay).toContain('❌ Task not found: "Nonexistent task"');
    });

    it('should not complete already completed tasks', async () => {
      const existingTasks = {
        tasks: [{
          id: '1',
          name: 'Completed task',
          status: 'complete',
          created: '2025-08-26T10:00:00.000Z',
          updated: '2025-08-26T10:00:00.000Z'
        }]
      };

      mockReadFile.mockResolvedValue(JSON.stringify(existingTasks));

      const invocation = taskTool.createInvocation({
        action: 'complete',
        task_name: 'Completed task'
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.returnDisplay).toContain('❌ Task not found');
    });
  });

  describe('In Progress Action', () => {
    it('should mark task as in progress', async () => {
      const existingTasks = {
        tasks: [{
          id: '1',
          name: 'Test task',
          status: 'pending',
          created: '2025-08-26T10:00:00.000Z',
          updated: '2025-08-26T10:00:00.000Z'
        }]
      };

      mockReadFile.mockResolvedValue(JSON.stringify(existingTasks));
      mockWriteFile.mockResolvedValue(undefined);

      const invocation = taskTool.createInvocation({
        action: 'in_progress',
        task_name: 'Test task',
        context: 'Starting work now'
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.returnDisplay).toContain('🔄 Started working on: "Test task"');
      
      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenData.tasks[0].status).toBe('in_progress');
      expect(writtenData.tasks[0].context).toBe('Starting work now');
    });

    it('should update already completed task status', async () => {
      const existingTasks = {
        tasks: [{
          id: '1',
          name: 'Test task',
          status: 'complete',
          created: '2025-08-26T10:00:00.000Z',
          updated: '2025-08-26T10:00:00.000Z'
        }]
      };

      mockReadFile.mockResolvedValue(JSON.stringify(existingTasks));
      mockWriteFile.mockResolvedValue(undefined);

      const invocation = taskTool.createInvocation({
        action: 'in_progress',
        task_name: 'Test task'
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.returnDisplay).toContain('🔄 Started working on: "Test task"');
      
      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenData.tasks[0].status).toBe('in_progress');
    });
  });

  describe('List Tasks Action', () => {
    it('should return message when no tasks exist', async () => {
      mockReadFile.mockRejectedValue(new Error('File not found'));

      const invocation = taskTool.createInvocation({
        action: 'list'
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.returnDisplay).toContain('📝 No tasks found');
    });

    it('should list all tasks with proper formatting', async () => {
      const existingTasks = {
        tasks: [
          {
            id: '1',
            name: 'Completed task',
            status: 'complete',
            created: '2025-08-26T10:00:00.000Z',
            updated: '2025-08-26T10:00:00.000Z'
          },
          {
            id: '2',
            name: 'In progress task',
            status: 'in_progress',
            context: 'Working on it',
            created: '2025-08-26T10:00:00.000Z',
            updated: '2025-08-26T10:00:00.000Z'
          },
          {
            id: '3',
            name: 'Pending task',
            status: 'pending',
            created: '2025-08-26T10:00:00.000Z',
            updated: '2025-08-26T10:00:00.000Z'
          }
        ]
      };

      mockReadFile.mockResolvedValue(JSON.stringify(existingTasks));

      const invocation = taskTool.createInvocation({
        action: 'list'
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.returnDisplay).toContain('📋 **Current Tasks:**');
      expect(result.returnDisplay).toContain('1 [✓] Completed task (Complete)');
      expect(result.returnDisplay).toContain('2 [ ] In progress task (In Progress) - Working on it');
      expect(result.returnDisplay).toContain('3 [ ] Pending task (Pending)');
    });
  });

  describe('Show Progress Action', () => {
    it('should return no tasks message when empty', async () => {
      mockReadFile.mockRejectedValue(new Error('File not found'));

      const invocation = taskTool.createInvocation({
        action: 'show_progress'
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.returnDisplay).toContain('📊 No tasks to track progress');
    });

    it('should calculate and display progress correctly', async () => {
      const existingTasks = {
        tasks: [
          { id: '1', name: 'Task 1', status: 'complete', created: '', updated: '' },
          { id: '2', name: 'Task 2', status: 'complete', created: '', updated: '' },
          { id: '3', name: 'Task 3', status: 'in_progress', created: '', updated: '' },
          { id: '4', name: 'Task 4', status: 'pending', created: '', updated: '' },
          { id: '5', name: 'Task 5', status: 'pending', created: '', updated: '' }
        ]
      };

      mockReadFile.mockResolvedValue(JSON.stringify(existingTasks));

      const invocation = taskTool.createInvocation({
        action: 'show_progress'
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.returnDisplay).toContain('📊 **Progress Summary:**');
      expect(result.returnDisplay).toContain('✅ Complete: 2');
      expect(result.returnDisplay).toContain('🔄 In Progress: 1');
      expect(result.returnDisplay).toContain('⏳ Pending: 2');
      expect(result.returnDisplay).toContain('📈 **Overall Progress: 40% (2/5)**');
    });
  });

  describe('Remove Task Action', () => {
    it('should remove task successfully', async () => {
      const existingTasks = {
        tasks: [
          { id: '1', name: 'Task to remove', status: 'pending', created: '', updated: '' },
          { id: '2', name: 'Task to keep', status: 'pending', created: '', updated: '' }
        ]
      };

      mockReadFile.mockResolvedValue(JSON.stringify(existingTasks));
      mockWriteFile.mockResolvedValue(undefined);

      const invocation = taskTool.createInvocation({
        action: 'remove',
        task_name: 'Task to remove'
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.returnDisplay).toContain('🗑️ Removed task: "Task to remove"');
      
      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenData.tasks).toHaveLength(1);
      expect(writtenData.tasks[0].name).toBe('Task to keep');
    });

    it('should return error when task to remove not found', async () => {
      const existingTasks = { tasks: [] };
      mockReadFile.mockResolvedValue(JSON.stringify(existingTasks));

      const invocation = taskTool.createInvocation({
        action: 'remove',
        task_name: 'Nonexistent task'
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.returnDisplay).toContain('❌ Task not found: "Nonexistent task"');
    });
  });

  describe('Error Handling', () => {
    it('should handle file system errors gracefully', async () => {
      mockReadFile.mockRejectedValue(new Error('Permission denied'));
      mockWriteFile.mockRejectedValue(new Error('Disk full'));

      const invocation = taskTool.createInvocation({
        action: 'add',
        task_name: 'Test task'
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.returnDisplay).toContain('❌ Task management error');
      expect(result.returnDisplay).toContain('Disk full');
    });

    it('should handle invalid JSON gracefully', async () => {
      mockReadFile.mockResolvedValue('invalid json content');
      mockWriteFile.mockResolvedValue(undefined);

      const invocation = taskTool.createInvocation({
        action: 'add',
        task_name: 'Test task'
      });

      const result = await invocation.execute(new AbortController().signal);

      // Should create new task file when JSON is invalid
      expect(result.returnDisplay).toContain('✅ Added task: "Test task"');
    });

    it('should return error for unknown action', async () => {
      const invocation = taskTool.createInvocation({
        action: 'unknown_action' as any
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.returnDisplay).toContain('❌ Unknown action: unknown_action');
    });
  });

  describe('Persistence', () => {
    it('should save tasks to correct file path', async () => {
      mockReadFile.mockRejectedValue(new Error('File not found'));
      mockWriteFile.mockResolvedValue(undefined);

      const invocation = taskTool.createInvocation({
        action: 'add',
        task_name: 'Test task'
      });

      await invocation.execute(new AbortController().signal);

      // Check direct write to tasks.json
      expect(mockWriteFile).toHaveBeenCalledWith(
        path.join(mockCwd, 'tasks.json'),
        expect.any(String),
        'utf-8'
      );
    });

    it('should create valid JSON structure', async () => {
      mockReadFile.mockRejectedValue(new Error('File not found'));
      mockWriteFile.mockResolvedValue(undefined);

      const invocation = taskTool.createInvocation({
        action: 'add',
        task_name: 'Test task',
        context: 'Test context'
      });

      await invocation.execute(new AbortController().signal);

      const writtenJson = mockWriteFile.mock.calls[0][1];
      const parsedData = JSON.parse(writtenJson);

      expect(parsedData).toHaveProperty('tasks');
      expect(Array.isArray(parsedData.tasks)).toBe(true);
      expect(parsedData.tasks[0]).toHaveProperty('id');
      expect(parsedData.tasks[0]).toHaveProperty('name');
      expect(parsedData.tasks[0]).toHaveProperty('status');
      expect(parsedData.tasks[0]).toHaveProperty('created');
      expect(parsedData.tasks[0]).toHaveProperty('updated');
    });
  });

  describe('Tool Descriptions', () => {
    it('should provide appropriate descriptions for each action', () => {
      const addInvocation = taskTool.createInvocation({
        action: 'add',
        task_name: 'Test task'
      });
      expect(addInvocation.getDescription()).toContain('Add task: "Test task"');

      const completeInvocation = taskTool.createInvocation({
        action: 'complete',
        task_name: 'Test task'
      });
      expect(completeInvocation.getDescription()).toContain('Complete task: "Test task"');

      const listInvocation = taskTool.createInvocation({
        action: 'list'
      });
      expect(listInvocation.getDescription()).toContain('List all tasks');
    });
  });
});