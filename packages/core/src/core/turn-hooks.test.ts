/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelRequestRunnerEvent } from '../model-request/types.js';

import { cloneUsage } from '../protocol/provider/empty-usage.js';
import { sessionLogger } from '../utils/sessionLogger.js';
import {
  TurnHooks,
  type TurnHookModule,
  type TurnHookRegistrar,
  type TurnStepInput,
  type TurnStepResult,
  type TurnStepStream,
} from './turn-hooks.js';
import { TaskRunStatsAccumulator } from './task-run-stats.js';

const signal = new AbortController().signal;
const input: TurnStepInput = {
  turnId: 'turn',
  index: 0,
  model: 'model',
  messageCount: 2,
};
const summary: TurnStepResult = {
  turnId: 'turn',
  index: 0,
  answer: 'answer',
  toolUses: [],
  stopReason: 'end_turn',
  usage: null,
};
const events: ModelRequestRunnerEvent[] = [
  {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'first' },
    },
  },
  {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'second' },
    },
  },
];

async function drain(stream: TurnStepStream) {
  const values: ModelRequestRunnerEvent[] = [];
  for (;;) {
    const item = await stream.next();
    if (item.done) return { values, result: item.value };
    values.push(item.value);
  }
}

describe('TurnHooks', () => {
  afterEach(() => vi.restoreAllMocks());

  it('composes ordinary handlers in registration order and unwinds their results', async () => {
    const order: string[] = [];
    const modules: TurnHookModule[] = ['outer', 'inner'].map((id) => ({
      id,
      register(on) {
        on('turn.start', async ($, e, next) => {
          expect($.sessionId).toBe('session');
          expect(next.signal).toBe(signal);
          order.push(`${id}:before`);
          const result = await next({ ...e, text: `${e.text}:${id}` });
          order.push(`${id}:after`);
          return result;
        });
        on('turn.complete', async (_$, e, next) => {
          const result = await next(e);
          return { ...result, text: `${result.text}:${id}` };
        });
      },
    }));
    const hooks = new TurnHooks(modules, { sessionId: 'session' });
    expect(
      await hooks.start({ text: 'prompt', turnId: 'turn' }, signal),
    ).toEqual({ turnId: 'turn' });
    expect(order).toEqual([
      'outer:before',
      'inner:before',
      'inner:after',
      'outer:after',
    ]);
    expect(
      await hooks.complete({
        turnId: 'turn',
        answer: 'answer',
        reason: 'answer',
        durationMs: 1,
        isAborted: false,
      }),
    ).toEqual({ text: 'answer:inner:outer' });
  });

  it('recovers an ordinary handler failure using its already completed downstream result', async () => {
    const completed = vi.fn();
    const hooks = new TurnHooks(
      [
        {
          id: 'outer',
          register(on) {
            on('turn.complete', async (_$, e, next) => {
              await next(e);
              throw new Error('observer failed');
            });
          },
        },
        {
          id: 'inner',
          register(on) {
            on('turn.complete', (_$, e, next) => {
              completed();
              return next(e);
            });
          },
        },
      ],
      { sessionId: 'session' },
    );
    expect(
      await hooks.complete({
        turnId: 'turn',
        answer: 'answer',
        reason: 'aborted',
        durationMs: 1,
        isAborted: true,
      }),
    ).toEqual({ text: 'answer' });
    expect(completed).toHaveBeenCalledOnce();
  });

  it('composes step handlers in order and exposes summary changes only to outer handlers', async () => {
    const order: string[] = [];
    const core = vi.fn(async function* () {
      order.push('model');
      yield* events;
      return summary;
    });
    const hooks = new TurnHooks(
      ['outer', 'inner'].map((id) => ({
        id,
        register(on) {
          on('turn.step', async function* (_$, e, next) {
            order.push(`${id}:before`);
            const result = yield* next(e);
            order.push(`${id}:${result.answer}`);
            return { ...result, answer: `${result.answer}:${id}` };
          });
        },
      })),
      { sessionId: 'session' },
    );
    expect(await drain(hooks.step(input, core, signal))).toEqual({
      values: events,
      result: { ...summary, answer: 'answer:inner:outer' },
    });
    expect(order).toEqual([
      'outer:before',
      'inner:before',
      'model',
      'inner:answer',
      'outer:answer:inner',
    ]);
    expect(summary.answer).toBe('answer');
    expect(core).toHaveBeenCalledOnce();
  });

  it('attributes interleaved failures to their module, session, turn, agent and step', async () => {
    const log = vi.spyOn(sessionLogger, 'event').mockImplementation(() => {});
    const failure = new Error('observer failed');
    function stream(
      sessionId: string,
      turnId: string,
      index: number,
      agentId?: string,
    ) {
      const hooks = new TurnHooks(
        [
          {
            id: 'observer',
            register(on) {
              // eslint-disable-next-line require-yield -- The observer fails before forwarding its first event.
              on('turn.step', async function* (_$, e, next) {
                const downstream = next(e);
                await downstream.next();
                throw failure;
              });
            },
          },
        ],
        { sessionId },
      );
      return hooks.step(
        { ...input, turnId, index, agentId },
        async function* (e) {
          yield* events;
          return { ...summary, turnId: e.turnId, index: e.index };
        },
        signal,
      );
    }
    const first = stream('first-session', 'parent-turn', 0);
    const second = stream('second-session', 'child-turn', 2, 'child');
    expect(await Promise.all([drain(first), drain(second)])).toEqual([
      { values: events, result: { ...summary, turnId: 'parent-turn' } },
      {
        values: events,
        result: { ...summary, turnId: 'child-turn', index: 2 },
      },
    ]);
    expect(log).toHaveBeenCalledTimes(2);
    for (const [sessionId, turnId, stepIndex, agentId] of [
      ['first-session', 'parent-turn', 0, undefined],
      ['second-session', 'child-turn', 2, 'child'],
    ]) {
      expect(log).toHaveBeenCalledWith({
        level: 'warn',
        kind: 'hook',
        type: 'hook.module_failed',
        ids: { session_id: sessionId, turn_id: turnId },
        data: {
          module_id: 'observer',
          stage: 'turn.step',
          step_index: stepIndex,
          agent_id: agentId,
          error: failure.stack,
        },
      });
    }
  });

  it.each(['turn.start', 'turn.complete'] as const)(
    'records a scoped %s failure and continues the chain',
    async (stage) => {
      const log = vi.spyOn(sessionLogger, 'event').mockImplementation(() => {});
      const hooks = new TurnHooks(
        [
          {
            id: 'observer',
            register(on) {
              if (stage === 'turn.start') {
                on(stage, () => {
                  throw new Error('start failed');
                });
              } else {
                on(stage, () => {
                  throw new Error('complete failed');
                });
              }
            },
          },
        ],
        { sessionId: 'session' },
      );
      if (stage === 'turn.start') {
        expect(
          await hooks.start({ text: 'prompt', turnId: 'turn' }, signal),
        ).toEqual({ turnId: 'turn' });
      } else {
        expect(
          await hooks.complete({
            turnId: 'turn',
            agentId: 'child',
            answer: 'answer',
            durationMs: 1,
            reason: 'answer',
            isAborted: false,
          }),
        ).toEqual({ text: 'answer' });
      }
      expect(log).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          type: 'hook.module_failed',
          ids: { session_id: 'session', turn_id: 'turn' },
          data: expect.objectContaining({ module_id: 'observer', stage }),
        }),
      );
    },
  );

  it('preserves start identity when a handler returns another turn id', async () => {
    const hooks = new TurnHooks(
      [
        {
          id: 'identity',
          register(on) {
            on('turn.start', async (_$, e, next) => {
              await next(e);
              return { turnId: 'other' };
            });
          },
        },
      ],
      { sessionId: 'session' },
    );
    expect(
      await hooks.start({ turnId: 'turn', text: 'prompt' }, signal),
    ).toEqual({ turnId: 'turn' });
  });

  it.each([
    'before',
    'after-pull',
    'after-prefetch',
    'during',
    'after',
    'invalid',
  ] as const)(
    'preserves stream progress when a hook fails %s downstream execution',
    async (when) => {
      const core = vi.fn(async function* () {
        yield* events;
        return summary;
      });
      const hooks = new TurnHooks(
        [
          {
            id: 'failing',
            register(on) {
              on('turn.step', async function* (_$, e, next) {
                if (when === 'before') throw new Error('before');
                const downstream = next(e);
                if (when === 'after-pull' || when === 'after-prefetch') {
                  await downstream.next();
                  if (when === 'after-prefetch') await downstream.next();
                  throw new Error(when);
                }
                if (when === 'during') {
                  const first = await downstream.next();
                  if (!first.done) yield first.value;
                  throw new Error('during');
                }
                const result = yield* downstream;
                if (when === 'after') throw new Error('after');
                return { ...result, turnId: 'invalid' };
              });
            },
          },
        ],
        { sessionId: 'session' },
      );
      expect(await drain(hooks.step(input, core, signal))).toEqual({
        values: events,
        result: summary,
      });
      expect(core).toHaveBeenCalledOnce();
    },
  );

  it.each(['events', 'result', 'error'] as const)(
    'takes over an in-flight read returning %s after a handler fails',
    async (outcome) => {
      const failure = new Error('native request failed');
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      const log = vi
        .spyOn(sessionLogger, 'event')
        .mockImplementation(() => release());
      const core = vi.fn(async function* () {
        await ready;
        if (outcome === 'error') throw failure;
        if (outcome === 'events') yield* events;
        return summary;
      });
      const completed = vi.fn();
      const pending: Array<Promise<unknown>> = [];
      const hooks = new TurnHooks(
        [
          {
            id: 'prefetch',
            register(on) {
              // eslint-disable-next-line require-yield -- Fail while the downstream read is still pending.
              on('turn.step', async function* (_$, e, next) {
                const stream = next(e);
                // Queue another read to verify that the failed reader is retired.
                pending.push(stream.next(), stream.next());
                for (const read of pending) void read.catch(() => {});
                throw new Error('observer failed during a pull');
              });
            },
          },
          {
            id: 'completion',
            register(on) {
              on('turn.step', async function* (_$, e, next) {
                const result = yield* next(e);
                completed();
                return result;
              });
            },
          },
        ],
        { sessionId: 'session' },
      );
      const result = drain(hooks.step(input, core, signal));
      if (outcome === 'error') {
        await expect(result).rejects.toBe(failure);
        expect(completed).not.toHaveBeenCalled();
      } else {
        expect(await result).toEqual({
          values: outcome === 'events' ? events : [],
          result: summary,
        });
        expect(completed).toHaveBeenCalledOnce();
      }
      await Promise.allSettled(pending);
      expect(core).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledOnce();
    },
  );

  it('preserves a native error caught by a handler that returns a valid summary', async () => {
    const log = vi.spyOn(sessionLogger, 'event').mockImplementation(() => {});
    const failure = new Error('native request failed');
    const closed = vi.fn();
    const core = vi.fn(async function* () {
      try {
        yield events[0];
        throw failure;
      } finally {
        closed();
      }
    });
    const hooks = new TurnHooks(
      [
        {
          id: 'catch-error',
          register(on) {
            on('turn.step', async function* (_$, e, next) {
              try {
                return yield* next(e);
              } catch {
                return summary;
              }
            });
          },
        },
      ],
      { sessionId: 'session' },
    );
    await expect(drain(hooks.step(input, core, signal))).rejects.toBe(failure);
    expect(core).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
  });

  it('propagates consumer throw and closes all handlers without pulling more events', async () => {
    const log = vi.spyOn(sessionLogger, 'event').mockImplementation(() => {});
    const closed: string[] = [];
    const resumed = vi.fn();
    const hooks = new TurnHooks(
      ['outer', 'inner'].map(
        (id): TurnHookModule => ({
          id,
          register(on) {
            on('turn.step', async function* (_$, e, next) {
              try {
                return yield* next(e);
              } finally {
                closed.push(id);
              }
            });
          },
        }),
      ),
      { sessionId: 'session' },
    );
    const stream = hooks.step(
      input,
      async function* () {
        try {
          yield events[0];
          resumed();
          yield events[1];
          return summary;
        } finally {
          closed.push('model');
        }
      },
      signal,
    );
    expect((await stream.next()).value).toBe(events[0]);
    const failure = new Error('consumer failed');
    await expect(stream.throw(failure)).rejects.toBe(failure);
    expect(resumed).not.toHaveBeenCalled();
    expect(closed).toEqual(['outer', 'inner', 'model']);
    expect((await stream.next()).done).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it('propagates a downstream failure without invoking the model again', async () => {
    const log = vi.spyOn(sessionLogger, 'event').mockImplementation(() => {});
    const failure = new Error('model failed');
    let closed = 0;
    const core = vi.fn(async function* () {
      try {
        yield events[0];
        throw failure;
      } finally {
        closed++;
      }
    });
    const hooks = new TurnHooks(
      [
        {
          id: 'observer',
          register(on) {
            on('turn.step', async function* (_$, e, next) {
              return yield* next(e);
            });
          },
        },
      ],
      { sessionId: 'session' },
    );
    await expect(drain(hooks.step(input, core, signal))).rejects.toBe(failure);
    expect(core).toHaveBeenCalledOnce();
    expect(closed).toBe(1);
    expect(log).not.toHaveBeenCalled();
  });

  it.each(['before-consumption', 'during', 'after'] as const)(
    'does not execute downstream twice when next is repeated %s',
    async (when) => {
      const core = vi.fn(async function* () {
        yield* events;
        return summary;
      });
      const observed = vi.fn();
      const hooks = new TurnHooks(
        [
          {
            id: 'repeat',
            register(on) {
              on('turn.step', async function* (_$, e, next) {
                const stream = next(e);
                if (when === 'during') {
                  const item = await stream.next();
                  if (!item.done) yield item.value;
                } else if (when === 'after') {
                  yield* stream;
                }
                return yield* next(e);
              });
            },
          },
          {
            id: 'observer',
            register(on) {
              on('turn.step', async function* (_$, e, next) {
                const result = yield* next(e);
                observed();
                return result;
              });
            },
          },
        ],
        { sessionId: 'session' },
      );
      expect(await drain(hooks.step(input, core, signal))).toEqual({
        values: events,
        result: summary,
      });
      expect(core).toHaveBeenCalledOnce();
      expect(observed).toHaveBeenCalledOnce();
    },
  );

  it('does not repeat ordinary downstream effects when next is called twice', async () => {
    const completed = vi.fn();
    const hooks = new TurnHooks(
      [
        {
          id: 'repeat',
          register(on) {
            on('turn.complete', async (_$, e, next) => {
              await next(e);
              return next(e);
            });
          },
        },
        {
          id: 'observer',
          register(on) {
            on('turn.complete', (_$, e, next) => {
              completed();
              return next(e);
            });
          },
        },
      ],
      { sessionId: 'session' },
    );
    expect(
      await hooks.complete({
        turnId: 'turn',
        answer: 'answer',
        durationMs: 1,
        isAborted: false,
        reason: 'answer',
      }),
    ).toEqual({ text: 'answer' });
    expect(completed).toHaveBeenCalledOnce();
  });

  it.each([{ model: 'other' }, { effort: 'high' as const }])(
    'preserves prepared step metadata when a handler attempts %j',
    async (patch) => {
      const core = vi.fn(async function* (e: TurnStepInput) {
        expect(e).toEqual(input);
        yield* events;
        return summary;
      });
      const hooks = new TurnHooks(
        [
          {
            id: 'rewrite',
            register(on) {
              on('turn.step', async function* (_$, e, next) {
                return yield* next({ ...e, ...patch });
              });
            },
          },
        ],
        { sessionId: 'session' },
      );
      expect(await drain(hooks.step(input, core, signal))).toEqual({
        values: events,
        result: summary,
      });
      expect(core).toHaveBeenCalledOnce();
    },
  );

  it('closes suspended handlers and their model source when the consumer returns early', async () => {
    const closed: string[] = [];
    const hooks = new TurnHooks(
      [
        {
          id: 'observer',
          register(on) {
            on('turn.step', async function* (_$, e, next) {
              try {
                return yield* next(e);
              } finally {
                closed.push('hook');
              }
            });
          },
        },
      ],
      { sessionId: 'session' },
    );
    const stream = hooks.step(
      input,
      async function* () {
        try {
          yield* events;
          return summary;
        } finally {
          closed.push('model');
        }
      },
      signal,
    );
    expect((await stream.next()).value).toBe(events[0]);
    await stream.return(undefined as never);
    expect(closed).toEqual(['hook', 'model']);
  });

  it('does not recover a cancelled dispatch by starting downstream work', async () => {
    const log = vi.spyOn(sessionLogger, 'event').mockImplementation(() => {});
    const controller = new AbortController();
    const failure = new Error('cancelled');
    const core = vi.fn(async function* () {
      yield* events;
      return summary;
    });
    const hooks = new TurnHooks(
      [
        {
          id: 'observer',
          register(on) {
            // eslint-disable-next-line require-yield -- Cancellation can end a stream before its first item.
            on('turn.step', async function* (_$, _e, next) {
              controller.abort();
              expect(next.signal.aborted).toBe(true);
              throw failure;
            });
          },
        },
      ],
      { sessionId: 'session' },
    );
    await expect(
      drain(hooks.step(input, core, controller.signal)),
    ).rejects.toBe(failure);
    expect(core).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  describe.each([false, true])(
    'downstream state with cancelled=%s',
    (cancelled) => {
      it.each(
        (
          [
            'not-created',
            'idle',
            'pending',
            'yielded',
            'completed',
            'failed',
          ] as const
        ).flatMap((state) =>
          (['throw', 'invalid'] as const).map((failure) => ({
            state,
            failure,
          })),
        ),
      )(
        'preserves execution facts for $state / $failure',
        async ({ state, failure }) => {
          const controller = new AbortController();
          const nativeFailure = new Error('Native request failed');
          const observerFailure = new Error('Observer failed');
          const result: TurnStepResult = {
            ...summary,
            usage: { ...cloneUsage(), model: input.model, credits: 3 },
          };
          let release!: () => void;
          let started!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const didStart = new Promise<void>((resolve) => {
            started = resolve;
          });
          const log = vi
            .spyOn(sessionLogger, 'event')
            .mockImplementation(() => release());
          const closed = vi.fn();
          const core = vi.fn(async function* () {
            started();
            try {
              if (state === 'pending') await gate;
              yield* events;
              if (cancelled) controller.abort();
              if (state === 'failed') throw nativeFailure;
              return result;
            } finally {
              closed();
            }
          });
          const stats = new TaskRunStatsAccumulator();
          let pending: Promise<unknown> | undefined;
          const hooks = new TurnHooks(
            [
              stats.turnHookModule,
              {
                id: 'observer',
                register(on) {
                  on('turn.step', async function* (_$, e, next) {
                    if (state !== 'not-created') {
                      const stream = next(e);
                      if (state === 'pending') {
                        pending = stream.next();
                        void pending.catch(() => {});
                        await didStart;
                      } else if (state === 'yielded') {
                        const first = await stream.next();
                        if (!first.done) yield first.value;
                      } else if (state === 'completed' || state === 'failed') {
                        try {
                          yield* stream;
                        } catch {
                          /* Exercise failure replacement by the handler. */
                        }
                      }
                    }
                    if (cancelled) controller.abort();
                    if (failure === 'throw') throw observerFailure;
                    return { ...result, turnId: 'invalid' };
                  });
                },
              },
            ],
            { sessionId: 'session' },
          );
          const execution = drain(hooks.step(input, core, controller.signal));
          const unstarted =
            cancelled && (state === 'not-created' || state === 'idle');
          if (unstarted) {
            if (failure === 'throw')
              await expect(execution).rejects.toBe(observerFailure);
            else
              await expect(execution).rejects.toThrow(
                'invalid turn.step result',
              );
            expect(core).not.toHaveBeenCalled();
            expect(closed).not.toHaveBeenCalled();
            expect(log).not.toHaveBeenCalled();
          } else if (state === 'failed') {
            await expect(execution).rejects.toBe(nativeFailure);
            expect(core).toHaveBeenCalledOnce();
            expect(closed).toHaveBeenCalledOnce();
            expect(log).not.toHaveBeenCalled();
          } else {
            expect(await execution).toEqual({ values: events, result });
            expect(core).toHaveBeenCalledOnce();
            expect(closed).toHaveBeenCalledOnce();
            expect(log).toHaveBeenCalledOnce();
          }
          await pending;
          expect(stats.statisticsSnapshot().totalCredits).toBe(
            unstarted || state === 'failed' ? 0 : 3,
          );
        },
      );
    },
  );

  it.each([false, true])(
    'does not start an already cancelled native step with handler=%s',
    async (withHandler) => {
      const controller = new AbortController();
      controller.abort();
      const core = vi.fn(async function* () {
        yield* events;
        return summary;
      });
      const module: TurnHookModule = {
        id: 'delegate',
        register(on) {
          on('turn.step', async function* (_$, e, next) {
            return yield* next(e);
          });
        },
      };
      const hooks = new TurnHooks(withHandler ? [module] : [], {
        sessionId: 'session',
      });
      await expect(
        drain(hooks.step(input, core, controller.signal)),
      ).rejects.toBe(controller.signal.reason);
      expect(core).not.toHaveBeenCalled();
    },
  );

  it('rejects duplicate modules, duplicate stages and registrations after loading', () => {
    let register: TurnHookRegistrar | undefined;
    const module: TurnHookModule = {
      id: 'module',
      register(on) {
        register = on;
      },
    };
    new TurnHooks([module], { sessionId: 'session' });
    expect(() => register!('turn.start', (_$, e, next) => next(e))).toThrow(
      'only register',
    );
    expect(
      () => new TurnHooks([module, module], { sessionId: 'session' }),
    ).toThrow('Duplicate turn hook module');
    expect(
      () =>
        new TurnHooks(
          [
            {
              id: 'duplicate',
              register(on) {
                on('turn.start', (_$, e, next) => next(e));
                on('turn.start', (_$, e, next) => next(e));
              },
            },
          ],
          { sessionId: 'session' },
        ),
    ).toThrow('duplicate turn.start');
  });

  it('keeps the original turn identity when a hook attempts to replace it', async () => {
    const core = vi.fn(async function* () {
      yield* events;
      return summary;
    });
    const hooks = new TurnHooks(
      [
        {
          id: 'identity',
          register(on) {
            on('turn.step', async function* (_$, e, next) {
              return yield* next({ ...e, turnId: 'other' });
            });
          },
        },
      ],
      { sessionId: 'session' },
    );
    expect((await drain(hooks.step(input, core, signal))).result.turnId).toBe(
      'turn',
    );
    expect(core).toHaveBeenCalledOnce();
  });
});
