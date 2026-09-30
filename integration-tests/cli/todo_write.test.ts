/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  runForcedToolCallScenario,
  TestRig,
  printDebugInfo,
  validateModelOutput,
} from '../test-helper.js';
import { fakeToolCall } from '../fake-openai-server.js';

async function runForcedTodoCall(rig: TestRig) {
  return runForcedToolCallScenario({
    rig,
    toolCall: fakeToolCall('todo_write', {
      todos: [{ id: '1', content: 'Verify Todo', status: 'pending' }],
    }),
    prompt: 'Complete the requested action.',
    finalResponse: 'done',
  });
}

function inspectTodoRequests(requests: Array<Record<string, unknown>>) {
  const initialRequest = requests[0];
  const tools = (initialRequest?.['tools'] ?? []) as Array<{
    function?: { name?: string };
  }>;
  const systemMessage = (
    (initialRequest?.['messages'] ?? []) as Array<{
      role?: string;
      content?: unknown;
    }>
  ).find(({ role }) => role === 'system');
  const toolResult = requests
    .flatMap(
      (request) =>
        ((request?.['messages'] ?? []) as Array<{
          role?: string;
          content?: unknown;
        }>) ?? [],
    )
    .filter(({ role }) => role === 'tool')
    .map(({ content }) => JSON.stringify(content))
    .join('\n');
  return {
    tools,
    baseSystemPrompt: String(systemMessage?.content).split('\n\n---\n\n', 1)[0],
    toolResultRequest: JSON.stringify(requests[1]),
    toolResult,
  };
}

describe('todo_write', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should not declare todo_write by default', async () => {
    const rig = new TestRig();
    await rig.setup('should not declare todo_write by default');

    const requests = await runForcedTodoCall(rig);
    const { tools, baseSystemPrompt, toolResultRequest } =
      inspectTodoRequests(requests);
    const toolDescriptionsWithTodo = tools
      .filter((tool) => JSON.stringify(tool).includes('todo_write'))
      .map((tool) => tool.function?.name);

    expect(tools.map((tool) => tool.function?.name)).not.toContain(
      'todo_write',
    );
    expect(baseSystemPrompt).not.toContain('todo_write');
    expect(toolDescriptionsWithTodo).toEqual([]);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(toolResultRequest).toContain('disabled by default');
    expect(toolResultRequest).toContain('tools.todoWrite.enabled');
  });

  it('should declare and execute todo_write when enabled', async () => {
    const rig = new TestRig();
    await rig.setup('should declare and execute todo_write when enabled', {
      settings: { tools: { todoWrite: { enabled: true } } },
    });

    const requests = await runForcedTodoCall(rig);
    const { tools, baseSystemPrompt, toolResult } =
      inspectTodoRequests(requests);

    expect(tools.map((tool) => tool.function?.name)).toContain('todo_write');
    expect(baseSystemPrompt).toContain('# Task Management');
    expect(toolResult).toContain('Verify Todo');
    expect(toolResult).not.toContain('disabled by default');
  });

  it('should be able to create and manage a todo list', async () => {
    const rig = new TestRig();
    await rig.setup('should be able to create and manage a todo list', {
      settings: { tools: { todoWrite: { enabled: true } } },
    });

    const prompt = `Please create a todo list with these three simple tasks:
1. Buy milk
2. Walk the dog  
3. Read a book

Use the todo_write tool to create this list.`;

    const result = await rig.run(prompt);

    const foundToolCall = await rig.waitForToolCall('todo_write');

    // Add debugging information
    if (!foundToolCall) {
      printDebugInfo(rig, result);
    }

    expect(
      foundToolCall,
      'Expected to find a todo_write tool call',
    ).toBeTruthy();

    // Validate model output - will throw if no output
    validateModelOutput(result, null, 'Todo write test');

    // Check that the tool was called with the right parameters
    const toolLogs = rig.readToolLogs();
    const todoWriteCalls = toolLogs.filter(
      (t) => t.toolRequest.name === 'todo_write',
    );

    expect(todoWriteCalls.length).toBeGreaterThan(0);

    // Parse the arguments to verify they contain our tasks
    const todoArgs = JSON.parse(todoWriteCalls[0].toolRequest.args ?? '{}');

    expect(todoArgs.todos).toBeDefined();
    expect(Array.isArray(todoArgs.todos)).toBe(true);
    expect(todoArgs.todos.length).toBeGreaterThanOrEqual(3);

    // Check that all todos have the correct structure
    for (const todo of todoArgs.todos) {
      expect(todo.id).toBeDefined();
      expect(todo.content).toBeDefined();
      expect(['pending', 'in_progress', 'completed', 'cancelled']).toContain(
        todo.status,
      );
    }

    // Log success info if verbose
    if (process.env['VERBOSE'] === 'true') {
      console.log('Todo list created successfully');
      console.log(`Created ${todoArgs.todos.length} todos`);
    }
  });
});
