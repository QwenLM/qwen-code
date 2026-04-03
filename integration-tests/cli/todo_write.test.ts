/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  TestRig,
  printDebugInfo,
  validateModelOutput,
} from '../test-helper.js';

describe('todo_write', () => {
  it('should be able to create and manage a todo list', async () => {
    const rig = new TestRig();
    await rig.setup('should be able to create and manage a todo list');

    const prompt = `Please create a todo list with these three simple tasks:
1. Buy milk
2. Walk the dog
3. Read a book

Use the task_create tool to create each task.`;

    const result = await rig.run(prompt);

    // todo_write was replaced by task_create; wait for any of the task creation calls
    const foundToolCall = await rig.waitForAnyToolCall([
      'task_create',
      'todo_write',
    ]);

    // Add debugging information
    if (!foundToolCall) {
      printDebugInfo(rig, result);
    }

    expect(
      foundToolCall,
      'Expected to find a task_create tool call',
    ).toBeTruthy();

    // Validate model output - will throw if no output
    validateModelOutput(result, null, 'Todo write test');

    // Check that the tool was called with the right parameters
    const toolLogs = rig.readToolLogs();
    const taskCreateCalls = toolLogs.filter(
      (t) =>
        t.toolRequest.name === 'task_create' ||
        t.toolRequest.name === 'todo_write',
    );

    expect(taskCreateCalls.length).toBeGreaterThan(0);

    // Parse the arguments to verify they contain our tasks
    const taskArgs = JSON.parse(taskCreateCalls[0].toolRequest.args);

    // task_create uses { title, description?, priority? }
    expect(taskArgs.title).toBeDefined();

    // Log success info if verbose
    if (process.env['VERBOSE'] === 'true') {
      console.log('Todo list created successfully');
      console.log(`Created ${taskCreateCalls.length} task(s)`);
    }
  });
});
