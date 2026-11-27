/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import {
  TurnHooks,
  type TurnRunStartHandler,
  type TurnRunStartInput,
  type TurnRunStartResult,
  type TurnHookModule,
  type TurnHookRegistrar,
  type TurnRunEndInput,
} from './turn-hooks.js';

const signal = new AbortController().signal;
const ready: TurnRunStartInput = {
  turnId: 'turn',
  taskId: 'task',
  promptText: 'accepted prompt',
  isSubagent: false,
  isWorkflow: false,
  isRemoteWorker: false,
  trigger: 'user_prompt',
};
const terminal: TurnRunEndInput = {
  turnId: 'turn',
  taskId: 'task',
  promptId: 'prompt',
  model: 'final-model',
  requestIndex: 3,
  terminal: {
    reason: 'end_turn',
    numTurns: 1,
    durationMs: 10,
    usage: cloneUsage(),
  },
  statistics: {
    totalCredits: 4,
    totalOriginalCredits: 6,
  },
};
const moduleFor = (
  id: string,
  handler: TurnRunStartHandler,
): TurnHookModule => ({
  id,
  register: (on) => on('turn.run.start', handler),
});
const hooksFor = (...modules: TurnHookModule[]) =>
  new TurnHooks(modules, { sessionId: 'session' });

describe('Synchronous lifecycle hooks', () => {
  it('runs in registration order and adopts the outer result without yielding', () => {
    const order: string[] = [];
    const hooks = hooksFor(
      ...['outer', 'inner'].map((id) =>
        moduleFor(id, (context, input, next) => {
          expect(context.sessionId).toBe('session');
          expect(input).toEqual(ready);
          expect(next.signal).toBe(signal);
          order.push(`${id}:before`);
          const result = next();
          order.push(`${id}:after`);
          return { trigger: id === 'outer' ? 'scheduled' : result.trigger };
        }),
      ),
    );
    expect(hooks.runStart(ready, signal)).toEqual({
      trigger: 'scheduled',
    });
    expect(order).toEqual([
      'outer:before',
      'inner:before',
      'inner:after',
      'outer:after',
    ]);
  });

  it.each([
    [{}, 'unknown'],
    [{ trigger: 'continuation' as const }, 'continuation'],
    [{ isWorkflow: true, trigger: 'scheduled' as const }, 'workflow'],
    [{ isSubagent: true, isWorkflow: true }, 'subagent'],
  ])(
    'preserves source defaults without product modules (%j)',
    (input, trigger) => {
      expect(
        hooksFor().runStart({ ...ready, trigger: undefined, ...input }, signal),
      ).toEqual({ trigger });
    },
  );

  it.each([false, true])(
    'propagates failures without retry after next=%s',
    (afterNext) => {
      const downstream = vi.fn((_context, _input, next) => next());
      const failure = new Error('claim or manager failed');
      const handler = vi.fn((_context, _input, next) => {
        if (afterNext) next();
        throw failure;
      });
      const hooks = hooksFor(
        moduleFor('failing', handler),
        moduleFor('following', downstream),
      );
      expect(() => hooks.runStart(ready, signal)).toThrow(failure);
      expect(handler).toHaveBeenCalledOnce();
      expect(downstream).toHaveBeenCalledTimes(afterNext ? 1 : 0);
    },
  );

  it('does not allow a wrapper to hide a downstream failure', () => {
    const failure = new Error('downstream');
    const hooks = hooksFor(
      moduleFor('wrapper', (_context, _input, next) => {
        try {
          return next();
        } catch {
          return { trigger: 'unknown' };
        }
      }),
      moduleFor('failing', () => {
        throw failure;
      }),
    );
    expect(() => hooks.runStart(ready, signal)).toThrow(failure);
  });

  it('rejects skipped, duplicate and late next without replaying effects', () => {
    expect(() =>
      hooksFor(moduleFor('skip', () => ({ trigger: 'unknown' }))).runStart(
        ready,
        signal,
      ),
    ).toThrow('must call next once');
    const effect = vi.fn();
    const hooks = hooksFor(
      moduleFor('twice', (_context, _input, next) => {
        next();
        return next();
      }),
      moduleFor('effect', (_context, _input, next) => {
        effect();
        return next();
      }),
    );
    expect(() => hooks.runStart(ready, signal)).toThrow(
      'next may only be called once',
    );
    expect(effect).toHaveBeenCalledOnce();
    let saved!: () => TurnRunStartResult;
    hooksFor(
      moduleFor('late', (_context, _input, next) => {
        saved = next;
        return next();
      }),
    ).runStart(ready, signal);
    expect(saved).toThrow('next called after handler returned');
  });

  it('rejects asynchronous handlers and prevents deferred next from running effects', async () => {
    const effect = vi.fn();
    const asyncHandler = async (
      _context: unknown,
      _input: unknown,
      next: () => TurnRunStartResult,
    ) => {
      await Promise.resolve();
      return next();
    };
    const hooks = hooksFor(
      moduleFor('async', asyncHandler as unknown as TurnRunStartHandler),
      moduleFor('effect', (_context, _input, next) => {
        effect();
        return next();
      }),
    );
    expect(() => hooks.runStart(ready, signal)).toThrow('must be synchronous');
    await Promise.resolve();
    await Promise.resolve();
    expect(effect).not.toHaveBeenCalled();
  });

  it('rejects invalid source results', () => {
    const hooks = hooksFor(
      moduleFor('invalid', (_context, _input, next) => {
        next();
        return { trigger: 'invalid' } as unknown as TurnRunStartResult;
      }),
    );
    expect(() => hooks.runStart(ready, signal)).toThrow(
      'invalid turn.run.start result',
    );
  });

  it('delivers detached frozen terminal and statistics facts to every handler', () => {
    const seen: TurnRunEndInput[] = [];
    const hooks = hooksFor(
      ...['first', 'second'].map((id) => ({
        id,
        register(on: TurnHookRegistrar) {
          on('turn.run.end', (_context, input, next) => {
            seen.push(input);
            expect(Object.isFrozen(input.statistics)).toBe(true);
            expect(Object.isFrozen(input.terminal.usage.cache_creation)).toBe(
              true,
            );
            expect(() => {
              input.terminal.usage.input_tokens = 999;
            }).toThrow();
            return next();
          });
        },
      })),
    );
    hooks.runEnd(terminal, signal);
    expect(seen).toEqual([terminal, terminal]);
    expect(seen[0]).not.toBe(terminal);
    expect(seen[0]).toBe(seen[1]);
    expect(Object.isFrozen(terminal.terminal.usage)).toBe(false);
  });

  it('reports an error snapshot even when its original cause cannot be cloned', () => {
    const cause = () => undefined;
    const error = new Error('transport failed', { cause });
    const reported = vi.fn();
    const hooks = hooksFor({
      id: 'error-observer',
      register(on) {
        on('turn.run.end', (_context, input, next) => {
          reported(input.terminal.error);
          return next();
        });
      },
    });
    expect(() =>
      hooks.runEnd(
        {
          ...terminal,
          terminal: { ...terminal.terminal, reason: 'error', error },
        },
        signal,
      ),
    ).not.toThrow();
    expect(reported).toHaveBeenCalledExactlyOnceWith({
      name: 'Error',
      message: 'transport failed',
      stack: error.stack,
    });
    expect(error.cause).toBe(cause);
    expect(Object.isFrozen(error)).toBe(false);
  });

  it('runs reached model and terminal boundaries synchronously after cancellation', () => {
    const controller = new AbortController();
    controller.abort();
    const order: string[] = [];
    const hooks = hooksFor({
      id: 'effects',
      register(on) {
        on('turn.step.result', (_context, input, next) => {
          expect(input.outcome).toBe('interrupted');
          expect(next.signal.aborted).toBe(true);
          order.push('clock');
          return next();
        });
        on('turn.run.end', (_context, _input, next) => {
          order.push('budget');
          return next();
        });
      },
    });
    hooks.stepResult(
      { turnId: 'turn', index: 0, model: 'model', outcome: 'interrupted' },
      controller.signal,
    );
    hooks.runEnd(terminal, controller.signal);
    expect(order).toEqual(['clock', 'budget']);
  });

  it('uses the existing registration guards for synchronous phases', () => {
    expect(() =>
      hooksFor({
        id: 'duplicate',
        register(on) {
          on('turn.step.result', (_context, _input, next) => next());
          on('turn.step.result', (_context, _input, next) => next());
        },
      }),
    ).toThrow('duplicate turn.step.result registration');
    let saved!: TurnHookRegistrar;
    hooksFor({
      id: 'late',
      register(on) {
        saved = on;
      },
    });
    expect(() =>
      saved('turn.run.end', (_context, _input, next) => next()),
    ).toThrow('only register during module registration');
  });
});
