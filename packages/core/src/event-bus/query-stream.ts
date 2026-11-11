/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { Config } from '../config/config.js';
import { buildStartupMemoryPrefix } from '../prompts/context-injection.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';

import { isCancellationError } from '../utils/errors.js';
import { extractUserVisiblePromptText } from '../utils/promptTextUtils.js';
import { runLogger } from '../utils/runLogger.js';
import { queryModelSelectContext } from '../core/model-policy.js';
import type { ModelPolicySelectContext } from '../core/model-policy.js';
import type { QueryParams } from '../core/query-params.js';
import type { QueryEvent, Terminal } from '../core/query-event.js';
import { createHistoryOnlyRuntimeState } from '../core/query-runtime-state.js';
import { QueryTurn } from '../core/query-turn.js';
import { TaskRunStatsAccumulator } from '../core/task-run-stats.js';
import { createBusEvent, type QueryEventBus } from './bus.js';
import type { QueryCancelReason } from './events.js';
import { createQueryEventBus, type QueryEventRuntime } from './runtime.js';
import type {
  QueryControl,
  QueryEndNotificationState,
  QueryInput,
  QueryState,
} from './state.js';

/** Bound on waiting for the handlers to settle after an early close. */
const CLOSE_SETTLEMENT_CAP_MS = 10_000;

type ListenerItem =
  | { kind: 'event'; event: QueryEvent }
  | { kind: 'finished' }
  | { kind: 'closed' };

/**
 * query()'s view of the bus: buffers outputs in order, observes the end of
 * the query and turns caller abort, consumer close and Conversation failure
 * into query.cancelled. Never references a handler or decides a next step.
 */
class QueryListener {
  private readonly buffer: QueryEvent[] = [];
  private wake?: () => void;
  private cancelled = false;
  private conversationFailure?: { error: unknown };
  closed = false;
  finished = false;
  private resolveFinished!: () => void;
  readonly finishedPromise = new Promise<void>((resolve) => {
    this.resolveFinished = resolve;
  });
  private readonly unsubscribe: () => void;

  constructor(
    private readonly bus: QueryEventBus,
    private readonly state: QueryState,
  ) {
    const { queryId } = state.input;
    this.unsubscribe = bus.subscribe(
      'query',
      ['query.output', 'query.finished', 'handler.failed'],
      (event) => {
        if (event.type === 'query.output') {
          if (!this.closed && !this.finished) {
            this.buffer.push(event.data.event);
            this.notify();
          }
          return;
        }
        if (event.type === 'query.finished') {
          this.markFinished();
          return;
        }
        if (event.type === 'handler.failed') {
          if (event.data.source !== 'conversation') return;
          this.conversationFailure ??= { error: event.data.error };
          this.cancel('conversation_failed');
          void this.capWait().then(() => this.markFinished());
        }
      },
      { name: `query:${queryId}`, queryId },
    );
  }

  get failure(): { error: unknown } | undefined {
    return this.conversationFailure;
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private markFinished(): void {
    if (this.finished) return;
    this.finished = true;
    this.resolveFinished();
    this.notify();
  }

  submit(): void {
    this.bus.publish(
      createBusEvent('query.submitted', this.state.input, {}),
    );
  }

  cancel(reason: QueryCancelReason, signalReason?: unknown): void {
    if (this.cancelled) return;
    this.cancelled = true;
    // Handlers read the shared signal; the event tells them it happened.
    this.state.control.abort.abort(signalReason);
    this.bus.publish(
      createBusEvent('query.cancelled', this.state.input, {
        reason,
        ...(signalReason !== undefined ? { signalReason } : {}),
      }),
    );
  }

  /** Consumer closed: cancel at once and drop what it will never read. */
  close(reason: QueryCancelReason): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer.length = 0;
    if (!this.finished) this.cancel(reason);
    this.notify();
  }

  async next(): Promise<ListenerItem> {
    for (;;) {
      if (this.closed) return { kind: 'closed' };
      const event = this.buffer.shift();
      if (event) return { kind: 'event', event };
      if (this.finished) return { kind: 'finished' };
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private capWait(): Promise<void> {
    const deadline = this.state.input.params.toolSettlementDeadlineMs;
    const capMs =
      deadline === undefined
        ? CLOSE_SETTLEMENT_CAP_MS
        : Math.min(
            CLOSE_SETTLEMENT_CAP_MS,
            Math.max(1_000, deadline - Date.now() + 1_000),
          );
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, capMs);
      timer.unref?.();
      void this.finishedPromise.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Waits for query.finished, bounded so a stuck handler cannot hang close. */
  waitFinished(): Promise<void> {
    return this.finished ? Promise.resolve() : this.capWait();
  }

  dispose(): void {
    this.unsubscribe();
  }
}

function captureAsyncContext(): <T>(fn: () => T) => T {
  const snapshot = (
    AsyncLocalStorage as unknown as {
      snapshot?: () => <R>(fn: () => R) => R;
    }
  ).snapshot?.();
  return snapshot ? (fn) => snapshot(fn) : (fn) => fn();
}

function toolAgentContextFor(
  config: Config,
  options: QueryParams,
): AgentLoopContext {
  const { toolRegistry, agentContext } = options;
  // The root query resolves tools from Config; a host-supplied registry (e.g.
  // one that mounts host-only tools) is overlaid so schema and execution agree.
  const rootToolRegistry =
    toolRegistry && toolRegistry !== config.getToolRegistry?.()
      ? toolRegistry
      : undefined;
  return (agentContext ??
    (rootToolRegistry
      ? // eslint-disable-next-line eslint-js/no-restricted-syntax -- Preserve Config methods while shadowing its getter.
        Object.create(config, {
          toolRegistry: {
            value: rootToolRegistry,
            writable: true,
            enumerable: true,
            configurable: true,
          },
        })
      : config)) as AgentLoopContext;
}

async function fireQueryEndSafely(
  options: QueryParams,
  state: QueryEndNotificationState,
  reason: Terminal['reason'],
): Promise<void> {
  if (
    options.isSubagent ||
    options.modelPurpose === 'side_question' ||
    options.modelPurpose === 'hook_prompt' ||
    !state.requestSetId
  ) {
    return;
  }
  await options.config
    ?.getHookSystem?.()
    ?.fireQueryEndEvent(
      state.requestSetId,
      state.businessId,
      state.model,
      reason,
    );
}

function createQueryControl(): QueryControl {
  const abort = new AbortController();
  const turnAbort = new AbortController();
  const toolSignal = AbortSignal.any([abort.signal, turnAbort.signal]);
  return {
    abort,
    turnAbort,
    toolSignal,
    queryLifecycle: {
      signal: toolSignal,
      cleanups: new Set(),
      admissionGuards: new Set(),
    },
  };
}

interface StreamControl {
  listener?: QueryListener;
  state?: QueryState;
  runtime?: QueryEventRuntime;
  closeReason?: QueryCancelReason;
}

/** Creates the query state, submits it and yields its outputs until finished. */
async function* listen(
  options: QueryParams,
  control: StreamControl,
  base: Omit<
    QueryInput,
    | 'queryId'
    | 'config'
    | 'promptText'
    | 'startTime'
    | 'toolAgentContext'
    | 'selectInput'
    | 'startupMemoryPrefix'
    | 'runInContext'
    | 'params'
  >,
  signal: AbortSignal,
): AsyncGenerator<QueryEvent, Terminal> {
  const config = options.config;
  if (!config) {
    throw new Error('A session Config is required for ModelProvider inference.');
  }
  if (
    options.systemPrompt !== undefined &&
    options.resolveSystemPrompt !== undefined
  ) {
    throw new Error(
      'QueryParams.systemPrompt and resolveSystemPrompt are mutually exclusive.',
    );
  }
  const runtime = options.eventBus ?? createQueryEventBus();
  control.runtime = runtime;
  const workdirs =
    options.workdirs ?? config.getWorkspaceContext().getDirectories();
  const selectInput = {
    overrideSelection: options.querySelection,
    parentSelection: options.parentSelection,
    ...queryModelSelectContext({
      purpose: options.modelPurpose,
      isSubagent: options.isSubagent,
    }),
    ...(workdirs.length > 0 ? { workdirs } : {}),
  } satisfies ModelPolicySelectContext;
  const params: QueryParams = { ...options, signal: undefined };
  const state = runtime.store.create(
    {
      ...base,
      queryId: randomUUID(),
      params,
      config,
      promptText: extractUserVisiblePromptText(options.prompt),
      startTime: Date.now(),
      toolAgentContext: toolAgentContextFor(config, options),
      selectInput,
      startupMemoryPrefix: buildStartupMemoryPrefix(
        options.startupMemoryContext,
      ),
      runInContext: captureAsyncContext(),
    },
    {
      control: createQueryControl(),
      flow: {
        llmInFlight: false,
        toolsInFlight: false,
        finishing: false,
        businessFinishStarted: false,
      },
      runtime: createHistoryOnlyRuntimeState({ history: [] }),
      toolUseContext: { signal },
      lastRequestPrefixMessages: [],
      usage: cloneUsage(),
      requestIndex: 0,
      cumulativeResponseText: '',
      toolStreamRecoveryCount: 0,
      sessionContextReason: options.messages?.some(
        (message) =>
          message.type === 'system' && message.subtype === 'compact_boundary',
      )
        ? 'compaction'
        : 'session_start',
      task: { started: false, terminalReported: false },
    },
  );
  control.state = state;
  const listener = new QueryListener(runtime.bus, state);
  control.listener = listener;
  if (control.closeReason) listener.close(control.closeReason);
  // The caller is never aborted back; outputs keep flowing until finished.
  const onAbort = () => listener.cancel('abort', signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    listener.submit();
    if (signal.aborted) onAbort();
    for (;;) {
      const item = await listener.next();
      if (item.kind === 'event') {
        yield item.event;
        continue;
      }
      if (item.kind === 'closed') return undefined as never;
      break;
    }
    const slot = state.terminal;
    if (!slot) {
      throw listener.failure?.error ?? new Error('Query finished without a terminal.');
    }
    if (slot.thrown) throw slot.thrownError;
    return slot.terminal!;
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!listener.finished) {
      listener.close(control.closeReason ?? 'consumer_return');
      await listener.waitFinished();
    }
    listener.dispose();
  }
}

/**
 * The outer query generator: turn lifecycle and QueryEnd around
 * the listener. Synchronous validation stays in query(); nothing is submitted
 * before the first next().
 */
async function* runQuery(
  options: QueryParams,
  initialModel: string,
  control: StreamControl,
): AsyncGenerator<QueryEvent, Terminal> {
  const { sessionId } = options;
  const signal = options.signal ?? new AbortController().signal;
  const taskRunStats = new TaskRunStatsAccumulator();
  const turn = new QueryTurn({
    turnId: options.promptId,
    sessionId,
    agentId: options.isSubagent
      ? (options.agentId ?? options.promptId)
      : undefined,
    isSubagent: options.isSubagent,
    signal,
    modules: [
      taskRunStats.turnHookModule,
      ...(options.turnHookFactories ?? []).map((createModule) =>
        createModule(),
      ),
    ],
  });
  const queryEndState: QueryEndNotificationState = {
    requestSetId:
      options.userMessage?.requestSetId ?? options.preallocatedRequestSetId,
    model: initialModel,
  };

  const stream = await listen(
    options,
    control,
    {
      sessionId,
      parentQueryId: options.parentQueryId,
      turn,
      taskRunStats,
      queryEndState,
    },
    signal,
  );

  const startedCommandUuids = new Set<string>();
  let fallbackReason: Terminal['reason'] = 'abort';
  let result: IteratorResult<QueryEvent, Terminal> | undefined;
  try {
    result = await stream.next();
    while (!result.done) {
      const event = result.value;
      turn.observe(event);
      if (event.type === 'command_lifecycle' && event.state === 'started') {
        startedCommandUuids.add(event.uuid);
      }
      yield event;
      result = await stream.next();
    }

    const terminal = result.value;
    // The consumer closed while a next() was pending.
    if (!terminal) return undefined as never;
    fallbackReason = terminal.reason;
    const terminalState =
      terminal.reason === 'end_turn' || terminal.reason === 'max_turns'
        ? 'completed'
        : 'cancelled';
    for (const commandUuid of startedCommandUuids) {
      yield {
        type: 'command_lifecycle',
        uuid: commandUuid,
        state: terminalState,
      };
    }
    return terminal;
  } catch (error) {
    fallbackReason = isCancellationError(error, signal) ? 'abort' : 'error';
    queryEndState.reason ??= fallbackReason;
    throw error;
  } finally {
    if (!result?.done) {
      try {
        await stream.return(undefined as never);
      } catch (error) {
        runLogger.debug('[AgentLoop] Failed to close query implementation:', error);
      }
    }
    try {
      await turn.complete(queryEndState.reason ?? fallbackReason);
    } finally {
      try {
        await fireQueryEndSafely(
          options,
          queryEndState,
          queryEndState.reason ?? fallbackReason,
        );
      } finally {
        if (control.state) {
          control.runtime?.store.delete(control.state.input.queryId);
        }
        if (control.runtime && control.runtime !== options.eventBus) {
          control.runtime.dispose();
        }
      }
    }
  }
}

/**
 * Controlled adapter: return()/throw() publish the cancellation immediately,
 * even while a next() is pending, instead of waiting for the next yield.
 */
class QueryStream implements AsyncGenerator<QueryEvent, Terminal> {
  private readonly control: StreamControl = {};
  private readonly inner: AsyncGenerator<QueryEvent, Terminal>;

  constructor(options: QueryParams, initialModel: string) {
    this.inner = runQuery(options, initialModel, this.control);
  }

  next(): Promise<IteratorResult<QueryEvent, Terminal>> {
    return this.inner.next();
  }

  return(
    value?: Terminal | PromiseLike<Terminal>,
  ): Promise<IteratorResult<QueryEvent, Terminal>> {
    this.close('consumer_return');
    return this.inner.return(value as Terminal);
  }

  throw(error?: unknown): Promise<IteratorResult<QueryEvent, Terminal>> {
    this.close('consumer_throw');
    return this.inner.throw(error);
  }

  private close(reason: QueryCancelReason): void {
    this.control.closeReason ??= reason;
    this.control.listener?.close(reason);
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.return();
  }
}

export function createQueryStream(
  options: QueryParams,
  initialModel: string,
): AsyncGenerator<QueryEvent, Terminal> {
  return new QueryStream(options, initialModel);
}
