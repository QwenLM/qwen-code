/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  getSchemaProperties,
  Kind,
  type ToolInvocation,
  type Todo,
  type TodoWriteResult,
  type ToolResult,
} from './tools.js';
import { WRITE_TODOS_TOOL_NAME } from './tool-names.js';
import { CORE_TOOL_SET } from './definitions/coreTools.js';
import { getTodoWriteDescription } from './tool-use-display.js';
import { coerceContainerArgsToSchema } from '../utils/coerceArgs.js';
import { runLogger } from '../utils/runLogger.js';
import { SchemaValidator } from '../utils/schemaValidator.js';

const TODO_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
  'blocked',
] as const;
const TODO_STATUS_LIST = TODO_STATUSES.join(', ');
const TODO_EXAMPLE =
  '{ "todos": [{ "description": "fix bug", "status": "in_progress" }] }';
const ALLOWED_TODO_KEYS = new Set(['description', 'status']);

interface SanitizeOutcome {
  cleaned: unknown[];
  droppedKeys: string[];
  aliasUsed: string[];
}

function sanitizeTodos(rawTodos: unknown): SanitizeOutcome {
  if (!Array.isArray(rawTodos)) {
    return { cleaned: [], droppedKeys: [], aliasUsed: [] };
  }

  const dropped = new Set<string>();
  const aliases = new Set<string>();
  const cleaned = rawTodos.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return item;
    }

    const src = item as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const rawDescription = src['description'];
    const rawContent = src['content'];
    const hasDescription =
      typeof rawDescription === 'string' && rawDescription.length > 0;

    if (!hasDescription && typeof rawContent === 'string') {
      out['description'] = rawContent;
      aliases.add('content->description');
    }

    for (const key of Object.keys(src)) {
      if (key === 'content' && !hasDescription) {
        continue;
      }
      if (ALLOWED_TODO_KEYS.has(key)) {
        if (out[key] === undefined) {
          out[key] = src[key];
        }
      } else {
        dropped.add(key);
      }
    }

    return out;
  });

  return {
    cleaned,
    droppedKeys: [...dropped].sort(),
    aliasUsed: [...aliases].sort(),
  };
}

function humanizeTodoWriteError(args: {
  rawMessage: string;
  droppedKeys: string[];
  aliasUsed: string[];
  todosCount: number;
}): string {
  const { rawMessage, droppedKeys } = args;

  if (
    rawMessage.includes('params/todos must be array') ||
    rawMessage.includes('`todos` parameter must be an array')
  ) {
    return `TodoWrite expected \`todos\` to be an array of todo objects. Example: ${TODO_EXAMPLE}`;
  }

  if (
    rawMessage.includes('Value of params must be an object') ||
    rawMessage.includes('params must be object')
  ) {
    return `TodoWrite parameters must be an object with a \`todos\` array. Example: ${TODO_EXAMPLE}`;
  }

  if (rawMessage.match(/params\/todos\/\d+ must be object/)) {
    return `Each TodoWrite item must be an object with \`description\` and \`status\`. Example: ${TODO_EXAMPLE}`;
  }

  if (rawMessage.includes('An unexpected parameter')) {
    if (/An unexpected parameter `[^`.[]+` was provided/.test(rawMessage)) {
      return `TodoWrite parameters only accept a top-level \`todos\` field. Example: ${TODO_EXAMPLE}`;
    }
    if (droppedKeys.length > 0) {
      return (
        `TodoWrite todo items only accept \`description\` and \`status\`. ` +
        `Removed unsupported field(s): ${droppedKeys.join(', ')}. ` +
        `Retry with shape: ${TODO_EXAMPLE}`
      );
    }
    return `TodoWrite parameters only accept a top-level \`todos\` field. Example: ${TODO_EXAMPLE}`;
  }

  if (rawMessage.includes("must have required property 'description'")) {
    return `Each TodoWrite item requires a non-empty \`description\` string. Example: ${TODO_EXAMPLE}`;
  }

  if (rawMessage.includes("must have required property 'status'")) {
    return `Each TodoWrite item requires \`status\` with one of: ${TODO_STATUS_LIST}. Example: ${TODO_EXAMPLE}`;
  }

  if (
    rawMessage.includes('status must be equal to one of the allowed values') ||
    rawMessage.includes('Each todo must have a valid status')
  ) {
    return `Invalid TodoWrite \`status\`. Use one of: ${TODO_STATUS_LIST}.`;
  }

  if (rawMessage.includes('Each todo must have a non-empty description string')) {
    return `Each TodoWrite item requires a non-empty \`description\` string. Example: ${TODO_EXAMPLE}`;
  }

  if (rawMessage.includes('Only one task can be "in_progress" at a time')) {
    return `${rawMessage} Set the other active tasks to pending or blocked.`;
  }

  return `${rawMessage}. Expected shape: ${TODO_EXAMPLE}`;
}

export interface WriteTodosToolParams {
  /**
   * The full list of todos. This will overwrite any existing list.
   */
  todos: Todo[];
}

class WriteTodosToolInvocation extends BaseToolInvocation<
  WriteTodosToolParams,
  ToolResult
> {
  constructor(
    params: WriteTodosToolParams,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    return getTodoWriteDescription(this.params);
  }

  async execute(
    _signal: AbortSignal,
    _updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    const rawTodos = this.params.todos ?? [];

    // When the caller marks every item completed, clear the list so the
    // reminder doesn't perpetually surface a fully-done list.
    const allCompleted =
      rawTodos.length > 0 && rawTodos.every((t) => t.status === 'completed');
    const todos = allCompleted ? [] : rawTodos;
    const toolUseResult: TodoWriteResult = {
      oldTodos: [],
      newTodos: todos,
    };

    const todoListString = todos
      .map(
        (todo, index) => `${index + 1}. [${todo.status}] ${todo.description}`,
      )
      .join('\n');

    const llmContent = allCompleted
      ? 'All tasks completed. Todo list has been cleared.'
      : todos.length > 0
        ? `Successfully updated the todo list. The current list is now:\n${todoListString}`
        : 'Successfully cleared the todo list.';

    return {
      llmContent,
      returnDisplay: { todos },
      toolUseResult,
    };
  }
}

export class WriteTodosTool extends BaseDeclarativeTool<
  WriteTodosToolParams,
  ToolResult
> {
  static readonly Name = WRITE_TODOS_TOOL_NAME;

  constructor() {
    super(
      WriteTodosTool.Name,
      'WriteTodos',
      CORE_TOOL_SET.TodoWrite.description!,
      Kind.Other,
      CORE_TOOL_SET.TodoWrite.parametersJsonSchema,
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  override validateToolParams(params: WriteTodosToolParams): string | null {
    const schema = this.schema.parametersJsonSchema;
    const schemaProps = getSchemaProperties(schema);
    const paramsRecord = params as unknown as Record<string, unknown>;
    const coercedParams = coerceContainerArgsToSchema(
      paramsRecord,
      schemaProps,
    );
    if (coercedParams && coercedParams !== paramsRecord) {
      Object.assign(params, coercedParams);
    }

    let droppedKeys: string[] = [];
    let aliasUsed: string[] = [];
    if (Array.isArray(params?.todos)) {
      const outcome = sanitizeTodos(params.todos);
      params.todos = outcome.cleaned as Todo[];
      droppedKeys = outcome.droppedKeys;
      aliasUsed = outcome.aliasUsed;
      if (droppedKeys.length || aliasUsed.length) {
        runLogger.debug(
          `TodoWrite normalized payload: dropped=[${droppedKeys.join(',')}] alias=[${aliasUsed.join(',')}]`,
        );
      }
    }

    const humanize = (rawMessage: string) =>
      humanizeTodoWriteError({
        rawMessage,
        droppedKeys,
        aliasUsed,
        todosCount: Array.isArray(params?.todos) ? params.todos.length : 0,
      });

    const errors = SchemaValidator.validate(schema, params);
    if (errors) {
      return humanize(errors);
    }

    const valueError = this.validateToolParamValues(params);
    return valueError ? humanize(valueError) : null;
  }

  protected override validateToolParamValues(
    params: WriteTodosToolParams,
  ): string | null {
    const todos = params?.todos;
    if (!params || !Array.isArray(todos)) {
      return '`todos` parameter must be an array';
    }

    for (const todo of todos) {
      if (typeof todo !== 'object' || todo === null) {
        return 'Each todo item must be an object';
      }
      if (typeof todo.description !== 'string' || !todo.description.trim()) {
        return 'Each todo must have a non-empty description string';
      }
      if (!TODO_STATUSES.includes(todo.status)) {
        return `Each todo must have a valid status (${TODO_STATUSES.join(', ')})`;
      }
    }

    const inProgressCount = todos.filter(
      (todo: Todo) => todo.status === 'in_progress',
    ).length;

    if (inProgressCount > 1) {
      return 'Invalid parameters: Only one task can be "in_progress" at a time.';
    }

    return null;
  }

  protected createInvocation(
    params: WriteTodosToolParams,
    _toolName?: string,
    _displayName?: string,
  ): ToolInvocation<WriteTodosToolParams, ToolResult> {
    return new WriteTodosToolInvocation(params, _toolName, _displayName);
  }
}
