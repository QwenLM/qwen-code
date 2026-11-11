/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ModelRequestRunnerEvent } from '../model-request/types.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import { createAssistantMessage } from '../protocol/transcript/conversions.js';
import type { NonNullableUsage } from '../protocol/schemas/common.js';
import type {
  TurnCompleteInput,
  TurnHookModule,
  TurnStepInput,
  TurnStepResult,
} from './turn-hooks.js';
import { QueryTurn } from './query-turn.js';
import { TaskRunStatsAccumulator } from './task-run-stats.js';


const event: ModelRequestRunnerEvent = {
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: '正文' },
  },
};
const stepInput = { model: 'model', messageCount: 1 };
function summary(
  input: TurnStepInput,
  usage: Partial<NonNullableUsage> = {},
): TurnStepResult {
  return {
    turnId: input.turnId,
    index: input.index,
    answer: 'answer',
    toolUses: [],
    stopReason: 'end_turn',
    usage: { ...cloneUsage(), ...usage, model: input.model },
  };
}
function createTurn(
  modules: readonly TurnHookModule[] = [],
  isSubagent = false,
) {
  const stats = new TaskRunStatsAccumulator();
  const controller = new AbortController();
  const turn = new QueryTurn({
    turnId: 'turn',
    sessionId: 'session',
    signal: controller.signal,
    isSubagent,
    agentId: isSubagent ? 'agent' : undefined,
    modules: [...modules, stats.turnHookModule],
  });
  return Object.assign(turn, { controller, stats });
}
async function execute(turn: QueryTurn, usage: Partial<NonNullableUsage> = {}) {
  const stream = turn.step(stepInput, async function* (input) {
    yield event;
    return summary(input, usage);
  });
  expect((await stream.next()).value).toBe(event);
  const result = await stream.next();
  expect(result.done).toBe(true);
  return result.value as TurnStepResult;
}

describe('QueryTurn', () => {
  it('allocates step indexes on consumption and supplies the turn identity and signal', async () => {
    const steps: Array<{ input: TurnStepInput; signal: AbortSignal }> = [];
    const turn = createTurn([
      {
        id: 'observer',
        register(on) {
          on('turn.step', async function* (_$, e, next) {
            steps.push({ input: e, signal: next.signal });
            return yield* next(e);
          });
        },
      },
    ]);
    const core = vi.fn(async function* (input: TurnStepInput) {
      yield event;
      return summary(input, { credits: 1 });
    });
    const first = turn.step({ ...stepInput, effort: 'high' }, core);
    const second = turn.step(stepInput, core);
    expect(core).not.toHaveBeenCalled();
    expect(steps).toEqual([]);
    await second.next();
    await second.next();
    await first.next();
    await first.next();
    expect(steps).toEqual([
      {
        input: { ...stepInput, turnId: 'turn', index: 0 },
        signal: turn.controller.signal,
      },
      {
        input: { ...stepInput, effort: 'high', turnId: 'turn', index: 1 },
        signal: turn.controller.signal,
      },
    ]);
    expect(turn.stats.statisticsSnapshot().totalCredits).toBe(2);
  });

  it('keeps parent and child steps and credits isolated while streams interleave', async () => {
    const steps: Array<{ turnId: string; index: number; agentId?: string }> =
      [];
    function runtime(turnId: string, agentId?: string) {
      const stats = new TaskRunStatsAccumulator();
      const turn = new QueryTurn({
        turnId,
        agentId,
        isSubagent: agentId !== undefined,
        sessionId: 'shared-session',
        signal: new AbortController().signal,
        modules: [
          {
            id: 'observer',
            register(on) {
              on('turn.step', async function* ($, e, next) {
                expect($.sessionId).toBe('shared-session');
                steps.push({
                  turnId: e.turnId,
                  index: e.index,
                  agentId: e.agentId,
                });
                return yield* next(e);
              });
            },
          },
          stats.turnHookModule,
        ],
      });
      return { turn, stats };
    }
    const parent = runtime('parent-turn');
    const child = runtime('child-turn', 'child');
    const first = parent.turn.step(stepInput, async function* (input) {
      yield event;
      return summary(input, { credits: 1 });
    });
    const second = child.turn.step(stepInput, async function* (input) {
      yield event;
      return summary(input, { credits: 4 });
    });
    await first.next();
    await second.next();
    await second.next();
    await first.next();
    await execute(parent.turn, { credits: 1 });
    expect(steps).toEqual([
      { turnId: 'parent-turn', index: 0, agentId: undefined },
      { turnId: 'child-turn', index: 0, agentId: 'child' },
      { turnId: 'parent-turn', index: 1, agentId: undefined },
    ]);
    expect(parent.stats.statisticsSnapshot().totalCredits).toBe(2);
    expect(child.stats.statisticsSnapshot().totalCredits).toBe(4);
  });

  it('accumulates finite credits per query and preserves zero and missing fields', async () => {
    const first = createTurn();
    const second = createTurn();
    await execute(first, { credits: 1.25, original_credits: 2 });
    await execute(first, { credits: 0.75, original_credits: 1.5 });
    await execute(first, {});
    await execute(first, { credits: 0, original_credits: 2 });
    await execute(first, { credits: Number.NaN, original_credits: Infinity });
    expect(first.stats.statisticsSnapshot()).toMatchObject({
      totalCredits: 2,
      totalOriginalCredits: 5.5,
    });
    expect(second.stats.statisticsSnapshot()).toMatchObject({
      totalCredits: 0,
      totalOriginalCredits: 0,
    });
    expect(first.stats.statisticsSnapshot()).not.toBe(first.stats.statisticsSnapshot());
  });

  it('retains completed credits when an outer observer fails without replaying the step', async () => {
    const core = vi.fn(async function* (input: TurnStepInput) {
      yield event;
      return summary(input, { credits: 1.25 });
    });
    const turn = createTurn([
      {
        id: 'observer',
        register(on) {
          on('turn.step', async function* (_$, e, next) {
            yield* next(e);
            throw new Error('Observer failed');
          });
        },
      },
    ]);
    const stream = turn.step(stepInput, core);
    await stream.next();
    expect((await stream.next()).done).toBe(true);
    expect(core).toHaveBeenCalledOnce();
    expect(turn.stats.statisticsSnapshot().totalCredits).toBe(1.25);
  });

  it.each([
    'none',
    'before-cancel',
    'after-cancel',
    'invalid-after-cancel',
  ] as const)(
    'retains interrupted usage across cancellation with observer failure=%s',
    async (failure) => {
      const controller = new AbortController();
      const stats = new TaskRunStatsAccumulator();
      const modules: TurnHookModule[] = [stats.turnHookModule];
      if (failure !== 'none') {
        modules.push({
          id: 'observer',
          register(on) {
            on('turn.step', async function* (_$, input, next) {
              const stream = next(input);
              if (failure === 'before-cancel') await stream.next();
              else {
                const result = yield* stream;
                if (failure === 'invalid-after-cancel')
                  return { ...result, turnId: 'invalid' };
              }
              throw new Error('Observer failed');
            });
          },
        });
      }
      const turn = new QueryTurn({
        turnId: 'turn',
        sessionId: 'session',
        signal: controller.signal,
        modules,
      });
      const core = vi.fn(async function* (input: TurnStepInput) {
        yield event;
        controller.abort();
        return summary(input, { credits: 3, original_credits: 4 });
      });
      const stream = turn.step(stepInput, core);
      expect((await stream.next()).value).toBe(event);
      const result = await stream.next();
      expect(result.done).toBe(true);
      expect(result.value).toMatchObject({
        usage: { credits: 3, original_credits: 4 },
      });
      expect(stats.statisticsSnapshot()).toMatchObject({
        totalCredits: 3,
        totalOriginalCredits: 4,
      });
      expect(core).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    'finalizes once after cancellation with subagent=%s',
    async (isSubagent) => {
      const stages: string[] = [];
      const completions: TurnCompleteInput[] = [];
      const turn = createTurn(
        [
          {
            id: 'lifecycle',
            register(on) {
              on('turn.start', (_$, e, next) => {
                stages.push('start');
                return next(e);
              });
              on('turn.step', async function* (_$, e, next) {
                stages.push(`step:${e.index}`);
                return yield* next(e);
              });
              on('turn.complete', (_$, e, next) => {
                stages.push('complete');
                completions.push(e);
                expect(next.signal.aborted).toBe(false);
                return next(e);
              });
            },
          },
        ],
        isSubagent,
      );
      await turn.start('prompt');
      await turn.start('prompt');
      await execute(turn, { credits: 1 });
      turn.recordTerminal({
        reason: 'abort',
        numTurns: 1,
        durationMs: 10,
        usage: cloneUsage(),
      });
      turn.controller.abort();
      await turn.complete('error');
      await turn.complete('abort');
      expect(stages).toEqual([
        ...(isSubagent ? [] : ['start']),
        'step:0',
        'complete',
      ]);
      expect(completions[0]).toMatchObject({
        turnId: 'turn',
        reason: 'aborted',
        isAborted: true,
        usage: { model: 'model' },
        ...(isSubagent ? { agentId: 'agent' } : {}),
      });
      expect(turn.stats.statisticsSnapshot().totalCredits).toBe(1);
    },
  );

  it('does not emit completion if input was never adopted', async () => {
    const complete = vi.fn();
    const turn = createTurn([
      {
        id: 'observer',
        register(on) {
          on('turn.complete', (_$, e, next) => {
            complete();
            return next(e);
          });
        },
      },
    ]);
    await turn.complete('error');
    expect(complete).not.toHaveBeenCalled();
  });

  it('collects split assistant blocks without mixing model steps', async () => {
    const completions: TurnCompleteInput[] = [];
    const turn = createTurn([
      {
        id: 'completion',
        register(on) {
          on('turn.complete', (_$, e, next) => {
            completions.push(e);
            return next(e);
          });
        },
      },
    ]);
    function assistant(text: string) {
      return createAssistantMessage({
        messageId: 'response',

        blocks: [{ type: 'text', text }],
        model: 'model',
        stopReason: 'end_turn',

        usage: ((value) => ({
          inputTokens: value.input_tokens,
          outputTokens: value.output_tokens,
          cacheReadInputTokens: value.cache_read_input_tokens,
          cacheCreationInputTokens: value.cache_creation_input_tokens,
        }))(cloneUsage()),
      });
    }
    await turn.start('prompt');
    turn.observe({ type: 'request_start' });
    turn.observe(assistant('Earlier step'));
    turn.observe({ type: 'request_start' });
    turn.observe(assistant('First block'));
    turn.observe(assistant('Second block'));
    await turn.complete('end_turn');
    expect(completions[0].answer).toBe('First block\nSecond block');
  });

  it.each([false, true])(
    'excludes child assistant messages from an aborted parent with own answer=%s',
    async (hasParentAnswer) => {
      const completions: TurnCompleteInput[] = [];
      const turn = createTurn([
        {
          id: 'completion',
          register(on) {
            on('turn.complete', (_$, e, next) => {
              completions.push(e);
              return next(e);
            });
          },
        },
      ]);
      const assistant = (text: string) =>
        createAssistantMessage({
          messageId: text,

          blocks: [{ type: 'text', text }],
          model: 'model',
          stopReason: 'end_turn',

          usage: ((value) => ({
            inputTokens: value.input_tokens,
            outputTokens: value.output_tokens,
            cacheReadInputTokens: value.cache_read_input_tokens,
            cacheCreationInputTokens: value.cache_creation_input_tokens,
          }))(cloneUsage()),
        });
      await turn.start('prompt');
      turn.observe({ type: 'request_start' });
      const child = assistant('Child answer');
      child.parent_tool_use_id = 'agent-tool';
      turn.observe(child);
      if (hasParentAnswer) {
        const parent = assistant('Parent answer');
        parent.parent_tool_use_id = null;
        turn.observe(parent);
      }
      turn.observe(child);
      await turn.complete('abort');
      expect(completions[0]).toMatchObject({
        answer: hasParentAnswer ? 'Parent answer' : '',
        reason: 'aborted',
        isAborted: true,
      });
    },
  );

  it('isolates completion usage from the terminal result', async () => {
    const turn = createTurn([
      {
        id: 'completion',
        register(on) {
          on('turn.complete', (_$, e, next) => {
            e.usage!.cache_creation.ephemeral_1h_input_tokens = 999;
            return next(e);
          });
        },
      },
    ]);
    await turn.start('prompt');
    await execute(turn);
    const usage = cloneUsage();
    turn.recordTerminal({
      reason: 'end_turn',
      numTurns: 1,
      durationMs: 10,
      usage,
    });
    await turn.complete('end_turn');
    expect(usage.cache_creation.ephemeral_1h_input_tokens).toBe(0);
  });

  it('closes a suspended source without charging an unfinished step', async () => {
    const closed = vi.fn();
    const completions: TurnCompleteInput[] = [];
    const turn = createTurn([
      {
        id: 'completion',
        register(on) {
          on('turn.complete', (_$, e, next) => {
            completions.push(e);
            return next(e);
          });
        },
      },
    ]);
    await turn.start('prompt');
    const stream = turn.step(stepInput, async function* (input) {
      try {
        yield event;
        return summary(input, { credits: 5 });
      } finally {
        closed();
      }
    });
    await stream.next();
    await stream.return(undefined as never);
    await turn.complete('abort');
    expect(closed).toHaveBeenCalledOnce();
    expect(turn.stats.statisticsSnapshot().totalCredits).toBe(0);
    expect(completions[0]).toMatchObject({
      reason: 'aborted',
      isAborted: true,
    });
    expect(completions[0].usage).toBeUndefined();
  });
});
