/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  CONTAINER_SANDBOX_NO_PROXY,
  fakeServerHostOptions,
  IS_CONTAINER_SANDBOX,
  TestRig,
  printDebugInfo,
  validateModelOutput,
} from '../test-helper.js';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import { join } from 'node:path';

async function runForcedTodoCall(rig: TestRig) {
  let streamingRequestIndex = 0;
  const fakeServer = await startFakeOpenAIServer(({ body }) => {
    if (body['stream'] !== true) {
      return { content: '{"selected_memories":[]}' };
    }
    if (streamingRequestIndex++ === 0) {
      return {
        toolCalls: [
          fakeToolCall('todo_write', {
            todos: [{ id: '1', content: 'Verify Todo', status: 'pending' }],
          }),
        ],
      };
    }
    return { content: 'done' };
  }, fakeServerHostOptions());

  const noProxy = IS_CONTAINER_SANDBOX
    ? CONTAINER_SANDBOX_NO_PROXY
    : '127.0.0.1,localhost';
  vi.stubEnv('OPENAI_API_KEY', 'fake-key');
  vi.stubEnv('OPENAI_BASE_URL', fakeServer.baseUrl);
  vi.stubEnv('OPENAI_MODEL', 'fake-model');
  vi.stubEnv('QWEN_MODEL', 'fake-model');
  vi.stubEnv('QWEN_HOME', join(rig.testDir!, '.qwen-home'));
  vi.stubEnv('QWEN_RUNTIME_DIR', join(rig.testDir!, '.qwen-home'));
  vi.stubEnv('NO_PROXY', noProxy);
  vi.stubEnv('no_proxy', noProxy);

  try {
    await rig.run(
      'Complete the requested action.',
      '--auth-type',
      'openai',
      '--model',
      'fake-model',
      '--openai-base-url',
      fakeServer.baseUrl,
      '--openai-api-key',
      'fake-key',
    );
    return fakeServer.requests
      .filter(({ body }) => body['stream'] === true)
      .map(({ body }) => body);
  } finally {
    await fakeServer.close();
  }
}

describe('todo_write', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should not declare todo_write by default', async () => {
    const rig = new TestRig();
    await rig.setup('should not declare todo_write by default');

    const requests = await runForcedTodoCall(rig);
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
    const baseSystemPrompt = String(systemMessage?.content).split(
      '\n\n---\n\n',
      1,
    )[0];
    const toolDescriptionsWithTodo = tools
      .filter((tool) => JSON.stringify(tool).includes('todo_write'))
      .map((tool) => tool.function?.name);

    expect(tools.map((tool) => tool.function?.name)).not.toContain(
      'todo_write',
    );
    expect(baseSystemPrompt).not.toContain('todo_write');
    expect(toolDescriptionsWithTodo).toEqual([]);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(requests[1])).toContain('disabled by default');
    expect(JSON.stringify(requests[1])).toContain('tools.todoWrite.enabled');
  });

  it('should declare and execute todo_write when enabled', async () => {
    const rig = new TestRig();
    await rig.setup('should declare and execute todo_write when enabled', {
      settings: { tools: { todoWrite: { enabled: true } } },
    });

    const requests = await runForcedTodoCall(rig);
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
    const baseSystemPrompt = String(systemMessage?.content).split(
      '\n\n---\n\n',
      1,
    )[0];
    const toolResultRequest = JSON.stringify(requests[1]);

    expect(tools.map((tool) => tool.function?.name)).toContain('todo_write');
    expect(baseSystemPrompt).toContain('# Task Management');
    expect(toolResultRequest).toContain('Verify Todo');
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
