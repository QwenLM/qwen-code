/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlanEmitter } from './PlanEmitter.js';
import type { SessionContext, TodoItem } from '../types.js';
import type { Config } from '@qwen-code/qwen-code-core';

describe('PlanEmitter', () => {
  let mockContext: SessionContext;
  let sendUpdateSpy: ReturnType<typeof vi.fn>;
  let emitter: PlanEmitter;

  beforeEach(() => {
    sendUpdateSpy = vi.fn().mockResolvedValue(undefined);
    mockContext = {
      sessionId: 'test-session-id',
      config: {} as Config,
      sendUpdate: sendUpdateSpy,
    };
    emitter = new PlanEmitter(mockContext);
  });

  describe('emitPlan', () => {
    it('should send plan update with converted todo entries', async () => {
      const todos: TodoItem[] = [
        { id: '1', content: 'First task', status: 'pending' },
        { id: '2', content: 'Second task', status: 'in_progress' },
        { id: '3', content: 'Third task', status: 'completed' },
      ];

      await emitter.emitPlan(todos);

      expect(sendUpdateSpy).toHaveBeenCalledTimes(1);
      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'plan',
        entries: [
          { content: 'First task', priority: 'medium', status: 'pending' },
          { content: 'Second task', priority: 'medium', status: 'in_progress' },
          { content: 'Third task', priority: 'medium', status: 'completed' },
        ],
      });
    });

    it('should handle empty todos array', async () => {
      await emitter.emitPlan([]);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'plan',
        entries: [],
      });
    });

    it('should set default priority to medium for all entries', async () => {
      const todos: TodoItem[] = [
        { id: '1', content: 'Task', status: 'pending' },
      ];

      await emitter.emitPlan(todos);

      const call = sendUpdateSpy.mock.calls[0][0];
      expect(call.entries[0].priority).toBe('medium');
    });
  });

  describe('extractTodos', () => {
    describe('from resultDisplay object', () => {
      it('should extract todos from valid todo_list object', () => {
        const resultDisplay = {
          type: 'todo_list',
          todos: [
            { id: '1', content: 'Task 1', status: 'pending' as const },
            { id: '2', content: 'Task 2', status: 'completed' as const },
          ],
        };

        const result = emitter.extractTodos(resultDisplay);

        expect(result).toEqual([
          { id: '1', content: 'Task 1', status: 'pending' },
          { id: '2', content: 'Task 2', status: 'completed' },
        ]);
      });

      it('should return null for object without type todo_list', () => {
        const resultDisplay = {
          type: 'other',
          todos: [],
        };

        const result = emitter.extractTodos(resultDisplay);

        expect(result).toBeNull();
      });

      it('should return null for object without todos array', () => {
        const resultDisplay = {
          type: 'todo_list',
          items: [], // wrong key
        };

        const result = emitter.extractTodos(resultDisplay);

        expect(result).toBeNull();
      });
    });

    describe('from resultDisplay JSON string', () => {
      it('should extract todos from valid JSON string', () => {
        const resultDisplay = JSON.stringify({
          type: 'todo_list',
          todos: [{ id: '1', content: 'Task', status: 'pending' }],
        });

        const result = emitter.extractTodos(resultDisplay);

        expect(result).toEqual([
          { id: '1', content: 'Task', status: 'pending' },
        ]);
      });

      it('should return null for invalid JSON string', () => {
        const resultDisplay = 'not valid json';

        const result = emitter.extractTodos(resultDisplay);

        expect(result).toBeNull();
      });

      it('should return null for JSON without todo_list type', () => {
        const resultDisplay = JSON.stringify({
          type: 'other',
          data: {},
        });

        const result = emitter.extractTodos(resultDisplay);

        expect(result).toBeNull();
      });
    });

    describe('from args fallback', () => {
      it('should extract todos from args when resultDisplay is null', () => {
        const args = {
          todos: [{ id: '1', content: 'From args', status: 'pending' }],
        };

        const result = emitter.extractTodos(null, args);

        expect(result).toEqual([
          { id: '1', content: 'From args', status: 'pending' },
        ]);
      });

      it('should extract todos from args when resultDisplay is undefined', () => {
        const args = {
          todos: [{ id: '1', content: 'From args', status: 'pending' }],
        };

        const result = emitter.extractTodos(undefined, args);

        expect(result).toEqual([
          { id: '1', content: 'From args', status: 'pending' },
        ]);
      });

      it('should prefer resultDisplay over args', () => {
        const resultDisplay = {
          type: 'todo_list',
          todos: [{ id: '1', content: 'From display', status: 'completed' }],
        };
        const args = {
          todos: [{ id: '2', content: 'From args', status: 'pending' }],
        };

        const result = emitter.extractTodos(resultDisplay, args);

        expect(result).toEqual([
          { id: '1', content: 'From display', status: 'completed' },
        ]);
      });

      it('should return null when args has no todos array', () => {
        const args = { other: 'value' };

        const result = emitter.extractTodos(null, args);

        expect(result).toBeNull();
      });

      it('should return null when args.todos is not an array', () => {
        const args = { todos: 'not an array' };

        const result = emitter.extractTodos(null, args);

        expect(result).toBeNull();
      });
    });

    describe('edge cases', () => {
      it('should return null when both resultDisplay and args are undefined', () => {
        const result = emitter.extractTodos(undefined, undefined);

        expect(result).toBeNull();
      });

      it('should return null when resultDisplay is empty object', () => {
        const result = emitter.extractTodos({});

        expect(result).toBeNull();
      });

      it('should handle resultDisplay with todos but wrong type', () => {
        const resultDisplay = {
          type: 'not_todo_list',
          todos: [{ id: '1', content: 'Task', status: 'pending' }],
        };

        const result = emitter.extractTodos(resultDisplay);

        expect(result).toBeNull();
      });
    });
  });
});
