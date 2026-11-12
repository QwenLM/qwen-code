/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, PartListUnion } from '@google/genai';
import type { Config } from '../config/config.js';
import type { RuntimeContentGeneratorView } from '../agents/runtime/agent-context.js';
import { goalToolResultProvenance } from '../goals/goal-tool-result-provenance.js';
import { findPlanModeEntryBatchBoundaryIndex } from './plan-mode-entry-policy.js';
import { finalizeToolResponses } from '../tools/tool-response-finalizer.js';
import type { ToolResultDisplay } from '../tools/tools.js';
import { SendMessageType } from './client.js';
import type { LlmClient, SendMessageOptions } from './client.js';
import {
  CoreToolScheduler,
  type CompletedToolCall,
  type OutputUpdateHandler,
  type ScheduledToolCall,
} from './coreToolScheduler.js';
import {
  getCachedToolCallFingerprint,
  isReplayOfHandledToolCall,
  recordHandledToolCall,
} from './toolCallIdUtils.js';
import {
  createDuplicateProviderToolCallResponse,
  findRepeatedDuplicateProviderToolCall,
  LlmEventType,
  markDuplicateProviderToolCallResponseSent,
  type ServerLlmStreamEvent,
  type ToolCallRequestInfo,
  type ToolCallResponseInfo,
  Turn,
  type TurnRunOptions,
} from './turn.js';
import type { LlmChat } from './llm-chat.js';
import { runAgentLoopOnBus } from '../event-bus/adapter.js';

type SchedulerOptions = ConstructorParameters<typeof CoreToolScheduler>[0];

export type AgentLoopStopReason =
  /** The model stopped calling tools. */
  | 'completed'
  /** `maxRounds` was reached with tool results still to send (`parts`). */
  | 'next_round'
  /**
   * The loop's signal was aborted. A cancel that comes only from a signal the
   * client merged in, such as a Goal turn's, ends the round like a response
   * without tool calls.
   */
  | 'cancelled'
  | 'loop_detected'
  | 'duplicate_provider_call'
  /** A tool result asked to end the turn (`parts` holds the results). */
  | 'tool_ended_turn'
  /** A surface callback ended the loop. */
  | 'surface_ended'
  | 'max_session_turns'
  | 'session_token_limit'
  | 'user_prompt_blocked';

export interface AgentLoopResult {
  reason: AgentLoopStopReason;
  rounds: number;
  /** The last model round. */
  turn?: Turn;
  /** The function responses of the last tool batch. */
  parts?: Part[];
  /** The same responses by call, as the batch returned them. */
  responses?: ToolBatchResult['responses'];
}

export interface AgentLoopRound {
  parts: PartListUnion;
  promptId: string;
  options: SendMessageOptions;
}

export interface AgentLoopToolResult {
  /** The call as the model sent it. */
  request: ToolCallRequestInfo;
  /** The call as it ran, e.g. the target of a `tool_call` bridge. */
  executionRequest: ToolCallRequestInfo;
  response: ToolCallResponseInfo;
  status: CompletedToolCall['status'];
  /**
   * `executed` went through the scheduler. The others were answered without
   * running: a provider replay, a call the surface did not run, or a repeat
   * of a call id already in the batch.
   */
  origin: 'executed' | 'replayed' | 'skipped' | 'duplicate';
}

/** What the loop needs of a finished call. */
export type AgentLoopSettledCall = Pick<
  CompletedToolCall,
  'status' | 'request' | 'response'
> & {
  /**
   * The executor counts the call toward the client's tool-call stats
   * itself, as the Ink TUI's Mod tool middleware does for each attempt.
   */
  recorded?: boolean;
};

/** Provider replay bookkeeping; shared when several loops serve one run. */
export interface AgentLoopDuplicateState {
  handled: Map<string, string>;
  responded: Set<string>;
}

/**
 * What a surface returns for a model event: a stop reason ends the round
 * there, as a stop event of the client does, and closes its stream.
 */
export type ModelEventResult = AgentLoopStopReason | void;

/**
 * Sends one model round. The main session's round is its `LlmClient`; an
 * agent with its own `LlmChat` sends its rounds with {@link turnModelRound}.
 * The iterator's return value is the round's `Turn`.
 */
export interface ModelRoundSource {
  sendRound(
    round: AgentLoopRound,
    signal: AbortSignal,
  ): AsyncIterator<ServerLlmStreamEvent, Turn | undefined>;
}

/**
 * A round on a `Turn` over `chat`, for an agent that owns its chat: the
 * stream's chunks are parsed into events only in `turn.ts`. `round.options`
 * belong to the main session's client and are not used.
 */
export function turnModelRound(
  chat: LlmChat,
  model: string,
  options?: TurnRunOptions,
): ModelRoundSource {
  return {
    sendRound: (round, signal) =>
      runTurn(
        new Turn(chat, round.promptId),
        model,
        round.parts,
        signal,
        options,
      ),
  };
}

async function* runTurn(
  turn: Turn,
  model: string,
  parts: PartListUnion,
  signal: AbortSignal,
  options: TurnRunOptions | undefined,
): AsyncGenerator<ServerLlmStreamEvent, Turn> {
  yield* turn.run(model, parts, signal, undefined, options);
  return turn;
}

const isModelRoundSource = (
  source: LlmClient | ModelRoundSource,
): source is ModelRoundSource => 'sendRound' in source;

/** Behavior the surface owns. Every hook is optional. */
export interface AgentLoopHost {
  onRoundStart?(round: number, promptId: string): void;
  /**
   * Every event of the model round, in order. On `Retry` and `ModelFallback`
   * `discardedCalls` holds the tool calls the abandoned attempt emitted.
   * Throwing ends the loop.
   */
  onModelEvent?(
    event: ServerLlmStreamEvent,
    discardedCalls: readonly ToolCallRequestInfo[],
  ): ModelEventResult | Promise<ModelEventResult>;
  /**
   * After each model round, before its tool batch. Returning a stop reason
   * ends the loop there; a stop of the round itself takes precedence.
   */
  onRoundEnd?(round: number): AgentLoopStopReason | void;
  /** The request for a round after the first; defaults to the tool results. */
  nextRound?(round: number, parts: Part[]): AgentLoopRound;
  /**
   * The calls of a batch that run; the rest get `skippedOutput`. `batch`
   * holds every call of the batch, including replays and repeated ids.
   */
  selectCalls?(
    executable: ToolCallRequestInfo[],
    batch: readonly ToolCallRequestInfo[],
  ): ToolCallRequestInfo[];
  /**
   * Runs once for each call `selectCalls` kept, serially and in request
   * order: right before its launch or, for a call the scheduler settled
   * without launching it (invalid arguments, a denial), at its turn.
   * Returning false leaves the call unexecuted. `settled` holds the batch's
   * calls that have already finished.
   */
  beforeToolLaunch?(
    request: ToolCallRequestInfo,
    settled: readonly AgentLoopSettledCall[],
  ): boolean;
  /** Live output of a running call. */
  outputHandler?(request: ToolCallRequestInfo): OutputUpdateHandler | undefined;
  /**
   * One result of the batch. Results arrive when the batch is complete:
   * replays first, then executed calls, skipped calls and repeated ids, each
   * in request order. Returning true ends the loop after this batch.
   */
  onToolResult?(result: AgentLoopToolResult): boolean | void;
  /** Output for a call the surface did not run. */
  skippedOutput?(request: ToolCallRequestInfo): string;
  /** Whether a result's `terminateTurn` ends the loop. */
  endsOnTerminateTurn?(): boolean;
}

/**
 * Runs one batch of calls; the default is one `CoreToolScheduler`. Like the
 * scheduler, an executor calls `beforeLaunch` right before each launch and
 * skips the siblings of a plan-mode entry.
 */
export interface AgentLoopToolExecutor {
  run(
    requests: ToolCallRequestInfo[],
    signal: AbortSignal,
    hooks: {
      beforeLaunch(
        request: ToolCallRequestInfo,
        settled: readonly AgentLoopSettledCall[],
      ): boolean;
      output(callId: string, chunk: ToolResultDisplay): void;
    },
  ): Promise<AgentLoopSettledCall[]>;
}

export interface AgentLoopOptions {
  /**
   * Sends the rounds. An agent with its own chat passes its round source;
   * its calls then do not count toward the session's tool calls.
   */
  client: LlmClient | ModelRoundSource;
  config: Config;
  /** Cancels the loop; the model rounds use it. */
  signal: AbortSignal;
  /** The signal tools run under, when it differs from `signal`. */
  toolSignal?: AbortSignal;
  first: AgentLoopRound;
  host?: AgentLoopHost;
  /** Return after this many rounds, with the pending tool results. */
  maxRounds?: number;
  duplicates?: AgentLoopDuplicateState;
  /** Scheduler wiring the surface owns, such as approvals. */
  scheduler?: Partial<SchedulerOptions>;
  executor?: AgentLoopToolExecutor;
  runtimeView?: RuntimeContentGeneratorView;
  /** Passed to each tool batch; see {@link ToolBatchOptions}. */
  duplicateStateForCall?: ToolBatchOptions['duplicateStateForCall'];
  keepCancelledResults?: boolean;
  deferRecording?: boolean;
  /**
   * Run the loop on the event-bus implementation instead of the procedural
   * one. Opt-in; the two are behaviorally equivalent. See
   * docs/design/2026-11-11-event-bus-agent-loop.md.
   */
  useEventBus?: boolean;
}

/**
 * The agent loop: send a request, stream the reply, run the requested tools
 * as one batch, send their results back, and repeat until the model stops
 * calling tools. The Stop hook, steering and next-speaker continuations run
 * inside `LlmClient.sendMessageStream`.
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  if (options.useEventBus) {
    return runAgentLoopOnBus(options);
  }
  const { client, config, signal, host = {} } = options;
  const duplicates = options.duplicates ?? defaultDuplicates(client);
  const executor =
    options.executor ??
    createSchedulerExecutor(config, options.scheduler, options.runtimeView);
  let round = options.first;
  for (let index = 0; ; index++) {
    const rounds = index + 1;
    host.onRoundStart?.(index, round.promptId);
    const {
      turn,
      calls,
      stop: modelStop,
    } = await runModelRound(client, round, signal, host);
    const hostStop = host.onRoundEnd?.(index);
    const stop = modelStop ?? hostStop;
    if (stop) return { reason: stop, rounds, turn };
    if (calls.length === 0) return { reason: 'completed', rounds, turn };

    const batch = await runToolBatch(
      calls,
      batchOptions(options, duplicates, executor),
    );
    const { parts, responses } = batch;
    if (batch.stop) {
      return { reason: batch.stop, rounds, turn, parts, responses };
    }
    if (options.maxRounds !== undefined && rounds >= options.maxRounds) {
      return { reason: 'next_round', rounds, turn, parts, responses };
    }
    round = host.nextRound?.(rounds, batch.parts) ?? {
      parts: batch.parts,
      promptId: round.promptId,
      options: { type: SendMessageType.ToolResult },
    };
  }
}

/** Provider replay bookkeeping seeded from the session's history. */
export function defaultDuplicates(
  client: LlmClient | ModelRoundSource,
): AgentLoopDuplicateState {
  return {
    handled: new Map(
      isModelRoundSource(client) ? [] : client.getHistoryToolCallFingerprints(),
    ),
    responded: new Set<string>(),
  };
}

/** The options of a loop's tool batch. */
export function batchOptions(
  options: AgentLoopOptions,
  duplicates: AgentLoopDuplicateState,
  executor: AgentLoopToolExecutor,
): ToolBatchOptions {
  const { client } = options;
  return {
    config: options.config,
    ...(isModelRoundSource(client) ? {} : { client }),
    signal: options.signal,
    toolSignal: options.toolSignal,
    host: options.host,
    duplicates,
    duplicateStateForCall: options.duplicateStateForCall,
    executor,
    keepCancelledResults: options.keepCancelledResults,
    deferRecording: options.deferRecording,
  };
}

/**
 * The stop reason of a client's terminal event. Built on first use: agent
 * runtimes import this module while `turn.ts` may still be evaluating.
 */
let stopEvents: Partial<Record<LlmEventType, AgentLoopStopReason>> | undefined;
const stopReasonOf = (type: LlmEventType) =>
  (stopEvents ??= {
    [LlmEventType.UserCancelled]: 'cancelled',
    [LlmEventType.LoopDetected]: 'loop_detected',
    [LlmEventType.MaxSessionTurns]: 'max_session_turns',
    [LlmEventType.SessionTokenLimitExceeded]: 'session_token_limit',
    [LlmEventType.UserPromptSubmitBlocked]: 'user_prompt_blocked',
  })[type];

/**
 * One model round of the loop: the events go to `host.onModelEvent`, the
 * calls of an attempt a retry or fallback replaced are dropped, and the
 * client's terminal events become a stop reason. A surface that still runs
 * its own tool step calls it directly.
 */
export async function runModelRound(
  source: LlmClient | ModelRoundSource,
  round: AgentLoopRound,
  signal: AbortSignal,
  host: Pick<AgentLoopHost, 'onModelEvent'>,
): Promise<{
  turn?: Turn;
  calls: ToolCallRequestInfo[];
  stop?: AgentLoopStopReason;
}> {
  const calls: ToolCallRequestInfo[] = [];
  let stop: AgentLoopStopReason | undefined;
  const stream: AsyncIterator<ServerLlmStreamEvent, Turn | undefined> =
    isModelRoundSource(source)
      ? source.sendRound(round, signal)
      : source.sendMessageStream(
          round.parts,
          signal,
          round.promptId,
          round.options,
        );
  let finished = false;
  try {
    for (;;) {
      const next = await stream.next();
      if (next.done) {
        finished = true;
        return { turn: next.value, calls, stop };
      }
      const event = next.value;
      let discardedCalls: ToolCallRequestInfo[] = [];
      if (
        event.type === LlmEventType.Retry ||
        event.type === LlmEventType.ModelFallback
      ) {
        discardedCalls = calls.splice(0);
      } else if (event.type === LlmEventType.ToolCallRequest) {
        calls.push(event.value);
      } else if (event.type !== LlmEventType.UserCancelled || signal.aborted) {
        stop ??= stopReasonOf(event.type);
      }
      const surfaceStop = await host.onModelEvent?.(event, discardedCalls);
      if (surfaceStop) return { calls, stop: stop ?? surfaceStop };
    }
  } finally {
    // The surface stopped the round or threw out of an event: close the
    // client's turn too.
    if (!finished) await stream.return?.(undefined);
  }
}

export interface ToolBatchOptions {
  config: Config;
  /**
   * Counts the executed calls toward the session's tool calls. An agent with
   * its own chat leaves it out.
   */
  client?: Pick<LlmClient, 'recordCompletedToolCall'>;
  /** Cancels the batch, as the loop's signal does. */
  signal: AbortSignal;
  /** The signal tools run under, when it differs from `signal`. */
  toolSignal?: AbortSignal;
  host?: AgentLoopHost;
  duplicates: AgentLoopDuplicateState;
  /** Keeps distinct classes of calls from claiming each other's provider IDs. */
  duplicateStateForCall?(request: ToolCallRequestInfo): AgentLoopDuplicateState;
  executor: AgentLoopToolExecutor;
  /**
   * Finish and record a batch `signal` cancelled and return its results,
   * with the stop reason `cancelled`, for a surface that keeps them.
   */
  keepCancelledResults?: boolean;
  /**
   * Leave each result unrecorded and return its recording as `record` on
   * `responses`, for a surface that records only the results it sends.
   */
  deferRecording?: boolean;
}

export interface ToolBatchResult {
  /** The results in request order, finalized, as the next round sends them. */
  parts: Part[];
  /**
   * The same parts by call, for a surface that drops some calls' results.
   * Absent when the batch stopped before it answered any call.
   */
  responses?: Array<{
    callId: string;
    parts: Part[];
    /** Records the result, when the batch deferred recording. */
    record?: () => void;
  }>;
  stop?: AgentLoopStopReason;
}

/**
 * One tool batch of the loop: duplicates, selection, one executor run, the
 * results in request order, finalized and recorded. A surface that still
 * runs its own model loop calls it directly.
 */
export async function runToolBatch(
  calls: ToolCallRequestInfo[],
  options: ToolBatchOptions,
): Promise<ToolBatchResult> {
  const { config, client, signal, duplicates, executor } = options;
  const host = options.host ?? {};
  const toolSignal = options.toolSignal ?? signal;
  const duplicateStateFor = (request: ToolCallRequestInfo) =>
    options.duplicateStateForCall?.(request) ?? duplicates;
  const providerKey = (request: ToolCallRequestInfo) =>
    request.providerCallId ?? (request.callId || undefined);
  const isReplay = (
    request: ToolCallRequestInfo,
    state: AgentLoopDuplicateState,
  ) => {
    const key = providerKey(request);
    return key
      ? isReplayOfHandledToolCall(
          state.handled,
          key,
          getCachedToolCallFingerprint(request, request.name, request.args),
        )
      : false;
  };

  const seenCallIds = new Set<string>();
  const unique: ToolCallRequestInfo[] = [];
  const repeated: ToolCallRequestInfo[] = [];
  for (const request of calls) {
    if (request.callId && seenCallIds.has(request.callId)) {
      repeated.push(request);
      continue;
    }
    if (request.callId) seenCallIds.add(request.callId);
    unique.push(request);
  }
  const callsByDuplicateState = new Map<
    AgentLoopDuplicateState,
    ToolCallRequestInfo[]
  >();
  for (const request of [...unique, ...repeated]) {
    const state = duplicateStateFor(request);
    const group = callsByDuplicateState.get(state);
    if (group) group.push(request);
    else callsByDuplicateState.set(state, [request]);
  }
  for (const [state, group] of callsByDuplicateState) {
    if (
      findRepeatedDuplicateProviderToolCall(
        group,
        providerKey,
        (request) => isReplay(request, state),
        state.responded,
      )
    ) {
      return { parts: [], stop: 'duplicate_provider_call' };
    }
  }

  const results = new Map<ToolCallRequestInfo, AgentLoopToolResult>();
  let ended = false;
  const deliver = (result: AgentLoopToolResult) => {
    results.set(result.request, result);
    if (host.onToolResult?.(result) === true) ended = true;
  };
  const answer = (
    request: ToolCallRequestInfo,
    response: ToolCallResponseInfo,
    origin: AgentLoopToolResult['origin'],
  ) =>
    deliver({
      request,
      executionRequest: request,
      response,
      status: response.error ? 'error' : 'success',
      origin,
    });

  const executable: ToolCallRequestInfo[] = [];
  for (const request of unique) {
    const key = providerKey(request);
    const state = duplicateStateFor(request);
    if (key && isReplay(request, state)) {
      markDuplicateProviderToolCallResponseSent(key, state.responded);
      answer(
        request,
        createDuplicateProviderToolCallResponse(request),
        'replayed',
      );
      continue;
    }
    if (key) {
      recordHandledToolCall(
        state.handled,
        key,
        getCachedToolCallFingerprint(request, request.name, request.args),
      );
    }
    executable.push(request);
  }

  const selected = new Set(host.selectCalls?.(executable, calls) ?? executable);
  const toRun = executable.filter((request) => selected.has(request));
  const outputHandlers = new Map<string, OutputUpdateHandler>();
  for (const request of toRun) {
    const handler = host.outputHandler?.(request);
    if (handler) outputHandlers.set(request.callId, handler);
  }
  const launches = new Map<string, boolean>();
  let offered = 0;
  const offerUntil = (
    end: number,
    settled: readonly AgentLoopSettledCall[],
  ) => {
    for (; offered < end; offered++) {
      const request = toRun[offered];
      launches.set(
        request.callId,
        host.beforeToolLaunch?.(request, settled) ?? true,
      );
    }
  };
  const completed =
    toRun.length === 0
      ? []
      : await executor.run(toRun, toolSignal, {
          beforeLaunch: (request, settled) => {
            offerUntil(
              toRun.findIndex(({ callId }) => callId === request.callId) + 1,
              settled,
            );
            return launches.get(request.callId) === true;
          },
          output: (callId, chunk) =>
            outputHandlers.get(callId)?.(callId, chunk),
        });
  offerUntil(toRun.length, completed);
  const completedByCallId = new Map(
    completed.map((call) => [call.request.callId, call]),
  );

  const aborted = signal.aborted;
  const planModeEntry = findPlanModeEntryBatchBoundaryIndex(
    toRun.map(({ name }) => name),
  );
  let terminateTurn = false;
  for (const [index, request] of toRun.entries()) {
    const call = completedByCallId.get(request.callId);
    if (!call || !launches.get(request.callId)) continue;
    terminateTurn ||= call.response.terminateTurn === true;
    // A plan-mode entry's siblings never ran.
    if (
      !call.recorded &&
      (planModeEntry === undefined || index === planModeEntry)
    ) {
      client?.recordCompletedToolCall(
        call.request.name,
        call.request.args as Record<string, unknown>,
      );
    }
    deliver(executedResult(request, call));
  }
  // Nothing is sent or recorded after an abort, which the surface routes,
  // unless a result already ended the loop.
  if (aborted && !ended && !options.keepCancelledResults) {
    return { parts: [], stop: 'cancelled' };
  }
  for (const request of executable) {
    if (results.has(request)) continue;
    answer(
      request,
      skippedResponse(request, host.skippedOutput?.(request) ?? ''),
      'skipped',
    );
  }
  for (const request of repeated) {
    const key = providerKey(request);
    if (!key) continue;
    markDuplicateProviderToolCallResponseSent(
      key,
      duplicateStateFor(request).responded,
    );
    answer(
      request,
      createDuplicateProviderToolCallResponse(request),
      'duplicate',
    );
  }

  const ordered = calls.flatMap((request) => {
    const result = results.get(request);
    return result ? [result] : [];
  });
  const finalized = await finalizeToolResponses(
    config,
    ordered.map(({ request, response, executionRequest }) => ({
      callId: request.callId,
      toolName: executionRequest.name,
      responseParts: response.responseParts,
      persistedOutputFiles: response.persistedOutputFiles,
      artifacts: response.artifacts,
    })),
    new Map(ordered.map(({ request }) => [request.callId, request.prompt_id])),
  );
  const parts: Part[] = [];
  const responses: NonNullable<ToolBatchResult['responses']> = [];
  ordered.forEach(({ request, executionRequest, response, status }, index) => {
    const responseParts = finalized[index].responseParts;
    parts.push(...responseParts);
    // The recorder is resolved when the result is written, as the surface
    // may record it later.
    const record = () => {
      const provenance = goalToolResultProvenance(
        executionRequest,
        responseParts,
      );
      config.getChatRecordingService?.()?.recordToolResult?.(
        responseParts,
        {
          callId: request.callId,
          status,
          resultDisplay: response.resultDisplay,
          persistedOutputFiles: finalized[index].persistedOutputFiles,
          artifacts: finalized[index].artifacts,
          error: response.error,
          errorType: response.errorType,
          executionStatus: response.executionStatus,
        },
        ...(provenance ? ([provenance] as const) : ([] as const)),
      );
    };
    if (options.deferRecording) {
      responses.push({ callId: request.callId, parts: responseParts, record });
    } else {
      responses.push({ callId: request.callId, parts: responseParts });
      record();
    }
  });

  if (aborted && !ended) return { parts, responses, stop: 'cancelled' };
  if (ended) return { parts, responses, stop: 'surface_ended' };
  if (terminateTurn && (host.endsOnTerminateTurn?.() ?? true)) {
    return { parts, responses, stop: 'tool_ended_turn' };
  }
  return { parts, responses };
}

function executedResult(
  request: ToolCallRequestInfo,
  call: AgentLoopSettledCall,
): AgentLoopToolResult {
  return {
    request,
    executionRequest: call.request,
    response: call.response,
    status: call.status,
    origin: 'executed',
  };
}

function skippedResponse(
  request: ToolCallRequestInfo,
  output: string,
): ToolCallResponseInfo {
  return {
    callId: request.callId,
    responseParts: [
      {
        functionResponse: {
          id: request.callId,
          name: request.name,
          response: { output },
        },
      },
    ],
    resultDisplay: output,
    error: undefined,
    errorType: undefined,
    executionStatus: 'not_started',
  };
}

/** One `CoreToolScheduler` for the whole batch. */
export function createSchedulerExecutor(
  config: Config,
  options: Partial<SchedulerOptions> = {},
  runtimeView?: RuntimeContentGeneratorView,
): AgentLoopToolExecutor {
  return {
    run: (requests, signal, hooks) =>
      new Promise<CompletedToolCall[]>((resolve, reject) => {
        const batch = new Set(requests.map(({ callId }) => callId));
        const settled = new Map<string, CompletedToolCall>();
        // Calls an `exec` script makes report through the same callbacks;
        // their output belongs to the `exec` call.
        const parents = new Map<string, string>();
        const scheduler = new CoreToolScheduler({
          getPreferredEditor: () => undefined,
          onEditorClose: () => {},
          ...options,
          config,
          outputUpdateHandler: (callId, chunk) => {
            options.outputUpdateHandler?.(callId, chunk);
            hooks.output(parents.get(callId) ?? callId, chunk);
          },
          onToolCallsUpdate: (toolCalls) => {
            for (const call of toolCalls) {
              const { callId, parentCallId } = call.request;
              if (!batch.has(callId)) {
                if (parentCallId) parents.set(callId, parentCallId);
              } else if (
                call.status === 'success' ||
                call.status === 'error' ||
                call.status === 'cancelled'
              ) {
                settled.set(callId, call);
              }
            }
            options.onToolCallsUpdate?.(toolCalls);
          },
          beforeToolLaunch: (call: ScheduledToolCall) =>
            hooks.beforeLaunch(call.request, [...settled.values()]),
          onAllToolCallsComplete: async (completedCalls) => {
            await options.onAllToolCallsComplete?.(completedCalls);
            resolve(completedCalls);
          },
        });
        scheduler.schedule(requests, signal, runtimeView).catch(reject);
      }),
  };
}
