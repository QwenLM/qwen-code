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

    const prompt = `I want to implement a new feature to track user preferences. Here are the tasks:
1. Create a user preferences model
2. Add API endpoints for preferences
3. Implement frontend components
4. Write tests for the new functionality

Please create a todo list for these tasks.`;

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
    expect(todoArgs.todos.length).toBe(4);

    // Check that all todos have the correct structure
    for (const todo of todoArgs.todos) {
      expect(todo.id).toBeDefined();
      expect(todo.content).toBeDefined();
      expect(['pending', 'in_progress', 'completed']).toContain(todo.status);
    }

    // Log success info if verbose
    if (process.env.VERBOSE === 'true') {
      console.log('Todo list created successfully');
    }
  });

  it('should be able to update todo status', async () => {
    const rig = new TestRig();
    await rig.setup('should be able to update todo status');

    // First create a todo list
    const initialPrompt = `Create a todo list with these tasks:
1. Set up project structure
2. Implement authentication
3. Add database migrations`;

    await rig.run(initialPrompt);
    await rig.waitForToolCall('todo_write');

    // Now update the todo list by marking one as in progress
    const updatePrompt = `I've started working on implementing authentication. Please update the todo list to reflect that.`;

    const result = await rig.run(updatePrompt);

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
    validateModelOutput(result, null, 'Todo update test');

    // Check that the tool was called with updated parameters
    const toolLogs = rig.readToolLogs();
    const todoWriteCalls = toolLogs.filter(
      (t) => t.toolRequest.name === 'todo_write',
    );

    expect(todoWriteCalls.length).toBeGreaterThan(0);

    // Parse the arguments to verify the update
    const todoArgs = JSON.parse(
      todoWriteCalls[todoWriteCalls.length - 1].toolRequest.args,
    );

    expect(todoArgs.todos).toBeDefined();
    expect(Array.isArray(todoArgs.todos)).toBe(true);
    // The model might create a new list with just the task it's working on
    // or it might update the existing list. Let's check that we have at least one todo
    expect(todoArgs.todos.length).toBeGreaterThanOrEqual(1);

    // Check that all todos have the correct structure
    for (const todo of todoArgs.todos) {
      expect(todo.id).toBeDefined();
      expect(todo.content).toBeDefined();
      expect(['pending', 'in_progress', 'completed']).toContain(todo.status);
    }

    // Log success info if verbose
    if (process.env.VERBOSE === 'true') {
      console.log('Todo list updated successfully');
    }
  });
});
