/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { FunctionDeclaration } from '@google/genai';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { detectTodoChanges, HookPhase, type TodoItem } from '../hooks/types.js';
export type { TodoItem } from '../hooks/types.js';

const debugLogger = createDebugLogger('TODO_WRITE');

export interface TodoWriteParams {
  todos: TodoItem[];
  modified_by_user?: boolean;
  modified_content?: string;
}

const todoWriteToolSchemaData: FunctionDeclaration = {
  name: 'todo_write',
  description:
    'Creates and manages a concise, user-visible task list for complex or multi-step work.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              minLength: 1,
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
            },
            id: {
              type: 'string',
            },
          },
          required: ['content', 'status', 'id'],
          additionalProperties: false,
        },
        description: 'The updated todo list',
      },
    },
    required: ['todos'],
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
};

const todoWriteToolDescription = `
Use this tool to create and manage a user-visible task list when explicit progress tracking improves clarity.

## When to Use This Tool
Use this tool for work that is complex, ambiguous, or multi-phase; has multiple independent outcomes or important dependencies; benefits from checkpoints; or when the user explicitly asks for a todo list.

Do not use it for simple or single-step work, purely conversational or informational requests, or tasks that can be answered or completed directly unless the user explicitly requests a todo list.

## Planning with Todos

Keep the list short and outcome-oriented. Use a small number of meaningful, logically ordered, verifiable steps. Do not create a separate todo for every error, file, command, or minor edit.

Keep at most one task in_progress. When a plan exists, keep its statuses current, mark finished work completed, revise the plan when the scope or approach changes, and remove items that are no longer relevant. Do not mark incomplete or blocked work completed.
`;

function getTodoFilePath(todoDir: string, sessionId?: string): string {
  const filename = `${Storage.sanitizeTodoSessionId(
    sessionId || 'default',
  )}.json`;
  return path.join(todoDir, filename);
}

function isConfiguredTodoDir(todoDir: string): boolean {
  return path.resolve(todoDir) !== path.resolve(Storage.getTodosDir());
}

function isConfig(value: unknown): value is Config {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getTodosDir?: unknown }).getTodosDir === 'function'
  );
}

function getTodoDirectoryContext(source?: string | Config): {
  todoDir: string;
  projectRoot?: string;
  configured: boolean;
} {
  if (isConfig(source)) {
    const todoDir = source.getTodosDir();
    const configured = (
      source as Config & {
        isTodosDirectoryConfigured?: () => boolean;
      }
    ).isTodosDirectoryConfigured;
    return {
      todoDir,
      projectRoot: source.getTargetDir?.(),
      configured: configured
        ? configured.call(source)
        : isConfiguredTodoDir(todoDir),
    };
  }

  return {
    todoDir: source ?? Storage.getTodosDir(),
    configured: false,
  };
}

function assertTodoPathWithinAllowedDirectory(
  todoDir: string,
  todoFilePath: string,
  projectRoot?: string,
  configured = false,
): void {
  Storage.assertPathWithinDirectory(
    todoFilePath,
    todoDir,
    `Todo file path must resolve within the todos directory.`,
  );

  if (!projectRoot || !configured) {
    return;
  }

  Storage.assertPathWithinDirectory(
    todoDir,
    projectRoot,
    `todosDirectory must resolve within the project root.`,
  );
  Storage.assertPathWithinDirectory(
    todoFilePath,
    projectRoot,
    `Todo file path must resolve within the project root.`,
  );
}

/**
 * Reads the current todos from the file system
 */
async function readTodosFromFile(
  todoDir: string,
  sessionId?: string,
  projectRoot?: string,
  configured = false,
): Promise<TodoItem[]> {
  try {
    const todoFilePath = getTodoFilePath(todoDir, sessionId);
    assertTodoPathWithinAllowedDirectory(
      todoDir,
      todoFilePath,
      projectRoot,
      configured,
    );
    const content = await fs.readFile(todoFilePath, 'utf-8');
    const data = JSON.parse(content);
    return Array.isArray(data.todos) ? data.todos : [];
  } catch (err) {
    const error = err as Error & { code?: string };
    if (!(error instanceof Error) || error.code !== 'ENOENT') {
      throw err;
    }
    return [];
  }
}

/**
 * Writes todos to the file system
 */
async function writeTodosToFile(
  todoDir: string,
  todos: TodoItem[],
  sessionId?: string,
  projectRoot?: string,
  configured = false,
): Promise<void> {
  const todoFilePath = getTodoFilePath(todoDir, sessionId);
  const todoFileDir = path.dirname(todoFilePath);

  assertTodoPathWithinAllowedDirectory(
    todoDir,
    todoFilePath,
    projectRoot,
    configured,
  );
  await fs.mkdir(todoFileDir, { recursive: true });

  const data = {
    todos,
    sessionId: sessionId || 'default',
  };

  const contents = JSON.stringify(data, null, 2);
  await atomicWriteFile(todoFilePath, contents, {
    encoding: 'utf-8',
    noFollow: true,
  });
  try {
    assertTodoPathWithinAllowedDirectory(
      todoDir,
      todoFilePath,
      projectRoot,
      configured,
    );
  } catch (err) {
    try {
      await fs.unlink(todoFilePath);
    } catch (rollbackError) {
      debugLogger.error(
        `[TodoWriteTool] Post-write containment rollback failed: could not unlink ${todoFilePath}`,
        rollbackError,
      );
    }
    throw err;
  }
}

function createBlockedTodoResult(
  message: string,
  systemMessage: string,
): ToolResult {
  return {
    llmContent: `${message}

<system-reminder>
${systemMessage}
</system-reminder>`,
    returnDisplay: message,
  };
}

class TodoWriteToolInvocation extends BaseToolInvocation<
  TodoWriteParams,
  ToolResult
> {
  private operationType: 'create' | 'update';

  constructor(
    private readonly config: Config,
    params: TodoWriteParams,
    operationType: 'create' | 'update' = 'update',
  ) {
    super(params);
    this.operationType = operationType;
  }

  getDescription(): string {
    return this.operationType === 'create' ? 'Create todos' : 'Update todos';
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const { todos, modified_by_user, modified_content } = this.params;
    const sessionId = this.config.getSessionId();
    const { todoDir, projectRoot, configured } = getTodoDirectoryContext(
      this.config,
    );

    try {
      // 1. Read current todos (for change detection)
      const oldTodos = await readTodosFromFile(
        todoDir,
        sessionId,
        projectRoot,
        configured,
      );

      let finalTodos: TodoItem[];

      if (modified_by_user && modified_content !== undefined) {
        // User modified the content in external editor, parse it directly
        const data = JSON.parse(modified_content);
        finalTodos = Array.isArray(data.todos) ? data.todos : [];
      } else {
        // Use the normal todo logic - simply replace with new todos
        finalTodos = todos;
      }

      // 2. Detect changes
      const changes = detectTodoChanges(oldTodos, finalTodos);
      const oldTodosMap = new Map(oldTodos.map((t) => [t.id, t]));

      // 3. VALIDATION PHASE: Execute all hooks with Validation phase
      // Hooks should only check and return block/approve decisions, no side effects
      const hookSystem = this.config.getHookSystem();

      // Validate TodoCreated hooks
      if (hookSystem && changes.created.length > 0) {
        const createdResults = await Promise.all(
          changes.created.map((todo) =>
            hookSystem.fireTodoCreatedEvent(
              todo.id,
              todo.content,
              todo.status,
              finalTodos,
              HookPhase.Validation,
              _signal,
            ),
          ),
        );

        const blockedCreatedResult = createdResults.find(
          (result) => result.finalOutput?.decision === 'block',
        );
        if (blockedCreatedResult?.finalOutput) {
          const reason =
            blockedCreatedResult.finalOutput.reason ||
            'Hook blocked todo creation';
          return createBlockedTodoResult(
            `Todo creation blocked: ${reason}`,
            `Todo list was not modified because a TodoCreated hook blocked the operation: ${reason}`,
          );
        }
      }

      // Validate TodoCompleted hooks
      if (hookSystem && changes.completed.length > 0) {
        const completedResults = await Promise.all(
          changes.completed.map((todo) => {
            const oldTodo = oldTodosMap.get(todo.id);
            const previousStatus = oldTodo?.status ?? 'pending';

            return hookSystem.fireTodoCompletedEvent(
              todo.id,
              todo.content,
              previousStatus as 'pending' | 'in_progress',
              finalTodos,
              HookPhase.Validation,
              _signal,
            );
          }),
        );

        const blockedCompletedResult = completedResults.find(
          (result) => result.finalOutput?.decision === 'block',
        );
        if (blockedCompletedResult?.finalOutput) {
          const reason =
            blockedCompletedResult.finalOutput.reason ||
            'Hook blocked todo completion';
          return createBlockedTodoResult(
            `Todo completion blocked: ${reason}`,
            `Todo list was not modified because a TodoCompleted hook blocked the operation: ${reason}`,
          );
        }
      }

      // 4. Write new todos AFTER all validation passes
      await writeTodosToFile(
        todoDir,
        finalTodos,
        sessionId,
        projectRoot,
        configured,
      );

      // 5. POST-WRITE PHASE: Execute hooks for side effects (logging, HTTP sync, etc.)
      // These hooks can now safely perform side effects knowing data is persisted
      // We don't check for blocking here since validation already passed.
      //
      // Dispatch sequentially in list order (NOT Promise.all). A single
      // todo_write call can change several items' statuses at once (the model is
      // encouraged to batch status updates that complete together), and these
      // post-write hooks run real side effects — logging, external HTTP sync,
      // stateful read-modify-write. Firing them concurrently for sibling items
      // could interleave a shared stateful/external-sync hook, lose an update,
      // or publish completions out of order. Serial, in-order dispatch keeps
      // the observable side effects deterministic.
      let postWriteError: Error | undefined;
      try {
        if (hookSystem && changes.created.length > 0) {
          for (const todo of changes.created) {
            await hookSystem.fireTodoCreatedEvent(
              todo.id,
              todo.content,
              todo.status,
              finalTodos,
              HookPhase.PostWrite,
              _signal,
            );
          }
        }

        if (hookSystem && changes.completed.length > 0) {
          for (const todo of changes.completed) {
            const oldTodo = oldTodosMap.get(todo.id);
            const previousStatus = oldTodo?.status ?? 'pending';

            await hookSystem.fireTodoCompletedEvent(
              todo.id,
              todo.content,
              previousStatus as 'pending' | 'in_progress',
              finalTodos,
              HookPhase.PostWrite,
              _signal,
            );
          }
        }
      } catch (error) {
        postWriteError =
          error instanceof Error ? error : new Error(String(error));
        debugLogger.error(
          `[TodoWriteTool] Post-write hooks failed after todos were persisted: ${postWriteError.message}`,
        );
      }

      // 6. Create structured display object for rich UI rendering
      const todoResultDisplay = {
        type: 'todo_list' as const,
        todos: finalTodos,
        changes,
      };

      // Create plain string format with system reminder
      const todosJson = JSON.stringify(finalTodos);
      let llmContent: string;
      const postWriteReminder = postWriteError
        ? `

<system-reminder>
Todos were persisted successfully, but post-write hooks failed with error: ${postWriteError.message}. Do not tell the user the write failed; only handle any follow-up hook issues if needed.
</system-reminder>`
        : '';

      if (finalTodos.length === 0) {
        // Special message for empty todos
        llmContent = `Todo list has been cleared.

<system-reminder>
Your todo list is now empty. DO NOT mention this explicitly to the user. You have no pending tasks in your todo list.
</system-reminder>${postWriteReminder}`;
      } else {
        // Normal message for todos with items
        llmContent = `Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable

<system-reminder>
Your todo list has changed. DO NOT mention this explicitly to the user. Here are the latest contents of your todo list:

${todosJson}. Continue on with the tasks at hand if applicable.
</system-reminder>${postWriteReminder}`;
      }

      return {
        llmContent,
        returnDisplay: todoResultDisplay,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      debugLogger.error(
        `[TodoWriteTool] Error executing todo_write: ${errorMessage}`,
      );

      // Create plain string format for error with system reminder
      const errorLlmContent = `Failed to modify todos. An error occurred during the operation.

<system-reminder>
Todo list modification failed with error: ${errorMessage}. You may need to retry or handle this error appropriately.
</system-reminder>`;

      return {
        llmContent: errorLlmContent,
        returnDisplay: `Error writing todos: ${errorMessage}`,
      };
    }
  }
}

/**
 * Utility function to read todos for a specific session (useful for session recovery)
 */
export async function readTodosForSession(
  config: Config,
  sessionId?: string,
): Promise<TodoItem[]>;
export async function readTodosForSession(
  sessionId?: string,
  todoDirOrConfig?: string | Config,
): Promise<TodoItem[]>;
export async function readTodosForSession(
  sessionIdOrConfig?: string | Config,
  todoDirOrSessionId?: string | Config,
): Promise<TodoItem[]> {
  let sessionId: string | undefined;
  let source: string | Config | undefined;

  if (isConfig(sessionIdOrConfig)) {
    sessionId =
      typeof todoDirOrSessionId === 'string' ? todoDirOrSessionId : undefined;
    source = sessionIdOrConfig;
  } else {
    sessionId = sessionIdOrConfig;
    source = todoDirOrSessionId;
  }

  const { todoDir, projectRoot, configured } = getTodoDirectoryContext(source);
  return readTodosFromFile(todoDir, sessionId, projectRoot, configured);
}

/**
 * Utility function to list all todo files in the todos directory
 */
export async function listTodoSessions(
  todoDirOrConfig?: string | Config,
): Promise<string[]> {
  try {
    const {
      todoDir: resolvedTodoDir,
      projectRoot,
      configured,
    } = getTodoDirectoryContext(todoDirOrConfig);
    if (projectRoot && configured) {
      Storage.assertPathWithinDirectory(
        resolvedTodoDir,
        projectRoot,
        `todosDirectory must resolve within the project root.`,
      );
    }
    const files = await fs.readdir(resolvedTodoDir);
    return files
      .filter((file: string) => file.endsWith('.json'))
      .map((file: string) => file.replace('.json', ''));
  } catch (err) {
    const error = err as Error & { code?: string };
    if (!(error instanceof Error) || error.code !== 'ENOENT') {
      throw err;
    }
    return [];
  }
}

export class TodoWriteTool extends BaseDeclarativeTool<
  TodoWriteParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.TODO_WRITE;

  constructor(private readonly config: Config) {
    super(
      TodoWriteTool.Name,
      ToolDisplayNames.TODO_WRITE,
      todoWriteToolDescription,
      Kind.Think,
      todoWriteToolSchemaData.parametersJsonSchema as Record<string, unknown>,
    );
  }

  override validateToolParams(params: TodoWriteParams): string | null {
    // Validate todos array
    if (!Array.isArray(params.todos)) {
      return 'Parameter "todos" must be an array.';
    }

    // Validate individual todos
    for (const todo of params.todos) {
      if (!todo.id || typeof todo.id !== 'string' || todo.id.trim() === '') {
        return 'Each todo must have a non-empty "id" string.';
      }
      if (
        !todo.content ||
        typeof todo.content !== 'string' ||
        todo.content.trim() === ''
      ) {
        return 'Each todo must have a non-empty "content" string.';
      }
      if (!['pending', 'in_progress', 'completed'].includes(todo.status)) {
        return 'Each todo must have a valid "status" (pending, in_progress, completed).';
      }
    }

    // Check for duplicate IDs
    const ids = params.todos.map((todo) => todo.id);
    const uniqueIds = new Set(ids);
    if (ids.length !== uniqueIds.size) {
      return 'Todo IDs must be unique within the array.';
    }

    return null;
  }

  protected createInvocation(params: TodoWriteParams) {
    // Determine if this is a create or update operation by checking if todos file exists
    const sessionId = this.config.getSessionId();
    const { todoDir, projectRoot, configured } = getTodoDirectoryContext(
      this.config,
    );
    const todoFilePath = getTodoFilePath(todoDir, sessionId);
    let operationType: 'create' | 'update' = 'create';
    try {
      assertTodoPathWithinAllowedDirectory(
        todoDir,
        todoFilePath,
        projectRoot,
        configured,
      );
      operationType = fsSync.existsSync(todoFilePath) ? 'update' : 'create';
    } catch {
      operationType = 'create';
    }

    return new TodoWriteToolInvocation(this.config, params, operationType);
  }
}
