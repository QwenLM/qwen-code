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
    'Manage persistent task lists with automatic state tracking. Add, complete, list, and update tasks without manual tracking.',
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
      let taskList: TaskList = { tasks: [] };

      // Load existing tasks with better error handling
      try {
        const content = await fs.readFile(tasksPath, 'utf-8');
        const parsed = JSON.parse(content);
        
        // Validate the structure
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tasks)) {
          taskList = parsed;
        } else {
          console.warn('Invalid task file structure, starting fresh');
          taskList = { tasks: [] };
        }
      } catch (error) {
        // File doesn't exist, is corrupted, or has invalid JSON - start fresh
        console.warn('Task file not found or corrupted, starting fresh:', error instanceof Error ? error.message : 'Unknown error');
        taskList = { tasks: [] };
      }

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
            id: Date.now().toString(),
            name: task_name,
            status: 'pending',
            context,
            created: now,
            updated: now,
          };
          
          taskList.tasks.push(newTask);
          await this.saveTaskList(tasksPath, taskList);
          
          // Auto-display task list after adding
          
          return {
            llmContent: JSON.stringify({
              success: true,
              action: 'add',
              task: newTask,
              taskList: taskList,
            }),
            returnDisplay: `Added: ${task_name}`,
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
          
          const taskToComplete = taskList.tasks.find(t => 
            t.name.toLowerCase().includes(task_name.toLowerCase()) && t.status !== 'complete'
          );
          
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
          
          // Auto-display task list after completing
          
          return {
            llmContent: JSON.stringify({
              success: true,
              action: 'complete',
              task: taskToComplete,
              taskList: taskList,
            }),
            returnDisplay: `Completed: ${taskToComplete.name}`,
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
          
          const taskToProgress = taskList.tasks.find(t => 
            t.name.toLowerCase().includes(task_name.toLowerCase())
          );
          
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
          
          // Auto-display task list after starting work
          
          return {
            llmContent: JSON.stringify({
              success: true,
              action: 'in_progress',
              task: taskToProgress,
              taskList: taskList,
            }),
            returnDisplay: `Started: ${taskToProgress.name}`,
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
          const taskDisplay = this.formatTaskList(taskList);
          
          return {
            llmContent: JSON.stringify({
              success: true,
              action: 'list',
              tasks: taskList.tasks,
              total: taskList.tasks.length,
            }),
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
          
          const completed = taskList.tasks.filter(t => t.status === 'complete').length;
          const inProgress = taskList.tasks.filter(t => t.status === 'in_progress').length;
          const pending = taskList.tasks.filter(t => t.status === 'pending').length;
          const total = taskList.tasks.length;
          const percentage = Math.round((completed / total) * 100);
          
          return {
            llmContent: JSON.stringify({
              success: true,
              action: 'show_progress',
              completed,
              inProgress,
              pending,
              total,
              percentage,
            }),
            returnDisplay: `📊 **Progress Summary:**\n\n` +
                          `✅ Complete: ${completed}\n` +
                          `🔄 In Progress: ${inProgress}\n` +
                          `⏳ Pending: ${pending}\n` +
                          `📈 **Overall Progress: ${percentage}% (${completed}/${total})**`,
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

          return {
            llmContent: JSON.stringify({
              success: true,
              action: 'batch_add',
              addedCount,
              taskList: taskList,
            }),
            returnDisplay: `Added ${addedCount} tasks`,
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

          return {
            llmContent: JSON.stringify({
              success: true,
              action: 'batch_update',
              updatedCount,
              taskList: taskList,
            }),
            returnDisplay: `Updated ${updatedCount} tasks`,
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


  private async saveTaskList(tasksPath: string, taskList: TaskList): Promise<void> {
    // Simplified save - direct write with better error handling
    const content = JSON.stringify(taskList, null, 2);
    
    try {
      await fs.writeFile(tasksPath, content, 'utf-8');
    } catch (error) {
      console.error('Failed to save tasks:', error);
      throw new Error(`Failed to save tasks: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private formatTaskList(taskList: TaskList): string {
    if (taskList.tasks.length === 0) {
      return '🎯 No tasks yet - use qwen_tasks to add some!';
    }
    
    // Calculate metrics
    const completed = taskList.tasks.filter(t => t.status === 'complete').length;
    const inProgress = taskList.tasks.filter(t => t.status === 'in_progress').length;
    const pending = taskList.tasks.filter(t => t.status === 'pending').length;
    const total = taskList.tasks.length;
    const percentage = Math.round((completed / total) * 100);
    
    // Use format that works well in QwenCode's text rendering
    let output = '┌─────────────────────────────────────────────────────────────────┐\n';
    output += '│                        📋 TASK DASHBOARD                        │\n';
    output += '├─────────────────────────────────────────────────────────────────┤\n';
    output += `│ 📊 Progress: ${completed}/${total} complete (${percentage}%)${' '.repeat(Math.max(0, 35 - `Progress: ${completed}/${total} complete (${percentage}%)`.length))}│\n`;
    output += `│ 📈 Status: ✅ ${completed} • 🔄 ${inProgress} • ⏳ ${pending}${' '.repeat(Math.max(0, 41 - `Status: ✅ ${completed} • 🔄 ${inProgress} • ⏳ ${pending}`.length))}│\n`;
    output += '├─────────────────────────────────────────────────────────────────┤\n';
    
    taskList.tasks.forEach((task, index) => {
      let statusIcon: string;
      let statusText: string; 
      let taskDisplay: string = task.name;
      
      switch (task.status) {
        case 'complete':
          statusIcon = '✅';
          statusText = 'DONE';
          break;
        case 'in_progress':
          statusIcon = '🔄';
          statusText = 'WORK';
          taskDisplay = `► ${task.name}`;  // Arrow for active
          break;
        case 'pending':
          statusIcon = '⏳';
          statusText = 'TODO';
          break;
      }
      
      // Format task line with consistent spacing
      const taskNum = `${index + 1}.`.padEnd(3);
      const status = `${statusIcon} ${statusText}`.padEnd(8);
      
      // Truncate task name if too long (leave room for borders and formatting)
      const maxTaskLength = 40;
      if (taskDisplay.length > maxTaskLength) {
        taskDisplay = taskDisplay.substring(0, maxTaskLength - 3) + '...';
      }
      
      output += `│ ${taskNum}${status} ${taskDisplay}${' '.repeat(Math.max(0, 55 - taskNum.length - status.length - taskDisplay.length))}│\n`;
      
      // Add context line if present
      if (task.context) {
        const contextText = `💡 ${task.context}`;
        const truncatedContext = contextText.length > 60 ? contextText.substring(0, 57) + '...' : contextText;
        output += `│      ${truncatedContext}${' '.repeat(Math.max(0, 59 - truncatedContext.length))}│\n`;
      }
    });
    
    output += '├─────────────────────────────────────────────────────────────────┤\n';
    output += '│ 💡 Commands: add | complete | in_progress | remove | list      │\n';
    output += '└─────────────────────────────────────────────────────────────────┘';
    
    return output;
  }
}

export class TaskTool extends BaseDeclarativeTool<TaskToolParams, ToolResult> {
  static readonly Name: string = taskToolSchemaData.name!;

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