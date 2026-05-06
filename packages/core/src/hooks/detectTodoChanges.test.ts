/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { detectTodoChanges } from './types.js';
import type { TodoItem } from './types.js';

describe('detectTodoChanges', () => {
  describe('empty inputs', () => {
    it('should return empty changes when both lists are empty', () => {
      const result = detectTodoChanges([], []);
      expect(result).toEqual({
        created: [],
        completed: [],
      });
    });

    it('should mark all todos as created when oldTodos is empty', () => {
      const newTodos: TodoItem[] = [
        { id: '1', content: 'Task 1', status: 'pending' },
        { id: '2', content: 'Task 2', status: 'in_progress' },
      ];
      const result = detectTodoChanges([], newTodos);
      expect(result.created).toEqual(newTodos);
      expect(result.completed).toHaveLength(0);
    });

    it('should return empty changes when newTodos is empty', () => {
      const oldTodos: TodoItem[] = [
        { id: '1', content: 'Task 1', status: 'pending' },
      ];
      const result = detectTodoChanges(oldTodos, []);
      expect(result).toEqual({
        created: [],
        completed: [],
      });
    });
  });

  describe('todo creation', () => {
    it('should detect newly created todos', () => {
      const oldTodos: TodoItem[] = [
        { id: '1', content: 'Existing Task', status: 'pending' },
      ];
      const newTodos: TodoItem[] = [
        { id: '1', content: 'Existing Task', status: 'pending' },
        { id: '2', content: 'New Task', status: 'pending' },
      ];
      const result = detectTodoChanges(oldTodos, newTodos);
      expect(result.created).toEqual([
        { id: '2', content: 'New Task', status: 'pending' },
      ]);
      expect(result.completed).toHaveLength(0);
    });

    it('should detect multiple newly created todos', () => {
      const oldTodos: TodoItem[] = [
        { id: '1', content: 'A', status: 'pending' },
      ];
      const newTodos: TodoItem[] = [
        { id: '1', content: 'A', status: 'pending' },
        { id: '2', content: 'B', status: 'pending' },
        { id: '3', content: 'C', status: 'in_progress' },
      ];
      const result = detectTodoChanges(oldTodos, newTodos);
      expect(result.created).toHaveLength(2);
      expect(result.created).toContainEqual({
        id: '2',
        content: 'B',
        status: 'pending',
      });
      expect(result.created).toContainEqual({
        id: '3',
        content: 'C',
        status: 'in_progress',
      });
    });
  });

  describe('todo completion', () => {
    it('should detect todo completion from pending to completed', () => {
      const oldTodos: TodoItem[] = [
        { id: '1', content: 'Task', status: 'pending' },
      ];
      const newTodos: TodoItem[] = [
        { id: '1', content: 'Task', status: 'completed' },
      ];
      const result = detectTodoChanges(oldTodos, newTodos);
      expect(result.completed).toEqual([
        { id: '1', content: 'Task', status: 'completed' },
      ]);
      expect(result.created).toHaveLength(0);
    });

    it('should detect todo completion from in_progress to completed', () => {
      const oldTodos: TodoItem[] = [
        { id: '1', content: 'Task', status: 'in_progress' },
      ];
      const newTodos: TodoItem[] = [
        { id: '1', content: 'Task', status: 'completed' },
      ];
      const result = detectTodoChanges(oldTodos, newTodos);
      expect(result.completed).toHaveLength(1);
    });

    it('should NOT detect completion when todo was already completed', () => {
      const oldTodos: TodoItem[] = [
        { id: '1', content: 'Task', status: 'completed' },
      ];
      const newTodos: TodoItem[] = [
        { id: '1', content: 'Task', status: 'completed' },
      ];
      const result = detectTodoChanges(oldTodos, newTodos);
      expect(result.completed).toHaveLength(0);
    });
  });

  describe('non-hooked changes', () => {
    it('should ignore status change from pending to in_progress', () => {
      const oldTodos: TodoItem[] = [
        { id: '1', content: 'Task', status: 'pending' },
      ];
      const newTodos: TodoItem[] = [
        { id: '1', content: 'Task', status: 'in_progress' },
      ];
      const result = detectTodoChanges(oldTodos, newTodos);
      expect(result).toEqual({
        created: [],
        completed: [],
      });
    });

    it('should ignore status change from completed back to pending', () => {
      const oldTodos: TodoItem[] = [
        { id: '1', content: 'Task', status: 'completed' },
      ];
      const newTodos: TodoItem[] = [
        { id: '1', content: 'Task', status: 'pending' },
      ];
      const result = detectTodoChanges(oldTodos, newTodos);
      expect(result).toEqual({
        created: [],
        completed: [],
      });
    });

    it('should handle content change without status change', () => {
      const oldTodos: TodoItem[] = [
        { id: '1', content: 'Old content', status: 'pending' },
      ];
      const newTodos: TodoItem[] = [
        { id: '1', content: 'New content', status: 'pending' },
      ];
      const result = detectTodoChanges(oldTodos, newTodos);
      expect(result).toEqual({
        created: [],
        completed: [],
      });
    });
  });

  describe('mixed changes', () => {
    it('should detect created and completed changes simultaneously', () => {
      const oldTodos: TodoItem[] = [
        { id: '1', content: 'Existing pending', status: 'pending' },
        { id: '2', content: 'Existing in_progress', status: 'in_progress' },
        { id: '3', content: 'Existing completed', status: 'completed' },
      ];
      const newTodos: TodoItem[] = [
        { id: '1', content: 'Existing pending', status: 'completed' },
        { id: '2', content: 'Existing in_progress', status: 'pending' },
        { id: '4', content: 'New task', status: 'pending' },
      ];
      const result = detectTodoChanges(oldTodos, newTodos);

      expect(result.created).toHaveLength(1);
      expect(result.completed).toHaveLength(1);
      expect(result.created).toContainEqual({
        id: '4',
        content: 'New task',
        status: 'pending',
      });
      expect(result.completed).toContainEqual({
        id: '1',
        content: 'Existing pending',
        status: 'completed',
      });
    });
  });
});
