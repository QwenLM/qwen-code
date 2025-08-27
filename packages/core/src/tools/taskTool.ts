/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolResult,
} from './tools.js';
import { FunctionDeclaration } from '@google/genai';
import * as fs from 'fs/promises';
import * as path from 'path';

const taskToolSchemaData: FunctionDeclaration = {
  name: 'qwen_tasks',
  description:
    'Manage task lists efficiently. Visual indicators: ● complete, 🟡 active, ○ pending. Always show task list after modifications for immediate visual feedback.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action to perform',
        enum: ['add', 'complete', 'in_progress', 'list', 'show_progress', 'remove', 'batch_add', 'batch_update'],
      },
      task_name: {
        type: 'string',
        description: 'Name of the task (required for add, complete, in_progress, remove actions)',
      },
      context: {
        type: 'string',
        description: 'Optional context or notes for the task',
      },
      tasks: {
        type: 'array',
        description: 'Array of tasks for batch operations (required for batch_add, batch_update)',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            context: { type: 'string' },
            action: { type: 'string', enum: ['add', 'complete', 'in_progress', 'remove'] }
          },
          required: ['name']
        }
      },
    },
    required: ['action'],
  },
};

const taskToolDescription = `
Manages persistent task lists with automatic state tracking.

Single Actions:
- add: Create a new task
- complete: Mark a task as completed  
- in_progress: Mark a task as currently being worked on
- list: Show all tasks with their status
- show_progress: Display completion percentage
- remove: Remove a task from the list

Batch Actions:
- batch_add: Add multiple tasks in a single operation (prevents race conditions)
- batch_update: Update multiple tasks in a single operation

The system automatically persists state to tasks.json with atomic writes to prevent corruption.
`;

interface TaskToolParams {
  action: 'add' | 'complete' | 'in_progress' | 'list' | 'show_progress' | 'remove' | 'batch_add' | 'batch_update';
  task_name?: string;
  context?: string;
  tasks?: Array<{
    name: string;
    context?: string;
    action?: 'add' | 'complete' | 'in_progress' | 'remove';
  }>;
}

interface Task {
  id: string;
  name: string;
  status: 'pending' | 'in_progress' | 'complete';
  context?: string;
  created: string;
  updated: string;
}

interface TaskList {
  tasks: Task[];
}

class TaskToolInvocation extends BaseToolInvocation<TaskToolParams, ToolResult> {
  constructor(params: TaskToolParams) {
    super(params);
  }

  getDescription(): string {
    const { action, task_name } = this.params;
    
    switch (action) {
      case 'add':
        return `Add task: "${task_name}"`;
      case 'complete':
        return `Complete task: "${task_name}"`;
      case 'in_progress':
        return `Start working on: "${task_name}"`;
      case 'list':
        return 'List all tasks';
      case 'show_progress':
        return 'Show progress summary';
      case 'remove':
        return `Remove task: "${task_name}"`;
      case 'batch_add':
        return `Batch add ${this.params.tasks?.length || 0} tasks`;
      case 'batch_update':
        return `Batch update ${this.params.tasks?.length || 0} tasks`;
      default:
        return 'Task management operation';
    }
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const { action, task_name, context } = this.params;

    try {
      const tasksPath = path.join(process.cwd(), 'tasks.json');
      let taskList = await this.loadTaskList(tasksPath);

      const now = new Date().toISOString();

      switch (action) {
        case 'add':
          if (!task_name) {
            return {
              llmContent: JSON.stringify({
                success: false,
                error: 'task_name is required for add action',
              }),
              returnDisplay: '❌ Error: task_name is required for add action',
            };
          }
          
          const newTask: Task = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            name: task_name,
            status: 'pending',
            context,
            created: now,
            updated: now,
          };
          
          taskList.tasks.push(newTask);
          console.log(`[DEBUG] Adding task: ${newTask.name}`);
          console.log(`[DEBUG] Task list now has ${taskList.tasks.length} tasks`);
          await this.saveTaskList(tasksPath, taskList);
          
          // Auto-display updated task list 
          const addedTaskDisplay = this.formatTaskList(taskList);
          
          return {
            llmContent: JSON.stringify({
              success: true,
              action: 'add',
              task: newTask,
              taskList: taskList,
            }),
            returnDisplay: `Added: ${task_name}\n\n${addedTaskDisplay}`,
          };

        case 'complete':
          if (!task_name) {
            return {
              llmContent: JSON.stringify({
                success: false,
                error: 'task_name is required for complete action',
              }),
              returnDisplay: '❌ Error: task_name is required for complete action',
            };
          }
          
          // Reload task list to ensure we have the most current state
          taskList = await this.loadTaskList(tasksPath);
          
          const taskToComplete = taskList.tasks.find(t => 
            t.name.toLowerCase().includes(task_name.toLowerCase()) && t.status !== 'complete'
          );
          
          console.log(`[DEBUG] Looking for task to complete: "${task_name}"`);
          console.log(`[DEBUG] Available tasks:`, taskList.tasks.map(t => `${t.name} (${t.status}, id: ${t.id})`));
          
          if (!taskToComplete) {
            return {
              llmContent: JSON.stringify({
                success: false,
                error: `Task not found: "${task_name}"`,
              }),
              returnDisplay: `❌ Task not found: "${task_name}"`,
            };
          }
          
          taskToComplete.status = 'complete';
          taskToComplete.updated = now;
          await this.saveTaskList(tasksPath, taskList);
          
          // Auto-display updated task list
          const completedTaskDisplay = this.formatTaskList(taskList);
          
          return {
            llmContent: JSON.stringify({
              success: true,
              action: 'complete',
              task: taskToComplete,
              taskList: taskList,
            }),
            returnDisplay: `Completed: ${taskToComplete.name}\n\n${completedTaskDisplay}`,
          };

        case 'in_progress':
          if (!task_name) {
            return {
              llmContent: JSON.stringify({
                success: false,
                error: 'task_name is required for in_progress action',
              }),
              returnDisplay: '❌ Error: task_name is required for in_progress action',
            };
          }
          
          // Reload task list to ensure we have the most current state
          taskList = await this.loadTaskList(tasksPath);
          
          const taskToProgress = taskList.tasks.find(t => 
            t.name.toLowerCase().includes(task_name.toLowerCase())
          );
          
          console.log(`[DEBUG] Looking for task to set in progress: "${task_name}"`);
          console.log(`[DEBUG] Available tasks:`, taskList.tasks.map(t => `${t.name} (${t.status}, id: ${t.id})`));
          
          if (!taskToProgress) {
            return {
              llmContent: JSON.stringify({
                success: false,
                error: `Task not found: "${task_name}"`,
              }),
              returnDisplay: `❌ Task not found: "${task_name}"`,
            };
          }
          
          taskToProgress.status = 'in_progress';
          taskToProgress.updated = now;
          if (context) {
            taskToProgress.context = context;
          }
          await this.saveTaskList(tasksPath, taskList);
          
          // Auto-display updated task list
          const progressTaskDisplay = this.formatTaskList(taskList);
          
          return {
            llmContent: JSON.stringify({
              success: true,
              action: 'in_progress',
              task: taskToProgress,
              taskList: taskList,
            }),
            returnDisplay: `Started: ${taskToProgress.name}\n\n${progressTaskDisplay}`,
          };

        case 'remove':
          if (!task_name) {
            return {
              llmContent: JSON.stringify({
                success: false,
                error: 'task_name is required for remove action',
              }),
              returnDisplay: '❌ Error: task_name is required for remove action',
            };
          }
          
          const taskIndex = taskList.tasks.findIndex(t => 
            t.name.toLowerCase().includes(task_name.toLowerCase())
          );
          
          if (taskIndex === -1) {
            return {
              llmContent: JSON.stringify({
                success: false,
                error: `Task not found: "${task_name}"`,
              }),
              returnDisplay: `❌ Task not found: "${task_name}"`,
            };
          }
          
          const removedTask = taskList.tasks.splice(taskIndex, 1)[0];
          await this.saveTaskList(tasksPath, taskList);
          
          // Auto-display task list after removing
          
          return {
            llmContent: JSON.stringify({
              success: true,
              action: 'remove',
              task: removedTask,
              taskList: taskList,
            }),
            returnDisplay: `Removed: ${removedTask.name}`,
          };

        case 'list':
          console.log(`[DEBUG] List action: Found ${taskList.tasks.length} tasks`);
          console.log(`[DEBUG] Task list contents:`, taskList.tasks.map(t => `${t.name} (${t.status})`));
          
          const taskDisplay = this.formatTaskList(taskList);
          
          // Count tasks by status for clear context
          const completed = taskList.tasks.filter(t => t.status === 'complete').length;
          const inProgress = taskList.tasks.filter(t => t.status === 'in_progress').length;
          const pending = taskList.tasks.filter(t => t.status === 'pending').length;
          
          return {
            llmContent: `Task list displayed with visual indicators: ● complete (${completed}), 🟡 active (${inProgress}), ○ pending (${pending}). The visual display shows the current status - no need to repeat it.`,
            returnDisplay: taskDisplay,
          };

        case 'show_progress':
          if (taskList.tasks.length === 0) {
            return {
              llmContent: JSON.stringify({
                success: true,
                action: 'show_progress',
                completed: 0,
                inProgress: 0,
                pending: 0,
                total: 0,
                percentage: 0,
              }),
              returnDisplay: '📊 No tasks to track progress.',
            };
          }
          
          const progressCompleted = taskList.tasks.filter(t => t.status === 'complete').length;
          const progressInProgress = taskList.tasks.filter(t => t.status === 'in_progress').length;
          const progressPending = taskList.tasks.filter(t => t.status === 'pending').length;
          const total = taskList.tasks.length;
          const percentage = Math.round((progressCompleted / total) * 100);
          
          return {
            llmContent: JSON.stringify({
              success: true,
              action: 'show_progress',
              completed: progressCompleted,
              inProgress: progressInProgress,
              pending: progressPending,
              total,
              percentage,
            }),
            returnDisplay: `📊 **Progress Summary:**\n\n` +
                          `✅ Complete: ${progressCompleted}\n` +
                          `🔄 In Progress: ${progressInProgress}\n` +
                          `⏳ Pending: ${progressPending}\n` +
                          `📈 **Overall Progress: ${percentage}% (${progressCompleted}/${total})**`,
          };

        case 'batch_add':
          if (!this.params.tasks || this.params.tasks.length === 0) {
            return {
              llmContent: JSON.stringify({
                success: false,
                error: 'tasks array is required for batch_add action',
              }),
              returnDisplay: '❌ Error: tasks array is required for batch_add action',
            };
          }

          let addedCount = 0;
          for (const taskInfo of this.params.tasks) {
            const newTask: Task = {
              id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
              name: taskInfo.name,
              status: 'pending',
              context: taskInfo.context,
              created: now,
              updated: now,
            };
            taskList.tasks.push(newTask);
            addedCount++;
          }

          await this.saveTaskList(tasksPath, taskList);

          // Auto-display updated task list
          const batchAddDisplay = this.formatTaskList(taskList);
          
          return {
            llmContent: JSON.stringify({
              success: true,
              action: 'batch_add',
              addedCount,
              taskList: taskList,
            }),
            returnDisplay: `Added ${addedCount} tasks\n\n${batchAddDisplay}`,
          };

        case 'batch_update':
          if (!this.params.tasks || this.params.tasks.length === 0) {
            return {
              llmContent: JSON.stringify({
                success: false,
                error: 'tasks array is required for batch_update action',
              }),
              returnDisplay: '❌ Error: tasks array is required for batch_update action',
            };
          }

          let updatedCount = 0;
          for (const taskInfo of this.params.tasks) {
            const task = taskList.tasks.find(t => 
              t.name.toLowerCase().includes(taskInfo.name.toLowerCase())
            );
            
            if (task) {
              if (taskInfo.action === 'complete') {
                task.status = 'complete';
              } else if (taskInfo.action === 'in_progress') {
                task.status = 'in_progress';
              } else if (taskInfo.action === 'remove') {
                const index = taskList.tasks.indexOf(task);
                taskList.tasks.splice(index, 1);
              }
              
              if (taskInfo.context) {
                task.context = taskInfo.context;
              }
              
              task.updated = now;
              updatedCount++;
            }
          }

          await this.saveTaskList(tasksPath, taskList);

          // Auto-display updated task list
          const batchUpdateDisplay = this.formatTaskList(taskList);
          
          return {
            llmContent: JSON.stringify({
              success: true,
              action: 'batch_update',
              updatedCount,
              taskList: taskList,
            }),
            returnDisplay: `Updated ${updatedCount} tasks\n\n${batchUpdateDisplay}`,
          };

        default:
          return {
            llmContent: JSON.stringify({
              success: false,
              error: `Unknown action: ${action}`,
            }),
            returnDisplay: `❌ Unknown action: ${action}`,
          };
      }
    } catch (error) {
      return {
        llmContent: JSON.stringify({
          success: false,
          error: `Task management error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }),
        returnDisplay: `❌ Task management error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  private async loadTaskList(tasksPath: string): Promise<TaskList> {
    try {
      const content = await fs.readFile(tasksPath, 'utf-8');
      
      // Check for obviously corrupted content
      if (!content.trim() || content.trim().length < 10) {
        console.warn('Task file appears empty or too short, starting fresh');
        return { tasks: [] };
      }
      
      // Try to parse JSON with better error handling
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (jsonError) {
        console.warn('JSON parsing failed, attempting to recover by cleaning content');
        
        // Try to find the last complete JSON structure
        const lastBraceIndex = content.lastIndexOf('}');
        if (lastBraceIndex > 0) {
          const cleanContent = content.substring(0, lastBraceIndex + 1);
          try {
            parsed = JSON.parse(cleanContent);
            console.log('Successfully recovered from partial JSON corruption');
          } catch {
            console.warn('Recovery failed, starting fresh');
            return { tasks: [] };
          }
        } else {
          console.warn('No recoverable JSON structure found, starting fresh');
          return { tasks: [] };
        }
      }
      
      console.log(`[DEBUG] Loading tasks from ${tasksPath}`);
      console.log(`[DEBUG] Loaded ${parsed?.tasks?.length || 0} existing tasks`);
      
      // Validate the structure
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tasks)) {
        return parsed;
      } else {
        console.warn('Invalid task file structure, starting fresh');
        return { tasks: [] };
      }
    } catch (error) {
      // File doesn't exist, is corrupted, or has invalid JSON - start fresh
      console.warn('Task file not found or corrupted, starting fresh:', error instanceof Error ? error.message : 'Unknown error');
      return { tasks: [] };
    }
  }

  private async saveTaskList(tasksPath: string, taskList: TaskList): Promise<void> {
    // Use file locking to prevent concurrent writes
    TaskTool.fileLockPromise = TaskTool.fileLockPromise.then(async () => {
      const content = JSON.stringify(taskList, null, 2);
      const tempPath = `${tasksPath}.tmp.${Date.now()}.${Math.random().toString(36).substr(2, 9)}`;
      
      try {
        console.log(`[DEBUG] Acquiring file lock for save operation`);
        
        // Write to temporary file first
        await fs.writeFile(tempPath, content, 'utf-8');
        
        // Validate the written content by parsing it
        const written = await fs.readFile(tempPath, 'utf-8');
        const parsed = JSON.parse(written);
        
        if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
          throw new Error('Invalid task structure written to file');
        }
        
        // Ensure we have the exact number of tasks expected
        if (parsed.tasks.length !== taskList.tasks.length) {
          throw new Error(`Task count mismatch: expected ${taskList.tasks.length}, got ${parsed.tasks.length}`);
        }
        
        // Atomic rename to final file
        await fs.rename(tempPath, tasksPath);
        
        console.log(`[DEBUG] Successfully saved ${taskList.tasks.length} tasks atomically`);
        
      } catch (error) {
        // Clean up temp file if it exists
        try {
          await fs.unlink(tempPath);
        } catch {
          // Ignore cleanup errors
        }
        
        console.error('Failed to save tasks:', error);
        throw new Error(`Failed to save tasks: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    });
    
    return TaskTool.fileLockPromise;
  }

  private formatTaskList(taskList: TaskList): string {
    if (taskList.tasks.length === 0) {
      return '📋 No tasks yet';
    }
    
    let output = '';
    
    taskList.tasks.forEach((task, index) => {
      let radioButton: string;
      
      switch (task.status) {
        case 'complete':
          radioButton = '●';  // Solid filled circle - completed
          break;
        case 'in_progress': 
          radioButton = '🟡'; // Yellow circle - active/in progress
          break;
        case 'pending':
          radioButton = '○';  // Empty circle - not started
          break;
      }
      
      // Single compact row per task
      output += `${radioButton} ${task.name}\n`;
    });
    
    return output.trim();
  }
}

export class TaskTool extends BaseDeclarativeTool<TaskToolParams, ToolResult> {
  static readonly Name: string = taskToolSchemaData.name!;
  static fileLockPromise: Promise<void> = Promise.resolve();

  constructor() {
    super(
      TaskTool.Name,
      'Task Management',
      taskToolDescription,
      Kind.Other, // Tasks modify file system (tasks.json)
      taskToolSchemaData.parametersJsonSchema as Record<string, unknown>,
    );
  }

  getDeclaration(): FunctionDeclaration {
    return taskToolSchemaData;
  }

  createInvocation(params: TaskToolParams) {
    return new TaskToolInvocation(params);
  }
}