/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { LlmEventType } from '@qwen-code/qwen-code-core/core/turn.js';
import { TurnBudget } from '@qwen-code/qwen-code-core/core/turn-budget.js';
import type { Content, Part } from '@google/genai';
import type { ConfigInitializeOptions } from '@qwen-code/qwen-code-core/config/config.js';
import {
  HookEventName,
  type HookInput,
} from '@qwen-code/qwen-code-core/hooks/types.js';
import type { ManagedHookDispatcher } from '@qwen-code/qwen-code-core/hooks/hookEventHandler.js';
import type { HostedHookSession } from './hosted-hook-session.js';
import { HostedHookRecoveryRequiredError } from './hosted-hook-session.js';
import { SendMessageType } from '@qwen-code/qwen-code-core/core/client.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCliConfig } from '../config/config.js';
import { runHostedHarnessTextTurn } from './hosted-harness-model.js';

const state = vi.hoisted(() => ({
  config: undefined as unknown as {
    [key: string]: unknown;
    setUserMemory: ReturnType<typeof vi.fn>;
    getLlmClient(): {
      [key: string]: unknown;
      sendMessageStream(...args: never[]): AsyncGenerator<unknown, void>;
    };
  },
}));
vi.mock('../config/settings.js', () => ({
  loadSettings: () => ({ merged: {} }),
}));
vi.mock('../config/config.js', () => ({
  loadCliConfig: vi.fn(async () => state.config),
}));

const input = {
  sessionId: '22222222-2222-4222-8222-222222222222',
  cwd: '/workspace',
  history: [],
  prompt: 'hello',
  promptId: '33333333-3333-4333-8333-333333333333',
  signal: new AbortController().signal,
};

function config(
  events: Array<{
    type: LlmEventType;
    value?: unknown;
    isContinuation?: boolean;
  }>,
) {
  const tools = new Set(['run_shell_command']);
  const unregisterTool = vi.fn((name: string) => tools.delete(name));
  const setTools = vi.fn(async () => undefined);
  const shutdown = vi.fn(async () => undefined);
  const setHistory = vi.fn();
  const setUserMemory = vi.fn();
  const refreshSystemInstruction = vi.fn(async () => undefined);
  const initialize = vi
    .fn<(options?: ConfigInitializeOptions) => Promise<void>>()
    .mockResolvedValue(undefined);
  const refreshAuth = vi.fn(async () => undefined);
  const requests: Part[][] = [];
  const sendOptions: unknown[] = [];
  const getHistory = vi.fn<() => Content[]>(() => [
    { role: 'model', parts: [{ text: 'answer' }] },
  ]);
  const budget = new TurnBudget();
  const sendMessageStream = vi.fn(async function* (
    request: Part[],
    _signal?: unknown,
    _promptId?: unknown,
    options?: unknown,
  ) {
    requests.push(request);
    sendOptions.push(options);
    for (const event of events) yield event;
  });
  state.config = {
    initialize,
    getModelsConfig: () => ({ getCurrentAuthType: () => 'test-auth' }),
    refreshAuth,
    getToolRegistry: () => ({
      warmAll: vi.fn(async () => undefined),
      getAllTools: () => [...tools].map((name) => ({ name })),
      unregisterTool,
      getFunctionDeclarations: () => [...tools],
    }),
    getLlmClient: () => ({
      setTools,
      refreshSystemInstruction,
      getChat: () => ({ setHistory, setTools: vi.fn() }),
      getHistory,
      sendMessageStream,
    }),
    getModel: () => 'test-model',
    setUserMemory,
    getTurnBudget: () => budget,
    shutdown,
  };
  return {
    unregisterTool,
    setTools,
    shutdown,
    setHistory,
    setUserMemory,
    refreshSystemInstruction,
    initialize,
    refreshAuth,
    sendMessageStream,
    requests,
    sendOptions,
    budget,
    getHistory,
  };
}

function hostedHooks(events: HookEventName[] = []) {
  const fire = vi.fn<HostedHookSession['fire']>().mockResolvedValue(undefined);
  const hasCompletedOccurrence = vi.fn().mockReturnValue(false);
  const session = {
    ensureReady: vi.fn().mockResolvedValue(undefined),
    getCatalog: () => ({ hooks: events.map((eventName) => ({ eventName })) }),
    hasCompletedOccurrence,
    wasStopBlocked: vi.fn().mockResolvedValue(false),
    setMessagesProvider: vi.fn(),
    fire,
  } as unknown as HostedHookSession;
  return { session, fire, hasCompletedOccurrence };
}

function nativeInput(event: HookEventName): HookInput {
  return {
    session_id: input.sessionId,
    cwd: input.cwd,
    transcript_path: '',
    hook_event_name: event,
    timestamp: '2026-09-30T00:00:00.000Z',
  };
}

describe('Hosted Harness model boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes local tools before a text model request', async () => {
    const hooks = config([
      { type: LlmEventType.Content, value: 'hello back' },
      { type: LlmEventType.Finished },
    ]);
    await expect(runHostedHarnessTextTurn(input)).resolves.toEqual({
      text: 'hello back',
      model: 'test-model',
    });
    expect(hooks.unregisterTool).toHaveBeenCalledWith('run_shell_command');
    expect(hooks.setTools).toHaveBeenCalledOnce();
    expect(hooks.setHistory).toHaveBeenCalledWith([]);
    expect(hooks.shutdown).toHaveBeenCalledOnce();
    const args = vi.mocked(loadCliConfig).mock.calls[0];
    expect(args?.[1]).toMatchObject({ safeMode: true, chatRecording: false });
    expect(args?.[9]?.toolInvocationGuard?.({} as never)).toMatchObject({
      allowed: false,
    });
  });

  it('rejects a model tool request without executing it', async () => {
    const hooks = config([{ type: LlmEventType.ToolCallRequest }]);
    await expect(runHostedHarnessTextTurn(input)).rejects.toThrow(
      'refused a tool call',
    );
    expect(hooks.shutdown).toHaveBeenCalledOnce();
  });

  it('discards abandoned output after a fresh retry or model fallback', async () => {
    config([
      { type: LlmEventType.Content, value: 'first attempt' },
      { type: LlmEventType.Retry, isContinuation: false },
      { type: LlmEventType.Content, value: 'second attempt' },
      { type: LlmEventType.ModelFallback },
      { type: LlmEventType.Content, value: 'final answer' },
      { type: LlmEventType.Finished },
    ]);
    await expect(runHostedHarnessTextTurn(input)).resolves.toMatchObject({
      text: 'final answer',
    });
  });

  it('discards abandoned output after a fresh retry alone', async () => {
    config([
      { type: LlmEventType.Content, value: 'first attempt' },
      { type: LlmEventType.Retry, isContinuation: false },
      { type: LlmEventType.Content, value: 'final answer' },
      { type: LlmEventType.Finished },
    ]);
    await expect(runHostedHarnessTextTurn(input)).resolves.toMatchObject({
      text: 'final answer',
    });
  });

  it('keeps output across a continuation and accepts chat compaction', async () => {
    config([
      { type: LlmEventType.Content, value: 'first' },
      { type: LlmEventType.Retry, isContinuation: true },
      { type: LlmEventType.ChatCompressed },
      { type: LlmEventType.Content, value: ' second' },
      { type: LlmEventType.Finished },
    ]);
    await expect(runHostedHarnessTextTurn(input)).resolves.toMatchObject({
      text: 'first second',
    });
  });

  it('keeps a completed answer when config cleanup fails', async () => {
    const hooks = config([
      { type: LlmEventType.Content, value: 'answer' },
      { type: LlmEventType.Finished },
    ]);
    hooks.shutdown.mockRejectedValueOnce(new Error('cleanup failed'));
    await expect(runHostedHarnessTextTurn(input)).resolves.toMatchObject({
      text: 'answer',
    });
  });

  it('injects the Workspace context fetched before the turn', async () => {
    const order: string[] = [];
    const hooks = config([
      { type: LlmEventType.Content, value: 'answer' },
      { type: LlmEventType.Finished },
    ]);
    // initialize() runs a safe-mode memory refresh that clears user memory,
    // so the injection must come after it.
    hooks.initialize.mockImplementation(async () => {
      order.push('initialize');
    });
    hooks.setUserMemory.mockImplementation(() => {
      order.push('inject');
    });
    hooks.refreshSystemInstruction.mockImplementation(async () => {
      order.push('refresh');
    });
    const client = state.config.getLlmClient();
    const stream = client.sendMessageStream.bind(client);
    state.config.getLlmClient = () => ({
      ...client,
      async *sendMessageStream() {
        order.push('request');
        yield* stream();
      },
    });
    await expect(
      runHostedHarnessTextTurn({
        ...input,
        workspaceContext: { read: () => 'project rules' },
      }),
    ).resolves.toMatchObject({ text: 'answer' });
    expect(hooks.setUserMemory).toHaveBeenCalledWith('project rules');
    // setUserMemory only writes the field; without the refresh the cached
    // system instruction still carries the pre-injection prompt.
    expect(order).toEqual(['initialize', 'inject', 'refresh', 'request']);
  });

  it('picks up the Workspace context a tool batch fetched, on the next request', async () => {
    const order: string[] = [];
    let context: string | undefined;
    const rounds = [
      [
        {
          type: LlmEventType.ToolCallRequest,
          value: {
            callId: 'call-1',
            name: 'read_file',
            args: { file_path: 'QWEN.md' },
            isClientInitiated: false,
            prompt_id: input.promptId,
          },
        },
        { type: LlmEventType.Finished },
      ],
      [
        { type: LlmEventType.Content, value: 'done' },
        { type: LlmEventType.Finished },
      ],
    ];
    const hooks = config([]);
    hooks.setUserMemory.mockImplementation(() => {
      order.push('inject');
    });
    let requests = 0;
    state.config.getLlmClient = () => ({
      setTools: vi.fn(async () => undefined),
      refreshSystemInstruction: vi.fn(async () => {
        order.push('refresh');
      }),
      getChat: () => ({ setHistory: vi.fn(), setTools: vi.fn() }),
      getHistory: () => [
        {
          role: 'model',
          parts:
            requests <= 1
              ? [{ functionCall: { name: 'read_file' } }]
              : [{ text: 'done' }],
        },
      ],
      async *sendMessageStream() {
        requests++;
        order.push('request');
        for (const event of rounds.shift() ?? []) yield event;
      },
    });
    const toolTurn = {
      declarations: vi.fn(async () => []),
      consumeResults: vi.fn(async () => undefined),
      execute: vi.fn(async () => {
        context = 'project rules';
        return [
          {
            functionResponse: {
              id: 'call-1',
              name: 'read_file',
              response: { output: 'rules' },
            },
          },
        ];
      }),
    };
    await expect(
      runHostedHarnessTextTurn({
        ...input,
        toolTurn: toolTurn as never,
        workspaceContext: { read: () => context },
      }),
    ).resolves.toMatchObject({ text: 'done', model: 'test-model' });
    expect(toolTurn.execute).toHaveBeenCalledOnce();
    expect(hooks.setUserMemory).toHaveBeenCalledWith('project rules');
    expect(order).toEqual(['request', 'inject', 'refresh', 'request']);
  });

  it('does not reapply a completed SessionStart on later turns', async () => {
    const model = config([{ type: LlmEventType.Finished }]);
    const hooks = hostedHooks();
    hooks.hasCompletedOccurrence.mockReturnValue(true);
    await runHostedHarnessTextTurn({ ...input, hooks: hooks.session });
    expect(
      hooks.fire.mock.calls.some(
        ([event]) => event === HookEventName.SessionStart,
      ),
    ).toBe(false);
    expect(model.requests[0]).toEqual([{ text: input.prompt }]);
  });

  it('defers initialization InstructionsLoaded until authentication, preserving native fields', async () => {
    const model = config([{ type: LlmEventType.Finished }]);
    const hooks = hostedHooks([HookEventName.InstructionsLoaded]);
    let authenticated = false;
    model.refreshAuth.mockImplementation(async () => {
      authenticated = true;
    });
    const fields = {
      ...nativeInput(HookEventName.InstructionsLoaded),
      file_path: '/workspace/AGENTS.md',
      memory_type: 'project',
      load_reason: 'session_start',
    };
    model.initialize.mockImplementation(async (options) => {
      await options!.managedHookDispatcher!.execute(
        HookEventName.InstructionsLoaded,
        fields,
        input.signal,
      );
      expect(hooks.fire).not.toHaveBeenCalled();
    });
    hooks.fire.mockImplementation(async () => {
      expect(authenticated).toBe(true);
      return undefined;
    });
    await runHostedHarnessTextTurn({ ...input, hooks: hooks.session });
    const events = hooks.fire.mock.calls.map(([event]) => event);
    expect(events.slice(0, 3)).toEqual([
      HookEventName.SessionStart,
      HookEventName.InstructionsLoaded,
      HookEventName.UserPromptSubmit,
    ]);
    expect(
      hooks.fire.mock.calls.find(
        ([event]) => event === HookEventName.InstructionsLoaded,
      )?.[2],
    ).toMatchObject({
      file_path: '/workspace/AGENTS.md',
      memory_type: 'project',
      load_reason: 'session_start',
      prompt_id: input.promptId,
    });
  });

  it('routes real native compaction callbacks through the managed dispatcher', async () => {
    const model = config([]);
    const hooks = hostedHooks([
      HookEventName.PreCompact,
      HookEventName.PostCompact,
      HookEventName.Stop,
      HookEventName.PermissionDenied,
    ]);
    let dispatcher: ManagedHookDispatcher;
    model.initialize.mockImplementation(async (options) => {
      dispatcher = options!.managedHookDispatcher!;
    });
    model.sendMessageStream.mockImplementation(async function* () {
      expect(dispatcher.hasHooksForEvent(HookEventName.Stop)).toBe(false);
      expect(dispatcher.hasHooksForEvent(HookEventName.PermissionDenied)).toBe(
        true,
      );
      await dispatcher.execute(
        HookEventName.PreCompact,
        nativeInput(HookEventName.PreCompact),
      );
      await dispatcher.execute(
        HookEventName.PostCompact,
        nativeInput(HookEventName.PostCompact),
      );
      yield { type: LlmEventType.Finished };
    });
    await runHostedHarnessTextTurn({ ...input, hooks: hooks.session });
    expect(
      hooks.fire.mock.calls
        .filter(
          ([event]) =>
            event === HookEventName.PreCompact ||
            event === HookEventName.PostCompact,
        )
        .map(([event]) => event),
    ).toEqual([HookEventName.PreCompact, HookEventName.PostCompact]);
  });

  it('keeps InstructionsLoaded occurrence identity after tool recovery and skips its completed effects', async () => {
    const hooks = hostedHooks([HookEventName.InstructionsLoaded]);
    const fields = {
      ...nativeInput(HookEventName.InstructionsLoaded),
      file_path: '/workspace/AGENTS.md',
      memory_type: 'project',
      load_reason: 'session_start',
    };
    const first = config([{ type: LlmEventType.Finished }]);
    first.initialize.mockImplementation(async (options) => {
      await options!.managedHookDispatcher!.execute(
        HookEventName.InstructionsLoaded,
        fields,
      );
    });
    await runHostedHarnessTextTurn({ ...input, hooks: hooks.session });
    const occurrence = hooks.fire.mock.calls.find(
      ([event]) => event === HookEventName.InstructionsLoaded,
    )![1];
    hooks.hasCompletedOccurrence.mockImplementation(
      (event, id) =>
        event === HookEventName.InstructionsLoaded && id === occurrence,
    );
    hooks.fire.mockClear();
    const resumed = config([{ type: LlmEventType.Finished }]);
    resumed.initialize.mockImplementation(async (options) => {
      await options!.managedHookDispatcher!.execute(
        HookEventName.InstructionsLoaded,
        { ...fields, timestamp: '2026-09-30T01:00:00.000Z' },
      );
    });
    await runHostedHarnessTextTurn({
      ...input,
      hooks: hooks.session,
      resumeFromToolResults: [],
      history: [{ type: 'tool_result', uuid: 'after-tool' } as never],
    });
    expect(hooks.hasCompletedOccurrence).toHaveBeenCalledWith(
      HookEventName.InstructionsLoaded,
      occurrence,
    );
    expect(
      hooks.fire.mock.calls.some(
        ([event]) => event === HookEventName.InstructionsLoaded,
      ),
    ).toBe(false);
  });

  it('opens the shared budget before startup Hooks and persists main usage in the same scope', async () => {
    const model = config([
      {
        type: LlmEventType.Finished,
        value: { usageMetadata: { candidatesTokenCount: 30 } },
      },
    ]);
    const hooks = hostedHooks();
    const complete = vi.fn();
    const bindBudget = vi.fn(async (budget: TurnBudget, prompt?: string) => {
      expect(prompt).toBe('original +5k');
      budget.beginTurn({
        promptId: input.promptId,
        sessionId: input.sessionId,
        budget: 5_000,
        outputTokensAtTurnStart: 100,
      });
    });
    hooks.fire.mockImplementation(async (event) => {
      expect(model.budget.current(input.sessionId)).toMatchObject({
        budget: 5_000,
        outputTokensAtTurnStart: 100,
      });
      return event === HookEventName.UserPromptSubmit
        ? {
            hookSpecificOutput: {
              hookEventName: event,
              updatedPrompt: 'rewritten +10k',
            },
          }
        : undefined;
    });
    await runHostedHarnessTextTurn({
      ...input,
      prompt: 'original +5k',
      hooks: hooks.session,
      modelScope: {
        bindBudget,
        evaluate: vi.fn(),
        beginMainAttempt: vi.fn().mockResolvedValue(complete),
      },
    });
    expect(bindBudget).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(true, [{ candidatesTokenCount: 30 }]);
    expect(model.requests[0]).toEqual([{ text: 'rewritten +10k' }]);
  });

  it('reports provider failure through StopFailure and leaves Hook recovery failures untouched', async () => {
    config([
      {
        type: LlmEventType.Error,
        value: { error: { message: 'provider failed' } },
      },
    ]);
    const hooks = hostedHooks();
    await expect(
      runHostedHarnessTextTurn({ ...input, hooks: hooks.session }),
    ).rejects.toThrow('provider failed');
    expect(hooks.fire).toHaveBeenCalledWith(
      HookEventName.StopFailure,
      `${input.promptId}:0:model-failure`,
      expect.objectContaining({ error_details: 'provider failed' }),
      input.signal,
      undefined,
    );

    const model = config([]);
    hooks.fire.mockClear();
    model.sendMessageStream.mockImplementation(async function* () {
      yield { type: LlmEventType.Content, value: 'partial' };
      throw new HostedHookRecoveryRequiredError();
    });
    await expect(
      runHostedHarnessTextTurn({ ...input, hooks: hooks.session }),
    ).rejects.toThrow('requires reconciliation');
    expect(
      hooks.fire.mock.calls.some(
        ([event]) => event === HookEventName.StopFailure,
      ),
    ).toBe(false);
  });

  it('suppresses both returned text and persisted parts when MessageDisplay hides the answer', async () => {
    config([
      { type: LlmEventType.Content, value: 'answer' },
      { type: LlmEventType.Finished },
    ]);
    const hooks = hostedHooks([HookEventName.MessageDisplay]);
    const getCatalog = hooks.session.getCatalog;
    let ready = false;
    vi.spyOn(hooks.session, 'getCatalog').mockImplementation(() =>
      ready ? getCatalog() : undefined,
    );
    vi.mocked(hooks.session.ensureReady).mockImplementation(async () => {
      ready = true;
    });
    const textDeltas = {
      delta: vi.fn(),
      retract: vi.fn(async () => undefined),
    };
    hooks.fire.mockImplementation(async (event) =>
      event === HookEventName.MessageDisplay
        ? { suppressOutput: true }
        : undefined,
    );
    const toolTurn = {
      execute: vi.fn(),
      consumeResults: vi.fn(),
      declarations: vi.fn().mockResolvedValue([]),
      setPromptHookRunner: vi.fn(),
    };
    await expect(
      runHostedHarnessTextTurn({
        ...input,
        hooks: hooks.session,
        toolTurn,
        textDeltas,
      }),
    ).resolves.toMatchObject({ text: '', parts: [] });
    expect(textDeltas.delta).not.toHaveBeenCalled();
    expect(
      hooks.fire.mock.calls.find(
        ([event]) => event === HookEventName.MessageDisplay,
      )?.[2],
    ).toMatchObject({
      message_id: `${input.promptId}:0`,
      displayed_text: 'answer',
      is_final: true,
    });
  });

  it('buffers discarded Stop drafts until the final answer is accepted', async () => {
    const model = config([]);
    const hooks = hostedHooks([HookEventName.Stop]);
    let attempts = 0;
    model.sendMessageStream.mockImplementation(async function* () {
      yield {
        type: LlmEventType.Content,
        value: ++attempts === 1 ? 'discarded draft' : 'accepted answer',
      };
      yield { type: LlmEventType.Finished };
    });
    let stops = 0;
    hooks.fire.mockImplementation(async (event) =>
      event === HookEventName.Stop && ++stops === 1
        ? { decision: 'block', reason: 'Continue' }
        : undefined,
    );
    const textDeltas = {
      delta: vi.fn(),
      retract: vi.fn(async () => undefined),
    };
    await expect(
      runHostedHarnessTextTurn({ ...input, hooks: hooks.session, textDeltas }),
    ).resolves.toMatchObject({ text: 'accepted answer' });
    expect(textDeltas.delta).not.toHaveBeenCalled();
    expect(model.sendMessageStream).toHaveBeenCalledTimes(2);
  });

  it('streams text when the Hook catalog has no output policy', async () => {
    config([
      { type: LlmEventType.Content, value: 'answer' },
      { type: LlmEventType.Finished },
    ]);
    const hooks = hostedHooks([HookEventName.Notification]);
    const textDeltas = {
      delta: vi.fn(),
      retract: vi.fn(async () => undefined),
    };
    await runHostedHarnessTextTurn({
      ...input,
      hooks: hooks.session,
      textDeltas,
    });
    expect(textDeltas.delta).toHaveBeenCalledExactlyOnceWith('answer');
  });

  it('reconstructs after-Hook tool results after installing the authorized prompt runner', async () => {
    const model = config([{ type: LlmEventType.Finished }]);
    const responses: Part[] = [
      {
        functionResponse: {
          id: 'call-1',
          name: 'shell',
          response: { output: 'done' },
        },
      },
    ];
    const resumed = [...responses, { text: 'after-Hook context' }];
    const toolTurn = {
      execute: vi.fn(),
      consumeResults: vi.fn(),
      declarations: vi.fn().mockResolvedValue([]),
      setPromptHookRunner: vi.fn(),
      resumeHookResults: vi.fn().mockResolvedValue(resumed),
    };
    await runHostedHarnessTextTurn({
      ...input,
      resumeFromToolResults: responses,
      modelScope: {
        evaluate: vi.fn(),
        bindBudget: vi.fn(),
        beginMainAttempt: vi.fn(),
      },
      toolTurn,
    });
    expect(model.requests[0]).toEqual(resumed);
    expect(
      toolTurn.setPromptHookRunner.mock.invocationCallOrder[0],
    ).toBeLessThan(toolTurn.resumeHookResults.mock.invocationCallOrder[0]);
    expect(toolTurn.consumeResults).toHaveBeenCalledOnce();
  });

  it('keeps the first Stop inactive after ordinary tool rounds', async () => {
    const model = config([]);
    const hooks = hostedHooks();
    let round = 0;
    model.sendMessageStream.mockImplementation(async function* () {
      if (round++ === 0) {
        model.getHistory.mockReturnValue([
          {
            role: 'model',
            parts: [
              { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
            ],
          },
        ]);
        yield {
          type: LlmEventType.ToolCallRequest,
          value: { callId: 'call-1', name: 'read_file', args: {} },
        };
      } else {
        model.getHistory.mockReturnValue([
          { role: 'model', parts: [{ text: 'done' }] },
        ]);
        yield { type: LlmEventType.Content, value: 'done' };
      }
      yield { type: LlmEventType.Finished };
    });
    await runHostedHarnessTextTurn({
      ...input,
      hooks: hooks.session,
      toolTurn: {
        execute: vi.fn().mockResolvedValue([
          {
            functionResponse: {
              id: 'call-1',
              name: 'read_file',
              response: { output: 'read' },
            },
          },
        ]),
        consumeResults: vi.fn(),
        declarations: vi.fn().mockResolvedValue([]),
        setPromptHookRunner: vi.fn(),
      },
    });
    expect(
      hooks.fire.mock.calls
        .filter(([event]) => event === HookEventName.Stop)
        .map(([, , fields]) => fields['stop_hook_active']),
    ).toEqual([false]);
  });

  it.each(['decision', 'continue'] as const)(
    'uses durable model attempt identities and restores a Stop %s block chain across a tool restart',
    async (kind) => {
      const hooks = hostedHooks();
      const complete = (attemptId: string) =>
        Object.assign(vi.fn().mockResolvedValue(undefined), { attemptId });
      const modelScope = {
        evaluate: vi.fn(),
        bindBudget: vi.fn(),
        beginMainAttempt: vi
          .fn()
          .mockResolvedValueOnce(complete('turn:model-1'))
          .mockResolvedValueOnce(complete('turn:model-2'))
          .mockResolvedValueOnce(complete('turn:model-3')),
      };
      hooks.fire.mockImplementation(async (event) =>
        event === HookEventName.Stop
          ? kind === 'decision'
            ? { decision: 'block', reason: 'continue' }
            : { continue: false, stopReason: 'continue' }
          : undefined,
      );
      const first = config([]);
      let round = 0;
      first.sendMessageStream.mockImplementation(async function* () {
        if (round++ === 0)
          yield { type: LlmEventType.Content, value: 'initial answer' };
        else {
          first.getHistory.mockReturnValue([
            {
              role: 'model',
              parts: [
                { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
              ],
            },
          ]);
          yield {
            type: LlmEventType.ToolCallRequest,
            value: { callId: 'call-1', name: 'read_file', args: {} },
          };
        }
        yield { type: LlmEventType.Finished };
      });
      const toolTurn = {
        execute: vi
          .fn()
          .mockRejectedValue(new Error('restart after durable tool receipt')),
        consumeResults: vi.fn(),
        declarations: vi.fn().mockResolvedValue([]),
        setPromptHookRunner: vi.fn(),
        resumeHookResults: vi
          .fn()
          .mockImplementation(async (parts: Part[]) => parts),
      };
      await expect(
        runHostedHarnessTextTurn({
          ...input,
          hooks: hooks.session,
          modelScope,
          toolTurn,
        }),
      ).rejects.toThrow('restart after durable tool receipt');
      const initialStop = hooks.fire.mock.calls.find(
        ([event]) => event === HookEventName.Stop,
      )!;
      expect(initialStop[1]).toBe('turn:model-1');
      expect(initialStop[2]).toMatchObject({ stop_hook_active: false });
      vi.mocked(hooks.session.wasStopBlocked).mockResolvedValue(true);
      hooks.fire.mockReset().mockResolvedValue(undefined);
      config([
        { type: LlmEventType.Content, value: 'recovered answer' },
        { type: LlmEventType.Finished },
      ]);
      await runHostedHarnessTextTurn({
        ...input,
        hooks: hooks.session,
        modelScope,
        toolTurn,
        resumeFromToolResults: [
          {
            functionResponse: {
              id: 'call-1',
              name: 'read_file',
              response: { output: 'saved' },
            },
          },
        ],
      });
      const resumedStop = hooks.fire.mock.calls.find(
        ([event]) => event === HookEventName.Stop,
      )!;
      expect(hooks.session.wasStopBlocked).toHaveBeenCalledWith(input.promptId);
      expect(resumedStop[1]).toBe('turn:model-3');
      expect(resumedStop[2]).toMatchObject({ stop_hook_active: true });
    },
  );

  it('provides only Session conversation messages before model initialization and live history for native and Stop Hooks', async () => {
    const model = config([]);
    const hooks = hostedHooks([HookEventName.PreCompact]);
    let dispatcher: ManagedHookDispatcher;
    model.initialize.mockImplementation(async (options) => {
      dispatcher = options!.managedHookDispatcher!;
    });
    const live: Content[] = [
      { role: 'user', parts: [{ text: input.prompt }] },
      { role: 'model', parts: [{ text: 'live answer' }] },
    ];
    model.sendMessageStream.mockImplementation(async function* () {
      model.getHistory.mockReturnValue(live);
      await dispatcher.execute(
        HookEventName.PreCompact,
        nativeInput(HookEventName.PreCompact),
      );
      yield { type: LlmEventType.Content, value: 'live answer' };
      yield { type: LlmEventType.Finished };
    });
    await runHostedHarnessTextTurn({
      ...input,
      hooks: hooks.session,
      history: [
        {
          type: 'user',
          message: { role: 'user', parts: [{ text: 'prior question' }] },
          metadata: { secret: 'not context' },
        } as never,
        {
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'prior answer' }] },
        } as never,
        {
          type: 'system',
          message: { parts: [{ text: 'private implementation metadata' }] },
        } as never,
      ],
    });
    expect(
      hooks.fire.mock.calls.find(
        ([event]) => event === HookEventName.UserPromptSubmit,
      )![2]['messages'],
    ).toEqual([
      { role: 'user', parts: [{ text: 'prior question' }] },
      { role: 'model', parts: [{ text: 'prior answer' }] },
      { role: 'user', parts: [{ text: input.prompt }] },
    ]);
    for (const event of [HookEventName.PreCompact, HookEventName.Stop])
      expect(
        hooks.fire.mock.calls.find(([name]) => name === event)![2]['messages'],
      ).toEqual(live);
    live[1].parts![0].text = 'later mutation';
    expect(
      hooks.fire.mock.calls.find(([event]) => event === HookEventName.Stop)![2][
        'messages'
      ],
    ).toEqual([
      { role: 'user', parts: [{ text: input.prompt }] },
      { role: 'model', parts: [{ text: 'live answer' }] },
    ]);
  });

  it('installs live messages for tool callbacks and clears the provider when the turn exits', async () => {
    const hooks = hostedHooks();
    const model = config([]);
    let provider: (() => Array<Record<string, unknown>>) | undefined;
    vi.mocked(hooks.session.setMessagesProvider).mockImplementation((value) => {
      provider = value;
    });
    model.sendMessageStream.mockImplementation(async function* () {
      model.getHistory.mockReturnValue([
        {
          role: 'user',
          parts: [{ text: 'Stop continuation not yet projected' }],
        },
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
          ],
        },
      ]);
      yield {
        type: LlmEventType.ToolCallRequest,
        value: { callId: 'call-1', name: 'read_file', args: {} },
      };
      yield { type: LlmEventType.Finished };
    });
    const toolTurn = {
      execute: vi.fn(async () => {
        expect(provider?.()).toEqual(model.getHistory());
        expect(provider?.()[0]).toMatchObject({
          parts: [{ text: 'Stop continuation not yet projected' }],
        });
        throw new Error('tool exit');
      }),
      consumeResults: vi.fn(),
      declarations: vi.fn().mockResolvedValue([]),
      setPromptHookRunner: vi.fn(),
    };
    await expect(
      runHostedHarnessTextTurn({ ...input, hooks: hooks.session, toolTurn }),
    ).rejects.toThrow('tool exit');
    expect(provider).toBeUndefined();
    expect(hooks.session.setMessagesProvider).toHaveBeenLastCalledWith(
      undefined,
    );
  });

  it.each([false, true])(
    'settles a post-tool Hook stop before another model request (resume=%s)',
    async (resume) => {
      const hooks = hostedHooks();
      const model = config([]);
      const responses: Part[] = [
        {
          functionResponse: {
            id: 'call-1',
            name: 'read_file',
            response: { output: 'original physical result' },
          },
        },
      ];
      model.sendMessageStream.mockImplementation(async function* () {
        model.getHistory.mockReturnValue([
          {
            role: 'model',
            parts: [
              { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
            ],
          },
        ]);
        yield {
          type: LlmEventType.ToolCallRequest,
          value: { callId: 'call-1', name: 'read_file', args: {} },
        };
        yield { type: LlmEventType.Finished };
      });
      const toolTurn = {
        hookStopReason: undefined as string | undefined,
        execute: vi.fn(async () => {
          toolTurn.hookStopReason = 'Stopped after tools.';
          return responses;
        }),
        resumeHookResults: vi.fn(async () => {
          toolTurn.hookStopReason = 'Stopped after tools.';
          return responses;
        }),
        consumeResults: vi.fn(),
        declarations: vi.fn().mockResolvedValue([]),
        setPromptHookRunner: vi.fn(),
      };
      await expect(
        runHostedHarnessTextTurn({
          ...input,
          hooks: hooks.session,
          toolTurn,
          ...(resume ? { resumeFromToolResults: responses } : {}),
        }),
      ).resolves.toEqual({
        text: 'Stopped after tools.',
        parts: [{ text: 'Stopped after tools.' }],
        model: 'test-model',
      });
      expect(model.sendMessageStream).toHaveBeenCalledTimes(resume ? 0 : 1);
      expect(toolTurn.consumeResults).not.toHaveBeenCalled();
      expect(
        hooks.fire.mock.calls.some(([event]) => event === HookEventName.Stop),
      ).toBe(false);
      expect(responses[0].functionResponse?.response).toEqual({
        output: 'original physical result',
      });
    },
  );
});

it.each(['decision', 'continue'] as const)(
  'consumes recovered tool results before Stop %s continuation without consuming them twice',
  async (kind) => {
    const model = config([{ type: LlmEventType.Finished }]);
    const hooks = hostedHooks();
    const order: string[] = [];
    let stops = 0;
    model.sendMessageStream.mockImplementation(async function* () {
      order.push('model');
      yield { type: LlmEventType.Finished };
    });
    hooks.fire.mockImplementation(async (event) => {
      if (event !== HookEventName.Stop) return undefined;
      order.push('stop');
      if (++stops === 1)
        return kind === 'decision'
          ? { decision: 'block', reason: 'Continue' }
          : { continue: false, stopReason: 'Continue' };
      return undefined;
    });
    const toolTurn = {
      execute: vi.fn(),
      consumeResults: vi.fn(async () => {
        order.push('consume');
      }),
      declarations: vi.fn(async () => []),
      setPromptHookRunner: vi.fn(),
      resumeHookResults: vi.fn(async (parts: readonly Part[]) => [...parts]),
    };
    await runHostedHarnessTextTurn({
      ...input,
      hooks: hooks.session,
      toolTurn,
      resumeFromToolResults: [
        {
          functionResponse: {
            id: 'original',
            name: 'read_file',
            response: { output: 'saved' },
          },
        },
      ],
    });
    expect(order).toEqual(['model', 'consume', 'stop', 'model', 'stop']);
    expect(model.sendMessageStream.mock.calls[1][0]).toEqual([
      { text: 'Continue' },
    ]);
    expect(toolTurn.consumeResults).toHaveBeenCalledOnce();
    expect(toolTurn.execute).not.toHaveBeenCalled();
    expect(
      hooks.fire.mock.calls
        .filter(([event]) => event === HookEventName.Stop)
        .map(([, , fields]) => fields['stop_hook_active']),
    ).toEqual([false, true]);
  },
);

describe('Hosted Harness resume and retraction', () => {
  beforeEach(() => vi.clearAllMocks());

  function configWithTools(
    events: Array<{
      type: LlmEventType;
      value?: unknown;
      isContinuation?: boolean;
    }>,
    modelParts: unknown[],
  ) {
    const tools = new Set(['run_shell_command']);
    const requests: unknown[] = [];
    const types: unknown[] = [];
    state.config = {
      initialize: vi.fn(async () => undefined),
      getModelsConfig: () => ({ getCurrentAuthType: () => 'test-auth' }),
      refreshAuth: vi.fn(async () => undefined),
      getToolRegistry: () => ({
        warmAll: vi.fn(async () => undefined),
        getAllTools: () => [...tools].map((name) => ({ name })),
        unregisterTool: vi.fn((name: string) => tools.delete(name)),
        getFunctionDeclarations: () => [...tools],
      }),
      getLlmClient: () => ({
        setTools: vi.fn(async () => undefined),
        getChat: () => ({
          setHistory: vi.fn(),
          setTools: vi.fn(async () => undefined),
        }),
        getHistory: () => [{ role: 'model', parts: modelParts }],
        async *sendMessageStream(
          request: unknown,
          _signal: unknown,
          _promptId: unknown,
          options: unknown,
        ) {
          requests.push(request);
          types.push(options);
          for (const event of events) yield event;
        },
      }),
      getModel: () => 'test-model',
      setUserMemory: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    };
    return { requests, types };
  }

  it('resumes from journaled tool results as a tool-result request', async () => {
    const resumeParts = [
      {
        functionResponse: {
          id: 'call-1',
          name: 'write_file',
          response: { ok: true },
        },
      },
    ];
    const { requests, types } = configWithTools(
      [
        { type: LlmEventType.Content, value: 'recovered' },
        { type: LlmEventType.Finished },
      ],
      [{ text: 'recovered' }],
    );
    const toolTurn = {
      execute: vi.fn(),
      consumeResults: vi.fn(async () => undefined),
      declarations: async () => [],
      setPromptHookRunner: vi.fn(),
    };
    const result = await runHostedHarnessTextTurn({
      ...input,
      toolTurn,
      resumeFromToolResults: resumeParts,
    });
    expect(result.text).toBe('recovered');
    expect(requests[0]).toStrictEqual(resumeParts);
    expect(types[0]).toMatchObject({
      type: SendMessageType.ToolResult,
    });
    expect(toolTurn.consumeResults).toHaveBeenCalledOnce();
    expect(toolTurn.execute).not.toHaveBeenCalled();
  });

  it('retracts a published model attempt before the replay resumes', async () => {
    const model = config([
      { type: LlmEventType.Content, value: 'orphaned prefix' },
      { type: LlmEventType.Retry, isContinuation: false },
      { type: LlmEventType.Content, value: 'second attempt' },
      { type: LlmEventType.Finished },
    ]);
    const textDeltas = {
      delta: vi.fn(async () => undefined),
      messageComplete: vi.fn(async () => undefined),
      retract: vi.fn(async () => undefined),
    };
    await expect(
      runHostedHarnessTextTurn({ ...input, textDeltas }),
    ).resolves.toMatchObject({ text: 'second attempt' });
    expect(textDeltas.retract).toHaveBeenCalledOnce();
    // The replay's text is published under the fresh identity only after the
    // retraction, so the orphaned prefix never glues into it (#13319).
    expect(textDeltas.retract.mock.invocationCallOrder[0]).toBeLessThan(
      textDeltas.delta.mock.invocationCallOrder[1],
    );
    // The send opts out of continuation recovery: a post-delivery cut must
    // replay the original request, or the retry has nothing clean to publish
    // over the retracted prefix. Deleting this option silently regresses to
    // the glued transcript (#13319).
    expect(model.sendOptions[0]).toMatchObject({
      retractDeliveredOutputOnRetry: true,
    });
  });

  it('retracts a published model fallback before the fallback resumes', async () => {
    config([
      { type: LlmEventType.Content, value: 'orphaned prefix' },
      { type: LlmEventType.ModelFallback },
      { type: LlmEventType.Content, value: 'second attempt' },
      { type: LlmEventType.Finished },
    ]);
    const textDeltas = {
      delta: vi.fn(async () => undefined),
      messageComplete: vi.fn(async () => undefined),
      retract: vi.fn(async () => undefined),
    };
    await expect(
      runHostedHarnessTextTurn({ ...input, textDeltas }),
    ).resolves.toMatchObject({ text: 'second attempt' });
    expect(textDeltas.retract).toHaveBeenCalledOnce();
  });

  it('keeps the text buffer across a continuation retry', async () => {
    config([
      { type: LlmEventType.Content, value: 'published prefix' },
      { type: LlmEventType.Retry, isContinuation: true },
      { type: LlmEventType.Content, value: ' continued' },
      { type: LlmEventType.Finished },
    ]);
    const textDeltas = {
      delta: vi.fn(async () => undefined),
      messageComplete: vi.fn(async () => undefined),
      retract: vi.fn(async () => undefined),
    };
    await expect(
      runHostedHarnessTextTurn({ ...input, textDeltas }),
    ).resolves.toMatchObject({ text: 'published prefix continued' });
    expect(textDeltas.retract).not.toHaveBeenCalled();
  });

  it('still discards an unpublished abandoned attempt', async () => {
    config([
      { type: LlmEventType.Content, value: 'first attempt' },
      { type: LlmEventType.Retry, isContinuation: false },
      { type: LlmEventType.Content, value: 'final answer' },
      { type: LlmEventType.Finished },
    ]);
    const textDeltas = {
      delta: vi.fn(async () => undefined),
      messageComplete: vi.fn(async () => undefined),
      retract: vi.fn(async () => undefined),
    };
    await expect(
      runHostedHarnessTextTurn({ ...input, textDeltas }),
    ).resolves.toMatchObject({ text: 'final answer' });
    // retract() is a no-op when nothing is published, but the stream owns
    // that decision: the turn still defers to it.
    expect(textDeltas.retract).toHaveBeenCalledOnce();
  });

  it('commits every Content chunk through the delta stream as it arrives', async () => {
    config([
      { type: LlmEventType.Content, value: 'chunk one' },
      { type: LlmEventType.Content, value: ' and two' },
      { type: LlmEventType.Finished },
    ]);
    const textDeltas = {
      delta: vi.fn(async (_text: string) => undefined),
      messageComplete: vi.fn(async () => undefined),
      retract: vi.fn(async () => undefined),
    };
    await expect(
      runHostedHarnessTextTurn({ ...input, textDeltas }),
    ).resolves.toMatchObject({ text: 'chunk one and two' });
    expect(textDeltas.delta.mock.calls.map((call) => call[0])).toEqual([
      'chunk one',
      ' and two',
    ]);
  });
});
