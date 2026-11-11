/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelRequestRunnerEvent } from '../model-request/types.js';
import type { NonNullableUsage } from '../protocol/schemas/common.js';
import type { ReasoningEffortLevel } from '../config/model-values.js';
import type { Terminal } from './query-event.js';
import type { TaskStatisticsSnapshot } from './task-run-stats.js';
import type { TaskTrigger } from './task-trigger.js';

import { emitTurnHookFailed } from '../utils/diagnosticInterceptors.js';

/** Main-agent input after submission was accepted; not a prompt transformation. */
export interface TurnStartInput {
  readonly text: string;
  readonly turnId: string;
}

/** One logical model call; tools and loop continuation execute outside this stage. */
export interface TurnStepInput {
  readonly turnId: string;
  readonly index: number;
  readonly model: string;
  readonly effort?: ReasoningEffortLevel;
  readonly messageCount: number;
  readonly agentId?: string;
}

export type TurnUsage = NonNullableUsage & { model: string };

/** Chain-local summary. The host retains the native response for execution. */
export interface TurnStepResult {
  readonly turnId: string;
  readonly index: number;
  answer: string;
  toolUses: ReadonlyArray<{ name: string; input: Record<string, unknown> }>;
  stopReason: string | null;
  usage: TurnUsage | null;
}

/** Finalization of an accepted main or child turn, including cancellation. */
export interface TurnCompleteInput {
  readonly turnId: string;
  readonly agentId?: string;
  readonly answer: string;
  readonly durationMs: number;
  readonly isAborted: boolean;
  readonly reason: 'answer' | 'aborted' | 'refusal' | 'error';
  readonly refusal?: { category: string | null; explanation: string | null };
  readonly usage?: TurnUsage;
}

/** Chain-local result; QueryTurn does not display or apply replacement text or usage. */
export interface TurnCompleteResult {
  text: string;
  usage?: TurnUsage;
}

/** Internal host identity; product modules do not receive the execution Config. */
export interface TurnHookContext {
  readonly sessionId: string;
}

type Next<Input, Result> = ((input: Input) => Result) & {
  readonly signal: AbortSignal;
};

type Handler<Input, Result> = (
  context: TurnHookContext,
  input: Input,
  next: Next<Input, Promise<Result>>,
) => Promise<Result> | Result;

/** Input changes affect downstream handlers only; the host keeps the accepted prompt. */
export type TurnStartHandler = Handler<TurnStartInput, { turnId: string }>;
export type TurnCompleteHandler = Handler<
  TurnCompleteInput,
  TurnCompleteResult
>;
/** Native events must be forwarded once, in order and without mutation. */
export type TurnStepStream = AsyncGenerator<
  ModelRequestRunnerEvent,
  TurnStepResult
>;
export type TurnStepHandler = (
  context: TurnHookContext,
  input: TurnStepInput,
  next: Next<TurnStepInput, TurnStepStream>,
) => TurnStepStream;

/** 内部同步阶段：初始化完成，即将开始本轮执行。 */
export interface TurnRunStartInput {
  readonly turnId: string;
  readonly agentId?: string;
  readonly taskId: string;
  readonly promptText: string;
  readonly isSubagent: boolean;
  readonly isWorkflow: boolean;
  readonly isRemoteWorker: boolean;
  readonly trigger?: TaskTrigger;
}

export interface TurnRunStartResult {
  readonly trigger: TaskTrigger;
}

/** 内部同步阶段：模型步骤产生有效结果，包括中断快照。 */
export interface TurnStepResultInput {
  readonly turnId: string;
  readonly agentId?: string;
  readonly index: number;
  readonly model: string;
  readonly outcome: 'complete' | 'interrupted';
}

/** 内部同步阶段：本轮执行进入终态，结束日志和资源清理尚未开始。 */
export interface TurnRunEndInput {
  readonly turnId: string;
  readonly agentId?: string;
  readonly taskId: string;
  readonly promptId?: string;
  readonly terminal: Readonly<Omit<Terminal, 'error'>> & {
    readonly error?: {
      readonly name: string;
      readonly message: string;
      readonly stack?: string;
    };
  };
  readonly requestIndex: number;
  readonly model: string;
  readonly statistics: TaskStatisticsSnapshot;
}

/**
 * 同步处理器必须调用 next 一次。输入是宿主事实，不可替换；准备阶段可以
 * 返回来源分类。异常直接传播，不接续、不重试，避免重放领取或预算更新。
 */
type SyncHandler<Input, Result> = (
  context: TurnHookContext,
  input: Input,
  next: (() => Result) & { readonly signal: AbortSignal },
) => Result;
export type TurnRunStartHandler = SyncHandler<
  TurnRunStartInput,
  TurnRunStartResult
>;
export type TurnStepResultHandler = SyncHandler<TurnStepResultInput, undefined>;
export type TurnRunEndHandler = SyncHandler<TurnRunEndInput, undefined>;

export interface TurnHookRegistrar {
  (stage: 'turn.start', handler: TurnStartHandler): void;
  (stage: 'turn.step', handler: TurnStepHandler): void;
  (stage: 'turn.complete', handler: TurnCompleteHandler): void;
  (stage: 'turn.run.start', handler: TurnRunStartHandler): void;
  (stage: 'turn.step.result', handler: TurnStepResultHandler): void;
  (stage: 'turn.run.end', handler: TurnRunEndHandler): void;
}

export interface TurnHookModule {
  readonly id: string;
  register(on: TurnHookRegistrar): void;
}

/** 每次执行创建独立模块；工厂可闭包绑定会话服务，不共享本轮状态。 */
export type TurnHookModuleFactory = () => TurnHookModule;

interface RegisteredHook<Hook> {
  moduleId: string;
  handler: Hook;
}

type StepExecutionState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'completed'; result: TurnStepResult }
  | { kind: 'failed'; error: unknown };

interface StepStreamState {
  stream: TurnStepStream;
  state: StepExecutionState;
  pending?: Promise<IteratorResult<ModelRequestRunnerEvent, TurnStepResult>>;
}

/** One query owns a frozen registration set and all of its in-flight calls. */
export class TurnHooks {
  private readonly starts: Array<RegisteredHook<TurnStartHandler>> = [];
  private readonly steps: Array<RegisteredHook<TurnStepHandler>> = [];
  private readonly completions: Array<RegisteredHook<TurnCompleteHandler>> = [];

  private readonly runStarts: Array<RegisteredHook<TurnRunStartHandler>> = [];
  private readonly stepResults: Array<RegisteredHook<TurnStepResultHandler>> =
    [];
  private readonly runEnds: Array<RegisteredHook<TurnRunEndHandler>> = [];

  constructor(
    modules: readonly TurnHookModule[],
    private readonly context: TurnHookContext,
  ) {
    const ids = new Set<string>();
    for (const module of modules) {
      if (ids.has(module.id))
        throw new Error(`Duplicate turn hook module: ${module.id}`);
      ids.add(module.id);
      const stages = new Set<string>();
      let registering = true;
      const on: TurnHookRegistrar = (stage, handler) => {
        if (!registering)
          throw new Error(
            'Turn hooks may only register during module registration',
          );
        if (stages.has(stage))
          throw new Error(`${module.id}: duplicate ${stage} registration`);
        stages.add(stage);
        switch (stage) {
          case 'turn.start':
            this.starts.push({
              moduleId: module.id,
              handler: handler as TurnStartHandler,
            });
            break;
          case 'turn.step':
            this.steps.push({
              moduleId: module.id,
              handler: handler as TurnStepHandler,
            });
            break;
          case 'turn.complete':
            this.completions.push({
              moduleId: module.id,
              handler: handler as TurnCompleteHandler,
            });
            break;
          case 'turn.run.start':
            this.runStarts.push({
              moduleId: module.id,
              handler: handler as TurnRunStartHandler,
            });
            break;
          case 'turn.step.result':
            this.stepResults.push({
              moduleId: module.id,
              handler: handler as TurnStepResultHandler,
            });
            break;
          case 'turn.run.end':
            this.runEnds.push({
              moduleId: module.id,
              handler: handler as TurnRunEndHandler,
            });
            break;
          default:
            throw new Error(
              `${module.id}: unsupported turn hook stage ${stage}`,
            );
        }
      };
      try {
        module.register(on);
      } finally {
        registering = false;
      }
    }
  }

  start(
    input: TurnStartInput,
    signal: AbortSignal,
  ): Promise<{ turnId: string }> {
    return this.invoke(
      'turn.start',
      this.starts,
      input,
      signal,
      (e) => ({ turnId: e.turnId }),
      (result) => result?.turnId === input.turnId,
    );
  }

  complete(input: TurnCompleteInput): Promise<TurnCompleteResult> {
    // Completion belongs to finalization, including when the turn was aborted.
    return this.invoke(
      'turn.complete',
      this.completions,
      input,
      new AbortController().signal,
      (e) => ({ text: e.answer, ...(e.usage ? { usage: e.usage } : {}) }),
      (result) => typeof result?.text === 'string',
    );
  }

  runStart(input: TurnRunStartInput, signal: AbortSignal): TurnRunStartResult {
    return this.invokeSync(
      'turn.run.start',
      this.runStarts,
      input,
      signal,
      () => ({
        trigger: input.isSubagent
          ? 'subagent'
          : input.isWorkflow
            ? 'workflow'
            : (input.trigger ?? 'unknown'),
      }),
      (result) =>
        [
          'user_prompt',
          'continuation',
          'scheduled',
          'subagent',
          'workflow',
          'unknown',
        ].includes(result?.trigger),
    );
  }

  stepResult(input: TurnStepResultInput, signal: AbortSignal): void {
    this.invokeSync(
      'turn.step.result',
      this.stepResults,
      input,
      signal,
      () => undefined,
      (result) => result === undefined,
    );
  }

  runEnd(input: TurnRunEndInput, signal: AbortSignal): void {
    this.invokeSync(
      'turn.run.end',
      this.runEnds,
      {
        ...input,
        terminal: {
          ...input.terminal,
          // Error.cause 可能包含不可克隆的传输对象；阶段只传递诊断摘要。
          error: input.terminal.error
            ? {
                name: input.terminal.error.name,
                message: input.terminal.error.message,
                stack: input.terminal.error.stack,
              }
            : undefined,
        },
      },
      signal,
      () => undefined,
      (result) => result === undefined,
    );
  }

  private invokeSync<Input, Result>(
    stage: string,
    hooks: ReadonlyArray<RegisteredHook<SyncHandler<Input, Result>>>,
    input: Input,
    signal: AbortSignal,
    executeCore: () => Result,
    isValidResult: (result: Result) => boolean,
  ): Result {
    // 阶段由实际执行边界触发；取消后返回的中断结果和终态也必须处理。
    const snapshot = freezeSnapshot(structuredClone(input));
    const call = (index: number): Result => {
      const hook = hooks[index];
      if (!hook) return executeCore();
      let called = false;
      let settled = false;
      let downstreamFailure: { error: unknown } | undefined;
      const next = Object.assign(
        () => {
          if (settled)
            throw new Error(`${stage}: next called after handler returned`);
          if (called) throw new Error(`${stage}: next may only be called once`);
          called = true;
          try {
            return call(index + 1);
          } catch (error) {
            downstreamFailure = { error };
            throw error;
          }
        },
        { signal },
      );
      try {
        const result = hook.handler(this.context, snapshot, next);
        // JS 模块可能绕过类型约束；禁止把 Promise 带回同步执行边界。
        if (
          result &&
          typeof (result as { then?: unknown }).then === 'function'
        ) {
          void Promise.resolve(result).catch(() => {});
          throw new Error(`${hook.moduleId}: ${stage} must be synchronous`);
        }
        if (downstreamFailure) throw downstreamFailure.error;
        if (!called)
          throw new Error(`${hook.moduleId}: ${stage} must call next once`);
        if (!isValidResult(result))
          throw new Error(`${hook.moduleId}: invalid ${stage} result`);
        return result;
      } finally {
        settled = true;
      }
    };
    return call(0);
  }

  private async invoke<
    Input extends { turnId: string; agentId?: string },
    Result,
  >(
    stage: 'turn.start' | 'turn.complete',
    hooks: ReadonlyArray<RegisteredHook<Handler<Input, Result>>>,
    input: Input,
    signal: AbortSignal,
    executeCore: (input: Input) => Result,
    isValidResult: (result: Result) => boolean,
  ): Promise<Result> {
    const call = async (index: number, e: Input): Promise<Result> => {
      const hook = hooks[index];
      if (!hook) return executeCore(e);
      let downstream: Promise<Result> | undefined;
      let downstreamFailure: { error: unknown } | undefined;
      let settled = false;
      const next = Object.assign(
        async (updated: Input) => {
          if (settled)
            throw new Error(`${hook.moduleId}: next() after ${stage} settled`);
          if (updated.turnId !== e.turnId || updated.agentId !== e.agentId) {
            throw new Error(
              `${hook.moduleId}: ${stage} cannot change turn identity`,
            );
          }
          if (downstream)
            throw new Error(
              `${hook.moduleId}: ${stage} next() may only be called once`,
            );
          downstream = call(index + 1, updated).then(
            (result) => {
              downstreamFailure = undefined;
              return result;
            },
            (error: unknown) => {
              downstreamFailure = { error };
              throw error;
            },
          );
          return downstream;
        },
        { signal },
      );
      try {
        const result = await hook.handler(this.context, Object.freeze(e), next);
        if (!isValidResult(result))
          throw new Error(`${hook.moduleId}: invalid ${stage} result`);
        return result;
      } catch (error) {
        if (signal.aborted) throw error;
        if (downstreamFailure) throw downstreamFailure.error;
        emitTurnHookFailed({
          sessionId: this.context.sessionId,
          turnId: e.turnId,
          agentId: e.agentId,
          moduleId: hook.moduleId,
          stage,
          error,
        });
        return await (downstream ?? call(index + 1, e));
      } finally {
        settled = true;
      }
    };
    return call(0, input);
  }

  step(
    input: TurnStepInput,
    executeCore: (input: TurnStepInput) => TurnStepStream,
    signal: AbortSignal,
  ): TurnStepStream {
    const context = this.context;
    const hooks = this.steps;
    async function* call(index: number, e: TurnStepInput): TurnStepStream {
      const hook = hooks[index];
      if (!hook) {
        signal.throwIfAborted();
        return yield* executeCore(e);
      }
      let downstream: StepStreamState | undefined;
      let settled = false;
      const pendingEvents: ModelRequestRunnerEvent[] = [];
      function pull(progress: StepStreamState) {
        if (progress.state.kind === 'idle') {
          signal.throwIfAborted();
          progress.state = { kind: 'running' };
        }
        if (progress.state.kind === 'completed') {
          return Promise.resolve({
            done: true as const,
            value: progress.state.result,
          });
        }
        if (progress.state.kind === 'failed') {
          return Promise.reject(progress.state.error);
        }
        // Running work owns cancellation and may return an interrupted result.
        // A failed handler and recovery share the same in-flight read.
        return (progress.pending ??= progress.stream.next().then(
          (item) => {
            progress.pending = undefined;
            if (item.done) {
              progress.state = { kind: 'completed', result: item.value };
            } else {
              pendingEvents.push(item.value);
            }
            return item;
          },
          (error: unknown) => {
            progress.pending = undefined;
            progress.state = { kind: 'failed', error };
            throw error;
          },
        ));
      }
      async function* read(progress: StepStreamState): TurnStepStream {
        // Retired handlers cannot start further reads, including queued next calls.
        while (!settled) {
          const item = await pull(progress);
          if (item.done) return item.value;
          yield item.value;
        }
        // A retired reader cannot publish a result; recovery owns the stream.
        return undefined as never;
      }
      const next = Object.assign(
        (updated: TurnStepInput): TurnStepStream => {
          if (settled)
            throw new Error(`${hook.moduleId}: next() after turn.step settled`);
          for (const key of [
            'turnId',
            'index',
            'messageCount',
            'agentId',
            'model',
            'effort',
          ] as const) {
            if (updated[key] !== e[key])
              throw new Error(
                `${hook.moduleId}: turn.step cannot change ${key}`,
              );
          }
          if (downstream)
            throw new Error(
              `${hook.moduleId}: turn.step next() may only be called once`,
            );
          downstream = {
            stream: call(index + 1, updated),
            state: { kind: 'idle' },
          };
          return read(downstream);
        },
        { signal },
      );
      let handler: TurnStepStream | undefined;
      let finished = false;
      try {
        for (;;) {
          let item: IteratorResult<ModelRequestRunnerEvent, TurnStepResult>;
          try {
            handler ??= hook.handler(context, Object.freeze(e), next);
            item = await handler.next();
            finished = item.done === true;
            // A handler cannot turn a failed native request into a successful step.
            if (downstream?.state.kind === 'failed')
              throw downstream.state.error;
            if (item.done) {
              const result = item.value;
              if (
                !result ||
                result.turnId !== e.turnId ||
                result.index !== e.index ||
                typeof result.answer !== 'string' ||
                !Array.isArray(result.toolUses)
              ) {
                throw new Error(`${hook.moduleId}: invalid turn.step result`);
              }
              return result;
            }
          } catch (error) {
            settled = true;
            if (downstream?.state.kind === 'failed')
              throw downstream.state.error;
            // Cancellation prevents starting work, not settling work already started.
            if (
              signal.aborted &&
              (!downstream || downstream.state.kind === 'idle')
            ) {
              throw error;
            }
            emitTurnHookFailed({
              sessionId: context.sessionId,
              turnId: e.turnId,
              agentId: e.agentId,
              stepIndex: e.index,
              moduleId: hook.moduleId,
              stage: 'turn.step',
              error,
            });
            downstream ??= {
              stream: call(index + 1, e),
              state: { kind: 'idle' },
            };
            // Settle the old read, then drain the native stream even after cancellation.
            // Its interrupted result carries usage and tool settlement facts.
            await downstream.pending;
            for (;;) {
              yield* pendingEvents;
              pendingEvents.length = 0;
              if (downstream.state.kind === 'completed')
                return downstream.state.result;
              await pull(downstream);
            }
          }
          const pendingIndex = pendingEvents.indexOf(item.value);
          if (pendingIndex !== -1) pendingEvents.splice(pendingIndex, 1);
          // Consumer throw/return belongs to stream closure, not hook recovery.
          yield item.value;
        }
      } finally {
        settled = true;
        if (handler && !finished) {
          try {
            await handler.return(undefined as never);
          } catch {
            /* Preserve the original failure. */
          }
        }
        if (
          downstream &&
          (downstream.state.kind === 'idle' ||
            downstream.state.kind === 'running')
        ) {
          try {
            await downstream.stream.return(undefined as never);
          } catch {
            /* Preserve the original failure. */
          }
        }
      }
    }
    return call(0, input);
  }
}

/** 冻结独立快照，避免处理器修改宿主终态或影响后续模块的统计输入。 */
function freezeSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freezeSnapshot(child, seen);
    Object.freeze(value);
  }
  return value;
}
