/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionArtifactRuntime } from '../../session/artifacts/sessionArtifactRuntime.js';
import {
  makeFakeConfig,
  ASK_USER_TOOL_NAME,
  runLogger,
  createUserMessage,
  ToolConfirmationOutcome,
  type Model,
  type QueryEvent,
} from '@qwen-code/core';
import type {
  SessionExecutionState,
  SessionExecutionUpdate,
} from '../../session/localSession.js';
import type {
  SessionChange,
  SessionMessageInput,
  SessionSubmitOptions,
} from '../../session/sessionPort.js';
import type { SessionState, SessionUpdate } from '../../session/session.js';
import { createPermissionQueueStore } from '../permissions/permissionQueueStore.js';
import { createSessionUiBinding } from './prepareSessionUi.js';
import { StreamingState, type HistoryItemWithoutId } from '../types.js';
import { NOOP_RUNTIME_PROJECTION } from '../hooks/localSession.shared.js';
import { testProviderModel } from '../../../../core/src/test-utils/model-resolution.js';
import {
  LocalTuiSessionAdapter,
  type LocalTuiSessionSource,
} from './localTuiSessionAdapter.js';

function fixture(overrides: Partial<LocalTuiSessionSource> = {}) {
  const config = makeFakeConfig();
  const permissionQueue = createPermissionQueueStore();
  const messages = [createUserMessage('existing', { uuid: 'existing' })];
  const runtime = {
    submitUserInput: vi.fn<LocalTuiSessionSource['runtime']['submitUserInput']>(
      async () => {},
    ),
    submitQuery: vi.fn<LocalTuiSessionSource['runtime']['submitQuery']>(
      async () => {},
    ),
    dispose: vi.fn(async () => {}),
    cancelOngoingRequest: vi.fn(),
    handlePermissionModeChange: vi.fn(async () => {}),
    getIsResponding: (): boolean =>
      owner.state.activity?.isResponding ?? owner.execution.isResponding,
    activeModelQueue: null,
    getMessages: vi.fn(() => messages),
    getConversationMessages: vi.fn(() => messages),
    setMessages: vi.fn(),
    replaceMessages: vi.fn<LocalTuiSessionSource['runtime']['replaceMessages']>(
      async () => {},
    ),
  };
  const manager = config.getModelProviderManager();
  const operations = {
    restore: vi.fn(async (_input: unknown) => true),
    interrupt: runtime.cancelOngoingRequest,
    setModel: vi.spyOn(config, 'setModel').mockImplementation(async (model) => {
      owner.state = { ...owner.state, model };
      return true;
    }),
    setPermissionMode: vi
      .spyOn(config, 'setPermissionMode')
      .mockImplementation((mode) => {
        owner.state = { ...owner.state, permissionMode: mode };
      }),
    setTitle: vi
      .spyOn(config, 'persistSessionTitle')
      .mockImplementation(async (title) => {
        owner.state = { ...owner.state, title };
      }),
    refreshModels: vi
      .spyOn(manager, 'listModels')
      .mockResolvedValue([testProviderModel('m')]),
    setContextWindow: vi.spyOn(manager, 'setModelConfig').mockReturnValue(true),
  };
  let owner: {
    config: typeof config;
    runtime: typeof runtime;
    state: Omit<SessionState, 'access' | 'models' | 'approvals'>;
    execution: SessionExecutionState;
  } = {
    config,
    runtime,
    state: {
      model: 'initial',
      permissionMode: 'default',
      title: null,
      modeChoices: ['default'],
      initialMessages: { pendingAssistantText: '', activityStatus: 'idle' },
      initialHistory: [],
      pendingHistory: [],
      historyAvailable: true,
    },
    execution: {
      canSubmitMessage: true,
      isResponding: false,
      pendingToolCalls: [],
    },
  };
  vi.spyOn(config, 'getModel').mockImplementation(() => owner.state.model);
  vi.spyOn(config, 'getPermissionMode').mockImplementation(
    () => owner.state.permissionMode,
  );
  vi.spyOn(config.topicState, 'getTopic').mockImplementation(
    () => owner.state.title ?? undefined,
  );
  vi.spyOn(manager, 'getModel').mockImplementation(async (key) =>
    testProviderModel(key),
  );
  vi.spyOn(manager, 'getModelConfig').mockImplementation(() => ({
    reasoning: { effort: owner.state.reasoningEffort },
    context: { contextWindow: owner.state.contextWindow },
  }));
  const readSource = (): LocalTuiSessionSource => ({
    config: owner.config,
    runtime: { ...owner.runtime, toolRegistry: owner.config.toolRegistry },
    permissionQueue,
    isReadyForInput: () => owner.execution.canSubmitMessage,
    isClosed: () => false,
    restoreSession: operations.restore,
    model: testProviderModel(owner.state.model),
    history: owner.state
      .initialHistory as unknown as LocalTuiSessionSource['history'],
    projection: {
      ...NOOP_RUNTIME_PROJECTION,
      getStreamingState: () =>
        (owner.state.activity?.status as StreamingState) ??
        (owner.state.initialMessages.activityStatus === 'running'
          ? StreamingState.Responding
          : StreamingState.Idle),
      getToolCalls: () =>
        owner.execution.pendingToolCalls as ReturnType<
          LocalTuiSessionSource['projection']['getToolCalls']
        >,
      getSnapshot: () => ({
        lastTurnEnd: null,
        streamingState:
          (owner.state.activity?.status as StreamingState) ??
          (owner.state.initialMessages.activityStatus === 'running'
            ? StreamingState.Responding
            : StreamingState.Idle),
        isModelTurnActive:
          owner.state.activity?.isModelTurnActive ??
          owner.execution.isResponding,
        thought: owner.state.activity?.thought ?? null,
        pendingHistoryItems: owner.state
          .pendingHistory as unknown as HistoryItemWithoutId[],
        pendingToolCalls: owner.execution.pendingToolCalls as ReturnType<
          LocalTuiSessionSource['projection']['getToolCalls']
        >,
      }),
    },
    ...overrides,
  });
  const adapter = new LocalTuiSessionAdapter(config, readSource);
  void adapter.start();
  return {
    config,
    runtime,
    operations,
    permissionQueue,
    adapter,
    readSource,
    get owner() {
      return owner;
    },
    update(next: Partial<typeof owner>) {
      owner = { ...owner, ...next };
    },
  };
}
const message: SessionMessageInput = {
  id: 'remote-original',
  text: 'look',
  content: [
    { type: 'text', text: 'look' },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
    },
  ],
};
const bridgeOptions: SessionSubmitOptions = { origin: { kind: 'bridge' } };
const event: QueryEvent = {
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'answer' },
  },
};
afterEach(() => vi.restoreAllMocks());

describe('local TUI session adapter', () => {
  it('owns automatic title settings through the native session interface', async () => {
    const h = fixture();
    expect(h.adapter.automaticTitleEnabled).toBe(true);
    await h.adapter.applySettings({ automaticTitleEnabled: false });
    expect(h.adapter.automaticTitleEnabled).toBe(false);
    expect(h.adapter.automaticTitleEnabled).toBe(false);
    await h.adapter.applySettings({ automaticTitleEnabled: true });
    expect(h.adapter.automaticTitleEnabled).toBe(true);
    expect(h.operations.setTitle).not.toHaveBeenCalled();
  });
  it('clears the binding-scoped automatic title override when the native owner releases', async () => {
    const h = fixture();
    await h.adapter.applySettings({ automaticTitleEnabled: false });
    await h.adapter.release();
    expect(h.adapter.automaticTitleEnabled).toBe(true);
  });
  it('delegates title generation to the existing native generator without scheduling it', async () => {
    const core = await import('@qwen-code/core');
    const generate = vi
      .spyOn(core, 'generateRemoteSessionTitleForMessages')
      .mockResolvedValueOnce('Generated title');
    const h = fixture();
    await expect(h.adapter.generateTitle()).resolves.toBe('Generated title');
    expect(generate).toHaveBeenCalledExactlyOnceWith({
      config: h.config,
      messages: h.runtime.getConversationMessages(),
    });
    expect(h.operations.setTitle).not.toHaveBeenCalled();
  });
  it('discards a title generated for a released native binding', async () => {
    const core = await import('@qwen-code/core');
    let finish!: (title: string) => void;
    vi.spyOn(
      core,
      'generateRemoteSessionTitleForMessages',
    ).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const h = fixture();
    const pending = h.adapter.generateTitle();
    await h.adapter.release();
    finish('old title');
    await expect(pending).resolves.toBeNull();
  });
  it('publishes changed execution facts and reads the original live guard without another render', () => {
    const h = fixture();
    let responding = false;
    const activity = {
      status: 'idle' as const,
      isModelTurnActive: false,
      thought: null,
      get isResponding() {
        return responding;
      },
    };
    h.update({ state: { ...h.owner.state, activity } });
    h.adapter.sync();
    const updates: SessionUpdate[] = [];
    h.adapter.observeUpdates((update) => updates.push(update));
    const before = h.adapter.getState();
    responding = true;
    expect(h.adapter.getState().activity!.isResponding).toBe(true);
    expect(before.activity!.isResponding).toBe(false);
    h.adapter.sync();
    expect(updates).toHaveLength(2);
    h.adapter.sync();
    expect(updates).toHaveLength(2);
  });
  it.each([false, true])(
    'reads actual execution after input returns with responding=%s',
    async (isResponding) => {
      const h = fixture();
      const binding = createSessionUiBinding(h.adapter, 'local');
      binding.bindHistoryWriter(vi.fn());
      const stop = binding.uiSession.observeSession();
      h.runtime.submitUserInput.mockImplementationOnce(async () => {
        h.update({ execution: { ...h.owner.execution, isResponding } });
      });
      try {
        await binding.uiSession.submitMessage(message);
        expect(binding.uiSession.getIsResponding()).toBe(isResponding);
        expect(binding.uiSession.getSnapshot().workerStatus).toBe(
          isResponding ? 'running' : 'idle',
        );
      } finally {
        stop();
        await binding.dispose();
      }
    },
  );

  it('notifies message observers when committed native activity changes without a terminal event', async () => {
    const h = fixture();
    const changes: SessionChange[] = [];
    h.adapter.observe((change) => changes.push(change));
    for (const activityStatus of ['running', 'idle']) {
      h.update({
        state: {
          ...h.owner.state,
          initialMessages: { pendingAssistantText: '', activityStatus },
        },
      });
      h.adapter.sync();
      if (activityStatus === 'running') h.adapter.handleQueryEvent(event);
    }
    expect(changes.filter((change) => change.type === 'status')).toEqual([
      { type: 'status', activityStatus: 'running', transition: true },
      { type: 'status', activityStatus: 'idle', transition: true },
    ]);
    const current = vi.fn();
    h.adapter.observe(current)();
    expect(current).toHaveBeenCalledExactlyOnceWith({
      type: 'snapshot',
      reason: 'observe',
      state: expect.objectContaining({
        pendingAssistantText: '',
        activityStatus: 'idle',
      }),
    });
  });

  it('does not overwrite a live request with unchanged committed activity', () => {
    const h = fixture();
    const changes: SessionChange[] = [];
    h.adapter.observe((change) => changes.push(change));
    h.adapter.handleQueryEvent({ type: 'request_start' });
    h.adapter.sync();
    expect(changes.filter((change) => change.type === 'status')).toEqual([
      { type: 'status', activityStatus: 'running', transition: true },
    ]);
  });

  it.each(['released', 'rebound', 'restored', 'owner changed'] as const)(
    'does not publish late input activity after the session is %s',
    async (change) => {
      const h = fixture();
      let complete!: () => void;
      h.runtime.submitUserInput.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
      );
      const changes: SessionChange[] = [];
      h.adapter.observe((update) => changes.push(update));
      const submitted = h.adapter.submitMessage(message);
      if (change === 'released' || change === 'rebound') {
        await h.adapter.release();
        if (change === 'rebound') await h.adapter.start();
      } else if (change === 'restored') {
        vi.spyOn(h.config, 'getSessionId').mockReturnValue('restored-id');
        h.adapter.sync();
      } else {
        h.update({ config: makeFakeConfig() });
      }
      changes.length = 0;
      complete();
      await submitted;
      expect(changes.some((update) => update.type === 'status')).toBe(false);
    },
  );

  it.each([true, false])(
    'preserves the native model save result %s',
    async (saved) => {
      const h = fixture();
      h.operations.setModel.mockResolvedValueOnce(saved);
      await expect(
        h.adapter.setModel('next', undefined, undefined, {
          sessionOnly: false,
        }),
      ).resolves.toBe(saved);
      expect(h.operations.setModel).toHaveBeenCalledExactlyOnceWith(
        'next',
        false,
      );
    },
  );
  it('preserves synchronous permission validation and asynchronous binding failures', async () => {
    const h = fixture();
    h.operations.setPermissionMode.mockImplementationOnce(() => {
      throw new Error('mode unavailable');
    });
    const metadata = { trigger: 'shortcut' as const };
    expect(() => h.adapter.setPermissionMode('yolo', metadata)).toThrow(
      'mode unavailable',
    );
    expect(h.operations.setPermissionMode).toHaveBeenCalledExactlyOnceWith(
      'yolo',
      metadata,
    );
    await h.adapter.release();
    await expect(h.adapter.setPermissionMode('yolo', metadata)).rejects.toThrow(
      'released',
    );
    expect(h.operations.setPermissionMode).toHaveBeenCalledOnce();
  });
  it('forwards the original local input context without rebuilding the queued batch', async () => {
    const h = fixture();
    const options: SessionSubmitOptions = {
      pastedContents: {
        1: {
          id: 1,
          type: 'image',
          content: '',
          sourcePath: '/local/image.png',
        },
      },
      commandMode: 'bash',
      queuedCommands: [
        { prompt: 'look', commandMode: 'bash', uuid: message.id },
      ],
      suppressWorkflowKeyword: true,
    };
    await h.adapter.submitMessage(message, options);
    expect(h.runtime.submitUserInput).toHaveBeenCalledWith(
      message.text,
      expect.objectContaining(options),
    );
    expect(h.runtime.submitUserInput.mock.calls[0][1]?.queuedCommands).toBe(
      options.queuedCommands,
    );
    expect(h.runtime.submitUserInput.mock.calls[0][1]?.pastedContents).toBe(
      options.pastedContents,
    );
  });

  it('uses the original local input history when consumed by the common UI binding', async () => {
    const h = fixture();
    const binding = createSessionUiBinding(h.adapter);
    const history = vi.fn<(item: HistoryItemWithoutId) => void>();
    binding.bindHistoryWriter(history);
    const stop = binding.uiSession.observeSession();
    h.runtime.submitUserInput.mockImplementation(async (text, options) => {
      if (!options?.userMessage?.uuid) throw new Error('Missing input UUID');
      history({ type: 'user', text });
      h.adapter.handleLocalUserMessage({
        uuid: options.userMessage.uuid,
        text,
      });
    });
    try {
      await binding.uiSession.submitMessage({
        id: 'typed-original',
        text: 'typed',
        content: [{ type: 'text', text: 'typed' }],
      });
      expect(history.mock.calls).toEqual([[{ type: 'user', text: 'typed' }]]);
      expect(h.runtime.submitUserInput).toHaveBeenCalledOnce();
      expect(h.runtime.submitQuery).not.toHaveBeenCalled();
    } finally {
      stop();
      await binding.dispose();
    }
  });

  it('reads local thinking and text without writing thinking history a second time', async () => {
    const h = fixture();
    const binding = createSessionUiBinding(h.adapter);
    const history = vi.fn<(item: HistoryItemWithoutId) => void>();
    binding.bindHistoryWriter(history);
    const stop = binding.uiSession.observeSession();
    try {
      h.adapter.handleQueryEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: '**Checking**\nDetails' },
        },
      });
      h.adapter.handleQueryEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'answer' },
        },
      });
      expect(binding.uiSession.getSnapshot().pendingAssistantText).toBe(
        'answer',
      );
      expect(history).not.toHaveBeenCalled();
    } finally {
      stop();
      await binding.dispose();
    }
  });
  it.each([undefined, { kind: 'human' } as const])(
    'routes human origin %s through the original local input entry',
    async (origin) => {
      const h = fixture();
      h.update({
        execution: { ...h.owner.execution, canSubmitMessage: false },
      });
      await h.adapter.submitMessage(message, {
        origin,
        timestamp: '2026-11-02T12:00:00Z',
      });
      expect(h.runtime.submitUserInput).toHaveBeenCalledExactlyOnceWith(
        'look',
        {
          hideFromDisplay: undefined,
          userMessage: { uuid: message.id, timestamp: '2026-11-02T12:00:00Z' },
          contentBlocks: [
            { type: 'text', text: 'look' },
            {
              type: 'image',
              source: {
                type: 'base64',
                mediaType: 'image/png',
                data: 'aW1hZ2U=',
              },
            },
          ],
        },
      );
      expect(h.runtime.submitQuery).not.toHaveBeenCalled();
    },
  );

  it('starts observation once and lets consumers unsubscribe independently', async () => {
    const h = fixture();
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = h.adapter.observeExecution(first);
    const stopSecond = h.adapter.observeExecution(second);
    const subscribe = vi.spyOn(h.permissionQueue, 'subscribe');
    await h.adapter.start();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(subscribe).not.toHaveBeenCalled();
    stopFirst();
    h.adapter.handleQueryEvent(event);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    await h.adapter.submitMessage({
      id: 'local-after-unsubscribe',
      text: 'continue',
      content: [{ type: 'text', text: 'continue' }],
    });
    expect(h.runtime.submitUserInput).toHaveBeenCalledOnce();
    stopSecond();
    expect(h.adapter.getState().access.status).toBe('connected');
    expect(h.runtime.dispose).not.toHaveBeenCalled();
  });

  it('publishes input preparation once when the local input callback observes the submitted identity', async () => {
    const h = fixture();
    h.runtime.submitUserInput.mockImplementationOnce(async () => {
      h.adapter.handleLocalUserMessage({
        uuid: message.id,
        text: message.text,
      });
    });
    const changes: SessionChange[] = [];
    h.adapter.observe((change) => changes.push(change));
    await h.adapter.submitMessage(message);
    expect(h.runtime.submitUserInput).toHaveBeenCalledOnce();
    expect(
      changes.filter((change) => change.type === 'input_prepared'),
    ).toHaveLength(1);
  });
  it('does not observe permissions or process events before start', async () => {
    const h = fixture();
    await h.adapter.release();
    const subscribe = vi.spyOn(h.permissionQueue, 'subscribe');
    const adapter = new LocalTuiSessionAdapter(h.config, h.readSource);
    adapter.sync();
    adapter.handleQueryEvent(event);
    adapter.handleLocalUserMessage({ uuid: 'dormant', text: 'ignored' });
    expect(subscribe).not.toHaveBeenCalled();
    expect(adapter.getState().access.status).toBe('disconnected');
    await expect(adapter.submitMessage(message)).rejects.toThrow('released');
    await adapter.start();
    expect(subscribe).toHaveBeenCalledOnce();
    const changes: SessionChange[] = [];
    adapter.observe((change) => changes.push(change));
    expect(changes).toHaveLength(1);
  });
  it('uses the existing executor once and preserves remote identity, content, origin and retry options', async () => {
    const h = fixture();
    const before = structuredClone(message);
    const options = {
      ...bridgeOptions,
      timestamp: '2026-10-30T01:02:03.000Z',
      hideFromDisplay: true,
    };
    const changes: SessionChange[] = [];
    const execution: SessionExecutionUpdate[] = [];
    h.adapter.observe((change) => changes.push(change));
    h.adapter.observeExecution((update) => execution.push(update));
    await h.adapter.submitMessage(message, options);
    expect(h.runtime.submitQuery).toHaveBeenCalledExactlyOnceWith('look', {
      hideFromDisplay: true,
      emitInputEvent: false,
      userMessage: { uuid: message.id, timestamp: options.timestamp },
      contentBlocks: [
        { type: 'text', text: 'look' },
        {
          type: 'image',
          source: { type: 'base64', mediaType: 'image/png', data: 'aW1hZ2U=' },
        },
      ],
      useInputProcessor: true,
      queuedCommands: [
        {
          prompt: expect.any(Array),
          preExpansionPrompt: 'look',
          commandMode: 'prompt',
          uuid: message.id,
          origin: bridgeOptions.origin,
          bridgeOrigin: true,
          skipSlashCommands: true,
        },
      ],
    });
    expect(message).toEqual(before);
    expect(changes.map((change) => change.type)).toEqual([
      'snapshot',
      'input_prepared',
      'send_started',
      'send_finished',
      'status',
    ]);
    expect(execution.map((update) => update.type)).toEqual(['snapshot']);
  });

  it('observes prepared keyboard input without resubmitting or generating another identity', () => {
    const h = fixture();
    const changes: SessionChange[] = [];
    h.adapter.observe((change) => changes.push(change));
    const contentBlocks = [{ type: 'text' as const, text: 'typed' }];
    h.adapter.handleLocalUserMessage({
      uuid: 'typed-original',
      text: 'typed',
      contentBlocks,
    });
    expect(changes.at(-1)).toEqual({
      type: 'input_prepared',
      source: { delivery: 'live', hasDisplayHistory: true },
      message: { id: 'typed-original', text: 'typed', content: contentBlocks },
    });
    expect(h.runtime.submitQuery).not.toHaveBeenCalled();
  });

  it('preserves normalized content blocks including cache hints', async () => {
    const h = fixture();
    const content = [
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.test/a.png' },
        cacheControl: { type: 'ephemeral', ttl: '5m' },
      },
    ];
    await h.adapter.submitMessage({ ...message, content }, bridgeOptions);
    expect(h.runtime.submitQuery.mock.calls[0]![1]!.contentBlocks).toEqual(
      content,
    );
  });

  it('keeps the original plain-text input path', async () => {
    const h = fixture();
    await h.adapter.submitMessage(
      {
        id: 'plain',
        text: '/compact',
        content: [{ type: 'text', text: '/compact' }],
      },
      bridgeOptions,
    );
    expect(h.runtime.submitQuery).toHaveBeenCalledWith(
      '/compact',
      expect.objectContaining({
        contentBlocks: undefined,
        queuedCommands: [
          expect.objectContaining({
            prompt: '/compact',
            preExpansionPrompt: '/compact',
            uuid: 'plain',
            bridgeOrigin: true,
            skipSlashCommands: true,
          }),
        ],
      }),
    );
  });

  it('does not execute busy or invalid input and does not create another queue', async () => {
    const h = fixture();
    h.update({ execution: { ...h.owner.execution, canSubmitMessage: false } });
    await expect(
      h.adapter.submitMessage(message, bridgeOptions),
    ).rejects.toThrow('not ready');
    h.update({ execution: { ...h.owner.execution, canSubmitMessage: true } });
    await expect(
      h.adapter.submitMessage({
        ...message,
        content: [{ type: 'tool_result' }],
      }),
    ).rejects.toThrow('Unsupported');
    await h.adapter.submitMessage({ ...message, content: [] });
    expect(h.runtime.submitQuery).not.toHaveBeenCalled();
  });

  it.each(['human', 'bridge'] as const)(
    'retains %s execution failures and reports the actual activity after sending',
    async (kind) => {
      const h = fixture();
      const failure = new Error('original failure');
      (kind === 'bridge'
        ? h.runtime.submitQuery
        : h.runtime.submitUserInput
      ).mockRejectedValueOnce(failure);
      const changes: SessionChange[] = [];
      h.adapter.observe((change) => changes.push(change));
      await expect(
        h.adapter.submitMessage(message, { origin: { kind } }),
      ).rejects.toBe(failure);
      expect(changes.slice(-3)).toEqual([
        {
          type: 'send_failed',
          messageId: message.id,
          errorMessage: 'original failure',
        },
        { type: 'send_finished', messageId: message.id },
        { type: 'status', activityStatus: 'idle', transition: true },
      ]);
      h.adapter.handleLocalUserMessage({
        uuid: message.id,
        text: message.text,
      });
      expect(
        changes.filter((change) => change.type === 'input_prepared'),
      ).toHaveLength(2);
    },
  );

  it('uses the latest owner operations and preserves replacement failure promises', async () => {
    const h = fixture();
    const nextSubmit = vi.fn<LocalTuiSessionSource['runtime']['submitQuery']>(
      async () => {},
    );
    h.update({
      runtime: { ...h.runtime, submitQuery: nextSubmit },
      state: { ...h.owner.state, model: 'latest' },
    });
    await h.adapter.submitMessage(message, bridgeOptions);
    expect(nextSubmit).toHaveBeenCalledOnce();
    expect(h.runtime.submitQuery).not.toHaveBeenCalled();
    expect(h.adapter.getState().model).toBe('latest');
    const failure = new Error('replace failed');
    h.runtime.replaceMessages.mockRejectedValueOnce(failure);
    await expect(h.adapter.replaceMessages([])).rejects.toBe(failure);
    h.update({ config: makeFakeConfig() });
    await expect(h.adapter.submitMessage(message)).rejects.toThrow(
      'binding has changed',
    );
    await h.adapter.release();
    expect(h.runtime.dispose).not.toHaveBeenCalled();
  });

  it('keeps execution events intact, ordered during reentry, and detachable', () => {
    const h = fixture();
    const first: SessionExecutionUpdate[] = [];
    const second: SessionExecutionUpdate[] = [];
    h.adapter.observeExecution((update) => {
      first.push(update);
      if (update.type === 'query_event') h.adapter.handleTurnComplete();
    });
    const stop = h.adapter.observeExecution((update) => second.push(update));
    h.adapter.handleQueryEvent(event);
    expect(second.map((update) => update.type)).toEqual([
      'snapshot',
      'query_event',
      'turn_complete',
    ]);
    expect(second[1]).toEqual({ type: 'query_event', event });
    expect(
      (second[1] as Extract<SessionExecutionUpdate, { type: 'query_event' }>)
        .event,
    ).toBe(event);
    stop();
    h.adapter.handleQueryEvent(event);
    expect(second).toHaveLength(3);
    expect(
      first.filter((update) => update.type === 'query_event'),
    ).toHaveLength(2);
  });

  it('does not lose events emitted while delivering the first execution snapshot', () => {
    const h = fixture();
    const changes: SessionExecutionUpdate[] = [];
    h.adapter.observeExecution((update) => {
      changes.push(update);
      if (update.type === 'snapshot') h.adapter.handleQueryEvent(event);
    });
    expect(changes).toEqual([
      { type: 'snapshot', state: h.owner.execution },
      { type: 'query_event', event },
    ]);
  });

  it('removes an observer that fails during initial delivery', () => {
    const h = fixture();
    const fail = vi.fn(() => {
      throw new Error('observer failure');
    });
    expect(() => h.adapter.observeExecution(fail)).toThrow('observer failure');
    h.adapter.handleQueryEvent(event);
    expect(fail).toHaveBeenCalledOnce();
  });

  it('keeps faulty live message observers from interrupting the local producer', () => {
    const h = fixture();
    const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    h.adapter.observe((change) => {
      if (change.type !== 'snapshot') throw new Error('consumer failed');
    });
    const next = vi.fn();
    h.adapter.observe(next);
    expect(() => h.adapter.handleQueryEvent(event)).not.toThrow();
    expect(next).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'assistant_stream' }),
    );
    expect(warn).toHaveBeenCalledOnce();
  });

  it('publishes current readiness, history and pending snapshots without redundant state notifications', async () => {
    const h = fixture();
    await h.adapter.start();
    const updates: SessionUpdate[] = [];
    const execution: SessionExecutionUpdate[] = [];
    h.adapter.observeUpdates((update) => updates.push(update));
    h.adapter.observeExecution((update) => execution.push(update));
    h.adapter.sync();
    expect(updates).toHaveLength(1);
    expect(execution).toHaveLength(1);
    const pending = [{ type: 'gemini', text: 'pending' }];
    const history = [{ type: 'user', text: 'history' }];
    h.update({
      state: {
        ...h.owner.state,
        initialHistory: history,
        pendingHistory: pending,
      },
      execution: {
        ...h.owner.execution,
        canSubmitMessage: false,
        isResponding: true,
      },
    });
    h.adapter.sync();
    expect(updates).toContainEqual({
      type: 'history',
      kind: 'append',
      record: history[0],
    });
    expect(updates).toContainEqual({
      type: 'history',
      kind: 'pending',
      records: pending,
    });
    expect(execution.at(-1)).toEqual({
      type: 'snapshot',
      state: h.owner.execution,
    });
  });

  it('separates observation release from executor shutdown and resumes observation', async () => {
    const h = fixture();
    await h.adapter.start();
    const events: SessionExecutionUpdate[] = [];
    h.adapter.observeExecution((update) => events.push(update));
    await h.adapter.release();
    h.adapter.handleQueryEvent(event);
    expect(events).toHaveLength(1);
    expect(h.runtime.dispose).not.toHaveBeenCalled();
    expect(h.operations.interrupt).not.toHaveBeenCalled();
    expect(h.adapter.getState().access.status).toBe('disconnected');
    await expect(h.adapter.submitMessage(message)).rejects.toThrow('released');
    await expect(h.adapter.interrupt()).rejects.toThrow('released');
    expect(h.operations.interrupt).not.toHaveBeenCalled();
    h.update({
      state: {
        ...h.owner.state,
        initialMessages: {
          pendingAssistantText: 'continued while detached',
          activityStatus: 'running',
        },
        pendingHistory: [{ type: 'gemini', text: 'continued while detached' }],
      },
    });
    await expect(h.adapter.resume()).resolves.toMatchObject({
      status: 'connected',
    });
    const recovered: SessionChange[] = [];
    h.adapter.observe((change) => recovered.push(change));
    expect(recovered[0]).toMatchObject({
      type: 'snapshot',
      state: { pendingAssistantText: 'continued while detached' },
    });
    h.adapter.handleQueryEvent(event);
    expect(events.at(-1)).toEqual({ type: 'query_event', event });
    expect(h.adapter.toolCallSnapshots).toBe(h.config.toolCallSnapshots);
    await h.adapter.end();
    await h.adapter.end();
    expect(h.runtime.dispose).toHaveBeenCalledOnce();
    expect(h.adapter.getState().access.status).toBe('disconnected');
    expect(h.adapter.getExecutionState().canSubmitMessage).toBe(false);
    await expect(h.adapter.submitMessage(message)).rejects.toThrow('ended');
  });

  it('waits for the committed owner view instead of publishing old history after restore', async () => {
    const h = fixture();
    let sessionId = 'before';
    vi.spyOn(h.config, 'getSessionId').mockImplementation(() => sessionId);
    const before = [{ type: 'user', text: 'before' }];
    h.update({ state: { ...h.owner.state, initialHistory: before } });
    await h.adapter.start();
    const updates: SessionUpdate[] = [];
    h.adapter.observeUpdates((update) => updates.push(update));
    h.operations.restore.mockImplementationOnce(async () => {
      sessionId = 'after';
      return true;
    });
    await h.adapter.restore({ sessionId: 'after', messages: [] });
    expect(updates).toHaveLength(1);
    const after = [{ type: 'user', text: 'after' }];
    h.update({ state: { ...h.owner.state, initialHistory: after } });
    h.adapter.sync();
    expect(updates).toContainEqual(
      expect.objectContaining({
        type: 'snapshot',
        reason: 'restore',
        state: expect.objectContaining({ initialHistory: after }),
      }),
    );
  });

  it('restores through the existing owner and clears old pending text when identity changes', async () => {
    const h = fixture();
    let sessionId = 'before';
    vi.spyOn(h.config, 'getSessionId').mockImplementation(() => sessionId);
    await h.adapter.start();
    h.adapter.handleQueryEvent(event);
    const updates: SessionUpdate[] = [];
    h.adapter.observeUpdates((update) => updates.push(update));
    h.operations.restore.mockImplementationOnce(async () => {
      sessionId = 'after';
      return true;
    });
    const input = { sessionId: 'after', messages: [] };
    await h.adapter.restore(input);
    expect(h.operations.restore).toHaveBeenCalledExactlyOnceWith(input);
    // The UI publishes its committed view separately from the restore operation.
    h.adapter.sync();
    expect(updates.at(-1)).toMatchObject({
      type: 'snapshot',
      reason: 'restore',
      state: { access: { sessionId: 'after' } },
    });
    const messages: SessionChange[] = [];
    h.adapter.observe((change) => messages.push(change));
    expect(messages[0]).toMatchObject({
      type: 'snapshot',
      state: { pendingAssistantText: '' },
    });
  });

  it('uses the original Config and Provider for settings, preserves failures, and retains models', async () => {
    const h = fixture();
    await h.adapter.setModel('next', 'high', 1000);
    expect(h.operations.setModel).toHaveBeenCalledExactlyOnceWith('next', true);
    expect(h.operations.setContextWindow).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'next' }),
      {
        reasoning: { effort: 'high' },
        context: { contextWindow: 1000 },
      },
      false,
    );
    await h.adapter.setContextWindow(undefined);
    expect(h.operations.setContextWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'next' }),
      { context: { contextWindow: undefined } },
      undefined,
    );
    await expect(
      h.adapter.applySettings({ unsupportedSetting: true }),
    ).rejects.toThrow('Unsupported session settings');
    await h.adapter.setPermissionMode('auto');
    await h.adapter.setTitle('title');
    await h.adapter.interrupt();
    expect(h.operations.setPermissionMode).toHaveBeenCalledExactlyOnceWith(
      'auto',
    );
    expect(h.operations.setTitle).toHaveBeenCalledExactlyOnceWith('title');
    expect(h.operations.interrupt).toHaveBeenCalledOnce();
    const failure = new Error('model failed');
    h.operations.setModel.mockRejectedValueOnce(failure);
    await expect(h.adapter.setModel('bad')).rejects.toBe(failure);
    const models = await h.adapter.refreshModels();
    h.adapter.sync();
    expect(h.adapter.getState().models).toBe(models);
  });

  it('observes current execution facts even before another UI render', async () => {
    const h = fixture();
    let responding = false;
    h.update({
      execution: {
        get canSubmitMessage() {
          return !responding;
        },
        get isResponding() {
          return responding;
        },
        pendingToolCalls: [],
      },
    });
    await h.adapter.start();
    const updates: SessionExecutionUpdate[] = [];
    h.adapter.observeExecution((update) => updates.push(update));
    responding = true;
    expect(h.adapter.getExecutionState()).toMatchObject({
      canSubmitMessage: false,
      isResponding: true,
    });
    await expect(
      h.adapter.submitMessage(message, bridgeOptions),
    ).rejects.toThrow('not ready');
    h.adapter.sync();
    expect(updates.at(-1)).toEqual({
      type: 'snapshot',
      state: {
        canSubmitMessage: false,
        isResponding: true,
        pendingToolCalls: [],
      },
    });
  });

  it.each(['config', 'session', 'model', 'identity', 'binding'] as const)(
    'does not publish a model list after %s changes during refresh',
    async (changed) => {
      const h = fixture();
      let identity = 'identity-before';
      let model = 'model-before';
      let sessionId = h.config.getSessionId();
      vi.spyOn(h.config, 'getModelRequestIdentity').mockImplementation(
        () => identity,
      );
      vi.spyOn(h.config, 'getModel').mockImplementation(() => model);
      vi.spyOn(h.config, 'getSessionId').mockImplementation(() => sessionId);
      let resolve!: (models: Model[]) => void;
      h.operations.refreshModels.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const updates: SessionUpdate[] = [];
      h.adapter.observeUpdates((update) => updates.push(update));
      const request = h.adapter.refreshModels();
      switch (changed) {
        case 'config':
          h.update({ config: makeFakeConfig() });
          break;
        case 'session':
          sessionId = 'session-after';
          break;
        case 'model':
          model = 'model-after';
          break;
        case 'identity':
          identity = 'identity-after';
          break;
        case 'binding':
          await h.adapter.release();
          await h.adapter.resume();
          break;
        default:
          throw new Error('Unexpected model refresh target');
      }
      resolve([testProviderModel('old')]);
      await expect(request).rejects.toThrow('session changed');
      expect(updates.some((update) => update.type === 'models')).toBe(false);
    },
  );

  it.each(['local', 'session'] as const)(
    'keeps the native ask handler when %s answers first',
    async (first) => {
      const h = fixture();
      const removed = vi.fn();
      const pending = h.permissionQueue.askHandler({
        toolUseId: 'native-approval',
        toolName: 'Read',
        input: { path: '/tmp/test' },
        toolCheckResult: {
          kind: 'ask',
          reason: {
            message: 'Read?',
            attribution: { type: 'other', reason: 'test' },
          },
        },
        onToolCheckResult: () => removed,
      });
      await vi.waitFor(() =>
        expect(h.permissionQueue.getById('native-approval')).toBeDefined(),
      );
      const prompt = h.permissionQueue.getById('native-approval')!;
      const binding = createSessionUiBinding(h.adapter, 'local');
      const stop = binding.uiSession.observeSession();
      expect(h.permissionQueue.getById('native-approval')).toBe(prompt);
      stop();
      // Ending one display observation must leave the executor's prompt alive.
      expect(h.permissionQueue.getById('native-approval')).toBe(prompt);
      if (first === 'local') {
        prompt.approve();
        await h.adapter.respondToApproval(
          'native-approval',
          ToolConfirmationOutcome.Cancel,
        );
      } else {
        await h.adapter.respondToApproval(
          'native-approval',
          ToolConfirmationOutcome.ProceedOnce,
        );
        prompt.reject();
      }
      await expect(pending).resolves.toEqual({ kind: 'approved' });
      expect(removed).toHaveBeenCalledOnce();
      expect(h.permissionQueue.size).toBe(0);
      expect(h.adapter.getState().approvals).toEqual([]);
      await binding.dispose();
      expect(h.runtime.dispose).not.toHaveBeenCalled();
    },
  );

  it('settles an existing permission prompt once when local and session answers race', async () => {
    const h = fixture();
    await h.adapter.start();
    const approve = vi.fn();
    const reject = vi.fn();
    const remove = h.permissionQueue.presentProxied(
      {
        toolUseId: 'approval',
        toolName: 'Read',
        input: { path: '/tmp/test' },
        reason: {
          message: 'Read?',
          attribution: { type: 'other', reason: 'test' },
        },
        skippable: true,
      },
      {
        approve: (...args) => {
          remove();
          approve(...args);
        },
        reject: () => {
          remove();
          reject();
        },
        abort: () => remove(),
      },
    );
    expect(h.adapter.getState().approvals).toMatchObject([
      { id: 'approval', name: 'Read' },
    ]);
    h.permissionQueue.getById('approval')!.approve();
    await h.adapter.respondToApproval(
      'approval',
      ToolConfirmationOutcome.ProceedOnce,
    );
    expect(approve).toHaveBeenCalledOnce();
    expect(reject).not.toHaveBeenCalled();
    expect(h.adapter.getState().approvals).toEqual([]);
  });
  it('settles question answers already normalized by the caller', async () => {
    const h = fixture();
    await h.adapter.start();
    const approve = vi.fn();
    const remove = h.permissionQueue.presentProxied(
      {
        toolUseId: 'question',
        toolName: ASK_USER_TOOL_NAME,
        input: { questions: [{ question: 'Continue?' }] },
        reason: {
          message: 'Answer?',
          attribution: { type: 'other', reason: 'test' },
        },
        skippable: false,
      },
      {
        approve: (...args) => {
          remove();
          approve(...args);
        },
        reject: () => remove(),
        abort: () => remove(),
      },
    );
    await h.adapter.respondToApproval(
      'question',
      ToolConfirmationOutcome.ProceedOnce,
      { answers: { 'Continue?': 'yes' } },
    );
    expect(approve).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ answers: { 'Continue?': 'yes' } }),
      undefined,
    );
    await h.adapter.respondToApproval(
      'question',
      ToolConfirmationOutcome.Cancel,
    );
    expect(approve).toHaveBeenCalledOnce();
  });
  it('reads settings and output styles from the original native config', async () => {
    const h = fixture();
    vi.spyOn(h.config, 'getAvailableOutputStyles').mockResolvedValue({
      default: {},
      concise: {},
    } as never);
    const settings = await h.adapter.readSettings();
    expect(settings.outputStyles).toEqual(['default', 'concise']);
    expect(settings.effective).toHaveProperty('ultracode');
    expect(settings.applied).toHaveProperty('effort');
    expect(h.runtime.submitQuery).not.toHaveBeenCalled();
  });
  it('emits a manual title once when persistence already notified the owner', async () => {
    const h = fixture();
    const updates: SessionUpdate[] = [];
    h.adapter.observeUpdates((update) => updates.push(update));
    h.operations.setTitle.mockImplementationOnce(async (title) => {
      h.owner.state = { ...h.owner.state, title };
      h.adapter.sync({ title });
    });
    await h.adapter.setTitle('custom title');
    expect(updates.filter((update) => update.type === 'title')).toEqual([
      { type: 'title', title: 'custom title' },
    ]);
  });
  it('keeps canonical initialization settings on the original Config and Provider', async () => {
    const system = vi.fn();
    const append = vi.fn();
    const h = fixture({
      setSystemPrompt: system,
      setAppendSystemPrompt: append,
    });
    await h.adapter.applySettings({
      model: 'chosen',
      reasoningEffort: 'high',
      systemPrompt: 'system',
      appendSystemPrompt: 'append',
    });
    expect(h.operations.setModel).toHaveBeenCalledExactlyOnceWith(
      'chosen',
      true,
    );
    expect(system).toHaveBeenCalledExactlyOnceWith('system');
    expect(append).toHaveBeenCalledExactlyOnceWith('append');
    expect(h.adapter.getState().model).toBe('chosen');
    expect(h.runtime.submitQuery).not.toHaveBeenCalled();
  });
  it('does not mutate flag settings after their caller aborts during model lookup', async () => {
    const h = fixture();
    let finish!: (model: Model) => void;
    vi.spyOn(
      h.config.getModelProviderManager(),
      'getModel',
    ).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const setFlag = vi.spyOn(h.config, 'setUltracode');
    const controller = new AbortController();
    const applying = h.adapter.applySettings(
      { ultracode: true },
      { signal: controller.signal },
    );
    controller.abort();
    finish(testProviderModel('initial'));
    await expect(applying).rejects.toThrow();
    expect(setFlag).not.toHaveBeenCalled();
  });
  it('reuses the original artifact registry and orders execution observations after registration', async () => {
    const initialize = vi
      .spyOn(SessionArtifactRuntime.prototype, 'initialize')
      .mockResolvedValue([]);
    let finish!: () => void;
    const observe = vi
      .spyOn(SessionArtifactRuntime.prototype, 'observeEvent')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve(null);
          }),
      );
    const h = fixture();
    const artifacts = await h.adapter.getArtifacts();
    expect(await h.adapter.getArtifacts()).toBe(artifacts);
    expect(initialize).toHaveBeenCalledOnce();
    const first: SessionExecutionUpdate[] = [];
    h.adapter.observeExecution((update) => first.push(update));
    h.adapter.handleQueryEvent(event);
    h.adapter.handleTurnComplete();
    const late: SessionExecutionUpdate[] = [];
    h.adapter.observeExecution((update) => late.push(update));
    await Promise.resolve();
    expect(first.map((update) => update.type)).toEqual(['snapshot']);
    finish();
    await vi.waitFor(() =>
      expect(first.map((update) => update.type)).toEqual([
        'snapshot',
        'query_event',
        'turn_complete',
      ]),
    );
    expect(late.map((update) => update.type)).toEqual(['snapshot']);
    expect(
      (first[1] as Extract<SessionExecutionUpdate, { type: 'query_event' }>)
        .event,
    ).toBe(event);
    observe.mockRestore();
    initialize.mockRestore();
  });
  it('rebinds artifact registration after a local session identity change', async () => {
    const initialize = vi
      .spyOn(SessionArtifactRuntime.prototype, 'initialize')
      .mockResolvedValue([]);
    const h = fixture();
    let sessionId = 'before';
    vi.spyOn(h.config, 'getSessionId').mockImplementation(() => sessionId);
    const before = await h.adapter.getArtifacts();
    sessionId = 'after';
    h.adapter.sync();
    const after = await h.adapter.getArtifacts();
    expect(after).not.toBe(before);
    expect(await h.adapter.getArtifacts()).toBe(after);
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('rejects artifact initialization completed for an old session', async () => {
    let finish!: () => void;
    vi.spyOn(SessionArtifactRuntime.prototype, 'initialize')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve([]);
          }),
      )
      .mockResolvedValue([]);
    const h = fixture();
    let sessionId = 'before';
    vi.spyOn(h.config, 'getSessionId').mockImplementation(() => sessionId);
    const before = h.adapter.getArtifacts();
    void before.catch(() => {});
    sessionId = 'after';
    h.adapter.sync();
    const after = h.adapter.getArtifacts();
    finish();
    await expect(before).rejects.toThrow('Local session changed');
    await expect(after).resolves.toBeDefined();
  });

  it('does not deliver or enqueue old artifact observations after switching sessions', async () => {
    vi.spyOn(SessionArtifactRuntime.prototype, 'initialize').mockResolvedValue(
      [],
    );
    let finish!: () => void;
    const observe = vi
      .spyOn(SessionArtifactRuntime.prototype, 'observeEvent')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve(null);
          }),
      )
      .mockResolvedValue(null);
    const h = fixture();
    let sessionId = 'before';
    vi.spyOn(h.config, 'getSessionId').mockImplementation(() => sessionId);
    await h.adapter.getArtifacts();
    const updates: SessionExecutionUpdate[] = [];
    h.adapter.observeExecution((update) => updates.push(update));
    const queued = { ...event };
    const next = { ...event };
    h.adapter.handleQueryEvent(event);
    h.adapter.handleQueryEvent(queued);
    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
    try {
      sessionId = 'after';
      h.adapter.sync();
      const after = await Promise.race([
        h.adapter.getArtifacts(),
        new Promise<undefined>((resolve) => setTimeout(resolve, 200)),
      ]);
      expect(after).toBeDefined();
      updates.length = 0;
      h.adapter.handleQueryEvent(next);
      await vi.waitFor(
        () =>
          expect(updates).toContainEqual({ type: 'query_event', event: next }),
        { timeout: 200 },
      );
      finish();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(observe).toHaveBeenCalledTimes(2);
      expect(observe.mock.calls[1]![0]).toBe(next);
      expect(updates).toHaveLength(1);
      expect(
        (updates[0] as Extract<SessionExecutionUpdate, { type: 'query_event' }>)
          .event,
      ).toBe(next);
    } finally {
      finish();
    }
  });
});
