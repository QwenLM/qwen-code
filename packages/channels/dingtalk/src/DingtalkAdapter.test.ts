import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DWClientDownStream } from 'dingtalk-stream-sdk-nodejs';
import type {
  ChannelOutputSegmentContext,
  ChannelOutputSegmentEndReason,
  ChannelTaskLifecycleEvent,
  ChannelUserInputRequestContext,
  Envelope,
  SessionTarget,
} from '@qwen-code/channel-base';
import type {
  DingtalkCardCallback,
  DingtalkCardCallbackResult,
} from './interactive-card-types.js';

type LifecycleBase = Omit<
  Extract<ChannelTaskLifecycleEvent, { type: 'started' }>,
  'type'
>;

const dingtalkSdkMock = vi.hoisted(() => ({
  instances: [] as unknown[],
  nextConnect: undefined as (() => Promise<void>) | undefined,
  rawLog: vi.fn(),
}));

const PNG_DATA = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

function createTempPng(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dingtalk-outbound-image-'));
  const path = join(dir, 'image.png');
  writeFileSync(path, PNG_DATA);
  return { dir, path };
}

vi.mock('dingtalk-stream-sdk-nodejs', () => ({
  DWClient: class {
    debug = true;
    connected = true;
    registered = true;
    config = { autoReconnect: true };
    socket = new (class {
      readyState = 1;
      ping = vi.fn();
      private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

      on(event: string, listener: (...args: unknown[]) => void): void {
        const listeners = this.listeners.get(event) ?? new Set();
        listeners.add(listener);
        this.listeners.set(event, listeners);
      }

      off(event: string, listener: (...args: unknown[]) => void): void {
        this.listeners.get(event)?.delete(listener);
      }

      emit(event: string, ...args: unknown[]): void {
        for (const listener of this.listeners.get(event) ?? []) {
          listener(...args);
        }
      }
    })();
    callback?: (msg: DWClientDownStream) => void;
    callbacks = new Map<string, (msg: DWClientDownStream) => void>();
    disconnect = vi.fn();
    getConfig = vi.fn(() => ({ access_token: 'token' }));
    registerCallbackListener = vi.fn(
      (topic: string, callback: (msg: DWClientDownStream) => void) => {
        this.callbacks.set(topic, callback);
        if (topic === 'robot') this.callback = callback;
      },
    );
    send = vi.fn();
    connect = vi.fn(() => {
      const connect = dingtalkSdkMock.nextConnect;
      dingtalkSdkMock.nextConnect = undefined;
      return connect?.() ?? Promise.resolve();
    });

    onSystem = vi.fn();
    onEvent = vi.fn();
    onCallback = vi.fn();
    onDownStream = vi.fn((data: Buffer | string) => {
      dingtalkSdkMock.rawLog(data);
      const msg = JSON.parse(data.toString());
      if (msg.type === 'SYSTEM') this.onSystem(msg);
      if (msg.type === 'EVENT') this.onEvent(msg);
      if (msg.type === 'CALLBACK') this.onCallback(msg);
    });

    constructor(readonly options: Record<string, unknown>) {
      dingtalkSdkMock.instances.push(this);
    }
  },
  TOPIC_ROBOT: 'robot',
  TOPIC_CARD: 'card',
  EventAck: { SUCCESS: 'success' },
}));

vi.mock('@qwen-code/channel-base', async () => {
  // Use the REAL sanitizeSenderName so the adapter's log-sanitization path is
  // exercised against the shared helper, not a stub that could mask drift. The
  // vitest config aliases @qwen-code/channel-base to its SOURCE, so this resolves
  // with no prior channel-base build (dist may be absent/stale package-locally).
  const real = await vi.importActual<typeof import('@qwen-code/channel-base')>(
    '@qwen-code/channel-base',
  );
  return {
    ChannelBase: class {
      protected config: Record<string, unknown>;
      protected name: string;
      handleInbound = vi.fn().mockResolvedValue(undefined);
      protected preflightInbound = vi.fn().mockResolvedValue(true);
      protected processInbound = vi.fn().mockResolvedValue(undefined);
      onSessionDied(_sessionId: string): void {}
      protected logDebugPayload(platform: string, payload: unknown): void {
        (
          real.ChannelBase.prototype as unknown as {
            logDebugPayload(platform: string, payload: unknown): void;
          }
        ).logDebugPayload.call(this, platform, payload);
      }
      protected onPromptBufferDropped(
        _chatId: string,
        _sessionId: string,
        _messageIds: string[],
      ): void {}
      protected onPromptBufferDrained(
        _chatId: string,
        _sessionId: string,
        _messageIds: string[],
      ): void {}
      protected requestPromptRunCancellation = vi.fn().mockResolvedValue(false);
      protected supportsProactiveTarget(target: SessionTarget): boolean {
        return target.threadId === undefined;
      }
      protected supportsProactiveWebhookTarget(target: SessionTarget): boolean {
        return this.supportsProactiveTarget(target);
      }

      constructor(
        name: string,
        config: Record<string, unknown>,
        _bridge: unknown,
      ) {
        this.name = name;
        this.config = config;
      }
    },
    sanitizeLogText: real.sanitizeLogText,
    sanitizeSenderName: real.sanitizeSenderName,
    isTerminalTaskLifecycleType: real.isTerminalTaskLifecycleType,
  };
});

const { DingtalkChannel } = await import('./DingtalkAdapter.js');
type DingtalkChannelInstance = InstanceType<typeof DingtalkChannel>;

function createChannel(
  overrides: Record<string, unknown> = {},
): DingtalkChannelInstance {
  return new DingtalkChannel(
    'test-dingtalk',
    {
      type: 'dingtalk',
      token: '',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      senderPolicy: 'open',
      allowedUsers: [],
      sessionScope: 'user',
      cwd: '/tmp',
      groupPolicy: 'open',
      dmPolicy: 'open',
      groups: {},
      interactiveCards: {},
      ...overrides,
    } as never,
    {} as never,
  );
}

function latestMockClient(): Record<string, unknown> {
  const client = dingtalkSdkMock.instances.at(-1) as
    | Record<string, unknown>
    | undefined;
  if (!client) throw new Error('No mock DingTalk client created');
  return client;
}

interface MockDingtalkClient {
  callback?: (msg: DWClientDownStream) => void;
  callbacks: Map<string, (msg: DWClientDownStream) => void>;
  disconnect: ReturnType<typeof vi.fn>;
  onDownStream(raw: string): void;
  registerCallbackListener: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

function mockClientAt(index: number): MockDingtalkClient {
  const client = dingtalkSdkMock.instances[index] as
    | MockDingtalkClient
    | undefined;
  if (!client) throw new Error(`No mock DingTalk client at index ${index}`);
  return client;
}

it('uses the connection manager by default', () => {
  createChannel();

  expect(latestMockClient().options).toEqual(
    expect.objectContaining({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      keepAlive: false,
    }),
  );
  expect(
    (latestMockClient().config as { autoReconnect: boolean }).autoReconnect,
  ).toBe(false);
});

it('uses SDK keepalive when the connection manager is disabled', () => {
  createChannel({ useConnectionManager: false });

  expect(latestMockClient().options).toEqual(
    expect.objectContaining({
      keepAlive: true,
    }),
  );
  expect(
    (latestMockClient().config as { autoReconnect: boolean }).autoReconnect,
  ).toBe(true);
});

it('rejects a non-boolean useConnectionManager value', () => {
  expect(() => createChannel({ useConnectionManager: 'false' })).toThrow(
    'useConnectionManager must be a boolean',
  );
});

it('adds outbound image instructions without replacing custom instructions', () => {
  const channel = createChannel({ instructions: 'Keep the answer concise.' });
  const instructions = (
    channel as unknown as { config: { instructions: string } }
  ).config.instructions;

  expect(instructions).toContain('Keep the answer concise.');
  expect(instructions).toContain('[IMAGE: /absolute/path/to/file.png]');
});

it('validates interactive card config in the adapter', () => {
  expect(() =>
    createChannel({
      interactiveCards: { questionCard: { timeoutMs: 0 } },
    }),
  ).toThrow('questionCard.timeoutMs');
});

it('does not initialize or subscribe to cards when configuration is omitted', () => {
  const channel = createChannel({ interactiveCards: undefined });
  const client = mockClientAt(dingtalkSdkMock.instances.length - 1);

  expect([...client.callbacks.keys()]).toEqual(['robot']);
  expect(
    (
      channel as unknown as {
        interactionPresenter?: unknown;
      }
    ).interactionPresenter,
  ).toBeUndefined();
  expect(
    (channel as unknown as { statusCardController?: unknown })
      .statusCardController,
  ).toBeUndefined();
  expect(
    (channel as unknown as { questionCardController?: unknown })
      .questionCardController,
  ).toBeUndefined();
});

function createCallbackResultChannel(
  result: DingtalkCardCallbackResult,
): DingtalkChannelInstance {
  class CallbackResultChannel extends DingtalkChannel {
    protected override routeCardCallback(): DingtalkCardCallbackResult {
      return result;
    }
  }
  return new CallbackResultChannel(
    'test-dingtalk',
    {
      type: 'dingtalk',
      token: '',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      senderPolicy: 'open',
      allowedUsers: [],
      sessionScope: 'user',
      cwd: '/tmp',
      groupPolicy: 'open',
      dmPolicy: 'open',
      groups: {},
      interactiveCards: {},
    } as never,
    {} as never,
  );
}

function stubCardFeedbackFetch(options?: { rejectDirect?: boolean }) {
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://oapi.dingtalk.com/gettoken')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              errcode: 0,
              access_token: 'feedback-token',
              expires_in: 7200,
            }),
            { status: 200 },
          ),
        );
      }
      if (
        options?.rejectDirect &&
        url.startsWith(
          'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
        )
      ) {
        return Promise.reject(new Error('direct feedback failed'));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
  const calls = (prefix: string) =>
    spy.mock.calls.filter(([input]) => String(input).startsWith(prefix));
  return {
    spy,
    directSendCalls: () =>
      calls('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend'),
    groupSendCalls: () =>
      calls('https://api.dingtalk.com/v1.0/robot/groupMessages/send'),
  };
}

function dispatchCardCallback(
  client: MockDingtalkClient,
  data: Record<string, unknown>,
): void {
  client.callbacks.get('card')?.({
    headers: { messageId: 'card-message' },
    data: JSON.stringify(data),
  } as DWClientDownStream);
}

it('ACKs a parsed card callback before starting asynchronous handling', async () => {
  const events: string[] = [];
  class CallbackTestChannel extends DingtalkChannel {
    protected override routeCardCallback(): DingtalkCardCallbackResult {
      return {
        kind: 'accepted',
        execute: async () => {
          events.push('action');
        },
      };
    }
  }
  const channel = new CallbackTestChannel(
    'test-dingtalk',
    {
      type: 'dingtalk',
      token: '',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      senderPolicy: 'open',
      allowedUsers: [],
      sessionScope: 'user',
      cwd: '/tmp',
      groupPolicy: 'open',
      dmPolicy: 'open',
      groups: {},
      interactiveCards: {},
    } as never,
    {} as never,
  );
  expect(channel).toBeDefined();
  const client = mockClientAt(dingtalkSdkMock.instances.length - 1);
  client.send.mockImplementation(() => {
    events.push('ack');
  });

  client.callbacks.get('card')?.({
    headers: { messageId: 'card-message' },
    data: JSON.stringify({
      userId: 'owner-1',
      value: JSON.stringify({
        outTrackId: 'status-1',
        actionValue: 'btn_stop',
      }),
    }),
  } as DWClientDownStream);

  expect(events[0]).toBe('ack');
  await vi.waitFor(() => expect(events).toEqual(['ack', 'action']));
  expect(client.send).toHaveBeenCalledWith('card-message', {
    status: 'success',
    message: 'ok',
  });
});

it('ACKs before sending forbidden feedback to the original group', async () => {
  createCallbackResultChannel({
    kind: 'forbidden',
    actorId: 'other-user',
    target: { chatId: 'group-1', isGroup: true },
  });
  const client = mockClientAt(dingtalkSdkMock.instances.length - 1);
  const { spy, directSendCalls, groupSendCalls } = stubCardFeedbackFetch();

  try {
    dispatchCardCallback(client, {
      userId: 'other-user',
      value: JSON.stringify({
        outTrackId: 'question-1',
        actionValue: 'submit',
      }),
    });

    expect(client.send).toHaveBeenCalledWith('card-message', {
      status: 'success',
      message: 'ok',
    });
    await vi.waitFor(() => expect(groupSendCalls()).toHaveLength(1));
    expect(directSendCalls()).toHaveLength(0);
    const requestBody = JSON.parse(
      String((groupSendCalls()[0]![1] as RequestInit).body),
    );
    expect(requestBody.openConversationId).toBe('group-1');
    expect(requestBody.userIds).toBeUndefined();
    expect(JSON.parse(requestBody.msgParam).text).toContain('任务发起人');
    expect(JSON.parse(requestBody.msgParam).text).toContain('未生效');
  } finally {
    spy.mockRestore();
  }
});

it('silently ACKs an ignored callback', async () => {
  createCallbackResultChannel({ kind: 'ignored', actorId: 'owner-1' });
  const client = mockClientAt(dingtalkSdkMock.instances.length - 1);
  const { spy, directSendCalls, groupSendCalls } = stubCardFeedbackFetch();

  try {
    dispatchCardCallback(client, {
      userId: 'owner-1',
      value: JSON.stringify({
        outTrackId: 'question-1',
        actionValue: 'submit',
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.send).toHaveBeenCalledWith('card-message', {
      status: 'success',
      message: 'ok',
    });
    expect(directSendCalls()).toHaveLength(0);
    expect(groupSendCalls()).toHaveLength(0);
  } finally {
    spy.mockRestore();
  }
});

it('silently ACKs a malformed callback with a trusted actor', async () => {
  createChannel();
  const client = mockClientAt(dingtalkSdkMock.instances.length - 1);
  const { spy, directSendCalls, groupSendCalls } = stubCardFeedbackFetch();

  try {
    dispatchCardCallback(client, {
      userId: 'actor-1',
      value: JSON.stringify({ outTrackId: 'missing-action' }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.send).toHaveBeenCalledWith('card-message', {
      status: 'success',
      message: 'ok',
    });
    expect(directSendCalls()).toHaveLength(0);
    expect(groupSendCalls()).toHaveLength(0);
  } finally {
    spy.mockRestore();
  }
});

it('does not send feedback for a malformed callback without an actor', async () => {
  createChannel();
  const client = mockClientAt(dingtalkSdkMock.instances.length - 1);
  const { spy, directSendCalls, groupSendCalls } = stubCardFeedbackFetch();

  try {
    dispatchCardCallback(client, {
      value: JSON.stringify({ outTrackId: 'missing-action' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.send).toHaveBeenCalledWith('card-message', {
      status: 'success',
      message: 'ok',
    });
    expect(directSendCalls()).toHaveLength(0);
    expect(groupSendCalls()).toHaveLength(0);
  } finally {
    spy.mockRestore();
  }
});

it('logs failed direct feedback without falling back to the group', async () => {
  createCallbackResultChannel({
    kind: 'forbidden',
    actorId: 'other-user',
    target: { chatId: 'other-user', isGroup: false },
  });
  const client = mockClientAt(dingtalkSdkMock.instances.length - 1);
  const { spy, directSendCalls, groupSendCalls } = stubCardFeedbackFetch({
    rejectDirect: true,
  });
  const stderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => true);

  try {
    dispatchCardCallback(client, {
      userId: 'other-user',
      value: JSON.stringify({
        outTrackId: 'question-1',
        actionValue: 'submit',
      }),
    });

    await vi.waitFor(() =>
      expect(
        stderr.mock.calls.map(([text]) => String(text)).join(''),
      ).toContain('card interaction feedback failed'),
    );
    expect(directSendCalls()).toHaveLength(1);
    expect(groupSendCalls()).toHaveLength(0);
  } finally {
    stderr.mockRestore();
    spy.mockRestore();
  }
});

it('does not send feedback for an accepted callback', async () => {
  const action = vi.fn().mockResolvedValue(undefined);
  createCallbackResultChannel({ kind: 'accepted', execute: action });
  const client = mockClientAt(dingtalkSdkMock.instances.length - 1);
  const { spy, directSendCalls, groupSendCalls } = stubCardFeedbackFetch();

  try {
    dispatchCardCallback(client, {
      userId: 'owner-1',
      value: JSON.stringify({
        outTrackId: 'question-1',
        actionValue: 'submit',
      }),
    });

    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(directSendCalls()).toHaveLength(0);
    expect(groupSendCalls()).toHaveLength(0);
  } finally {
    spy.mockRestore();
  }
});

it('ACKs duplicate card callbacks while executing one claimed action', async () => {
  const action = vi.fn().mockResolvedValue(undefined);
  const claim = vi
    .fn()
    .mockReturnValueOnce({ kind: 'accepted', execute: action })
    .mockReturnValue({ kind: 'ignored', actorId: 'owner-1' });
  class DuplicateCallbackTestChannel extends DingtalkChannel {
    protected override routeCardCallback(): DingtalkCardCallbackResult {
      return claim();
    }
  }
  new DuplicateCallbackTestChannel(
    'test-dingtalk',
    {
      type: 'dingtalk',
      token: '',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      senderPolicy: 'open',
      allowedUsers: [],
      sessionScope: 'user',
      cwd: '/tmp',
      groupPolicy: 'open',
      dmPolicy: 'open',
      groups: {},
      interactiveCards: {},
    } as never,
    {} as never,
  );
  const client = mockClientAt(dingtalkSdkMock.instances.length - 1);
  const { spy, directSendCalls } = stubCardFeedbackFetch();
  const callbackData = JSON.stringify({
    userId: 'owner-1',
    value: JSON.stringify({
      outTrackId: 'question-1',
      actionValue: 'submit',
    }),
  });

  try {
    client.callbacks.get('card')?.({
      headers: { messageId: 'card-message-1' },
      data: callbackData,
    } as DWClientDownStream);
    client.callbacks.get('card')?.({
      headers: { messageId: 'card-message-2' },
      data: callbackData,
    } as DWClientDownStream);

    expect(client.send).toHaveBeenNthCalledWith(1, 'card-message-1', {
      status: 'success',
      message: 'ok',
    });
    expect(client.send).toHaveBeenNthCalledWith(2, 'card-message-2', {
      status: 'success',
      message: 'ok',
    });
    expect(claim).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(directSendCalls()).toHaveLength(0);
  } finally {
    spy.mockRestore();
  }
});

it('routes the built-in btn_stop action to the status card controller', () => {
  const stopResult: DingtalkCardCallbackResult = {
    kind: 'accepted',
    execute: vi.fn().mockResolvedValue(undefined),
  };
  const claimStop = vi.fn().mockReturnValue(stopResult);
  class CallbackRoutingChannel extends DingtalkChannel {
    route(callback: DingtalkCardCallback) {
      return this.routeCardCallback(callback);
    }
  }
  const channel = new CallbackRoutingChannel(
    'test-dingtalk',
    {
      type: 'dingtalk',
      token: '',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      senderPolicy: 'open',
      allowedUsers: [],
      sessionScope: 'user',
      cwd: '/tmp',
      groupPolicy: 'open',
      dmPolicy: 'open',
      groups: {},
    } as never,
    {} as never,
  );
  Object.assign(channel, { statusCardController: { claimStop } });

  expect(
    channel.route({
      outTrackId: 'status-1',
      actionId: 'btn_stop',
      actorId: 'owner-1',
      formData: {},
    }),
  ).toBe(stopResult);
  expect(claimStop).toHaveBeenCalledWith('status-1', 'owner-1');
});

it('keeps callbacks and ACKs bound to the client that received them', async () => {
  const firstIndex = dingtalkSdkMock.instances.length;
  const channel = createChannel();
  const firstClient = mockClientAt(firstIndex);
  await channel.connect();
  const replacementConnect = deferredPromise<void>();
  dingtalkSdkMock.nextConnect = () => replacementConnect.promise;

  firstClient.onDownStream(
    JSON.stringify({
      type: 'SYSTEM',
      headers: { topic: 'disconnect', messageId: 'system-message' },
      data: '',
    }),
  );

  await vi.waitFor(() => {
    expect(dingtalkSdkMock.instances.length).toBe(firstIndex + 2);
  });
  const replacement = mockClientAt(firstIndex + 1);

  firstClient.callback?.({
    headers: { messageId: 'old-message' },
    data: '{}',
  } as DWClientDownStream);
  replacementConnect.resolve();
  await vi.waitFor(() => {
    expect(firstClient.disconnect).toHaveBeenCalledOnce();
  });
  replacement.callback?.({
    headers: { messageId: 'new-message' },
    data: '{}',
  } as DWClientDownStream);

  expect(firstClient.registerCallbackListener).toHaveBeenCalledTimes(2);
  expect(replacement.registerCallbackListener).toHaveBeenCalledTimes(2);
  expect(
    firstClient.registerCallbackListener.mock.calls.map(([topic]) => topic),
  ).toEqual(['robot', 'card']);
  expect(
    replacement.registerCallbackListener.mock.calls.map(([topic]) => topic),
  ).toEqual(['robot', 'card']);
  expect(firstClient.send).toHaveBeenCalledWith('old-message', {
    status: 'success',
    message: 'ok',
  });
  expect(replacement.send).toHaveBeenCalledWith('new-message', {
    status: 'success',
    message: 'ok',
  });
  expect(firstClient.disconnect).toHaveBeenCalledOnce();
  channel.disconnect();
});

function getPromptHook(
  channel: DingtalkChannelInstance,
  hook: 'onPromptStart' | 'onPromptEnd',
): (chatId: string, sessionId: string, messageId?: string) => void {
  const fn = (channel as unknown as Record<string, unknown>)[hook] as (
    chatId: string,
    sessionId: string,
    messageId?: string,
  ) => void;
  return fn.bind(channel);
}

function getResponseHook(
  channel: DingtalkChannelInstance,
): (chatId: string, text: string, sessionId: string) => Promise<void> {
  const fn = (channel as unknown as Record<string, unknown>)[
    'sendResponseMessage'
  ] as (chatId: string, text: string, sessionId: string) => Promise<void>;
  return fn.bind(channel);
}

function getPromptBufferDropHook(
  channel: DingtalkChannelInstance,
): (chatId: string, sessionId: string, messageIds: string[]) => void {
  const fn = (channel as unknown as Record<string, unknown>)[
    'onPromptBufferDropped'
  ] as (chatId: string, sessionId: string, messageIds: string[]) => void;
  return fn.bind(channel);
}

function getPromptBufferDrainHook(
  channel: DingtalkChannelInstance,
): (chatId: string, sessionId: string, messageIds: string[]) => void {
  const fn = (channel as unknown as Record<string, unknown>)[
    'onPromptBufferDrained'
  ] as (chatId: string, sessionId: string, messageIds: string[]) => void;
  return fn.bind(channel);
}

function getLifecycleHook(
  channel: DingtalkChannelInstance,
): (event: ChannelTaskLifecycleEvent) => void {
  const fn = (channel as unknown as Record<string, unknown>)[
    'onTaskLifecycle'
  ] as (event: ChannelTaskLifecycleEvent) => void;
  return fn.bind(channel);
}

function getCompleteHook(
  channel: DingtalkChannelInstance,
): (
  chatId: string,
  text: string,
  sessionId: string,
  segment?: ChannelOutputSegmentContext,
) => Promise<void> {
  const fn = (channel as unknown as Record<string, unknown>)[
    'onResponseComplete'
  ] as (
    chatId: string,
    text: string,
    sessionId: string,
    segment?: ChannelOutputSegmentContext,
  ) => Promise<void>;
  return fn.bind(channel);
}

function getOutputSegmentEndHook(
  channel: DingtalkChannelInstance,
): (
  chatId: string,
  sessionId: string,
  segment: ChannelOutputSegmentContext,
  reason: ChannelOutputSegmentEndReason,
) => void | Promise<void> {
  const fn = (channel as unknown as Record<string, unknown>)[
    'onOutputSegmentEnd'
  ] as (
    chatId: string,
    sessionId: string,
    segment: ChannelOutputSegmentContext,
    reason: ChannelOutputSegmentEndReason,
  ) => void | Promise<void> | undefined;
  expect(fn).toBeTypeOf('function');
  return fn.bind(channel);
}

function getChunkHook(
  channel: DingtalkChannelInstance,
): (
  chatId: string,
  chunk: string,
  sessionId: string,
  segment?: ChannelOutputSegmentContext,
) => void {
  const fn = (channel as unknown as Record<string, unknown>)[
    'onResponseChunk'
  ] as (
    chatId: string,
    chunk: string,
    sessionId: string,
    segment?: ChannelOutputSegmentContext,
  ) => void;
  return fn.bind(channel);
}

function getUserInputHook(
  channel: DingtalkChannelInstance,
): (context: ChannelUserInputRequestContext) => Promise<{ kind: string }> {
  const fn = (channel as unknown as Record<string, unknown>)[
    'presentUserInputRequest'
  ] as (context: ChannelUserInputRequestContext) => Promise<{ kind: string }>;
  return fn.bind(channel);
}

/** Reactions only fire for message ids seen inbound — mimic message arrival. */
function seedSeenMessage(
  channel: DingtalkChannelInstance,
  messageId: string,
): void {
  (
    channel as unknown as { inboundMessageIds: Set<string> }
  ).inboundMessageIds.add(messageId);
}

function seedWebhook(channel: DingtalkChannelInstance, chatId: string): void {
  (channel as unknown as { webhooks: Map<string, string> }).webhooks.set(
    chatId,
    'https://oapi.dingtalk.com/robot/send?access_token=token',
  );
}

function seedMentionTarget(
  channel: DingtalkChannelInstance,
  messageId: string,
  staffId: string,
): void {
  (
    channel as unknown as { mentionTargets: Map<string, string> }
  ).mentionTargets.set(messageId, staffId);
}

function deferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('DingtalkChannel prompt reactions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('maps lifecycle start and terminal events to the eye reaction', () => {
    const channel = createChannel();
    const attachReaction = vi.fn().mockResolvedValue(undefined);
    const recallReaction = vi.fn().mockResolvedValue(undefined);
    (
      channel as unknown as {
        attachReaction: typeof attachReaction;
        recallReaction: typeof recallReaction;
      }
    ).attachReaction = attachReaction;
    (
      channel as unknown as {
        attachReaction: typeof attachReaction;
        recallReaction: typeof recallReaction;
      }
    ).recallReaction = recallReaction;

    const event = {
      channelName: 'dingtalk',
      chatId: 'cid-123',
      sessionId: 'session-1',
      messageId: 'message-1',
      identity: { id: 'channel:dingtalk', displayName: 'dingtalk' },
      memoryScope: { namespace: 'channel:dingtalk', mode: 'metadata-only' },
    } satisfies LifecycleBase;

    seedSeenMessage(channel, 'message-1');
    seedMentionTarget(channel, 'message-1', 'staff-1');
    const lifecycle = getLifecycleHook(channel);
    lifecycle({ ...event, type: 'started' });
    lifecycle({ ...event, type: 'started' });
    lifecycle({ ...event, type: 'failed', error: 'boom', phase: 'agent' });
    lifecycle({ ...event, type: 'completed' });

    expect(attachReaction).toHaveBeenCalledOnce();
    expect(attachReaction).toHaveBeenCalledWith('message-1', 'cid-123');
    expect(recallReaction).toHaveBeenCalledOnce();
    expect(recallReaction).toHaveBeenCalledWith('message-1', 'cid-123');
    expect(
      (
        channel as unknown as { mentionTargets: Map<string, string> }
      ).mentionTargets.has('message-1'),
    ).toBe(false);
  });

  it('recalls again when a late lifecycle attach resolves after terminal cleanup', async () => {
    const channel = createChannel();
    const attach = deferredPromise<void>();
    const attachReaction = vi
      .fn()
      .mockReturnValueOnce(attach.promise)
      .mockResolvedValueOnce(undefined);
    const recallReaction = vi.fn().mockResolvedValue(undefined);
    (
      channel as unknown as {
        attachReaction: typeof attachReaction;
        recallReaction: typeof recallReaction;
      }
    ).attachReaction = attachReaction;
    (
      channel as unknown as {
        attachReaction: typeof attachReaction;
        recallReaction: typeof recallReaction;
      }
    ).recallReaction = recallReaction;

    const event = {
      channelName: 'dingtalk',
      chatId: 'cid-456',
      sessionId: 'session-2',
      messageId: 'message-2',
      identity: { id: 'channel:dingtalk', displayName: 'dingtalk' },
      memoryScope: { namespace: 'channel:dingtalk', mode: 'metadata-only' },
    } satisfies LifecycleBase;

    seedSeenMessage(channel, 'message-2');
    const lifecycle = getLifecycleHook(channel);
    lifecycle({ ...event, type: 'started' });
    lifecycle({ ...event, type: 'cancelled', reason: 'cancel_command' });

    expect(attachReaction).toHaveBeenNthCalledWith(1, 'message-2', 'cid-456');
    expect(recallReaction).toHaveBeenNthCalledWith(1, 'message-2', 'cid-456');

    attach.resolve();

    await vi.waitFor(() => {
      expect(recallReaction).toHaveBeenNthCalledWith(2, 'message-2', 'cid-456');
      expect(recallReaction).toHaveBeenCalledTimes(2);
    });
  });

  it('does not attach lifecycle reactions without a conversation id', () => {
    const channel = createChannel();
    const attachReaction = vi.fn().mockResolvedValue(undefined);
    (
      channel as unknown as { attachReaction: typeof attachReaction }
    ).attachReaction = attachReaction;

    getLifecycleHook(channel)({
      type: 'started',
      channelName: 'dingtalk',
      chatId: 'HTTPS://oapi.dingtalk.com/robot/send?access_token=token',
      sessionId: 'session-1',
      messageId: 'message-1',
      identity: { id: 'channel:dingtalk', displayName: 'dingtalk' },
      memoryScope: { namespace: 'channel:dingtalk', mode: 'metadata-only' },
    });

    expect(attachReaction).not.toHaveBeenCalled();
  });

  it('clears active lifecycle reactions on disconnect', () => {
    const channel = createChannel();
    const attachReaction = vi.fn().mockResolvedValue(undefined);
    (
      channel as unknown as { attachReaction: typeof attachReaction }
    ).attachReaction = attachReaction;
    const activeReactionKeys = (
      channel as unknown as { activeReactionKeys: Set<string> }
    ).activeReactionKeys;

    seedSeenMessage(channel, 'message-1');
    getLifecycleHook(channel)({
      type: 'started',
      channelName: 'dingtalk',
      chatId: 'cid-123',
      sessionId: 'session-1',
      messageId: 'message-1',
      identity: { id: 'channel:dingtalk', displayName: 'dingtalk' },
      memoryScope: { namespace: 'channel:dingtalk', mode: 'metadata-only' },
    });
    expect(activeReactionKeys.size).toBe(1);

    channel.disconnect();

    expect(activeReactionKeys.size).toBe(0);
  });

  it('skips uppercase webhook URLs when starting a prompt', () => {
    const channel = createChannel();
    const attachReaction = vi.fn().mockResolvedValue(undefined);
    (
      channel as unknown as { attachReaction: typeof attachReaction }
    ).attachReaction = attachReaction;

    getPromptHook(channel, 'onPromptStart')(
      'HTTPS://oapi.dingtalk.com/robot/send?access_token=token',
      'session-1',
      'message-1',
    );

    expect(attachReaction).not.toHaveBeenCalled();
  });

  it('still attaches reactions for conversation IDs', () => {
    const channel = createChannel();
    const attachReaction = vi.fn().mockResolvedValue(undefined);
    (
      channel as unknown as { attachReaction: typeof attachReaction }
    ).attachReaction = attachReaction;

    seedSeenMessage(channel, 'message-1');
    getPromptHook(channel, 'onPromptStart')(
      'cid-123',
      'session-1',
      'message-1',
    );

    expect(attachReaction).toHaveBeenCalledWith('message-1', 'cid-123');
  });

  it('skips uppercase webhook URLs when ending a prompt', () => {
    const channel = createChannel();
    const recallReaction = vi.fn().mockResolvedValue(undefined);
    (
      channel as unknown as { recallReaction: typeof recallReaction }
    ).recallReaction = recallReaction;

    getPromptHook(channel, 'onPromptEnd')(
      'HTTPS://oapi.dingtalk.com/robot/send?access_token=token',
      'session-1',
      'message-1',
    );

    expect(recallReaction).not.toHaveBeenCalled();
  });

  it('skips reactions when the started event has no messageId', () => {
    const channel = createChannel();
    const attachReaction = vi.fn().mockResolvedValue(undefined);
    (
      channel as unknown as { attachReaction: typeof attachReaction }
    ).attachReaction = attachReaction;

    getLifecycleHook(channel)({
      type: 'started',
      channelName: 'dingtalk',
      chatId: 'cid-123',
      sessionId: 'session-1',
      identity: { id: 'channel:dingtalk', displayName: 'dingtalk' },
      memoryScope: { namespace: 'channel:dingtalk', mode: 'metadata-only' },
    });

    expect(attachReaction).not.toHaveBeenCalled();
  });

  it('skips reactions for loop job ids that never arrived as messages', () => {
    const channel = createChannel();
    const attachReaction = vi.fn().mockResolvedValue(undefined);
    (
      channel as unknown as { attachReaction: typeof attachReaction }
    ).attachReaction = attachReaction;

    getPromptHook(channel, 'onPromptStart')('cid-123', 'session-1', 'job-1');

    expect(attachReaction).not.toHaveBeenCalled();
  });

  it('clears the reaction key when attach fails so a retry can attach again', async () => {
    const channel = createChannel();
    const attachReaction = vi
      .fn()
      .mockRejectedValueOnce(new Error('api down'))
      .mockResolvedValueOnce(undefined);
    (
      channel as unknown as { attachReaction: typeof attachReaction }
    ).attachReaction = attachReaction;
    const activeReactionKeys = (
      channel as unknown as { activeReactionKeys: Set<string> }
    ).activeReactionKeys;
    seedSeenMessage(channel, 'message-1');
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      getPromptHook(channel, 'onPromptStart')(
        'cid-123',
        'session-1',
        'message-1',
      );
      await vi.waitFor(() => expect(activeReactionKeys.size).toBe(0));
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('reaction attach failed: api down'),
      );

      getPromptHook(channel, 'onPromptStart')(
        'cid-123',
        'session-1',
        'message-1',
      );
      expect(attachReaction).toHaveBeenCalledTimes(2);
    } finally {
      stderr.mockRestore();
    }
  });

  it.each(['completed', 'cancelled', 'failed'] as const)(
    'recalls the reaction on an isolated %s event',
    (terminal) => {
      const channel = createChannel();
      const attachReaction = vi.fn().mockResolvedValue(undefined);
      const recallReaction = vi.fn().mockResolvedValue(undefined);
      (
        channel as unknown as {
          attachReaction: typeof attachReaction;
          recallReaction: typeof recallReaction;
        }
      ).attachReaction = attachReaction;
      (
        channel as unknown as {
          attachReaction: typeof attachReaction;
          recallReaction: typeof recallReaction;
        }
      ).recallReaction = recallReaction;

      const base = {
        channelName: 'dingtalk',
        chatId: 'cid-123',
        sessionId: 'session-1',
        messageId: 'message-1',
        identity: { id: 'channel:dingtalk', displayName: 'dingtalk' },
        memoryScope: {
          namespace: 'channel:dingtalk',
          mode: 'metadata-only',
        },
      } satisfies LifecycleBase;

      seedSeenMessage(channel, 'message-1');
      const lifecycle = getLifecycleHook(channel);
      lifecycle({ ...base, type: 'started' });
      if (terminal === 'cancelled') {
        lifecycle({ ...base, type: terminal, reason: 'cancel_command' });
      } else if (terminal === 'failed') {
        lifecycle({ ...base, type: terminal, error: 'boom', phase: 'agent' });
      } else {
        lifecycle({ ...base, type: terminal });
      }

      expect(recallReaction).toHaveBeenCalledOnce();
      expect(recallReaction).toHaveBeenCalledWith('message-1', 'cid-123');
    },
  );

  it('recalls reactions when the session dies without terminal events', () => {
    const channel = createChannel();
    const attachReaction = vi.fn().mockResolvedValue(undefined);
    const recallReaction = vi.fn().mockResolvedValue(undefined);
    (
      channel as unknown as {
        attachReaction: typeof attachReaction;
        recallReaction: typeof recallReaction;
      }
    ).attachReaction = attachReaction;
    (
      channel as unknown as {
        attachReaction: typeof attachReaction;
        recallReaction: typeof recallReaction;
      }
    ).recallReaction = recallReaction;
    const activeReactionKeys = (
      channel as unknown as { activeReactionKeys: Set<string> }
    ).activeReactionKeys;

    seedSeenMessage(channel, 'message-1');
    getLifecycleHook(channel)({
      type: 'started',
      channelName: 'dingtalk',
      chatId: 'cid-123',
      sessionId: 'session-1',
      messageId: 'message-1',
      identity: { id: 'channel:dingtalk', displayName: 'dingtalk' },
      memoryScope: { namespace: 'channel:dingtalk', mode: 'metadata-only' },
    });
    expect(activeReactionKeys.size).toBe(1);

    channel.onSessionDied('session-1');

    expect(recallReaction).toHaveBeenCalledWith('message-1', 'cid-123');
    expect(activeReactionKeys.size).toBe(0);
  });

  it('uses the app access token for emotion replies', async () => {
    const channel = createChannel();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://oapi.dingtalk.com/gettoken')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                errcode: 0,
                access_token: 'proactive-token',
                expires_in: 7200,
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

    await (
      channel as unknown as {
        attachReaction(msgId: string, conversationId: string): Promise<void>;
      }
    ).attachReaction('msg-1', 'cid-123');

    const emotionCall = fetchSpy.mock.calls.find((call) =>
      String(call[0]).startsWith(
        'https://api.dingtalk.com/v1.0/robot/emotion/reply',
      ),
    );
    expect(emotionCall).toBeDefined();
    expect(
      ((emotionCall![1] as RequestInit).headers as Record<string, string>)[
        'x-acs-dingtalk-access-token'
      ],
    ).toBe('proactive-token');
  });

  it('uses stream auth token for emotion replies when clientSecret is absent', async () => {
    const channel = createChannel();
    (
      channel as unknown as { config: { clientSecret?: string } }
    ).config.clientSecret = undefined;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      await (
        channel as unknown as {
          attachReaction(msgId: string, conversationId: string): Promise<void>;
        }
      ).attachReaction('msg-1', 'cid-123');

      const emotionCall = fetchSpy.mock.calls.find((call) =>
        String(call[0]).startsWith(
          'https://api.dingtalk.com/v1.0/robot/emotion/reply',
        ),
      );
      expect(emotionCall).toBeDefined();
      expect(
        ((emotionCall![1] as RequestInit).headers as Record<string, string>)[
          'x-acs-dingtalk-access-token'
        ],
      ).toBe('token');
      expect(stderr).not.toHaveBeenCalledWith(
        '[DingTalk:test-dingtalk] emotion/reply skipped: clientSecret not configured\n',
      );
    } finally {
      stderr.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('skips emotion replies before token lookup when robotCode is missing', async () => {
    const channel = createChannel();
    (channel as unknown as { config: { clientId?: string } }).config.clientId =
      '';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          errcode: 0,
          access_token: 'proactive-token',
          expires_in: 7200,
        }),
        { status: 200 },
      ),
    );

    try {
      await (
        channel as unknown as {
          attachReaction(msgId: string, conversationId: string): Promise<void>;
        }
      ).attachReaction('msg-1', 'cid-123');

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('retries transient emotion failures before succeeding', async () => {
    vi.useFakeTimers();
    const channel = createChannel();
    let emotionAttempts = 0;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://oapi.dingtalk.com/gettoken')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                errcode: 0,
                access_token: 'proactive-token',
                expires_in: 7200,
              }),
              { status: 200 },
            ),
          );
        }
        emotionAttempts++;
        return Promise.resolve(
          new Response('{}', { status: emotionAttempts < 3 ? 500 : 200 }),
        );
      });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      const request = (
        channel as unknown as {
          attachReaction(msgId: string, conversationId: string): Promise<void>;
        }
      ).attachReaction('msg-1', 'cid-123');
      await vi.runAllTimersAsync();
      await request;

      expect(emotionAttempts).toBe(3);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      stderr.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('does not retry non-transient emotion failures', async () => {
    const channel = createChannel();
    let emotionAttempts = 0;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://oapi.dingtalk.com/gettoken')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                errcode: 0,
                access_token: 'proactive-token',
                expires_in: 7200,
              }),
              { status: 200 },
            ),
          );
        }
        emotionAttempts++;
        return Promise.resolve(new Response('{}', { status: 400 }));
      });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      await (
        channel as unknown as {
          attachReaction(msgId: string, conversationId: string): Promise<void>;
        }
      ).attachReaction('msg-1', 'cid-123');

      expect(emotionAttempts).toBe(1);
    } finally {
      stderr.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('retries 429 rate-limit responses before succeeding', async () => {
    vi.useFakeTimers();
    const channel = createChannel();
    let emotionAttempts = 0;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://oapi.dingtalk.com/gettoken')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                errcode: 0,
                access_token: 'proactive-token',
                expires_in: 7200,
              }),
              { status: 200 },
            ),
          );
        }
        emotionAttempts++;
        return Promise.resolve(
          new Response('{}', { status: emotionAttempts < 2 ? 429 : 200 }),
        );
      });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      const request = (
        channel as unknown as {
          attachReaction(msgId: string, conversationId: string): Promise<void>;
        }
      ).attachReaction('msg-1', 'cid-123');
      await vi.runAllTimersAsync();
      await request;

      expect(emotionAttempts).toBe(2);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      stderr.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('sanitizes failed emotion response details before logging', async () => {
    vi.useFakeTimers();
    const channel = createChannel();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://oapi.dingtalk.com/gettoken')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                errcode: 0,
                access_token: 'proactive-token',
                expires_in: 7200,
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response('bad\n[DingTalk:fake] forged', { status: 500 }),
        );
      });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      const request = (
        channel as unknown as {
          attachReaction(msgId: string, conversationId: string): Promise<void>;
        }
      ).attachReaction('msg-1', 'cid-123');
      await vi.runAllTimersAsync();
      await request;

      const logged = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(stderr).toHaveBeenCalledOnce();
      expect(logged).toContain('bad\\n[DingTalk:fake] forged');
      expect(logged).not.toContain('bad\n');
    } finally {
      vi.useRealTimers();
      stderr.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

describe('DingtalkChannel status cards', () => {
  it('passes the configured model to the status card controller', () => {
    const channel = createChannel({ model: 'qwen3.7-max' });

    expect(
      (
        channel as unknown as {
          statusCardController?: {
            options: { model?: string };
          };
        }
      ).statusCardController?.options.model,
    ).toBe('qwen3.7-max');
  });

  it('keeps status cards disabled when block streaming is enabled', () => {
    const channel = createChannel({ blockStreaming: 'on' });

    expect(
      (
        channel as unknown as {
          statusCardController?: unknown;
          interactiveCardClient?: unknown;
        }
      ).statusCardController,
    ).toBeUndefined();
    expect(
      (
        channel as unknown as {
          interactiveCardClient?: unknown;
        }
      ).interactiveCardClient,
    ).toBeDefined();
  });

  it('starts a status card only for the matching real inbound owner', () => {
    const channel = createChannel();
    const registerRun = vi.fn();
    const startStatusCard = vi.fn();
    const appendOutput = vi.fn();
    (
      channel as unknown as {
        interactionPresenter: {
          registerRun: typeof registerRun;
          startStatusCard: typeof startStatusCard;
          appendOutput: typeof appendOutput;
        };
        inboundCardOwners: Map<string, unknown>;
      }
    ).interactionPresenter = { registerRun, startStatusCard, appendOutput };
    (
      channel as unknown as {
        inboundCardOwners: Map<string, unknown>;
      }
    ).inboundCardOwners.set('message-1', {
      ownerId: 'owner-1',
      target: { chatId: 'cid-1', isGroup: true },
    });

    getLifecycleHook(channel)({
      type: 'started',
      channelName: 'dingtalk',
      chatId: 'cid-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      runId: 'run-1',
      owner: { kind: 'channel_user', id: 'other-owner' },
    });
    expect(registerRun).not.toHaveBeenCalled();
    expect(startStatusCard).not.toHaveBeenCalled();
    expect(appendOutput).not.toHaveBeenCalled();

    (
      channel as unknown as {
        inboundCardOwners: Map<string, unknown>;
      }
    ).inboundCardOwners.set('message-2', {
      ownerId: 'owner-1',
      target: { chatId: 'cid-1', isGroup: true },
      sender: { senderName: 'Alice' },
    });
    getLifecycleHook(channel)({
      type: 'started',
      channelName: 'dingtalk',
      chatId: 'cid-1',
      sessionId: 'session-1',
      messageId: 'message-2',
      runId: 'run-2',
      owner: { kind: 'channel_user', id: 'owner-1' },
    });

    expect(registerRun).toHaveBeenCalledOnce();
    expect(registerRun).toHaveBeenCalledWith(
      'run-2',
      'owner-1',
      {
        chatId: 'cid-1',
        isGroup: true,
      },
      'session-1',
      { senderName: 'Alice' },
    );
    expect(startStatusCard).toHaveBeenCalledOnce();
    expect(startStatusCard).toHaveBeenCalledWith('run-2');
    expect(startStatusCard.mock.invocationCallOrder[0]).toBeGreaterThan(
      registerRun.mock.invocationCallOrder[0],
    );
    expect(appendOutput).not.toHaveBeenCalled();
  });

  it('captures direct-card correlation by conversation instead of delivery user', async () => {
    const channel = createChannel();
    const envelope: Envelope = {
      channelName: 'dingtalk',
      senderId: 'owner-1',
      senderName: 'Owner',
      chatId: 'conversation-1',
      messageId: 'message-1',
      text: 'hello',
      isGroup: false,
      isMentioned: false,
      isReplyToBot: false,
    };

    await DingtalkChannel.prototype.handleInbound.call(channel, envelope);

    expect(
      (
        channel as unknown as {
          inboundCardOwners: Map<string, unknown>;
        }
      ).inboundCardOwners.get('message-1'),
    ).toEqual({
      ownerId: 'owner-1',
      target: { chatId: 'conversation-1', isGroup: false },
    });
  });

  it('captures the group sender for card attribution when atSender is enabled', async () => {
    const channel = createChannel({ atSender: true });
    const downstream = {
      data: JSON.stringify({
        msgId: 'message-quote',
        conversationType: '2',
        conversationId: 'cid-quote',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        chatbotUserId: 'bot-user',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        senderId: 'owner-1',
        isInAtList: true,
        atUsers: [{ dingtalkId: 'bot-user' }, { dingtalkId: 'other-user' }],
        text: { content: '@qwen-code What changed?' },
      }),
      headers: { messageId: 'message-quote' },
    } as unknown as DWClientDownStream;

    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);
    const envelope = vi.mocked(channel.handleInbound).mock.calls[0]![0];
    await DingtalkChannel.prototype.handleInbound.call(channel, envelope);

    expect(
      (
        channel as unknown as {
          inboundCardOwners: Map<string, unknown>;
        }
      ).inboundCardOwners.get('message-quote'),
    ).toEqual({
      ownerId: 'staff-1',
      target: { chatId: 'cid-quote', isGroup: true },
      sender: { senderName: 'Alice' },
    });
  });

  it('omits the group sender from card attribution when atSender is disabled', async () => {
    const channel = createChannel({ atSender: false });
    const downstream = {
      data: JSON.stringify({
        msgId: 'message-quote',
        conversationType: '2',
        conversationId: 'cid-quote',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        chatbotUserId: 'bot-user',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        senderId: 'owner-1',
        isInAtList: true,
        atUsers: [{ dingtalkId: 'bot-user' }, { dingtalkId: 'other-user' }],
        text: { content: '@qwen-code What changed?' },
      }),
      headers: { messageId: 'message-quote' },
    } as unknown as DWClientDownStream;

    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);
    const envelope = vi.mocked(channel.handleInbound).mock.calls[0]![0];
    await DingtalkChannel.prototype.handleInbound.call(channel, envelope);

    expect(
      (
        channel as unknown as {
          inboundCardOwners: Map<string, unknown>;
        }
      ).inboundCardOwners.get('message-quote'),
    ).toEqual({
      ownerId: 'staff-1',
      target: { chatId: 'cid-quote', isGroup: true },
    });
  });

  it('routes the first visible chunk with its exact segment context', () => {
    const channel = createChannel();
    const appendOutput = vi.fn();
    (
      channel as unknown as {
        interactionPresenter: { appendOutput: typeof appendOutput };
      }
    ).interactionPresenter = { appendOutput };
    const segment = {
      channelName: 'dingtalk',
      sessionId: 'session-1',
      runId: 'run-1',
      segmentId: 'segment-1',
      owner: { kind: 'channel_user', id: 'owner-1' },
      target: {
        channelName: 'dingtalk',
        chatId: 'cid-1',
        senderId: 'owner-1',
        isGroup: true,
      },
    } as ChannelOutputSegmentContext;

    getChunkHook(channel)('cid-1', 'first', 'session-1', segment);

    expect(appendOutput).toHaveBeenCalledWith(segment, 'first');
  });

  it('uses the awaited status finalization or falls back to Markdown', async () => {
    const channel = createChannel();
    seedWebhook(channel, 'cid-1');
    const closeOutput = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    (
      channel as unknown as {
        interactionPresenter: { closeOutput: typeof closeOutput };
      }
    ).interactionPresenter = { closeOutput };
    const segment = {
      channelName: 'dingtalk',
      sessionId: 'session-1',
      runId: 'run-1',
      segmentId: 'segment-1',
      owner: { kind: 'channel_user', id: 'owner-1' },
      target: {
        channelName: 'dingtalk',
        chatId: 'cid-1',
        senderId: 'owner-1',
        isGroup: true,
      },
    } as ChannelOutputSegmentContext;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}'));

    await getCompleteHook(channel)('cid-1', 'first', 'session-1', segment);
    expect(fetchSpy).not.toHaveBeenCalled();

    await getCompleteHook(channel)('cid-1', 'second', 'session-1', {
      ...segment,
      segmentId: 'segment-2',
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('uploads a final status card image before closing output', async () => {
    const image = createTempPng();
    const channel = createChannel({ cwd: image.dir });
    const closeOutput = vi.fn().mockResolvedValue(true);
    (
      channel as unknown as {
        interactionPresenter: { closeOutput: typeof closeOutput };
      }
    ).interactionPresenter = { closeOutput };
    const segment = {
      channelName: 'dingtalk',
      sessionId: 'session-1',
      runId: 'run-1',
      segmentId: 'segment-1',
      owner: { kind: 'channel_user', id: 'owner-1' },
      target: {
        channelName: 'dingtalk',
        chatId: 'cid-1',
        senderId: 'owner-1',
        isGroup: true,
      },
    } as ChannelOutputSegmentContext;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://oapi.dingtalk.com/gettoken')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                errcode: 0,
                access_token: 'proactive-token',
                expires_in: 7200,
              }),
              { status: 200 },
            ),
          );
        }
        if (url.startsWith('https://oapi.dingtalk.com/media/upload')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                errcode: 0,
                media_id: '@lAL-card-media-id',
              }),
              { status: 200 },
            ),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      });

    try {
      await getCompleteHook(channel)(
        'cid-1',
        `before\n[IMAGE: ${image.path}]\nafter`,
        'session-1',
        segment,
      );

      const finalText = String(closeOutput.mock.calls[0]?.[1]);
      expect(finalText).toContain('![image](@lAL-card-media-id)');
      expect(finalText).not.toContain('[IMAGE:');
      expect(finalText).not.toContain(image.path);
    } finally {
      fetchSpy.mockRestore();
      rmSync(image.dir, { recursive: true, force: true });
    }
  });

  it('terminalizes the presenter when the agent response is empty', () => {
    const channel = createChannel();
    const terminalizeRun = vi.fn();
    (
      channel as unknown as {
        interactionPresenter: { terminalizeRun: typeof terminalizeRun };
        cardRunBySession: Map<string, string>;
      }
    ).interactionPresenter = { terminalizeRun };
    (
      channel as unknown as {
        cardRunBySession: Map<string, string>;
      }
    ).cardRunBySession.set('session-1', 'run-1');

    getLifecycleHook(channel)({
      type: 'completed',
      channelName: 'dingtalk',
      chatId: 'cid-1',
      sessionId: 'session-1',
      runId: 'run-1',
      owner: { kind: 'channel_user', id: 'owner-1' },
    });

    expect(terminalizeRun).toHaveBeenCalledWith('run-1', 'completed');
  });

  it('closes the exact output segment when that segment ends', async () => {
    const channel = createChannel();
    const closeOutput = vi.fn().mockResolvedValue(true);
    (
      channel as unknown as {
        interactionPresenter: { closeOutput: typeof closeOutput };
      }
    ).interactionPresenter = { closeOutput };
    const segment = {
      channelName: 'dingtalk',
      sessionId: 'session-1',
      runId: 'run-1',
      segmentId: 'segment-1',
      owner: { kind: 'channel_user', id: 'owner-1' },
      target: {
        channelName: 'dingtalk',
        chatId: 'cid-1',
        senderId: 'owner-1',
        isGroup: true,
      },
    } as ChannelOutputSegmentContext;

    await getOutputSegmentEndHook(channel)(
      'cid-1',
      'session-1',
      segment,
      'input_requested',
    );

    expect(closeOutput).toHaveBeenCalledWith(
      'segment-1',
      '',
      'input_requested',
      segment,
    );
  });

  it('does not let a stale terminal event detach a newer session run', () => {
    const channel = createChannel();
    const terminalizeRun = vi.fn();
    const maps = channel as unknown as {
      cardRunBySession: Map<string, string>;
      cardRuns: Map<string, unknown>;
      interactionPresenter: { terminalizeRun: typeof terminalizeRun };
    };
    maps.interactionPresenter = { terminalizeRun };
    maps.cardRunBySession.set('session-1', 'run-new');
    maps.cardRuns.set('run-old', {});
    maps.cardRuns.set('run-new', {});

    getLifecycleHook(channel)({
      type: 'completed',
      channelName: 'dingtalk',
      chatId: 'cid-1',
      sessionId: 'session-1',
      runId: 'run-old',
      owner: { kind: 'channel_user', id: 'owner-1' },
    });

    expect(terminalizeRun).toHaveBeenCalledWith('run-old', 'completed');
    expect(maps.cardRunBySession.get('session-1')).toBe('run-new');
    expect(maps.cardRuns.has('run-old')).toBe(false);
    expect(maps.cardRuns.has('run-new')).toBe(true);
  });
});

describe('DingtalkChannel question cards', () => {
  it.each([
    undefined,
    { enabled: false },
    { questionCard: { enabled: false } },
  ])(
    'returns unsupported without cancelling when question cards are disabled: %j',
    async (interactiveCards) => {
      const channel = createChannel({ interactiveCards });
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const respond = vi.fn().mockResolvedValue(true);
      Object.assign(channel, { sendMessage });
      (
        channel as unknown as {
          cardRuns: Map<string, unknown>;
        }
      ).cardRuns.set('run-disabled', {
        ownerId: 'owner-1',
        target: { chatId: 'conversation-1', isGroup: false },
      });
      const context = {
        requestId: 'request-disabled',
        sessionId: 'session-disabled',
        runId: 'run-disabled',
        owner: { kind: 'channel_user', id: 'owner-1' },
        target: {
          channelName: 'dingtalk',
          senderId: 'owner-1',
          chatId: 'conversation-1',
          isGroup: false,
        },
        questions: [],
        submitOptionId: 'proceed_once',
        onSettled: () => () => {},
        respond,
      } as ChannelUserInputRequestContext;

      await expect(getUserInputHook(channel)(context)).resolves.toEqual({
        kind: 'unsupported',
      });
      expect(respond).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  it('keeps question cards eligible while block streaming is enabled', () => {
    const channel = createChannel({ blockStreaming: 'on' });

    expect(
      (
        channel as unknown as {
          questionCardController?: unknown;
        }
      ).questionCardController,
    ).toBeDefined();
  });

  it('presents through the matching attended run only', async () => {
    const channel = createChannel();
    const closeOutput = vi.fn().mockResolvedValue(true);
    const presentInput = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'presented' })
      .mockResolvedValueOnce({ kind: 'unsupported' });
    (
      channel as unknown as {
        interactionPresenter: {
          closeOutput: typeof closeOutput;
          presentInput: typeof presentInput;
        };
        cardRuns: Map<string, unknown>;
      }
    ).interactionPresenter = { closeOutput, presentInput };
    (channel as unknown as { cardRuns: Map<string, unknown> }).cardRuns.set(
      'run-1',
      {
        ownerId: 'owner-1',
        target: { chatId: 'cid-1', isGroup: true },
      },
    );
    const context = {
      requestId: 'request-1',
      sessionId: 'session-1',
      runId: 'run-1',
      owner: { kind: 'channel_user', id: 'owner-1' },
      precedingSegmentId: 'segment-1',
    } as ChannelUserInputRequestContext;

    await expect(getUserInputHook(channel)(context)).resolves.toEqual({
      kind: 'presented',
    });
    expect(presentInput).toHaveBeenCalledWith(context);
    expect(closeOutput).not.toHaveBeenCalled();

    await expect(
      getUserInputHook(channel)({ ...context, runId: 'unknown' }),
    ).resolves.toEqual({ kind: 'unsupported' });
  });
});

describe('DingtalkChannel inbound media', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function attachImage(
    channel: DingtalkChannelInstance,
    envelope: Envelope,
    downloadCode: string,
  ): Promise<void> {
    return (
      channel as unknown as {
        attachMedia(
          envelope: Envelope,
          downloadCode: string,
          mediaType: 'image',
        ): Promise<void>;
      }
    ).attachMedia(envelope, downloadCode, 'image');
  }

  it('refreshes the app access token after its TTL while the stream stays connected', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T00:00:00Z'));
    const channel = createChannel();
    let tokenCall = 0;
    const mediaTokens: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('https://oapi.dingtalk.com/gettoken')) {
          tokenCall++;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                errcode: 0,
                access_token: `app-token-${tokenCall}`,
                expires_in: 60,
              }),
              { status: 200 },
            ),
          );
        }
        if (
          url === 'https://api.dingtalk.com/v1.0/robot/messageFiles/download'
        ) {
          mediaTokens.push(
            (init?.headers as Record<string, string>)[
              'x-acs-dingtalk-access-token'
            ],
          );
          return Promise.resolve(
            new Response(
              JSON.stringify({ downloadUrl: 'https://example.com/image' }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
        );
      },
    );
    const firstEnvelope = {} as Envelope;
    const secondEnvelope = {} as Envelope;
    await attachImage(channel, firstEnvelope, 'download-code-1');
    vi.advanceTimersByTime(61_000);
    await attachImage(channel, secondEnvelope, 'download-code-2');

    expect(tokenCall).toBe(2);
    expect(mediaTokens).toEqual(['app-token-1', 'app-token-2']);
    expect(firstEnvelope.attachments).toHaveLength(1);
    expect(secondEnvelope.attachments).toHaveLength(1);
  });

  it('keeps media attachment best-effort when app token refresh fails', async () => {
    const channel = createChannel();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error(
        'request failed for https://oapi.dingtalk.com/gettoken?appkey=client-id&appsecret=client-secret',
      ),
    );
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await expect(
      attachImage(channel, {} as Envelope, 'download-code'),
    ).resolves.toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledWith(
      '[DingTalk:test-dingtalk] Cannot download media: access token refresh failed.\n',
    );
    const logged = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(logged).toContain(
      '[DingTalk:test-dingtalk] access token fetch failed.\n',
    );
    expect(logged).not.toContain('client-secret');
  });
});

describe('DingtalkChannel.isUnroutableGroupMessage', () => {
  it('drops group messages with no conversationId', () => {
    expect(DingtalkChannel.isUnroutableGroupMessage(true, undefined)).toBe(
      true,
    );
    expect(DingtalkChannel.isUnroutableGroupMessage(true, '')).toBe(true);
  });

  it('keeps routable group messages and all DMs', () => {
    expect(DingtalkChannel.isUnroutableGroupMessage(true, 'cid123')).toBe(
      false,
    );
    expect(DingtalkChannel.isUnroutableGroupMessage(false, undefined)).toBe(
      false,
    );
  });
});

describe('DingtalkChannel unroutable-message logging', () => {
  it('neutralizes a newline-bearing senderNick before logging', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: 'm1',
        // conversationType '2' = group; no conversationId => unroutable.
        conversationType: '2',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Mallory\n[DingTalk:fake] forged log line',
      }),
      headers: { messageId: 'm1' },
    } as unknown as DWClientDownStream;

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(logged).toContain('sender=Mallory  DingTalk:fake  forged log line)');
    expect(logged).not.toContain('Mallory\n');
    expect(logged).not.toContain('[DingTalk:fake]');
  });
});

describe('DingtalkChannel parsed-message logging', () => {
  it('forwards the inbound conversation title as the group name', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: 'group-name-m1',
        conversationType: '2',
        conversationId: 'cid123',
        conversationTitle: 'Project Group',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        senderId: 'sender-1',
        isInAtList: true,
        text: { content: '@qwen-code hello' },
      }),
      headers: { messageId: 'group-name-m1' },
    } as unknown as DWClientDownStream;

    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);

    expect(channel.handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'cid123',
        chatName: 'Project Group',
        isGroup: true,
      }),
    );
  });

  it('uses conversation fallback for thread scope when DingTalk has no thread id', () => {
    const channel = createChannel({ sessionScope: 'thread' });
    const downstream = {
      data: JSON.stringify({
        msgId: 'thread-fallback-m1',
        conversationType: '2',
        conversationId: 'cid-thread-fallback',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        senderId: 'sender-1',
        isInAtList: true,
        text: { content: '@qwen-code hello' },
      }),
      headers: { messageId: 'thread-fallback-m1' },
    } as unknown as DWClientDownStream;

    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);

    const inbound = vi.mocked(channel.handleInbound).mock.calls[0]![0];
    expect(inbound).toMatchObject({
      chatId: 'cid-thread-fallback',
      isGroup: true,
    });
    expect(inbound).not.toHaveProperty('threadId');
  });

  it('logs debug payloads when enabled for the channel', () => {
    const oldDebugPayload = process.env['QWEN_CHANNEL_DEBUG_PAYLOAD'];
    process.env['QWEN_CHANNEL_DEBUG_PAYLOAD'] = 'test-dingtalk';
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: 'debug-m1',
        conversationType: '2',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        senderId: 'sender-1',
        isInAtList: true,
        atUsers: [
          { dingtalkId: 'private-dingtalk-id', staffId: 'private-staff-id' },
        ],
        text: { content: '@qwen-code hello' },
      }),
      headers: { messageId: 'debug-m1' },
    } as unknown as DWClientDownStream;
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    let logged = '';

    try {
      (
        channel as unknown as { onMessage(d: DWClientDownStream): void }
      ).onMessage(downstream);
      logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      if (oldDebugPayload === undefined) {
        delete process.env['QWEN_CHANNEL_DEBUG_PAYLOAD'];
      } else {
        process.env['QWEN_CHANNEL_DEBUG_PAYLOAD'] = oldDebugPayload;
      }
      writeSpy.mockRestore();
    }

    expect(logged).toContain('[DingTalk:test-dingtalk] debug payload');
    expect(logged).toContain('"msgId":"debug-m1"');
    expect(logged).toContain('"sessionWebhook":"[redacted]"');
    expect(logged).not.toContain('access_token=token');
    expect(logged).toContain('"dingtalkId":"[redacted]"');
    expect(logged).toContain('"staffId":"[redacted]"');
    expect(logged).not.toContain('private-dingtalk-id');
    expect(logged).not.toContain('private-staff-id');
  });

  it('logs parsed routing and sender fields for routable group messages', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: 'm1',
        conversationType: '2',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        senderId: 'sender-1',
        isInAtList: true,
        text: { content: '@qwen-code hello' },
      }),
      headers: { messageId: 'm1' },
    } as unknown as DWClientDownStream;

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(logged).toContain(
      '[DingTalk:test-dingtalk] message msgId=m1 conversationId=cid123 isGroup=true isMentioned=true senderNick=Alice senderStaffId=staff-1 senderId=sender-1',
    );
  });
});

describe('DingtalkChannel downstream logging', () => {
  it('replaces raw SDK Buffer logging with a structured downstream summary', () => {
    createChannel();
    const client = latestMockClient() as {
      debug: boolean;
      onDownStream(data: Buffer): void;
      onCallback: ReturnType<typeof vi.fn>;
    };
    const raw = Buffer.from(
      JSON.stringify({
        specVersion: '1.0',
        type: 'CALLBACK',
        headers: {
          messageId: 'message-1',
          topic: 'robot',
        },
        data: '{"msgId":"m1"}',
      }),
    );

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    dingtalkSdkMock.rawLog.mockClear();
    client.onDownStream(raw);
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(dingtalkSdkMock.rawLog).not.toHaveBeenCalled();
    expect(logged).toContain(
      `[DingTalk:test-dingtalk] downstream type=CALLBACK topic=robot messageId=message-1 bytes=${raw.length}`,
    );
    expect(client.debug).toBe(false);
    expect(client.onCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'CALLBACK',
        headers: expect.objectContaining({
          messageId: 'message-1',
          topic: 'robot',
        }),
      }),
    );
  });

  it('sanitizes malformed downstream parse errors and skips dispatch', () => {
    createChannel();
    const client = latestMockClient() as {
      onDownStream(data: Buffer): void;
      onSystem: ReturnType<typeof vi.fn>;
      onEvent: ReturnType<typeof vi.fn>;
      onCallback: ReturnType<typeof vi.fn>;
    };
    const raw = Buffer.from('not json\n[DingTalk:fake]');

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    client.onDownStream(raw);
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(logged).toContain(
      '[DingTalk:test-dingtalk] Failed to parse downstream:',
    );
    expect(logged).not.toContain('not json\n');
    expect(logged).not.toContain('\n[DingTalk:fake]');
    expect(logged).not.toContain('[DingTalk:fake]');
    expect(client.onSystem).not.toHaveBeenCalled();
    expect(client.onEvent).not.toHaveBeenCalled();
    expect(client.onCallback).not.toHaveBeenCalled();
  });

  it('ignores downstream JSON that is not an object', () => {
    createChannel();
    const client = latestMockClient() as {
      onDownStream(data: Buffer): void;
      onSystem: ReturnType<typeof vi.fn>;
      onEvent: ReturnType<typeof vi.fn>;
      onCallback: ReturnType<typeof vi.fn>;
    };

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    expect(() => client.onDownStream(Buffer.from('null'))).not.toThrow();
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(logged).toContain(
      '[DingTalk:test-dingtalk] downstream parsed to non-object, ignoring.',
    );
    expect(client.onSystem).not.toHaveBeenCalled();
    expect(client.onEvent).not.toHaveBeenCalled();
    expect(client.onCallback).not.toHaveBeenCalled();
  });

  it('logs SDK dispatch failures without propagating them', () => {
    createChannel();
    const client = latestMockClient() as {
      onDownStream(data: Buffer): void;
      onCallback: ReturnType<typeof vi.fn>;
    };
    client.onCallback.mockImplementationOnce(() => {
      throw new Error('callback failed\n[DingTalk:fake]');
    });
    const raw = Buffer.from(
      JSON.stringify({
        specVersion: '1.0',
        type: 'CALLBACK',
        headers: {
          messageId: 'message-1',
          topic: 'robot',
        },
        data: '{"msgId":"m1"}',
      }),
    );

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    expect(() => client.onDownStream(raw)).not.toThrow();
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(logged).toContain('[DingTalk:test-dingtalk] onCallback failed:');
    expect(logged).not.toContain('callback failed\n');
    expect(logged).not.toContain('\n[DingTalk:fake]');
  });

  it('ignores downstream frames with non-string routing fields', () => {
    createChannel();
    const client = latestMockClient() as {
      onDownStream(data: Buffer): void;
      onSystem: ReturnType<typeof vi.fn>;
      onEvent: ReturnType<typeof vi.fn>;
      onCallback: ReturnType<typeof vi.fn>;
    };
    const raw = Buffer.from(
      JSON.stringify({
        specVersion: '1.0',
        type: { forged: 'CALLBACK' },
        headers: {
          messageId: { value: 'message-1' },
          topic: ['robot'],
        },
        data: '{"msgId":"m1"}',
      }),
    );

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    expect(() => client.onDownStream(raw)).not.toThrow();
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(logged).toContain(
      `[DingTalk:test-dingtalk] downstream type= topic= messageId= bytes=${raw.length}`,
    );
    expect(logged).toContain(
      '[DingTalk:test-dingtalk] Ignoring downstream type unknown.',
    );
    expect(client.onSystem).not.toHaveBeenCalled();
    expect(client.onEvent).not.toHaveBeenCalled();
    expect(client.onCallback).not.toHaveBeenCalled();
  });

  it('rejects callback frames with invalid routing headers before dispatch', () => {
    createChannel();
    const client = latestMockClient() as {
      onDownStream(data: Buffer): void;
      onCallback: ReturnType<typeof vi.fn>;
    };
    const raw = Buffer.from(
      JSON.stringify({
        specVersion: '1.0',
        type: 'CALLBACK',
        headers: {
          messageId: 'message-1',
          topic: ['robot'],
        },
        data: '{"msgId":"m1"}',
      }),
    );

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    expect(() => client.onDownStream(raw)).not.toThrow();
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(logged).toContain(
      '[DingTalk:test-dingtalk] Ignoring downstream with invalid routing headers.',
    );
    expect(client.onCallback).not.toHaveBeenCalled();
  });
});

describe('DingtalkChannel sender attribution', () => {
  it('falls back to senderStaffId when senderNick is absent', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: 'm1',
        conversationType: '2',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderStaffId: 'staff-1',
        senderId: 'sender-1',
        isInAtList: true,
        text: { content: '@qwen-code hello' },
      }),
      headers: { messageId: 'm1' },
    } as unknown as DWClientDownStream;

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);
    writeSpy.mockRestore();

    const handleInbound = (
      channel as unknown as {
        handleInbound: ReturnType<typeof vi.fn>;
      }
    ).handleInbound;

    expect(handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: 'staff-1',
        senderName: 'staff-1',
      }),
    );
  });

  it('passes mention-stripped text with platform format characters to base', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: 'm1',
        conversationType: '2',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        senderId: 'sender-1',
        isInAtList: true,
        text: { content: '@qwen-code 查看记忆\u200b' },
      }),
      headers: { messageId: 'm1' },
    } as unknown as DWClientDownStream;

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);
    writeSpy.mockRestore();

    const handleInbound = (
      channel as unknown as {
        handleInbound: ReturnType<typeof vi.fn>;
      }
    ).handleInbound;

    expect(handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '查看记忆\u200b',
        isGroup: true,
        isMentioned: true,
      }),
    );
  });

  it('does not consume text after a mention followed by a format character', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: 'm1',
        conversationType: '2',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        senderId: 'sender-1',
        isInAtList: true,
        text: { content: '@qwen-code\u200b查看记忆' },
      }),
      headers: { messageId: 'm1' },
    } as unknown as DWClientDownStream;

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);
    writeSpy.mockRestore();

    const handleInbound = (
      channel as unknown as {
        handleInbound: ReturnType<typeof vi.fn>;
      }
    ).handleInbound;

    expect(handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '\u200b查看记忆',
        isGroup: true,
        isMentioned: true,
      }),
    );
  });

  it('preserves @ in git URLs and emails when stripping bot mention (#7402)', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: 'm1',
        conversationType: '2',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        senderId: 'sender-1',
        isInAtList: true,
        text: {
          content: '@qwen-code 重复： git@example.com:group/repo.git',
        },
      }),
      headers: { messageId: 'm1' },
    } as unknown as DWClientDownStream;

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);
    writeSpy.mockRestore();

    const handleInbound = (
      channel as unknown as {
        handleInbound: ReturnType<typeof vi.fn>;
      }
    ).handleInbound;

    expect(handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '重复： git@example.com:group/repo.git',
        isMentioned: true,
      }),
    );
  });

  it('does not strip @ in URLs when bot mention is absent from text (#7402)', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: 'm2',
        conversationType: '2',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        senderId: 'sender-1',
        isInAtList: true,
        text: {
          content: '重复： git@example.com:group/repo.git',
        },
      }),
      headers: { messageId: 'm2' },
    } as unknown as DWClientDownStream;

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);
    writeSpy.mockRestore();

    const handleInbound = (
      channel as unknown as {
        handleInbound: ReturnType<typeof vi.fn>;
      }
    ).handleInbound;

    // When the bot @mention is not in the text (DingTalk already stripped it),
    // the regex must NOT eat the @ in the git URL.
    expect(handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '重复： git@example.com:group/repo.git',
        isMentioned: true,
      }),
    );
  });

  it('preserves non-bot mentions when DingTalk removes names from text', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: 'structured-mentions',
        conversationType: '2',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        senderId: 'sender-1',
        chatbotUserId: 'bot-user',
        isInAtList: true,
        atUsers: [
          { dingtalkId: 'bot-user' },
          { dingtalkId: 'member-user', staffId: 'member-staff' },
          { dingtalkId: 'member-user', staffId: 'member-staff' },
        ],
        text: { content: 'please review this' },
      }),
      headers: { messageId: 'structured-mentions' },
    } as unknown as DWClientDownStream;

    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);

    expect(channel.handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '[Mentioned 1 other group member]\nplease review this',
        isMentioned: true,
      }),
    );
  });

  it('does not add mention context when only the bot was mentioned', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: 'bot-only-mention',
        conversationType: '2',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        senderId: 'sender-1',
        chatbotUserId: 'bot-user',
        isInAtList: true,
        atUsers: [{ dingtalkId: 'bot-user' }],
        text: { content: 'hello' },
      }),
      headers: { messageId: 'bot-only-mention' },
    } as unknown as DWClientDownStream;

    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);

    expect(channel.handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello', isMentioned: true }),
    );
  });

  it('uses plural label when multiple distinct non-bot members are mentioned', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: 'plural-mentions',
        conversationType: '2',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        senderId: 'sender-1',
        chatbotUserId: 'bot-user',
        isInAtList: true,
        atUsers: [
          { dingtalkId: 'bot-user' },
          { dingtalkId: 'user-a' },
          { dingtalkId: 'user-b' },
        ],
        text: { content: 'please review this' },
      }),
      headers: { messageId: 'plural-mentions' },
    } as unknown as DWClientDownStream;

    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);

    expect(channel.handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '[Mentioned 2 other group members]\nplease review this',
        isMentioned: true,
      }),
    );
  });

  it('falls back to staffId when dingtalkId is absent', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: 'staffid-fallback',
        conversationType: '2',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        senderId: 'sender-1',
        chatbotUserId: 'bot-user',
        isInAtList: true,
        atUsers: [{ dingtalkId: 'bot-user' }, { staffId: 'only-staff' }],
        text: { content: 'hello' },
      }),
      headers: { messageId: 'staffid-fallback' },
    } as unknown as DWClientDownStream;

    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);

    expect(channel.handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '[Mentioned 1 other group member]\nhello',
        isMentioned: true,
      }),
    );
  });

  it('returns text unchanged when chatbotUserId is absent', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: 'no-chatbot-id',
        conversationType: '2',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        senderId: 'sender-1',
        isInAtList: true,
        atUsers: [{ dingtalkId: 'user-a' }],
        text: { content: 'hello' },
      }),
      headers: { messageId: 'no-chatbot-id' },
    } as unknown as DWClientDownStream;

    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);

    expect(channel.handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello', isMentioned: true }),
    );
  });

  it('returns context only when text is empty after mention stripping', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: 'empty-text-mention',
        conversationType: '2',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        senderId: 'sender-1',
        chatbotUserId: 'bot-user',
        isInAtList: true,
        atUsers: [{ dingtalkId: 'bot-user' }, { dingtalkId: 'user-a' }],
        text: { content: '' },
      }),
      headers: { messageId: 'empty-text-mention' },
    } as unknown as DWClientDownStream;

    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);

    expect(channel.handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '[Mentioned 1 other group member]',
        isMentioned: true,
      }),
    );
  });

  it('ignores non-string message metadata when logging parsed JSON', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: { value: 'm1' },
        conversationType: '2',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: { value: 'Alice' },
        senderStaffId: ['staff-1'],
        senderId: 123,
        isInAtList: true,
        text: { content: '@qwen-code hello' },
      }),
      headers: { messageId: 'header-m1' },
    } as unknown as DWClientDownStream;

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    expect(() =>
      (
        channel as unknown as { onMessage(d: DWClientDownStream): void }
      ).onMessage(downstream),
    ).not.toThrow();
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(logged).toContain(
      '[DingTalk:test-dingtalk] message msgId=header-m1 conversationId=cid123 isGroup=true isMentioned=true senderNick= senderStaffId= senderId=',
    );
  });

  it('falls back to downstream header messageId when body msgId is empty', () => {
    const channel = createChannel();
    const downstream = {
      data: JSON.stringify({
        msgId: '',
        conversationType: '1',
        conversationId: 'cid123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderNick: 'Alice',
        senderStaffId: 'staff-1',
        isInAtList: false,
        text: { content: 'hello' },
      }),
      headers: { messageId: 'header-m1' },
    } as unknown as DWClientDownStream;

    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    (
      channel as unknown as { onMessage(d: DWClientDownStream): void }
    ).onMessage(downstream);
    writeSpy.mockRestore();

    const handleInbound = (
      channel as unknown as {
        handleInbound: ReturnType<typeof vi.fn>;
      }
    ).handleInbound;

    expect(handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'header-m1',
      }),
    );
  });
});

describe('DingtalkChannel reply mentions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('retains queued mention after dedup cleanup until onPromptStart', async () => {
    vi.useFakeTimers();
    const channel = createChannel({ atSender: true });
    seedWebhook(channel, 'cid123');
    seedMentionTarget(channel, 'm1', 'staff-1');
    (
      channel as unknown as { seenMessages: Map<string, number> }
    ).seenMessages.set('m1', Date.now() - 5 * 60 * 1000 - 1);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    try {
      await channel.connect();
      await vi.advanceTimersByTimeAsync(60_000);

      getPromptHook(channel, 'onPromptStart')('cid123', 'session-1', 'm1');
      await getResponseHook(channel)('cid123', 'hello', 'session-1');

      expect(fetchSpy).toHaveBeenCalledOnce();
      const body = JSON.parse(
        String((fetchSpy.mock.calls[0]![1] as RequestInit).body),
      );
      expect(body).toMatchObject({
        msgtype: 'markdown',
        markdown: { text: '@staff-1\n\nhello' },
        at: { atUserIds: ['staff-1'] },
      });
    } finally {
      channel.disconnect();
      vi.useRealTimers();
    }
  });

  it('removes mention targets for dropped queued prompts', () => {
    const channel = createChannel({ atSender: true });
    seedMentionTarget(channel, 'm1', 'staff-1');

    getPromptBufferDropHook(channel)('cid123', 'session-1', ['m1']);

    expect(
      (
        channel as unknown as { mentionTargets: Map<string, string> }
      ).mentionTargets.has('m1'),
    ).toBe(false);
  });

  it('keeps only the final mention target for a coalesced queued prompt', () => {
    const channel = createChannel({ atSender: true });
    seedMentionTarget(channel, 'm1', 'staff-1');
    seedMentionTarget(channel, 'm2', 'staff-2');

    getPromptBufferDrainHook(channel)('cid123', 'session-1', ['m1', 'm2']);

    const mentionTargets = (
      channel as unknown as { mentionTargets: Map<string, string> }
    ).mentionTargets;
    expect(mentionTargets.has('m1')).toBe(false);
    expect(mentionTargets.get('m2')).toBe('staff-2');
  });

  it('mentions the originating group member when atSender is enabled', async () => {
    const channel = createChannel({ atSender: true });
    seedWebhook(channel, 'cid123');
    seedMentionTarget(channel, 'm1', 'staff-1');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    getPromptHook(channel, 'onPromptStart')('cid123', 'session-1', 'm1');
    await getResponseHook(channel)('cid123', 'hello', 'session-1');

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(
      JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body)),
    ).toMatchObject({
      msgtype: 'markdown',
      markdown: { text: '@staff-1\n\nhello' },
      at: { atUserIds: ['staff-1'] },
    });
  });

  it('logs the redacted mention delivery result when diagnostics are enabled', async () => {
    vi.stubEnv('QWEN_CHANNEL_DEBUG_MENTIONS', '1');
    const channel = createChannel({ atSender: true });
    seedWebhook(channel, 'cid123');
    seedMentionTarget(channel, 'm1', 'staff-1');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ errcode: 0 }), { status: 200 }),
    );
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    getPromptHook(channel, 'onPromptStart')('cid123', 'session-1', 'm1');
    await getResponseHook(channel)('cid123', 'hello', 'session-1');

    expect(writeSpy).toHaveBeenCalledWith(
      '[DingTalk:test-dingtalk] mention delivery status=200 code=0\n',
    );
  });

  it('does not mention the sender by default', async () => {
    const channel = createChannel();
    seedWebhook(channel, 'cid123');
    seedMentionTarget(channel, 'm1', 'staff-1');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    getPromptHook(channel, 'onPromptStart')('cid123', 'session-1', 'm1');
    await getResponseHook(channel)('cid123', 'hello', 'session-1');

    const body = JSON.parse(
      String((fetchSpy.mock.calls[0]![1] as RequestInit).body),
    );
    expect(body).toMatchObject({
      msgtype: 'markdown',
      markdown: { text: 'hello' },
    });
    expect(body).not.toHaveProperty('at');
  });

  it('does not mention when the correlated prompt has no stored staff ID', async () => {
    const channel = createChannel({ atSender: true });
    seedWebhook(channel, 'cid123');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    getPromptHook(channel, 'onPromptStart')('cid123', 'session-1', 'm1');
    await getResponseHook(channel)('cid123', 'hello', 'session-1');

    const body = JSON.parse(
      String((fetchSpy.mock.calls[0]![1] as RequestInit).body),
    );
    expect(body).toMatchObject({
      msgtype: 'markdown',
      markdown: { text: 'hello' },
    });
    expect(body).not.toHaveProperty('at');
  });

  it('reserves the mention prefix within the first markdown chunk limit', async () => {
    const channel = createChannel({ atSender: true });
    seedWebhook(channel, 'cid123');
    seedMentionTarget(channel, 'm1', 'staff-1');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    getPromptHook(channel, 'onPromptStart')('cid123', 'session-1', 'm1');
    const text = 'a'.repeat(3800);
    await getResponseHook(channel)('cid123', text, 'session-1');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const bodies = fetchSpy.mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)),
    );
    expect(bodies[0]).toMatchObject({
      msgtype: 'markdown',
      at: { atUserIds: ['staff-1'] },
    });
    expect(bodies[1]).toMatchObject({ msgtype: 'markdown' });
    expect(bodies[1]).not.toHaveProperty('at');
    expect(bodies.map((body) => body.markdown.text.length)).toEqual([3800, 10]);
    expect(
      bodies
        .map((body, index) =>
          index === 0
            ? body.markdown.text.slice('@staff-1\n\n'.length)
            : body.markdown.text,
        )
        .join(''),
    ).toBe(text);
  });

  it('preserves code fences across mentioned text chunks', async () => {
    const channel = createChannel({ atSender: true });
    seedWebhook(channel, 'cid123');
    seedMentionTarget(channel, 'm1', 'staff-1');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const text = `\`\`\`\n${'a'.repeat(3800)}\n\`\`\``;

    getPromptHook(channel, 'onPromptStart')('cid123', 'session-1', 'm1');
    await getResponseHook(channel)('cid123', text, 'session-1');

    const contents = fetchSpy.mock.calls.map(([, init], index) => {
      const body = JSON.parse(String((init as RequestInit).body));
      return index === 0
        ? body.markdown.text.slice('@staff-1\n\n'.length)
        : body.markdown.text;
    });
    expect(contents[0]).toMatch(/^```/u);
    expect(contents.at(-1)).toMatch(/```$/u);
    expect(contents.join('').replace(/[`\n]/gu, '')).toBe(
      text.replace(/[`\n]/gu, ''),
    );
    expect(
      fetchSpy.mock.calls.every(([, init]) => {
        const body = JSON.parse(String((init as RequestInit).body));
        return body.markdown.text.length <= 3800;
      }),
    ).toBe(true);
  });

  it('mentions only the first block-streamed response', async () => {
    const channel = createChannel({ atSender: true });
    seedWebhook(channel, 'cid123');
    seedMentionTarget(channel, 'm1', 'staff-1');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    getPromptHook(channel, 'onPromptStart')('cid123', 'session-1', 'm1');
    await getResponseHook(channel)('cid123', 'first block', 'session-1');
    await getResponseHook(channel)('cid123', 'second block', 'session-1');

    const bodies = fetchSpy.mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)),
    );
    expect(bodies[0]).toMatchObject({ at: { atUserIds: ['staff-1'] } });
    expect(bodies[0].msgtype).toBe('markdown');
    expect(bodies[1]).toMatchObject({ msgtype: 'markdown' });
    expect(bodies[1]).not.toHaveProperty('at');
  });

  it('keeps the mention available to the final reply after a mid-run fallback', async () => {
    const channel = createChannel({ atSender: true });
    seedWebhook(channel, 'cid123');
    seedMentionTarget(channel, 'm1', 'staff-1');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    getPromptHook(channel, 'onPromptStart')('cid123', 'session-1', 'm1');
    await (
      channel as unknown as {
        sendFallbackReply(
          chatId: string,
          text: string,
          sessionId: string,
        ): Promise<void>;
      }
    ).sendFallbackReply('cid123', 'intermediate result', 'session-1');
    await getResponseHook(channel)('cid123', 'final answer', 'session-1');

    const bodies = fetchSpy.mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)),
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      msgtype: 'markdown',
      markdown: { text: '@staff-1\n\nintermediate result' },
      at: { atUserIds: ['staff-1'] },
    });
    expect(bodies[1]).toMatchObject({
      msgtype: 'markdown',
      markdown: { text: '@staff-1\n\nfinal answer' },
      at: { atUserIds: ['staff-1'] },
    });
  });

  it('keeps the final answer mention after a mid-run card fallback', async () => {
    const channel = createChannel({ atSender: true });
    seedWebhook(channel, 'cid-1');
    seedMentionTarget(channel, 'message-1', 'staff-1');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const cardClient = (
      channel as unknown as {
        interactiveCardClient: {
          createAndDeliver: ReturnType<typeof vi.fn>;
          openOrUpdateStream: ReturnType<typeof vi.fn>;
          updateInstance: ReturnType<typeof vi.fn>;
        };
      }
    ).interactiveCardClient;
    cardClient.createAndDeliver = vi
      .fn()
      .mockRejectedValue(new Error('card unavailable'));
    cardClient.openOrUpdateStream = vi.fn().mockResolvedValue(undefined);
    cardClient.updateInstance = vi.fn().mockResolvedValue(undefined);

    getPromptHook(channel, 'onPromptStart')('cid-1', 'session-1', 'message-1');
    (
      channel as unknown as { inboundCardOwners: Map<string, unknown> }
    ).inboundCardOwners.set('message-1', {
      ownerId: 'staff-1',
      target: { chatId: 'cid-1', isGroup: true },
      sender: { senderName: 'Alice' },
    });
    getLifecycleHook(channel)({
      type: 'started',
      channelName: 'dingtalk',
      chatId: 'cid-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      runId: 'run-1',
      owner: { kind: 'channel_user', id: 'staff-1' },
    });

    const segmentContext = {
      channelName: 'dingtalk',
      sessionId: 'session-1',
      runId: 'run-1',
      segmentId: 'segment-1',
      owner: { kind: 'channel_user', id: 'staff-1' },
      target: {
        channelName: 'dingtalk',
        chatId: 'cid-1',
        senderId: 'staff-1',
        isGroup: true,
      },
    } as ChannelOutputSegmentContext;
    getChunkHook(channel)(
      'cid-1',
      'intermediate result',
      'session-1',
      segmentContext,
    );
    await getOutputSegmentEndHook(channel)(
      'cid-1',
      'session-1',
      segmentContext,
      'response_boundary',
    );
    await getResponseHook(channel)('cid-1', 'final answer', 'session-1');

    const bodies = fetchSpy.mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)),
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      msgtype: 'markdown',
      markdown: { text: '@staff-1\n\nintermediate result' },
      at: { atUserIds: ['staff-1'] },
    });
    expect(bodies[1]).toMatchObject({
      msgtype: 'markdown',
      markdown: { text: '@staff-1\n\nfinal answer' },
      at: { atUserIds: ['staff-1'] },
    });
  });
});

describe('DingtalkChannel mention target lifecycle', () => {
  it('does not retain a preflight-rejected group candidate', async () => {
    vi.doUnmock('@qwen-code/channel-base');
    vi.resetModules();
    const { DingtalkChannel: RealDingtalkChannel } = await import(
      './DingtalkAdapter.js'
    );
    const bridge = Object.assign(new EventEmitter(), {
      availableCommands: [],
      newSession: vi.fn().mockResolvedValue('session-1'),
      loadSession: vi.fn(),
      prompt: vi.fn().mockResolvedValue('agent response'),
      cancelSession: vi.fn().mockResolvedValue(undefined),
    }) as never;
    const createRealChannel = (groups: Record<string, unknown>) =>
      new RealDingtalkChannel(
        'real-dingtalk',
        {
          type: 'dingtalk',
          token: '',
          clientId: 'client-id',
          clientSecret: 'client-secret',
          senderPolicy: 'open',
          allowedUsers: [],
          sessionScope: 'user',
          cwd: '/tmp',
          groupPolicy: 'open',
          dmPolicy: 'open',
          atSender: true,
          groups,
        },
        bridge,
        {
          registerBridgeEvents: false,
          groupHistoryPath: join(
            mkdtempSync(join(tmpdir(), 'dingtalk-mention-lifecycle-')),
            'history.jsonl',
          ),
        },
      );
    const sendInbound = (
      channel: InstanceType<typeof RealDingtalkChannel>,
      msgId: string,
      text: string,
      isInAtList: boolean,
    ) => {
      (
        channel as unknown as {
          onMessage(downstream: DWClientDownStream): void;
        }
      ).onMessage({
        data: JSON.stringify({
          msgId,
          conversationType: '2',
          conversationId: 'cid-123',
          sessionWebhook:
            'https://oapi.dingtalk.com/robot/send?access_token=token',
          senderStaffId: 'staff-123',
          senderId: 'sender-123',
          senderNick: 'Alice',
          isInAtList,
          text: { content: text },
        }),
        headers: { messageId: msgId },
      } as unknown as DWClientDownStream);
    };
    const targetMap = (channel: InstanceType<typeof RealDingtalkChannel>) =>
      (channel as unknown as { mentionTargets: Map<string, string> })
        .mentionTargets;
    const rejected = createRealChannel({ '*': { requireMention: true } });
    sendInbound(rejected, 'rejected-1', 'not for the bot', false);

    await vi.waitFor(() => {
      expect(targetMap(rejected).has('rejected-1')).toBe(false);
    });
  });

  it('does not retain a local-command candidate', async () => {
    vi.doUnmock('@qwen-code/channel-base');
    vi.resetModules();
    const { DingtalkChannel: RealDingtalkChannel } = await import(
      './DingtalkAdapter.js'
    );
    const bridge = Object.assign(new EventEmitter(), {
      availableCommands: [],
      newSession: vi.fn().mockResolvedValue('session-1'),
      loadSession: vi.fn(),
      prompt: vi.fn().mockResolvedValue('agent response'),
      cancelSession: vi.fn().mockResolvedValue(undefined),
    }) as never;
    const channel = new RealDingtalkChannel(
      'real-dingtalk',
      {
        type: 'dingtalk',
        token: '',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        senderPolicy: 'open',
        allowedUsers: [],
        sessionScope: 'user',
        cwd: '/tmp',
        groupPolicy: 'open',
        dmPolicy: 'open',
        atSender: true,
        groups: { '*': { requireMention: false } },
      },
      bridge,
      { registerBridgeEvents: false },
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    (
      channel as unknown as {
        onMessage(downstream: DWClientDownStream): void;
      }
    ).onMessage({
      data: JSON.stringify({
        msgId: 'command-1',
        conversationType: '2',
        conversationId: 'cid-123',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/send?access_token=token',
        senderStaffId: 'staff-123',
        senderId: 'sender-123',
        senderNick: 'Alice',
        isInAtList: true,
        text: { content: '/help' },
      }),
      headers: { messageId: 'command-1' },
    } as unknown as DWClientDownStream);

    await vi.waitFor(() => {
      expect(
        (
          channel as unknown as { mentionTargets: Map<string, string> }
        ).mentionTargets.has('command-1'),
      ).toBe(false);
    });
    expect(bridge.prompt).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('clears the final buffered command target after synthetic collect re-entry', async () => {
    vi.doUnmock('@qwen-code/channel-base');
    vi.resetModules();
    const { DingtalkChannel: RealDingtalkChannel } = await import(
      './DingtalkAdapter.js'
    );
    const firstPrompt = deferredPromise<string>();
    const bridge = Object.assign(new EventEmitter(), {
      availableCommands: [],
      newSession: vi.fn().mockResolvedValue('session-1'),
      loadSession: vi.fn(),
      prompt: vi.fn().mockReturnValueOnce(firstPrompt.promise),
      cancelSession: vi.fn().mockResolvedValue(undefined),
    }) as never;
    const channel = new RealDingtalkChannel(
      'real-dingtalk',
      {
        type: 'dingtalk',
        token: '',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        senderPolicy: 'open',
        allowedUsers: [],
        sessionScope: 'user',
        cwd: '/tmp',
        groupPolicy: 'open',
        dmPolicy: 'open',
        dispatchMode: 'collect',
        atSender: true,
        groups: { '*': { requireMention: false } },
      },
      bridge,
      { registerBridgeEvents: false },
    );
    const finalCommand: Envelope = {
      chatId: 'cid-123',
      senderId: 'sender-123',
      senderName: 'Alice',
      messageId: 'command-1',
      text: '/help',
      isGroup: true,
      isMentioned: true,
    };
    const initial = channel.handleInbound({
      ...finalCommand,
      messageId: 'active-1',
      text: 'first request',
    });
    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledOnce());

    const internals = channel as unknown as {
      collectBuffers: Map<string, Array<{ text: string; envelope: Envelope }>>;
      mentionTargets: Map<string, string>;
      onPromptBuffered(
        chatId: string,
        sessionId: string,
        messageId?: string,
      ): void;
    };
    internals.mentionTargets.set('command-1', 'staff-123');
    internals.collectBuffers.set('session-1', [
      { text: '/help', envelope: finalCommand },
    ]);
    internals.onPromptBuffered('cid-123', 'session-1', 'command-1');

    firstPrompt.resolve('first response');
    await initial;

    await vi.waitFor(() => {
      expect(internals.mentionTargets.has('command-1')).toBe(false);
    });
    expect(bridge.prompt).toHaveBeenCalledOnce();
  });

  it('clears buffered mention targets for a dead session only', async () => {
    vi.doUnmock('@qwen-code/channel-base');
    vi.resetModules();
    const { DingtalkChannel: RealDingtalkChannel } = await import(
      './DingtalkAdapter.js'
    );
    const bridge = Object.assign(new EventEmitter(), {
      availableCommands: [],
      newSession: vi.fn(),
      loadSession: vi.fn(),
      prompt: vi.fn(),
      cancelSession: vi.fn(),
    }) as never;
    const channel = new RealDingtalkChannel(
      'real-dingtalk',
      {
        type: 'dingtalk',
        token: '',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        senderPolicy: 'open',
        allowedUsers: [],
        sessionScope: 'user',
        cwd: '/tmp',
        groupPolicy: 'open',
        dmPolicy: 'open',
        atSender: true,
        groups: {},
      },
      bridge,
      { registerBridgeEvents: false },
    );
    const internals = channel as unknown as {
      mentionTargets: Map<string, string>;
      sessionMentionTargets: Map<string, string>;
      bufferedMentionTargets: Set<string>;
      bufferedMentionTargetsBySession: Map<string, Set<string>>;
      onPromptBuffered(
        chatId: string,
        sessionId: string,
        messageId?: string,
      ): void;
    };
    internals.mentionTargets.set('buffered-1', 'staff-buffered');
    internals.mentionTargets.set('queued-1', 'staff-queued');
    internals.mentionTargets.set('other-1', 'staff-other');
    internals.onPromptBuffered('cid-123', 'session-1', 'buffered-1');
    internals.onPromptBuffered('cid-123', 'session-1', 'queued-1');
    internals.onPromptBuffered('cid-123', 'session-2', 'other-1');
    internals.sessionMentionTargets.set('session-1', 'staff-active');
    internals.sessionMentionTargets.set('session-2', 'staff-other-active');

    channel.onSessionDied('session-1');

    expect(internals.mentionTargets.has('buffered-1')).toBe(false);
    expect(internals.mentionTargets.has('queued-1')).toBe(false);
    expect(internals.bufferedMentionTargets.has('buffered-1')).toBe(false);
    expect(internals.bufferedMentionTargets.has('queued-1')).toBe(false);
    expect(internals.bufferedMentionTargetsBySession.has('session-1')).toBe(
      false,
    );
    expect(internals.sessionMentionTargets.has('session-1')).toBe(false);
    expect(internals.mentionTargets.get('other-1')).toBe('staff-other');
    expect(internals.bufferedMentionTargets.has('other-1')).toBe(true);
    expect(internals.bufferedMentionTargetsBySession.get('session-2')).toEqual(
      new Set(['other-1']),
    );
    expect(internals.sessionMentionTargets.get('session-2')).toBe(
      'staff-other-active',
    );
  });
});

describe('DingtalkChannel outbound image delivery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubImageReplyFetch(
    mediaHandler: (uploadCall: number) => Response = () =>
      new Response(
        JSON.stringify({ errcode: 0, media_id: '@lAL-test-media-id' }),
        { status: 200 },
      ),
  ) {
    let tokenCall = 0;
    let uploadCall = 0;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://oapi.dingtalk.com/gettoken')) {
          tokenCall++;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                errcode: 0,
                access_token: `proactive-token-${tokenCall}`,
                expires_in: 7200,
              }),
              { status: 200 },
            ),
          );
        }
        if (url.startsWith('https://oapi.dingtalk.com/media/upload')) {
          return Promise.resolve(mediaHandler(uploadCall++));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });
    const calls = (prefix: string) =>
      spy.mock.calls.filter((call) => String(call[0]).startsWith(prefix));
    return {
      uploadCalls: () => calls('https://oapi.dingtalk.com/media/upload'),
      tokenCalls: () => calls('https://oapi.dingtalk.com/gettoken'),
      webhookCalls: () =>
        calls('https://oapi.dingtalk.com/robot/send?access_token=token'),
    };
  }

  it('uploads a local image and embeds its MediaID in a reply', async () => {
    const image = createTempPng();
    try {
      const channel = createChannel({ cwd: image.dir });
      seedWebhook(channel, 'cid123');
      const { uploadCalls, tokenCalls, webhookCalls } = stubImageReplyFetch();

      await channel.sendMessage(
        'cid123',
        `before\n[IMAGE: ${image.path}]\nafter`,
      );

      expect(tokenCalls()).toHaveLength(1);
      expect(uploadCalls()).toHaveLength(1);
      const calls = webhookCalls();
      expect(calls).toHaveLength(1);
      const body = JSON.parse(String((calls[0]![1] as RequestInit).body)) as {
        msgtype: string;
        markdown: { text: string };
      };
      expect(body.msgtype).toBe('markdown');
      expect(body.markdown.text).toContain('before');
      expect(body.markdown.text).toContain('![image](@lAL-test-media-id)');
      expect(body.markdown.text).toContain('after');
      expect(body.markdown.text).not.toContain('[IMAGE:');
    } finally {
      rmSync(image.dir, { recursive: true, force: true });
    }
  });

  it('refreshes the token and retries one expired media upload', async () => {
    const image = createTempPng();
    try {
      const channel = createChannel({ cwd: image.dir });
      seedWebhook(channel, 'cid123');
      const { uploadCalls, tokenCalls } = stubImageReplyFetch((uploadCall) =>
        uploadCall === 0
          ? new Response(
              JSON.stringify({ errcode: 42001, errmsg: 'token expired' }),
              { status: 200 },
            )
          : new Response(
              JSON.stringify({
                errcode: 0,
                media_id: '@lAL-refreshed-media-id',
              }),
              { status: 200 },
            ),
      );

      await channel.sendMessage('cid123', `[IMAGE: ${image.path}]`);

      expect(uploadCalls()).toHaveLength(2);
      expect(tokenCalls()).toHaveLength(2);
    } finally {
      rmSync(image.dir, { recursive: true, force: true });
    }
  });

  it('sends a visible fallback without leaking the token when upload fails', async () => {
    const image = createTempPng();
    try {
      const channel = createChannel({ cwd: image.dir });
      seedWebhook(channel, 'cid123');
      const writeSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const { webhookCalls } = stubImageReplyFetch(
        () =>
          new Response(
            JSON.stringify({ errcode: 40035, errmsg: 'invalid media' }),
            { status: 200 },
          ),
      );

      await channel.sendMessage('cid123', `[IMAGE: ${image.path}]`);

      const body = JSON.parse(
        String((webhookCalls()[0]![1] as RequestInit).body),
      ) as { markdown: { text: string } };
      expect(body.markdown.text).toContain(
        '[Image delivery failed: image.png]',
      );
      const logged = writeSpy.mock.calls
        .map((call) => String(call[0]))
        .join('');
      expect(logged).toContain('outbound image upload failed');
      expect(logged).not.toContain('proactive-token-1');
    } finally {
      rmSync(image.dir, { recursive: true, force: true });
    }
  });

  it('sends a mentioned image response as one message', async () => {
    const image = createTempPng();
    try {
      const channel = createChannel({ atSender: true, cwd: image.dir });
      seedWebhook(channel, 'cid123');
      seedMentionTarget(channel, 'm1', 'staff-1');
      const { webhookCalls } = stubImageReplyFetch();

      getPromptHook(channel, 'onPromptStart')('cid123', 'session-1', 'm1');
      await getResponseHook(channel)(
        'cid123',
        `[IMAGE: ${image.path}]`,
        'session-1',
      );

      const calls = webhookCalls();
      expect(calls).toHaveLength(1);
      expect(
        JSON.parse(String((calls[0]![1] as RequestInit).body)),
      ).toMatchObject({
        msgtype: 'markdown',
        markdown: {
          text: expect.stringContaining('@staff-1\n\n'),
        },
        at: { atUserIds: ['staff-1'] },
      });
      expect(
        JSON.parse(String((calls[0]![1] as RequestInit).body)),
      ).toMatchObject({
        markdown: {
          text: expect.stringContaining('![image](@lAL-test-media-id)'),
        },
      });
    } finally {
      rmSync(image.dir, { recursive: true, force: true });
    }
  });
});

describe('DingtalkChannel proactive send', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const groupTarget: SessionTarget = {
    channelName: 'test-dingtalk',
    senderId: '443056',
    chatId: 'cidk4iA51FpTrRlziR0ilUYeg==',
    isGroup: true,
  };

  const directTarget: SessionTarget = {
    channelName: 'test-dingtalk',
    senderId: 'webhook:github-ci',
    chatId: 'manager-user-id',
    isGroup: false,
  };

  function proactive(channel: DingtalkChannelInstance) {
    return channel as unknown as {
      supportsProactiveTarget(target: SessionTarget): boolean;
      supportsProactiveDeliveryTarget(target: SessionTarget): boolean;
      supportsProactiveWebhookTarget(target: SessionTarget): boolean;
      pushProactive(target: SessionTarget, text: string): Promise<void>;
    };
  }

  function stubProactiveFetch(
    sendHandler: (sendCall: number) => Response = () =>
      new Response('{}', { status: 200 }),
    tokenHandler: () => Response = () =>
      new Response(
        JSON.stringify({
          errcode: 0,
          access_token: 'proactive-token',
          expires_in: 7200,
        }),
        { status: 200 },
      ),
    mediaHandler: (uploadCall: number) => Response = () =>
      new Response(
        JSON.stringify({ errcode: 0, media_id: '@lAL-proactive-media-id' }),
        { status: 200 },
      ),
  ) {
    let sendCall = 0;
    let uploadCall = 0;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://oapi.dingtalk.com/gettoken')) {
          return Promise.resolve(tokenHandler());
        }
        if (url.startsWith('https://oapi.dingtalk.com/media/upload')) {
          return Promise.resolve(mediaHandler(uploadCall++));
        }
        return Promise.resolve(sendHandler(sendCall++));
      });
    const calls = (prefix: string) =>
      spy.mock.calls.filter((c) => String(c[0]).startsWith(prefix));
    return {
      spy,
      sendCalls: () =>
        calls('https://api.dingtalk.com/v1.0/robot/groupMessages/send'),
      directSendCalls: () =>
        calls('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend'),
      mediaCalls: () => calls('https://oapi.dingtalk.com/media/upload'),
      tokenCalls: () => calls('https://oapi.dingtalk.com/gettoken'),
    };
  }

  function msgParamOf(call: unknown[]): { title: string; text: string } {
    const body = JSON.parse(String((call[1] as RequestInit).body));
    return JSON.parse(body.msgParam);
  }

  it('opts into proactive send', () => {
    expect(createChannel().supportsProactiveSend()).toBe(true);
  });

  it('accepts direct-message targets only for webhooks', () => {
    const channel = proactive(createChannel());
    expect(channel.supportsProactiveTarget(groupTarget)).toBe(true);
    expect(channel.supportsProactiveTarget(directTarget)).toBe(false);
    expect(channel.supportsProactiveWebhookTarget(groupTarget)).toBe(true);
    expect(channel.supportsProactiveWebhookTarget(directTarget)).toBe(true);
    expect(
      channel.supportsProactiveWebhookTarget({
        channelName: groupTarget.channelName,
        senderId: groupTarget.senderId,
        chatId: groupTarget.chatId,
      }),
    ).toBe(false);
    expect(
      channel.supportsProactiveWebhookTarget({
        ...groupTarget,
        chatId: 'https://oapi.dingtalk.com/robot/sendBySession?session=abc',
      }),
    ).toBe(false);
    expect(
      channel.supportsProactiveWebhookTarget({ ...groupTarget, chatId: '' }),
    ).toBe(false);
    expect(
      channel.supportsProactiveWebhookTarget({
        ...groupTarget,
        threadId: '7',
      }),
    ).toBe(false);
  });

  it('keeps loop targets group-only while direct delivery accepts users', () => {
    const channel = proactive(createChannel());

    expect(channel.supportsProactiveTarget(groupTarget)).toBe(true);
    expect(channel.supportsProactiveTarget(directTarget)).toBe(false);
    expect(channel.supportsProactiveDeliveryTarget(groupTarget)).toBe(true);
    expect(channel.supportsProactiveDeliveryTarget(directTarget)).toBe(true);
  });

  it('sends proactive group messages through the robot API', async () => {
    const channel = proactive(createChannel());
    const { sendCalls, tokenCalls } = stubProactiveFetch();

    await channel.pushProactive(groupTarget, '# Result\nloop output');

    expect(tokenCalls()).toHaveLength(1);
    const sends = sendCalls();
    expect(sends).toHaveLength(1);
    const init = sends[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(
      (init.headers as Record<string, string>)['x-acs-dingtalk-access-token'],
    ).toBe('proactive-token');
    const body = JSON.parse(String(init.body));
    expect(body.robotCode).toBe('client-id');
    expect(body.openConversationId).toBe(groupTarget.chatId);
    expect(body.userIds).toBeUndefined();
    expect(body.msgKey).toBe('sampleMarkdown');
    expect(msgParamOf(sends[0]!).title).toBe('Result');
    expect(msgParamOf(sends[0]!).text).toContain('loop output');
  });

  it('sends proactive direct messages through the one-to-one robot API', async () => {
    const channel = proactive(createChannel());
    const { directSendCalls, tokenCalls } = stubProactiveFetch();

    await channel.pushProactive(directTarget, '# Result\nloop output');

    expect(tokenCalls()).toHaveLength(1);
    const sends = directSendCalls();
    expect(sends).toHaveLength(1);
    const init = sends[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(
      (init.headers as Record<string, string>)['x-acs-dingtalk-access-token'],
    ).toBe('proactive-token');
    const body = JSON.parse(String(init.body));
    expect(body.robotCode).toBe('client-id');
    expect(body.userIds).toEqual([directTarget.chatId]);
    expect(body.openConversationId).toBeUndefined();
    expect(body.msgKey).toBe('sampleMarkdown');
    expect(msgParamOf(sends[0]!).title).toBe('Result');
    expect(msgParamOf(sends[0]!).text).toContain('loop output');
  });

  it('uploads and embeds images in proactive group messages', async () => {
    const image = createTempPng();
    try {
      const channel = proactive(createChannel({ cwd: image.dir }));
      const { mediaCalls, sendCalls } = stubProactiveFetch();

      await channel.pushProactive(groupTarget, `[IMAGE: ${image.path}]`);

      expect(mediaCalls()).toHaveLength(1);
      expect(msgParamOf(sendCalls()[0]!).text).toContain(
        '![image](@lAL-proactive-media-id)',
      );
    } finally {
      rmSync(image.dir, { recursive: true, force: true });
    }
  });

  it('uploads and embeds images in proactive direct messages', async () => {
    const image = createTempPng();
    try {
      const channel = proactive(createChannel({ cwd: image.dir }));
      const { directSendCalls, mediaCalls } = stubProactiveFetch();

      await channel.pushProactive(directTarget, `[IMAGE: ${image.path}]`);

      expect(mediaCalls()).toHaveLength(1);
      expect(msgParamOf(directSendCalls()[0]!).text).toContain(
        '![image](@lAL-proactive-media-id)',
      );
    } finally {
      rmSync(image.dir, { recursive: true, force: true });
    }
  });

  it('rejects direct messages when DingTalk reports an invalid recipient', async () => {
    const channel = proactive(createChannel());
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stubProactiveFetch(
      () =>
        new Response(
          JSON.stringify({ invalidStaffIdList: [directTarget.chatId] }),
          { status: 200 },
        ),
    );

    await expect(channel.pushProactive(directTarget, 'hello')).rejects.toThrow(
      'DingTalk proactive send failed: invalid direct recipient',
    );
  });

  it('rejects direct messages when DingTalk reports a rate-limited recipient', async () => {
    const channel = proactive(createChannel());
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stubProactiveFetch(
      () =>
        new Response(
          JSON.stringify({
            flowControlledStaffIdList: [directTarget.chatId],
          }),
          { status: 200 },
        ),
    );

    await expect(channel.pushProactive(directTarget, 'hello')).rejects.toThrow(
      'DingTalk proactive send failed: direct recipient rate limited',
    );
  });

  it('rejects direct messages when DingTalk returns malformed JSON', async () => {
    const channel = proactive(createChannel());
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const response = new Response('<html>bad gateway</html>', { status: 200 });
    stubProactiveFetch(() => response);

    await expect(channel.pushProactive(directTarget, 'hello')).rejects.toThrow(
      'DingTalk proactive send failed: invalid JSON response',
    );

    expect(response.bodyUsed).toBe(true);
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain(
      'proactive send failed (dm, chunk 1/1): invalid JSON response',
    );
  });

  it('accepts direct messages when DingTalk rejects only other recipients', async () => {
    const channel = proactive(createChannel());
    const { directSendCalls } = stubProactiveFetch(
      () =>
        new Response(
          JSON.stringify({
            invalidStaffIdList: ['other-user'],
            flowControlledStaffIdList: ['another-user'],
          }),
          { status: 200 },
        ),
    );

    await expect(
      channel.pushProactive(directTarget, 'hello'),
    ).resolves.toBeUndefined();
    expect(directSendCalls()).toHaveLength(1);
  });

  it('reuses the cached token across group and direct-message sends', async () => {
    const channel = proactive(createChannel());
    const { tokenCalls } = stubProactiveFetch();

    await channel.pushProactive(groupTarget, 'first');
    await channel.pushProactive(directTarget, 'second');

    expect(tokenCalls()).toHaveLength(1);
  });

  it('splits long proactive messages into continuation chunks', async () => {
    const channel = proactive(createChannel());
    const { sendCalls } = stubProactiveFetch();

    const longLine = 'x'.repeat(100);
    const longText = Array.from({ length: 50 }, () => longLine).join('\n');
    await channel.pushProactive(groupTarget, longText);

    const sends = sendCalls();
    expect(sends).toHaveLength(2);
    expect(msgParamOf(sends[0]!).title).not.toContain('(cont.)');
    expect(msgParamOf(sends[1]!).title).toContain('(cont.)');
  });

  it('stops at the first failed chunk', async () => {
    const channel = proactive(createChannel());
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { directSendCalls } = stubProactiveFetch(
      () => new Response('denied', { status: 403 }),
    );

    const longLine = 'x'.repeat(100);
    const longText = Array.from({ length: 50 }, () => longLine).join('\n');
    await expect(channel.pushProactive(directTarget, longText)).rejects.toThrow(
      'HTTP 403',
    );

    expect(directSendCalls()).toHaveLength(1);
  });

  it('surfaces API detail in the error and log on failure', async () => {
    const channel = proactive(createChannel());
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    stubProactiveFetch(() => new Response('perm denied', { status: 403 }));

    await expect(channel.pushProactive(groupTarget, 'hello')).rejects.toThrow(
      'DingTalk proactive send failed: HTTP 403 perm denied',
    );

    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain(
      'proactive send failed (group, chunk 1/1): HTTP 403 perm denied',
    );
  });

  it('includes the direct target kind in network-error logs', async () => {
    const channel = proactive(createChannel());
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    stubProactiveFetch(() => {
      throw new Error('connection reset');
    });

    await expect(channel.pushProactive(directTarget, 'hello')).rejects.toThrow(
      'DingTalk proactive send failed: connection reset',
    );

    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain(
      'proactive send error (dm, chunk 1/1): Error: connection reset',
    );
  });

  it('refreshes the token and retries a direct message once on 401', async () => {
    const channel = proactive(createChannel());
    const { directSendCalls, tokenCalls } = stubProactiveFetch((sendCall) =>
      sendCall === 0
        ? new Response('expired', { status: 401 })
        : new Response('{}', { status: 200 }),
    );

    await channel.pushProactive(directTarget, 'hello');

    expect(directSendCalls()).toHaveLength(2);
    expect(tokenCalls()).toHaveLength(2);
  });

  it('refreshes the token and retries a group message once on 401', async () => {
    const channel = proactive(createChannel());
    const { sendCalls, tokenCalls } = stubProactiveFetch((sendCall) =>
      sendCall === 0
        ? new Response('expired', { status: 401 })
        : new Response('{}', { status: 200 }),
    );

    await channel.pushProactive(groupTarget, 'hello');

    expect(sendCalls()).toHaveLength(2);
    expect(tokenCalls()).toHaveLength(2);
  });

  it('throws when the token endpoint rejects', async () => {
    const channel = proactive(createChannel());
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stubProactiveFetch(
      undefined,
      () =>
        new Response(
          JSON.stringify({ errcode: 40089, errmsg: 'invalid credential' }),
          { status: 200 },
        ),
    );

    await expect(channel.pushProactive(groupTarget, 'hello')).rejects.toThrow(
      'gettoken errcode=40089',
    );
  });

  it('skips blank text without calling the API', async () => {
    const channel = proactive(createChannel());
    const { spy } = stubProactiveFetch();

    await channel.pushProactive(groupTarget, '   \n ');

    expect(spy).not.toHaveBeenCalled();
  });
});
