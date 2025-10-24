/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { TestRig, printDebugInfo, validateModelOutput } from './test-helper.js';

describe('todo_write', () => {
  it('should be able to create and manage a todo list', async () => {
    const rig = new TestRig();
    await rig.setup('should be able to create and manage a todo list');

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
    const todoArgs = JSON.parse(todoWriteCalls[0].toolRequest.args);

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
