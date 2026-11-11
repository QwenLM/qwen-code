/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  withSessionSelection,
  withTestSelection,
} from '../test-utils/request-model.js';
import { createModelStreamResponse } from '../provider/modelStreamResponseFactory.js';
import { ModelInferenceError } from '../provider/modelInferenceError.js';
import {
  hasModelRequestObservationListeners,
  publishModelRequestObservation,
  type ModelRequestProgressIdentity,
} from '../model-request/request-scope.js';
import type {
  ModelRequestObservation,
  ModelRequestObserver,
} from '../model-request/types.js';
import { ClientError, toClientError } from '../client/clientError.js';
import { EmptyAssistantCompletionError } from '../model-request/empty-assistant-completion.js';
import { buildMessagesStreamEvents } from '../provider/transport/impl/messages-factory/response/messagesStreamRespFactory.js';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages';
import path from 'node:path';
import { CompressionStatus } from './turn-events.js';
import { buildForkContextMessages } from '../utils/forkContextUtils.js';
import * as gitContext from '../context/system-context.js';
import { SessionContextAttachment } from '../attachments/models/session-context-attachment.js';
import { createCompactBoundaryMessage } from '../compression-v2/boundary.js';
import * as ptlRetry from '../compression-v2/ptl-retry.js';
import { isContextAttachmentMessage } from '../attachments/context-messages.js';
import { getEnvironmentAttachments } from '../attachments/generators/environment-generators.js';
import { runWithCwdOverride } from '../utils/Shell.js';
import * as suggestionFeature from '../config-service/features/promptSuggestion.js';
import {
  fixedSelection,
  policySelection,
  testProviderModel,
} from '../test-utils/request-model.js';
import { getBusinessInfoFromContext } from '../utils/sessionIdContext.js';
import { HookOutputAttachment } from '../attachments/models/hook-attachments.js';
import { createAttachmentMessage } from '../attachments/factory.js';
import * as requestTokenCounting from '../utils/request-token-count.js';
import * as sessionStateUsage from '../services/session-state-usage.js';
import * as protocol from '../protocol/index.js';
import * as transcriptConversions from '../protocol/transcript/conversions.js';
import * as requestConverter from '../protocol/provider/request-converter.js';
import { TaskRegistry } from '../tasks/task-registry.js';
import { mergeModelConfig } from '../provider/model/modelConfig.js';
import { CustomModelSelector } from '../provider/impl/customModelSelector.js';
import { CustomProviderConfig } from '../provider/impl/customProviderConfig.js';
import { OPENAI_CHAT_COMPLETIONS } from '../provider/transport/modelProtocol.js';
import { ModelNotFoundError } from '../utils/httpErrors.js';
import type { CompressOptions } from '../compression-v2/pipeline.js';
import type { ModelStreamRequest } from '../provider/modelStreamRequest.js';
import type { ModelSelectContext } from '../provider/model/modelSelectContext.js';
import type { ModelSelection } from '../provider/model/modelSelection.js';
import {
  testModelResolution,
  testRequestConfig,
} from '../test-utils/model-resolution.js';
import { QueryTurn, type QueryTurnOptions } from './query-turn.js';
import {
  DoomLoopGuard,
  REPEATED_TOOL_CALL_TERMINAL_REASON,
  buildRepeatedToolCallKey,
} from './doom-loop-guard.js';
import { runSideQuestion } from './side-question.js';
import type {
  TurnCompleteInput,
  TurnHookModule,
  TurnStepInput,
} from './turn-hooks.js';

import { systemPromptFromText } from '../prompts/system-prompt.js';
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import '../test-utils/mock-undici-fetch-with-global.js';
import { prepareImageBlocks } from '../hooks/imagePrepare.js';
import type {
  ToolCallResult,
  ToolExecuteContext,
  ToolExecutionBatch,
  ToolExecutor,
} from '../tool-executor/index.js';
import { waitForExecutionWithSubagentEvents } from '../tool-executor/streaming/tool-execution-wait.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ToolBridgeExecuteResult } from './tool-result.js';

interface MockToolBridge {
  getToolSchema: (
    modelKey?: string,
    schemaContext?: unknown,
    agentContext?: unknown,
  ) => ModelStreamTool[];
  execute: ToolExecutor['execute'];
}
import type { ModelToolUseBlock } from '../provider/event/modelCompleteEvent.js';
import type {
  ModelStreamTool,
  ModelToolChoice,
} from '../provider/modelStreamRequest.js';
import type { ToolUseContext } from '../tools/tool-types.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import { getThinkingTokenCount } from '../protocol/provider/usage-converter.js';
import {
  createBackgroundTasksChangedEvent,
  createTaskStartedEvent,
  drainSubagentSdkEvents,
  enqueueSubagentSdkEvent,
} from '../agents/subagent-sdk-events.js';
import {
  isDurableQueryEvent,
  type QueryEvent,
  type Terminal,
} from './query-event.js';
import type {
  ContentBlockParam,
  Message,
} from '../protocol/transcript/message.js';
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '../protocol/transcript/conversions.js';
import { REJECT_MESSAGE } from '../protocol/transcript/message-utils.js';
import { _resetQueueForTest, enqueue, getCommandQueue } from '../services/messageQueueManager.js';
import { HookEventName } from '../hooks/types.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before the import of the module under test
// ---------------------------------------------------------------------------

const mockFetch =
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const mockEmitToolExecutionFinished = vi.hoisted(() => vi.fn());
vi.mock('../utils/diagnosticInterceptors.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/diagnosticInterceptors.js')>();
  return {
    ...actual,
    emitToolExecutionFinished: mockEmitToolExecutionFinished,
  };
});

const mockReportBusinessFinish = vi.hoisted(() =>
  vi.fn<(params: unknown) => Promise<void>>(),
);
vi.mock('../qoder/business-finish.js', () => ({
  reportBusinessFinish: mockReportBusinessFinish,
}));

// Controllable stream events consumed by the provider mocks.
// For multi-turn tests, we support an array-of-arrays: each sub-array is
// consumed on one call. Single-array usage (legacy) is auto-wrapped.
const mockStreamEvents: unknown[] = [];
const mockStreamTurns: unknown[][] = [];
/** 每次推理端口收到的请求，按调用顺序记录。 */
const mockInferenceRequests: unknown[] = [];
const DRAIN_RESPONSE_BODY = Symbol('drain-response-body');
let streamCallIndex = 0;

// Product module assembly is replaced only in this test; query keeps its normal entry point.
const { mockTurnModules } = vi.hoisted(() => ({
  mockTurnModules: [] as Array<(options: QueryTurnOptions) => TurnHookModule>,
}));
vi.mock('./query-turn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./query-turn.js')>();
  return {
    ...actual,
    QueryTurn: class extends actual.QueryTurn {
      constructor(options: QueryTurnOptions) {
        super({
          ...options,
          modules: [
            ...mockTurnModules.map((createModule) => createModule(options)),
            ...options.modules,
          ],
        });
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Import AFTER mocks are set up
// ---------------------------------------------------------------------------

import { createQueryEventBus, query, type QueryParams } from './agent-loop.js';
import { runForkedAgent } from './forkedAgent.js';
import {
  READ_FILE_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
} from '../tools/tool-names.js';
import { createAttachmentContext } from '../attachments/get-attachments.js';
import type { Config } from '../config/config.js';
import { uiTelemetryService } from '../services/session-stats.js';
import {
  UNDELIVERED_TOOL_INCOMPLETE_ARGUMENTS_RESULT,
  UNDELIVERED_TOOL_NOT_DISPATCHED_RESULT,
} from './tool-stream-settlement.js';
import {
  createTmpDir,
  cleanupTmpDir,
} from '../test-utils/file-system-test-helpers.js';
import { join } from 'node:path';
import { createTestTranscriptWriter } from '../services/transcript/testing/fixtures.js';
import { TranscriptRepository } from '../services/transcript/repository.js';

/**
 * Tests assign this directly; `queryT` threads it into `queryT({ config })`, the
 * same explicit path production uses.
 */
let testRuntimeConfig: Config | undefined;
// Fixture model configures the session; it is never passed to query().
type QueryTestOptions = Omit<Parameters<typeof query>[0], 'sessionId'> & {
  sessionId?: string;
  model?: string;
  selectModel?: import('../test-utils/request-model.js').TestModelSelection['resolve'];
  /** Combined mock split into the agent registry and session executor. */
  toolBridge?: MockToolBridge;
};

function mockTooling(legacy: MockToolBridge): {
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
} {
  const batches = new Map<
    string,
    { blocks: ModelToolUseBlock[]; executions: Array<Promise<ToolCallResult>> }
  >();
  const batchFor = (responseId: string) => {
    let batch = batches.get(responseId);
    if (!batch) {
      batch = { blocks: [], executions: [] };
      batches.set(responseId, batch);
    }
    return batch;
  };
  // Mirrors the streaming executor's doom-loop guard: the fake bridge still
  // has to refuse the fifth identical call instead of running it.
  const repeatedCalls = new DoomLoopGuard();
  const record = (
    block: ModelToolUseBlock,
    responseId: string,
    promise: Promise<ToolCallResult>,
  ): Promise<ToolCallResult> => {
    const batch = batchFor(responseId);
    batch.blocks.push(block);
    batch.executions.push(promise);
    // Keep an early rejection from surfacing as unhandled while in flight.
    promise.catch(() => undefined);
    return promise;
  };
  const toolExecutor = {
    execute: (
      block: ModelToolUseBlock,
      ctx: Parameters<ToolExecutor['execute']>[1],
    ) => {
      const checked = repeatedCalls.check(block);
      if (!checked.allowed && checked.detection) {
        const detection = checked.detection;
        if (ctx.repeatedCallStats) {
          ctx.repeatedCallStats.loopDetected = true;
          ctx.repeatedCallStats.approvalCount += 1;
          ctx.repeatedCallStats.approvalRejectedCount += 1;
        }
        const message = `Repeated tool call detected: ${detection.toolName} was requested ${detection.repeatCount} recent times with identical input.`;
        const refused = {
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: message,
          is_error: true,
        };
        return record(
          block,
          ctx.responseId,
          Promise.resolve({
            block: refused,
            supplementaryMessages: [],
            historyMessage: protocol.createToolResultMessage(
              [refused],
              ctx.assistantMessageUuid ?? block.id,
            ),
            control: {
              settlement: 'completed' as const,
              terminalReason: REPEATED_TOOL_CALL_TERMINAL_REASON,
              permissionDenial: {
                tool_name: block.name,
                tool_use_id: block.id,
                tool_input: block.input,
                message,
                decision_reason_type: 'repeatedToolCall' as const,
                decision_reason: message,
              },
            },
          }),
        );
      }
      const settled = legacy.execute(block, ctx).then((result) => {
        if (
          (result.control as { repeatNeutral?: boolean }).repeatNeutral === true
        ) {
          repeatedCalls.neutralize(
            buildRepeatedToolCallKey(block.name, block.input),
          );
        }
        return result;
      });
      return record(block, ctx.responseId, settled);
    },
    async *waitForExecutions(batch: ToolExecutionBatch) {
      const pending = batches.get(batch.responseId);
      const blocks = pending?.blocks ?? [];
      // Forward subagent SDK events through the production waiter; only the
      // tool call execution itself is faked here.
      const settled = yield* waitForExecutionWithSubagentEvents(
        batch.sessionId,
        blocks,
        Promise.all(pending?.executions ?? []),
        batch.signal,
        batch.includeSessionSnapshots ?? true,
      );
      // Started calls keep their results: the stop path may race this wait and
      // still has to report them, so the batch is only released by a stop.
      return mockSummarizeExecutions(blocks, settled);
    },
    stopExecution: async (batch: {
      responseId: string;
      assistantMessageUuid?: string;
      failure?: { error: unknown; cancelled: boolean };
    }) => {
      const pending = batches.get(batch.responseId);
      batches.delete(batch.responseId);
      const blocks = pending?.blocks ?? [];
      return batch.failure
        ? mockFailedExecutions(blocks, {
            error: batch.failure.error,
            cancelled: batch.failure.cancelled,
            assistantMessageUuid: batch.assistantMessageUuid,
          })
        : mockSummarizeExecutions(
            blocks,
            await Promise.all(pending?.executions ?? []),
          );
    },
    dispose: vi.fn(),
  } as unknown as ToolExecutor;
  return {
    toolRegistry: {
      getSchema: (modelKey?: string, schemaContext?: unknown) =>
        legacy.getToolSchema(modelKey, schemaContext),
    } as unknown as ToolRegistry,
    toolExecutor,
  };
}
function queryT(opts: QueryTestOptions, runQuery: typeof query = query) {
  const config =
    opts.config ??
    (testRuntimeConfig?.getCustomProviderRegistry
      ? testRuntimeConfig
      : undefined);
  if (config) {
    const defaults = testRequestConfig();
    for (const [key, value] of Object.entries(defaults)) {
      if (!(key in config)) Object.assign(config, { [key]: value });
    }
  }
  const needsInferenceFixture = !config?.hasModelProviderManager?.();
  const { toolBridge: legacyToolBridge, ...queryInput } = opts;
  const options = withTestSelection({
    ...queryInput,
    ...(legacyToolBridge ? mockTooling(legacyToolBridge) : {}),
    config,
    sessionId: opts.sessionId ?? 'test-session',
    selectModel:
      opts.selectModel ?? fixedSelection(opts.model ?? 'test-model').resolve,
  });
  if (needsInferenceFixture) {
    Object.assign(options.config!.getModelProviderManager(), {
      // 选模仍走正式入口，推理端口只提供受控的协议事件。
      inference: vi.fn(async (request: unknown) => {
        mockInferenceRequests.push(request);
        const frames =
          mockStreamTurns.length > 0
            ? (mockStreamTurns[streamCallIndex++] ?? [])
            : mockStreamEvents;
        async function* source() {
          for (const frame of frames) {
            if (frame instanceof Error) throw frame;
            if (frame === DRAIN_RESPONSE_BODY) continue;
            yield frame as RawMessageStreamEvent;
          }
        }
        return createModelStreamResponse(buildMessagesStreamEvents(source()));
      }),
    });
  }
  const { model, ...queryOptions } = options;
  if (model !== undefined && needsInferenceFixture) {
    queryOptions.config = Object.assign(Object.create(queryOptions.config!), {
      getModel: () => model,
    });
  }
  return runQuery(queryOptions);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Carries only the model-request knobs under test, but stays viable for
 * `queryT({ config })`, which reads `getWorkspaceContext` and the
 * custom-provider surface outright.
 */
function createRequestConfig(
  overrides: Partial<
    Pick<Config, 'getMaxAttempts' | 'getRetryFetchErrors'>
  > = {},
): Config {
  return {
    ...testRequestConfig(),
    getWorkspaceContext: () => ({ getDirectories: () => [] }),
    ...overrides,
  } as unknown as Config;
}

/**
 * Drain all events from the query generator, capturing both yielded
 * events and the Terminal return value.
 */
async function drain(gen: AsyncGenerator<QueryEvent, Terminal>): Promise<{
  events: QueryEvent[];
  terminal: Terminal;
}> {
  const events: QueryEvent[] = [];
  let result = await gen.next();
  while (!result.done) {
    events.push(result.value);
    result = await gen.next();
  }
  return { events, terminal: result.value };
}

function isRuntimeAssistantEvent(event: QueryEvent): event is QueryEvent & {
  type: 'assistant';
} {
  return event.type === 'assistant';
}

function isRuntimeToolResultEvent(event: QueryEvent): event is QueryEvent & {
  type: 'user';
} {
  return (
    event.type === 'user' &&
    Array.isArray(event.message.content) &&
    event.message.content.some((block) => block.type === 'tool_result')
  );
}

function isPermissionDeniedEvent(event: QueryEvent): event is QueryEvent & {
  type: 'system';
  subtype: 'permission_denied';
  tool_use_id: string;
  decision_reason_type?: string;
} {
  return event.type === 'system' && event.subtype === 'permission_denied';
}

function getToolResultBlocks(
  event: QueryEvent & {
    type: 'user';
  },
): Array<Extract<ContentBlockParam, { type: 'tool_result' }>> {
  const content = event.message.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(
    (block): block is Extract<ContentBlockParam, { type: 'tool_result' }> =>
      block.type === 'tool_result',
  );
}

/** Set up mockStreamEvents with a standard text response sequence. */
function setStreamEvents(
  text: string,
  options: {
    thinkingTokens?: number;
    totalTokens?: number;
    credits?: number;
    originalCredits?: number;
    billable?: boolean;
  } = {},
) {
  const messageDeltaUsage: Record<string, unknown> = { output_tokens: 5 };
  if (options.thinkingTokens !== undefined) {
    messageDeltaUsage['thinking_tokens'] = options.thinkingTokens;
  }
  if (options.totalTokens !== undefined) {
    messageDeltaUsage['total_tokens'] = options.totalTokens;
  }
  if (options.credits !== undefined) {
    messageDeltaUsage['credits'] = options.credits;
  }
  if (options.originalCredits !== undefined) {
    messageDeltaUsage['original_credits'] = options.originalCredits;
  }
  if (options.billable !== undefined) {
    messageDeltaUsage['billable'] = options.billable;
  }

  mockStreamEvents.length = 0;
  mockStreamEvents.push(
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        model: 'test-model',
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
    {
      type: 'content_block_stop',
      index: 0,
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: messageDeltaUsage,
    },
    {
      type: 'message_stop',
    },
  );
}

/** Create a mock Response for successful fetch. */
function mockOkResponse(headers = new Headers()): Response {
  return new Response('', {
    status: 200,
    headers,
  });
}

/**
 * Create a mock SSE Response carrying a single `data:` chunk. A Response body
 * can only be consumed once, so hand out a fresh one per attempt
 * (`mockImplementation`, not `mockResolvedValue`) whenever a test replays.
 */
function sseResponse(chunk: string): Response {
  return new Response(`data: ${chunk}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** A chunk carrying visible answer text — replay-unsafe on the runner side. */
const VISIBLE_CONTENT_SSE_CHUNK =
  '{"id":"content","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}';

/**
 * The wire-level mid-stream peer close. The shape is the input contract of the
 * runner's retryable-error classifier, so keep exactly one copy of it.
 */
function makeSocketCloseError(): Error {
  return Object.assign(new Error('other side closed'), {
    name: 'SocketError',
    code: 'UND_ERR_SOCKET',
  });
}

function recordingPromptResolver() {
  return vi.fn<NonNullable<QueryParams['resolveSystemPrompt']>>(
    async (model) => ({
      blocks: systemPromptFromText(`prompt:${model}`),
      source: 'default',
      bundle: 'full',
    }),
  );
}

/**
 * Create a mock ToolBridge with controllable execute behavior. The history
 * message is built the way the streaming executor builds it: image blocks go
 * through the ImagePrepare hook before the result is persisted.
 */
async function makeToolCallResult(
  block: ModelToolUseBlock,
  legacy: ToolBridgeExecuteResult,
  ctx: Pick<
    ToolExecuteContext,
    'assistantMessageUuid' | 'imagePreparation' | 'signal'
  >,
): Promise<ToolCallResult> {
  const resultBlock =
    legacy.toolResults.find((result) => result.tool_use_id === block.id) ??
    legacy.toolResults[0] ?? {
      type: 'tool_result' as const,
      tool_use_id: block.id,
      content: '',
      is_error: false,
    };
  const message = legacy.allMessages.find(
    (result) =>
      result.message.type === 'tool_result' &&
      result.message.toolCallId === block.id,
  );
  const control = {
    contextModifier: message?.contextModifier?.modifyContext,
    settlement: legacy.settlement?.get(block.id) ?? 'completed',
    terminalReason: legacy.terminalReason,
    permissionDenial: legacy.permissionDenials?.find(
      (denial) => denial.tool_use_id === block.id,
    ),
    // The legacy bridge asked the loop to end the turn through a stop message.
    ...(legacy.allMessages.some(
      (entry) => (entry.message as { type?: string }).type === 'stop',
    )
      ? { stopRequested: true }
      : {}),
    // The legacy bridge reports neutral polls out of band; carry the flag so
    // the fake executor can clear the doom-loop streak like production does.
    ...(legacy.repeatNeutralToolResultIds?.has(block.id)
      ? { repeatNeutral: true }
      : {}),
  } as ToolCallResult['control'];
  let historyBlock = resultBlock;
  if (Array.isArray(resultBlock.content) && ctx.imagePreparation) {
    try {
      historyBlock = {
        ...resultBlock,
        content: await prepareImageBlocks(resultBlock.content, {
          ...ctx.imagePreparation,
          signal: ctx.signal,
        }),
      };
    } catch (error) {
      // A cancelled turn keeps the untouched content, as the real executor does.
      if (!ctx.signal?.aborted) throw error;
    }
  }
  return {
    block: resultBlock,
    supplementaryMessages: [],
    historyMessage: createToolResultMessage(
      [historyBlock],
      ctx.assistantMessageUuid ?? block.id,
    ),
    control,
  };
}

function mockSummarizeExecutions(
  blocks: readonly ModelToolUseBlock[],
  settled: readonly ToolCallResult[],
) {
  const byId = new Map(
    settled.map((result) => [result.block.tool_use_id, result]),
  );
  const results = blocks
    .map((block) => byId.get(block.id))
    .filter((result): result is ToolCallResult => result !== undefined);
  return {
    results,
    toolResults: results.map((result) => result.block),
    historyMessages: results.map((result) => result.historyMessage),
    settlements: new Map(
      results.map((result) => [
        result.block.tool_use_id,
        result.control.settlement,
      ]),
    ),
    permissionDenials: results.flatMap((result) =>
      result.control.permissionDenial ? [result.control.permissionDenial] : [],
    ),
    terminalReason: results.some(
      (result) =>
        result.control.terminalReason === REPEATED_TOOL_CALL_TERMINAL_REASON,
    )
      ? REPEATED_TOOL_CALL_TERMINAL_REASON
      : undefined,
    hasUnknownOutcomes: results.some(
      (result) => result.control.settlement === 'unknown',
    ),
  };
}

function mockFailedExecutions(
  blocks: readonly ModelToolUseBlock[],
  failure?: {
    error?: unknown;
    cancelled?: boolean;
    assistantMessageUuid?: string;
  },
) {
  const content =
    failure?.error === undefined
      ? 'Error'
      : `Error: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`;
  const results = blocks.map((block) => {
    const resultBlock = {
      type: 'tool_result' as const,
      tool_use_id: block.id,
      content,
      is_error: true,
      ...(failure?.cancelled ? { toolDenialKind: 'interrupted' as const } : {}),
    };
    return {
      block: resultBlock,
      supplementaryMessages: [],
      historyMessage: createToolResultMessage(
        [resultBlock],
        failure?.assistantMessageUuid ?? block.id,
      ),
      control: { settlement: 'not_started' as const },
    } as ToolCallResult;
  });
  return {
    results,
    toolResults: results.map((result) => result.block),
    historyMessages: results.map((result) => result.historyMessage),
    settlements: new Map(
      results.map((result) => [
        result.block.tool_use_id,
        result.control.settlement,
      ]),
    ),
    permissionDenials: [],
    hasUnknownOutcomes: false,
  };
}

/** Create a mock bridge with controllable per-block execute behavior. */
function createMockToolBridge(
  executeFn?: (
    blocks: ModelToolUseBlock[],
    signal: AbortSignal,
    toolUseContext?: ToolUseContext,
  ) => Promise<ToolBridgeExecuteResult>,
  schemas: ModelStreamTool[] = [],
): MockToolBridge {
  return {
    getToolSchema: vi.fn(() => schemas),
    execute: vi.fn(async (block: ModelToolUseBlock, ctx) => {
      if (!executeFn) {
        return {
          block: {
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: '',
            is_error: false,
          },
          supplementaryMessages: [],
          historyMessage: {} as never,
          control: { settlement: 'completed' as const },
        };
      }
      const legacy = await executeFn([block], ctx.signal, ctx.toolUseContext);
      return makeToolCallResult(block, legacy, ctx);
    }),
  } as unknown as MockToolBridge;
}

function createMockStreamingToolBridge(
  executeFn: (
    blocks: ModelToolUseBlock[],
    signal: AbortSignal,
    toolUseContext?: ToolUseContext,
  ) => Promise<ToolBridgeExecuteResult>,
  schemas: ModelStreamTool[] = [],
): MockToolBridge {
  return createMockToolBridge(executeFn, schemas);
}

/** Create stream events for a tool_use response. */
function makeToolUseStreamEvents(
  toolId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): unknown[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_tu',
        model: 'test-model',
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: toolId,
        name: toolName,
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(toolInput),
      },
    },
    {
      type: 'content_block_stop',
      index: 0,
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 5 },
    },
    {
      type: 'message_stop',
    },
  ];
}

function makeParallelToolUseStreamEvents(
  tools: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>,
): unknown[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_parallel_tu',
        model: 'test-model',
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    ...tools.flatMap((tool, index) => [
      {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: tool.id,
          name: tool.name,
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(tool.input),
        },
      },
      {
        type: 'content_block_stop',
        index,
      },
    ]),
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 5 },
    },
    {
      type: 'message_stop',
    },
  ];
}

/** Create stream events for a text response (end_turn). */
function makeTextStreamEvents(text: string): unknown[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_text',
        model: 'test-model',
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
    {
      type: 'content_block_stop',
      index: 0,
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 5 },
    },
    {
      type: 'message_stop',
    },
  ];
}

function makeMalformedToolUseStreamEvents(
  text = '',
  options: { includeContent?: boolean } = {},
): unknown[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_malformed_tool_use',
        model: 'test-model',
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    ...(options.includeContent === false
      ? []
      : [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          },
          {
            type: 'content_block_stop',
            index: 0,
          },
        ]),
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 5 },
    },
    {
      type: 'message_stop',
    },
  ];
}

const TEST_TOOL_SCHEMA: ModelStreamTool = {
  name: READ_FILE_TOOL_NAME,
  description: 'Read a file',
  parameters: { type: 'object' },
};

/** Create stream events for a partial response terminated by policy refusal. */
function makeRefusalStreamEvents(
  text: string,
  options: { includeContent?: boolean; includeToolUse?: boolean } = {},
): unknown[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_refusal',
        model: 'test-model',
        usage: { input_tokens: 30290, output_tokens: 0 },
      },
    },
    ...(options.includeContent === false
      ? []
      : [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          },
          {
            type: 'content_block_stop',
            index: 0,
          },
        ]),
    ...(options.includeToolUse
      ? [
          {
            type: 'content_block_start',
            index: 1,
            content_block: {
              type: 'tool_use',
              id: 'tool_refused',
              name: 'WriteFile',
              input: {},
            },
          },
          {
            type: 'content_block_delta',
            index: 1,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"path":"blocked.txt"}',
            },
          },
          {
            type: 'content_block_stop',
            index: 1,
          },
        ]
      : []),
    {
      type: 'message_delta',
      delta: { stop_reason: 'refusal' },
      usage: { output_tokens: 149 },
    },
    {
      type: 'message_stop',
    },
  ];
}

/** 构造因输出上限中止的正文或纯思考流。 */
function makeMaxTokensStreamEvents(
  text: string,
  contentType: 'text' | 'thinking' = 'text',
): unknown[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_max_tokens',
        model: 'test-model',
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block:
        contentType === 'thinking'
          ? { type: 'thinking', thinking: '' }
          : { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta:
        contentType === 'thinking'
          ? { type: 'thinking_delta', thinking: text }
          : { type: 'text_delta', text },
    },
    {
      type: 'content_block_stop',
      index: 0,
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens' },
      usage: { output_tokens: 5 },
    },
    {
      type: 'message_stop',
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Serialized history of the most recent model request. */
function lastRequestHistory() {
  return JSON.stringify(mockInferenceRequests.at(-1));
}

describe('query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTurnModules.length = 0;
    mockStreamEvents.length = 0;
    mockStreamTurns.length = 0;
    mockInferenceRequests.length = 0;
    streamCallIndex = 0;
    _resetQueueForTest();
    mockReportBusinessFinish.mockReset();
    mockReportBusinessFinish.mockResolvedValue(undefined);
    uiTelemetryService.clear();
    testRuntimeConfig = undefined;
  });

  it('overlays a host tool registry when Config exposes a getter', async () => {
    const baseRegistry = {
      getTool: () => undefined,
    } as unknown as ToolRegistry;
    const config = createRequestConfig();
    Object.defineProperty(config, 'toolRegistry', {
      get: () => baseRegistry,
    });
    config.getToolRegistry = () => baseRegistry;
    const bridge = createMockToolBridge();
    const tooling = mockTooling(bridge);
    mockStreamTurns.push(
      makeToolUseStreamEvents('host-tool', 'Read', { path: '/test.ts' }),
      makeTextStreamEvents('Done'),
    );

    const { terminal } = await drain(
      queryT({
        prompt: 'Use the host tool.',
        promptId: 'host-tool-registry',
        config,
        ...tooling,
      }),
    );

    expect(terminal.error).toBeUndefined();
    expect(terminal.reason).toBe('end_turn');
    expect(bridge.execute).toHaveBeenCalledOnce();
    const context = vi.mocked(bridge.execute).mock.calls[0][1].agentContext;
    expect(Object.getPrototypeOf(context)).toBe(config);
    expect(context.toolRegistry).toBe(tooling.toolRegistry);
    expect(config.toolRegistry).toBe(baseRegistry);
  });

  describe('Provider passive observation bridge', () => {
    type ObservedRequest = ModelStreamRequest & {
      qoder: { identity: ModelRequestProgressIdentity };
    };
    function response() {
      return createModelStreamResponse(
        buildMessagesStreamEvents(
          (async function* () {
            for (const event of makeTextStreamEvents('observed response'))
              yield event as RawMessageStreamEvent;
          })(),
        ),
      );
    }
    function setup(
      observer: ModelRequestObserver,
      inference: (
        request: ObservedRequest,
      ) => Promise<ReturnType<typeof response>>,
    ) {
      const options = withTestSelection({
        prompt: 'Observe this request',
        model: 'test-model',
        config: undefined as Config | undefined,
        sessionId: 'observation-session',
        promptId: 'observation-prompt',
        messages: [],
        maxTurns: 1,
        selectModel: fixedSelection('test-model').resolve,
        onModelRequestObservation: observer,
      });
      const run = vi.fn(inference);
      Object.assign(options.config!.getModelProviderManager(), {
        inference: run,
      });
      return { options, run };
    }

    it.each(['none', 'sync', 'async'] as const)(
      'observes fallback success and isolates observer failure=%s',
      async (failure) => {
        const records: ModelRequestObservation[] = [];
        let scope!: ModelRequestProgressIdentity;
        const observer: ModelRequestObserver = (record) => {
          records.push(record);
          if (failure === 'sync') throw new Error('observer failed');
          if (failure === 'async')
            return Promise.reject(new Error('async observer failed'));
          return undefined;
        };
        const { options, run } = setup(observer, async (request) => {
          scope = { ...request.qoder.identity };
          expect(hasModelRequestObservationListeners(scope)).toBe(true);
          expect(request).not.toHaveProperty('diagnostic');
          expect(request).not.toHaveProperty('onObservation');
          expect(request.qoder).not.toHaveProperty('onModelRequestObservation');
          return response();
        });
        const { terminal } = await drain(query(options));
        expect(terminal.reason).toBe('end_turn');
        expect(run).toHaveBeenCalledOnce();
        expect(records.map((record) => record.kind)).toEqual([
          'request_started',
          'request_finished',
        ]);
        expect(records[1]).toMatchObject({
          request_id: scope.requestId,
          initial_request_id: scope.requestId,
          model: 'test-model',
          data: {
            status: 'success',
            latency_ms: expect.any(Number),
            usage: { input_tokens: 10, output_tokens: expect.any(Number) },
          },
        });
        expect(JSON.stringify(records)).not.toContain('observed response');
        expect(hasModelRequestObservationListeners(scope)).toBe(false);
        await Promise.resolve();
      },
    );

    it('forwards real attempt IDs from Provider without adding a logical duplicate', async () => {
      const records: ModelRequestObservation[] = [];
      let scope!: ModelRequestProgressIdentity;
      const { options } = setup(
        (record) => {
          records.push(record);
        },
        async (request) => {
          scope = { ...request.qoder.identity };
          for (const [attempt, status] of [
            [1, 'error'],
            [2, 'success'],
          ] as const) {
            for (const kind of [
              'request_started',
              'request_finished',
            ] as const) {
              publishModelRequestObservation(scope, {
                kind,
                request_id: `physical-attempt-${attempt}`,
                initial_request_id: scope.requestId,
                model: 'test-model',
                at_ms: Date.now(),
                attempt,
                data: { status, retry_count: attempt - 1 },
              });
            }
          }
          return response();
        },
      );
      expect((await drain(query(options))).terminal.reason).toBe('end_turn');
      expect(records.map((record) => record.request_id)).toEqual([
        'physical-attempt-1',
        'physical-attempt-1',
        'physical-attempt-2',
        'physical-attempt-2',
      ]);
      expect(hasModelRequestObservationListeners(scope)).toBe(false);
      publishModelRequestObservation(scope, records[0]!);
      expect(records).toHaveLength(4);
    });

    it('observes the original fallback failure and releases its scope', async () => {
      const original = Object.assign(new Error('request denied'), {
        status: 403,
      });
      const records: ModelRequestObservation[] = [];
      let scope!: ModelRequestProgressIdentity;
      const { options, run } = setup(
        (record) => {
          records.push(record);
        },
        async (request) => {
          scope = { ...request.qoder.identity };
          throw original;
        },
      );
      const { terminal } = await drain(query(options));
      expect(terminal.reason).toBe('error');
      // The query keeps its existing user-facing 403 normalization; the
      // observation retains the original Provider failure before that mapping.
      expect(terminal.error).toMatchObject({ status: 403 });
      expect(run).toHaveBeenCalledOnce();
      expect(records.map((record) => record.kind)).toEqual([
        'request_started',
        'request_finished',
      ]);
      expect(records[1]).toMatchObject({
        data: {
          status: 'error',
          latency_ms: expect.any(Number),
          error_message: 'request denied',
        },
      });
      expect(hasModelRequestObservationListeners(scope)).toBe(false);
    });

    it('releases its observation subscription when the consumer returns early', async () => {
      const records: ModelRequestObservation[] = [];
      let scope: ModelRequestProgressIdentity | undefined;
      const { options } = setup(
        (record) => {
          records.push(record);
        },
        async (request) => {
          scope = { ...request.qoder.identity };
          return response();
        },
      );
      const stream = query(options);
      while (!scope) {
        const next = await stream.next();
        expect(next.done).toBe(false);
      }
      expect(hasModelRequestObservationListeners(scope)).toBe(true);
      await stream.return(undefined as never);
      expect(hasModelRequestObservationListeners(scope)).toBe(false);
      expect(records.at(-1)).toMatchObject({
        kind: 'request_finished',
        data: { status: 'abort' },
      });
    });
  });
  describe('main provider selection', () => {
    function setup(getModelPolicy?: Config['getModelPolicy']) {
      const getModel = vi.fn(async (key: string) => ({
        key,
        source: 'qoder',
        displayName: key,
        capabilities: {
          tools: true,
          vision: false,
          reasoning: {
            supported: true,
            supportedEfforts: ['low', 'high'] as const,
          },
          contextWindows: [{ tokens: 128000 }, { tokens: 256000 }],
        },
        limits: { maxContextTokens: 256000 },
      }));
      const manager = {
        getModel,
        listModels: async () => [
          await getModel('test-model'),
          await getModel('policy-model'),
        ],
        setMainModel: vi.fn(),
        select: vi.fn(
          async (
            input: ModelSelectContext & {
              readonly workdirs?: readonly string[];
            },
          ): Promise<ModelSelection> => ({
            model: await getModel(
              input.overrideSelection && 'model' in input.overrideSelection
                ? input.overrideSelection.model.key
                : 'test-model',
            ),
            config: mergeModelConfig(
              input.parentSelection?.config ?? {
                reasoning: { effort: 'high' },
                context: { contextWindow: 256000 },
              },
              input.overrideSelection?.config,
            ),
          }),
        ),
        inference: vi.fn(
          async (
            _request: ModelStreamRequest & {
              readonly qoder: {
                readonly workdirs?: readonly string[];
                readonly extraHeaders?: Readonly<Record<string, string>>;
              };
            },
          ) => {
            const frames =
              mockStreamTurns.length > 0
                ? (mockStreamTurns[streamCallIndex++] ?? [])
                : mockStreamEvents;
            return createModelStreamResponse(
              buildMessagesStreamEvents(
                (async function* () {
                  for (const frame of frames) {
                    if (frame instanceof Error)
                      throw toClientError(frame, {
                        operation: 'test.inference',
                      });
                    yield frame as RawMessageStreamEvent;
                  }
                })(),
              ),
            );
          },
        ),
      };
      const modelRouter = {
        kind: 'fixed' as const,
        resolve: vi.fn(async () => {
          throw new Error('old main router must not run');
        }),
      };
      const config = {
        ...testRequestConfig(),
        hasModelProviderManager: () => true,
        getModelProviderManager: () => manager,
        getModel: () => 'test-model',
        getSessionId: () => 'test-session',
        getModelPolicy,
        getWorkspaceContext: () => ({ getDirectories: () => [] }),
        getEffectiveContextWindow: () => 128000,
        getToolExecutor: () => ({}) as never,
      } as unknown as Config;
      const sessionManager = withSessionSelection(manager, config);
      config.getModelProviderManager = () =>
        sessionManager as unknown as ReturnType<
          Config['getModelProviderManager']
        >;
      return { manager, modelRouter, config };
    }

    it.each(['before_output', 'after_output'] as const)(
      'persists original Custom Provider authentication facts %s',
      async (phase) => {
        const { manager, config } = setup();
        manager.select.mockResolvedValue({
          model: {
            ...(await manager.getModel('test-model')),
            source: 'custom-provider',
          },
          config: { context: { contextWindow: 128000 } },
        });
        const failure = new ModelInferenceError('Invalid API key', {
          code: 'invalid_api_key',
          kind: 'auth',
          status: 401,
          phase,
        });
        manager.inference.mockImplementation(async () =>
          createModelStreamResponse(
            buildMessagesStreamEvents(
              (async function* () {
                if (phase === 'after_output') {
                  for (const event of makeTextStreamEvents(
                    'Partial response',
                  ).slice(0, 4)) {
                    yield event as RawMessageStreamEvent;
                  }
                }
                throw failure;
              })(),
            ),
          ),
        );
        const { events, terminal } = await drain(
          queryT({
            prompt: 'Hi',
            model: 'test-model',
            config,
            promptId: `custom-auth-${phase}`,
            messages: [],
            modelPurpose: 'main',
          }),
        );
        expect(
          terminal.error === failure || terminal.error?.cause === failure,
        ).toBe(true);
        if (phase === 'before_output') {
          expect(events).toContainEqual(
            expect.objectContaining({
              type: 'error_notification',
              error_code: 'invalid_api_key',
              error_details: expect.objectContaining({
                provider_source: 'custom-provider',
              }),
            }),
          );
        }
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'assistant',
            isApiErrorMessage: true,
            displayErrorCode: 'invalid_api_key',
            errorFallbackMessage: failure.message,
            modelError: expect.objectContaining({
              kind: 'auth',
              status: 401,
              providerSource: 'custom-provider',
            }),
          }),
        );
      },
    );

    it('uses querySelection for one query and session defaults for the next', async () => {
      setStreamEvents('answer');
      const { config, manager } = setup();
      const options = {
        config,
        prompt: 'question',
        sessionId: 'test-session',
        promptId: 'one-off-model',
      };
      const first = await drain(
        query({
          ...options,
          querySelection: {
            key: 'policy-model',
            config: { reasoning: { effort: 'low' } },
          },
        }),
      );
      expect(first.terminal.reason).toBe('end_turn');
      expect(manager.inference.mock.calls[0]![0].resolution).toMatchObject({
        model: { key: 'policy-model' },
        config: { reasoning: { effort: 'low' } },
      });
      const next = await drain(query({ ...options, promptId: 'next-input' }));
      expect(next.terminal.reason).toBe('end_turn');
      expect(manager.inference.mock.calls[1]![0].resolution).toMatchObject({
        model: { key: 'test-model' },
        config: { reasoning: { effort: 'high' } },
      });
      expect(manager.setMainModel).not.toHaveBeenCalled();
    });

    it.each([undefined, 'main', 'fork', 'side_question'] as const)(
      'rejects compactSelection on a non-compact query (%s)',
      (modelPurpose) => {
        const { config, manager } = setup();
        expect(() =>
          query({
            config,
            prompt: 'request',
            modelPurpose,
            sessionId: 'test-session',
            promptId: 'invalid-compact-query',
            compactSelection: testModelResolution('compact-model'),
          }),
        ).toThrow('compactSelection is only supported for compact queries');
        expect(manager.select).not.toHaveBeenCalled();
        expect(manager.inference).not.toHaveBeenCalled();
      },
    );

    it.each(['compact', 'partial-compact'])(
      'executes a %s summary through the real fork and query without selecting twice',
      async (forkLabel) => {
        setStreamEvents('summary');
        const host = vi.fn();
        const { config, manager } = setup(host);
        const compactSelection = testModelResolution('compact-model', {
          config: {
            reasoning: { effort: 'low' },
            context: { maxOutputTokens: 4096 },
          },
        });
        const onCompleted = vi.fn();
        const result = await runForkedAgent({
          config,
          compactSelection,
          model: compactSelection.model.key,
          prompt: 'summarize',
          sessionId: 'test-session',
          promptId: 'compact-request',
          forkLabel,
          maxTurns: 1,
          onCompleted,
        });
        expect(result.textContent).toBe('summary');
        expect(manager.select).not.toHaveBeenCalled();
        expect(host).not.toHaveBeenCalled();
        expect(manager.inference).toHaveBeenCalledOnce();
        expect(manager.inference.mock.calls[0]![0].resolution).toEqual(
          compactSelection,
        );
        expect(onCompleted).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ success: true }),
        );
      },
    );

    it.each([
      'default',
      'session-default',
      'config',
      'error',
      'cancel',
    ] as const)(
      'selects a fresh fork inside query without SDK (%s)',
      async (mode) => {
        setStreamEvents('fork answer');
        const host = vi.fn(async () => ({ model: 'policy-model' }));
        const { manager, config } = setup(host);
        const controller = new AbortController();
        const failure = new Error('fork selection failed');
        if (mode === 'error') manager.select.mockRejectedValueOnce(failure);
        if (mode === 'cancel') {
          manager.select.mockImplementationOnce(async () => {
            controller.abort(failure);
            throw failure;
          });
        }
        const onCompleted = vi.fn();
        const workdirs = ['/fork-repo'];
        const pending = runForkedAgent({
          config,
          model: mode === 'session-default' ? undefined : 'requested-model',
          prompt: 'Fork question',
          sessionId: 'test-session',
          promptId: 'fresh-fork',
          forkLabel: 'agent-fork',
          signal: controller.signal,
          workdirs,
          onCompleted,
          ...(mode === 'config'
            ? {
                generation: { temperature: 0.3, maxTokens: 1000 },
                reasoningEffort: 'low' as const,
                contextWindow: 128000,
                maxOutputTokens: 512,
                thinkingBudget: 0,
              }
            : {}),
        });
        if (mode === 'error' || mode === 'cancel') {
          await expect(pending).rejects.toBe(failure);
          expect(manager.inference).not.toHaveBeenCalled();
          expect(onCompleted).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ success: false }),
          );
        } else {
          expect(await pending).toMatchObject({ textContent: 'fork answer' });
          expect(manager.inference).toHaveBeenCalledOnce();
          const request = manager.inference.mock.calls[0]![0];
          expect(request.resolution.model.key).toBe(
            mode === 'session-default' ? 'test-model' : 'requested-model',
          );
          if (mode === 'session-default')
            expect(
              manager.select.mock.calls[0]![0].overrideSelection,
            ).toBeUndefined();
          if (mode === 'config') {
            expect(request.resolution.config).toMatchObject({
              sampling: { temperature: 0.3 },
              reasoning: { effort: 'low', thinking: { type: 'disabled' } },
              context: { contextWindow: 128000, maxOutputTokens: 512 },
            });
          }
          expect(request.qoder.workdirs).toBe(workdirs);
          expect(onCompleted).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ success: true }),
          );
        }
        expect(manager.select).toHaveBeenCalledOnce();
        expect(manager.select.mock.calls[0]![0].workdirs).toBe(workdirs);
        expect(host).not.toHaveBeenCalled();
      },
    );

    it.each([
      'default',
      'sdk-model',
      'sdk-config',
      'snapshot',
      'error',
      'cancel',
    ] as const)(
      'runs side question through query/select ($mode)',
      async (mode) => {
        setStreamEvents('side answer');
        const controller = new AbortController();
        const failure = new Error('side policy failed');
        const host = vi.fn(async () => {
          if (mode === 'error') throw failure;
          if (mode === 'cancel') controller.abort(failure);
          if (mode === 'sdk-model')
            return {
              model: 'policy-model',
              labels: { taskId: 'side-task' },
            };
          if (mode === 'sdk-config')
            return { parameters: { reasoningEffort: 'low' as const } };
          return undefined;
        });
        const { manager, config } = setup(host);
        const parentSelection = testModelResolution('parent-model', {
          reasoningEffort: 'low',
        });
        const pending = runSideQuestion({
          config,
          sessionId: 'test-session',
          question: 'Explain this',
          history: [
            { question: 'Earlier question', response: 'Earlier answer' },
          ],
          signal: controller.signal,
          ...(mode === 'snapshot'
            ? {
                cacheSafeQuerySnapshot: {
                  model: 'parent-model',
                  modelResolution: parentSelection,
                  forkContextMessages: [],
                  toolSchemas: [],
                },
              }
            : {}),
        });
        if (mode === 'error' || mode === 'cancel') {
          await expect(pending).rejects.toBe(failure);
          expect(host).toHaveBeenCalledOnce();
          expect(manager.inference).not.toHaveBeenCalled();
          return;
        }
        expect(await pending).toMatchObject({
          textContent: 'side answer',
          synthetic: false,
        });
        expect(manager.inference).toHaveBeenCalledOnce();
        const request = manager.inference.mock.calls[0]![0];
        if (mode === 'snapshot') {
          expect(request.resolution).toEqual(parentSelection);
          expect(manager.select).not.toHaveBeenCalled();
          expect(host).not.toHaveBeenCalled();
        } else {
          expect(manager.select).toHaveBeenCalledTimes(
            mode === 'default' ? 1 : 2,
          );
          expect(
            manager.select.mock.calls[0]![0].overrideSelection,
          ).toBeUndefined();
          expect(host).toHaveBeenCalledExactlyOnceWith(
            'utility',
            'test-session',
            0,
            undefined,
            expect.any(AbortSignal),
            expect.objectContaining({ resolvedModel: 'test-model' }),
          );
          if (mode === 'sdk-model') {
            expect(request.qoder).toMatchObject({
              taskRouting: { policyTaskId: 'side-task' },
            });
          }
          expect(request.resolution).toMatchObject({
            model: {
              key: mode === 'sdk-model' ? 'policy-model' : 'test-model',
            },
            config: {
              reasoning: { effort: mode === 'sdk-config' ? 'low' : 'high' },
            },
          });
        }
      },
    );

    it.each([
      'blocked',
      'stopped',
      'cancelled',
      'allowed',
      'policy-error',
    ] as const)(
      'keeps Hook, selection, policy and inference order for %s',
      async (mode) => {
        setStreamEvents('answer');
        const order: string[] = [];
        const controller = new AbortController();
        const failure = new Error('policy unavailable');
        const host = vi.fn(async () => {
          order.push('policy');
          if (mode === 'policy-error') throw failure;
          return undefined;
        });
        const { manager, config } = setup(host);
        const select = manager.select.getMockImplementation()!;
        manager.select.mockImplementation(async (input) => {
          order.push('select');
          return select(input);
        });
        const inference = manager.inference.getMockImplementation()!;
        manager.inference.mockImplementation(async (request) => {
          order.push('inference');
          return inference(request);
        });
        const stream = query({
          config,
          prompt: 'request',
          promptId: 'selection-order',
          sessionId: 'test-session',
          signal: controller.signal,
          querySelection: { key: 'test-model' },
          hookCoordinator: {
            fireBefore: vi.fn(async () => {
              order.push('hook');
              if (mode === 'cancelled') controller.abort();
              return mode === 'blocked'
                ? { blocked: true }
                : mode === 'stopped'
                  ? { stopped: true }
                  : null;
            }),
            fireAfter: vi.fn().mockResolvedValue(null),
            drainPendingAsyncContext: vi.fn(),
            fireStopFailure: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
          },
        });
        if (mode === 'cancelled') {
          await expect(drain(stream)).rejects.toMatchObject({
            name: 'AbortError',
          });
        } else if (mode === 'policy-error') {
          await expect(drain(stream)).rejects.toBe(failure);
        } else {
          const { terminal } = await drain(stream);
          expect(terminal.reason).toBe(
            mode === 'blocked' ? 'error' : 'end_turn',
          );
        }
        expect(order).toEqual(
          mode === 'allowed'
            ? ['hook', 'select', 'policy', 'inference']
            : mode === 'policy-error'
              ? ['hook', 'select', 'policy']
              : ['hook'],
        );
      },
    );

    it.each([
      { purpose: 'task', override: 'key' },
      { purpose: 'task', override: 'none' },
      { purpose: 'hook_prompt', override: 'none' },
      { purpose: 'hook_prompt', override: 'key' },
    ] as const)(
      'inherits the base selection then applies SDK selection for $purpose with $override override',
      async ({ purpose, override }) => {
        setStreamEvents('answer');
        const policy = vi.fn(async () => ({ model: 'policy-model' }));
        const { manager, config } = setup(policy);
        const baseModel = await manager.getModel('test-model');
        const policyModel = {
          ...(await manager.getModel('policy-model')),
          defaultModelConfig: {
            reasoning: { effort: 'low' as const },
            context: { contextWindow: 32_000, maxOutputTokens: 2048 },
          },
        };
        const selector = new CustomModelSelector(
          new CustomProviderConfig({
            providerId: baseModel.source,
            baseUrl: 'https://unused.invalid',
            protocol: OPENAI_CHAT_COMPLETIONS,
            models: [baseModel, policyModel],
          }),
          { getModelConfig: () => undefined, setModelConfig: () => true },
        );
        manager.select.mockImplementation((input) =>
          selector.select({ ...input, mainModel: baseModel }),
        );
        const parentSelection = testModelResolution(baseModel, {
          config: {
            reasoning: { effort: 'high' },
            context: { contextWindow: 128_000, maxOutputTokens: 8192 },
          },
        });
        const explicitConfig =
          purpose === 'task' ? { context: { maxOutputTokens: 4096 } } : {};
        const { terminal } = await drain(
          query({
            config,
            sessionId: 'test-session',
            prompt: 'child request',
            promptId: 'inherit-and-override',
            isSubagent: true,
            modelPurpose: purpose,
            parentSelection,
            querySelection:
              override === 'none'
                ? undefined
                : { key: baseModel.key, config: explicitConfig },
          }),
        );
        expect(terminal.reason).toBe('end_turn');
        expect(policy).toHaveBeenCalledOnce();
        expect(manager.select).toHaveBeenCalledTimes(2);
        expect(manager.setMainModel).not.toHaveBeenCalled();
        expect(manager.select.mock.calls[0]![0].parentSelection).toBe(
          parentSelection,
        );
        expect(manager.select.mock.calls[0]![0].overrideSelection).toEqual(
          override === 'none'
            ? purpose === 'task'
              ? { model: baseModel, config: { reasoning: { effort: 'high' } } }
              : undefined
            : { model: baseModel, config: explicitConfig },
        );
        await expect(
          manager.select.mock.results[0]!.value,
        ).resolves.toMatchObject({
          model: baseModel,
          config: {
            reasoning: { effort: 'high' },
            context: {
              contextWindow: 128_000,
              maxOutputTokens:
                purpose === 'task' && override === 'key' ? 4096 : 8192,
            },
          },
        });
        expect(manager.inference.mock.calls[0]![0].resolution).toMatchObject({
          model: policyModel,
          config: {
            reasoning: {
              effort:
                purpose === 'task' && override === 'none' ? 'high' : 'low',
            },
            context: {
              contextWindow: 32_000,
              maxOutputTokens:
                purpose === 'task' && override === 'key' ? 4096 : 2048,
            },
          },
        });
      },
    );

    it.each(
      ['fast', 'gateway/parent-model'].flatMap((parentKey) =>
        (['side_question', 'fork', 'compact'] as const).map((scenario) => ({
          parentKey,
          scenario,
        })),
      ),
    )(
      'reuses $scenario selection ($parentKey) after a session model switch',
      async ({ parentKey, scenario }) => {
        setStreamEvents('parent answer');
        const getModelPolicy = vi.fn(async () => {
          throw new Error('parent policy must not run twice');
        });
        const { config, manager } = setup(getModelPolicy);
        manager.select.mockRejectedValue(new Error('must reuse parent'));
        const parentSelection = testModelResolution(
          {
            ...testProviderModel(parentKey),
            source: parentKey.startsWith('gateway/') ? 'gateway' : 'qoder',
          },
          {
            config: {
              reasoning: {
                effort: 'high',
                thinking: { type: 'enabled', budgetTokens: 4096 },
              },
              context: { contextWindow: 200_000, maxOutputTokens: 8192 },
              sampling: { temperature: 0.2 },
            },
          },
        );
        const snapshot = vi.fn();
        const { terminal } = await drain(
          query({
            config,
            prompt: 'side question',
            sessionId: 'test-session',
            promptId: 'parent-selection-side-question',
            ...(scenario === 'compact'
              ? { compactSelection: parentSelection }
              : { parentSelection }),
            policyLabels: { taskId: 'provided-selection-policy' },
            modelPurpose: scenario,
            querySource: 'side_question',
            toolChoice: 'none',
            maxTurns: 1,
            onCacheSafeSnapshot: snapshot,
          }),
        );
        expect(terminal.reason).toBe('end_turn');
        expect(config.getModel()).not.toBe(parentKey);
        expect(manager.select).not.toHaveBeenCalled();
        expect(getModelPolicy).not.toHaveBeenCalled();
        expect(manager.inference).toHaveBeenCalledOnce();
        expect(manager.inference.mock.calls[0]![0].qoder).toMatchObject({
          taskRouting: { policyTaskId: 'provided-selection-policy' },
        });
        expect(manager.inference.mock.calls[0]![0].resolution).toEqual(
          parentSelection,
        );
        expect(manager.inference.mock.calls[0]![0].resolution.config).toBe(
          parentSelection.config,
        );
        expect(snapshot).toHaveBeenCalledWith(
          expect.objectContaining({
            model: parentKey,
            modelResolution: parentSelection,
            reasoningEffort: 'high',
            contextWindow: 200_000,
            maxOutputTokens: 8192,
            thinkingBudget: 4096,
          }),
        );
      },
    );

    it.each([
      { source: 'session', params: {}, model: 'test-model' },
      {
        source: 'key override',
        params: { querySelection: { key: 'fast' } },
        model: 'fast',
      },
      {
        source: 'preselected request',
        params: {
          compactSelection: testModelResolution('fast'),
          modelPurpose: 'compact' as const,
          parentSelection: testModelResolution('ignored-parent'),
          querySelection: { key: 'ignored' },
        },
        model: 'fast',
      },
      {
        source: 'fork parent',
        params: {
          modelPurpose: 'fork' as const,
          parentSelection: testModelResolution('fast'),
        },
        model: 'fast',
      },
      {
        source: 'parent intent',
        params: {
          parentSelection: testModelResolution('fast'),
        },
        model: 'test-model',
      },
    ])(
      'without QueryParams.model, preserves final selection from $source',
      async ({ params, model }) => {
        setStreamEvents('hello');
        const { config, manager } = setup();
        const { terminal } = await drain(
          query({
            prompt: 'hello',
            sessionId: 'test-session',
            promptId: 'no-duplicate-model',
            config,
            ...params,
          }),
        );
        expect(terminal.reason).toBe('end_turn');
        expect(manager.inference.mock.calls[0]![0].resolution.model.key).toBe(
          model,
        );
      },
    );

    it.each([
      { modelPurpose: 'task' as const, overrideKey: undefined },
      { modelPurpose: 'task' as const, overrideKey: 'test-model' },
      { modelPurpose: 'fork' as const, overrideKey: undefined },
      { modelPurpose: 'fork' as const, overrideKey: 'test-model' },
    ])(
      'selects the registered Agent model for $modelPurpose, with query override $overrideKey',
      async ({ modelPurpose, overrideKey }) => {
        setStreamEvents('hello');
        const { config, manager } = setup();
        config.taskRegistry = new TaskRegistry();
        config.taskRegistry.register({
          id: 'a-route-agent',
          agentId: 'route-agent',
          agentName: 'reviewer',
          agentType: 'reviewer',
          resolvedModel: 'fast',
          type: 'local_agent',
          status: 'running',
          description: 'Review',
          startTime: 0,
          notified: false,
          executionId: 1,
          completionBehavior: 'silent',
          prompt: 'Review',
          isBackgrounded: false,
          taskId: 'route-task',
        });
        config.getAgentRegistry = () =>
          ({
            getDefinition: () => ({
              kind: 'local',
              modelConfig: { model: 'fast' },
            }),
          }) as unknown as ReturnType<Config['getAgentRegistry']>;
        const { terminal } = await drain(
          query({
            config,
            prompt: 'review',
            sessionId: 'test-session',
            promptId: 'route-test',
            modelPurpose,
            isSubagent: true,
            agentId: 'route-agent',
            agentType: 'reviewer',
            querySelection: overrideKey ? { key: overrideKey } : undefined,
          }),
        );
        expect(terminal.reason).toBe('end_turn');
        expect(manager.inference.mock.calls[0][0].resolution.model.key).toBe(
          overrideKey ?? 'fast',
        );
      },
    );

    it('多轮工具请求复用一次选模，保留配置与请求级 workdirs', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('provider-tool', 'grep', { pattern: 'foo' }),
        makeTextStreamEvents('Found it'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());
      const { manager, modelRouter, config } = setup();
      const workdirs = Object.freeze(['/repo-a', '/repo-b']);
      const toolBridge = createMockToolBridge(async (blocks) => ({
        toolResults: blocks.map((block) => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'match',
          is_error: false,
        })),
        allMessages: [],
      }));
      const { terminal } = await drain(
        queryT({
          prompt: 'Search',
          model: 'test-model',
          promptId: 'provider-tool-rounds',
          config,
          selectModel: modelRouter.resolve,
          toolBridge,
          workdirs,
        }),
      );
      expect(terminal.reason).toBe('end_turn');
      expect(manager.select).toHaveBeenCalledOnce();
      expect(manager.select.mock.calls[0]![0].workdirs).toBe(workdirs);
      expect(modelRouter.resolve).not.toHaveBeenCalled();
      expect(manager.inference).toHaveBeenCalledTimes(2);
      for (const [request] of manager.inference.mock.calls) {
        expect(request.resolution.config).toMatchObject({
          reasoning: { effort: 'high' },
          context: { contextWindow: 256000 },
        });
        expect(request.qoder.workdirs).toBe(workdirs);
        expect(request).not.toHaveProperty('workdirs');
      }
      expect(manager.inference.mock.calls[1]![0].resolution).toBe(
        manager.inference.mock.calls[0]![0].resolution,
      );
    });

    it('首次主模型请求携带 SDK 附带头', async () => {
      setStreamEvents('Answer');
      const { manager, config } = setup();
      const extraHeaders = { 'X-Host-Trace': 'host-trace' };
      const { terminal } = await drain(
        queryT({
          prompt: 'Search',
          model: 'test-model',
          promptId: 'sdk-extra-headers',
          config,
          extraHeaders,
        }),
      );
      expect(terminal.reason).toBe('end_turn');
      expect(manager.inference).toHaveBeenCalledOnce();
      expect(manager.inference.mock.calls[0]![0].qoder.extraHeaders).toEqual(
        extraHeaders,
      );
    });

    it('工具续跑请求不携带 SDK 附带头', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('header-tool', 'grep', { pattern: 'foo' }),
        makeTextStreamEvents('Found it'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());
      const { manager, config } = setup();
      const toolBridge = createMockToolBridge(async (blocks) => ({
        toolResults: blocks.map((block) => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'match',
          is_error: false,
        })),
        allMessages: [],
      }));
      const { terminal } = await drain(
        queryT({
          prompt: 'Search',
          model: 'test-model',
          promptId: 'sdk-extra-headers-continuation',
          config,
          extraHeaders: { 'X-Host-Trace': 'host-trace' },
          toolBridge,
        }),
      );
      expect(terminal.reason).toBe('end_turn');
      expect(manager.inference).toHaveBeenCalledTimes(2);
      expect(manager.inference.mock.calls[0]![0].qoder).toHaveProperty(
        'extraHeaders',
      );
      expect(manager.inference.mock.calls[1]![0].qoder).not.toHaveProperty(
        'extraHeaders',
      );
    });

    it('subagent 不继承 SDK 附带头', async () => {
      setStreamEvents('Answer');
      const { manager, config } = setup();
      const { terminal } = await drain(
        queryT({
          prompt: 'Task',
          model: 'test-model',
          promptId: 'sdk-extra-headers-subagent',
          config,
          extraHeaders: { 'X-Host-Trace': 'host-trace' },
          isSubagent: true,
          agentId: 'child',
        }),
      );
      expect(terminal.reason).toBe('end_turn');
      expect(manager.inference).toHaveBeenCalledOnce();
      expect(manager.inference.mock.calls[0]![0].qoder).not.toHaveProperty(
        'extraHeaders',
      );
    });

    it.each(['upload', 'keep', 'url', 'no-hook', 'cancel'] as const)(
      'prepares tool result images before persistence with the current provider (%s)',
      async (mode) => {
        mockStreamTurns.push(
          makeToolUseStreamEvents('image-result', READ_FILE_TOOL_NAME, {
            file_path: '/image.png',
          }),
          makeTextStreamEvents('Done'),
        );
        const { manager, config } = setup();
        const getModel = manager.getModel.getMockImplementation()!;
        manager.getModel.mockImplementation(async (key) => {
          const model = await getModel(key);
          return {
            ...model,
            capabilities: { ...model.capabilities, vision: true },
          };
        });
        const original = {
          type: 'image' as const,
          source:
            mode === 'url'
              ? { type: 'url' as const, url: 'https://images.test/read.png' }
              : {
                  type: 'base64' as const,
                  mediaType: 'image/png',
                  data: 'aGVsbG8=',
                },
        };
        const prepared =
          mode === 'upload'
            ? {
                type: 'image' as const,
                source: {
                  type: 'url' as const,
                  url: 'https://images.test/upload.png',
                },
              }
            : original;
        const controller = new AbortController();
        const fireImagePrepareEvent = vi.fn(async () => {
          if (mode === 'cancel') {
            controller.abort();
            controller.signal.throwIfAborted();
          }
          return [prepared];
        });
        Object.assign(config, {
          getHookSystem: () =>
            mode === 'no-hook'
              ? undefined
              : { fireImagePrepareEvent, fireQueryEndEvent: vi.fn() },
        });
        const toolBridge = createMockToolBridge(async (blocks) => ({
          toolResults: blocks.map((block) => ({
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: [original],
            is_error: false,
          })),
          allMessages: [],
        }));
        const { events } = await drain(
          queryT({
            prompt: 'Read image',
            model: 'test-model',
            promptId: 'image-hook',
            config,
            toolBridge,
            signal: controller.signal,
            modelPurpose: 'main',
          }),
        );
        const serialized = JSON.stringify(events);
        expect(serialized).toContain(
          mode === 'upload'
            ? 'https://images.test/upload.png'
            : mode === 'url'
              ? 'https://images.test/read.png'
              : 'aGVsbG8=',
        );
        if (mode === 'no-hook')
          expect(fireImagePrepareEvent).not.toHaveBeenCalled();
        else expect(fireImagePrepareEvent).toHaveBeenCalledOnce();
        if (mode !== 'cancel') {
          expect(manager.inference).toHaveBeenCalledTimes(2);
          expect(manager.inference.mock.calls[1][0].prompt.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                role: 'tool',
                toolCallId: 'image-result',
                content: [expect.objectContaining(prepared)],
              }),
            ]),
          );
        }
      },
    );

    describe('本轮对话集中准备', () => {
      it.each([
        { compact: false, fork: false, skipUser: false },
        { compact: true, fork: false, skipUser: false },
        { compact: true, fork: false, skipUser: true },
        { compact: false, fork: true, skipUser: false },
      ])(
        '压缩=$compact、fork=$fork、跳过用户=$skipUser：投影、计数与请求共享同一份对话',
        async ({ compact, fork, skipUser }) => {
          setStreamEvents('Done');
          const { manager, config } = setup();
          const count = vi.spyOn(requestTokenCounting, 'countRequestTokens');
          const anchor = vi.spyOn(
            requestTokenCounting,
            'createRequestTokenAnchor',
          );
          const projection = vi.spyOn(protocol, 'normalizeMessagesForAPI');
          const conversion = vi.spyOn(requestConverter, 'convertMessages');
          const persistedUsage = {
            ...cloneUsage(),
            request_id: 'previous-request',
          };
          const loadUsage = vi
            .spyOn(sessionStateUsage, 'loadLatestSessionUsage')
            .mockResolvedValue(persistedUsage);
          try {
            const history = [createUserMessage('original-history')];
            const historyBefore = structuredClone(history);
            const prefix: NonNullable<QueryParams['preProjectedMessages']> = [
              {
                role: 'user',
                content: [{ type: 'text', text: 'fork-memory' }],
              },
            ];
            const prefixBefore = structuredClone(prefix);
            const inputAttachment = createAttachmentMessage(
              new HookOutputAttachment({
                type: 'hook_output',
                hookEventName: HookEventName.UserPromptSubmit,
                output: 'input-attachment',
              }),
            );
            const attachmentCtx = createAttachmentContext('/workspace/project');
            attachmentCtx.lastDateSeen = '1900-01-01';
            const hookCoordinator = {
              fireBefore: vi.fn().mockResolvedValue(null),
              fireAfter: vi.fn().mockResolvedValue(null),
              drainPendingAsyncContext: vi.fn(() => {
                attachmentCtx.pendingHookOutputs.push({
                  hookEventName: HookEventName.SessionStart,
                  output: 'late-attachment',
                });
                return 'async-tail';
              }),
            };
            const compressedHistory = [createUserMessage('compact-summary')];
            const compressionPipeline = {
              compress: vi.fn().mockResolvedValue({
                newHistory: compact ? compressedHistory : null,
              }),
            };
            const snapshot = vi.fn();
            const steps: TurnStepInput[] = [];
            const toolBridge = createMockToolBridge(undefined, [
              TEST_TOOL_SCHEMA,
            ]);
            const { events, terminal } = await drain(
              queryT({
                prompt: 'current-prompt',
                model: 'test-model',
                promptId: 'conversation-preparation',
                config,
                messages: history,
                skipInitialUserMessage: skipUser,
                initialInputAttachments: skipUser ? [] : [inputAttachment],
                startupMemoryContext: { autoMemory: 'startup-memory' },
                ...(fork
                  ? {
                      preProjectedMessages: prefix,
                    }
                  : {}),
                hookCoordinator: hookCoordinator as never,
                attachmentCtx,
                compressionPipeline: compressionPipeline as never,
                toolBridge,
                systemPrompt: systemPromptFromText('system-context'),
                onCacheSafeSnapshot: snapshot,
                turnHookFactories: [
                  () => ({
                    id: 'prepared-count',
                    register(on) {
                      on('turn.step', async function* (_context, input, next) {
                        steps.push(input);
                        return yield* next(input);
                      });
                    },
                  }),
                ],
              }),
            );
            expect(terminal.reason).toBe('end_turn');
            expect(manager.inference).toHaveBeenCalledOnce();
            expect(toolBridge.getToolSchema).toHaveBeenCalledOnce();
            expect(
              hookCoordinator.drainPendingAsyncContext,
            ).toHaveBeenCalledOnce();
            expect(count).toHaveBeenCalledTimes(compact ? 2 : 1);
            const firstCountInput = count.mock.calls[0][0];
            const finalCountInput = count.mock.calls.at(-1)![0];
            expect(firstCountInput.latestUsage).toBe(persistedUsage);
            if (compact) {
              expect(finalCountInput.latestUsage).toBeUndefined();
              expect(finalCountInput.normalizedMessages).not.toBe(
                firstCountInput.normalizedMessages,
              );
            }
            expect(compressionPipeline.compress).toHaveBeenCalledWith(
              history,
              expect.objectContaining({
                requestTokenCount: count.mock.results[0].value,
                requestPrefixMessages: fork ? [] : expect.any(Array),
              }),
            );
            const compactOptions = compressionPipeline.compress.mock
              .calls[0][1] as CompressOptions;
            expect(compactOptions.modelResolution).toBe(
              manager.inference.mock.calls[0][0].resolution,
            );
            expect(compactOptions.resolveCompactSelection).toBeTypeOf(
              'function',
            );
            for (const key of [
              'model',
              'generation',
              'thinkingBudget',
              'reasoningEffort',
              'contextWindow',
              'resolveCompactRequest',
            ]) {
              expect(compactOptions).not.toHaveProperty(key);
            }
            const preparedMessages = finalCountInput.normalizedMessages!;
            expect(conversion).toHaveBeenCalledOnce();
            expect(conversion.mock.calls[0][0]).toBe(preparedMessages);
            expect(anchor).toHaveBeenCalledOnce();
            expect(anchor.mock.calls[0][0].normalizedMessages).toBe(
              preparedMessages,
            );
            expect(snapshot.mock.calls[0][0].forkContextMessages).toEqual(
              preparedMessages,
            );
            expect(steps[0].messageCount).toBe(preparedMessages.length);
            expect(finalCountInput.tools).toBe(
              snapshot.mock.calls[0][0].toolSchemas,
            );
            const requestProjections = projection.mock.calls.filter(
              ([messages]) =>
                messages.some(
                  (message) =>
                    message.type === 'user' &&
                    JSON.stringify(message.message.content).includes(
                      'async-tail',
                    ),
                ),
            );
            expect(requestProjections).toHaveLength(compact ? 2 : 1);
            const sent = JSON.stringify(
              manager.inference.mock.calls[0][0].prompt,
            );
            const markers = [
              fork ? 'fork-memory' : 'startup-memory',
              ...(compact
                ? ['compact-summary']
                : fork
                  ? []
                  : ['original-history']),
              ...(skipUser ? [] : ['current-prompt', 'input-attachment']),
              'async-tail',
              'late-attachment',
            ];
            for (const marker of markers) {
              expect(sent.split(marker)).toHaveLength(2);
            }
            const rawRequest = requestProjections.at(-1)![0];
            expect(
              rawRequest.findIndex((message) =>
                JSON.stringify(message).includes('async-tail'),
              ),
            ).toBeLessThan(
              rawRequest.findIndex((message) =>
                JSON.stringify(message).includes('late-attachment'),
              ),
            );
            // 投影仍按既有规则把附件前移，不能把 transcript 的追加顺序当成发送顺序。
            expect(sent.indexOf('late-attachment')).toBeLessThan(
              sent.indexOf('async-tail'),
            );
            if (compact || fork) expect(sent).not.toContain('original-history');
            if (fork) {
              expect(sent).not.toContain('startup-memory');
              expect(finalCountInput.messages).toEqual([]);
              expect(prefix).toEqual(prefixBefore);
            }
            if (compact) {
              expect(
                events.filter(
                  (event) =>
                    event.type === 'attachment' &&
                    event.attachment.type === 'date_change',
                ),
              ).toHaveLength(1);
              expect(sent.split('Current date:')).toHaveLength(2);
            }
            expect(history).toEqual(historyBefore);
          } finally {
            count.mockRestore();
            anchor.mockRestore();
            projection.mockRestore();
            conversion.mockRestore();
            loadUsage.mockRestore();
          }
        },
      );
    });

    it('fork 续轮只投影新增后缀，临时上下文不写回运行历史', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('fork-tool', 'Read', { path: 'a' }),
        makeTextStreamEvents('Done'),
      );
      const { manager, config } = setup();
      const prefix: NonNullable<QueryParams['preProjectedMessages']> = [
        { role: 'user', content: [{ type: 'text', text: 'projected-memory' }] },
      ];
      const history = [createUserMessage('covered-history')];
      const before = structuredClone(prefix);
      const hookCoordinator = {
        fireBefore: vi.fn().mockResolvedValue(null),
        fireAfter: vi.fn().mockResolvedValue(null),
        drainPendingAsyncContext: vi
          .fn()
          .mockReturnValueOnce('request-only-tail'),
      };
      const bridge = createMockToolBridge(async (blocks) => ({
        toolResults: blocks.map((block) => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'read-result',
          is_error: false,
        })),
        allMessages: [],
      }));
      const { terminal } = await drain(
        queryT({
          prompt: 'current-prompt',
          model: 'test-model',
          promptId: 'fork-conversation-continuation',
          config,
          messages: history,
          preProjectedMessages: prefix,
          startupMemoryContext: { autoMemory: 'standalone-memory' },
          hookCoordinator: hookCoordinator as never,
          toolBridge: bridge,
        }),
      );
      expect(terminal.reason).toBe('end_turn');
      expect(manager.inference).toHaveBeenCalledTimes(2);
      const [first, second] = manager.inference.mock.calls.map(([request]) =>
        JSON.stringify(request.prompt),
      );
      for (const sent of [first, second]) {
        for (const marker of ['projected-memory', 'current-prompt']) {
          expect(sent.split(marker)).toHaveLength(2);
        }
        expect(sent).not.toContain('standalone-memory');
        expect(sent).not.toContain('covered-history');
      }
      expect(first).toContain('request-only-tail');
      expect(second).not.toContain('request-only-tail');
      expect(first).not.toContain('read-result');
      expect(second.split('read-result')).toHaveLength(2);
      expect(prefix).toEqual(before);
      expect(bridge.getToolSchema).toHaveBeenCalledTimes(2);
    });

    describe('正式推理请求装配', () => {
      it.each([true, false])(
        '保留 system 块开关=%s、工具声明和原始消息统计',
        async (blocksEnabled) => {
          vi.stubEnv('QWEN_SYSTEM_PROMPT_BLOCKS', String(blocksEnabled));
          try {
            setStreamEvents('Hello');
            const { manager, config } = setup();
            const steps: TurnStepInput[] = [];
            const snapshot = vi.fn();
            const { terminal } = await drain(
              queryT({
                prompt: 'Hello',
                model: 'test-model',
                promptId: 'formal-prompt',
                config,
                systemPrompt: [
                  { type: 'text', text: 'first' },
                  { type: 'text', text: '' },
                  { type: 'text', text: 'second' },
                ],
                toolBridge: createMockToolBridge(undefined, [TEST_TOOL_SCHEMA]),
                onCacheSafeSnapshot: snapshot,
                turnHookFactories: [
                  () => ({
                    id: 'message-count',
                    register(on) {
                      on('turn.step', async function* (_context, input, next) {
                        steps.push(input);
                        return yield* next(input);
                      });
                    },
                  }),
                ],
              }),
            );
            expect(terminal.reason).toBe('end_turn');
            const request = manager.inference.mock.calls[0]![0];
            expect(request.prompt.messages[0]).toEqual({
              role: 'system',
              content: blocksEnabled
                ? [
                    { type: 'text', text: 'first' },
                    { type: 'text', text: 'second' },
                  ]
                : 'first\n\nsecond',
            });
            expect(request.prompt.tools).toEqual([TEST_TOOL_SCHEMA]);
            expect(request.prompt).not.toHaveProperty('system');
            expect(request.prompt).not.toHaveProperty('skipCacheWrite');
            expect(steps[0].messageCount).toBe(
              snapshot.mock.calls[0][0].forkContextMessages.length,
            );
            expect(steps[0].messageCount).toBe(
              request.prompt.messages.length - 1,
            );
          } finally {
            vi.unstubAllEnvs();
          }
        },
      );

      it.each<[ModelToolChoice | undefined, ModelToolChoice | undefined]>([
        ['auto', 'auto'],
        ['none', 'none'],
        ['required', 'required'],
        [{ name: 'Read' }, { name: 'Read' }],
        [undefined, undefined],
      ])('工具选择 %j 直接写入正式 prompt', async (toolChoice, expected) => {
        setStreamEvents('Hello');
        const { manager, config } = setup();
        const { terminal } = await drain(
          queryT({
            prompt: 'Hello',
            model: 'test-model',
            promptId: 'formal-choice',
            config,
            toolChoice,
          }),
        );
        expect(terminal.reason).toBe('end_turn');
        const request = manager.inference.mock.calls[0]![0];
        expect(request.prompt.toolChoice).toEqual(expected);
        if (expected === undefined)
          expect(request.prompt).not.toHaveProperty('toolChoice');
        expect(request.prompt).not.toHaveProperty('tools');
        expect(
          request.prompt.messages.some((message) => message.role === 'system'),
        ).toBe(false);
      });

      it.each([false, true])(
        '保留 skipCacheWrite=%s 的缓存断点',
        async (skipCacheWrite) => {
          setStreamEvents('Hello');
          const { manager, config } = setup();
          const prefix: NonNullable<QueryParams['preProjectedMessages']> = [
            {
              role: 'user',
              content: [{ type: 'text', text: 'history' }],
            },
          ];
          const before = structuredClone(prefix);
          await drain(
            queryT({
              prompt: 'Hello',
              model: 'test-model',
              promptId: 'formal-cache',
              config,
              preProjectedMessages: prefix,
              skipCacheWrite,
            }),
          );
          const messages = manager.inference.mock.calls[0]![0].prompt.messages;
          const target =
            messages[
              skipCacheWrite ? messages.length - 2 : messages.length - 1
            ];
          expect(target.content).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ cacheControl: { type: 'ephemeral' } }),
            ]),
          );
          const unmarked =
            messages[
              skipCacheWrite ? messages.length - 1 : messages.length - 2
            ];
          expect(JSON.stringify(unmarked)).not.toContain('cacheControl');
          expect(prefix).toEqual(before);
        },
      );

      it.each([
        { preserve: true, vision: true },
        { preserve: false, vision: true },
        { preserve: true, vision: false },
        { preserve: false, vision: false },
      ])(
        '保留 reasoning=$preserve、vision=$vision 和工具结果投影',
        async ({ preserve, vision }) => {
          setStreamEvents('Hello');
          const { manager, config } = setup();
          const model = await manager.getModel('test-model');
          model.capabilities.vision = vision;
          manager.select.mockResolvedValue({
            model,
            config: { reasoning: { preserve } },
          });
          const prefix: NonNullable<QueryParams['preProjectedMessages']> = [
            { role: 'user', content: [{ type: 'text', text: 'history' }] },
            {
              role: 'assistant',
              content: [
                {
                  type: 'thinking',
                  thinking: 'reasoning',
                  signature: 'signature',
                },
                { type: 'redacted_thinking', data: 'redacted' },
                { type: 'text', text: 'calling tools' },
              ],
              toolCalls: [
                { id: 'tool-a', name: 'Read', arguments: '{"path":"a"}' },
                { id: 'tool-b', name: 'Read', arguments: '{"path":"b"}' },
              ],
            },
            { role: 'tool', toolCallId: 'tool-a', content: 'result a' },
            { role: 'tool', toolCallId: 'tool-b', content: 'result b' },
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    mediaType: 'image/png',
                    data: 'aGVsbG8=',
                  },
                },
              ],
            },
          ];
          const before = structuredClone(prefix);
          const snapshot = vi.fn();
          const steps: TurnStepInput[] = [];
          await drain(
            queryT({
              prompt: 'Hello',
              model: 'test-model',
              promptId: 'formal-projection',
              config,
              preProjectedMessages: prefix,
              onCacheSafeSnapshot: snapshot,
              turnHookFactories: [
                () => ({
                  id: 'projection-count',
                  register(on) {
                    on('turn.step', async function* (_context, input, next) {
                      steps.push(input);
                      return yield* next(input);
                    });
                  },
                }),
              ],
            }),
          );
          const request = manager.inference.mock.calls[0]![0];
          const assistant = request.prompt.messages.find(
            (message) => message.role === 'assistant',
          );
          expect(assistant?.content).toEqual(
            preserve
              ? expect.arrayContaining([
                  expect.objectContaining({ type: 'thinking' }),
                  expect.objectContaining({ type: 'redacted_thinking' }),
                ])
              : [{ type: 'text', text: 'calling tools' }],
          );
          expect(assistant).toMatchObject({
            toolCalls: [
              { id: 'tool-a', name: 'Read', arguments: '{"path":"a"}' },
              { id: 'tool-b', name: 'Read', arguments: '{"path":"b"}' },
            ],
          });
          expect(
            request.prompt.messages.filter(
              (message) => message.role === 'tool',
            ),
          ).toMatchObject([{ toolCallId: 'tool-a' }, { toolCallId: 'tool-b' }]);
          expect(
            JSON.stringify(request.prompt.messages).includes('"type":"image"'),
          ).toBe(vision);
          expect(steps[0].messageCount).toBe(
            snapshot.mock.calls[0][0].forkContextMessages.length,
          );
          // 标准前缀已把工具结果拆成独立消息，只额外计算正式 system 消息。
          expect(steps[0].messageCount).toBe(prefix.length + 1);
          expect(request.prompt.messages.length).toBe(
            steps[0].messageCount +
              request.prompt.messages.filter(
                (message) => message.role === 'system',
              ).length,
          );
          expect(prefix).toEqual(before);
        },
      );

      it.each([
        {
          isSubagent: false,
          querySource: undefined,
          type: 'agent',
          subTask: 'sdk-subtask',
          taskId: undefined,
        },
        {
          isSubagent: false,
          querySource: 'prompt_suggestion',
          type: 'agent',
          subTask: 'prompt_suggestion',
          taskId: 'agent_summary',
        },
        {
          isSubagent: true,
          querySource: undefined,
          type: 'sec_scan',
          subTask: 'sdk-subtask',
          taskId: 'sec_scan',
        },
      ])(
        '业务与诊断分离：child=$isSubagent、source=$querySource',
        async ({ isSubagent, querySource, type, subTask, taskId }) => {
          setStreamEvents('Hello');
          const { manager, config } = setup(async () => ({
            labels: { taskId: 'sdk-task', subTask: 'sdk-subtask' },
          }));
          const business = {
            version: '1',
            id: 'business-id',
            type,
            model_key: 'user-selected-model',
          };
          const patches: NonNullable<QueryParams['modelRequestPatches']> = {
            main: [{ action: 'edit_system_prompt', content: 'patch' }],
          };
          const customContext = { tenant: 'request-tenant' };
          const onCompleted = vi.fn(() => {
            throw new Error('observer failed');
          });
          const onFinished = vi.fn(() => {
            throw new Error('observer failed');
          });
          const { terminal } = await drain(
            queryT({
              prompt: 'Hello',
              model: 'test-model',
              promptId: 'formal-context',
              config,
              sessionId: 'formal-session',
              sourceSessionId: 'parent-session',
              initialModelRequestId: 'formal-request-id',
              isSubagent,
              agentType: 'test-child',
              businessInfo: business,
              parentBusinessInfo: business,
              querySource,
              customContext,
              modelRequestPatches: patches,
              onModelRequestCompleted: onCompleted,
              onModelRequestFinished: onFinished,
            }),
          );
          expect(terminal.reason).toBe('end_turn');
          const request = manager.inference.mock.calls[0]![0];
          expect(Object.keys(request).sort()).toEqual([
            'control',
            'prompt',
            'qoder',
            'resolution',
          ]);
          expect(request.qoder).toMatchObject({
            identity: {
              sessionId: 'formal-session',
              sourceSessionId: 'parent-session',
              requestId: 'formal-request-id',
              requestSetId: terminal.requestSetId,
            },
            taskRouting: { taskId, policyTaskId: 'sdk-task' },
            customContext,
            business: {
              id: 'business-id',
              model_key: 'user-selected-model',
              sub_task: subTask,
            },
          });
          if (isSubagent) expect(request.qoder).not.toHaveProperty('patches');
          else expect(request.qoder).toHaveProperty('patches', patches);
          expect(onCompleted).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              requestId: 'formal-request-id',
              model: 'test-model',
            }),
          );
          expect(onFinished).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              requestId: 'formal-request-id',
              success: true,
            }),
          );
        },
      );

      it('流中断后保留已交付工具，续接请求继续使用正式结构', async () => {
        mockStreamTurns.push(
          [
            ...makeToolUseStreamEvents('delivered-tool', 'Read', {
              path: 'a',
            }).slice(0, 4),
            makeSocketCloseError(),
          ],
          makeTextStreamEvents('Recovered'),
        );
        const { manager, config } = setup();
        const toolBridge = createMockStreamingToolBridge(
          async (blocks) => ({
            toolResults: blocks.map((block) => ({
              type: 'tool_result',
              tool_use_id: block.id,
              content: 'read once',
              is_error: false,
            })),
            allMessages: [],
            settlement: new Map(blocks.map((block) => [block.id, 'completed'])),
          }),
          [TEST_TOOL_SCHEMA],
        );
        const onFinished = vi.fn();
        const workdirs = Object.freeze(['/recovery-repo']);
        const { events, terminal } = await drain(
          queryT({
            prompt: 'Read',
            model: 'test-model',
            promptId: 'formal-recovery',
            config,
            toolBridge,
            workdirs,
            onModelRequestFinished: onFinished,
          }),
        );
        expect(terminal.reason).toBe('end_turn');
        expect(manager.inference).toHaveBeenCalledTimes(2);
        expect(toolBridge.execute).toHaveBeenCalledOnce();
        expect(events.filter(isRuntimeToolResultEvent)).toHaveLength(1);
        const [first, second] = manager.inference.mock.calls.map(
          ([request]) => request,
        );
        expect(second.resolution).toBe(first.resolution);
        expect(second.prompt.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: 'tool',
              toolCallId: 'delivered-tool',
            }),
          ]),
        );
        for (const request of [first, second]) {
          expect(request.qoder.workdirs).toBe(workdirs);
          expect(Object.keys(request).sort()).toEqual([
            'control',
            'prompt',
            'qoder',
            'resolution',
          ]);
        }
        expect(onFinished.mock.calls.map(([result]) => result.success)).toEqual(
          [false, true],
        );
      });

      it('取消只使用正式请求的 control.signal', async () => {
        setStreamEvents('partial answer');
        const { manager, config } = setup();
        const controller = new AbortController();
        const onFinished = vi.fn();
        const stream = queryT({
          prompt: 'Hello',
          model: 'test-model',
          promptId: 'formal-cancel',
          config,
          signal: controller.signal,
          onModelRequestFinished: onFinished,
        });
        for (;;) {
          const next = await stream.next();
          if (next.done) throw new Error('未收到正文增量');
          if (
            next.value.type === 'stream_event' &&
            next.value.event.type === 'content_block_delta'
          )
            break;
        }
        const request = manager.inference.mock.calls[0]![0];
        expect(request).not.toHaveProperty('signal');
        expect(request.control?.signal?.aborted).toBe(false);
        controller.abort();
        const { terminal } = await drain(stream);
        expect(terminal.reason).toBe('abort');
        expect(request.control?.signal?.aborted).toBe(true);
        expect(manager.inference).toHaveBeenCalledOnce();
        expect(onFinished).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ success: false }),
        );
      });
    });

    describe('响应终态残缺结果接入', () => {
      it('标准终值保持只读，模型回填与用量投影只影响宿主边界', async () => {
        const { manager, config } = setup();
        const source = responseFor(makeTextStreamEvents('标准回答'));
        const completed = await source.completed;
        const result = Object.freeze({
          ...completed,
          model: '',
          blocks: Object.freeze(completed.blocks),
          usage: Object.freeze({ ...completed.usage, reasoningTokens: 3 }),
        });
        manager.inference.mockResolvedValueOnce({
          ...source,
          completed: Promise.resolve(result),
        });
        const onCompleted = vi.fn();
        const observed = vi.fn();
        const { events, terminal } = await drain(
          queryT({
            prompt: 'Hello',
            model: 'test-model',
            promptId: 'standard-result',
            config,
            onModelRequestCompleted: onCompleted,
            turnHookFactories: [
              () => ({
                id: 'standard-result-observer',
                register(on) {
                  on('turn.step', async function* (_context, input, next) {
                    const step = yield* next(input);
                    observed(step);
                    return step;
                  });
                },
              }),
            ],
          }),
        );
        expect(terminal.reason).toBe('end_turn');
        const usage = onCompleted.mock.calls[0][0].usage;
        expect(usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
        expect(getThinkingTokenCount(usage)).toBe(3);
        expect(observed).toHaveBeenCalledWith(
          expect.objectContaining({
            answer: '标准回答',
            stopReason: 'end_turn',
            usage: expect.objectContaining({
              request_id: usage.request_id,
              model: 'test-model',
            }),
          }),
        );
        expect(getThinkingTokenCount(observed.mock.calls[0][0].usage)).toBe(3);
        expect(events.filter(isRuntimeAssistantEvent)).toMatchObject([
          {
            message: {
              model: 'test-model',
              content: [{ type: 'text', text: '标准回答' }],
              usage: { request_id: usage.request_id },
            },
          },
        ]);
        expect(usage.request_id).not.toBe(result.messageId);
        expect(result.model).toBe('');
        expect(result).not.toHaveProperty('content');
        expect(result.usage).toEqual({
          ...completed.usage,
          reasoningTokens: 3,
        });
        expect(result.usage).not.toHaveProperty('request_id');
        expect(result.usage).not.toHaveProperty('context_usage_ratio');
      });

      it('标准残缺结果保留稀疏 index，Hook 与历史只读取已交付内容', async () => {
        const { manager, config } = setup();
        const response = responseFor(
          [
            ...makeTextStreamEvents('已闭合').slice(0, 4),
            ...makeTextStreamEvents('开放正文').slice(1, 3),
            makeSocketCloseError(),
          ],
          [2, 7],
        );
        const rawPartial = await response.partial;
        Object.freeze(rawPartial.blocks);
        Object.freeze(rawPartial);
        const before = structuredClone(rawPartial);
        manager.inference.mockResolvedValueOnce(response);
        const observed = vi.fn();
        const { events, terminal } = await drain(
          queryT({
            prompt: 'Hello',
            model: 'test-model',
            promptId: 'standard-partial',
            config,
            turnHookFactories: [
              () => ({
                id: 'standard-partial-observer',
                register(on) {
                  on('turn.step', async function* (_context, input, next) {
                    const step = yield* next(input);
                    observed(step);
                    return step;
                  });
                },
              }),
            ],
          }),
        );
        expect(terminal.reason).toBe('error');
        const messages = events.filter(
          (event) =>
            event.type === 'assistant' &&
            event.partialStreamIndex !== undefined,
        );
        expect(messages).toMatchObject([
          {
            partialStreamIndex: 2,
            message: { content: [{ type: 'text', text: '已闭合' }] },
          },
          {
            partialStreamIndex: 7,
            message: { content: [{ type: 'text', text: '开放正文' }] },
          },
        ]);
        expect(observed).toHaveBeenCalledWith(
          expect.objectContaining({
            answer: '已闭合\n开放正文',
            toolUses: [],
            stopReason: null,
          }),
        );
        expect(await response.partial).toBe(rawPartial);
        expect(rawPartial).toEqual(before);
        expect(rawPartial).not.toHaveProperty('content');
      });

      it('标准残缺结果只结算已交付工具，未闭合工具保留为恢复事实', async () => {
        const { manager, config } = setup();
        const response = responseFor([
          ...makeToolUseStreamEvents('delivered', 'Read', { path: 'a' }).slice(
            0,
            4,
          ),
          {
            type: 'content_block_start',
            index: 4,
            content_block: {
              type: 'tool_use',
              id: 'unfinished',
              name: 'Read',
              input: {},
            },
          },
          {
            type: 'content_block_delta',
            index: 4,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"path":',
            },
          },
          makeSocketCloseError(),
        ]);
        const rawPartial = await response.partial;
        const before = structuredClone(rawPartial);
        manager.inference
          .mockResolvedValueOnce(response)
          .mockResolvedValueOnce(responseFor(makeTextStreamEvents('恢复完成')));
        const toolBridge = createMockStreamingToolBridge(
          async (blocks) => ({
            toolResults: blocks.map((block) => ({
              type: 'tool_result',
              tool_use_id: block.id,
              content: 'read once',
              is_error: false,
            })),
            settlement: new Map(
              blocks.map((block) => [block.id, 'completed' as const]),
            ),
            allMessages: [],
          }),
          [TEST_TOOL_SCHEMA],
        );
        const { events, terminal } = await drain(
          queryT({
            prompt: 'Read',
            model: 'test-model',
            promptId: 'standard-tool-partial',
            config,
            toolBridge,
          }),
        );
        if (terminal.reason === 'error') throw terminal.error;
        expect(terminal.reason).toBe('end_turn');
        expect(toolBridge.execute).toHaveBeenCalledOnce();
        expect(
          events.filter(isRuntimeToolResultEvent).flatMap(getToolResultBlocks),
        ).toMatchObject([
          { tool_use_id: 'delivered', content: 'read once' },
          {
            tool_use_id: 'unfinished',
            is_error: true,
            content: UNDELIVERED_TOOL_INCOMPLETE_ARGUMENTS_RESULT,
          },
        ]);
        expect(manager.inference).toHaveBeenCalledTimes(2);
        expect([...rawPartial.openBlocks.values()]).toEqual([
          {
            type: 'tool_use',
            id: 'unfinished',
            name: 'Read',
            inputJson: '{"path":',
          },
        ]);
        expect(rawPartial).toEqual(before);

        const durable = events.filter(isDurableQueryEvent);
        const assistants = durable.filter(
          (event) => event.type === 'assistant',
        );
        const retained = assistants.find((event) =>
          event.message.content.some(
            (block) => block.type === 'tool_use' && block.id === 'delivered',
          ),
        );
        const placeholder = assistants.find((event) =>
          event.message.content.some(
            (block) => block.type === 'tool_use' && block.id === 'unfinished',
          ),
        );
        expect(retained).toBeDefined();
        expect(placeholder).toBeDefined();
        expect(placeholder?.message.id).not.toBe(retained?.message.id);
        expect(placeholder?.message.stop_reason).toBe('tool_use');
        expect(placeholder?.message.usage).toBeUndefined();
        const paired = durable.find(
          (event) =>
            event.type === 'user' &&
            event.sourceToolAssistantUUID === placeholder?.uuid,
        );
        expect(paired).toBeDefined();

        const directory = await createTmpDir({});
        const filePath = join(directory, 'standard-tool-partial.jsonl');
        const { writer, store } = await createTestTranscriptWriter({
          filePath,
          sessionId: 'standard-tool-partial',
          cwd: directory,
          entrypoint: 'cli',
          flushIntervalMs: 0,
        });
        try {
          let parentUuid: string | null = null;
          for (const event of durable)
            parentUuid = await writer.recordMessages([event], parentUuid);
          await writer.close();
          await store.close();
          const restored = await new TranscriptRepository().resolveSession(
            filePath,
          );
          expect(restored?.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ uuid: retained?.uuid }),
              expect.objectContaining({ uuid: placeholder?.uuid }),
              expect.objectContaining({ uuid: paired?.uuid }),
            ]),
          );
          expect(
            restored?.chain.find((event) => event.uuid === paired?.uuid),
          ).toMatchObject({ parentUuid: placeholder?.uuid });
          expect(restored?.chain.at(0)?.parentUuid).toBeNull();
        } finally {
          await writer.close();
          await store.close();
          await cleanupTmpDir(directory);
        }
      });

      it('标准停止原因触发空工具响应的语义重试，保持旧历史格式', async () => {
        const { manager, config } = setup();
        manager.inference
          .mockResolvedValueOnce(
            responseFor(
              makeMalformedToolUseStreamEvents('', { includeContent: false }),
            ),
          )
          .mockResolvedValueOnce(responseFor(makeTextStreamEvents('重试完成')));
        const { events, terminal } = await drain(
          queryT({
            prompt: 'Read',
            model: 'test-model',
            promptId: 'standard-malformed',
            config,
            toolBridge: createMockToolBridge(undefined, [TEST_TOOL_SCHEMA]),
          }),
        );
        expect(terminal.reason).toBe('end_turn');
        expect(manager.inference).toHaveBeenCalledTimes(2);
        expect(events.filter(isRuntimeAssistantEvent)).toMatchObject([
          { message: { content: [], stop_reason: 'tool_use' } },
          {
            message: {
              content: [{ type: 'text', text: '重试完成' }],
              stop_reason: 'end_turn',
            },
          },
        ]);
      });

      function responseFor(
        frames: unknown[],
        blockIndices: readonly number[] = [],
      ) {
        const events = buildMessagesStreamEvents(
          (async function* () {
            for (const frame of frames) {
              if (frame instanceof Error)
                throw toClientError(frame, { operation: 'test.inference' });
              yield frame as RawMessageStreamEvent;
            }
          })(),
        );
        const response = createModelStreamResponse(
          (async function* () {
            // Transport 会连续编号；稀疏编号在标准模型事件层注入。
            for await (const event of events) {
              yield 'index' in event
                ? { ...event, index: blockIndices[event.index] ?? event.index }
                : event;
            }
          })(),
        );
        void response.completed.catch(() => undefined);
        return response;
      }

      it.each(['断流', '缺少终态'] as const)(
        '%s 时正文直接来自 response.partial，不在 loop 重聚合',
        async (failure) => {
          const { manager, config } = setup();
          const response = responseFor([
            ...makeTextStreamEvents('增量占位').slice(0, 3),
            ...(failure === '断流' ? [makeSocketCloseError()] : []),
          ]);
          const partial = response.partial.then((result) => ({
            ...result,
            openBlocks: new Map(
              [...result.openBlocks].map(([index, block]) => [
                index,
                { ...block, text: '残缺正文' },
              ]),
            ),
          }));
          manager.inference.mockResolvedValueOnce({ ...response, partial });
          const onCompleted = vi.fn();
          const { events, terminal } = await drain(
            queryT({
              prompt: 'Hello',
              model: 'test-model',
              promptId: 'response-snapshot',
              config,
              onModelRequestCompleted: onCompleted,
            }),
          );
          expect(terminal.reason).toBe('error');
          expect(onCompleted).not.toHaveBeenCalled();
          expect((await partial).openBlocks.get(0)).toEqual({
            type: 'text',
            text: '残缺正文',
          });
          const partialMessages = events.filter(
            (event) =>
              event.type === 'assistant' && event.partialStreamIndex === 0,
          );
          expect(partialMessages).toHaveLength(1);
          expect(partialMessages[0]).toMatchObject({
            message: { content: [{ type: 'text', text: '残缺正文' }] },
          });
        },
      );

      it('块已闭合但缺少停止原因时，从 partial 完整块保留已交付内容', async () => {
        const { manager, config } = setup();
        const source = responseFor(
          makeTextStreamEvents('已闭合正文').slice(0, 4),
        );
        const response = {
          ...source,
          partial: source.partial.then((result) => ({
            ...result,
            blocks: result.blocks.map((block) =>
              block.type === 'text' ? { ...block, text: '终态正文' } : block,
            ),
          })),
        };
        manager.inference.mockResolvedValueOnce(response);
        const onCompleted = vi.fn();
        const { events, terminal } = await drain(
          queryT({
            prompt: 'Hello',
            model: 'test-model',
            promptId: 'response-snapshot-no-stop-reason',
            config,
            onModelRequestCompleted: onCompleted,
          }),
        );
        expect(terminal.reason).toBe('error');
        expect(onCompleted).not.toHaveBeenCalled();
        expect((await response.partial).openBlocks.size).toBe(0);
        expect(
          events.filter(
            (event) =>
              event.type === 'assistant' && event.partialStreamIndex === 0,
          ),
        ).toMatchObject([
          { message: { content: [{ type: 'text', text: '终态正文' }] } },
        ]);
      });

      it.each(['text_delta', 'input_json_delta'] as const)(
        '上游已读完，在 %s 后取消只保留已交付内容，不执行预读工具',
        async (deltaType) => {
          const { manager, config } = setup();
          const frames =
            deltaType === 'text_delta'
              ? [
                  ...makeTextStreamEvents('前缀').slice(0, 3),
                  {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: '未展示后缀' },
                  },
                  { type: 'content_block_stop', index: 0 },
                  ...makeToolUseStreamEvents('unseen-tool', 'Read', {
                    path: 'a',
                  })
                    .slice(1)
                    .map((frame) => {
                      const event = frame as RawMessageStreamEvent;
                      return 'index' in event ? { ...event, index: 4 } : event;
                    }),
                ]
              : makeToolUseStreamEvents('unfinished-delivery', 'Read', {
                  path: 'a',
                });
          const response = responseFor(frames);
          await response.completed;
          manager.inference.mockResolvedValueOnce(response);
          const controller = new AbortController();
          const bridge = createMockStreamingToolBridge(
            async () => ({ toolResults: [], allMessages: [] }),
            [TEST_TOOL_SCHEMA],
          );
          const stream = queryT({
            prompt: 'Read',
            model: 'test-model',
            promptId: 'response-snapshot-cancel',
            config,
            signal: controller.signal,
            toolBridge: bridge,
          });
          for (;;) {
            const next = await stream.next();
            if (next.done) throw new Error('未收到预期增量');
            if (
              next.value.type === 'stream_event' &&
              next.value.event.type === 'content_block_delta' &&
              next.value.event.delta.type === deltaType
            )
              break;
          }
          controller.abort();
          const { events, terminal } = await drain(stream);
          expect(terminal.reason).toBe('abort');
          expect((await response.partial).openBlocks.size).toBe(0);
          expect(bridge.execute).not.toHaveBeenCalled();
          const partial = events.filter(
            (event) =>
              event.type === 'assistant' &&
              event.partialStreamIndex !== undefined,
          );
          if (deltaType === 'text_delta') {
            expect(partial).toHaveLength(1);
            expect(partial[0]).toMatchObject({
              message: { content: [{ type: 'text', text: '前缀' }] },
            });
            expect(JSON.stringify(partial)).not.toContain('未展示后缀');
          } else expect(partial).toEqual([]);
        },
      );
    });

    it.each([
      {
        isSubagent: false,
        modelPurpose: undefined,
        policyPurpose: 'main',
        providerPurpose: 'main',
      },
      {
        isSubagent: true,
        modelPurpose: undefined,
        policyPurpose: 'task',
        providerPurpose: 'task',
      },
      {
        isSubagent: true,
        modelPurpose: 'hook_prompt' as const,
        policyPurpose: 'hook_prompt',
        providerPurpose: 'hook_prompt',
      },
      {
        isSubagent: false,
        modelPurpose: 'side_question' as const,
        policyPurpose: 'utility',
        providerPurpose: 'main',
      },
    ])(
      'preserves SDK model/parameter overrides after provider selection for $policyPurpose',
      async ({ isSubagent, modelPurpose, policyPurpose, providerPurpose }) => {
        setStreamEvents('Hello');
        mockFetch.mockResolvedValue(mockOkResponse());
        const getModelPolicy = vi.fn(async () => ({
          model: 'policy-model',
          parameters: {
            reasoningEffort: 'low' as const,
            contextWindow: 128000,
          },
        }));
        const { manager, modelRouter, config } = setup(getModelPolicy);
        const resolveSystemPrompt = recordingPromptResolver();
        const reference = isSubagent
          ? testModelResolution('test-model')
          : undefined;
        const { terminal } = await drain(
          queryT({
            prompt: 'Hello',
            model: 'test-model',
            promptId: 'provider-sdk-policy',
            config,
            resolveSystemPrompt,
            isSubagent,
            modelPurpose,
            parentSelection: reference,
            selectModel: modelRouter.resolve,
          }),
        );
        expect(terminal.reason).toBe('end_turn');
        expect(getModelPolicy).toHaveBeenCalledOnce();
        expect(manager.select).toHaveBeenCalledTimes(2);
        expect(manager.select.mock.calls[0]![0].parentSelection).toBe(
          reference,
        );
        expect(
          manager.select.mock.calls.map(([input]) => input.purpose),
        ).toEqual([providerPurpose, providerPurpose]);
        expect(getModelPolicy.mock.calls[0]?.slice(0, 1)).toEqual([
          policyPurpose,
        ]);
        expect(modelRouter.resolve).not.toHaveBeenCalled();
        const request = manager.inference.mock.calls[0]![0];
        expect(resolveSystemPrompt).toHaveBeenCalledOnce();
        expect(resolveSystemPrompt.mock.calls[0]![1]).toBe(
          request.resolution.model,
        );
        expect(request.resolution.model.key).toBe('policy-model');
        expect(request.resolution.config).toMatchObject({
          reasoning: { effort: 'low' },
          context: { contextWindow: 128000 },
        });
        expect(request).not.toHaveProperty('workdirs');
        expect(request.qoder).not.toHaveProperty('workdirs');
      },
    );

    it('SDK 补目录后恢复显式模型，推理复用最终覆盖与 workdirs 且不回写主锚点', async () => {
      setStreamEvents('Recovered');
      let ready = false;
      const host = vi.fn(async () => {
        ready = true;
        return {
          parameters: { reasoningEffort: 'low' as const },
          labels: { taskId: 'sdk-scene' },
        };
      });
      const { manager, config } = setup(host);
      const getModel = manager.getModel.getMockImplementation()!;
      manager.getModel.mockImplementation(async (key) => {
        if (!ready) throw new ModelNotFoundError('目录未就绪', 404);
        return getModel(key);
      });
      const workdirs = Object.freeze(['/request-repo']);
      const { terminal } = await drain(
        queryT({
          prompt: 'Hello',
          model: 'requested-model',
          promptId: 'sdk-recovery',
          config,
          workdirs,
          querySelection: {
            key: 'requested-model',
            config: { context: { maxOutputTokens: 4096 } },
          },
        }),
      );
      expect(terminal.reason).toBe('end_turn');
      expect(host).toHaveBeenCalledOnce();
      expect(host.mock.calls[0]).toEqual([
        'main',
        'test-session',
        0,
        undefined,
        expect.any(AbortSignal),
        {},
      ]);
      expect(manager.setMainModel).not.toHaveBeenCalled();
      const request = manager.inference.mock.calls[0]![0];
      expect(request.resolution.model.key).toBe('requested-model');
      expect(request.resolution.config).toMatchObject({
        reasoning: { effort: 'low' },
        context: { maxOutputTokens: 4096 },
      });
      expect(request.qoder.workdirs).toBe(workdirs);
      expect(request).not.toHaveProperty('workdirs');
      for (const [input] of manager.select.mock.calls)
        expect(input.workdirs).toBe(workdirs);
    });

    it.each([
      undefined,
      { parameters: { reasoningEffort: 'low' as const } },
      { model: 'policy-model' },
    ])(
      '子代理前置模型 404 由 task 策略恢复 %s，推理只消费最终选模',
      async (policy) => {
        setStreamEvents('Recovered child');
        let ready = false;
        const host = vi.fn(async () => {
          ready = true;
          return policy;
        });
        const { manager, config } = setup(host);
        const getModel = manager.getModel.getMockImplementation()!;
        manager.getModel.mockImplementation(async (key) => {
          if (!ready && key === 'requested-model')
            throw new ModelNotFoundError('子代理模型暂缺', 404);
          return getModel(key);
        });
        const workdirs = Object.freeze(['/child-repo']);
        const { terminal } = await drain(
          queryT({
            prompt: 'child task',
            model: 'requested-model',
            promptId: 'sdk-child-recovery',
            config,
            isSubagent: true,
            agentId: 'child-id',
            agentType: 'test-child',
            workdirs,
            querySelection: {
              key: 'requested-model',
              config: { context: { maxOutputTokens: 4096 } },
            },
          }),
        );
        expect(terminal.reason).toBe('end_turn');
        expect(host).toHaveBeenCalledExactlyOnceWith(
          'task',
          'test-session',
          0,
          'child-id',
          expect.any(AbortSignal),
          { agentType: 'test-child' },
        );
        expect(manager.setMainModel).not.toHaveBeenCalled();
        const request = manager.inference.mock.calls[0]![0];
        expect(request.resolution.model.key).toBe(
          policy && 'model' in policy ? 'policy-model' : 'requested-model',
        );
        expect(request.resolution.config.context?.maxOutputTokens).toBe(4096);
        if (policy && 'parameters' in policy)
          expect(request.resolution.config.reasoning?.effort).toBe('low');
        expect(request.qoder.workdirs).toBe(workdirs);
        expect(request).not.toHaveProperty('workdirs');
      },
    );

    it('SDK 返回覆盖期间身份变化时不发起推理或再次选模', async () => {
      let identity = 'account-1';
      const { manager, config } = setup(async () => {
        identity = 'account-2';
        return { model: 'policy-model' };
      });
      config.getModelRequestIdentity = () => identity;
      await expect(
        drain(
          queryT({
            prompt: 'Hello',
            model: 'test-model',
            promptId: 'sdk-stale',
            config,
          }),
        ),
      ).rejects.toThrow('Session model changed');
      expect(manager.select).toHaveBeenCalledOnce();
      expect(manager.inference).not.toHaveBeenCalled();
    });

    function skillBridge(effort?: 'low') {
      return createMockToolBridge(async (blocks) => ({
        toolResults: blocks.map((block) => ({
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: 'skill activated',
          is_error: false,
        })),
        allMessages: [
          {
            message: {
              type: 'tool_result' as const,
              toolCallId: blocks[0]!.id,
              content: 'skill activated',
              isError: false,
            },
            contextModifier: {
              toolCallId: blocks[0]!.id,
              modifyContext: (context: ToolUseContext) => ({
                ...context,
                skillOverrides: { model: 'skill-model', effort },
              }),
            },
          },
        ],
      }));
    }

    it('Skill 切模后准备下一轮失败，StopFailure 仍归因于本轮请求模型', async () => {
      mockStreamTurns.push([
        ...makeToolUseStreamEvents('activate-skill', 'Skill', {}).slice(0, 4),
        makeSocketCloseError(),
      ]);
      const { manager, config } = setup();
      const bridge = skillBridge();
      const failure = new Error('next model prompt failed');
      const resolveSystemPrompt = vi
        .fn<NonNullable<QueryParams['resolveSystemPrompt']>>()
        .mockImplementationOnce(async (model, selectedModel) => {
          expect(selectedModel?.key).toBe(model);
          return {
            blocks: systemPromptFromText('initial-system'),
            source: 'default',
            bundle: 'full',
          };
        })
        .mockImplementationOnce(async (model, selectedModel) => {
          expect(selectedModel?.key).toBe(model);
          throw failure;
        });
      const hookCoordinator = {
        fireBefore: vi.fn().mockResolvedValue(null),
        drainPendingAsyncContext: vi.fn(),
        fireStopFailure: vi.fn().mockResolvedValue(undefined),
      };
      const { terminal, events } = await drain(
        queryT({
          prompt: 'Activate skill',
          model: 'test-model',
          promptId: 'skill-request-attribution',
          config,
          resolveSystemPrompt,
          hookCoordinator: hookCoordinator as never,
          toolBridge: bridge,
        }),
      );
      expect(terminal.reason).toBe('error');
      expect(terminal.error).toBe(failure);
      expect(manager.inference).toHaveBeenCalledOnce();
      expect(resolveSystemPrompt.mock.calls.map(([model]) => model)).toEqual([
        'test-model',
        'skill-model',
      ]);
      expect(resolveSystemPrompt.mock.calls[0][1]).toBe(
        manager.inference.mock.calls[0][0].resolution.model,
      );
      expect(resolveSystemPrompt.mock.calls[1][1]?.key).toBe('skill-model');
      expect(events.filter(isRuntimeToolResultEvent)).toHaveLength(1);
      expect(hookCoordinator.fireStopFailure).toHaveBeenCalledOnce();
      expect(hookCoordinator.fireStopFailure.mock.calls[0][3]).toBe(
        manager.inference.mock.calls[0][0].resolution.model.key,
      );
    });

    it('pure inherited Agent keeps its parent effort when a Skill changes the model', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('activate-skill', 'Skill', {}),
        makeTextStreamEvents('Done'),
      );
      const host = vi.fn<NonNullable<Config['getModelPolicy']>>(
        async () => undefined,
      );
      const { manager, config } = setup(host);
      const parentSelection = testModelResolution('test-model', {
        config: {
          reasoning: { effort: 'low' },
          sampling: { temperature: 0.7 },
        },
      });
      const { terminal } = await drain(
        query({
          prompt: 'Activate skill',
          promptId: 'inherited-skill',
          sessionId: 'test-session',
          config,
          isSubagent: true,
          parentSelection,
          ...mockTooling(skillBridge()),
        }),
      );
      expect(terminal.reason).toBe('end_turn');
      expect(host).toHaveBeenCalledTimes(2);
      expect(manager.inference).toHaveBeenCalledTimes(2);
      expect(manager.inference.mock.calls[1]![0].resolution).toMatchObject({
        model: { key: 'skill-model' },
        config: { reasoning: { effort: 'low' } },
      });
      const lastBaseInput = manager.select.mock.calls.at(-1)![0];
      expect(lastBaseInput.overrideSelection?.config).toEqual({
        reasoning: { effort: 'low' },
      });
      expect(lastBaseInput.parentSelection).toBeUndefined();
    });

    it.each(['key', 'parent'] as const)(
      'Skill 参数型 SDK policy 保留 Skill 模型、请求配置和 workdirs，不切换主锚点 (%s)',
      async (source) => {
        mockStreamTurns.push(
          makeToolUseStreamEvents('activate-skill', 'Skill', {}),
          makeTextStreamEvents('Done'),
        );
        const host = vi
          .fn<NonNullable<Config['getModelPolicy']>>()
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce({
            parameters: { reasoningEffort: 'low' },
            labels: { taskId: 'skill-scene' },
          });
        const { manager, config } = setup(host);
        const resolveSystemPrompt = recordingPromptResolver();
        const workdirs = Object.freeze(['/skill-dir']);
        const { terminal } = await drain(
          queryT({
            prompt: 'Activate skill',
            model: 'test-model',
            promptId: 'skill-policy',
            config,
            resolveSystemPrompt,
            workdirs,
            ...(source === 'key'
              ? {
                  querySelection: {
                    key: 'test-model',
                    config: { context: { maxOutputTokens: 4096 } },
                  },
                }
              : {
                  isSubagent: true,
                  parentSelection: testModelResolution('test-model'),
                  querySelection: {
                    key: 'test-model',
                    config: { context: { maxOutputTokens: 4096 } },
                  },
                }),
            ...mockTooling(skillBridge()),
          }),
        );
        expect(terminal.reason).toBe('end_turn');
        expect(host).toHaveBeenCalledTimes(2);
        expect(host.mock.calls[1]![5]).toMatchObject({
          resolvedModel: 'skill-model',
        });
        expect(manager.inference).toHaveBeenCalledTimes(2);
        const request = manager.inference.mock.calls[1]![0];
        expect(resolveSystemPrompt).toHaveBeenCalledTimes(2);
        expect(resolveSystemPrompt.mock.calls[0]![1]).toBe(
          manager.inference.mock.calls[0]![0].resolution.model,
        );
        expect(resolveSystemPrompt.mock.calls[1]![1]).toBe(
          request.resolution.model,
        );
        expect(request.resolution.model.key).toBe('skill-model');
        expect(request.resolution.config).toMatchObject({
          reasoning: { effort: 'low' },
          context: { maxOutputTokens: 4096 },
        });
        expect(request.qoder.workdirs).toBe(workdirs);
        expect(request).not.toHaveProperty('workdirs');
        expect(manager.setMainModel).not.toHaveBeenCalled();
        for (const [input] of manager.select.mock.calls)
          expect(input.workdirs).toBe(workdirs);
      },
    );

    it.each(['parent', 'fresh'] as const)(
      'fork %s path still applies SDK exactly once when a Skill changes the model',
      async (source) => {
        mockStreamTurns.push(
          makeToolUseStreamEvents('activate-skill', 'Skill', {}),
          makeTextStreamEvents('Done'),
        );
        const host = vi.fn<NonNullable<Config['getModelPolicy']>>(async () => ({
          parameters: { reasoningEffort: 'low' },
        }));
        const { manager, config } = setup(host);
        const previous = testModelResolution('test-model', {
          config: {
            reasoning: { effort: 'high' },
            sampling: { temperature: 0.7 },
          },
        });
        if (source === 'fresh') manager.select.mockResolvedValueOnce(previous);
        const result = await runForkedAgent({
          config,
          model: 'test-model',
          prompt: 'Activate skill',
          sessionId: 'test-session',
          promptId: 'fork-skill',
          forkLabel: 'agent-fork',
          transcriptAgentId: 'fork-agent',
          maxTurns: 2,
          ...(source === 'parent' ? { parentSelection: previous } : {}),
          ...mockTooling(skillBridge('low')),
        });
        expect(result.textContent).toContain('Done');
        expect(host).toHaveBeenCalledOnce();
        expect(host.mock.calls[0]?.[0]).toBe('task');
        expect(host.mock.calls[0]?.[5]).toMatchObject({
          resolvedModel: 'skill-model',
        });
        expect(manager.inference).toHaveBeenCalledTimes(2);
        expect(manager.inference.mock.calls[0]![0].resolution).toEqual(
          previous,
        );
        expect(manager.inference.mock.calls[1]![0].resolution.model.key).toBe(
          'skill-model',
        );
        expect(
          manager.inference.mock.calls[1]![0].resolution.config.sampling,
        ).toBeUndefined();
      },
    );

    it.each(['403', 'host-error', 'cancel'] as const)(
      'Skill SDK 准备失败（%s）后保留错误，不叠加 effort 或发起下一次推理',
      async (kind) => {
        mockStreamTurns.push(
          makeToolUseStreamEvents('activate-skill', 'Skill', {}),
        );
        const failure =
          kind === '403'
            ? new ModelNotFoundError('目录治理拒绝', 403)
            : kind === 'cancel'
              ? new DOMException('cancelled', 'AbortError')
              : new Error('host policy failed');
        const controller = new AbortController();
        const host = vi
          .fn<NonNullable<Config['getModelPolicy']>>()
          .mockResolvedValueOnce(undefined)
          .mockImplementationOnce(async () => {
            if (kind === 'cancel') controller.abort(failure);
            throw failure;
          });
        const { manager, config } = setup(host);
        if (kind === '403') {
          const select = manager.select.getMockImplementation()!;
          manager.select.mockImplementation(async (input) => {
            if (
              (input.overrideSelection && 'model' in input.overrideSelection
                ? input.overrideSelection.model.key
                : undefined) === 'skill-model'
            )
              throw failure;
            return select(input);
          });
        }
        await expect(
          drain(
            queryT({
              prompt: 'Activate skill',
              model: 'test-model',
              promptId: `skill-policy-${kind}`,
              config,
              signal: controller.signal,
              ...mockTooling(skillBridge('low')),
            }),
          ),
        ).rejects.toBe(failure);
        expect(host).toHaveBeenCalledTimes(kind === '403' ? 1 : 2);
        expect(manager.inference).toHaveBeenCalledOnce();
        // 一次主选模、一次 Skill 基础选模；失败后不能再进行 effort 选模。
        expect(manager.select).toHaveBeenCalledTimes(2);
      },
    );

    it('does not send inference or fall back to the old router after a provider-path SDK policy failure', async () => {
      const error = new Error('get_model_policy timeout');
      const { modelRouter, config } = setup(async () => {
        throw error;
      });
      await expect(
        drain(
          queryT({
            prompt: 'Hello',
            model: 'test-model',
            promptId: 'provider-sdk-failure',
            config,
            selectModel: modelRouter.resolve,
          }),
        ),
      ).rejects.toBe(error);
      expect(modelRouter.resolve).not.toHaveBeenCalled();
    });
  });

  describe('QCS dynamic turn budget', () => {
    function setBudget(limits = [2, 4, 5]) {
      vi.stubEnv(
        'QWEN_CONFIG_DYNAMIC_TURN_BUDGET',
        JSON.stringify({
          enabled: true,
          models: { qmodel_38max: { enabled: true, limits } },
        }),
      );
    }
    function budgetToolBridge(schemas: ModelStreamTool[] = []) {
      return createMockToolBridge(
        async (blocks) => ({
          toolResults: blocks.map((block) => ({
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: 'File content',
            is_error: false,
          })),
          allMessages: [],
        }),
        schemas,
      );
    }
    function toolLoop(count: number) {
      for (let i = 0; i < count; i++) {
        mockStreamTurns.push(
          makeToolUseStreamEvents(`budget_tool_${i}`, READ_FILE_TOOL_NAME, {
            file_path: `/file-${i}`,
          }),
        );
      }
    }
    function requestText(index: number, role?: 'system' | 'user') {
      const request = mockInferenceRequests[index] as ModelStreamRequest;
      return JSON.stringify(
        request.prompt.messages.filter(
          (message) => !role || message.role === role,
        ),
      );
    }
    function options(extra: Partial<QueryTestOptions> = {}): QueryTestOptions {
      return {
        prompt: 'Complete the task',
        model: 'qmodel_38max',
        promptId: 'budget-query',
        toolBridge: budgetToolBridge(),
        ...extra,
      };
    }
    beforeEach(() => setBudget());
    afterEach(() => vi.unstubAllEnvs());

    it('continues beyond all stages and repeats the exhausted reminder without limiting tools', async () => {
      toolLoop(7);
      mockStreamTurns.push(
        makeTextStreamEvents('Seven files read; work remains.'),
      );
      const opts = options({ toolBridge: budgetToolBridge([TEST_TOOL_SCHEMA]) });
      const { events, terminal } = await drain(queryT(opts));
      expect(terminal).toMatchObject({ reason: 'end_turn', numTurns: 8 });
      expect(mockInferenceRequests).toHaveLength(8);
      expect(opts.toolBridge!.execute).toHaveBeenCalledTimes(7);
      expect(requestText(0, 'user')).toContain(
        'The remaining count is not a reason to stop early or to cut exploration the task needs.',
      );
      expect(requestText(0, 'system')).not.toContain('# Turn budget');
      expect(requestText(1)).toContain('You have 1 turns left');
      expect(requestText(2)).toContain('an additional 2 turns');
      expect(requestText(4)).toContain('an additional 1 turns');
      expect(requestText(4)).not.toContain(
        'You have 0 turns left to complete the task.',
      );
      for (const index of [5, 6, 7]) {
        expect(requestText(index)).toContain(
          'You have 0 turns left to complete the task.',
        );
        const request = mockInferenceRequests[index] as ModelStreamRequest;
        expect(request.prompt.tools).toHaveLength(1);
        expect(request.prompt.toolChoice).not.toBe('none');
      }
      expect(
        events.filter(
          (e) =>
            e.type === 'attachment' &&
            e.attachment.type === 'turn_budget_exhausted',
        ),
      ).toHaveLength(3);
    });

    it('keeps the five-stage budget soft beyond 384 completed turns', async () => {
      setBudget([24, 48, 96, 192, 384]);
      toolLoop(385);
      mockStreamTurns.push(makeTextStreamEvents('Completed and verified.'));
      const toolBridge = budgetToolBridge([TEST_TOOL_SCHEMA]);
      const { events, terminal } = await drain(queryT(options({ toolBridge })));
      expect(terminal).toMatchObject({ reason: 'end_turn', numTurns: 386 });
      expect(toolBridge.execute).toHaveBeenCalledTimes(385);
      for (const [turn, additional] of [
        [24, 24],
        [48, 48],
        [96, 96],
        [192, 192],
      ]) {
        expect(requestText(turn)).toContain(`an additional ${additional} turns`);
      }
      for (const turn of [384, 385]) {
        expect(requestText(turn)).toContain(
          'You have 0 turns left to complete the task.',
        );
        expect(
          (mockInferenceRequests[turn] as ModelStreamRequest).prompt.tools,
        ).toHaveLength(1);
      }
      expect(
        events.filter(
          (event) =>
            event.type === 'attachment' &&
            event.attachment.type === 'turn_budget_exhausted',
        ),
      ).toHaveLength(2);
    });

    it('allows tool results to reach the next request after exhaustion', async () => {
      setBudget([1]);
      toolLoop(3);
      mockStreamTurns.push(makeTextStreamEvents('Finished'));
      const execute = vi.fn(async (blocks: ModelToolUseBlock[]) => ({
        toolResults: blocks.map((block) => ({
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: 'CHECK_RESULT_78312',
          is_error: false,
        })),
        allMessages: [],
      }));
      const toolBridge = createMockToolBridge(execute, [TEST_TOOL_SCHEMA]);
      const { events, terminal } = await drain(
        queryT(options({ toolBridge, toolChoice: 'auto' })),
      );
      expect(terminal).toMatchObject({ reason: 'end_turn', numTurns: 4 });
      expect(execute).toHaveBeenCalledTimes(3);
      expect(
        (mockInferenceRequests[2] as ModelStreamRequest).prompt.toolChoice,
      ).toBe('auto');
      expect(requestText(3)).toContain('CHECK_RESULT_78312');
      expect(
        events.filter(
          (e) =>
            e.type === 'attachment' &&
            e.attachment.type === 'turn_budget_exhausted',
        ),
      ).toHaveLength(3);
    });

    it('preserves Stop hook continuation after the soft budget is exhausted', async () => {
      setBudget([1]);
      mockStreamTurns.push(
        makeTextStreamEvents('First answer'),
        makeTextStreamEvents('Reviewed answer'),
      );
      const fireAfter = vi
        .fn()
        .mockResolvedValueOnce({ inject: 'Review the answer', blocked: true })
        .mockResolvedValue(null);
      const { terminal } = await drain(
        queryT(
          options({
            hookCoordinator: {
              fireBefore: vi.fn().mockResolvedValue(null),
              fireAfter,
              drainPendingAsyncContext: vi.fn().mockReturnValue(undefined),
            } as never,
          }),
        ),
      );
      expect(terminal).toMatchObject({ reason: 'end_turn', numTurns: 2 });
      expect(fireAfter).toHaveBeenCalledTimes(2);
      expect(requestText(1)).toContain(
        'You have 0 turns left to complete the task.',
      );
    });

    it('clips stage grants to the caller hard limit and fires the stop hook', async () => {
      toolLoop(4);
      const fireAfter = vi.fn().mockResolvedValue(null);
      const { terminal } = await drain(
        queryT(
          options({
            maxTurns: 3,
            hookCoordinator: {
              fireBefore: vi.fn().mockResolvedValue(null),
              fireAfter,
              drainPendingAsyncContext: vi.fn().mockReturnValue(undefined),
            } as never,
          }),
        ),
      );
      expect(terminal).toMatchObject({ reason: 'max_turns', numTurns: 3 });
      expect(requestText(2)).toContain('an additional 1 turns');
      expect(requestText(2)).not.toContain('an additional 2 turns');
      expect(fireAfter).toHaveBeenCalledOnce();
    });

    it.each([false, true])(
      'leaves queued input pending at the hard limit with budget=%s',
      async (enabled) => {
        if (enabled) setBudget([1]);
        else vi.stubEnv('QWEN_CONFIG_DYNAMIC_TURN_BUDGET', undefined);
        toolLoop(1);
        const toolBridge = createMockToolBridge(async (blocks) => {
          enqueue({
            prompt: 'Review another file',
            commandMode: 'prompt',
            priority: 'next',
            uuid: 'budget-pending-input',
            sessionId: 'test-session',
          });
          return {
            toolResults: blocks.map((block) => ({
              type: 'tool_result' as const,
              tool_use_id: block.id,
              content: 'ok',
              is_error: false,
            })),
            allMessages: [],
          };
        });
        const { terminal } = await drain(
          queryT(
            options({
              toolBridge,
              maxTurns: 1,
              attachmentCtx: createAttachmentContext('/workspace/project'),
            }),
          ),
        );
        expect(terminal.reason).toBe('max_turns');
        expect(getCommandQueue()).toContainEqual(
          expect.objectContaining({
            uuid: 'budget-pending-input',
          }),
        );
      },
    );

    it.each([1, 2])(
      'does not force continuation after completion at turn %s',
      async (turns) => {
        toolLoop(turns - 1);
        mockStreamTurns.push(makeTextStreamEvents('Completed'));
        const { events, terminal } = await drain(queryT(options()));
        expect(terminal).toMatchObject({ reason: 'end_turn', numTurns: turns });
        expect(mockInferenceRequests).toHaveLength(turns);
        expect(
          events.some(
            (event) =>
              event.type === 'attachment' &&
              event.attachment.type === 'additional_turns',
          ),
        ).toBe(false);
      },
    );

    it.each([
      { model: 'other' },
      { isSubagent: true },
      { modelPurpose: 'task' as const },
      {
        selectModel: fixedSelection(
          testModelResolution({
            ...testProviderModel('qmodel_38max'),
            source: 'custom',
          }),
        ).resolve,
      },
    ])('keeps untargeted queries unchanged: %j', async (overrides) => {
      mockStreamTurns.push(makeTextStreamEvents('Completed'));
      await drain(queryT(options(overrides)));
      expect(requestText(0)).not.toContain('# Turn budget');
    });

    it('matches the selected model instead of the requested alias', async () => {
      mockStreamTurns.push(makeTextStreamEvents('Completed'));
      await drain(
        queryT(
          options({
            model: 'auto',
            selectModel: fixedSelection('qmodel_38max').resolve,
          }),
        ),
      );
      expect(requestText(0)).toContain('# Turn budget');
    });

    it('preserves disabled rollout and zero-turn caller behavior', async () => {
      vi.stubEnv('QWEN_CONFIG_DYNAMIC_TURN_BUDGET', undefined);
      toolLoop(3);
      const { terminal } = await drain(queryT(options({ maxTurns: 2 })));
      expect(terminal).toMatchObject({ reason: 'max_turns', numTurns: 2 });
      expect(requestText(0)).not.toContain('# Turn budget');
      setBudget();
      const result = await drain(queryT(options({ maxTurns: 0 })));
      expect(result.terminal).toMatchObject({
        reason: 'max_turns',
        numTurns: 0,
      });
      expect(mockInferenceRequests).toHaveLength(2);
      expect(
        result.events.some(
          (event) =>
            event.type === 'attachment' &&
            event.attachment.type === 'turn_budget_guidance',
        ),
      ).toBe(false);
    });

    it('freezes policy during a query and reads updated policy on the next query', async () => {
      setBudget([1, 2]);
      toolLoop(3);
      mockStreamTurns.push(makeTextStreamEvents('One file read.'));
      const toolBridge = createMockToolBridge(async (blocks) => {
        vi.stubEnv('QWEN_CONFIG_DYNAMIC_TURN_BUDGET', undefined);
        return {
          toolResults: blocks.map((block) => ({
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: 'ok',
            is_error: false,
          })),
          allMessages: [],
        };
      });
      const first = await drain(queryT(options({ toolBridge })));
      expect(first.terminal).toMatchObject({
        reason: 'end_turn',
        numTurns: 4,
      });
      expect(requestText(1)).toContain('an additional 1 turns');
      mockStreamTurns.push(makeTextStreamEvents('Completed'));
      await drain(queryT(options()));
      expect(requestText(4)).not.toContain('# Turn budget');
    });

    it.each([false, true])(
      'injects fresh guidance for a query with history-only=%s',
      async (skipInitialUserMessage) => {
        setBudget([1, 2]);
        for (let i = 0; i < 2; i++) {
          mockStreamTurns.push(
            makeToolUseStreamEvents(`reset_${i}`, READ_FILE_TOOL_NAME, {}),
            makeTextStreamEvents('Completed'),
          );
          const { terminal } = await drain(
            queryT(
              options({
                skipInitialUserMessage,
                messages: [createUserMessage('Prior task')],
              }),
            ),
          );
          expect(terminal).toMatchObject({ reason: 'end_turn', numTurns: 2 });
          expect(requestText(i * 2)).toContain('# Turn budget');
          expect(requestText(i * 2 + 1)).toContain('an additional 1 turns');
        }
      },
    );

    it('keeps the current reminder outside compacted history', async () => {
      setBudget([1]);
      toolLoop(1);
      mockStreamTurns.push(makeTextStreamEvents('Completed'));
      const compressionPipeline = {
        compress: vi
          .fn()
          .mockResolvedValue({ newHistory: [createUserMessage('Summary')] }),
      };
      await drain(
        queryT(
          options({
            skipInitialUserMessage: true,
            messages: [createUserMessage('Prior task')],
            workdirs: ['/workspace/project'],
            compressionPipeline: compressionPipeline as never,
          }),
        ),
      );
      expect(requestText(0)).toContain('# Turn budget');
      expect(requestText(1)).toContain(
        'You have 0 turns left to complete the task.',
      );
    });

    it('allows malformed-response recovery across an intermediate stage', async () => {
      setBudget([1]);
      mockStreamTurns.push(
        makeMalformedToolUseStreamEvents('malformed'),
        makeTextStreamEvents('Completed'),
      );
      const { terminal } = await drain(
        queryT(
          options({
            toolBridge: budgetToolBridge([TEST_TOOL_SCHEMA]),
          }),
        ),
      );
      expect(terminal).toMatchObject({ reason: 'end_turn', numTurns: 2 });
      expect(requestText(1)).toContain(
        'You have 0 turns left to complete the task.',
      );
    });

    it.each([
      {
        turnsUsed: 0,
        type: 'turn_budget_guidance',
        text: 'The remaining count is not a reason to stop early or to cut exploration the task needs.',
      },
      { turnsUsed: 1, type: 'additional_turns', text: 'an additional 1 turns' },
      {
        turnsUsed: 2,
        type: 'turn_budget_exhausted',
        text: 'You have 0 turns left to complete the task.',
      },
    ])(
      'restores $type once after reactive compaction',
      async ({ turnsUsed, type, text }) => {
        setBudget([1, 2]);
        toolLoop(turnsUsed);
        mockStreamTurns.push(
          [
            new ClientError('Prompt is too long', {
              code: 'context_length_exceeded',
              statusCode: 400,
            }),
          ],
          makeTextStreamEvents('Completed'),
        );
        const compressionPipeline = {
          compress: vi.fn(
            async (_history: readonly Message[], opts: { trigger: string }) => ({
              newHistory:
                opts.trigger === 'reactive'
                  ? [createUserMessage('Summary')]
                  : null,
              info: {
                originalTokenCount: 100,
                newTokenCount: 10,
                compressionStatus: CompressionStatus.COMPRESSED,
              },
            }),
          ),
        };
        // Force compaction rather than the earlier history-truncation fallback.
        const truncation = vi
          .spyOn(ptlRetry, 'truncateHeadForPtlRetry')
          .mockReturnValueOnce(null);
        const { events, terminal } = await (async () => {
          try {
            return await drain(
              queryT(
                options({
                  workdirs: ['/workspace/project'],
                  compressionPipeline: compressionPipeline as never,
                }),
              ),
            );
          } finally {
            truncation.mockRestore();
          }
        })();
        expect(compressionPipeline.compress).toHaveBeenCalledWith(
          expect.any(Array),
          expect.objectContaining({ trigger: 'reactive' }),
        );
        expect(terminal).toMatchObject({
          reason: 'end_turn',
          numTurns: turnsUsed + 1,
        });
        expect(mockInferenceRequests).toHaveLength(turnsUsed + 2);
        expect(requestText(turnsUsed + 1).split(text)).toHaveLength(2);
        expect(
          events.filter(
            (event) =>
              event.type === 'attachment' && event.attachment.type === type,
          ),
        ).toHaveLength(1);
      },
    );
  });

  describe('internal turn hooks', () => {
    function withHooks(modules: readonly TurnHookModule[]): typeof query {
      return (options) =>
        query({
          ...options,
          turnHookFactories: [
            ...(options.turnHookFactories ?? []),
            ...modules.map((module) => () => module),
          ],
        });
    }

    function observer() {
      const starts: string[] = [];
      const steps: TurnStepInput[] = [];
      const completions: TurnCompleteInput[] = [];
      const module: TurnHookModule = {
        id: 'test-observer',
        register(on) {
          on('turn.start', (_$, e, next) => {
            starts.push(e.turnId);
            return next(e);
          });
          on('turn.step', async function* (_$, e, next) {
            steps.push(e);
            return yield* next(e);
          });
          on('turn.complete', (_$, e, next) => {
            completions.push(e);
            return next(e);
          });
        },
      };
      return { module, starts, steps, completions };
    }

    it.each(['consumer-close', 'routing-error'] as const)(
      'does not prepare or settle Cron when %s occurs after turn.start',
      async (ending) => {
        const prepare = vi.spyOn(QueryTurn.prototype, 'runStart');
        const finish = vi.spyOn(QueryTurn.prototype, 'runEnd');
        const router = fixedSelection('test-model');
        const failure = new Error('route failed');
        const resolve = vi.spyOn(router, 'resolve').mockRejectedValue(failure);
        const hook = observer();
        try {
          const stream = queryT(
            {
              prompt: 'hello',
              model: 'test-model',
              promptId: 'early-exit',
              selectModel: router.resolve,
            },
            withHooks([hook.module]),
          );
          expect(await stream.next()).toMatchObject({
            done: false,
            value: { type: 'user' },
          });
          expect(hook.starts).toEqual(['early-exit']);
          if (ending === 'consumer-close')
            await stream.return(undefined as never);
          else await expect(drain(stream)).rejects.toBe(failure);
          expect(prepare).not.toHaveBeenCalled();
          expect(finish).not.toHaveBeenCalled();
          expect(hook.completions).toHaveLength(1);
        } finally {
          prepare.mockRestore();
          finish.mockRestore();
          resolve.mockRestore();
        }
      },
    );

    it('does not start a turn when the submission hook blocks input', async () => {
      const hook = observer();
      const { terminal } = await drain(
        queryT(
          {
            prompt: 'blocked',
            model: 'test-model',
            promptId: 'blocked-turn',

            hookCoordinator: {
              fireBefore: vi.fn().mockResolvedValue({ blocked: true }),
            } as never,
          },
          withHooks([hook.module]),
        ),
      );
      expect(terminal.reason).toBe('error');
      expect(hook.starts).toEqual([]);
      expect(hook.steps).toEqual([]);
      expect(hook.completions).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });


  it.each([
    ['normal', undefined, true],
    ['strict override', false, false],
  ] as const)(
    'builds tool schemas with the %s pre-read behavior',
    async (_label, preReadLineDropped, expected) => {
      setStreamEvents('done');
      mockFetch.mockResolvedValue(mockOkResponse());
      const toolBridge = createMockToolBridge(undefined, [TEST_TOOL_SCHEMA]);

      await drain(
        queryT({
          prompt: 'inspect schemas',
          model: 'test-model',
          promptId: 'pid-schema-context',
          toolBridge,
          ...(preReadLineDropped !== undefined ? { preReadLineDropped } : {}),
        }),
      );

      expect(toolBridge.getToolSchema).toHaveBeenCalledWith('test-model', {
        preReadLineDropped: expected,
      });
    },
  );

  describe('system prompt resolution', () => {
    it('rejects fixed and resolved prompts before any provider request', async () => {
      const fireQueryEndEvent = vi.fn().mockResolvedValue(undefined);
      await expect(
        drain(
          queryT({
            prompt: 'hello',
            model: 'test-model',
            promptId: 'prompt-invalid-combination',
            sessionId: 'session-invalid-combination',
            preallocatedRequestSetId: 'request-invalid-combination',
            systemPrompt: systemPromptFromText('fixed'),
            resolveSystemPrompt: async () => ({
              blocks: [{ type: 'text', text: 'resolved' }],
              source: 'default',
              bundle: 'full',
            }),
            config: {
              getHookSystem: () => ({ fireQueryEndEvent }),
            } as unknown as Config,
            workdirs: [],
          }),
        ),
      ).rejects.toThrow('mutually exclusive');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(fireQueryEndEvent).toHaveBeenCalledExactlyOnceWith(
        'request-invalid-combination',
        undefined,
        'test-model',
        'error',
      );
    });
  });

  describe('business finish reporting', () => {
    const fireQueryEndEvent = vi.fn().mockResolvedValue(undefined);
    const config = {
      getHookSystem: () => ({ fireQueryEndEvent }),
    } as unknown as Config;
    const runBusinessFinishQuery = (
      overrides: Partial<QueryParams> & { toolBridge?: MockToolBridge } = {},
    ) => {
      const { toolBridge, ...queryOverrides } = overrides;
      return drain(
        queryT({
          prompt: 'Business finish test',
          model: 'test-model',
          promptId: 'prompt-business-finish',
          sessionId: 'session-business-finish',
          preallocatedRequestSetId: 'request-business-finish',
          config,
          workdirs: [],
          ...queryOverrides,
          ...(toolBridge ? mockTooling(toolBridge) : {}),
        }),
      );
    };

    it('reports the final root business snapshot after an end turn', async () => {
      setStreamEvents('Hello world');
      mockFetch.mockResolvedValue(mockOkResponse());
      const onBusinessContextReady = vi.fn();

      const hookCoordinator = {
        fireBefore: vi.fn().mockImplementation(async () => {
          expect(getBusinessInfoFromContext()?.id).toBe(
            'request-business-finish',
          );
          expect(getBusinessInfoFromContext()?.model_key).toBe('test-model');
          return null;
        }),
        fireAfter: vi.fn().mockImplementation(async () => {
          expect(getBusinessInfoFromContext()?.id).toBe(
            'request-business-finish',
          );
          expect(getBusinessInfoFromContext()?.model_key).toBe('test-model');
          return null;
        }),
        drainPendingAsyncContext: vi.fn().mockReturnValue(undefined),
      };

      const { terminal } = await runBusinessFinishQuery({
        prompt: 'Say hello',
        promptId: 'prompt-business-finish-1',
        sessionId: 'session-business-finish-1',
        onBusinessContextReady,
        hookCoordinator: hookCoordinator as never,
      });

      expect(terminal).toMatchObject({
        reason: 'end_turn',
        requestSetId: 'request-business-finish',
      });
      expect(hookCoordinator.fireBefore).toHaveBeenCalledExactlyOnceWith(
        'prompt-business-finish-1',
        'Say hello',
        undefined,
        terminal.requestSetId,
      );
      expect(mockReportBusinessFinish).toHaveBeenCalledExactlyOnceWith({
        sessionId: 'session-business-finish-1',
        businessInfo: expect.objectContaining({
          model_key: 'test-model',
          stage: 'complete',
          end_at: expect.any(Number),
        }),
      });
      expect(onBusinessContextReady).toHaveBeenCalledExactlyOnceWith({
        sessionId: 'session-business-finish-1',
        requestSetId: terminal.requestSetId,
        businessId: expect.any(String),
      });
      expect(fireQueryEndEvent).toHaveBeenCalledExactlyOnceWith(
        terminal.requestSetId,
        expect.any(String),
        'test-model',
        'end_turn',
      );
    });

    it('reports once after a multi-turn tool loop completes', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tool-business-finish', READ_FILE_TOOL_NAME, {
          file_path: '/tmp/example.ts',
        }),
        makeTextStreamEvents('Done'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());
      const toolBridge = createMockToolBridge(async (blocks) => ({
        toolResults: blocks.map((block) => ({
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: 'file contents',
          is_error: false,
        })),
        allMessages: [],
      }));

      const { terminal } = await runBusinessFinishQuery({
        promptId: 'prompt-business-finish-tool-loop',
        sessionId: 'session-business-finish-tool-loop',
        toolBridge,
      });

      expect(terminal).toMatchObject({ reason: 'end_turn', numTurns: 2 });
      expect(mockReportBusinessFinish).toHaveBeenCalledOnce();
    });

    it('reports an error stage when the root query reaches max turns', async () => {
      const { terminal } = await runBusinessFinishQuery({
        promptId: 'prompt-business-finish-max-turns',
        sessionId: 'session-business-finish-max-turns',
        maxTurns: 0,
      });

      expect(terminal.reason).toBe('max_turns');
      expect(mockReportBusinessFinish).toHaveBeenCalledExactlyOnceWith({
        sessionId: 'session-business-finish-max-turns',
        businessInfo: expect.objectContaining({ stage: 'error' }),
      });
      expect(fireQueryEndEvent).toHaveBeenCalledExactlyOnceWith(
        'request-business-finish',
        expect.any(String),
        'test-model',
        'max_turns',
      );
    });

    it('reports an error stage when the model request fails', async () => {
      mockFetch.mockRejectedValue(new Error('model unavailable'));

      const { terminal } = await runBusinessFinishQuery({
        promptId: 'prompt-business-finish-error',
        sessionId: 'session-business-finish-error',
      });

      expect(terminal.reason).toBe('error');
      expect(mockReportBusinessFinish).toHaveBeenCalledExactlyOnceWith({
        sessionId: 'session-business-finish-error',
        businessInfo: expect.objectContaining({ stage: 'error' }),
      });
      expect(fireQueryEndEvent).toHaveBeenCalledExactlyOnceWith(
        'request-business-finish',
        expect.any(String),
        'test-model',
        'error',
      );
    });

    it('does not report from subagent queries', async () => {
      setStreamEvents('Subagent done');
      mockFetch.mockResolvedValue(mockOkResponse());
      const onBusinessContextReady = vi.fn();

      const { terminal } = await runBusinessFinishQuery({
        promptId: 'prompt-business-finish-subagent',
        sessionId: 'session-business-finish-subagent',
        isSubagent: true,
        parentRequestSetId: 'parent-request-set',
        parentBusinessInfo: {
          version: '1.2.3',
          id: 'parent-business-id',
          stage: 'processing',
        },
        onBusinessContextReady,
      });

      expect(terminal.reason).toBe('end_turn');
      expect(mockReportBusinessFinish).not.toHaveBeenCalled();
      expect(onBusinessContextReady).not.toHaveBeenCalled();
      expect(fireQueryEndEvent).not.toHaveBeenCalled();
    });

    it.each(['hook_prompt', 'side_question'] as const)(
      'does not notify for internal %s queries',
      async (modelPurpose) => {
        setStreamEvents('Internal query done');
        mockFetch.mockResolvedValue(mockOkResponse());

        const { terminal } = await runBusinessFinishQuery({
          modelPurpose,
          preallocatedRequestSetId: `request-${modelPurpose}`,
        });

        expect(terminal.reason).toBe('end_turn');
        expect(fireQueryEndEvent).not.toHaveBeenCalled();
      },
    );

    it.each(['main', 'fork', 'compact'] as const)(
      'keeps QueryEnd for explicit %s business purpose',
      async (modelPurpose) => {
        setStreamEvents('Done');
        mockFetch.mockResolvedValue(mockOkResponse());
        const { terminal } = await runBusinessFinishQuery({
          modelPurpose,
          ...(modelPurpose === 'compact'
            ? { compactSelection: testModelResolution('test-model') }
            : {}),
          preallocatedRequestSetId: `request-${modelPurpose}`,
        });
        expect(terminal.reason).toBe('end_turn');
        expect(fireQueryEndEvent).toHaveBeenCalledOnce();
      },
    );

    it('notifies once for each consecutive request in the same session', async () => {
      setStreamEvents('First answer');
      mockFetch.mockResolvedValue(mockOkResponse());
      await runBusinessFinishQuery({
        promptId: 'prompt-query-end-first',
        preallocatedRequestSetId: 'request-query-end-first',
      });

      setStreamEvents('Second answer');
      await runBusinessFinishQuery({
        promptId: 'prompt-query-end-second',
        preallocatedRequestSetId: 'request-query-end-second',
      });

      expect(fireQueryEndEvent).toHaveBeenCalledTimes(2);
      expect(fireQueryEndEvent).toHaveBeenNthCalledWith(
        1,
        'request-query-end-first',
        expect.any(String),
        'test-model',
        'end_turn',
      );
      expect(fireQueryEndEvent).toHaveBeenNthCalledWith(
        2,
        'request-query-end-second',
        expect.any(String),
        'test-model',
        'end_turn',
      );
    });

    it('cleans up before QueryEnd on early generator closure', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tu-cleanup', READ_FILE_TOOL_NAME, {
          file_path: '/tmp/cleanup',
        }),
        makeTextStreamEvents('Unused answer'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());
      const order: string[] = [];
      fireQueryEndEvent.mockImplementationOnce(async () => {
        order.push('query-end');
      });
      let cleanupRegistered = false;
      // Query cleanups are registered through the tool context now; the fake
      // bridge stands in for a CodeMode cell that outlives its tool response.
      const toolBridge = createMockToolBridge(
        async (blocks, _signal, toolUseContext) => {
          toolUseContext?.queryLifecycle?.cleanups.add(async () => {
            order.push('cleanup');
          });
          cleanupRegistered = true;
          return {
            toolResults: blocks.map((block) => ({
              type: 'tool_result' as const,
              tool_use_id: block.id,
              content: 'ok',
              is_error: false,
            })),
            allMessages: [],
          };
        },
      );
      const generator = queryT({
        prompt: 'Close early',
        model: 'test-model',
        promptId: 'prompt-query-end-close',
        sessionId: 'session-business-finish',
        preallocatedRequestSetId: 'request-query-end-close',
        config,
        toolBridge,
        workdirs: [],
      });

      let result = await generator.next();
      while (!result.done && !cleanupRegistered) {
        result = await generator.next();
      }
      await generator.return(undefined as never);

      expect(order).toEqual(['cleanup', 'query-end']);
      expect(fireQueryEndEvent).toHaveBeenCalledExactlyOnceWith(
        'request-query-end-close',
        expect.any(String),
        'test-model',
        'abort',
      );
    });

    it('waits for and suppresses non-interactive reporting failures', async () => {
      setStreamEvents('Answer still succeeds');
      mockFetch.mockResolvedValue(mockOkResponse());
      let rejectReport!: (error: Error) => void;
      const pendingReport = new Promise<void>((_resolve, reject) => {
        rejectReport = reject;
      });
      mockReportBusinessFinish.mockReturnValue(pendingReport);
      let terminalSettled = false;

      const terminalPromise = runBusinessFinishQuery({
        promptId: 'prompt-business-finish-report-error',
        sessionId: 'session-business-finish-report-error',
      }).then((result) => {
        terminalSettled = true;
        return result;
      });

      await vi.waitFor(() => {
        expect(mockReportBusinessFinish).toHaveBeenCalledOnce();
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(terminalSettled).toBe(false);

      rejectReport(new Error('finish endpoint unavailable'));
      const { terminal } = await terminalPromise;
      expect(terminal.reason).toBe('end_turn');
    });

    it('does not wait for reporting in interactive mode', async () => {
      setStreamEvents('Interactive answer');
      mockFetch.mockResolvedValue(mockOkResponse());
      let resolveReport!: () => void;
      const pendingReport = new Promise<void>((resolve) => {
        resolveReport = resolve;
      });
      mockReportBusinessFinish.mockReturnValue(pendingReport);
      let terminalSettled = false;

      const terminalPromise = runBusinessFinishQuery({
        promptId: 'prompt-business-finish-interactive',
        sessionId: 'session-business-finish-interactive',
        config: {
          ...testRequestConfig(),
          isInteractive: () => true,
        } as Config,
      }).then((result) => {
        terminalSettled = true;
        return result;
      });

      await vi.waitFor(() => {
        expect(mockReportBusinessFinish).toHaveBeenCalledOnce();
      });
      await vi.waitFor(() => {
        expect(terminalSettled).toBe(true);
      });
      resolveReport();
      const { terminal } = await terminalPromise;
      expect(terminal.reason).toBe('end_turn');
    });

    it('reports and rethrows unexpected errors after lifecycle creation', async () => {
      const compressionError = new Error('compression exploded');
      const compressionPipeline = {
        compress: vi.fn().mockRejectedValue(compressionError),
      };

      await expect(
        runBusinessFinishQuery({
          promptId: 'prompt-business-finish-unexpected-error',
          sessionId: 'session-business-finish-unexpected-error',
          messages: [createUserMessage('Earlier prompt')],
          compressionPipeline: compressionPipeline as never,
        }),
      ).rejects.toBe(compressionError);
      expect(mockReportBusinessFinish).toHaveBeenCalledExactlyOnceWith({
        sessionId: 'session-business-finish-unexpected-error',
        businessInfo: expect.objectContaining({ stage: 'error' }),
      });
    });
  });

  // ========================================================================
  // Single turn (no tools)
  // ========================================================================

  describe('session event bus', () => {
    function sharedRuntime() {
      const runtime = createQueryEventBus();
      const queryIds: string[] = [];
      const create = runtime.store.create.bind(runtime.store);
      vi.spyOn(runtime.store, 'create').mockImplementation((input, initial) => {
        queryIds.push(input.queryId);
        return create(input, initial);
      });
      return { runtime, queryIds };
    }

    it('submits nothing before the first next()', async () => {
      setStreamEvents('unused');
      const { runtime, queryIds } = sharedRuntime();
      const stream = queryT({
        prompt: 'Hello',
        model: 'test-model',
        promptId: 'lazy-submit',
        eventBus: runtime,
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(queryIds).toEqual([]);
      expect(mockInferenceRequests).toHaveLength(0);
      await stream.return(undefined as never);
      expect(queryIds).toEqual([]);
    });

    it('keeps parallel queries on one bus apart and removes their state', async () => {
      setStreamEvents('Shared answer');
      const { runtime, queryIds } = sharedRuntime();
      const run = (prompt: string) =>
        drain(
          queryT({
            prompt,
            model: 'test-model',
            promptId: `parallel-${prompt}`,
            sessionId: 'shared-session',
            eventBus: runtime,
          }),
        );
      const [first, second] = await Promise.all([run('first'), run('second')]);
      for (const [result, prompt] of [
        [first, 'first'],
        [second, 'second'],
      ] as const) {
        expect(result.terminal.reason).toBe('end_turn');
        const users = result.events.filter((event) => event.type === 'user');
        expect(users).toHaveLength(1);
        expect(JSON.stringify(users[0])).toContain(prompt);
        expect(
          result.events.filter((event) => event.type === 'request_start'),
        ).toHaveLength(1);
      }
      expect(queryIds).toHaveLength(2);
      for (const queryId of queryIds) {
        expect(runtime.store.get(queryId)).toBeUndefined();
      }
    });

    it('settles and removes the query when the consumer returns mid-stream', async () => {
      setStreamEvents('partial answer');
      const { runtime, queryIds } = sharedRuntime();
      const stream = queryT({
        prompt: 'Hello',
        model: 'test-model',
        promptId: 'consumer-return',
        eventBus: runtime,
      });
      for (;;) {
        const next = await stream.next();
        if (next.done) throw new Error('stream ended before the first delta');
        if (next.value.type === 'stream_event') break;
      }
      await expect(stream.return(undefined as never)).resolves.toMatchObject({
        done: true,
      });
      expect(await stream.next()).toMatchObject({ done: true });
      expect(runtime.store.get(queryIds[0]!)).toBeUndefined();
    });
  });

  describe('single turn (no tools)', () => {
    it('captures a completed parent for forks with prompt suggestions disabled', async ({
      onTestFinished,
    }) => {
      setStreamEvents('Final answer');
      mockFetch.mockResolvedValue(mockOkResponse());
      const snapshots = vi.fn();
      const gate = vi
        .spyOn(suggestionFeature, 'getPromptSuggestionFeatureConfig')
        .mockReturnValue({
          enabled: false,
          mode: 'shared',
          forkEnabled: false,
        });
      onTestFinished(() => gate.mockRestore());
      const { terminal } = await drain(
        queryT({
          config: {
            getModel: () => 'test-model',
            getModelRequestIdentity: () => 'parent-account',
            getPermissionMode: () => 'default',
          } as unknown as Config,
          prompt: 'Finish the task',
          model: 'test-model',
          promptId: 'completed-turn',
          sessionId: 'parent-session',
          preallocatedRequestSetId: 'parent-set',
          onCacheSafeSnapshot: snapshots,
        }),
      );
      expect(terminal.reason).toBe('end_turn');
      expect(snapshots.mock.calls[0][0].completedTurn).toBeUndefined();
      const last = snapshots.mock.calls.at(-1)?.[0];
      expect(last.completedTurn).toMatchObject({
        sessionId: 'parent-session',
        promptId: 'completed-turn',
        requestSetId: 'parent-set',
        requestIdentity: {
          model: 'test-model',
          identity: 'parent-account',
          permission: 'default',
        },
      });
      expect(last.forkContextMessages.at(-1).role).toBe('assistant');
    });
    it('keeps a successful model request successful when the UI stats listener throws', async () => {
      setStreamEvents('Hello world');
      mockFetch.mockResolvedValue(mockOkResponse());
      const throwingListener = () => {
        throw new Error('UI stats update failed');
      };
      uiTelemetryService.on('update', throwingListener);

      try {
        const { terminal } = await drain(
          queryT({
            prompt: 'Say hello',
            model: 'test-model',
            promptId: 'prompt-stats-listener-success',
            config: {
              ...testRequestConfig(),
            } as Config,
            workdirs: [],
          }),
        );

        expect(terminal.reason).toBe('end_turn');
      } finally {
        uiTelemetryService.off('update', throwingListener);
      }
    });

    it('keeps a successful model request successful when the UI stats recording fails', async () => {
      setStreamEvents('Hello world');
      mockFetch.mockResolvedValue(mockOkResponse());
      const statsSpy = vi
        .spyOn(uiTelemetryService, 'recordModelRequest')
        .mockImplementation(() => {
          throw new Error('UI stats recording failed');
        });

      try {
        const { terminal } = await drain(
          queryT({
            prompt: 'Say hello',
            model: 'test-model',
            promptId: 'prompt-stats-recording-success',
            config: {
              ...testRequestConfig(),
            } as Config,
            workdirs: [],
          }),
        );

        expect(terminal.reason).toBe('end_turn');
      } finally {
        statsSpy.mockRestore();
      }
    });

    it('should yield durable messages and leave shared history untouched', async () => {
      setStreamEvents('Hello world');
      mockFetch.mockResolvedValue(mockOkResponse());
      const mutableMessages: Message[] = [];

      const gen = queryT({
        prompt: 'Say hello',
        model: 'test-model',
        promptId: 'pid-mutable-1',
        sessionId: 'sid-mutable-1',
        messages: mutableMessages,
      });

      const { events, terminal } = await drain(gen);
      const messages = events.filter(isDurableQueryEvent);

      expect(terminal.reason).toBe('end_turn');
      expect(messages).toHaveLength(2);
      expect(messages[0]?.type).toBe('user');
      expect(messages[1]?.type).toBe('assistant');
      expect(mutableMessages).toHaveLength(0);
    });

    // TODO(legacy-transport-removal): 压缩拒绝与重新签名的端到端覆盖迁入 Client 后补回。

    // 'replay' re-runs the request; 'continue' keeps the committed output and
    // issues a continuation request; 'stop' ends the turn.

    it('ends provider request scope even when the legacy runner did not queue', async () => {
      const { onModelRequestScopeEnd } = await import(
        '../model-request/request-scope.js'
      );
      const release = vi.fn(async () => {});
      const off = onModelRequestScopeEnd(release);
      try {
        mockStreamTurns.push(makeTextStreamEvents('Hello'));
        mockFetch.mockResolvedValue(mockOkResponse());
        const { terminal } = await drain(
          queryT({
            prompt: 'Say hello',
            model: 'test-model',
            promptId: 'scope-end',
            sessionId: 'scope-session',
            messages: [],
          }),
        );
        expect(terminal.reason).toBe('end_turn');
        expect(release).toHaveBeenCalledWith(
          'scope-session',
          expect.any(String),
        );
      } finally {
        off();
      }
    });

    it('preserves caller-provided user message metadata', async () => {
      setStreamEvents('Hello world');
      mockFetch.mockResolvedValue(mockOkResponse());

      const gen = queryT({
        prompt: 'Say hello',
        model: 'test-model',
        promptId: 'pid-user-metadata',
        sessionId: 'sid-user-metadata',
        messages: [],
        userMessage: {
          uuid: 'controller-user-1',
          timestamp: '2026-04-21T06:17:17.025Z',
        },
      });

      const { events } = await drain(gen);
      const user = events.find(
        (
          event,
        ): event is QueryEvent & {
          type: 'user';
        } => event.type === 'user',
      );

      expect(user).toMatchObject({
        type: 'user',
        uuid: 'controller-user-1',
        timestamp: '2026-04-21T06:17:17.025Z',
      });
      expect(user).not.toHaveProperty('isDelegatedTask');
    });

    it('marks a delegated seed prompt on the recorded user message', async () => {
      setStreamEvents('Hello world');
      mockFetch.mockResolvedValue(mockOkResponse());

      const gen = queryT({
        prompt: 'Run the tests',
        model: 'test-model',
        promptId: 'pid-delegated',
        sessionId: 'sid-delegated',
        messages: [],
        userMessage: { isDelegatedTask: true },
      });

      const { events } = await drain(gen);
      expect(events.find((event) => event.type === 'user')).toMatchObject({
        type: 'user',
        isDelegatedTask: true,
      });
    });

    it('should not yield the user message when before-hook blocks execution', async () => {
      const mutableMessages: Message[] = [];
      const hookCoordinator = {
        fireBefore: vi.fn().mockResolvedValue({ blocked: true }),
      };

      const gen = queryT({
        prompt: 'blocked prompt',
        model: 'test-model',
        promptId: 'pid-blocked-1',
        sessionId: 'sid-blocked-1',
        messages: mutableMessages,
        hookCoordinator: hookCoordinator as never,
      });

      const { events, terminal } = await drain(gen);
      const messages = events.filter(isDurableQueryEvent);

      expect(hookCoordinator.fireBefore).toHaveBeenCalledWith(
        'pid-blocked-1',
        'blocked prompt',
        undefined,
        undefined,
      );
      expect(messages).toHaveLength(0);
      expect(mutableMessages).toHaveLength(0);
      expect(terminal.reason).toBe('error');
      expect(terminal.error?.message).toContain('blocked by hook');
    });

    it('should mark a before-hook stop with hook_stopped and keep its stopReason', async () => {
      const hookCoordinator = {
        fireBefore: vi
          .fn()
          .mockResolvedValue({ stopped: true, stopReason: 'BLOCKED-BY-HOOK' }),
      };

      const gen = queryT({
        prompt: 'stopped prompt',
        model: 'test-model',
        promptId: 'pid-stopped-1',
        sessionId: 'sid-stopped-1',
        messages: [],
        hookCoordinator: hookCoordinator as never,
      });

      const { terminal } = await drain(gen);

      expect(terminal.reason).toBe('end_turn');
      expect(terminal.terminalDetail).toBe('hook_stopped');
      expect(terminal.hookStopReason).toBe('BLOCKED-BY-HOOK');
      expect(terminal.numTurns).toBe(0);
    });

    it('should include assembled text in the assistant message', async () => {
      setStreamEvents('The answer is 42');
      mockFetch.mockResolvedValue(mockOkResponse());

      const gen = queryT({
        prompt: 'What is the answer?',
        model: 'test-model',
        promptId: 'pid-2',
        messages: [],
      });

      const { events } = await drain(gen);
      const assistant = events.find(isRuntimeAssistantEvent);
      expect(assistant).toBeDefined();
      if (assistant) {
        const textBlocks = assistant.message.content.filter(
          (b) => b.type === 'text',
        );
        expect(textBlocks.length).toBe(1);
        if (textBlocks[0].type === 'text') {
          expect(textBlocks[0].text).toBe('The answer is 42');
        }
      }
    });

    it('should yield assistant_block with single block at content_block_stop', async () => {
      setStreamEvents('Hello');
      mockFetch.mockResolvedValue(mockOkResponse());

      const gen = queryT({
        prompt: 'Hi',
        model: 'test-model',
        promptId: 'pid-block-1',
      });

      const { events } = await drain(gen);
      const blockEvents = events.filter((e) => e.type === 'assistant_block');

      expect(blockEvents.length).toBe(1);
      if (blockEvents[0].type === 'assistant_block') {
        expect(blockEvents[0].index).toBe(0);
        // The block message should contain exactly one content block
        expect(blockEvents[0].message.blocks.length).toBe(1);
        expect(blockEvents[0].message.blocks[0].type).toBe('text');
      }
    });

    it('should include usage in terminal', async () => {
      setStreamEvents('Hi');
      mockFetch.mockResolvedValue(mockOkResponse());

      const gen = queryT({
        prompt: 'Hi',
        model: 'test-model',
        promptId: 'pid-usage',
      });

      const { terminal } = await drain(gen);
      expect(terminal.usage).toBeDefined();
      expect(terminal.usage.input_tokens).toBeGreaterThanOrEqual(0);
      expect(terminal.usage.output_tokens).toBeGreaterThanOrEqual(0);
    });

    it('does not count startup memory twice when the request prefix is already projected', async () => {
      setStreamEvents('Hello world');
      mockFetch.mockResolvedValue(mockOkResponse());
      const compressionPipeline = {
        compress: vi.fn().mockResolvedValue({
          newHistory: null,
          info: {
            originalTokenCount: 10,
            newTokenCount: 10,
            compressionStatus: 'noop',
          },
        }),
      };
      const config = {
        getEffectiveContextWindow: vi.fn(() => 200_000),
        getWorkspaceContext: () => ({ getDirectories: () => [] }),
      } as unknown as Config;

      const { terminal } = await drain(
        queryT({
          prompt: 'Current prompt',
          model: 'test-model',
          promptId: 'pid-preprojected-startup-memory',
          sessionId: 'session-preprojected-startup-memory',
          messages: [createUserMessage('Earlier runtime prompt')],
          preProjectedMessages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Projected startup and history' },
              ],
            },
          ],
          startupMemoryContext: { autoMemory: 'Startup memory' },
          compressionPipeline: compressionPipeline as never,
          config,
          workdirs: [],
        }),
      );

      expect(terminal.reason).toBe('end_turn');
      expect(compressionPipeline.compress).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ requestPrefixMessages: [] }),
      );
    });
  });

  describe('state-machine continuations', () => {
    it.each([
      {
        name: 'caps consecutive failures',
        response: 'none',
        reason: 'error',
        requests: 4,
        afterCalls: 0,
      },
      {
        name: 'restores all three retries after a complete text response',
        response: 'complete',
        reason: 'end_turn',
        requests: 8,
        afterCalls: 2,
      },
      {
        name: 'restores all three retries after a complete tool response',
        response: 'tool_complete',
        reason: 'end_turn',
        requests: 8,
        afterCalls: 1,
      },
      {
        name: 'still caps failures after the budget has been restored',
        response: 'complete_then_exhausted',
        reason: 'error',
        requests: 8,
        afterCalls: 1,
      },
      {
        name: 'keeps the used budget after an interrupted response',
        response: 'interrupted',
        reason: 'error',
        requests: 5,
        afterCalls: 0,
      },
    ])(
      'PTL retry budget: $name',
      async ({ response, reason, requests, afterCalls }) => {
        const successBetweenFailures =
          response === 'complete' ||
          response === 'tool_complete' ||
          response === 'complete_then_exhausted';
        const ptlFailure = () => [
          Object.assign(new Error('Prompt is too long'), { status: 413 }),
        ];
        mockStreamTurns.push(ptlFailure(), ptlFailure(), ptlFailure());
        if (successBetweenFailures) {
          mockStreamTurns.push(
            response === 'tool_complete'
              ? makeToolUseStreamEvents('ptl-read', READ_FILE_TOOL_NAME, {
                  file_path: '/fixture.txt',
                })
              : makeTextStreamEvents('Completed response'),
            ptlFailure(),
            ptlFailure(),
            ptlFailure(),
            response === 'complete_then_exhausted'
              ? ptlFailure()
              : makeTextStreamEvents('Final response'),
          );
        } else if (response === 'interrupted') {
          mockStreamTurns.push(
            [
              ...makeTextStreamEvents('Partial response').slice(0, 3),
              new ModelInferenceError('Connection closed', {
                kind: 'network',
                phase: 'after_output',
                code: 'UND_ERR_SOCKET',
              }),
            ],
            ptlFailure(),
          );
        } else {
          mockStreamTurns.push(ptlFailure());
        }
        const fireAfter = vi.fn().mockResolvedValue(null);
        if (response === 'complete' || response === 'complete_then_exhausted') {
          fireAfter.mockResolvedValueOnce({
            blocked: true,
            inject: 'Continue',
            retryAsStopHook: true,
          });
        }
        const hookCoordinator = {
          fireBefore: vi.fn().mockResolvedValue(null),
          fireAfter,
          drainPendingAsyncContext: vi.fn().mockReturnValue(undefined),
          fireStopFailure: vi.fn().mockResolvedValue(undefined),
        };
        // Keep enough API rounds to allow truncation after all retry attempts.
        const messages = Array.from({ length: 30 }, (_, index) => [
          createUserMessage(`Earlier prompt ${index}`),
          createAssistantMessage({
            messageId: `earlier-response-${index}`,
            blocks: [{ type: 'text', text: `Earlier answer ${index}` }],
            model: 'test-model',
            stopReason: 'end_turn',
          }),
        ]).flat();

        const { terminal } = await drain(
          queryT({
            prompt: 'Continue the task',
            model: 'test-model',
            promptId: 'pid-ptl-success-reset',
            messages,
            hookCoordinator: hookCoordinator as never,
            ...(response === 'tool_complete'
              ? {
                  toolBridge: createMockToolBridge(
                    async (blocks) => ({
                      toolResults: blocks.map((block) => ({
                        type: 'tool_result' as const,
                        tool_use_id: block.id,
                        content: 'Fixture contents',
                        is_error: false,
                      })),
                      allMessages: [],
                    }),
                    [TEST_TOOL_SCHEMA],
                  ),
                }
              : {}),
          }),
        );

        expect(terminal.reason).toBe(reason);
        expect(mockInferenceRequests).toHaveLength(requests);
        expect(hookCoordinator.fireAfter).toHaveBeenCalledTimes(afterCalls);
      },
    );

    it('retries after a blocking stop hook and marks the second after-hook call as active', async () => {
      mockStreamTurns.push(
        makeTextStreamEvents('First response'),
        makeTextStreamEvents('Second response'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());
      const fireQueryEndEvent = vi.fn().mockResolvedValue(undefined);
      const hookCoordinator = {
        fireBefore: vi.fn().mockResolvedValue(null),
        fireAfter: vi
          .fn()
          .mockResolvedValueOnce({
            blocked: true,
            inject: 'Please explain',
            retryAsStopHook: true,
          })
          .mockImplementationOnce(async () => {
            expect(fireQueryEndEvent).not.toHaveBeenCalled();
            return null;
          }),
        drainPendingAsyncContext: vi.fn().mockReturnValue(undefined),
      };

      const gen = queryT({
        prompt: 'Original prompt',
        model: 'test-model',
        promptId: 'pid-stop-hook',
        preallocatedRequestSetId: 'request-stop-hook',
        hookCoordinator: hookCoordinator as never,
        config: {
          getHookSystem: () => ({ fireQueryEndEvent }),
          getTargetDir: () => process.cwd(),
          getWorkingDir: () => process.cwd(),
          getWorkspaceContext: () => ({ getDirectories: () => [] }),
          getPermissionMode: () => 'default',
          getModel: () => 'test-model',
        } as unknown as Config,
      });

      const { events, terminal } = await drain(gen);
      const userEvents = events.filter(
        (
          event,
        ): event is QueryEvent & {
          type: 'user';
        } => event.type === 'user',
      );
      const requestStarts = events.filter(
        (event) => event.type === 'request_start',
      );

      expect(terminal.reason).toBe('end_turn');
      expect(requestStarts).toHaveLength(2);
      expect(userEvents.map((event) => event.message.content)).toEqual([
        'Original prompt',
        'Please explain',
      ]);
      expect(hookCoordinator.fireAfter).toHaveBeenNthCalledWith(
        1,
        'pid-stop-hook',
        'Original prompt',
        'First response',
        expect.objectContaining({ stopHookActive: false }),
      );
      expect(hookCoordinator.fireAfter).toHaveBeenNthCalledWith(
        2,
        'pid-stop-hook',
        'Original prompt',
        'Second response',
        expect.objectContaining({ stopHookActive: true }),
      );
      expect(fireQueryEndEvent).toHaveBeenCalledExactlyOnceWith(
        'request-stop-hook',
        expect.any(String),
        'test-model',
        'end_turn',
      );
    });

    it('appends a continuation user message when output token recovery is needed', async () => {
      mockStreamTurns.push(
        makeMaxTokensStreamEvents('Partial response'),
        makeTextStreamEvents('Completed response'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const gen = queryT({
        prompt: 'Original prompt',
        model: 'test-model',
        promptId: 'pid-max-tokens-recovery',
        querySelection: {
          key: 'test-model',
          config: { context: { maxOutputTokens: 256 } },
        },
        selectModel: fixedSelection(
          testModelResolution({
            ...testProviderModel('test-model'),
            limits: { maxContextTokens: 128_000, maxOutputTokens: 256 },
          }),
        ).resolve,
      });

      const { events, terminal } = await drain(gen);
      const userEvents = events.filter(
        (
          event,
        ): event is QueryEvent & {
          type: 'user';
        } => event.type === 'user',
      );
      const assistantEvents = events.filter(isRuntimeAssistantEvent);

      expect(terminal.reason).toBe('end_turn');
      expect(
        events.filter((event) => event.type === 'request_start'),
      ).toHaveLength(2);
      expect(userEvents.map((event) => event.message.content)).toEqual([
        'Original prompt',
        `Output token limit hit. Resume directly — no apology or recap.
Continue from the last verifiable point in the visible conversation and tool results.
Break the remaining work into smaller pieces.`,
      ]);
      expect(assistantEvents).toHaveLength(2);
      expect(assistantEvents[0]?.message.content[0]).toMatchObject({
        type: 'text',
        text: 'Partial response',
      });
      expect(assistantEvents[1]?.message.content[0]).toMatchObject({
        type: 'text',
        text: 'Completed response',
      });
    });

    it.each(['text', 'thinking'] as const)(
      'max output tokens recovery exhaustion fails and preserves %s output',
      async (contentType) => {
        mockStreamTurns.push(
          makeMaxTokensStreamEvents('Partial response 1', contentType),
          makeMaxTokensStreamEvents('Partial response 2', contentType),
          makeMaxTokensStreamEvents('Partial response 3', contentType),
        );
        mockFetch.mockResolvedValue(mockOkResponse());

        const gen = queryT({
          prompt: 'Original prompt',
          model: 'test-model',
          promptId: 'pid-max-tokens-limit',
          querySelection: {
            key: 'test-model',
            config: { context: { maxOutputTokens: 256 } },
          },
        });

        const { events, terminal } = await drain(gen);
        const userEvents = events.filter(
          (
            event,
          ): event is QueryEvent & {
            type: 'user';
          } => event.type === 'user',
        );
        const assistantEvents = events.filter(isRuntimeAssistantEvent);
        const partialResponses = assistantEvents.filter(
          (event) => !event.isApiErrorMessage,
        );
        const errorEvents = assistantEvents.filter(
          (event) => event.isApiErrorMessage,
        );

        expect(terminal).toMatchObject({
          reason: 'error',
          modelStopReason: 'max_tokens',
          error: {
            name: 'MaxOutputTokensError',
            code: 'max_output_tokens',
            error_code: 'max_output_tokens',
            retryable: false,
          },
          usage: { input_tokens: 30, output_tokens: 15 },
        });
        expect(
          events.filter((event) => event.type === 'request_start'),
        ).toHaveLength(3);
        expect(userEvents.map((event) => event.message.content)).toEqual([
          'Original prompt',
          `Output token limit hit. Resume directly — no apology or recap.
Continue from the last verifiable point in the visible conversation and tool results.
Break the remaining work into smaller pieces.`,
          `Output token limit hit. Resume directly — no apology or recap.
Continue from the last verifiable point in the visible conversation and tool results.
Break the remaining work into smaller pieces.`,
        ]);
        expect(
          partialResponses.map((event) => event.message.content[0]),
        ).toEqual([
          expect.objectContaining({
            type: contentType,
            [contentType]: 'Partial response 1',
          }),
          expect.objectContaining({
            type: contentType,
            [contentType]: 'Partial response 2',
          }),
          expect.objectContaining({
            type: contentType,
            [contentType]: 'Partial response 3',
          }),
        ]);
        expect(errorEvents).toEqual([
          expect.objectContaining({
            error: 'max_output_tokens',
            displayErrorCode: 'max_output_tokens',
          }),
        ]);
      },
    );

    it('max output tokens recovery succeeds on the last allowed continuation', async () => {
      mockStreamTurns.push(
        makeMaxTokensStreamEvents('Partial response 1'),
        makeMaxTokensStreamEvents('Partial response 2'),
        makeTextStreamEvents('Completed response'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());
      const { events, terminal } = await drain(
        queryT({
          prompt: 'Original prompt',
          model: 'test-model',
          promptId: 'pid-max-tokens-last-success',
          querySelection: {
            key: 'test-model',
            config: { context: { maxOutputTokens: 256 } },
          },
        }),
      );
      expect(terminal.reason).toBe('end_turn');
      expect(
        events
          .filter(isRuntimeAssistantEvent)
          .some((event) => event.isApiErrorMessage),
      ).toBe(false);
      expect(
        events.filter(isRuntimeAssistantEvent).at(-1)?.message.content[0],
      ).toMatchObject({ type: 'text', text: 'Completed response' });
    });

    it('max output tokens exhaustion cannot override user cancellation', async () => {
      const controller = new AbortController();
      let snapshots = 0;
      mockStreamTurns.push(
        makeMaxTokensStreamEvents('Partial response 1'),
        makeMaxTokensStreamEvents('Partial response 2'),
        makeMaxTokensStreamEvents('Partial response 3'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());
      const { events, terminal } = await drain(
        queryT({
          prompt: 'Original prompt',
          model: 'test-model',
          promptId: 'pid-max-tokens-cancel',
          querySelection: {
            key: 'test-model',
            config: { context: { maxOutputTokens: 256 } },
          },
          signal: controller.signal,
          onCacheSafeSnapshot: () => {
            if (++snapshots === 3) controller.abort();
          },
        }),
      );
      expect(terminal.reason).toBe('abort');
      expect(
        events
          .filter(isRuntimeAssistantEvent)
          .some((event) => event.isApiErrorMessage),
      ).toBe(false);
    });
  });

  // ========================================================================
  // Error handling
  // ========================================================================

  describe('error handling', () => {
    it('persists raw empty-completion facts for host rendering after resume', async () => {
      const empty = new EmptyAssistantCompletionError({
        reason: 'reasoning_only',
        finishReason: 'end_turn',
        contentBlockCount: 1,
        reasoningBlockCount: 1,
        textCharacterCount: 0,
        model: 'test-model',
        transport: 'test',
      });
      const failure = new ModelInferenceError(empty.message, {
        code: empty.code,
        kind: 'unknown',
        phase: 'before_output',
        cause: empty,
      });
      mockStreamTurns.push([failure]);
      const { events, terminal } = await drain(
        queryT({
          prompt: 'Hi',
          model: 'test-model',
          promptId: 'empty-provider-failure',
        }),
      );
      expect(terminal.error).toBe(failure);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'assistant',
          isApiErrorMessage: true,
          displayErrorCode: empty.code,
          modelError: expect.objectContaining({
            emptyCompletionReason: 'reasoning_only',
          }),
        }),
      );
    });

    it('preserves the Provider failure and delivered text after partial output', async () => {
      const failure = new ModelInferenceError('Provider diagnostic', {
        code: '140',
        kind: 'invalid_request',
        status: 403,
        phase: 'after_output',
      });
      mockStreamTurns.push([
        ...makeTextStreamEvents('Partial response').slice(0, 4),
        failure,
      ]);
      const { events, terminal } = await drain(
        queryT({
          prompt: 'Hi',
          model: 'test-model',
          promptId: 'raw-provider-partial',
        }),
      );
      expect(terminal.error).toBe(failure);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'assistant',
          isApiErrorMessage: true,
          displayErrorCode: '140',
          modelError: expect.objectContaining({
            kind: failure.kind,
          }),
        }),
      );
      expect(JSON.stringify(events)).toContain('Partial response');
    });

    it.each(['112', '140', 'EXTERNAL_TOKEN_RATE_LIMITED', undefined])(
      'passes Provider failure %s through the terminal without display wrapping',
      async (code) => {
        const failure = new ModelInferenceError('Provider diagnostic', {
          code,
          kind: 'invalid_request',
          status: 403,
          phase: 'before_output',
        });
        mockStreamTurns.push([failure]);
        const { events, terminal } = await drain(
          queryT({
            prompt: 'Hi',
            model: 'test-model',
            promptId: 'raw-provider-failure',
          }),
        );
        expect(terminal.error).toBe(failure);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'assistant',
            isApiErrorMessage: true,
            displayErrorCode: code,
            modelError: expect.objectContaining({ kind: failure.kind }),
            message: expect.objectContaining({
              content: [{ type: 'text', text: failure.message }],
            }),
          }),
        );
      },
    );

    it('preserves the Provider failure after a failing StopFailure hook', async () => {
      const failure = new ModelInferenceError('Provider diagnostic', {
        code: '140',
        kind: 'invalid_request',
        status: 403,
        phase: 'before_output',
      });
      mockStreamTurns.push([failure]);
      const hookCoordinator = {
        fireBefore: vi.fn().mockResolvedValue(null),
        fireAfter: vi.fn().mockResolvedValue(null),
        drainPendingAsyncContext: vi.fn().mockReturnValue(undefined),
        fireStopFailure: vi.fn().mockRejectedValue(new Error('Hook failed')),
      };
      const { terminal } = await drain(
        queryT({
          prompt: 'Hi',
          model: 'test-model',
          promptId: 'raw-provider-hook',
          hookCoordinator: hookCoordinator as never,
        }),
      );
      expect(hookCoordinator.fireStopFailure).toHaveBeenCalledOnce();
      expect(terminal.error).toBe(failure);
    });

    it('preserves a raw socket failure and recovery facts for host rendering', async () => {
      // Retrying fetch-level failures is opted out, so the close is terminal
      // and Core must retain its diagnostics for the host to render.
      testRuntimeConfig = createRequestConfig({
        getRetryFetchErrors: () => false,
      });
      const socketError = Object.assign(new Error('other side closed'), {
        name: 'SocketError',
        code: 'UND_ERR_SOCKET',
      });
      mockStreamTurns.push([socketError]);
      mockFetch.mockResolvedValue(mockOkResponse());

      const { events, terminal } = await drain(
        queryT({
          prompt: 'Hi',
          model: 'test-model',
          promptId: 'pid-socket-interrupted',
          sessionId: 'sid-socket-interrupted',
        }),
      );
      const syntheticError = events.find(
        (event) => event.type === 'assistant' && event.isApiErrorMessage,
      );

      expect(
        events.some(
          (event) => event.type === 'system' && event.subtype === 'api_retry',
        ),
      ).toBe(false);
      expect(terminal).toMatchObject({
        reason: 'error',
        error: {
          message: 'other side closed',
          cause: socketError,
        },
      });
      expect(terminal.error).toBeInstanceOf(ModelInferenceError);
      expect(syntheticError).toMatchObject({
        isApiErrorMessage: true,
        errorFallbackMessage: 'other side closed',
        errorDetails: expect.stringContaining('other side closed'),
        modelError: {
          kind: 'unknown',
          causeCodes: expect.arrayContaining(['UND_ERR_SOCKET']),
        },
        message: {
          content: [
            {
              type: 'text',
              text: 'other side closed',
            },
          ],
        },
      });
    });

    it('keeps a confirmed tool result when it settles before streamed refusal finalization', async () => {
      mockStreamTurns.push([
        DRAIN_RESPONSE_BODY,
        ...makeRefusalStreamEvents('Partial response', {
          includeToolUse: true,
        }),
      ]);
      mockFetch.mockResolvedValue(sseResponse(VISIBLE_CONTENT_SSE_CHUNK));
      const execute = vi.fn(async (block: ModelToolUseBlock) => {
        const resultBlock = {
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: 'confirmed result',
          is_error: false,
        };
        return {
          block: resultBlock,
          supplementaryMessages: [],
          historyMessage: createToolResultMessage([resultBlock], block.id),
          control: { settlement: 'completed' as const },
        };
      });
      const toolBridge: MockToolBridge = {
        ...createMockToolBridge(),
        execute,
      };

      const { events } = await drain(
        queryT({
          prompt: 'Hi',
          model: 'test-model',
          promptId: 'pid-confirmed-stream-refusal',
          toolBridge,
        }),
      );
      const toolResult = events.find(isRuntimeToolResultEvent);

      expect(execute).toHaveBeenCalledTimes(1);
      expect(getToolResultBlocks(toolResult!)).toEqual([
        expect.objectContaining({
          tool_use_id: 'tool_refused',
          content: 'confirmed result',
        }),
      ]);
      expect(getToolResultBlocks(toolResult!)[0].is_error).not.toBe(true);
      expect(toolResult?.toolUseResult).toBeUndefined();
    });

    it('treats an empty streamed refusal as refusal instead of empty response', async () => {
      mockStreamTurns.push(
        makeRefusalStreamEvents('', { includeContent: false }),
      );
      const toolBridge = createMockToolBridge();
      const hookCoordinator = {
        fireBefore: vi.fn().mockResolvedValue(null),
        fireAfter: vi.fn().mockResolvedValue(null),
        drainPendingAsyncContext: vi.fn().mockReturnValue(undefined),
        fireStopFailure: vi.fn().mockResolvedValue(undefined),
      };

      const { events, terminal } = await drain(
        queryT({
          prompt: 'Hi',
          model: 'test-model',
          promptId: 'pid-empty-stream-refusal',
          toolBridge,
          hookCoordinator: hookCoordinator as never,
        }),
      );
      const assistantMessages = events.filter(isRuntimeAssistantEvent);

      expect(mockInferenceRequests).toHaveLength(1);
      expect(toolBridge.execute).not.toHaveBeenCalled();
      expect(hookCoordinator.fireAfter).not.toHaveBeenCalled();
      expect(hookCoordinator.fireStopFailure).toHaveBeenCalledTimes(1);
      expect(terminal).toMatchObject({
        reason: 'error',
        modelStopReason: 'refusal',
        error: {
          name: 'ModelRefusalError',
          code: 'MODEL_REFUSAL',
          retryable: false,
        },
      });
      expect(terminal.error?.message).not.toContain('Empty response');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0]).toMatchObject({
        isApiErrorMessage: true,
        isContentFilteredMessage: true,
        displayErrorCode: 406,
      });
    });

    it('should return error terminal when tool_use without toolBridge', async () => {
      mockStreamEvents.length = 0;
      mockStreamEvents.push(
        ...makeToolUseStreamEvents('tu_no_bridge', READ_FILE_TOOL_NAME, {}),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const gen = queryT({
        prompt: 'Read a file',
        model: 'test-model',
        promptId: 'pid-no-bridge',
        // No toolBridge
      });

      const { terminal } = await drain(gen);
      expect(terminal.reason).toBe('error');
      expect(terminal.error?.message).toContain('tool_use');
    });
  });

  // ========================================================================
  // Multi-turn tool loop
  // ========================================================================

  describe('tool loop (with ToolBridge)', () => {
    it.each([
      { abort: false, calls: 1 },
      { abort: false, calls: 2 },
      { abort: true, calls: 1 },
    ])(
      'links streamed tool results to persisted assistant nodes (abort=$abort, calls=$calls)',
      async ({ abort, calls }) => {
        mockStreamTurns.push(
          makeParallelToolUseStreamEvents(
            Array.from({ length: calls }, (_, index) => ({
              id: `linked-call-${index}`,
              name: READ_FILE_TOOL_NAME,
              input: {},
            })),
          ),
          makeTextStreamEvents('done'),
        );
        mockFetch.mockResolvedValue(mockOkResponse());
        const controller = new AbortController();
        const toolBridge = createMockToolBridge();
        const createdAssistants = vi.spyOn(
          transcriptConversions,
          'createAssistantMessage',
        );
        const streamedNodes = new Map<
          string,
          ReturnType<typeof createAssistantMessage>
        >();
        toolBridge.execute = vi.fn(async (block, ctx) => {
          const node = createdAssistants.mock.results.findLast(
            (result) =>
              result.type === 'return' &&
              result.value.uuid === ctx.assistantMessageUuid,
          )?.value;
          expect(node).toBeDefined();
          streamedNodes.set(block.id, node);
          if (abort) controller.abort();
          const result = {
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: 'read',
            is_error: false,
          };
          return {
            block: result,
            supplementaryMessages: [],
            historyMessage: protocol.createToolResultMessage(
              [result],
              ctx.assistantMessageUuid!,
            ),
            control: { settlement: 'completed' as const },
          };
        });
        const { events } = await drain(
          queryT({
            prompt: 'read',
            model: 'test-model',
            promptId: 'linked-prompt',
            toolBridge,
            signal: controller.signal,
          }),
        );
        const assistants = events.filter(isRuntimeAssistantEvent);
        const results = events.filter(
          (event) => event.type === 'user' && event.sourceToolAssistantUUID,
        );
        expect(results).toHaveLength(calls);
        if (!abort) {
          const toolNodes = assistants.filter((assistant) =>
            assistant.message.content.some(
              (block) => block.type === 'tool_use',
            ),
          );
          expect(toolNodes.at(-1)?.message.stop_reason).toBe('tool_use');
          expect(toolNodes.at(-1)?.message.usage?.output_tokens).toBe(5);
          for (const node of toolNodes.slice(0, -1)) {
            expect(node.message.stop_reason).toBeNull();
            expect(node.message.usage).toBeUndefined();
          }
        }
        for (const result of results) {
          if (result.type !== 'user') throw new Error('Expected tool result');
          const toolResult = getToolResultBlocks(result)[0];
          const parent = assistants.find(
            (assistant) => assistant.uuid === result.sourceToolAssistantUUID,
          );
          expect(parent).toBe(streamedNodes.get(toolResult.tool_use_id));
          expect(parent?.message.content).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'tool_use',
                id: toolResult.tool_use_id,
              }),
            ]),
          );
        }
      },
    );

    it.each([false, true])(
      'retires CodeMode cells when the query ends (abort=%s)',
      async (abort) => {
        mockStreamTurns.push(
          makeToolUseStreamEvents('cell', READ_FILE_TOOL_NAME, {
            file_path: '/tmp/input',
          }),
          makeTextStreamEvents('done'),
        );
        mockFetch.mockResolvedValue(mockOkResponse());
        const root = new AbortController();
        const cleanup = vi.fn(async () => {
          await Promise.resolve();
        });
        const toolBridge = createMockToolBridge(undefined, [TEST_TOOL_SCHEMA]);
        toolBridge.execute = vi.fn(async (block: ModelToolUseBlock, ctx) => {
          expect(ctx.toolUseContext.queryLifecycle?.signal).toBeDefined();
          ctx.toolUseContext.queryLifecycle!.cleanups.add(cleanup);
          if (abort) root.abort();
          return {
            block: {
              type: 'tool_result' as const,
              tool_use_id: block.id,
              content: 'running',
              is_error: false,
            },
            supplementaryMessages: [],
            historyMessage: {} as never,
            control: { settlement: 'completed' as const },
          };
        });
        await drain(
          queryT({
            prompt: 'run a cell',
            model: 'test-model',
            promptId: 'cell-prompt',
            sessionId: 'cell-session',
            toolBridge,
            signal: root.signal,
          }),
        );
        expect(cleanup).toHaveBeenCalledTimes(1);
      },
    );

    it('SDK 工具往返在同一 Turn 复用一次选模结果', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('policy-tool', READ_FILE_TOOL_NAME, {
          file_path: '/tmp/input',
        }),
        makeTextStreamEvents('done'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());
      const getModelPolicy = vi.fn().mockResolvedValue({
        model: 'turn-model',
        parameters: { reasoningEffort: 'high', contextWindow: 272000 },
      });
      const toolBridge = createMockToolBridge(async () => ({
        toolResults: [
          {
            type: 'tool_result',
            tool_use_id: 'policy-tool',
            content: 'receipt',
            is_error: false,
          },
        ],
        allMessages: [],
      }));

      const { terminal } = await drain(
        queryT({
          prompt: 'Read the input and summarize it',
          model: 'test-model',
          promptId: 'policy-prompt',
          sessionId: 'policy-session',
          toolBridge,
          resolveSystemPrompt: async (model, selectedModel) => {
            expect(selectedModel?.key).toBe(model);
            return {
              text: `prompt:${model}`,
              blocks: [{ type: 'text', text: `prompt:${model}` }],
              source: 'default',
              bundle: 'full',
            };
          },
          selectModel: policySelection({
            baseRouter: fixedSelection('test-model'),
            getModelPolicy,
          }).resolve,
        }),
      );

      expect(terminal.reason).toBe('end_turn');
      expect(
        mockInferenceRequests.map(
          (request) => (request as ModelStreamRequest).resolution.model.key,
        ),
      ).toEqual(['turn-model', 'turn-model']);
      expect(JSON.stringify(mockInferenceRequests[1])).toContain('receipt');
      expect(getModelPolicy).toHaveBeenCalledTimes(1);
      expect(getModelPolicy.mock.calls[0][2]).toBe(0);
    });

    it('stamps permissionMode onto runtime user messages', async () => {
      mockStreamTurns.push(makeTextStreamEvents('done'));
      mockFetch.mockResolvedValue(mockOkResponse());
      const mutableMessages: Message[] = [];

      const gen = queryT({
        prompt: 'List files',
        model: 'test-model',
        promptId: 'pid-permission-mode',
        messages: mutableMessages,
        permissionMode: 'default',
      });

      await drain(gen);

      expect(mutableMessages).toHaveLength(0);
    });

    it('ends after recording tool results when a tool requests end of turn', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tool-terminal', 'terminal_tool', {}),
      );
      mockFetch.mockResolvedValue(mockOkResponse());
      const toolBridge = createMockToolBridge(async () => ({
        toolResults: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-terminal',
            content: 'structured output recorded',
            is_error: false,
          },
        ],
        allMessages: [
          {
            message: {
              type: 'tool_result',
              toolCallId: 'tool-terminal',
              content: 'structured output recorded',
              isError: false,
            },
          },
          {
            message: {
              type: 'stop',
              reason: 'Tool terminal_tool requested end of turn',
            },
          },
        ],
      }));

      const gen = queryT({
        prompt: 'Return structured output',
        model: 'test-model',
        promptId: 'pid-tool-terminal',
        toolBridge,
      });

      const { events, terminal } = await drain(gen);

      expect(terminal.reason).toBe('end_turn');
      expect(terminal.numTurns).toBe(1);
      expect(streamCallIndex).toBe(1);
      expect(toolBridge.execute).toHaveBeenCalledTimes(1);
      expect(events.find(isRuntimeToolResultEvent)).toBeDefined();
    });

    it('should emit user, assistant, and tool_result messages directly', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tool-1', 'bash', { cmd: 'ls' }),
        makeTextStreamEvents('done'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());
      const toolBridge = createMockToolBridge(async () => ({
        toolResults: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'file1',
            is_error: false,
          },
        ],
        allMessages: [],
      }));
      const mutableMessages: Message[] = [];

      const gen = queryT({
        prompt: 'List files',
        model: 'test-model',
        promptId: 'pid-runtime-tool',
        messages: mutableMessages,
        toolBridge,
      });

      const { events } = await drain(gen);
      const runtimeTypes = events
        .filter(isDurableQueryEvent)
        .map((event) => event.type);

      expect(runtimeTypes).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(mutableMessages).toHaveLength(0);
      const toolResultMessage = events.find(isRuntimeToolResultEvent);
      expect(toolResultMessage).toMatchObject({
        type: 'user',
        sourceToolAssistantUUID: expect.any(String),
      });
    });

    it('should complete a two-turn tool loop: tool_use → tool_result → text', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tu_1', READ_FILE_TOOL_NAME, {
          file_path: '/test.ts',
        }),
        makeTextStreamEvents('Here is the file content'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const toolBridge = createMockToolBridge(async (blocks) => ({
        toolResults: blocks.map((b) => ({
          type: 'tool_result' as const,
          tool_use_id: b.id,
          content: 'file contents here',
          is_error: false,
        })),
        allMessages: [],
      }));

      const gen = queryT({
        prompt: 'Read /test.ts',
        model: 'test-model',
        promptId: 'pid-tl-1',
        toolBridge,
        messages: [],
      });

      const { events, terminal } = await drain(gen);
      const types = events.map((e) => e.type);

      // Turn 1: request_start → stream_events → assistant_block → assistant → tool_result
      // Turn 2: request_start → stream_events → assistant_block → assistant
      expect(types.filter((t) => t === 'request_start').length).toBe(2);
      expect(events.filter(isRuntimeAssistantEvent).length).toBe(2);
      expect(events.filter(isRuntimeToolResultEvent).length).toBe(1);

      // Verify tool_result content
      const toolResult = events.find(isRuntimeToolResultEvent);
      if (toolResult) {
        const resultBlocks = getToolResultBlocks(toolResult);
        expect(resultBlocks.length).toBe(1);
        const resultBlock = resultBlocks[0];
        expect(resultBlock?.tool_use_id).toBe('tu_1');
        expect(resultBlock?.content).toBe('file contents here');
        expect(resultBlock?.is_error).toBeUndefined();
      }

      // Terminal
      expect(terminal.reason).toBe('end_turn');
      expect(terminal.numTurns).toBe(2);
    });

    it('yields child-scope subagent events before the parent tool_result', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tu_agent', 'Agent', {
          description: 'Explore current directory',
          prompt: 'Look around',
        }),
        makeTextStreamEvents('Subagent finished'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const toolBridge = createMockToolBridge(async (blocks) => {
        queueMicrotask(() => {
          const childUser = createUserMessage('Look around');
          childUser.parent_tool_use_id = 'tu_agent';
          childUser.sessionId = 'sid-subagent';
          enqueueSubagentSdkEvent('sid-subagent', childUser);
        });

        await Promise.resolve();

        return {
          toolResults: blocks.map((block) => ({
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: 'child result',
            is_error: false,
          })),
          allMessages: [],
        };
      });

      const gen = queryT({
        prompt: 'Use a subagent',
        model: 'test-model',
        promptId: 'pid-agent-side-events',
        sessionId: 'sid-subagent',
        toolBridge,
        messages: [],
      });

      const { events } = await drain(gen);
      const childUserIndex = events.findIndex(
        (event) =>
          event.type === 'user' &&
          event.parent_tool_use_id === 'tu_agent' &&
          event.message.content === 'Look around',
      );
      const toolResultIndex = events.findIndex(isRuntimeToolResultEvent);

      expect(childUserIndex).toBeGreaterThanOrEqual(0);
      expect(toolResultIndex).toBeGreaterThan(childUserIndex);
    });

    it('does not lose task_started when the background launch result is already ready', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tu_agent_ready', 'Agent', {
          description: 'Start background agent',
          prompt: 'Work in background',
        }),
        makeTextStreamEvents('Agent launched'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const toolBridge = createMockToolBridge(async (blocks) => {
        enqueueSubagentSdkEvent(
          'sid-agent-ready',
          createTaskStartedEvent({
            sessionId: 'sid-agent-ready',
            taskId: 'agent-ready',
            toolUseId: 'tu_agent_ready',
            description: 'Start background agent',
            taskType: 'local_agent',
            subagentType: 'general-purpose',
            prompt: 'Work in background',
          }),
        );
        return {
          toolResults: blocks.map((block) => ({
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: 'background launch ready',
            is_error: false,
          })),
          allMessages: [],
        };
      });

      const gen = queryT({
        prompt: 'Start a background agent',
        model: 'test-model',
        promptId: 'pid-agent-ready',
        sessionId: 'sid-agent-ready',
        toolBridge,
        messages: [],
      });

      const { events } = await drain(gen);
      const taskStartedIndex = events.findIndex(
        (event) =>
          event.type === 'system' &&
          event.subtype === 'task_started' &&
          event.task_id === 'agent-ready',
      );
      const toolResultIndex = events.findIndex(isRuntimeToolResultEvent);

      expect(taskStartedIndex).toBeGreaterThanOrEqual(0);
      expect(toolResultIndex).toBeGreaterThan(taskStartedIndex);
    });

    it.each(
      [false, true].flatMap((isSubagent) =>
        [false, true].flatMap((streaming) =>
          (['ready', 'pending'] as const).map((executionState) => ({
            isSubagent,
            streaming,
            executionState,
          })),
        ),
      ),
    )(
      'preserves session-wide background task snapshot order (subagent=$isSubagent, streaming=$streaming, execution=$executionState)',
      async ({ isSubagent, streaming, executionState }) => {
        const sessionId = `sid-background-roster-${isSubagent}-${streaming}-${executionState}`;
        const tasks = ['A', 'B', 'C'].map((taskId) => ({
          taskId,
          taskType: 'local_bash',
          description: `Background command ${taskId}`,
        }));
        mockStreamTurns.push(
          ...tasks.map((task) =>
            makeToolUseStreamEvents(`tu_${task.taskId}`, 'Bash', {
              command: task.description,
              run_in_background: true,
            }),
          ),
          makeTextStreamEvents('All background commands launched'),
        );
        mockFetch.mockResolvedValue(mockOkResponse());

        const foreignSnapshot = createBackgroundTasksChangedEvent({
          sessionId: `${sessionId}-other`,
          tasks: [],
        });
        enqueueSubagentSdkEvent(`${sessionId}-other`, foreignSnapshot);
        const unrelatedChild = createUserMessage('Unrelated child event');
        unrelatedChild.parent_tool_use_id = 'tu_unrelated';
        unrelatedChild.sessionId = sessionId;
        enqueueSubagentSdkEvent(sessionId, unrelatedChild);

        let launched = 0;
        const snapshots: QueryEvent[] = [];
        const createBridge = streaming
          ? createMockStreamingToolBridge
          : createMockToolBridge;
        const toolBridge = createBridge(async (blocks) => {
          const task = tasks[launched++];
          enqueueSubagentSdkEvent(
            sessionId,
            createTaskStartedEvent({
              sessionId,
              ...task,
              toolUseId: blocks[0].id,
            }),
          );
          const snapshot = createBackgroundTasksChangedEvent({
            sessionId,
            tasks: tasks.slice(0, launched),
          });
          snapshots.push(snapshot);
          enqueueSubagentSdkEvent(sessionId, snapshot);
          if (executionState === 'pending') {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
          return {
            toolResults: blocks.map((block) => ({
              type: 'tool_result' as const,
              tool_use_id: block.id,
              content: 'Background command launched',
              is_error: false,
            })),
            allMessages: [],
          };
        });

        const { events } = await drain(
          queryT({
            prompt: 'Launch three background commands',
            model: 'test-model',
            promptId: `pid-background-roster-${isSubagent}-${streaming}-${executionState}`,
            sessionId,
            isSubagent,
            toolBridge,
            messages: [],
          }),
        );
        const taskEvents = events.flatMap((event) => {
          if (event.type !== 'system') return [];
          if (event.subtype === 'task_started') {
            return [`start:${event.task_id}`];
          }
          if (event.subtype === 'background_tasks_changed') {
            return [
              `snapshot:${event.tasks?.map((task) => task.task_id).join(',')}`,
            ];
          }
          return [];
        });

        expect(taskEvents).toEqual(
          isSubagent
            ? ['start:A', 'start:B', 'start:C']
            : [
                'start:A',
                'snapshot:A',
                'start:B',
                'snapshot:A,B',
                'start:C',
                'snapshot:A,B,C',
              ],
        );
        expect(drainSubagentSdkEvents(sessionId, () => true)).toEqual([
          unrelatedChild,
          ...(isSubagent ? snapshots : []),
        ]);
        expect(
          drainSubagentSdkEvents(`${sessionId}-other`, () => true),
        ).toEqual([foreignSnapshot]);
      },
    );

    it('cancels the side-event waiter when tool execution finishes first', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tu_agent_done', 'Agent', {
          description: 'Explore current directory',
          prompt: 'Look around',
        }),
        makeTextStreamEvents('Subagent finished'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const toolBridge = createMockToolBridge(async (blocks) => ({
        toolResults: blocks.map((block) => ({
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: 'child result',
          is_error: false,
        })),
        allMessages: [],
      }));

      const gen = queryT({
        prompt: 'Use a subagent',
        model: 'test-model',
        promptId: 'pid-agent-side-events-no-leak',
        sessionId: 'sid-subagent-no-leak',
        toolBridge,
        messages: [],
      });

      await drain(gen);

      const lateChildUser = createUserMessage('Late child event');
      lateChildUser.parent_tool_use_id = 'tu_agent_done';
      lateChildUser.sessionId = 'sid-subagent-no-leak';
      enqueueSubagentSdkEvent('sid-subagent-no-leak', lateChildUser);

      expect(
        drainSubagentSdkEvents('sid-subagent-no-leak', () => true),
      ).toEqual([lateChildUser]);
    });

    it('drains cancelled tool_result when aborted while waiting for subagent execution', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tu_agent_abort', 'Agent', {
          description: 'Explore current directory',
          prompt: 'Look around',
        }),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      let resolveExecuteStarted: () => void = () => {};
      const executeStarted = new Promise<void>((resolve) => {
        resolveExecuteStarted = resolve;
      });
      const toolBridge = createMockToolBridge(async (blocks, signal) => {
        resolveExecuteStarted();
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          toolResults: blocks.map((block) => ({
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: REJECT_MESSAGE,
            is_error: true,
          })),
          allMessages: [],
        };
      });
      const controller = new AbortController();

      const gen = queryT({
        prompt: 'Use a subagent',
        model: 'test-model',
        promptId: 'pid-agent-abort-wait',
        sessionId: 'sid-subagent-abort-wait',
        signal: controller.signal,
        toolBridge,
        messages: [],
      });

      const drainPromise = drain(gen);
      await executeStarted;
      // Per-block dispatch starts the tool while the model stream is still
      // delivering; let the stream settle so the abort lands on the tool wait.
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();

      const { events, terminal } = await Promise.race([
        drainPromise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Timed out waiting for abort drain')),
            1000,
          ),
        ),
      ]);
      const resultBlocks = events
        .filter(isRuntimeToolResultEvent)
        .flatMap(getToolResultBlocks);
      const interruptionEvents = events.filter(
        (event): event is QueryEvent & { type: 'user' } =>
          event.type === 'user' &&
          Array.isArray(event.message.content) &&
          event.message.content.some(
            (block) =>
              block.type === 'text' &&
              block.text === '[Request interrupted by user for tool use]',
          ),
      );

      expect(terminal.reason).toBe('abort');
      expect(terminal.abortKind).toBe('aborted_tools');
      expect(resultBlocks).toHaveLength(1);
      expect(resultBlocks[0]).toMatchObject({
        tool_use_id: 'tu_agent_abort',
        is_error: true,
        content: REJECT_MESSAGE,
      });
      expect(interruptionEvents).toHaveLength(1);
    });

    it('preserves completed Agent tool_result and cancels unfinished Agent tool_results after abort', async () => {
      mockStreamTurns.push(
        makeParallelToolUseStreamEvents([
          {
            id: 'tu_agent_done',
            name: 'Agent',
            input: { description: 'done', prompt: 'Finish first' },
          },
          {
            id: 'tu_agent_cancel_a',
            name: 'Agent',
            input: { description: 'cancel a', prompt: 'Still running' },
          },
          {
            id: 'tu_agent_cancel_b',
            name: 'Agent',
            input: { description: 'cancel b', prompt: 'Still queued' },
          },
        ]),
        makeTextStreamEvents('This follow-up must not run'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      let resolveExecuteStarted: () => void = () => {};
      const executeStarted = new Promise<void>((resolve) => {
        resolveExecuteStarted = resolve;
      });
      const toolBridge = createMockToolBridge(async (blocks, signal) => {
        resolveExecuteStarted();
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          toolResults: blocks.map((block) =>
            block.id === 'tu_agent_done'
              ? {
                  type: 'tool_result' as const,
                  tool_use_id: block.id,
                  content: 'completed result',
                  is_error: false,
                }
              : {
                  type: 'tool_result' as const,
                  tool_use_id: block.id,
                  content: REJECT_MESSAGE,
                  is_error: true,
                },
          ),
          allMessages: [],
        };
      });
      const controller = new AbortController();

      const gen = queryT({
        prompt: 'Run parallel agents',
        model: 'test-model',
        promptId: 'pid-parallel-agent-mixed-cancel',
        sessionId: 'sid-parallel-agent-mixed-cancel',
        signal: controller.signal,
        toolBridge,
        messages: [],
      });

      const drainPromise = drain(gen);
      await executeStarted;
      // Per-block dispatch starts the tools while the model stream is still
      // delivering; let the stream settle so the abort lands on the tool wait.
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();

      const { events, terminal } = await Promise.race([
        drainPromise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Timed out waiting for mixed abort drain')),
            1000,
          ),
        ),
      ]);
      const resultBlocks = events
        .filter(isRuntimeToolResultEvent)
        .flatMap(getToolResultBlocks);
      const interruptionEvents = events.filter(
        (event): event is QueryEvent & { type: 'user' } =>
          event.type === 'user' &&
          Array.isArray(event.message.content) &&
          event.message.content.some(
            (block) =>
              block.type === 'text' &&
              block.text === '[Request interrupted by user for tool use]',
          ),
      );

      expect(terminal.reason).toBe('abort');
      expect(terminal.abortKind).toBe('aborted_tools');
      expect(resultBlocks).toHaveLength(3);
      expect(resultBlocks[0]).toMatchObject({
        tool_use_id: 'tu_agent_done',
        content: 'completed result',
      });
      expect(resultBlocks[0]?.is_error).toBeUndefined();
      expect(resultBlocks.slice(1)).toEqual([
        expect.objectContaining({
          tool_use_id: 'tu_agent_cancel_a',
          is_error: true,
          content: REJECT_MESSAGE,
        }),
        expect.objectContaining({
          tool_use_id: 'tu_agent_cancel_b',
          is_error: true,
          content: REJECT_MESSAGE,
        }),
      ]);
      expect(interruptionEvents).toHaveLength(1);
      expect(streamCallIndex).toBe(1);
    });

    it('should yield correct event order in a tool loop turn', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tu_order', 'grep', { pattern: 'foo' }),
        makeTextStreamEvents('Found it'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const toolBridge = createMockToolBridge(async (blocks) => ({
        toolResults: blocks.map((b) => ({
          type: 'tool_result' as const,
          tool_use_id: b.id,
          content: 'match',
          is_error: false,
        })),
        allMessages: [],
      }));

      const gen = queryT({
        prompt: 'Search',
        model: 'test-model',
        promptId: 'pid-tl-order',
        toolBridge,
        messages: [],
      });

      const { events } = await drain(gen);
      const types = events.map((e) => e.type);

      // Verify turn 1 ordering
      const reqStartIdx1 = types.indexOf('request_start');
      const assistantIdx1 = events.findIndex(isRuntimeAssistantEvent);
      const toolResultIdx = events.findIndex(isRuntimeToolResultEvent);
      const reqStartIdx2 = types.indexOf('request_start', reqStartIdx1 + 1);
      const assistantIdx2 = events.findIndex(
        (event, index) =>
          index > assistantIdx1 && isRuntimeAssistantEvent(event),
      );

      expect(reqStartIdx1).toBeLessThan(assistantIdx1);
      expect(assistantIdx1).toBeLessThan(toolResultIdx);
      expect(toolResultIdx).toBeLessThan(reqStartIdx2);
      expect(reqStartIdx2).toBeLessThan(assistantIdx2);
    });

    it('should yield error tool_result when toolBridge.execute() throws', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tu_err', 'bash', { command: 'bad' }),
        makeTextStreamEvents('Recovered'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const toolBridge = createMockToolBridge(async () => {
        throw new Error('Permission denied');
      });

      const gen = queryT({
        prompt: 'Run command',
        model: 'test-model',
        promptId: 'pid-tl-err',
        toolBridge,
        messages: [],
      });

      const { events } = await drain(gen);
      const toolResult = events.find(isRuntimeToolResultEvent);

      expect(toolResult).toBeDefined();
      if (toolResult) {
        const resultBlocks = getToolResultBlocks(toolResult);
        expect(resultBlocks.length).toBe(1);
        const resultBlock = resultBlocks[0];
        expect(resultBlock?.is_error).toBe(true);
        expect(String(resultBlock?.content)).toContain('Permission denied');
      }
    });

    it('forwards the denial kind to permission_denied system events', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tu_rejected', 'bash', { command: 'bad' }),
        makeTextStreamEvents('Used a different approach'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const toolBridge = createMockToolBridge(async (blocks) => ({
        toolResults: [
          {
            type: 'tool_result' as const,
            tool_use_id: blocks[0].id,
            content: REJECT_MESSAGE,
            is_error: true,
            toolDenialKind: 'user-rejected',
          },
        ],
        allMessages: [],
        permissionDenials: [
          {
            tool_name: blocks[0].name,
            tool_use_id: blocks[0].id,
            tool_input: blocks[0].input,
            message: REJECT_MESSAGE,
            tool_denial_kind: 'user-rejected',
            decision_reason_type: 'permissionPromptTool',
            decision_reason: 'Use a different approach',
          },
        ],
      }));

      const gen = queryT({
        prompt: 'Run command',
        model: 'test-model',
        promptId: 'pid-denial-kind',
        toolBridge,
        messages: [],
      });

      const { events } = await drain(gen);
      const permissionDenied = events.find(isPermissionDeniedEvent);

      expect(permissionDenied).toMatchObject({
        tool_name: 'bash',
        tool_use_id: 'tu_rejected',
        tool_denial_kind: 'user-rejected',
        decision_reason_type: 'permissionPromptTool',
        decision_reason: 'Use a different approach',
      });
    });

    it('yields one interrupted tool_result for each parallel tool_use when bridge execution is aborted', async () => {
      mockStreamTurns.push(
        makeParallelToolUseStreamEvents([
          {
            id: 'tu_agent_a',
            name: 'Agent',
            input: { subagent_name: 'research-a', prompt: 'A' },
          },
          {
            id: 'tu_agent_b',
            name: 'Agent',
            input: { subagent_name: 'research-b', prompt: 'B' },
          },
        ]),
        makeTextStreamEvents('Recovered from cancellation'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const toolBridge = createMockToolBridge(async () => {
        const abortError = new Error('Operation cancelled by user');
        abortError.name = 'AbortError';
        throw abortError;
      });

      const gen = queryT({
        prompt: 'Run parallel agents',
        model: 'test-model',
        promptId: 'pid-parallel-agent-cancel',
        sessionId: 'sid-parallel-agent-cancel',
        toolBridge,
        messages: [],
      });

      const { events, terminal } = await drain(gen);
      const resultBlocks = events
        .filter(isRuntimeToolResultEvent)
        .flatMap(getToolResultBlocks);

      expect(resultBlocks).toHaveLength(2);
      expect(resultBlocks.map((block) => block.tool_use_id)).toEqual([
        'tu_agent_a',
        'tu_agent_b',
      ]);
      for (const block of resultBlocks) {
        expect(block.is_error).toBe(true);
        expect(block.content).toBe('Error: Operation cancelled by user');
      }
      const toolResultKinds = events
        .filter(isRuntimeToolResultEvent)
        .map((event) => event.toolDenialKind);
      expect(toolResultKinds).toEqual(['interrupted', 'interrupted']);
      expect(terminal.reason).toBe('end_turn');
    });

    it('should return max_turns terminal when turns exceeded', async () => {
      const toolUseEvents = makeToolUseStreamEvents(
        'tu_loop',
        READ_FILE_TOOL_NAME,
        {},
      );
      mockStreamTurns.push(toolUseEvents, toolUseEvents, toolUseEvents);
      mockFetch.mockResolvedValue(mockOkResponse());

      const toolBridge = createMockToolBridge(async (blocks) => ({
        toolResults: blocks.map((b) => ({
          type: 'tool_result' as const,
          tool_use_id: b.id,
          content: 'ok',
          is_error: false,
        })),
        allMessages: [],
      }));

      const gen = queryT({
        prompt: 'Loop forever',
        model: 'test-model',
        promptId: 'pid-tl-max',
        toolBridge,
        maxTurns: 2,
      });

      const { terminal } = await drain(gen);
      expect(terminal.reason).toBe('max_turns');
      expect(terminal.numTurns).toBe(2);
    });

    it('fires the stop hook on max_turns termination (TurnComplete driver)', async () => {
      const toolUseEvents = makeToolUseStreamEvents(
        'tu_loop',
        READ_FILE_TOOL_NAME,
        {},
      );
      mockStreamTurns.push(toolUseEvents, toolUseEvents);
      mockFetch.mockResolvedValue(mockOkResponse());

      const toolBridge = createMockToolBridge(async (blocks) => ({
        toolResults: blocks.map((b) => ({
          type: 'tool_result' as const,
          tool_use_id: b.id,
          content: 'ok',
          is_error: false,
        })),
        allMessages: [],
      }));
      const fireAfter = vi.fn().mockResolvedValue(null);

      const gen = queryT({
        prompt: 'Loop forever',
        model: 'test-model',
        promptId: 'pid-tl-max-stop',
        toolBridge,
        maxTurns: 1,
        customContext: { tenant: 'max-turns' },
        hookCoordinator: {
          fireBefore: vi.fn().mockResolvedValue(null),
          fireAfter,
          fireStopFailure: vi.fn().mockResolvedValue(undefined),
          drainPendingAsyncContext: vi.fn().mockReturnValue(undefined),
        } as never,
      });

      const { terminal } = await drain(gen);
      expect(terminal.reason).toBe('max_turns');
      // turn 边界复核（memory / skill evolution 门禁）靠 Stop hook 发射的 TurnComplete
      // 驱动；max_turns 收尾此前不发，这一轮内容永远不会被复核。
      expect(fireAfter).toHaveBeenCalledTimes(1);
      expect(fireAfter.mock.calls[0][3]).toMatchObject({
        customContext: { tenant: 'max-turns' },
      });
    });

    it.each(['batch', 'streaming'] as const)(
      'neutralizes successful polls but still guards stale polls in the %s path',
      async (mode) => {
        for (let i = 1; i <= 11; i++) {
          mockStreamTurns.push(
            makeToolUseStreamEvents(`poll_${i}`, 'CodeModeWait', {
              cell_id: 'cell',
            }),
          );
        }
        mockFetch.mockResolvedValue(mockOkResponse());
        let calls = 0;
        const execute = vi.fn(async (blocks: ModelToolUseBlock[]) => {
          calls++;
          return {
            toolResults: blocks.map((block) => ({
              type: 'tool_result' as const,
              tool_use_id: block.id,
              content: calls <= 6 ? 'running' : 'unknown cell',
              is_error: calls > 6,
            })),
            allMessages: [],
            repeatNeutralToolResultIds:
              calls <= 6 ? new Set(blocks.map((block) => block.id)) : undefined,
          };
        });
        const toolBridge =
          mode === 'streaming'
            ? createMockStreamingToolBridge(execute)
            : createMockToolBridge(execute);
        const { terminal } = await drain(
          queryT({
            prompt: 'Wait for the cell',
            model: 'test-model',
            promptId: `poll-${mode}`,
            toolBridge,
            config: {
              ...testRequestConfig(),
              getPermissionMode: () => 'default',
              getModel: () => 'test-model',
            } as unknown as Config,
          }),
        );
        expect(execute).toHaveBeenCalledTimes(10);
        expect(terminal.reason).toBe('repeated_tool_call_denied');
        expect(streamCallIndex).toBe(11);
      },
    );

    it.each(['batch', 'streaming'] as const)(
      'does not let an earlier neutral poll erase later failures in the %s path',
      async (mode) => {
        mockStreamTurns.push(
          makeParallelToolUseStreamEvents([
            { id: 'poll_ok', name: 'CodeModeWait', input: { cell_id: 'cell' } },
            {
              id: 'poll_error',
              name: 'CodeModeWait',
              input: { cell_id: 'cell' },
            },
          ]),
        );
        for (let i = 3; i <= 6; i++) {
          mockStreamTurns.push(
            makeToolUseStreamEvents(`poll_${i}`, 'CodeModeWait', {
              cell_id: 'cell',
            }),
          );
        }
        mockFetch.mockResolvedValue(mockOkResponse());
        const execute = vi.fn(async (blocks: ModelToolUseBlock[]) => ({
          toolResults: blocks.map((block) => ({
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: block.id === 'poll_ok' ? 'running' : 'unknown cell',
            is_error: block.id !== 'poll_ok',
          })),
          allMessages: [],
          repeatNeutralToolResultIds: new Set(['poll_ok']),
        }));
        const toolBridge =
          mode === 'streaming'
            ? createMockStreamingToolBridge(execute)
            : createMockToolBridge(execute);
        const { terminal } = await drain(
          queryT({
            prompt: 'Wait for the cell',
            model: 'test-model',
            promptId: `poll-batch-${mode}`,
            toolBridge,
            config: {
              ...testRequestConfig(),
              getPermissionMode: () => 'default',
              getModel: () => 'test-model',
            } as unknown as Config,
          }),
        );
        // Per-block dispatch neutralizes the neutral poll before the failing
        // poll of the same batch is checked, so the streak restarts at the
        // failure and buys exactly one extra repeat: the pair runs once each,
        // then three follow-up polls, before the fifth identical call is
        // refused.
        expect(execute).toHaveBeenCalledTimes(5);
        expect(terminal.reason).toBe('repeated_tool_call_denied');
      },
    );

    it('terminates when the same tool call repeats five times without confirmation', async () => {
      for (let i = 1; i <= 5; i++) {
        mockStreamTurns.push(
          makeToolUseStreamEvents(`tu_repeat_${i}`, READ_FILE_TOOL_NAME, {
            file_path: '/same.txt',
          }),
        );
      }
      mockStreamTurns.push(makeTextStreamEvents('should not run'));
      mockFetch.mockResolvedValue(mockOkResponse());

      const toolBridge = createMockToolBridge(async (blocks) => ({
        toolResults: blocks.map((b) => ({
          type: 'tool_result' as const,
          tool_use_id: b.id,
          content: 'ok',
          is_error: false,
        })),
        allMessages: [],
      }));

      const fireQueryEndEvent = vi.fn().mockResolvedValue(undefined);
      const gen = queryT({
        prompt: 'Read repeatedly',
        model: 'test-model',
        promptId: 'pid-repeated-tool-call-deny',
        preallocatedRequestSetId: 'request-repeated-tool-call-deny',
        toolBridge,
        config: {
          getHookSystem: () => ({ fireQueryEndEvent }),
          getTargetDir: () => process.cwd(),
          getWorkingDir: () => process.cwd(),
          getWorkspaceContext: () => ({ getDirectories: () => [] }),
          getPermissionMode: () => 'default',
          getModel: () => 'test-model',
        } as unknown as Config,
      });

      const { events, terminal } = await drain(gen);
      const resultBlocks = events
        .filter(isRuntimeToolResultEvent)
        .flatMap(getToolResultBlocks);
      const permissionDenied = events.find(
        (event) =>
          event.type === 'system' && event.subtype === 'permission_denied',
      );

      expect(terminal.reason).toBe('repeated_tool_call_denied');
      expect(fireQueryEndEvent).toHaveBeenCalledExactlyOnceWith(
        'request-repeated-tool-call-deny',
        expect.any(String),
        'test-model',
        'repeated_tool_call_denied',
      );
      expect(mockReportBusinessFinish).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          businessInfo: expect.objectContaining({ stage: 'abort' }),
        }),
      );
      expect(toolBridge.execute).toHaveBeenCalledTimes(4);
      expect(resultBlocks.at(-1)).toMatchObject({
        tool_use_id: 'tu_repeat_5',
        is_error: true,
      });
      expect(String(resultBlocks.at(-1)?.content)).toContain(
        'Repeated tool call',
      );
      expect(permissionDenied).toMatchObject({
        decision_reason_type: 'repeatedToolCall',
      });
      expect(streamCallIndex).toBe(5);
    });

    it('should accumulate usage across multiple turns', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tu_usage', READ_FILE_TOOL_NAME, {}),
        makeTextStreamEvents('Done'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const toolBridge = createMockToolBridge(async (blocks) => ({
        toolResults: blocks.map((b) => ({
          type: 'tool_result' as const,
          tool_use_id: b.id,
          content: 'ok',
          is_error: false,
        })),
        allMessages: [],
      }));

      const gen = queryT({
        prompt: 'Test usage',
        model: 'test-model',
        promptId: 'pid-tl-usage',
        toolBridge,
      });

      const { terminal } = await drain(gen);
      expect(terminal.reason).toBe('end_turn');
      expect(terminal.usage.input_tokens).toBeGreaterThanOrEqual(0);
      expect(terminal.usage.output_tokens).toBeGreaterThanOrEqual(0);
    });

    it('should pass tool_use blocks with correct args to toolBridge.execute()', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tu_args', READ_FILE_TOOL_NAME, {
          file_path: '/important.ts',
        }),
        makeTextStreamEvents('Content delivered'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const executeSpy = vi.fn(async (block: ModelToolUseBlock) => ({
        block: {
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: 'mocked',
          is_error: false,
        },
        supplementaryMessages: [],
        historyMessage: {} as never,
        control: { settlement: 'completed' as const },
      }));

      const toolBridge: MockToolBridge = {
        getToolSchema: vi.fn(() => []),
        execute: executeSpy,
      };

      const gen = queryT({
        prompt: 'Read important file',
        model: 'test-model',
        promptId: 'pid-tl-args',
        toolBridge,
      });

      await drain(gen);

      expect(executeSpy).toHaveBeenCalledTimes(1);
      const calledBlock = executeSpy.mock.calls[0][0];
      expect(calledBlock.id).toBe('tu_args');
      expect(calledBlock.name).toBe(READ_FILE_TOOL_NAME);
    });
  });

  // ========================================================================
  // Per-block yield (assistant_block events)
  // ========================================================================

  describe('per-block yield', () => {
    it.each(['', 'provider-reused-id'])(
      'assigns different local response groups when upstream response ids are %j',
      async (upstreamId) => {
        mockFetch.mockResolvedValue(mockOkResponse());
        const useId = (events: unknown[]) =>
          events.map((event) => {
            const frame = event as {
              type: string;
              message?: Record<string, unknown>;
            };
            return frame.type === 'message_start'
              ? { ...frame, message: { ...frame.message, id: upstreamId } }
              : event;
          });
        mockStreamTurns.push(
          useId(
            makeToolUseStreamEvents('group-tool', READ_FILE_TOOL_NAME, {
              file_path: '/test.ts',
            }),
          ),
          useId(makeTextStreamEvents('complete')),
        );
        const toolBridge = createMockToolBridge(async (blocks) => ({
          toolResults: blocks.map((block) => ({
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: 'file result',
            is_error: false,
          })),
          allMessages: [],
        }));
        const { events, terminal } = await drain(
          queryT({
            prompt: 'read then answer',
            model: 'test-model',
            promptId: 'response-groups',
            toolBridge,
          }),
        );
        expect(terminal.reason).toBe('end_turn');
        const assistants = events.filter(isRuntimeAssistantEvent);
        expect(assistants).toHaveLength(2);
        expect(assistants.map((message) => message.message.id)).toEqual([
          upstreamId,
          upstreamId,
        ]);
        expect(
          assistants.every(
            (message) => typeof message.responseGroupId === 'string',
          ),
        ).toBe(true);
        expect(
          new Set(assistants.map((message) => message.responseGroupId)).size,
        ).toBe(2);
      },
    );

    it('should yield assistant_block for each content block in a multi-block response', async () => {
      // Simulate: thinking block + text block
      mockStreamEvents.length = 0;
      mockStreamEvents.push(
        {
          type: 'message_start',
          message: {
            id: 'msg_multi',
            model: 'test-model',
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        // Block 0: thinking
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Let me think...' },
        },
        {
          type: 'content_block_stop',
          index: 0,
        },
        // Block 1: text
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'The answer is 42' },
        },
        {
          type: 'content_block_stop',
          index: 1,
        },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 20 },
        },
        {
          type: 'message_stop',
        },
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const gen = queryT({
        prompt: 'Think and answer',
        model: 'test-model',
        promptId: 'pid-multi-block',
      });

      const { events } = await drain(gen);
      const blockEvents = events.filter((e) => e.type === 'assistant_block');

      // Should have 2 assistant_block events (one for thinking, one for text)
      expect(blockEvents.length).toBe(2);

      if (blockEvents[0].type === 'assistant_block') {
        expect(blockEvents[0].index).toBe(0);
        expect(blockEvents[0].message.blocks.length).toBe(1);
        expect(blockEvents[0].message.blocks[0].type).toBe('thinking');
      }

      if (blockEvents[1].type === 'assistant_block') {
        expect(blockEvents[1].index).toBe(1);
        expect(blockEvents[1].message.blocks.length).toBe(1);
        expect(blockEvents[1].message.blocks[0].type).toBe('text');
      }

      const assistantEvents = events.filter(isRuntimeAssistantEvent);
      expect(assistantEvents).toHaveLength(2);
      expect(assistantEvents[0].responseGroupId).toEqual(expect.any(String));
      expect(assistantEvents[1].responseGroupId).toBe(
        assistantEvents[0].responseGroupId,
      );
      expect(assistantEvents[1].uuid).not.toBe(assistantEvents[0].uuid);
      expect(assistantEvents.map((message) => message.message.id)).toEqual([
        'msg_multi',
        'msg_multi',
      ]);
      expect(assistantEvents[0].message.stop_reason).toBeNull();
      expect(assistantEvents[0].message).not.toHaveProperty('usage');
      expect(assistantEvents[1].message.stop_reason).toBe('end_turn');
      expect(assistantEvents[1].message.usage?.output_tokens).toBe(20);
    });

    it('should yield assistant_block for tool_use blocks during streaming', async () => {
      mockStreamEvents.length = 0;
      mockStreamEvents.push(
        ...makeToolUseStreamEvents('tu_block', READ_FILE_TOOL_NAME, {
          path: '/test.ts',
        }),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      // Need toolBridge to avoid error
      const toolBridge = createMockToolBridge(async (blocks) => ({
        toolResults: blocks.map((b) => ({
          type: 'tool_result' as const,
          tool_use_id: b.id,
          content: 'ok',
          is_error: false,
        })),
        allMessages: [],
      }));

      // Also need a second turn to end
      mockStreamTurns.push(
        makeToolUseStreamEvents('tu_block', READ_FILE_TOOL_NAME, {
          path: '/test.ts',
        }),
        makeTextStreamEvents('Done'),
      );
      mockStreamEvents.length = 0; // Clear since we're using turns

      const gen = queryT({
        prompt: 'Read file',
        model: 'test-model',
        promptId: 'pid-block-tool',
        toolBridge,
      });

      const { events } = await drain(gen);
      const blockEvents = events.filter((e) => e.type === 'assistant_block');

      // 2 turns, each with 1 block = 2 assistant_block events
      expect(blockEvents.length).toBe(2);

      // First turn's block should be tool_use
      if (blockEvents[0].type === 'assistant_block') {
        expect(blockEvents[0].message.blocks[0].type).toBe('tool_use');
      }
    });

    it('should yield assistant_block BEFORE assistant for the same turn', async () => {
      setStreamEvents('Hello');
      mockFetch.mockResolvedValue(mockOkResponse());

      const gen = queryT({
        prompt: 'Hi',
        model: 'test-model',
        promptId: 'pid-block-order',
        messages: [],
      });

      const { events } = await drain(gen);
      const types = events.map((e) => e.type);

      const blockIdx = types.indexOf('assistant_block');
      const contentBlockStopIdx = events.findIndex(
        (event) =>
          event.type === 'stream_event' &&
          event.event.type === 'content_block_stop',
      );
      const assistantIdx = events.findIndex(isRuntimeAssistantEvent);

      expect(blockIdx).toBeGreaterThan(-1);
      expect(contentBlockStopIdx).toBeGreaterThan(-1);
      expect(assistantIdx).toBeGreaterThan(-1);
      expect(blockIdx).toBeLessThan(contentBlockStopIdx);
      expect(blockIdx).toBeLessThan(assistantIdx);
    });
  });

  // ========================================================================
  // Tool use detection (not relying on stop_reason alone)
  // ========================================================================

  describe('tool use detection', () => {
    it('should detect tool_use by content blocks, not just stop_reason', async () => {
      // Simulate: model returns tool_use block but with end_turn stop_reason
      // (unusual but possible). The loop should still detect tool_use.
      mockStreamTurns.push(
        [
          {
            type: 'message_start',
            message: {
              id: 'msg_odd',
              model: 'test-model',
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'tu_odd',
              name: READ_FILE_TOOL_NAME,
              input: {},
            },
          },
          {
            type: 'content_block_stop',
            index: 0,
          },
          {
            type: 'message_delta',
            // Note: stop_reason is end_turn, NOT tool_use
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 5 },
          },
          {
            type: 'message_stop',
          },
        ],
        makeTextStreamEvents('Done'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const executeSpy = vi.fn(async (block: ModelToolUseBlock) => {
        const resultBlock = {
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: 'result',
          is_error: false,
        };
        return {
          block: resultBlock,
          supplementaryMessages: [],
          historyMessage: createToolResultMessage([resultBlock], block.id),
          control: { settlement: 'completed' as const },
        };
      });

      const toolBridge: MockToolBridge = {
        getToolSchema: vi.fn(() => []),
        execute: executeSpy,
      };

      const gen = queryT({
        prompt: 'Odd case',
        model: 'test-model',
        promptId: 'pid-detect',
        toolBridge,
        messages: [],
      });

      const { events, terminal } = await drain(gen);

      // Tool should have been executed despite end_turn stop_reason
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(events.filter(isRuntimeToolResultEvent).length).toBe(1);
      expect(terminal.reason).toBe('end_turn');
      expect(terminal.numTurns).toBe(2);
    });
  });

  describe('session context request preparation', () => {
    const root = path.resolve('/session-context-test/project');
    const child = path.join(root, 'worktree');
    const initialGit = 'Current branch: main\nRecent commits:\nabc123 before';
    const latestGit = 'Current branch: child\nRecent commits:\ndef456 after';
    let collectGit: MockInstance<typeof gitContext.collectGitContext>;

    beforeEach(() => {
      collectGit = vi
        .spyOn(gitContext, 'collectGitContext')
        .mockResolvedValue({ gitStatus: latestGit });
    });
    afterEach(() => collectGit.mockRestore());

    function savedGit(gitStatus = initialGit) {
      return createAttachmentMessage(
        new SessionContextAttachment({
          type: 'session_context',
          context: { gitStatus },
        }),
      );
    }
    function context() {
      const ctx = createAttachmentContext(root, 'session-context-agent');
      ctx.config = {
        ...testRequestConfig(),
        getTargetDir: () => root,
        getWorkingDir: () => root,
        getWorkspaceContext: () => ({ getDirectories: () => [root] }),
        getGoalManager: () => undefined,
      } as unknown as Config;
      return ctx;
    }
    const gitEvents = (events: QueryEvent[]) =>
      events.filter(
        (event): event is Extract<Message, { type: 'attachment' }> =>
          event.type === 'attachment' &&
          event.attachment.type === 'session_context',
      );

    describe.each([false, true])('subagent=%s', (isSubagent) => {
      it.each([
        'fresh',
        'resume',
        'legacy resume',
        'history-only',
        'after manual compact',
      ])('prepares Git before the first %s request', async (scenario) => {
        const ctx = context();
        const history: Message[] =
          scenario === 'resume'
            ? JSON.parse(JSON.stringify([savedGit()]))
            : [createUserMessage('Earlier conversation')];
        setStreamEvents('Done');
        mockFetch.mockResolvedValue(mockOkResponse());
        const { events, terminal } = await runWithCwdOverride(child, () =>
          drain(
            queryT({
              prompt: 'Continue',
              model: 'test-model',
              promptId: `git-${scenario}`,
              systemPrompt: systemPromptFromText('Stable system prompt'),
              messages: history,
              skipInitialUserMessage: scenario === 'history-only',
              attachmentCtx: ctx,
              config: ctx.config,
              isSubagent,
            }),
          ),
        );
        expect(terminal.reason).toBe('end_turn');
        const request = JSON.stringify(
          (mockInferenceRequests[0] as ModelStreamRequest).prompt.messages,
        );
        expect(request.match(/# gitStatus/g)).toHaveLength(1);
        expect(request).toContain(
          scenario === 'resume' ? 'abc123 before' : 'def456 after',
        );
        expect(gitEvents(events)).toHaveLength(scenario === 'resume' ? 0 : 1);
        expect(collectGit).toHaveBeenCalledTimes(scenario === 'resume' ? 0 : 1);
        if (scenario !== 'resume')
          expect(collectGit).toHaveBeenCalledWith(child, expect.anything());
      });

      it.each([
        'auto',
        'reactive',
        'auto retaining snapshot',
        'auto without initial snapshot',
      ])(
        'selects the retained Git snapshot after %s compaction',
        async (trigger) => {
          const ctx = context();
          let afterCompact = false;
          collectGit.mockImplementation(async () => ({
            gitStatus: afterCompact ? latestGit : initialGit,
          }));
          const history =
            trigger === 'auto without initial snapshot' ? [] : [savedGit()];
          const retained = trigger === 'auto retaining snapshot';
          const compacted: Message[] = [
            createUserMessage('Compacted context'),
            ...(retained ? history : []),
          ];
          const compressionPipeline = {
            compress: vi.fn(
              async (
                _history: readonly Message[],
                opts: { trigger: string },
              ) => {
                if (trigger === 'reactive' && opts.trigger !== 'reactive')
                  return { newHistory: null };
                afterCompact = true;
                return {
                  newHistory: compacted,
                  info: {
                    originalTokenCount: 100,
                    newTokenCount: 10,
                    compressionStatus: CompressionStatus.COMPRESSED,
                  },
                };
              },
            ),
          };
          setStreamEvents('Done after compression');
          if (trigger === 'reactive')
            mockStreamTurns.push(
              [
                new ClientError('Prompt is too long', {
                  code: 'context_length_exceeded',
                  statusCode: 400,
                }),
              ],
              makeTextStreamEvents('Done after compression'),
            );
          mockFetch.mockResolvedValue(mockOkResponse());
          const { events, terminal } = await runWithCwdOverride(child, () =>
            drain(
              queryT({
                prompt: 'Continue',
                model: 'test-model',
                promptId: `git-${trigger}`,
                messages: history,
                attachmentCtx: ctx,
                config: ctx.config,
                isSubagent,
                compressionPipeline: compressionPipeline as never,
              }),
            ),
          );
          expect(terminal.reason).toBe('end_turn');
          const request = JSON.stringify(
            (mockInferenceRequests.at(-1) as ModelStreamRequest).prompt
              .messages,
          );
          expect(request.match(/# gitStatus/g)).toHaveLength(1);
          expect(request).toContain(
            retained ? 'abc123 before' : 'def456 after',
          );
          if (!retained) expect(request).not.toContain('abc123 before');
          expect(
            gitEvents(events).filter(
              (event) =>
                !history.some((message) => message.uuid === event.uuid),
            ),
          ).toHaveLength(retained ? 0 : 1);
          expect(collectGit).toHaveBeenCalledTimes(retained ? 0 : 1);
        },
      );
    });

    describe.each([false, true])(
      'session context updates subagent=%s',
      (isSubagent) => {
        it.each([
          'ordinary',
          'manual compact',
          'auto retaining snapshot',
          'auto removing snapshot',
          'reactive compact',
        ])('announces the appropriate baseline after %s', async (scenario) => {
          const ctx = context();
          const previous = createAttachmentMessage(
            new SessionContextAttachment({
              type: 'session_context',
              context: { gitStatus: initialGit, userEmail: 'old@example.test' },
              changed: true,
              reason: 'account_change',
            }),
          );
          const boundary = () =>
            createCompactBoundaryMessage({ trigger: 'manual', preTokens: 100 });
          const history: Message[] =
            scenario === 'manual compact' ? [boundary(), previous] : [previous];
          const dropsSnapshot = scenario === 'auto removing snapshot';
          const runsCompact =
            scenario.startsWith('auto') || scenario === 'reactive compact';
          let compacted = false;
          const compressionPipeline = runsCompact
            ? {
                compress: vi.fn(
                  async (
                    _messages: readonly Message[],
                    opts: { trigger: string },
                  ) => {
                    if (
                      compacted ||
                      (scenario === 'reactive compact' &&
                        opts.trigger !== 'reactive')
                    )
                      return { newHistory: null };
                    compacted = true;
                    return {
                      newHistory: [
                        boundary(),
                        createUserMessage('Compacted context'),
                        ...(dropsSnapshot ? [] : [previous]),
                      ],
                      info: {
                        originalTokenCount: 100,
                        newTokenCount: 10,
                        compressionStatus: CompressionStatus.COMPRESSED,
                      },
                    };
                  },
                ),
              }
            : undefined;
          setStreamEvents('Done');
          if (scenario === 'reactive compact')
            mockStreamTurns.push(
              [
                new ClientError('Prompt is too long', {
                  code: 'context_length_exceeded',
                  statusCode: 400,
                }),
              ],
              makeTextStreamEvents('Done after compression'),
            );
          mockFetch.mockResolvedValue(mockOkResponse());
          const resolveSessionContext = vi.fn(() => ({
            context: {
              userEmail:
                scenario === 'reactive compact' && !compacted
                  ? 'old@example.test'
                  : 'new@example.test',
            },
          }));
          const { events, terminal } = await drain(
            queryT({
              prompt: 'Continue',
              model: 'test-model',
              promptId: `changed-${scenario}`,
              messages: history,
              attachmentCtx: ctx,
              config: ctx.config,
              isSubagent,
              resolveSessionContext,
              compressionPipeline: compressionPipeline as never,
            }),
          );
          expect(terminal.reason).toBe('end_turn');
          const announced = gitEvents(events).filter(
            (event) => event.uuid !== previous.uuid,
          );
          expect(announced).toHaveLength(1);
          if (dropsSnapshot) {
            expect(announced[0].attachment).not.toHaveProperty('changed');
            expect(announced[0].attachment).not.toHaveProperty('reason');
          } else {
            expect(announced[0].attachment).toMatchObject({
              changed: true,
              reason: scenario === 'ordinary' ? 'session_start' : 'compaction',
              context: { gitStatus: initialGit, userEmail: 'new@example.test' },
            });
          }
          expect(collectGit).toHaveBeenCalledTimes(dropsSnapshot ? 1 : 0);
          const request = JSON.stringify(
            (mockInferenceRequests.at(-1) as ModelStreamRequest).prompt
              .messages,
          );
          expect(request).toContain('new@example.test');
          if (!dropsSnapshot)
            expect(request).toContain('these values replace the earlier ones');

          // The changed attachment is a complete baseline, including when the
          // initial announcement was removed before the session was restored.
          const restored: Message[] = JSON.parse(JSON.stringify(announced));
          mockStreamTurns.length = 0;
          setStreamEvents('Resumed');
          const resumed = await drain(
            queryT({
              prompt: 'Resume',
              model: 'test-model',
              promptId: 'changed-resume',
              messages: restored,
              attachmentCtx: ctx,
              config: ctx.config,
              isSubagent,
              resolveSessionContext,
            }),
          );
          expect(resumed.terminal.reason).toBe('end_turn');
          expect(gitEvents(resumed.events)).toHaveLength(0);
          expect(collectGit).toHaveBeenCalledTimes(dropsSnapshot ? 1 : 0);
        });
      },
    );

    it('keeps an auxiliary fork prefix unchanged when current session values differ', async () => {
      const ctx = context();
      const previous = createAttachmentMessage(
        new SessionContextAttachment({
          type: 'session_context',
          context: { userEmail: 'parent@example.test', gitStatus: initialGit },
          changed: true,
          reason: 'account_change',
        }),
      );
      const prefix = buildForkContextMessages([previous]);
      setStreamEvents('Summary');
      mockFetch.mockResolvedValue(mockOkResponse());
      const { events, terminal } = await drain(
        queryT({
          prompt: 'Summarize',
          model: 'test-model',
          promptId: 'changed-auxiliary',
          messages: [previous],
          preProjectedMessages: prefix,
          attachmentCtx: ctx,
          config: ctx.config,
          resolveSessionContext: () => ({
            context: { userEmail: 'live@example.test' },
            reason: 'account_change',
          }),
        }),
      );
      expect(terminal.reason).toBe('end_turn');
      expect(gitEvents(events)).toHaveLength(0);
      expect(collectGit).not.toHaveBeenCalled();
      const request = (mockInferenceRequests[0] as ModelStreamRequest).prompt
        .messages;
      expect(request.slice(0, prefix.length)).toEqual(prefix);
      expect(JSON.stringify(request)).not.toContain('live@example.test');
    });

    describe.each(['default', 'custom', 'override'] as const)(
      '%s prompt source',
      (source) => {
        it.each([false, true])(
          'applies Git collection policy with retained snapshot=%s',
          async (hasSnapshot) => {
            const ctx = context();
            setStreamEvents('Done');
            mockFetch.mockResolvedValue(mockOkResponse());
            const { terminal } = await drain(
              queryT({
                prompt: 'Continue',
                model: 'test-model',
                promptId: `git-source-${source}`,
                attachmentCtx: ctx,
                config: ctx.config,
                messages: hasSnapshot ? [savedGit()] : [],
                resolveSystemPrompt: async () => {
                  const blocks = systemPromptFromText('Stable prompt');
                  return source === 'default'
                    ? { source, bundle: 'full', blocks }
                    : { source, blocks };
                },
              }),
            );
            expect(terminal.reason).toBe('end_turn');
            expect(collectGit).toHaveBeenCalledTimes(
              !hasSnapshot && source === 'default' ? 1 : 0,
            );
            const request = JSON.stringify(
              (mockInferenceRequests[0] as ModelStreamRequest).prompt.messages,
            );
            if (hasSnapshot) expect(request).toContain('abc123 before');
            else if (source === 'default')
              expect(request).toContain('def456 after');
            else expect(request).not.toContain('# gitStatus');
          },
        );
      },
    );

    it.each([false, true])(
      'omits new Git collection when requested for subagent=%s',
      async (isSubagent) => {
        const ctx = context();
        setStreamEvents('Done');
        mockFetch.mockResolvedValue(mockOkResponse());
        const { events, terminal } = await runWithCwdOverride(root, () =>
          drain(
            queryT({
              prompt: 'Continue',
              model: 'test-model',
              promptId: `git-omit-${isSubagent}`,
              attachmentCtx: ctx,
              config: ctx.config,
              isSubagent,
              agentType: isSubagent ? 'Explore' : undefined,
              omitGitStatus: true,
            }),
          ),
        );
        expect(terminal.reason).toBe('end_turn');
        expect(collectGit).not.toHaveBeenCalled();
        expect(gitEvents(events)).toEqual([
          expect.objectContaining({
            attachment: { type: 'session_context', context: {} },
          }),
        ]);
        expect(
          JSON.stringify(
            (mockInferenceRequests[0] as ModelStreamRequest).prompt.messages,
          ),
        ).not.toContain('# gitStatus');
      },
    );

    it('keeps the exact parent fork prefix and carries its Git baseline without replay', async () => {
      const ctx = context();
      const history = [savedGit()];
      const prefix = buildForkContextMessages(history);
      const onCacheSafeSnapshot = vi.fn();
      setStreamEvents('Fork done');
      mockFetch.mockResolvedValue(mockOkResponse());
      const { events, terminal } = await runWithCwdOverride(child, () =>
        drain(
          queryT({
            prompt: 'Inspect',
            model: 'test-model',
            promptId: 'git-fork',
            messages: history,
            preProjectedMessages: prefix,
            attachmentCtx: ctx,
            config: ctx.config,
            isSubagent: true,
            agentType: 'Explore',
            onCacheSafeSnapshot,
          }),
        ),
      );
      expect(terminal.reason).toBe('end_turn');
      expect(collectGit).not.toHaveBeenCalled();
      expect(gitEvents(events)).toEqual([]);
      const request = (mockInferenceRequests[0] as ModelStreamRequest).prompt
        .messages;
      expect(request.slice(0, prefix.length)).toEqual(prefix);
      expect(JSON.stringify(request).match(/# gitStatus/g)).toHaveLength(1);
      expect(
        onCacheSafeSnapshot.mock.calls[0][0].contextAttachmentMessages,
      ).toContainEqual(history[0]);
    });

    it('collects again if a generated Git attachment was never committed by its consumer', async () => {
      const ctx = context();
      const params = {
        prompt: 'Continue',
        model: 'test-model',
        promptId: 'git-cancelled',
        attachmentCtx: ctx,
        config: ctx.config,
      };
      await runWithCwdOverride(root, async () => {
        const generator = queryT(params);
        for await (const event of generator) {
          if (
            event.type === 'attachment' &&
            event.attachment.type === 'session_context'
          )
            break;
        }
        collectGit.mockResolvedValue({
          gitStatus: 'Current branch: changed after cancellation',
        });
        setStreamEvents('Done');
        mockFetch.mockResolvedValue(mockOkResponse());
        const { terminal } = await drain(queryT(params));
        expect(terminal.reason).toBe('end_turn');
        expect(collectGit).toHaveBeenCalledTimes(2);
        expect(
          JSON.stringify(
            (mockInferenceRequests[0] as ModelStreamRequest).prompt.messages,
          ),
        ).toContain('changed after cancellation');
      });
    });
  });

  describe('environment request preparation', () => {
    const root = path.resolve('/environment-test/project');
    const child = path.join(root, 'child');

    function context(isSubagent = false) {
      const ctx = createAttachmentContext(root, 'environment-agent', {
        isMainAgent: !isSubagent,
      });
      ctx.config = {
        ...testRequestConfig(),
        getTargetDir: () => root,
        getWorkingDir: () => root,
        getWorkspaceContext: () => ({ getDirectories: () => [root] }),
        getGoalManager: () => undefined,
      } as unknown as Config;
      return ctx;
    }

    async function baseline(ctx: ReturnType<typeof context>) {
      return runWithCwdOverride(root, async () =>
        (await getEnvironmentAttachments(ctx)).map(createAttachmentMessage),
      );
    }

    describe.each([false, true])('subagent=%s', (isSubagent) => {
      it.each([
        'fresh',
        'resume',
        'legacy resume',
        'history-only',
        'cwd changed',
      ])(
        'includes environment in the first request for %s',
        async (scenario) => {
          const ctx = context(isSubagent);
          const saved = await baseline(ctx);
          const history: Message[] =
            scenario === 'resume' || scenario === 'cwd changed'
              ? JSON.parse(JSON.stringify(saved))
              : scenario === 'fresh'
                ? []
                : [createUserMessage('Restored user prompt')];
          const cwd = scenario === 'cwd changed' ? child : root;
          setStreamEvents('Done');
          mockFetch.mockResolvedValue(mockOkResponse());
          const { events, terminal } = await runWithCwdOverride(cwd, () =>
            drain(
              queryT({
                prompt: 'Continue',
                model: 'test-model',
                promptId: `environment-${scenario}`,
                messages: history,
                skipInitialUserMessage: scenario === 'history-only',
                attachmentCtx: ctx,
                config: ctx.config,
                isSubagent,
              }),
            ),
          );
          expect(terminal.reason).toBe('end_turn');
          const request = JSON.stringify(
            (mockInferenceRequests[0] as ModelStreamRequest).prompt.messages,
          );
          expect(request.match(/# Environment\\n/g)).toHaveLength(1);
          expect(request).toContain(
            JSON.stringify(`Primary working directory: ${cwd}`).slice(1, -1),
          );
          expect(
            events.filter(
              (event) =>
                event.type === 'attachment' &&
                event.attachment.type === 'environment',
            ),
          ).toHaveLength(scenario === 'resume' ? 0 : 1);
          if (scenario === 'cwd changed')
            expect(request.match(/# Environment update/g)).toHaveLength(1);
        },
      );

      it.each([
        'auto',
        'auto with surviving delta',
        'auto retaining full baseline',
        'reactive',
      ])(
        'restores environment before the next request after %s compaction',
        async (trigger) => {
          const ctx = context(isSubagent);
          const history = await baseline(ctx);
          await runWithCwdOverride(child, async () => {
            const delta = (await getEnvironmentAttachments(ctx, history)).map(
              createAttachmentMessage,
            );
            const compacted: Message[] = [
              createUserMessage('Compacted context'),
              ...(trigger === 'auto retaining full baseline'
                ? [...history, ...delta]
                : trigger === 'auto with surviving delta'
                  ? delta
                  : []),
            ];
            const compressionPipeline = {
              compress: vi.fn(
                async (
                  _history: readonly Message[],
                  options: { trigger: string },
                ) => ({
                  newHistory:
                    trigger === 'reactive' && options.trigger !== 'reactive'
                      ? null
                      : compacted,
                  info: {
                    originalTokenCount: 100,
                    newTokenCount: 10,
                    compressionStatus: CompressionStatus.COMPRESSED,
                  },
                }),
              ),
            };
            setStreamEvents('Done after compression');
            if (trigger === 'reactive')
              mockStreamTurns.push(
                [
                  new ClientError('Prompt is too long', {
                    code: 'context_length_exceeded',
                    statusCode: 400,
                  }),
                ],
                makeTextStreamEvents('Done after compression'),
              );
            mockFetch.mockResolvedValue(mockOkResponse());
            const { events, terminal } = await drain(
              queryT({
                prompt: 'Continue current task',
                model: 'test-model',
                promptId: `environment-${trigger}`,
                messages: [...history, ...delta],
                attachmentCtx: ctx,
                config: ctx.config,
                isSubagent,
                compressionPipeline: compressionPipeline as never,
                maxTurns: 3,
              }),
            );
            expect(terminal.reason).toBe('end_turn');
            const calls = mockInferenceRequests as ModelStreamRequest[];
            expect(calls).toHaveLength(trigger === 'reactive' ? 2 : 1);
            const request = JSON.stringify(calls.at(-1)!.prompt.messages);
            expect(request).toContain('Compacted context');
            expect(request.match(/# Environment\\n/g)).toHaveLength(1);
            expect(request).toContain(
              JSON.stringify(`Primary working directory: ${child}`).slice(
                1,
                -1,
              ),
            );
            const environmentEvents = events.filter(
              (event): event is Extract<Message, { type: 'attachment' }> =>
                event.type === 'attachment' &&
                event.attachment.type === 'environment',
            );
            // Retained messages are replayed; only a missing baseline creates a new full announcement.
            expect(
              environmentEvents.filter(
                (event) => ![...history, ...delta].includes(event),
              ),
            ).toHaveLength(trigger === 'auto retaining full baseline' ? 0 : 1);
          });
        },
      );
    });

    it('keeps the first environment with pending input through automatic compaction', async () => {
      const ctx = context();
      const compacted = [createUserMessage('Compacted context')];
      const compressionPipeline = {
        compress: vi.fn().mockResolvedValue({
          newHistory: compacted,
          info: {
            originalTokenCount: 100,
            newTokenCount: 10,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        }),
      };
      setStreamEvents('Done');
      mockFetch.mockResolvedValue(mockOkResponse());
      const { events, terminal } = await runWithCwdOverride(root, () =>
        drain(
          queryT({
            prompt: 'Current task',
            model: 'test-model',
            promptId: 'environment-pending-compact',
            messages: [createUserMessage('Legacy history without environment')],
            attachmentCtx: ctx,
            config: ctx.config,
            compressionPipeline: compressionPipeline as never,
          }),
        ),
      );
      expect(terminal.reason).toBe('end_turn');
      const [compressible, options] =
        compressionPipeline.compress.mock.calls[0];
      expect(JSON.stringify(compressible)).not.toContain('"environment"');
      expect(options.pendingTurnForThreshold).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'attachment',
            attachment: expect.objectContaining({ type: 'environment' }),
          }),
        ]),
      );
      const request = JSON.stringify(
        (mockInferenceRequests[0] as ModelStreamRequest).prompt.messages,
      );
      expect(request).toContain('Compacted context');
      expect(request.match(/# Environment\\n/g)).toHaveLength(1);
      expect(
        events.filter(
          (event) =>
            event.type === 'attachment' &&
            event.attachment.type === 'environment',
        ),
      ).toHaveLength(1);
    });

    it.each([root, child])(
      'uses the inherited fork baseline with cwd=%s',
      async (cwd) => {
        const ctx = context(true);
        const history = await baseline(ctx);
        const prefix = buildForkContextMessages(history);
        const onCacheSafeSnapshot = vi.fn();
        setStreamEvents('Fork done');
        mockFetch.mockResolvedValue(mockOkResponse());
        const { events, terminal } = await runWithCwdOverride(cwd, () =>
          drain(
            queryT({
              prompt: 'Continue in fork',
              model: 'test-model',
              promptId: 'environment-fork',
              messages: history,
              preProjectedMessages: prefix,
              attachmentCtx: ctx,
              config: ctx.config,
              isSubagent: true,
              onCacheSafeSnapshot,
            }),
          ),
        );
        expect(terminal.reason).toBe('end_turn');
        const request = (mockInferenceRequests[0] as ModelStreamRequest).prompt
          .messages;
        expect(request.slice(0, prefix.length)).toEqual(prefix);
        expect(JSON.stringify(request).match(/# Environment\\n/g)).toHaveLength(
          1,
        );
        const updates = events.filter(
          (event) =>
            event.type === 'attachment' &&
            event.attachment.type === 'environment',
        );
        expect(updates).toHaveLength(cwd === root ? 0 : 1);
        expect(
          onCacheSafeSnapshot.mock.calls[0][0].contextAttachmentMessages,
        ).toEqual([
          ...history,
          ...events.filter(
            (event) =>
              event.type === 'attachment' && isContextAttachmentMessage(event),
          ),
        ]);
      },
    );

    it('retries an uncommitted initial environment after consumer cancellation', async () => {
      const ctx = context();
      const options = {
        prompt: 'Continue',
        model: 'test-model',
        promptId: 'environment-cancelled',
        attachmentCtx: ctx,
        config: ctx.config,
      };
      await runWithCwdOverride(root, async () => {
        const generator = queryT(options);
        let result = await generator.next();
        while (
          !result.done &&
          !(
            result.value.type === 'attachment' &&
            result.value.attachment.type === 'environment'
          )
        ) {
          result = await generator.next();
        }
        expect(result.done).toBe(false);
        await generator.return(undefined as never);
        expect(mockInferenceRequests).toHaveLength(0);
        setStreamEvents('Retried');
        mockFetch.mockResolvedValue(mockOkResponse());
        const { terminal } = await drain(queryT(options));
        expect(terminal.reason).toBe('end_turn');
        const request = JSON.stringify(
          (mockInferenceRequests[0] as ModelStreamRequest).prompt.messages,
        );
        expect(request.match(/# Environment\\n/g)).toHaveLength(1);
      });
    });
  });

  describe('inter-turn attachments', () => {
    it('announces environment changes through attachments before the next model request', async () => {
      const { getAttachmentMessages } = await import(
        '../attachments/get-attachments.js'
      );
      const { runWithCwdOverride, setCwd, getCwd } = await import(
        '../utils/Shell.js'
      );
      const path = await import('node:path');
      const root = path.resolve('/environment-test/project');
      const child = path.join(root, 'packages', 'core');
      await runWithCwdOverride(root, async () => {
        const ctx = createAttachmentContext(root);
        ctx.config = {
          getTargetDir: () => root,
          getWorkingDir: () => root,
          getWorkspaceContext: () => ({ getDirectories: () => [root] }),
          getGoalManager: () => undefined,
          getSkillListingMaxDescChars: () => 80,
          getSkillListingBudgetFraction: () => 0.1,
          getSkillVisibilityOverrides: () => undefined,
          getSkillManager: () => ({ getModelVisibleSkills: () => [] }),
        } as unknown as Config;
        const initial = await getAttachmentMessages(
          'start',
          ctx,
          [],
          null,
          { skipSkillDiscovery: true },
          undefined,
          undefined,
          [],
        );
        mockStreamTurns.push(
          makeToolUseStreamEvents('change-directory', 'Bash', {
            command: 'cd packages/core',
          }),
          makeToolUseStreamEvents('read-directory', 'Bash', { command: 'pwd' }),
          makeTextStreamEvents('done'),
        );
        mockFetch.mockResolvedValue(mockOkResponse());
        const bridge = createMockToolBridge(async (blocks) => {
          if (blocks[0].id === 'change-directory') setCwd(child);
          return {
            toolResults: blocks.map((block) => ({
              type: 'tool_result' as const,
              tool_use_id: block.id,
              content: getCwd(),
              is_error: false,
            })),
            allMessages: [],
          };
        });
        const { events, terminal } = await drain(
          queryT({
            prompt: 'Change directory then print it',
            model: 'test-model',
            promptId: 'environment-update',
            toolBridge: bridge,
            attachmentCtx: ctx,
            config: ctx.config,
            messages: initial,
          }),
        );
        expect(terminal.reason).toBe('end_turn');
        expect(getCwd()).toBe(child);
        expect(
          events.filter(
            (event) =>
              event.type === 'attachment' &&
              event.attachment.type === 'environment',
          ),
        ).toHaveLength(1);
        const requests = mockInferenceRequests as ModelStreamRequest[];
        expect(requests).toHaveLength(3);
        expect(JSON.stringify(requests[0].prompt.messages)).not.toContain(
          '# Environment update',
        );
        for (const request of requests.slice(1)) {
          const content = JSON.stringify(request.prompt.messages);
          expect(content).toContain(
            JSON.stringify(
              `Primary working directory: ${child} (was ${root})`,
            ).slice(1, -1),
          );
          expect(content.match(/# Environment update/g)).toHaveLength(1);
        }
      });
    });

    it.each([
      { mode: 'CodeMode on', codeMode: 'on', registration: 'deferred' },
      { mode: 'CodeMode only', codeMode: 'only', registration: 'deferred' },
      { mode: 'MCP meta tools', codeMode: undefined, registration: 'lazy' },
      {
        mode: 'eager MCP without registries',
        codeMode: undefined,
        registration: 'eager',
      },
    ] as const)(
      'updates MCP reminders in the next request after discovery changes: $mode',
      async ({ codeMode, registration }) => {
        const deferred = registration !== 'eager';
        const mcpManager = {
          connected: false,
          toolNames: [] as string[],
          peekRegistrationMode: () => registration,
          getConnectedServerInstructions() {
            return this.connected
              ? [
                  {
                    serverName: 'docs',
                    instructions: 'Read documents using IDs.',
                  },
                ]
              : [];
          },
          getLazyMcpServerSnapshot() {
            return deferred && this.connected
              ? [{ serverName: 'docs', toolNames: this.toolNames }]
              : [];
          },
        };
        const registry = deferred
          ? {
              hasToolEnabled: () => false,
              getTool: () => undefined,
              getCodeModeExposure: () => codeMode,
            }
          : undefined;
        const config = {
          getMcpClientManager: () => mcpManager,
          getSkillManager: () => ({ getModelVisibleSkills: () => [] }),
          // The active agent's discovery instructions must win over the parent view.
          getToolRegistry: () =>
            registry && {
              ...registry,
              getCodeModeExposure: () => 'on',
            },
          isWorkflowsEnabled: () => false,
          isTasksEnabled: () => false,
          getSkillListingMaxDescChars: () => 80,
          getSkillListingBudgetFraction: () => 0.1,
          getSkillVisibilityOverrides: () => undefined,
        } as unknown as Config;
        for (let round = 0; round < 4; round++) {
          mockStreamTurns.push(
            makeToolUseStreamEvents(`read-${round}`, READ_FILE_TOOL_NAME, {
              file_path: '/test.ts',
            }),
          );
        }
        mockStreamTurns.push(makeTextStreamEvents('Done.'));
        mockFetch.mockResolvedValue(mockOkResponse());
        let round = 0;
        const bridge = createMockToolBridge(async (blocks) => {
          round++;
          if (round === 1) {
            mcpManager.connected = true;
            mcpManager.toolNames = ['mcp__docs__read'];
          } else if (round === 2) {
            mcpManager.toolNames = ['mcp__docs__read', 'mcp__docs__search'];
          } else if (round === 4) {
            mcpManager.connected = false;
            mcpManager.toolNames = [];
          }
          return {
            toolResults: blocks.map((block) => ({
              type: 'tool_result' as const,
              tool_use_id: block.id,
              content: 'File read.',
              is_error: false,
            })),
            allMessages: [],
          };
        });
        const { events, terminal } = await drain(
          queryT({
            prompt: 'Read files while MCP discovery changes.',
            model: 'test-model',
            promptId: 'inter-turn-mcp-discovery',
            toolBridge: bridge,
            attachmentCtx: createAttachmentContext('/workspace/project'),
            attachmentToolRegistry: registry as ToolRegistry | undefined,
            config,
            workdirs: [],
          }),
        );
        expect(terminal.error).toBeUndefined();
        expect(terminal.reason).toBe('end_turn');
        const catalogs = events.flatMap((event) =>
          event.type === 'attachment' &&
          event.attachment.type === 'mcp_lazy_tools_delta'
            ? [event.attachment]
            : [],
        );
        expect(catalogs).toHaveLength(deferred ? 3 : 0);
        const instructions = events.flatMap((event) =>
          event.type === 'attachment' &&
          event.attachment.type === 'mcp_instructions_delta'
            ? [event.attachment]
            : [],
        );
        expect(instructions).toMatchObject([
          { addedNames: ['docs'], removedNames: [] },
          { addedNames: [], removedNames: ['docs'] },
        ]);
        const requests = mockInferenceRequests.map((request) =>
          JSON.stringify((request as ModelStreamRequest).prompt.messages),
        );
        expect(requests).toHaveLength(5);
        expect(requests[0]).not.toContain('Read documents using IDs.');
        expect(requests[1]).toContain('Read documents using IDs.');
        expect(requests[3]).not.toContain(
          'Their instructions above no longer apply',
        );
        expect(requests[4]).toContain(
          'Their instructions above no longer apply',
        );

        if (!deferred) {
          expect(requests[4]).not.toContain('MCP tool catalog');
          return;
        }
        expect(catalogs).toMatchObject([
          {
            isInitial: true,
            addedNames: ['mcp__docs__read'],
            removedNames: [],
          },
          {
            isInitial: false,
            addedNames: ['mcp__docs__search'],
            removedNames: [],
          },
          {
            isInitial: false,
            addedNames: [],
            removedNames: ['mcp__docs__read', 'mcp__docs__search'],
          },
        ]);
        expect(requests[0]).not.toContain('mcp__docs__read');
        expect(requests[1]).toContain('mcp__docs__read');
        expect(requests[1]).not.toContain('mcp__docs__search');
        expect(requests[1]).toContain(codeMode ? 'searchTools' : 'mcp_list');
        expect(requests[1]).not.toContain(
          codeMode ? 'mcp_list' : 'searchTools',
        );
        expect(requests[2]).toContain('mcp__docs__search');
        expect(requests[3].match(/Some MCP tools are deferred/g)).toHaveLength(
          1,
        );
        expect(requests[3].match(/MCP tool catalog update/g)).toHaveLength(1);
        expect(requests[4].match(/MCP tool catalog update/g)).toHaveLength(2);
        expect(requests[4]).toContain('No MCP servers are connected right now');
      },
    );

    it('does not expose the parent task list when TaskUpdate is absent from the subagent tool set', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents(
          'read-without-task-update',
          READ_FILE_TOOL_NAME,
          {
            file_path: '/workspace/project/file.ts',
          },
        ),
        makeTextStreamEvents('Subagent work completed.'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const messages = Array.from({ length: 10 }, (_, index) => [
        createUserMessage(`Previous request ${index}`),
        createAssistantMessage({
          messageId: `previous-response-${index}`,

          blocks: [
            {
              type: 'text',
              text: `Previous response ${index}`,
            },
          ],

          model: 'test-model',
          stopReason: 'end_turn',

          usage: ((value) => ({
            inputTokens: value.input_tokens,
            outputTokens: value.output_tokens,
            cacheReadInputTokens: value.cache_read_input_tokens,
            cacheCreationInputTokens: value.cache_creation_input_tokens,
          }))(cloneUsage()),
        }),
      ]).flat();
      const listTasks = vi.fn().mockResolvedValue([
        {
          id: 'parent-task',
          subject: 'Parent task',
          description: 'Must not be injected into this subagent.',
          status: 'in_progress',
          blocks: [],
          blockedBy: [],
        },
      ]);
      const config = {
        getMemoryContextManager: () => undefined,
        getSkillManager: () => ({ getModelVisibleSkills: () => [] }),
        // The process-wide registry represents the parent session and includes
        // TaskUpdate. The subagent's model-visible bridge below does not.
        getToolRegistry: () => ({
          hasToolEnabled: (toolName: string) =>
            toolName === TASK_UPDATE_TOOL_NAME,
          getTool: () => undefined,
        }),
        isWorkflowsEnabled: () => false,
        isTasksEnabled: () => true,
        getTaskStore: () => ({ listTasks }),
        getSkillListingMaxDescChars: () => 80,
        getSkillListingBudgetFraction: () => 0.1,
        getSkillVisibilityOverrides: () => undefined,
      } as unknown as Config;
      const bridge = createMockToolBridge(
        async (blocks) => ({
          toolResults: blocks.map((block) => ({
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'File read.',
            is_error: false,
          })),
          allMessages: [],
        }),
        [TEST_TOOL_SCHEMA],
      );

      const { events, terminal } = await drain(
        queryT({
          prompt: 'Inspect the repository as a subagent.',
          model: 'test-model',
          promptId: 'pid-subagent-task-reminder-capability',
          sessionId: 'subagent-task-reminder-capability-session',
          messages,
          toolBridge: bridge,
          attachmentCtx: createAttachmentContext(
            '/workspace/project',
            'task-reminder-subagent',
            { isMainAgent: false },
          ),
          config,
          workdirs: [],
          isSubagent: true,
          agentId: 'task-reminder-subagent',
        }),
      );

      expect(terminal.reason).toBe('end_turn');
      expect(listTasks).not.toHaveBeenCalled();
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: 'attachment',
          attachment: expect.objectContaining({ type: 'task_reminder' }),
        }),
      );
    });

    it('injects the full plan reminder after a tool round when plan mode was just entered', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tu-plan-entry', READ_FILE_TOOL_NAME, {
          file_path: '/test.ts',
        }),
        makeTextStreamEvents('Plan reminder received.'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const attachmentCtx = createAttachmentContext('/workspace/project');
      attachmentCtx.planModeJustEntered = true;
      attachmentCtx.currentPlanFilePath = '/workspace/plans/session-plan.md';
      const planStateManager = {
        get isActive() {
          return true;
        },
      } as Config['planStateManager'];
      const config = {
        planStateManager,
        getMemoryContextManager: () => undefined,
        getSkillManager: () => ({ getModelVisibleSkills: () => [] }),
        getToolRegistry: () => ({
          hasToolEnabled: () => false,
          getTool: () => undefined,
        }),
        isWorkflowsEnabled: () => false,
        isTasksEnabled: () => false,
        getSkillListingMaxDescChars: () => 80,
        getSkillListingBudgetFraction: () => 0.1,
        getSkillVisibilityOverrides: () => undefined,
      } as unknown as Config;

      const { events } = await drain(
        queryT({
          prompt: 'Enter plan mode and inspect the repository.',
          model: 'test-model',
          promptId: 'pid-plan-interturn',
          sessionId: 'plan-interturn-session',
          toolBridge: createMockToolBridge(),
          attachmentCtx,
          config,
          workdirs: [],
        }),
      );

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'attachment',
          attachment: expect.objectContaining({
            type: 'plan_mode',
            reminderType: 'full',
            isActive: true,
            planFilePath: '/workspace/plans/session-plan.md',
          }),
        }),
      );
    });

    it('does not inject the parent plan reminder into a subagent tool round', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tu-subagent-plan', READ_FILE_TOOL_NAME, {
          file_path: '/test.ts',
        }),
        makeTextStreamEvents('Subagent work completed.'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const attachmentCtx = createAttachmentContext(
        '/workspace/project',
        'plan-subagent',
        { isMainAgent: false },
      );
      attachmentCtx.planModeJustEntered = true;
      attachmentCtx.currentPlanFilePath = '/workspace/plans/parent-plan.md';
      const planStateManager = {
        get isActive() {
          return true;
        },
      } as Config['planStateManager'];
      const config = {
        planStateManager,
        getMemoryContextManager: () => undefined,
        getSkillManager: () => ({ getModelVisibleSkills: () => [] }),
        getToolRegistry: () => ({
          hasToolEnabled: () => false,
          getTool: () => undefined,
        }),
        isWorkflowsEnabled: () => false,
        isTasksEnabled: () => false,
        getSkillListingMaxDescChars: () => 80,
        getSkillListingBudgetFraction: () => 0.1,
        getSkillVisibilityOverrides: () => undefined,
      } as unknown as Config;

      const { events } = await drain(
        queryT({
          prompt: 'Inspect the repository as a subagent.',
          model: 'test-model',
          promptId: 'pid-subagent-plan-interturn',
          sessionId: 'subagent-plan-interturn-session',
          toolBridge: createMockToolBridge(),
          attachmentCtx,
          config,
          workdirs: [],
          isSubagent: true,
          agentId: 'plan-subagent',
        }),
      );

      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: 'attachment',
          attachment: expect.objectContaining({
            type: 'plan_mode',
          }),
        }),
      );
    });
  });

  // ========================================================================
  // Streaming execution path
  // ========================================================================

  describe('streaming execution path', () => {
    it.each([
      ['eager', false],
      ['eager', true],
      ['lazy', false],
      ['lazy', true],
    ] as const)(
      'retains captured MCP names after %s discovery disappears (interrupted=%s)',
      async (mode, interrupted) => {
        const qualifiedName = 'mcp__demo__u_611aec98eddc';
        const name = mode === 'lazy' ? 'mcp_call' : qualifiedName;
        const input =
          mode === 'lazy'
            ? { toolName: qualifiedName, arguments: { id: 'demo-001' } }
            : { id: 'demo-001' };
        const mcpInfo = {
          serverName: '转换服务',
          toolName: '文档格式转换_查询',
        };
        let connected = true;
        const config = {
          getTargetDir: () => process.cwd(),
          getWorkspaceContext: () => ({ getDirectories: () => [] }),
          getToolRegistry: () => ({
            getTool: () => (connected ? { mcpInfo } : undefined),
          }),
          getMcpClientManager: () => ({
            peekLazyMode: () => mode === 'lazy',
            peekRegistrationMode: () => mode,
            getLazyDiscoveredMcpToolByQualifiedName: () =>
              connected ? mcpInfo : undefined,
          }),
        } as unknown as Config;
        const streamEvents = makeToolUseStreamEvents(
          'mcp-disconnect',
          name,
          input,
        );
        mockStreamTurns.push(
          [
            DRAIN_RESPONSE_BODY,
            ...(interrupted
              ? [
                  ...streamEvents.slice(0, -2),
                  new Error('Qoder API error: NOT_ACCEPTABLE'),
                ]
              : streamEvents),
          ],
          makeTextStreamEvents('Done'),
        );
        mockFetch.mockResolvedValue(sseResponse(VISIBLE_CONTENT_SSE_CHUNK));
        const toolBridge = createMockStreamingToolBridge(async (tools) => ({
          toolResults: tools.map((tool) => ({
            type: 'tool_result',
            tool_use_id: tool.id,
            content: 'completed',
            is_error: false,
          })),
          allMessages: [],
        }));
        const gen = queryT({
          prompt: 'Query',
          model: 'test-model',
          promptId: 'mcp-disconnect',
          querySource: 'sdk',
          config,
          toolBridge,
          workdirs: [],
        });
        const events: QueryEvent[] = [];
        let captured = false;
        for (;;) {
          const step = await gen.next();
          if (step.done) {
            if (!interrupted) expect(step.value.error).toBeUndefined();
            expect(step.value).toMatchObject({
              reason: interrupted ? 'error' : 'end_turn',
            });
            break;
          }
          events.push(step.value);
          if (step.value.type === 'assistant_block') {
            const block = step.value.message.blocks[0];
            if (block?.type === 'tool_use') {
              expect(step.value.mcpToolIdentities).toEqual({
                [block.id]: mcpInfo,
              });
              captured = true;
              connected = false;
            }
          }
        }
        expect(captured).toBe(true);
        const persistedCalls = events
          .filter(isRuntimeAssistantEvent)
          .flatMap((event) => event.message.content)
          .filter((block) => block.type === 'tool_use');
        expect(persistedCalls).toEqual([
          { type: 'tool_use', id: 'mcp-disconnect', name, input, mcpInfo },
        ]);
      },
    );

    it('publishes the current request blocks and schemas before streaming tools execute', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tu_fork_snapshot', READ_FILE_TOOL_NAME, {
          file_path: '/test.ts',
        }),
        makeTextStreamEvents('Done'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());
      const blocks = [
        { type: 'text' as const, text: 'stable prompt' },
        { type: 'text' as const, text: 'dynamic prompt' },
      ];
      const onCacheSafeSnapshot = vi.fn();
      const toolBridge = createMockStreamingToolBridge(async (tools) => {
        const snapshot = onCacheSafeSnapshot.mock.calls.at(-1)?.[0];
        expect(snapshot).toMatchObject({
          systemPrompt: blocks,
          model: 'test-model',
          toolSchemas: toolBridge.getToolSchema('test-model'),
        });
        expect(snapshot.forkContextMessages.at(-1)).toMatchObject({
          role: 'user',
        });
        expect(JSON.stringify(snapshot.forkContextMessages)).toContain(
          'Fork this request',
        );
        return {
          toolResults: tools.map((tool) => ({
            type: 'tool_result' as const,
            tool_use_id: tool.id,
            content: 'Done',
            is_error: false,
          })),
          allMessages: [],
        };
      });
      const execute = toolBridge.execute;
      toolBridge.execute = vi.fn((block, ctx) => {
        const snapshot = onCacheSafeSnapshot.mock.calls.at(-1)?.[0];
        expect(snapshot?.systemPrompt).toEqual(blocks);
        expect(snapshot?.lastAssistantUsage).toBeUndefined();
        return execute(block, ctx);
      });
      const { terminal } = await drain(
        queryT({
          prompt: 'Fork this request',
          model: 'test-model',
          promptId: 'streaming-fork-snapshot',
          resolveSystemPrompt: async () => ({
            blocks,
            source: 'default',
            bundle: 'full',
          }),
          onCacheSafeSnapshot,
          toolBridge,
        }),
      );
      expect(terminal.reason).toBe('end_turn');
      expect(toolBridge.execute).toHaveBeenCalledTimes(1);
      const completed = onCacheSafeSnapshot.mock.calls.at(-1)?.[0];
      expect(completed.forkContextMessages.at(-1)).toMatchObject({
        role: 'assistant',
      });
      expect(completed.lastAssistantUsage).toBeDefined();
    });

    it('should use execute when available and canUseTool is not set', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tu_s1', READ_FILE_TOOL_NAME, {
          file_path: '/test.ts',
        }),
        makeTextStreamEvents('Done'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const toolBridge = createMockStreamingToolBridge(async (blocks) => ({
        toolResults: blocks.map((b) => ({
          type: 'tool_result' as const,
          tool_use_id: b.id,
          content: 'streaming file content',
          is_error: false,
        })),
        allMessages: [],
      }));

      const gen = queryT({
        prompt: 'Read file',
        model: 'test-model',
        promptId: 'pid-streaming-1',
        toolBridge,
      });

      const { events, terminal } = await drain(gen);

      expect(toolBridge.execute).toHaveBeenCalledTimes(1);
      expect(terminal.reason).toBe('end_turn');
      expect(terminal.numTurns).toBe(2);

      // Verify tool_result was passed through correctly
      const toolResult = events.find(isRuntimeToolResultEvent);
      expect(toolResult).toBeDefined();
      if (toolResult) {
        const resultBlocks = getToolResultBlocks(toolResult);
        expect(resultBlocks[0]?.content).toBe('streaming file content');
      }
    });

    it('should handle streaming execution error gracefully', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tu_err_s', READ_FILE_TOOL_NAME, {}),
        makeTextStreamEvents('Recovered'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const toolBridge = createMockToolBridge(async () => ({
        toolResults: [],
        allMessages: [],
      }));
      toolBridge.execute = vi.fn(async () => {
        throw new Error('Streaming failed');
      });

      const gen = queryT({
        prompt: 'Read file',
        model: 'test-model',
        promptId: 'pid-streaming-err',
        toolBridge,
      });

      const { events, terminal } = await drain(gen);

      // Should recover with error tool_result
      const toolResult = events.find(isRuntimeToolResultEvent);
      expect(toolResult).toBeDefined();
      if (toolResult) {
        const resultBlocks = getToolResultBlocks(toolResult);
        expect(resultBlocks[0]?.is_error).toBe(true);
        expect(String(resultBlocks[0]?.content)).toContain('Streaming failed');
      }
      expect(terminal.reason).toBe('end_turn');
    });

    it('marks a streaming bridge cancellation as interrupted', async () => {
      mockStreamTurns.push(
        makeToolUseStreamEvents('tu_cancel_s', READ_FILE_TOOL_NAME, {}),
        makeTextStreamEvents('Recovered'),
      );
      mockFetch.mockResolvedValue(mockOkResponse());

      const toolBridge = createMockToolBridge(async () => ({
        toolResults: [],
        allMessages: [],
      }));
      toolBridge.execute = vi.fn(async () => {
        const error = new Error('Streaming cancelled');
        error.name = 'AbortError';
        throw error;
      });

      const { events } = await drain(
        queryT({
          prompt: 'Read file',
          model: 'test-model',
          promptId: 'pid-streaming-cancel',
          sessionId: 'sid-streaming-cancel',
          toolBridge,
        }),
      );

      const toolResultEvent = events.find(isRuntimeToolResultEvent);
      expect(toolResultEvent?.toolDenialKind).toBe('interrupted');
    });

    it('should handle multiple tool_use blocks in streaming path', async () => {
      // Create stream events with two tool_use blocks in the same turn
      const multiToolEvents = [
        {
          type: 'message_start',
          message: {
            id: 'msg_multi_tu',
            model: 'test-model',
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'tu_multi_1',
            name: READ_FILE_TOOL_NAME,
            input: {},
          },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({ file_path: '/a.ts' }),
          },
        },
        {
          type: 'content_block_stop',
          index: 0,
        },
        {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'tool_use',
            id: 'tu_multi_2',
            name: 'grep',
            input: {},
          },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({ pattern: 'foo' }),
          },
        },
        {
          type: 'content_block_stop',
          index: 1,
        },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 10 },
        },
        {
          type: 'message_stop',
        },
      ];

      mockStreamTurns.push(multiToolEvents, makeTextStreamEvents('All done'));
      mockFetch.mockResolvedValue(mockOkResponse());

      const receivedBlocks: ModelToolUseBlock[] = [];
      const toolBridge = createMockStreamingToolBridge(async (blocks) => {
        receivedBlocks.push(...blocks);
        return {
          toolResults: blocks.map((b) => ({
            type: 'tool_result' as const,
            tool_use_id: b.id,
            content: `result-${b.id}`,
            is_error: false,
          })),
          allMessages: [],
        };
      });

      const gen = queryT({
        prompt: 'Multi tool',
        model: 'test-model',
        promptId: 'pid-streaming-multi',
        toolBridge,
      });

      const { terminal } = await drain(gen);

      expect(toolBridge.execute).toHaveBeenCalledTimes(2);
      expect(receivedBlocks).toHaveLength(2);
      expect(receivedBlocks[0].id).toBe('tu_multi_1');
      expect(receivedBlocks[1].id).toBe('tu_multi_2');
      expect(terminal.reason).toBe('end_turn');
    });
  });
  describe('v3 stream recovery', () => {
    function isUndeliveredToolResult(
      block: Extract<ContentBlockParam, { type: 'tool_result' }>,
    ): boolean {
      return (
        block.content === UNDELIVERED_TOOL_NOT_DISPATCHED_RESULT ||
        block.content === UNDELIVERED_TOOL_INCOMPLETE_ARGUMENTS_RESULT
      );
    }
    function undeliveredToolResults(events: QueryEvent[]) {
      return events
        .filter(isRuntimeToolResultEvent)
        .flatMap(getToolResultBlocks)
        .filter(isUndeliveredToolResult);
    }
    function findAssistantWithToolUse(events: QueryEvent[], toolUseId: string) {
      return events.find(
        (e) =>
          e.type === 'assistant' &&
          e.message.content.some(
            (b) => b.type === 'tool_use' && b.id === toolUseId,
          ),
      ) as Extract<QueryEvent, { type: 'assistant' }> | undefined;
    }
    function bridgeWithEvidence(evidence: 'completed' | 'unknown') {
      return createMockStreamingToolBridge(async (blocks) => ({
        toolResults: blocks.map((block) => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'written once',
          is_error: false,
        })),
        allMessages: [],
        settlement: new Map(blocks.map((block) => [block.id, evidence])),
      }));
    }
    function options(toolBridge?: MockToolBridge) {
      return {
        prompt: 'write',
        model: 'test-model',
        promptId: 'v3',
        sessionId: 'v3',
        messages: [],
        toolBridge,
      };
    }

    it('gives the placeholder a local id when the interrupted response has none', async () => {
      const withoutMessageId = makeToolUseStreamEvents('a', 'Write', {
        path: 'a',
      })
        .slice(0, 4)
        .map((event) => {
          const e = event as { type: string; message?: { id: string } };
          return e.type === 'message_start'
            ? { ...e, message: { ...e.message, id: '' } }
            : event;
        });
      mockStreamTurns.push(
        [
          DRAIN_RESPONSE_BODY,
          ...withoutMessageId,
          {
            type: 'content_block_start',
            index: 1,
            content_block: {
              type: 'tool_use',
              id: 'unfinished',
              name: 'Write',
              input: {},
            },
          },
          new ModelInferenceError('other side closed', {
            kind: 'network',
            phase: 'after_output',
            cause: makeSocketCloseError(),
          }),
        ],
        makeTextStreamEvents('done'),
      );
      mockFetch.mockImplementation(async () =>
        sseResponse(VISIBLE_CONTENT_SSE_CHUNK),
      );
      const { events, terminal } = await drain(
        queryT(options(bridgeWithEvidence('completed'))),
      );
      expect(terminal.reason).toBe('end_turn');
      const retained = findAssistantWithToolUse(events, 'a');
      const placeholder = findAssistantWithToolUse(events, 'unfinished');
      expect(retained?.message.id).toBe('');
      expect(placeholder?.message.id).toMatch(/^recovery_/);
      expect(retained?.responseGroupId).toEqual(expect.any(String));
      expect(placeholder?.responseGroupId).toBe(retained?.responseGroupId);
      expect(placeholder?.uuid).not.toBe(retained?.uuid);
    });

    it('does not pair a tool fragment that lacks an identity', async () => {
      mockStreamTurns.push(
        [
          DRAIN_RESPONSE_BODY,
          ...makeToolUseStreamEvents('a', 'Write', { path: 'a' }).slice(0, 4),
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: '', name: '', input: {} },
          },
          new ModelInferenceError('other side closed', {
            kind: 'network',
            phase: 'after_output',
            cause: makeSocketCloseError(),
          }),
        ],
        makeTextStreamEvents('done'),
      );
      mockFetch.mockImplementation(async () =>
        sseResponse(VISIBLE_CONTENT_SSE_CHUNK),
      );
      const { events, terminal } = await drain(
        queryT(options(bridgeWithEvidence('completed'))),
      );
      expect(terminal.reason).toBe('end_turn');
      expect(undeliveredToolResults(events)).toEqual([]);
      const history = lastRequestHistory();
      expect(history).not.toContain('"id":""');
    });
  });
});
