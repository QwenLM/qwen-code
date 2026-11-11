/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ACP 会话的 `ThreadHost` 适配器与会话级协议状态。
 *
 * 会话生命周期、ACP 方法路由、认证与存储都在 `AcpServer`；本文件只做两件事：
 * `ThreadEvent` → ACP `session/update`，以及 ACP 反向请求 → `ThreadHostRequests`。
 * 与 `sdk/handlers/session/sessionHost.ts` 同层，不持有会话实现。
 */

import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import {
  BRAND_PROTOCOL_NAMESPACE,
  ASK_USER_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  ROOT_TOOL_CALL_SCOPE_ID,
  TASK_MUTATION_TOOL_NAMES,
  ToolConfirmationOutcome,
  WRITE_TODOS_TOOL_NAME,
  getErrorMessage,
  getErrorStatus,
  isAbortError,
  isInternalTask,
  normalizePermissionMode,
  rememberApproval,
  runLogger,
  type Config,
  type Message,
  type SerializableConfirmationDetails,
  type SDKMessage,
} from '@qwen-code/core';
import { z } from 'zod';
import { getAcpErrorMessage } from './acpErrors.js';
import {
  RequestPermissionResponseSchema,
  buildAcpPermissionContent,
  buildAskUserElicitationRequest,
  buildAskUserPayloadFromElicitation,
  buildAvailableModes,
  supportsFormElicitation,
  toAcpAvailableCommand,
  toPermissionOptions,
  type AcpModelAdapter,
} from './acpSupport.js';
import {
  isCommandAvailableInAcp,
  toAcpSupportedCommand,
  type AcpSupportedCommand,
} from './commandAvailability.js';
import { replayAcpHistory } from './acpHistory.js';
import { todosToPlanEntries } from './planProjection.js';
import { projectToolCall, toAcpToolKind } from './toolProjection.js';
import { AcpToolCallPublisher } from './toolCallPublisher.js';
import { createNonInteractiveCommandService } from '../nonInteractiveCliCommands.js';
import type {
  ThreadCallContext,
  ThreadCanUseToolHandler,
  ThreadEvent,
  ThreadHost,
  ThreadHostRequests,
  ThreadNotice,
  ThreadReverseRequestOptions,
} from '../thread-manager/thread-session/contract/hostContext.js';

export type AcpPendingCommand = {
  readonly uuid: string;
  readonly resolve: (response: acp.PromptResponse) => void;
  readonly reject: (error: unknown) => void;
  /** 内部续跑轮（任务通知、goal kickoff 等）没有 `session/prompt` 在等回包。 */
  readonly background: boolean;
  readonly commandText: string | undefined;
  usageInputTokens: number;
  usageOutputTokens: number;
  usageCacheReadTokens: number;
  usageCacheCreationTokens: number;
  modelUsage: Map<
    string,
    { input: number; output: number; cacheRead: number; cacheCreation: number }
  >;
  result?: SDKMessage;
  recordedUserMessageId?: string;
  started: boolean;
  finalized: boolean;
  slashStateSynced: boolean;
};

export interface AcpSessionState {
  readonly sessionId: string;
  readonly cwd: string;
  readonly clientCapabilities: acp.ClientCapabilities | undefined;
  readonly mcpServers: readonly acp.McpServer[];
  readonly additionalDirectories: readonly string[];
  readonly abortController: AbortController;
  readonly modelAdapter: AcpModelAdapter;
  host: AcpSessionHost;
  callContext: ThreadCallContext;
  updateChain: Promise<void>;
  eventChain: Promise<void>;
  readonly pendingCommands: Map<string, AcpPendingCommand>;
  activeCommandUuid: string | undefined;
  toolPublisher: AcpToolCallPublisher | undefined;
  readonly toolCallNames: Map<string, string>;
  readonly permissionToolCallIds: Set<string>;
  modes: acp.SessionModeState;
  models: acp.SessionModelState;
  configOptions: acp.SessionConfigOption[];
  modelStateRevision: number;
  disposed: boolean;
  /** `session/new` / `session/load` 的回包发出后才向客户端推送增量通知。 */
  active: boolean;
}

export interface AcpPromptHandle {
  readonly promise: Promise<acp.PromptResponse>;
  fail(error: unknown): void;
}

export interface AcpSessionHost extends ThreadHost {
  beginPrompt(uuid: string, commandText: string | undefined): AcpPromptHandle;
  cancelPendingPrompts(): Promise<void>;
  dispose(): Promise<void>;
  replayHistory(messages: readonly Message[]): Promise<void>;
  sendAvailableCommands(): Promise<void>;
  sendDirectText(text: string): Promise<acp.PromptResponse>;
}

export interface CreateAcpSessionHostParams {
  readonly sessionId: string;
  readonly cwd: string;
  readonly clientCapabilities: acp.ClientCapabilities | undefined;
  readonly mcpServers: readonly acp.McpServer[];
  readonly additionalDirectories: readonly string[];
  readonly modelAdapter: AcpModelAdapter;
  readonly connection: acp.AgentSideConnection;
  readonly ensureAuthReady: () => Promise<void>;
  readonly prepareInference?: ThreadHostRequests['prepareInference'];
  readonly resolveConfig: (sessionId: string) => Config;
  readonly setModeForExitPlan: (
    sessionId: string,
    modeId: string,
  ) => Promise<void>;
}

export function createAcpSessionHost(params: CreateAcpSessionHostParams): {
  state: AcpSessionState;
  host: AcpSessionHost;
} {
  const state: AcpSessionState = {
    sessionId: params.sessionId,
    cwd: params.cwd,
    clientCapabilities: params.clientCapabilities,
    mcpServers: params.mcpServers,
    additionalDirectories: params.additionalDirectories,
    abortController: new AbortController(),
    modelAdapter: params.modelAdapter,
    host: undefined as unknown as AcpSessionHost,
    callContext: undefined as unknown as ThreadCallContext,
    updateChain: Promise.resolve(),
    eventChain: Promise.resolve(),
    pendingCommands: new Map(),
    activeCommandUuid: undefined,
    toolPublisher: undefined,
    toolCallNames: new Map(),
    permissionToolCallIds: new Set(),
    modes: { availableModes: buildAvailableModes(), currentModeId: 'default' },
    models: { availableModels: [], currentModelId: 'auto' },
    configOptions: [],
    modelStateRevision: 0,
    disposed: false,
    active: false,
  };

  const config = (): Config => params.resolveConfig(state.sessionId);

  async function sendUpdate(update: acp.SessionUpdate): Promise<void> {
    await sendSessionUpdate(state, params.connection, update);
  }

  async function sendPlanUpdate(input: unknown): Promise<void> {
    const entries = todosToPlanEntries(input);
    if (!entries) {
      return;
    }
    await sendUpdate({ sessionUpdate: 'plan', entries });
  }

  function enqueueEvent(event: ThreadEvent): void {
    state.eventChain = state.eventChain
      .then(() => handleEvent(event))
      .catch((error: unknown) => {
        runLogger.warn('[acp] session event projection failed', {
          sessionId: state.sessionId,
          kind: event.kind,
          error: getErrorMessage(error),
        });
      });
  }

  async function handleEvent(event: ThreadEvent): Promise<void> {
    switch (event.kind) {
      case 'threadMessage':
        await handleThreadMessage(event.message);
        return;
      case 'commandLifecycle':
        await handleCommandLifecycle(event.commandUuid, event.state);
        return;
      case 'notice':
        await handleNotice(event.notice);
        return;
      case 'turnFailed': {
        const pending = activePendingCommand();
        if (pending?.background) {
          await finishBackgroundTurn(pending);
        } else if (pending) {
          await rejectPending(pending, event.error);
        }
        return;
      }
      case 'messageReplay': {
        const pending = state.pendingCommands.get(event.commandUuid);
        if (pending) {
          pending.recordedUserMessageId = event.commandUuid;
          return;
        }
        // 合成消息的回显是内部续跑轮唯一的开始信号：会话在模型调用前发出它，
        // 该轮随后产出的帧同样要投影给客户端，否则子代理完成后外部客户端会停摆。
        const inbound = event.message as { isSynthetic?: boolean } | undefined;
        if (inbound?.isSynthetic === true) {
          startBackgroundTurn(event.commandUuid);
        }
        return;
      }
      case 'sessionSnapshot':
      case 'transcriptMirror':
        return;
      default:
        return;
    }
  }

  async function handleCommandLifecycle(
    commandUuid: string,
    lifecycle: 'queued' | 'started' | 'completed' | 'cancelled' | 'discarded',
  ): Promise<void> {
    const pending = state.pendingCommands.get(commandUuid);
    if (!pending) {
      return;
    }
    if (lifecycle === 'started') {
      state.activeCommandUuid = commandUuid;
      pending.started = true;
      state.toolPublisher = new AcpToolCallPublisher(
        config().toolCallSnapshots,
        ROOT_TOOL_CALL_SCOPE_ID,
        commandUuid,
        supportsTerminalOutput(),
        (update) => sendUpdate(update),
      );
      return;
    }
    if (lifecycle === 'completed') {
      await completePending(pending);
      return;
    }
    if (lifecycle === 'cancelled' || lifecycle === 'discarded') {
      await resolveCancelled(pending);
    }
  }

  async function handleThreadMessage(message: SDKMessage): Promise<void> {
    const pending = activePendingCommand();
    if (!pending) {
      return;
    }

    if (message.type === 'stream_event') {
      await dispatchStreamEvent(message);
    } else if (message.type === 'assistant') {
      await dispatchAssistant(message, pending);
    } else if (message.type === 'user') {
      await dispatchUser(message);
    } else if (message.type === 'result') {
      pending.result = message;
      try {
        await dispatchResultOutput(message, pending);
      } finally {
        if (pending.background) {
          await finishBackgroundTurn(pending);
        }
      }
    }
  }

  /**
   * 内部续跑轮没有 `session/prompt` 在等回包，但它的帧属于同一条 ACP 会话流。
   * 用合成消息回显的 uuid 建一个只投影、不 resolve 的归属，子代理完成/目标 kickoff
   * 等后续轮次才能继续以 `session/update` 到达客户端。
   */
  function startBackgroundTurn(commandUuid: string): void {
    if (state.disposed || !state.active) return;
    if (state.pendingCommands.has(commandUuid)) return;
    if (activePendingCommand()) return;
    const pending: AcpPendingCommand = {
      uuid: commandUuid,
      resolve: () => {},
      reject: () => {},
      background: true,
      commandText: undefined,
      usageInputTokens: 0,
      usageOutputTokens: 0,
      usageCacheReadTokens: 0,
      usageCacheCreationTokens: 0,
      modelUsage: new Map(),
      started: true,
      finalized: false,
      slashStateSynced: true,
    };
    state.pendingCommands.set(commandUuid, pending);
    state.activeCommandUuid = commandUuid;
    state.toolPublisher = new AcpToolCallPublisher(
      config().toolCallSnapshots,
      ROOT_TOOL_CALL_SCOPE_ID,
      commandUuid,
      supportsTerminalOutput(),
      (update) => sendUpdate(update),
    );
  }

  async function finishBackgroundTurn(
    pending: AcpPendingCommand,
  ): Promise<void> {
    if (pending.finalized) return;
    pending.finalized = true;
    state.pendingCommands.delete(pending.uuid);
    if (state.activeCommandUuid === pending.uuid) {
      state.activeCommandUuid = undefined;
    }
    await flushToolPublisher();
  }

  async function syncSlashCommandState(
    pending: AcpPendingCommand,
  ): Promise<void> {
    if (!pending.commandText?.startsWith('/') || pending.slashStateSynced) {
      return;
    }
    pending.slashStateSynced = true;
    const { modeChanged } = await refreshAcpSessionState(state, config());
    if (modeChanged) {
      await sendUpdate({
        sessionUpdate: 'current_mode_update',
        currentModeId: state.modes.currentModeId,
      });
    }
    await sendUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: state.configOptions,
    });
  }

  async function dispatchResultOutput(
    message: SDKMessage,
    pending: AcpPendingCommand,
  ): Promise<void> {
    await syncSlashCommandState(pending);
    const result = message as {
      subtype?: string;
      stop_reason?: string;
      num_turns?: number;
      result?: string;
      errors?: string[];
    };
    if (
      result.subtype === 'success' &&
      result.num_turns === 0 &&
      typeof result.result === 'string' &&
      result.result.trim()
    ) {
      await sendUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: result.result },
      });
    } else if (
      result.subtype === 'error_during_execution' &&
      result.stop_reason !== 'refusal'
    ) {
      const errors = result.errors ?? [];
      if (errors.length > 0 && !isSlashCommandFailure(pending)) {
        await sendUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `[Error] ${errors.join('; ')}` },
        });
      }
    } else if (result.subtype === 'error_max_turns') {
      await sendUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: '[Warning] Maximum number of tool-loop turns reached. You can continue with a new message.',
        },
      });
    }
  }

  async function dispatchStreamEvent(message: SDKMessage): Promise<void> {
    const sseEvent = (message as { event?: unknown }).event as
      | {
          type?: string;
          delta?: { type?: string; text?: string; thinking?: string };
        }
      | undefined;
    if (sseEvent?.type !== 'content_block_delta' || !sseEvent.delta) {
      return;
    }
    if (sseEvent.delta.type === 'text_delta' && sseEvent.delta.text) {
      await sendUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: sseEvent.delta.text },
      });
    } else if (
      sseEvent.delta.type === 'thinking_delta' &&
      sseEvent.delta.thinking
    ) {
      await sendUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: sseEvent.delta.thinking },
      });
    }
  }

  async function dispatchAssistant(
    message: SDKMessage,
    pending: AcpPendingCommand,
  ): Promise<void> {
    const assistant = message as {
      message?: {
        content?: unknown[];
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        model?: string;
      };
    };
    const usage = assistant.message?.usage;
    if (usage) {
      const input = usage.input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheCreation = usage.cache_creation_input_tokens ?? 0;
      pending.usageInputTokens += input;
      pending.usageOutputTokens += output;
      pending.usageCacheReadTokens += cacheRead;
      pending.usageCacheCreationTokens += cacheCreation;
      const modelName = assistant.message?.model ?? 'unknown';
      const existing = pending.modelUsage.get(modelName) ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
      };
      existing.input += input;
      existing.output += output;
      existing.cacheRead += cacheRead;
      existing.cacheCreation += cacheCreation;
      pending.modelUsage.set(modelName, existing);
    }

    const content = assistant.message?.content;
    if (!Array.isArray(content)) {
      return;
    }
    const sessionConfig = config();
    for (const block of content) {
      if (
        !block ||
        typeof block !== 'object' ||
        (block as { type?: string }).type !== 'tool_use'
      ) {
        continue;
      }
      const toolBlock = block as { id: string; name: string; input: unknown };
      state.toolCallNames.set(toolBlock.id, toolBlock.name);
      if (state.permissionToolCallIds.has(toolBlock.id)) {
        continue;
      }
      const tool = sessionConfig.getToolRegistry().getTool(toolBlock.name);
      await state.toolPublisher?.declare(
        projectToolCall({
          toolCallId: toolBlock.id,
          name: toolBlock.name,
          input: toolBlock.input,
          kind: tool?.kind,
          status: 'pending',
          supportsTerminalOutput: supportsTerminalOutput(),
        }),
        toolBlock.name,
      );
      if (toolBlock.name === WRITE_TODOS_TOOL_NAME) {
        await sendPlanUpdate(toolBlock.input);
      }
    }
  }

  async function dispatchUser(message: SDKMessage): Promise<void> {
    const content = (message as { message?: { content?: unknown[] } }).message
      ?.content;
    if (!Array.isArray(content)) {
      return;
    }
    const sessionConfig = config();
    for (const block of content) {
      if (
        !block ||
        typeof block !== 'object' ||
        (block as { type?: string }).type !== 'tool_result'
      ) {
        continue;
      }
      const toolResult = block as {
        tool_use_id?: string;
        content?: string | unknown[];
        is_error?: boolean;
      };
      const toolName = toolResult.tool_use_id
        ? state.toolCallNames.get(toolResult.tool_use_id)
        : undefined;
      if (toolResult.tool_use_id) {
        state.toolCallNames.delete(toolResult.tool_use_id);
        state.permissionToolCallIds.delete(toolResult.tool_use_id);
      }
      await state.toolPublisher?.result({
        toolCallId: toolResult.tool_use_id ?? '',
        name: toolName,
        content: toolResult.content,
        isError: toolResult.is_error,
        supportsTerminalOutput: supportsTerminalOutput(),
      });
      if (
        !toolResult.is_error &&
        toolName !== undefined &&
        TASK_MUTATION_TOOL_NAMES.has(toolName) &&
        sessionConfig.isTasksEnabled()
      ) {
        const tasks = await sessionConfig.getTaskStore().listTasks();
        await sendPlanUpdate({
          todos: tasks
            .filter((task) => !isInternalTask(task))
            .map((task) => ({
              description: `#${task.id} ${task.subject}`,
              status: task.status,
            })),
        });
      }
    }
  }

  async function completePending(pending: AcpPendingCommand): Promise<void> {
    if (pending.finalized) {
      return;
    }
    pending.finalized = true;
    state.pendingCommands.delete(pending.uuid);
    if (state.activeCommandUuid === pending.uuid) {
      state.activeCommandUuid = undefined;
    }
    await syncSlashCommandState(pending);
    const result = pending.result as
      | {
          subtype?: string;
          stop_reason?: string;
          num_turns?: number;
          errors?: string[];
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          modelUsage?: Record<string, unknown>;
        }
      | undefined;

    if (
      result?.subtype === 'error_during_execution' &&
      isSlashCommandFailure(pending)
    ) {
      await flushToolPublisher();
      await sendDirectText(
        unsupportedInteractiveCommandMessage(pending.commandText),
      );
      pending.resolve({ stopReason: 'end_turn' });
      return;
    }

    let response: acp.PromptResponse;
    try {
      response = buildPromptResponse(pending, result);
    } catch (error) {
      await flushToolPublisher();
      pending.reject(error);
      return;
    }
    await flushToolPublisher();
    pending.resolve(response);
  }

  function buildPromptResponse(
    pending: AcpPendingCommand,
    result:
      | {
          subtype?: string;
          stop_reason?: string;
          num_turns?: number;
          errors?: string[];
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          modelUsage?: Record<string, unknown>;
        }
      | undefined,
  ): acp.PromptResponse {
    let endReason: acp.StopReason = 'end_turn';
    if (result) {
      if (result.usage) {
        pending.usageInputTokens =
          result.usage.input_tokens ?? pending.usageInputTokens;
        pending.usageOutputTokens =
          result.usage.output_tokens ?? pending.usageOutputTokens;
        pending.usageCacheReadTokens =
          result.usage.cache_read_input_tokens ?? pending.usageCacheReadTokens;
        pending.usageCacheCreationTokens =
          result.usage.cache_creation_input_tokens ??
          pending.usageCacheCreationTokens;
      }
      if (result.modelUsage) {
        pending.modelUsage.clear();
        for (const [modelName, counts] of Object.entries(result.modelUsage)) {
          if (!counts || typeof counts !== 'object') {
            continue;
          }
          const usageCounts = counts as {
            inputTokens?: number;
            outputTokens?: number;
            cacheReadInputTokens?: number;
            cacheCreationInputTokens?: number;
          };
          pending.modelUsage.set(modelName, {
            input: usageCounts.inputTokens ?? 0,
            output: usageCounts.outputTokens ?? 0,
            cacheRead: usageCounts.cacheReadInputTokens ?? 0,
            cacheCreation: usageCounts.cacheCreationInputTokens ?? 0,
          });
        }
      }

      if (result.stop_reason === 'refusal') {
        endReason = 'refusal';
      } else if (result.subtype === 'error_during_execution') {
        const errors = Array.isArray(result.errors) ? result.errors : [];
        const message = errors.join('; ') || 'Unknown execution error';
        if (message.includes('Operation aborted')) {
          endReason = 'cancelled';
        } else {
          throw new acp.RequestError(500, message);
        }
      } else if (result.subtype === 'error_max_budget_usd') {
        throw new acp.RequestError(429, 'Maximum budget exceeded.');
      } else if (result.subtype === 'error_max_turns') {
        endReason = 'max_turn_requests' as acp.StopReason;
      }
    }

    const modelUsageArray = [...pending.modelUsage.entries()].map(
      ([model, counts]) => ({
        model,
        token_count: {
          input_tokens: counts.input,
          output_tokens: counts.output,
          cache_read_input_tokens: counts.cacheRead,
          cache_creation_input_tokens: counts.cacheCreation,
        },
      }),
    );

    return {
      stopReason: endReason,
      ...(pending.recordedUserMessageId && result?.num_turns !== 0
        ? { userMessageId: pending.recordedUserMessageId }
        : {}),
      usage: {
        inputTokens: pending.usageInputTokens,
        outputTokens: pending.usageOutputTokens,
        totalTokens: pending.usageInputTokens + pending.usageOutputTokens,
        cachedReadTokens: pending.usageCacheReadTokens,
        cachedWriteTokens: pending.usageCacheCreationTokens,
      },
      _meta: {
        quota: {
          token_count: {
            input_tokens: pending.usageInputTokens,
            output_tokens: pending.usageOutputTokens,
            cache_read_input_tokens: pending.usageCacheReadTokens,
            cache_creation_input_tokens: pending.usageCacheCreationTokens,
          },
          model_usage: modelUsageArray,
        },
      },
    };
  }

  async function resolveCancelled(pending: AcpPendingCommand): Promise<void> {
    if (pending.finalized) {
      return;
    }
    pending.finalized = true;
    state.pendingCommands.delete(pending.uuid);
    if (state.activeCommandUuid === pending.uuid) {
      state.activeCommandUuid = undefined;
    }
    await syncSlashCommandState(pending);
    await flushToolPublisher();
    const result = pending.result as
      | { subtype?: string; errors?: string[] }
      | undefined;
    if (result?.subtype === 'error_during_execution') {
      const errors = result.errors ?? [];
      const message = errors.join('; ') || 'Unknown execution error';
      if (isSlashCommandFailure(pending)) {
        await sendDirectText(
          unsupportedInteractiveCommandMessage(pending.commandText),
        );
        pending.resolve({ stopReason: 'end_turn' });
        return;
      }
      if (!message.includes('Operation aborted')) {
        pending.reject(toAcpRequestError(new Error(message)));
        return;
      }
    }
    pending.resolve({
      stopReason: 'cancelled',
      ...(pending.recordedUserMessageId
        ? { userMessageId: pending.recordedUserMessageId }
        : {}),
    });
  }

  async function rejectPending(
    pending: AcpPendingCommand,
    error: unknown,
  ): Promise<void> {
    if (pending.finalized) {
      return;
    }
    pending.finalized = true;
    state.pendingCommands.delete(pending.uuid);
    if (state.activeCommandUuid === pending.uuid) {
      state.activeCommandUuid = undefined;
    }
    await flushToolPublisher();
    pending.reject(toAcpRequestError(error));
  }

  async function flushToolPublisher(): Promise<void> {
    const publisher = state.toolPublisher;
    state.toolPublisher = undefined;
    if (!publisher) {
      return;
    }
    try {
      await publisher.flush();
    } catch (error) {
      runLogger.warn('[acp] tool update flush failed', {
        sessionId: state.sessionId,
        error: getErrorMessage(error),
      });
    } finally {
      publisher.dispose();
    }
  }

  function activePendingCommand(): AcpPendingCommand | undefined {
    if (state.activeCommandUuid) {
      return state.pendingCommands.get(state.activeCommandUuid);
    }
    const started = [...state.pendingCommands.values()].filter(
      (pending) => pending.started && !pending.finalized,
    );
    return started.length === 1 ? started[0] : undefined;
  }

  async function handleNotice(notice: ThreadNotice): Promise<void> {
    if (!state.active) {
      return;
    }
    switch (notice.kind) {
      case 'commandsChanged':
        await sendAvailableCommands();
        return;
      case 'availableModelsChanged': {
        const { modelsChanged } = await refreshAcpSessionState(state, config());
        if (modelsChanged) {
          await sendUpdate({
            sessionUpdate: 'config_option_update',
            configOptions: state.configOptions,
          });
        }
        return;
      }
      case 'statusChanged':
      case 'planModeChanged': {
        const { modeChanged } = await refreshAcpSessionState(state, config());
        if (!modeChanged) {
          return;
        }
        await sendUpdate({
          sessionUpdate: 'current_mode_update',
          currentModeId: state.modes.currentModeId,
        });
        await sendUpdate({
          sessionUpdate: 'config_option_update',
          configOptions: state.configOptions,
        });
        return;
      }
      default:
        return;
    }
  }

  function supportsTerminalOutput(): boolean {
    return state.clientCapabilities?.terminal === true;
  }

  async function loadSupportedCommands(): Promise<AcpSupportedCommand[]> {
    const commandService = await createNonInteractiveCommandService(
      config(),
      AbortSignal.timeout(5000),
    );
    return commandService
      .getCommands()
      .filter(isCommandAvailableInAcp)
      .map(toAcpSupportedCommand);
  }

  async function sendAvailableCommands(): Promise<void> {
    try {
      const commands = await loadSupportedCommands();
      await sendUpdate({
        sessionUpdate: 'available_commands_update',
        availableCommands: commands.map(toAcpAvailableCommand),
      });
    } catch (error) {
      runLogger.warn(
        'acp.available_commands.send_failed',
        `session=${state.sessionId}`,
        `error=${getErrorMessage(error)}`,
      );
    }
  }

  async function sendDirectText(text: string): Promise<acp.PromptResponse> {
    if (text) {
      await sendUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      });
    }
    return { stopReason: 'end_turn' };
  }

  async function canUseTool(
    request: Parameters<ThreadCanUseToolHandler>[0],
    options?: ThreadReverseRequestOptions,
  ): Promise<Awaited<ReturnType<ThreadCanUseToolHandler>>> {
    const sessionConfig = config();
    const details = request.details as
      | SerializableConfirmationDetails
      | undefined;

    if (
      details?.type === ASK_USER_TOOL_NAME &&
      supportsFormElicitation(state.clientCapabilities)
    ) {
      const answered = await tryAskUserQuestionViaElicitation(
        request,
        details,
        options,
      );
      if (answered) {
        return answered;
      }
    }

    const tool = sessionConfig.getToolRegistry().getTool(request.toolName);
    let acpOptions = details
      ? toPermissionOptions(details)
      : basicPermissionOptions();
    if (request.options?.length && details?.type !== EXIT_PLAN_MODE_TOOL_NAME) {
      acpOptions = acpOptions.filter((option) =>
        request.options!.some((choice) => choice.outcome === option.optionId),
      );
    }
    state.toolCallNames.set(request.toolUseId, request.toolName);
    state.permissionToolCallIds.add(request.toolUseId);
    state.toolPublisher?.permissionRequested(
      request.toolUseId,
      request.toolName,
    );

    const acpRequest: acp.RequestPermissionRequest = {
      sessionId: state.sessionId,
      options: acpOptions,
      toolCall: {
        toolCallId: request.toolUseId,
        status: 'pending',
        title: details?.title ?? request.title ?? request.toolName,
        content: buildAcpPermissionContent(details),
        kind: tool ? toAcpToolKind(tool.kind) : 'other',
        rawInput: request.input,
        _meta: {
          [BRAND_PROTOCOL_NAMESPACE]: {
            toolName: request.toolName,
          },
        },
      },
    };

    if (options?.signal?.aborted) {
      throw new AbortError('ACP permission request aborted');
    }

    try {
      const output = RequestPermissionResponseSchema.parse(
        await raceWithAbort(
          params.connection.requestPermission(acpRequest),
          options?.signal,
        ),
      );

      if (output.outcome.outcome === 'selected') {
        const selected = output.outcome.optionId;
        if (!acpOptions.some((option) => option.optionId === selected)) {
          return denyDecision();
        }
      }
      if (details?.type === EXIT_PLAN_MODE_TOOL_NAME) {
        if (output.outcome.outcome !== 'selected') {
          return denyDecision();
        }
        const mode = normalizePermissionModeId(output.outcome.optionId);
        if (!mode) {
          return denyDecision();
        }
        await params.setModeForExitPlan(state.sessionId, mode);
        return { behavior: 'allow', updatedInput: request.input };
      }

      if (output.outcome.outcome === 'cancelled') {
        return denyDecision();
      }

      const outcome = z
        .nativeEnum(ToolConfirmationOutcome)
        .parse(output.outcome.optionId);
      if (outcome === ToolConfirmationOutcome.Cancel) {
        return denyDecision();
      }

      const scope =
        outcome === ToolConfirmationOutcome.ProceedPersist
          ? 'persist'
          : outcome === ToolConfirmationOutcome.ProceedSession
            ? 'session'
            : 'once';
      if (sessionConfig.permission) {
        rememberApproval({
          permission: sessionConfig.permission,
          scope,
          suggestions: request.suggestions as never,
          settingsWriter: sessionConfig.permission?.getSettingsWriter?.(),
          onModeChange: (mode) =>
            sessionConfig.setPermissionMode(mode, { trigger: 'tool' }),
        });
      }
      return { behavior: 'allow', updatedInput: request.input };
    } catch (error) {
      if (options?.signal?.aborted || isAbortError(error)) {
        throw error;
      }
      runLogger.warn('[acp] permission request failed', {
        sessionId: state.sessionId,
        error: getErrorMessage(error),
      });
      return denyDecision();
    }
  }

  async function tryAskUserQuestionViaElicitation(
    request: Parameters<ThreadCanUseToolHandler>[0],
    details: Extract<
      SerializableConfirmationDetails,
      { type: typeof ASK_USER_TOOL_NAME }
    >,
    options?: ThreadReverseRequestOptions,
  ): Promise<Awaited<ReturnType<ThreadCanUseToolHandler>> | undefined> {
    state.toolCallNames.set(request.toolUseId, request.toolName);
    try {
      const response = (await raceWithAbort(
        params.connection.unstable_createElicitation(
          buildAskUserElicitationRequest(
            state.sessionId,
            request.toolUseId,
            details,
          ),
        ),
        options?.signal,
      )) as acp.CreateElicitationResponse;

      if (response.action !== 'accept') {
        return denyDecision();
      }
      const answered = buildAskUserPayloadFromElicitation(details, response);
      return {
        behavior: 'allow',
        updatedInput: answered
          ? { ...(request.input as object), ...answered }
          : request.input,
      };
    } catch (error) {
      if (options?.signal?.aborted || isAbortError(error)) {
        throw error;
      }
      runLogger.warn(
        '[acp] Form elicitation failed, falling back to a permission request',
        getErrorMessage(error),
      );
      return undefined;
    }
  }

  async function elicit(
    payload: unknown,
    options?: ThreadReverseRequestOptions,
  ): Promise<unknown> {
    if (
      !supportsFormElicitation(state.clientCapabilities) &&
      !state.clientCapabilities?.elicitation?.url
    ) {
      return { action: 'cancel' };
    }
    const record =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {};
    const message = readStringProperty(record, 'message') ?? 'Input required';
    const url = readStringProperty(record, 'url');
    const mode = record['mode'] === 'url' ? 'url' : 'form';
    try {
      const request =
        mode === 'url' && url !== undefined
          ? ({
              mode: 'url',
              sessionId: state.sessionId,
              message,
              url,
              elicitationId:
                readStringProperty(record, 'elicitation_id') ?? randomUUID(),
            } satisfies acp.CreateElicitationRequest)
          : ({
              mode: 'form',
              sessionId: state.sessionId,
              message,
              requestedSchema: (record[
                'requested_schema'
              ] as acp.ElicitationSchema) ?? {
                type: 'object',
                properties: {},
              },
            } satisfies acp.CreateElicitationRequest);
      const response = (await raceWithAbort(
        params.connection.unstable_createElicitation(request),
        options?.signal,
      )) as acp.CreateElicitationResponse;
      if (response.action === 'accept' && response.content) {
        return { action: 'accept', content: response.content };
      }
      return { action: response.action };
    } catch (error) {
      runLogger.warn('[acp] elicitation failed', getErrorMessage(error));
      return { action: 'cancel' };
    }
  }

  function beginPrompt(
    uuid: string,
    commandText: string | undefined,
  ): AcpPromptHandle {
    let resolvePrompt!: (response: acp.PromptResponse) => void;
    let rejectPrompt!: (error: unknown) => void;
    const promise = new Promise<acp.PromptResponse>((resolve, reject) => {
      resolvePrompt = resolve;
      rejectPrompt = reject;
    });
    const pending: AcpPendingCommand = {
      uuid,
      resolve: resolvePrompt,
      reject: rejectPrompt,
      background: false,
      commandText,
      usageInputTokens: 0,
      usageOutputTokens: 0,
      usageCacheReadTokens: 0,
      usageCacheCreationTokens: 0,
      modelUsage: new Map(),
      started: false,
      finalized: false,
      slashStateSynced: false,
    };
    state.pendingCommands.set(uuid, pending);
    return {
      promise,
      fail(error: unknown): void {
        if (pending.finalized) return;
        pending.finalized = true;
        state.pendingCommands.delete(uuid);
        pending.reject(toAcpRequestError(error));
      },
    };
  }

  async function cancelPendingPrompts(): Promise<void> {
    for (const pending of [...state.pendingCommands.values()]) {
      if (pending.background) {
        await finishBackgroundTurn(pending);
      } else {
        await resolveCancelled(pending);
      }
    }
  }

  async function dispose(): Promise<void> {
    if (state.disposed) {
      return;
    }
    state.disposed = true;
    state.abortController.abort();
    state.toolPublisher?.dispose();
    state.toolPublisher = undefined;
    for (const pending of state.pendingCommands.values()) {
      if (!pending.finalized) {
        pending.finalized = true;
        pending.resolve({ stopReason: 'cancelled' });
      }
    }
    state.pendingCommands.clear();
  }

  async function replayHistory(messages: readonly Message[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    await replayAcpHistory({
      messages,
      config: config(),
      supportsTerminalOutput: supportsTerminalOutput(),
      sendUpdate: (update) => sendUpdate(update),
      rememberToolName: (toolCallId, name) =>
        state.toolCallNames.set(toolCallId, name),
    });
  }

  const requests: ThreadHostRequests = {
    ensureAuthReady: () => params.ensureAuthReady(),
    prepareInference: params.prepareInference,
    canUseTool: (request, options) => canUseTool(request, options),
    elicit: (payload, options) => elicit(payload, options),
    runHookCallback: async () => {
      throw new Error('Hook callbacks are not supported in ACP sessions.');
    },
    getModelPolicy: async () => {
      throw new Error('Model policy is not supported in ACP sessions.');
    },
    resolveSessionArtifacts: async () => {
      throw new Error('Session artifact resolution is not supported in ACP.');
    },
    sendMcpMessage: async () => {
      throw new Error('In-process MCP servers are not supported in ACP.');
    },
    shouldGenerateMemory: async () => false,
    shouldReviewSkillEvolution: async () => false,
  };

  const host: AcpSessionHost = {
    events: {
      emit: (event: ThreadEvent) => enqueueEvent(event),
    },
    requests,
    beginPrompt,
    cancelPendingPrompts,
    dispose,
    replayHistory,
    sendAvailableCommands,
    sendDirectText,
  };
  state.host = host;
  state.callContext = {
    signal: state.abortController.signal,
    host,
  };
  return { state, host };
}

export async function sendSessionUpdate(
  state: AcpSessionState,
  connection: acp.AgentSideConnection,
  update: acp.SessionUpdate,
): Promise<void> {
  if (state.disposed) {
    return;
  }
  state.updateChain = state.updateChain
    .then(() =>
      connection.sessionUpdate({
        sessionId: state.sessionId,
        update,
      }),
    )
    .catch((error: unknown) => {
      runLogger.warn('[acp] session update failed', {
        sessionId: state.sessionId,
        update: update.sessionUpdate,
        error: getErrorMessage(error),
      });
    });
  return state.updateChain;
}

export async function refreshAcpSessionState(
  state: AcpSessionState,
  config: Config,
): Promise<{
  modeChanged: boolean;
  modelsChanged: boolean;
}> {
  if (state.disposed) return { modeChanged: false, modelsChanged: false };
  const revision = ++state.modelStateRevision;
  const model = config.getModel();
  const identity = config.getModelRequestIdentity();
  const sessionId = config.getSessionId();
  const permissionMode = config.getPermissionMode();
  const models = await state.modelAdapter.buildAvailableModels(config);
  const modes = {
    availableModes: buildAvailableModes(),
    currentModeId: permissionMode,
  };
  const configOptions = await buildAcpConfigOptions(
    { ...state, models, modes },
    config,
  );
  if (
    state.disposed ||
    state.abortController.signal.aborted ||
    revision !== state.modelStateRevision ||
    model !== config.getModel() ||
    identity !== config.getModelRequestIdentity() ||
    sessionId !== config.getSessionId() ||
    permissionMode !== config.getPermissionMode()
  )
    return { modeChanged: false, modelsChanged: false };
  const previousMode = state.modes.currentModeId;
  const previousModels = JSON.stringify(state.models);
  state.modes = modes;
  state.models = models;
  state.configOptions = configOptions;
  return {
    modeChanged: previousMode !== state.modes.currentModeId,
    modelsChanged: previousModels !== JSON.stringify(state.models),
  };
}

export async function buildAcpConfigOptions(
  state: AcpSessionState,
  config: Config,
): Promise<acp.SessionConfigOption[]> {
  const options: acp.SessionConfigOption[] = [
    {
      type: 'select',
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      currentValue: state.modes.currentModeId,
      options: state.modes.availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description,
      })),
    },
    {
      type: 'select',
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: state.models.currentModelId,
      options: state.models.availableModels.map((model) => ({
        value: model.modelId,
        name: model.name,
        description: model.description,
      })),
    },
  ];

  const reasoningEffortOption =
    (await state.modelAdapter.buildReasoningEffortOption?.(config)) ?? null;
  if (reasoningEffortOption) {
    options.push(reasoningEffortOption);
  }
  return options;
}

export function getAcpSessionResponse(
  state: AcpSessionState,
): acp.NewSessionResponse {
  return {
    sessionId: state.sessionId,
    modes: state.modes,
    models: state.models,
    configOptions: state.configOptions,
  };
}

export function normalizePermissionModeId(modeId: string): string {
  return normalizePermissionMode(modeId) ?? modeId;
}

export function parseRewindInvocation(
  prompt: readonly acp.ContentBlock[],
): string | undefined | null {
  if (prompt.length !== 1 || prompt[0].type !== 'text') {
    return null;
  }
  const match = prompt[0].text.trim().match(/^\/rewind(?:\s+(\S+))?\s*$/);
  if (!match) {
    return null;
  }
  return match[1];
}

export function getSingleTextPrompt(
  prompt: readonly acp.ContentBlock[],
): string | undefined {
  return prompt.length === 1 && prompt[0].type === 'text'
    ? prompt[0].text.trim()
    : undefined;
}

export function toAcpRequestError(error: unknown): acp.RequestError {
  if (error instanceof acp.RequestError) {
    return error;
  }
  if (getErrorStatus(error) === 429) {
    return new acp.RequestError(429, 'Rate limit exceeded. Try again later.');
  }
  return new acp.RequestError(
    getErrorStatus(error) || 500,
    getAcpErrorMessage(error),
  );
}

function basicPermissionOptions(): acp.PermissionOption[] {
  return [
    {
      optionId: ToolConfirmationOutcome.ProceedOnce,
      name: 'Allow',
      kind: 'allow_once',
    },
    {
      optionId: ToolConfirmationOutcome.Cancel,
      name: 'Reject',
      kind: 'reject_once',
    },
  ];
}

function denyDecision(): {
  behavior: 'deny';
  message: string;
  interrupt: boolean;
} {
  return {
    behavior: 'deny',
    message: 'Permission denied by the ACP client.',
    interrupt: false,
  };
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    throw new AbortError('Aborted');
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortError('Aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

class AbortError extends Error {
  override readonly name = 'AbortError';
}

function readStringProperty(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function isSlashCommandFailure(pending: AcpPendingCommand): boolean {
  return pending.commandText?.startsWith('/') === true;
}

function unsupportedInteractiveCommandMessage(
  commandText: string | undefined,
): string {
  const name = commandText?.startsWith('/')
    ? commandText.slice(1).split(/\s+/)[0]
    : undefined;
  return name
    ? `Command /${name} requires interactive UI and is not available in ACP.`
    : 'Command requires interactive UI and is not available in ACP.';
}
