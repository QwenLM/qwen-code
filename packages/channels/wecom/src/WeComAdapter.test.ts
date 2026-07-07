import {
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ChannelAgentBridge,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';

const mocks = vi.hoisted(() => {
  type MockHttpResponse = {
    statusCode: number;
    headers: Record<string, string>;
    on(
      event: string,
      handler: (value?: Buffer | Error) => void,
    ): MockHttpResponse;
    resume: ReturnType<typeof vi.fn>;
  };
  type MockHttpRequest = {
    on: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    setTimeout: ReturnType<typeof vi.fn>;
  };
  type MockHttpCall = {
    options: unknown;
    request: MockHttpRequest;
    response: MockHttpResponse;
  };
  type MockFileHandle = {
    stat: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };

  const instances: MockWSClient[] = [];
  const httpCalls: MockHttpCall[] = [];
  const openHandles: MockFileHandle[] = [];
  const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
  const decryptFile = vi.fn((buffer: Buffer, _aesKey: string) => buffer);
  const open = vi.fn(async (_path: string, _flags: string | number) => {
    const handle: MockFileHandle = {
      stat: vi.fn(async () => ({ isFile: () => true, size: 4 })),
      readFile: vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      close: vi.fn(async () => {}),
    };
    openHandles.push(handle);
    return handle;
  });
  const readFile = vi.fn(async (_path: string) =>
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );
  const writeFile = vi.fn(
    async (_path: string, _data: Buffer, _options: unknown) => {},
  );
  const httpResponse = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: Buffer.from('downloaded'),
  };
  const httpsRequest = vi.fn(
    (
      _url: string,
      _options: unknown,
      callback: (response: MockHttpResponse) => void,
    ) => {
      const handlers = new Map<
        string,
        Array<(value?: Buffer | Error) => void>
      >();
      const response: MockHttpResponse = {
        statusCode: httpResponse.statusCode,
        headers: httpResponse.headers,
        on(event, handler) {
          const eventHandlers = handlers.get(event) ?? [];
          eventHandlers.push(handler);
          handlers.set(event, eventHandlers);
          return response;
        },
        resume: vi.fn(),
      };
      const emit = (event: string, value?: Buffer | Error): void => {
        for (const handler of handlers.get(event) ?? []) {
          handler(value);
        }
      };
      const request: MockHttpRequest = {
        on: vi.fn(() => request),
        end: vi.fn(() => {
          queueMicrotask(() => {
            callback(response);
            queueMicrotask(() => {
              emit('data', httpResponse.body);
              if (state.mediaResponseNeverEnds) return;
              emit('end');
            });
          });
          return request;
        }),
        destroy: vi.fn(() => request),
        setTimeout: vi.fn(() => request),
      };
      httpCalls.push({ options: _options, request, response });
      return request;
    },
  );
  const state = {
    autoAuthenticate: true,
    connectErrorsRemaining: 0,
    connectNeverSettles: false,
    connectResolvers: [] as Array<() => void>,
    connectWaitsForRelease: false,
    kickAfterConnectsRemaining: 0,
    mediaResponseNeverEnds: false,
  };

  class MockWSClient {
    readonly options: Record<string, unknown>;
    readonly handlers = new Map<string, Array<(payload: unknown) => void>>();
    connect = vi.fn(() => {
      if (state.connectErrorsRemaining > 0) {
        state.connectErrorsRemaining -= 1;
        return Promise.reject(new Error('connect failed'));
      }
      if (state.connectNeverSettles) {
        return new Promise(() => {});
      }
      if (state.connectWaitsForRelease) {
        if (state.autoAuthenticate) {
          queueMicrotask(() => this.emit('authenticated', {}));
        }
        return new Promise<MockWSClient>((resolve) => {
          state.connectResolvers.push(() => resolve(this));
        });
      }
      if (state.autoAuthenticate) {
        queueMicrotask(() => this.emit('authenticated', {}));
      }
      if (state.kickAfterConnectsRemaining > 0) {
        state.kickAfterConnectsRemaining -= 1;
        queueMicrotask(() =>
          this.emit('event.disconnected_event', 'kicked again'),
        );
      }
      return this;
    });
    disconnect = vi.fn();
    sendMessage = vi.fn(async (_chatId: string, _message: unknown) => ({
      headers: { req_id: 'req-1' },
    }));
    uploadMedia = vi.fn(
      async (_data: Buffer, _options: { type: string; filename: string }) => ({
        media_id: 'media-1',
      }),
    );
    sendMediaMessage = vi.fn(
      async (_chatId: string, _mediaType: string, _mediaId: string) => ({
        headers: { req_id: 'media-req-1' },
      }),
    );
    downloadFile = vi.fn(async (_url: string, _aesKey?: string) => ({
      buffer: Buffer.from('downloaded'),
    }));

    constructor(options: Record<string, unknown>) {
      this.options = options;
      instances.push(this);
    }

    on(event: string, handler: (payload: unknown) => void): void {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    }

    off(event: string, handler: (payload: unknown) => void): void {
      const handlers = this.handlers.get(event) ?? [];
      this.handlers.set(
        event,
        handlers.filter((candidate) => candidate !== handler),
      );
    }

    emit(event: string, payload: unknown): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(payload);
      }
    }
  }

  return {
    MockWSClient,
    instances,
    httpCalls,
    openHandles,
    lookup,
    decryptFile,
    open,
    readFile,
    writeFile,
    httpResponse,
    httpsRequest,
    state,
  };
});

vi.mock('@wecom/aibot-node-sdk', () => ({
  WSClient: mocks.MockWSClient,
  decryptFile: mocks.decryptFile,
}));
vi.mock('node:dns/promises', () => ({
  lookup: mocks.lookup,
}));
vi.mock('node:https', () => ({
  request: mocks.httpsRequest,
}));
vi.mock('node:fs/promises', () => ({
  open: mocks.open,
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
}));

import { WeComChannel } from './WeComAdapter.js';
import { plugin } from './index.js';

type MockWSClient = InstanceType<typeof mocks.MockWSClient>;

function makeConfig(
  overrides: Partial<ChannelConfig & Record<string, unknown>> = {},
): ChannelConfig & Record<string, unknown> {
  return {
    type: 'wecom',
    token: '',
    senderPolicy: 'open',
    allowedUsers: [],
    sessionScope: 'user',
    cwd: process.cwd(),
    groupPolicy: 'disabled',
    groups: {},
    botId: 'bot-id',
    secret: 'bot-secret',
    ...overrides,
  };
}

function makeBridge(): ChannelAgentBridge {
  return {
    availableCommands: [],
    on: vi.fn(),
    off: vi.fn(),
    newSession: vi.fn(async () => 'session-1'),
    loadSession: vi.fn(async (id: string) => id),
    prompt: vi.fn(async () => ''),
    cancelSession: vi.fn(async () => {}),
  } as unknown as ChannelAgentBridge;
}

class TestWeComChannel extends WeComChannel {
  readonly envelopes: Envelope[] = [];

  protected override async processInbound(envelope: Envelope): Promise<void> {
    this.envelopes.push(envelope);
  }
}

class PromptEndWeComChannel extends WeComChannel {
  finishPrompt(chatId: string, sessionId: string, messageId?: string): void {
    this.onPromptEnd(chatId, sessionId, messageId);
  }
}

class FailingPreflightWeComChannel extends WeComChannel {
  readonly preflights = vi.fn(async (_envelope: Envelope) => {
    throw new Error('preflight failed');
  });

  protected override async preflightInbound(
    envelope: Envelope,
  ): Promise<boolean> {
    return this.preflights(envelope);
  }
}

class RejectingPreflightWeComChannel extends WeComChannel {
  readonly preflights = vi.fn(async (_envelope: Envelope) => false);

  protected override async preflightInbound(
    envelope: Envelope,
  ): Promise<boolean> {
    return this.preflights(envelope);
  }
}

class BlockingPreflightWeComChannel extends TestWeComChannel {
  readonly preflights = vi.fn();
  private readonly preflightResolvers: Array<() => void> = [];

  releasePreflights(): void {
    this.preflightResolvers.splice(0).forEach((resolve) => resolve());
  }

  protected override async preflightInbound(
    envelope: Envelope,
  ): Promise<boolean> {
    this.preflights(envelope);
    await new Promise<void>((resolve) => {
      this.preflightResolvers.push(resolve);
    });
    return super.preflightInbound(envelope);
  }
}

class FailingProcessWeComChannel extends WeComChannel {
  readonly processes = vi.fn(async (_envelope: Envelope) => {
    throw new Error('process failed after side effects started');
  });

  protected override async processInbound(envelope: Envelope): Promise<void> {
    return this.processes(envelope);
  }
}

class BlockingAliceProcessWeComChannel extends WeComChannel {
  private releaseAliceProcess?: () => void;
  readonly aliceBlocked = new Promise<void>((resolve) => {
    this.releaseAliceProcess = resolve;
  });

  releaseAlice(): void {
    this.releaseAliceProcess?.();
  }

  protected override async processInbound(envelope: Envelope): Promise<void> {
    if (envelope.senderId === 'alice') {
      await this.aliceBlocked;
    }
    await super.processInbound(envelope);
  }
}

function lastClient(): MockWSClient {
  const client = mocks.instances.at(-1);
  if (!client) throw new Error('missing mock client');
  return client;
}

function channelFileDirs(): string[] {
  const parent = join(tmpdir(), 'channel-files');
  if (!existsSync(parent)) return [];
  return readdirSync(parent).map((entry) => join(parent, entry));
}

describe('WeComChannel', () => {
  beforeEach(() => {
    mocks.instances.length = 0;
    mocks.httpCalls.length = 0;
    mocks.openHandles.length = 0;
    mocks.state.autoAuthenticate = true;
    mocks.state.connectErrorsRemaining = 0;
    mocks.state.connectNeverSettles = false;
    mocks.state.connectResolvers.length = 0;
    mocks.state.connectWaitsForRelease = false;
    mocks.state.kickAfterConnectsRemaining = 0;
    mocks.state.mediaResponseNeverEnds = false;
    mocks.httpResponse.statusCode = 200;
    mocks.httpResponse.headers = {};
    mocks.httpResponse.body = Buffer.from('downloaded');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok')),
    );
    vi.clearAllMocks();
    mocks.decryptFile.mockImplementation((buffer: Buffer) => buffer);
    mocks.readFile.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    mocks.writeFile.mockImplementation(
      async (path: string, data: Buffer, _options: unknown) => {
        writeFileSync(path, data);
      },
    );
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    rmSync(join(tmpdir(), 'channel-files'), { recursive: true, force: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rmSync(join(tmpdir(), 'channel-files'), { recursive: true, force: true });
  });

  it('requires botId and secret', () => {
    expect(
      () => new WeComChannel('bot', makeConfig({ botId: '' }), makeBridge()),
    ).toThrow('requires botId and secret');
    expect(
      () => new WeComChannel('bot', makeConfig({ secret: '' }), makeBridge()),
    ).toThrow('requires botId and secret');
    expect(
      () =>
        new WeComChannel(
          'bot',
          makeConfig({ wsUrl: 'ws://example.invalid/ws' }),
          makeBridge(),
        ),
    ).toThrow('requires wsUrl to use wss://');
  });

  it('supports proactive sends', () => {
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());

    expect(channel.supportsProactiveSend()).toBe(true);
  });

  it('connects the official SDK with bot credentials', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new WeComChannel(
      'bot',
      makeConfig({ wsUrl: 'wss://example.invalid/ws' }),
      makeBridge(),
    );

    await channel.connect();

    const client = lastClient();
    expect(client.options).toMatchObject({
      botId: 'bot-id',
      secret: 'bot-secret',
      wsUrl: 'wss://example.invalid/ws',
    });
    expect(client.connect).toHaveBeenCalledTimes(1);
    const logger = client.options['logger'] as {
      debug(message: string): void;
      warn(message: string, ...args: unknown[]): void;
      error(message: string, ...args: unknown[]): void;
    };
    expect(logger).toBeDefined();

    logger.debug('body={"text":"secret","aeskey":"key"}');
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('secret'));

    logger.warn('No aesKey provided:', 'https://example.invalid/file');
    expect(stderr).toHaveBeenCalledWith(
      '[WeCom:bot] SDK warn: No aesKey provided:\n',
    );
    expect(stderr).not.toHaveBeenCalledWith(
      expect.stringContaining('https://example.invalid/file'),
    );

    client.emit('error', {
      config: {
        headers: { authorization: 'Bearer nested-token' },
        data: { secret: 'nested-secret' },
      },
      response: { status: 401 },
    });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[REDACTED]'));
    expect(stderr).not.toHaveBeenCalledWith(
      expect.stringContaining('nested-token'),
    );
    expect(stderr).not.toHaveBeenCalledWith(
      expect.stringContaining('nested-secret'),
    );
    stderr.mockRestore();
  });

  it('waits for SDK authentication before reporting connected', async () => {
    mocks.state.autoAuthenticate = false;
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());

    const connecting = channel.connect();
    const client = lastClient();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stderr).not.toHaveBeenCalledWith(
      '[WeCom:bot] Connected via smart bot.\n',
    );

    client.emit('authenticated', {});
    await connecting;

    expect(stderr).toHaveBeenCalledWith(
      '[WeCom:bot] Connected via smart bot.\n',
    );
    stderr.mockRestore();
  });

  it('removes temporary authentication listeners after connect settles', async () => {
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());

    await channel.connect();

    const client = lastClient();
    expect(client.handlers.get('authenticated')).toHaveLength(0);
    expect(client.handlers.get('error')).toHaveLength(1);
  });

  it('keeps waiting when the SDK disconnects before authentication', async () => {
    mocks.state.autoAuthenticate = false;
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());

    const connecting = channel.connect();
    const client = lastClient();
    client.emit('disconnected', 'auth failed');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      '[WeCom:bot] WebSocket auth failed; waiting for SDK reconnect.\n',
    );

    client.emit('authenticated', {});
    await connecting;

    expect(stderr).toHaveBeenCalledWith(
      '[WeCom:bot] Connected via smart bot.\n',
    );
    stderr.mockRestore();
  });

  it('drops messages received before authentication completes', async () => {
    mocks.state.autoAuthenticate = false;
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());

    const connecting = channel.connect();
    const client = lastClient();
    client.emit('message.text', {
      msgid: 'msg-before-auth',
      msgtype: 'text',
      chattype: 'single',
      from: { userid: 'alice' },
      text: { content: 'hello' },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(channel.envelopes).toHaveLength(0);
    expect(stderr).toHaveBeenCalledWith(
      '[WeCom:bot] dropping message before authentication.\n',
    );

    client.emit('authenticated', {});
    await connecting;
    stderr.mockRestore();
  });

  it('keeps the active SDK client when the websocket disconnects', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('disconnected', 'closed');
    await channel.sendMessage('chat-1', 'hello');

    expect(stderr).toHaveBeenCalledWith(
      '[WeCom:bot] WebSocket closed; waiting for SDK reconnect.\n',
    );
    expect(client.sendMessage).toHaveBeenCalledWith('chat-1', {
      msgtype: 'markdown',
      markdown: { content: 'hello' },
    });
    stderr.mockRestore();
  });

  it('preserves structured websocket disconnect reasons in logs', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('disconnected', {
      code: 1006,
      reason: 'abnormal closure',
      wasClean: false,
    });

    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        'code=1006 reason=abnormal closure wasClean=false',
      ),
    );
    stderr.mockRestore();
  });

  it('reconnects when WeCom kicks the connection for a newer client', async () => {
    vi.useFakeTimers();
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const oldClient = lastClient();

    oldClient.emit('event.disconnected_event', {
      errcode: 45009,
      errmsg: 'another client connected',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(2));
    expect(oldClient.disconnect).toHaveBeenCalled();
    expect(lastClient().connect).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(
      '[WeCom:bot] WebSocket errcode=45009 errmsg=another client connected; reconnecting after server kick.\n',
    );
    channel.disconnect();
    stderr.mockRestore();
  });

  it('keeps retrying later after kick reconnect attempts are exhausted', async () => {
    vi.useFakeTimers();
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const oldClient = lastClient();
    mocks.state.connectErrorsRemaining = 3;

    oldClient.emit('event.disconnected_event', 'kicked');

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(4));
    expect(stderr).toHaveBeenCalledWith(
      '[WeCom:bot] reconnect after server kick gave up after 3 attempts; retrying later.\n',
    );

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(5));
    expect(lastClient().connect).toHaveBeenCalledTimes(1);

    channel.disconnect();
    stderr.mockRestore();
  });

  it('does not keep the delayed kick reconnect retry alive', () => {
    const unref = vi.fn();
    const timeout = { unref } as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockReturnValue(timeout);
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    const inspectable = channel as unknown as {
      kickReconnectRetry?: ReturnType<typeof setTimeout>;
      scheduleKickReconnectRetry(
        reason: unknown,
        disconnectGeneration: number,
      ): void;
    };

    inspectable.scheduleKickReconnectRetry('kicked', 0);

    expect(inspectable.kickReconnectRetry).toBe(timeout);
    expect(unref).toHaveBeenCalledTimes(1);
    setTimeoutSpy.mockRestore();
  });

  it('resets exhausted kick attempts when a fresh kick cancels a delayed retry', async () => {
    vi.useFakeTimers();
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const retry = setTimeout(() => {}, 60_000);
    const inspectable = channel as unknown as {
      kickReconnectAttempts: number;
      kickReconnectRetry?: ReturnType<typeof setTimeout>;
    };
    inspectable.kickReconnectAttempts = 3;
    inspectable.kickReconnectRetry = retry;

    lastClient().emit('event.disconnected_event', 'kicked');

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(2));
    expect(inspectable.kickReconnectAttempts).toBe(0);

    channel.disconnect();
  });

  it('schedules a long retry when kick reconnect fails unexpectedly', async () => {
    vi.useFakeTimers();
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    const inspectable = channel as unknown as {
      reconnectAfterKick(
        reason: unknown,
        reconnectReason?: string,
      ): Promise<void>;
      startKickReconnect(reason: unknown, reconnectReason?: string): void;
      kickReconnectRetry?: ReturnType<typeof setTimeout>;
    };
    inspectable.reconnectAfterKick = vi.fn(async () => {
      throw new Error('state corrupt');
    });

    inspectable.startKickReconnect('kicked', 'server kick');

    await vi.waitFor(() =>
      expect(inspectable.kickReconnectRetry).toBeDefined(),
    );
    expect(stderr).toHaveBeenCalledWith(
      '[WeCom:bot] kick-reconnect failed: state corrupt\n',
    );

    stderr.mockRestore();
  });

  it('does not keep the SDK disconnect fallback reconnect alive', () => {
    const unref = vi.fn();
    const timeout = { unref } as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockReturnValue(timeout);
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    const client = {};
    const inspectable = channel as unknown as {
      disconnectReconnectFallback?: ReturnType<typeof setTimeout>;
      scheduleDisconnectReconnectFallback(
        reason: unknown,
        client: unknown,
        disconnectGeneration: number,
      ): void;
    };

    inspectable.scheduleDisconnectReconnectFallback('closed', client, 0);

    expect(inspectable.disconnectReconnectFallback).toBe(timeout);
    expect(unref).toHaveBeenCalledTimes(1);
    setTimeoutSpy.mockRestore();
  });

  it('falls back to adapter reconnect when SDK disconnect stalls', async () => {
    vi.useFakeTimers();
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const oldClient = lastClient();

    oldClient.emit('disconnected', 'closed');

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(2));
    expect(oldClient.disconnect).toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      '[WeCom:bot] SDK reconnect did not recover after WebSocket closed; reconnecting adapter.\n',
    );

    channel.disconnect();
    stderr.mockRestore();
  });

  it('keeps kick reconnect alive when SDK disconnect throws', async () => {
    vi.useFakeTimers();
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const oldClient = lastClient();
    oldClient.disconnect.mockImplementationOnce(() => {
      throw new Error('socket already closed');
    });

    oldClient.emit('event.disconnected_event', 'kicked');

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(2));
    expect(stderr).toHaveBeenCalledWith(
      '[WeCom:bot] client.disconnect() threw: socket already closed\n',
    );

    channel.disconnect();
    stderr.mockRestore();
  });

  it('does not reconnect when disconnect emits a kick event', async () => {
    vi.useFakeTimers();
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const oldClient = lastClient();
    oldClient.off = undefined as unknown as MockWSClient['off'];
    oldClient.disconnect.mockImplementationOnce(() => {
      oldClient.emit('event.disconnected_event', 'kicked');
    });

    channel.disconnect();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mocks.instances).toHaveLength(1);
  });

  it('does not reconnect when disconnect emits a disconnected event', async () => {
    vi.useFakeTimers();
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const oldClient = lastClient();
    oldClient.off = undefined as unknown as MockWSClient['off'];
    oldClient.disconnect.mockImplementationOnce(() => {
      oldClient.emit('disconnected', 'closed');
    });

    channel.disconnect();
    await vi.advanceTimersByTimeAsync(31_000);

    expect(mocks.instances).toHaveLength(1);
  });

  it('resets exhausted kick retry cycles before SDK-disconnect fallback reconnect', async () => {
    vi.useFakeTimers();
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const inspectable = channel as unknown as {
      kickReconnectRetryCycles: number;
    };
    inspectable.kickReconnectRetryCycles = 3;

    lastClient().emit('disconnected', 'closed');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(inspectable.kickReconnectRetryCycles).toBe(0);

    channel.disconnect();
  });

  it('continues kick reconnect after repeated retry cycles are exhausted', async () => {
    vi.useFakeTimers();
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const inspectable = channel as unknown as {
      kickReconnectRetryCycles: number;
    };
    const oldClient = lastClient();
    mocks.state.connectErrorsRemaining = 9;

    oldClient.emit('event.disconnected_event', 'kicked');

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);
      await vi.waitFor(() =>
        expect(mocks.instances).toHaveLength(4 + cycle * 3),
      );
      if (cycle < 2) {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      }
    }

    expect(stderr).toHaveBeenCalledWith(
      '[WeCom:bot] reconnect after server kick exhausted 3 retry cycles; next attempt in 15 minutes.\n',
    );
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(11));
    expect(inspectable.kickReconnectRetryCycles).toBe(0);

    channel.disconnect();
    stderr.mockRestore();
  });

  it('resets the kick reconnect attempt budget after a successful reconnect', async () => {
    vi.useFakeTimers();
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();

    for (let kick = 0; kick < 4; kick += 1) {
      lastClient().emit('event.disconnected_event', 'kicked');
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(mocks.instances).toHaveLength(kick + 2));
      await vi.waitFor(() =>
        expect(
          (
            channel as unknown as {
              reconnectingAfterKick: boolean;
            }
          ).reconnectingAfterKick,
        ).toBe(false),
      );
    }

    channel.disconnect();
  });

  it('retries failed kick reconnect attempts with exponential backoff', async () => {
    vi.useFakeTimers();
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    mocks.state.connectErrorsRemaining = 2;

    lastClient().emit('event.disconnected_event', 'kicked');

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(4));
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('reconnect after server kick attempt 1 failed'),
    );
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('reconnect after server kick attempt 2 failed'),
    );
    expect(lastClient().connect).toHaveBeenCalledTimes(1);

    channel.disconnect();
    stderr.mockRestore();
  });

  it('stops kick reconnect when the channel disconnects mid-retry', async () => {
    vi.useFakeTimers();
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();

    lastClient().emit('event.disconnected_event', 'kicked');
    channel.disconnect();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.instances).toHaveLength(1);
  });

  it('clears pending kick reconnect state on disconnect', async () => {
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    (
      channel as unknown as {
        pendingKickReconnect: boolean;
      }
    ).pendingKickReconnect = true;

    channel.disconnect();

    expect(
      (
        channel as unknown as {
          pendingKickReconnect: boolean;
        }
      ).pendingKickReconnect,
    ).toBe(false);
  });

  it('does not replay a pending kick after a successful reconnect', async () => {
    vi.useFakeTimers();
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();

    lastClient().emit('event.disconnected_event', 'kicked');
    (
      channel as unknown as {
        pendingKickReconnect: boolean;
      }
    ).pendingKickReconnect = true;

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(2));
    await vi.waitFor(() =>
      expect(
        (
          channel as unknown as {
            reconnectingAfterKick: boolean;
          }
        ).reconnectingAfterKick,
      ).toBe(false),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.instances).toHaveLength(2);
    expect(
      (
        channel as unknown as {
          pendingKickReconnect: boolean;
        }
      ).pendingKickReconnect,
    ).toBe(false);

    channel.disconnect();
  });

  it('does not schedule reconnect reset after disconnect races with connect success', async () => {
    vi.useFakeTimers();
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    mocks.state.connectWaitsForRelease = true;

    lastClient().emit('event.disconnected_event', 'kicked');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.instances).toHaveLength(2);

    channel.disconnect();
    mocks.state.connectResolvers.splice(0).forEach((resolve) => resolve());
    await vi.runAllTicks();

    expect(
      (
        channel as unknown as {
          kickReconnectReset?: ReturnType<typeof setTimeout>;
        }
      ).kickReconnectReset,
    ).toBeUndefined();
  });

  it('does not tear down a recovered client for a pending kick', async () => {
    vi.useFakeTimers();
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    mocks.state.kickAfterConnectsRemaining = 1;

    lastClient().emit('event.disconnected_event', 'kicked');
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(2));
    await vi.waitFor(() =>
      expect(
        (
          channel as unknown as {
            reconnectingAfterKick: boolean;
          }
        ).reconnectingAfterKick,
      ).toBe(false),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.instances).toHaveLength(2);

    channel.disconnect();
  });

  it('resets exhausted kick attempts before replaying a pending kick', async () => {
    vi.useFakeTimers();
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    mocks.state.connectErrorsRemaining = 3;

    lastClient().emit('event.disconnected_event', 'kicked');
    (
      channel as unknown as {
        pendingKickReconnect: boolean;
      }
    ).pendingKickReconnect = true;

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(4));

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(5));

    channel.disconnect();
  });

  it('does not clear adapter state when reconnecting after a kick', async () => {
    vi.useFakeTimers();
    const bridge = makeBridge();
    (bridge.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<string>(() => {}),
    );
    const channel = new WeComChannel('bot', makeConfig(), bridge);
    await channel.connect();
    const oldClient = lastClient();

    oldClient.emit('message.file', {
      msgid: 'msg-kick-preserve',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'report.txt',
      },
    });

    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(1));
    const prompt = (bridge.prompt as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    const filePath = prompt.match(/saved to: (.*report\.txt)/)?.[1];
    expect(filePath).toBeDefined();

    oldClient.emit('event.disconnected_event', {
      errcode: 45009,
      errmsg: 'another client connected',
    });
    expect(oldClient.disconnect).toHaveBeenCalled();
    expect(existsSync(filePath!)).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(2));
    const newClient = lastClient();
    newClient.emit('message.file', {
      msgid: 'msg-kick-preserve',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'report.txt',
      },
    });

    await Promise.resolve();
    expect(bridge.prompt).toHaveBeenCalledTimes(1);
    expect(existsSync(filePath!)).toBe(true);
    channel.disconnect();
  });

  it('fails a pending authentication promptly when the connection is kicked', async () => {
    mocks.state.autoAuthenticate = false;
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());

    const connecting = channel.connect();
    const client = lastClient();
    client.emit('event.disconnected_event', {
      errcode: 45009,
      errmsg: 'another client connected',
    });

    await expect(connecting).rejects.toThrow('kicked');
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('fails pending authentication promptly on SDK errors', async () => {
    mocks.state.autoAuthenticate = false;
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());

    const connecting = channel.connect();
    lastClient().emit('error', new Error('auth failed'));

    await expect(connecting).rejects.toThrow(
      'WeCom authentication failed: Error: auth failed',
    );
    stderr.mockRestore();
  });

  it('fails pending authentication when the timeout elapses', async () => {
    vi.useFakeTimers();
    mocks.state.autoAuthenticate = false;
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());

    const connecting = channel.connect();
    const rejection = expect(connecting).rejects.toThrow(
      'WeCom authentication timed out.',
    );
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
  });

  it('fails authentication timeout even when SDK connect hangs', async () => {
    vi.useFakeTimers();
    mocks.state.autoAuthenticate = false;
    mocks.state.connectNeverSettles = true;
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());

    const connecting = channel.connect();
    const rejection = expect(connecting).rejects.toThrow(
      'WeCom authentication timed out.',
    );
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(lastClient().disconnect).toHaveBeenCalled();
  });

  it('fails when SDK authenticates but connect never settles', async () => {
    vi.useFakeTimers();
    mocks.state.autoAuthenticate = false;
    mocks.state.connectNeverSettles = true;
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());

    const connecting = channel.connect();
    const client = lastClient();
    let settled: string | undefined;
    connecting.then(
      () => {
        settled = 'resolved';
      },
      (err: unknown) => {
        settled = err instanceof Error ? err.message : String(err);
      },
    );

    client.emit('authenticated', {});
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();

    expect(settled).toBe('WeCom SDK connect timed out.');
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('removes SDK event handlers on disconnect', async () => {
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    channel.disconnect();
    client.emit('message.text', {
      msgid: 'msg-after-disconnect',
      msgtype: 'text',
      chattype: 'single',
      from: { userid: 'alice' },
      text: { content: 'hello' },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(channel.envelopes).toHaveLength(0);
    expect(client.handlers.get('message.text')).toHaveLength(0);
    expect(client.handlers.get('message.image')).toHaveLength(0);
    expect(client.handlers.get('error')).toHaveLength(0);
    expect(client.handlers.get('disconnected')).toHaveLength(0);
    expect(client.handlers.get('event.disconnected_event')).toHaveLength(0);
  });

  it('rejects sends when no SDK client is active', async () => {
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());

    await expect(channel.sendMessage('chat-1', 'hello')).rejects.toThrow(
      '[WeCom:bot] No active SDK client, cannot send.',
    );
  });

  it('logs when sendMessage produces an empty payload', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    await channel.sendMessage('chat-1', '   ');

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.uploadMedia).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      '[WeCom:bot] sendMessage produced empty payload for chatId=chat-1.\n',
    );
    stderr.mockRestore();
  });

  it('normalizes text messages into envelopes', async () => {
    const channel = new TestWeComChannel(
      'bot',
      makeConfig({ groupPolicy: 'open', groups: { '*': {} } }),
      makeBridge(),
    );
    await channel.connect();

    lastClient().emit('message.text', {
      msgid: 'msg-1',
      msgtype: 'text',
      chattype: 'single',
      from: { userid: 'alice' },
      text: { content: 'hello' },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    const envelope = channel.envelopes[0]!;
    expect(envelope).toMatchObject({
      channelName: 'bot',
      senderId: 'alice',
      senderName: 'alice',
      chatId: 'alice',
      text: 'hello',
      messageId: 'msg-1',
      isGroup: false,
      isMentioned: true,
      isReplyToBot: false,
    });
  });

  it('logs malformed message payloads without processing them', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();

    lastClient().emit('message.text', undefined);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(channel.envelopes).toHaveLength(0);
    expect(stderr).toHaveBeenCalledWith(
      '[WeCom:bot] dropping message with unrecognized payload structure.\n',
    );
    stderr.mockRestore();
  });

  it('normalizes group, voice, mixed, quote, and file messages', async () => {
    const channel = new TestWeComChannel(
      'bot',
      makeConfig({
        groupPolicy: 'open',
        groups: { '*': { requireMention: false } },
      }),
      makeBridge(),
    );
    await channel.connect();
    const client = lastClient();
    mocks.httpResponse.body = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    client.emit('message.mixed', {
      msgid: 'msg-2',
      msgtype: 'mixed',
      chattype: 'group',
      chatid: 'group-1',
      from: { userid: 'bob', name: 'Bob' },
      mixed: {
        msg_item: [
          { msgtype: 'text', text: { content: '@bot inspect this' } },
          { msgtype: 'voice', voice: { content: 'voice transcript' } },
          {
            msgtype: 'image',
            image: { url: 'https://example.invalid/image', aeskey: 'k1' },
          },
        ],
      },
      image: { url: 'https://example.invalid/image', aeskey: 'k1' },
      quote: {
        msgtype: 'voice',
        voice: { content: 'previous voice text' },
      },
    });

    client.emit('message.file', {
      msgid: 'msg-3',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'carol' },
      file: {
        url: 'https://example.invalid/file',
        aeskey: 'k2',
        filename: '../report.pdf',
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(2));
    expect(mocks.httpsRequest).toHaveBeenCalledWith(
      'https://example.invalid/image',
      expect.objectContaining({ method: 'GET' }),
      expect.any(Function),
    );
    expect(mocks.httpsRequest).toHaveBeenCalledWith(
      'https://example.invalid/file',
      expect.objectContaining({ method: 'GET' }),
      expect.any(Function),
    );
    expect(mocks.httpsRequest).toHaveBeenCalledTimes(2);
    expect(mocks.decryptFile).toHaveBeenCalledWith(expect.any(Buffer), 'k1');
    expect(mocks.decryptFile).toHaveBeenCalledWith(expect.any(Buffer), 'k2');
    const mixed = channel.envelopes[0]!;
    expect(mixed.chatId).toBe('group-1');
    expect(mixed.isGroup).toBe(true);
    expect(mixed.text).toBe('@bot inspect this\nvoice transcript');
    expect(mixed.referencedText).toBe('previous voice text');
    expect(mixed.attachments?.[0]).toMatchObject({
      type: 'image',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      mimeType: 'image/png',
    });

    const file = channel.envelopes[1]!;
    expect(file.text).toBe('(file: report.pdf)');
    expect(file.attachments?.[0]?.type).toBe('file');
    expect(file.attachments?.[0]?.fileName).toBe('report.pdf');
    expect(file.attachments?.[0]?.filePath).toContain('report.pdf');
  });

  it('preserves distinct unicode inbound filenames', async () => {
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.mixed', {
      msgid: 'msg-unicode-files',
      msgtype: 'mixed',
      chattype: 'single',
      from: { userid: 'alice' },
      mixed: {
        msg_item: [
          {
            msgtype: 'file',
            file: {
              url: 'https://example.invalid/report',
              filename: '報告.pdf',
            },
          },
          {
            msgtype: 'file',
            file: {
              url: 'https://example.invalid/photo',
              filename: '写真.pdf',
            },
          },
        ],
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    const attachments = channel.envelopes[0]?.attachments ?? [];
    expect(attachments.map((attachment) => attachment.fileName)).toEqual([
      '報告.pdf',
      '写真.pdf',
    ]);
    expect(
      new Set(attachments.map((attachment) => attachment.filePath)).size,
    ).toBe(2);
  });

  it('allows group replies to the bot without an explicit mention', async () => {
    const channel = new TestWeComChannel(
      'bot',
      makeConfig({
        groupPolicy: 'open',
        groups: { '*': {} },
      }),
      makeBridge(),
    );
    await channel.connect();

    lastClient().emit('message.text', {
      msgid: 'msg-reply',
      msgtype: 'text',
      chattype: 'group',
      chatid: 'group-1',
      from: { userid: 'alice' },
      mentions: [],
      text: { content: 'follow up' },
      quote: {
        msgtype: 'text',
        from: { userid: 'bot-id' },
        text: { content: 'bot response' },
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]).toMatchObject({
      isGroup: true,
      isMentioned: false,
      isReplyToBot: true,
      referencedText: 'bot response',
    });
  });

  it('sanitizes downloaded image filenames before adding attachments', async () => {
    mocks.httpResponse.headers = {
      'content-disposition': 'attachment; filename="../secret.png"',
    };
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-image-filename',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: { url: 'https://example.invalid/image', aeskey: 'k1' },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments?.[0]?.fileName).toBe('secret.png');
  });

  it('honors explicit group mention metadata when present', async () => {
    const channel = new TestWeComChannel(
      'bot',
      makeConfig({
        groupPolicy: 'open',
        groups: { '*': { requireMention: false } },
      }),
      makeBridge(),
    );
    await channel.connect();
    const client = lastClient();

    client.emit('message.text', {
      msgid: 'msg-unmentioned',
      msgtype: 'text',
      chattype: 'group',
      chatid: 'group-1',
      from: { userid: 'bob' },
      text: { content: 'background' },
      mentions: [{ userid: 'other-bot' }],
    });
    client.emit('message.text', {
      msgid: 'msg-mentioned',
      msgtype: 'text',
      chattype: 'group',
      chatid: 'group-1',
      from: { userid: 'bob' },
      text: { content: '@bot inspect' },
      mentions: [{ userid: 'bot-id' }],
    });
    client.emit('message.text', {
      msgid: 'msg-other-mentioned',
      msgtype: 'text',
      chattype: 'group',
      chatid: 'group-1',
      from: { userid: 'bob' },
      text: { content: '@someone else' },
      isMentioned: true,
      isInAtList: false,
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(3));
    expect(channel.envelopes.map((envelope) => envelope.isMentioned)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('treats empty mention metadata as explicitly unmentioned', async () => {
    const channel = new TestWeComChannel(
      'bot',
      makeConfig({ groupPolicy: 'open', groups: { '*': {} } }),
      makeBridge(),
    );
    await channel.connect();
    const client = lastClient();

    client.emit('message.text', {
      msgid: 'msg-empty-mentions',
      msgtype: 'text',
      chattype: 'group',
      chatid: 'group-1',
      from: { userid: 'bob' },
      text: { content: 'background' },
      mentions: [],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(channel.envelopes).toHaveLength(0);
  });

  it('treats missing group mention metadata as unmentioned', async () => {
    const channel = new TestWeComChannel(
      'bot',
      makeConfig({ groupPolicy: 'open', groups: { '*': {} } }),
      makeBridge(),
    );
    await channel.connect();
    const client = lastClient();

    client.emit('message.text', {
      msgid: 'msg-missing-mention-metadata',
      msgtype: 'text',
      chattype: 'group',
      chatid: 'group-1',
      from: { userid: 'bob' },
      text: { content: 'background' },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(channel.envelopes).toHaveLength(0);
  });

  it('does not download attachments for messages rejected by mention gate', async () => {
    const channel = new TestWeComChannel(
      'bot',
      makeConfig({ groupPolicy: 'open', groups: { '*': {} } }),
      makeBridge(),
    );
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-unmentioned-image',
      msgtype: 'image',
      chattype: 'group',
      chatid: 'group-1',
      from: { userid: 'bob' },
      mentions: [],
      image: { url: 'https://example.invalid/private-image', aeskey: 'k1' },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(channel.envelopes).toHaveLength(0);
  });

  it('drops malformed group messages without falling back to sender chat', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel(
      'bot',
      makeConfig({ groupPolicy: 'open', groups: { '*': {} } }),
      makeBridge(),
    );
    await channel.connect();
    const client = lastClient();

    client.emit('message.text', {
      msgid: 'msg-missing-chat',
      msgtype: 'text',
      chattype: 'group',
      from: { userid: 'bob' },
      text: { content: '@bot inspect' },
      mentions: [{ userid: 'bot-id' }],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(channel.envelopes).toHaveLength(0);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('missing chatId'),
    );
    stderr.mockRestore();
  });

  it('does not create a session for local commands before base dispatch', async () => {
    const bridge = makeBridge();
    const channel = new WeComChannel('bot', makeConfig(), bridge);
    await channel.connect();
    const client = lastClient();

    client.emit('message.text', {
      msgid: 'msg-who',
      msgtype: 'text',
      chattype: 'single',
      from: { userid: 'alice' },
      text: { content: '/who' },
    });

    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalled());
    expect(bridge.newSession).not.toHaveBeenCalled();
    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledWith(
      'alice',
      expect.objectContaining({
        markdown: expect.objectContaining({
          content: expect.stringContaining('Session: none'),
        }),
      }),
    );
  });

  it('does not create a session for refused group shell commands', async () => {
    const bridge = makeBridge();
    const channel = new WeComChannel(
      'bot',
      makeConfig({ groupPolicy: 'open', groups: { '*': {} } }),
      bridge,
    );
    await channel.connect();
    const client = lastClient();

    client.emit('message.text', {
      msgid: 'msg-shell',
      msgtype: 'text',
      chattype: 'group',
      chatid: 'group-1',
      from: { userid: 'alice' },
      text: { content: '!pwd' },
      mentions: [{ userid: 'bot-id' }],
    });

    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalled());
    expect(bridge.newSession).not.toHaveBeenCalled();
    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledWith(
      'group-1',
      expect.objectContaining({
        markdown: expect.objectContaining({
          content: expect.stringContaining('Shell commands'),
        }),
      }),
    );
  });

  it('rolls back message dedup when preflight work fails', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new FailingPreflightWeComChannel(
      'bot',
      makeConfig(),
      makeBridge(),
    );
    await channel.connect();
    const client = lastClient();
    const payload = {
      msgid: 'msg-preflight-fails',
      msgtype: 'text',
      chattype: 'single',
      from: { userid: 'alice' },
      text: { content: 'hello' },
    };

    client.emit('message.text', payload);
    await vi.waitFor(() => expect(channel.preflights).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('message handling failed'),
      ),
    );

    client.emit('message.text', payload);
    await vi.waitFor(() => expect(channel.preflights).toHaveBeenCalledTimes(2));
    stderr.mockRestore();
  });

  it('allows retries for messages rejected by preflight', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const bridge = makeBridge();
    const channel = new RejectingPreflightWeComChannel(
      'bot',
      makeConfig(),
      bridge,
    );
    await channel.connect();
    const client = lastClient();
    const payload = {
      msgid: 'msg-preflight-rejected',
      msgtype: 'text',
      chattype: 'single',
      from: { userid: 'alice' },
      text: { content: 'hello' },
    };

    client.emit('message.text', payload);
    await vi.waitFor(() => expect(channel.preflights).toHaveBeenCalledTimes(1));
    expect(bridge.newSession).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(stderr).toHaveBeenCalledWith(
        '[WeCom:bot] dropping message msg-preflight-rejected: preflight rejected.\n',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    client.emit('message.text', payload);
    await vi.waitFor(() => expect(channel.preflights).toHaveBeenCalledTimes(2));
    expect(bridge.newSession).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('deduplicates repeated messages while preflight is pending', async () => {
    const channel = new BlockingPreflightWeComChannel(
      'bot',
      makeConfig(),
      makeBridge(),
    );
    await channel.connect();
    const client = lastClient();
    const payload = {
      msgid: 'msg-preflight-pending',
      msgtype: 'text',
      chattype: 'single',
      from: { userid: 'alice' },
      text: { content: 'hello' },
    };

    client.emit('message.text', payload);
    await vi.waitFor(() => expect(channel.preflights).toHaveBeenCalledTimes(1));
    client.emit('message.text', payload);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(channel.preflights).toHaveBeenCalledTimes(1);

    channel.releasePreflights();
    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
  });

  it('keeps message dedup when processing fails after side effects start', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new FailingProcessWeComChannel(
      'bot',
      makeConfig(),
      makeBridge(),
    );
    await channel.connect();
    const client = lastClient();
    const payload = {
      msgid: 'msg-process-fails',
      msgtype: 'text',
      chattype: 'single',
      from: { userid: 'alice' },
      text: { content: 'hello' },
    };

    client.emit('message.text', payload);
    await vi.waitFor(() => expect(channel.processes).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('message handling failed'),
      ),
    );

    client.emit('message.text', payload);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(channel.processes).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(
      '[WeCom:bot] dropping duplicate message msg-process-fails (already seen).\n',
    );
    stderr.mockRestore();
  });

  it('logs duplicate messages that are already in flight', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new BlockingPreflightWeComChannel(
      'bot',
      makeConfig(),
      makeBridge(),
    );
    await channel.connect();
    const client = lastClient();
    const payload = {
      msgid: 'msg-in-flight',
      msgtype: 'text',
      chattype: 'single',
      from: { userid: 'alice' },
      text: { content: 'hello' },
    };

    client.emit('message.text', payload);
    await vi.waitFor(() => expect(channel.preflights).toHaveBeenCalledTimes(1));

    client.emit('message.text', payload);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(channel.preflights).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(
      '[WeCom:bot] dropping duplicate message msg-in-flight (already in flight).\n',
    );
    channel.releasePreflights();
    stderr.mockRestore();
  });

  it('does not download attachments from unsafe media URLs', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-unsafe-image',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://169.254.169.254/latest/meta-data/',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('unsafe media URL'),
    );
    stderr.mockRestore();
  });

  it('blocks non-HTTPS media URLs before probing them', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-http-image',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'http://169.254.169.254/latest/meta-data/',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('unsafe media URL'),
    );
    stderr.mockRestore();
  });

  it('blocks media URLs with embedded credentials before probing them', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-userinfo-image',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://token:secret@example.com/file.png',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('URL contains embedded credentials'),
    );
    stderr.mockRestore();
  });

  it('blocks local and bare media hostnames before probing them', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    for (const [index, url] of [
      'https://localhost/latest/meta-data/',
      'https://metadata.local/latest/meta-data/',
      'https://metadata.local./latest/meta-data/',
      'https://metadata/latest/meta-data/',
    ].entries()) {
      client.emit('message.image', {
        msgid: `msg-local-host-${index}`,
        msgtype: 'image',
        chattype: 'single',
        from: { userid: 'alice' },
        image: { url, aeskey: 'k1' },
      });
    }

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(4));
    expect(channel.envelopes.every((entry) => !entry.attachments)).toBe(true);
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('unsafe media URL'),
    );
    stderr.mockRestore();
  });

  it('blocks IPv4-mapped IPv6 media URLs before probing them', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-mapped-ip',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://[::ffff:169.254.169.254]/latest/meta-data/',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('unsafe media URL'),
    );
    stderr.mockRestore();
  });

  it('blocks non-canonical IPv6 unspecified addresses before probing them', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-unspecified-ipv6',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://[0:0:0:0:0:0:0:0]/latest/meta-data/',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('unsafe media URL (private address ::)'),
    );
    stderr.mockRestore();
  });

  it('blocks uncompressed IPv4-mapped IPv6 media URLs before probing them', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-uncompressed-mapped-ip',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://[0:0:0:0:0:ffff:7f00:1]/latest/meta-data/',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('unsafe media URL'),
    );
    stderr.mockRestore();
  });

  it('blocks SIIT IPv4-mapped IPv6 media URLs before probing them', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-siit-mapped-ip',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://[::ffff:0:a00:1]/latest/meta-data/',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('unsafe media URL'),
    );
    stderr.mockRestore();
  });

  it('blocks SIIT IPv4-mapped metadata URLs before probing them', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-siit-metadata-ip',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://[::ffff:0:a9fe:a9fe]/latest/meta-data/',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('unsafe media URL'),
    );
    stderr.mockRestore();
  });

  it('blocks IPv6 transition media URLs before probing them', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    for (const [index, url] of [
      'https://[::]/internal-api',
      'https://[::a9fe:a9fe]/latest/meta-data/',
      'https://[2002:a9fe:a9fe::]/latest/meta-data/',
      'https://[2001::ffff:ffff:ffff:5601:5601]/latest/meta-data/',
    ].entries()) {
      client.emit('message.image', {
        msgid: `msg-ipv6-transition-${index}`,
        msgtype: 'image',
        chattype: 'single',
        from: { userid: 'alice' },
        image: { url, aeskey: 'k1' },
      });
    }

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(4));
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('unsafe media URL'),
    );
    stderr.mockRestore();
  });

  it('blocks CGNAT media URLs before probing them', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-cgnat-ip',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://100.100.100.200/latest/meta-data/',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('unsafe media URL'),
    );
    stderr.mockRestore();
  });

  it('blocks media hostnames that resolve to private addresses', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mocks.lookup.mockResolvedValueOnce([
      { address: '169.254.169.254', family: 4 },
    ]);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-rebinding-host',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://metadata.example.com/latest/meta-data/',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(mocks.lookup).toHaveBeenCalledWith('metadata.example.com', {
      all: true,
    });
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        'unsafe media URL (metadata.example.com resolved to private address 169.254.169.254)',
      ),
    );
    stderr.mockRestore();
  });

  it('includes DNS lookup errors when rejecting media hostnames', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mocks.lookup.mockRejectedValueOnce(new Error('queryA ETIMEDOUT'));
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-dns-failure',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://metadata.example.com/latest/meta-data/',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        'unsafe media URL (DNS lookup failed for metadata.example.com: queryA ETIMEDOUT)',
      ),
    );
    stderr.mockRestore();
  });

  it('blocks media hostnames with mixed public and private DNS results', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mocks.lookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-mixed-dns-host',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://metadata.example.com/latest/meta-data/',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(mocks.lookup).toHaveBeenCalledWith('metadata.example.com', {
      all: true,
    });
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('unsafe media URL'),
    );
    stderr.mockRestore();
  });

  it('returns all resolved addresses when Node requests lookup all mode', async () => {
    type LookupCallback = (
      err: Error | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void;
    type RequestOptionsWithLookup = {
      lookup?: (
        hostname: string,
        options: { all?: boolean },
        callback: LookupCallback,
      ) => void;
    };
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-lookup-all',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://example.invalid/image',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(mocks.httpCalls).toHaveLength(1));
    const options = mocks.httpCalls[0]?.options as RequestOptionsWithLookup;
    const callback = vi.fn<LookupCallback>();

    options.lookup?.('example.invalid', { all: true }, callback);

    await vi.waitFor(() =>
      expect(callback).toHaveBeenCalledWith(null, [
        { address: '93.184.216.34', family: 4 },
      ]),
    );
  });

  it('does not follow redirects while probing inbound media', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mocks.httpResponse.statusCode = 302;
    mocks.httpResponse.headers = {
      location: 'http://169.254.169.254/latest/meta-data/',
    };
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-redirect-image',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://example.invalid/redirect',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(mocks.httpsRequest).toHaveBeenCalledWith(
      'https://example.invalid/redirect',
      expect.objectContaining({
        method: 'GET',
        lookup: expect.any(Function),
      }),
      expect.any(Function),
    );
    expect(mocks.httpCalls[0]?.request.setTimeout).toHaveBeenCalledWith(
      10_000,
      expect.any(Function),
    );
    expect(mocks.httpCalls[0]?.request.destroy).toHaveBeenCalled();
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('redirected media URL'),
    );
    stderr.mockRestore();
  });

  it('skips inbound attachments that exceed the media size cap', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();
    mocks.httpResponse.headers = {
      'content-length': String(20 * 1024 * 1024 + 1),
    };

    client.emit('message.image', {
      msgid: 'msg-large-image',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: { url: 'https://example.invalid/large-image', aeskey: 'k1' },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).toHaveBeenCalled();
    expect(mocks.httpCalls[0]?.request.destroy).toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('oversized attachment'),
    );
    expect(stderr).not.toHaveBeenCalledWith(
      expect.stringContaining('https://example.invalid/large-image'),
    );
    stderr.mockRestore();
  });

  it('aborts inbound attachments that exceed the streaming size cap', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();
    mocks.httpResponse.body = Buffer.alloc(20 * 1024 * 1024 + 1);

    client.emit('message.image', {
      msgid: 'msg-stream-large-image',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: { url: 'https://example.invalid/stream-large', aeskey: 'k1' },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.httpCalls[0]?.request.destroy).toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('oversized attachment'),
    );
    stderr.mockRestore();
  });

  it('aborts inbound attachments on absolute download timeout', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    vi.useFakeTimers();
    const client = lastClient();
    mocks.state.mediaResponseNeverEnds = true;

    client.emit('message.image', {
      msgid: 'msg-slow-image',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: { url: 'https://example.invalid/slow-image', aeskey: 'k1' },
    });

    await vi.waitFor(() => expect(mocks.httpCalls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(60_000);

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.httpCalls[0]?.request.destroy).toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('media download absolute timeout'),
    );
    stderr.mockRestore();
  });

  it('skips inbound attachments when the media request returns non-success', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mocks.httpResponse.statusCode = 500;
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-download-fails',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: { url: 'https://example.invalid/fails', aeskey: 'k1' },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.httpCalls[0]?.request.destroy).toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('media download failed: HTTP 500'),
    );
    stderr.mockRestore();
  });

  it('skips inbound attachments when the media response is empty', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mocks.httpResponse.body = Buffer.alloc(0);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-empty-media',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: { url: 'https://example.invalid/empty', aeskey: 'k1' },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('empty media response'),
    );
    stderr.mockRestore();
  });

  it('rejects private addresses during request-time lookup validation', async () => {
    type LookupCallback = (
      err: Error | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void;
    type RequestOptionsWithLookup = {
      lookup?: (
        hostname: string,
        options: { all?: boolean },
        callback: LookupCallback,
      ) => void;
    };
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-lookup-private',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://example.invalid/image',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(mocks.httpCalls).toHaveLength(1));
    mocks.lookup.mockResolvedValueOnce([
      { address: '169.254.169.254', family: 4 },
    ]);
    const options = mocks.httpCalls[0]?.options as RequestOptionsWithLookup;
    const callback = vi.fn<LookupCallback>();

    options.lookup?.('example.invalid', { all: true }, callback);

    await vi.waitFor(() => expect(callback).toHaveBeenCalled());
    expect(callback.mock.calls[0]?.[0]).toEqual(
      new Error(
        'unsafe resolved media address: example.invalid resolved to private address 169.254.169.254',
      ),
    );
    expect(callback).toHaveBeenCalledWith(expect.any(Error), '', 0);
  });

  it('rejects uncompressed mapped private addresses during request-time lookup validation', async () => {
    type LookupCallback = (
      err: Error | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void;
    type RequestOptionsWithLookup = {
      lookup?: (
        hostname: string,
        options: { all?: boolean },
        callback: LookupCallback,
      ) => void;
    };
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-lookup-uncompressed-mapped',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://example.invalid/image',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(mocks.httpCalls).toHaveLength(1));
    mocks.lookup.mockResolvedValueOnce([
      { address: '0:0:0:0:0:ffff:7f00:1', family: 6 },
    ]);
    const options = mocks.httpCalls[0]?.options as RequestOptionsWithLookup;
    const callback = vi.fn<LookupCallback>();

    options.lookup?.('example.invalid', { all: true }, callback);

    await vi.waitFor(() =>
      expect(callback).toHaveBeenCalledWith(expect.any(Error), '', 0),
    );
  });

  it('rejects low-zero IPv6 private IPv4 embeddings during request-time lookup validation', async () => {
    type LookupCallback = (
      err: Error | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void;
    type RequestOptionsWithLookup = {
      lookup?: (
        hostname: string,
        options: { all?: boolean },
        callback: LookupCallback,
      ) => void;
    };
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-lookup-low-zero-private',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://example.invalid/image',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(mocks.httpCalls).toHaveLength(1));
    mocks.lookup.mockResolvedValueOnce([{ address: '::1:a9fe:1', family: 6 }]);
    const options = mocks.httpCalls[0]?.options as RequestOptionsWithLookup;
    const callback = vi.fn<LookupCallback>();

    options.lookup?.('example.invalid', { all: true }, callback);

    await vi.waitFor(() =>
      expect(callback).toHaveBeenCalledWith(expect.any(Error), '', 0),
    );
  });

  it('limits quote recursion when collecting inbound attachments', async () => {
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.text', {
      msgid: 'msg-deep-quote',
      msgtype: 'text',
      chattype: 'single',
      from: { userid: 'alice' },
      text: { content: 'hello' },
      quote: {
        msgtype: 'text',
        quote: {
          msgtype: 'text',
          quote: {
            msgtype: 'text',
            quote: {
              msgtype: 'text',
              quote: {
                msgtype: 'image',
                image: { url: 'https://example.invalid/deep-image' },
              },
            },
          },
        },
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it('deduplicates media URLs across quoted messages', async () => {
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.text', {
      msgid: 'msg-quote-duplicate',
      msgtype: 'text',
      chattype: 'single',
      from: { userid: 'alice' },
      text: { content: 'hello' },
      image: { url: 'https://example.invalid/image', aeskey: 'k1' },
      quote: {
        msgtype: 'image',
        image: { url: 'https://example.invalid/image', aeskey: 'k1' },
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(mocks.httpsRequest).toHaveBeenCalledTimes(1);
  });

  it('stores inbound file attachments in private temp files asynchronously', async () => {
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.file', {
      msgid: 'msg-private-file',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'report.txt',
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    const filePath = channel.envelopes[0]?.attachments?.[0]?.filePath;
    expect(filePath).toBeDefined();
    expect(mocks.writeFile).toHaveBeenCalledWith(
      filePath,
      Buffer.from('downloaded'),
      { mode: 0o600 },
    );
  });

  it('skips inbound file attachments when temp file writing fails', async () => {
    mocks.writeFile.mockRejectedValueOnce(new Error('ENAMETOOLONG'));
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    try {
      client.emit('message.file', {
        msgid: 'msg-write-fails',
        msgtype: 'file',
        chattype: 'single',
        from: { userid: 'alice' },
        file: {
          url: 'https://example.invalid/file',
          filename: 'report.txt',
        },
      });

      await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
      expect(channel.envelopes[0]?.attachments).toBeUndefined();
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('skipping file attachment: ENAMETOOLONG'),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('removes file attachment dirs created during disconnect', async () => {
    let finishWrite: (() => void) | undefined;
    mocks.writeFile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const bridge = makeBridge();
    const channel = new WeComChannel('bot', makeConfig(), bridge);
    await channel.connect();
    const client = lastClient();

    client.emit('message.file', {
      msgid: 'msg-disconnect-during-download',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'report.txt',
      },
    });

    await vi.waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(1));
    const filePath = mocks.writeFile.mock.calls[0]?.[0] as string;
    const dir = dirname(filePath);
    expect(existsSync(dir)).toBe(true);

    channel.disconnect();
    finishWrite?.();

    await vi.waitFor(() => expect(existsSync(dir)).toBe(false));
    expect(bridge.prompt).not.toHaveBeenCalled();
  });

  it('rejects media URLs that resolve to IPv6 link-local addresses', async () => {
    mocks.lookup.mockResolvedValue([{ address: 'fe90::1', family: 6 }]);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-link-local',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: { url: 'https://example.invalid/image', aeskey: 'k1' },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it('rejects media URLs that resolve to IPv6 site-local addresses', async () => {
    mocks.lookup.mockResolvedValue([{ address: 'fec0::1', family: 6 }]);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-site-local',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: { url: 'https://example.invalid/image', aeskey: 'k1' },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it('rejects media URLs that resolve to IPv6 multicast addresses', async () => {
    mocks.lookup.mockResolvedValue([{ address: 'ff02::1', family: 6 }]);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-multicast',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: { url: 'https://example.invalid/image', aeskey: 'k1' },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it('decodes Teredo media URLs before checking embedded IPv4 safety', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-teredo-xor',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://[2001::ffff:ffff:ffff:561:561]/latest/meta-data/',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('unsafe media URL'),
    );
    stderr.mockRestore();
  });

  it('decodes NAT64 media URLs before checking embedded IPv4 safety', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-nat64',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://[64:ff9b::10.0.0.1]/latest/meta-data/',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('unsafe media URL'),
    );
    stderr.mockRestore();
  });

  it('decodes NAT64 /48 media URLs before checking embedded IPv4 safety', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-nat64-48',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: {
        url: 'https://[64:ff9b:1::127.0.0.1]/latest/meta-data/',
        aeskey: 'k1',
      },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('unsafe media URL'),
    );
    stderr.mockRestore();
  });

  it('allows public IPv4 addresses adjacent to documentation ranges', async () => {
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-public-ipv4-adjacent',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: { url: 'https://192.0.32.1/image', aeskey: 'k1' },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(mocks.httpsRequest).toHaveBeenCalledWith(
      'https://192.0.32.1/image',
      expect.objectContaining({ method: 'GET' }),
      expect.any(Function),
    );
    expect(channel.envelopes[0]?.attachments).toHaveLength(1);
  });

  it('still rejects IPv4 documentation ranges', async () => {
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-doc-ipv4',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: { url: 'https://192.0.2.1/image', aeskey: 'k1' },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it('rejects IPv6 documentation ranges', async () => {
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-doc-ipv6',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: { url: 'https://[2001:db8::1]/image', aeskey: 'k1' },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it('rejects deprecated 6to4 relay anycast IPv4 addresses', async () => {
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.image', {
      msgid: 'msg-6to4-relay',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: { url: 'https://192.88.99.1/image', aeskey: 'k1' },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it('keeps downloaded file attachments for base prompt consumers', async () => {
    vi.useFakeTimers();
    const bridge = makeBridge();
    (bridge.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<string>(() => {}),
    );
    const channel = new WeComChannel('bot', makeConfig(), bridge);
    await channel.connect();
    const client = lastClient();

    client.emit('message.file', {
      msgid: 'msg-cleanup-dir',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'report.txt',
      },
    });

    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(1));
    const prompt = (bridge.prompt as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    const filePath = prompt.match(/saved to: (.*report\.txt)/)?.[1];
    expect(filePath).toBeDefined();
    expect(existsSync(dirname(filePath!))).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(existsSync(filePath!)).toBe(true);
    expect(existsSync(dirname(filePath!))).toBe(true);
  });

  it('removes downloaded file attachments after the prompt finishes', async () => {
    const bridge = makeBridge();
    const channel = new WeComChannel('bot', makeConfig(), bridge);
    await channel.connect();
    const client = lastClient();

    client.emit('message.file', {
      msgid: 'msg-cleanup-after-prompt',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'report.txt',
      },
    });

    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(1));
    const prompt = (bridge.prompt as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    const filePath = prompt.match(/saved to: (.*report\.txt)/)?.[1];
    expect(filePath).toBeDefined();
    await vi.waitFor(() => expect(existsSync(dirname(filePath!))).toBe(false));
  });

  it('continues attachment cleanup when one dir removal fails', async () => {
    const parent = join(tmpdir(), 'channel-files');
    mkdirSync(parent, { recursive: true });
    const blockedParent = mkdtempSync(join(parent, 'wecom-blocked-'));
    const firstDir = join(blockedParent, 'first');
    mkdirSync(firstDir);
    chmodSync(blockedParent, 0o500);
    const secondDir = mkdtempSync(join(parent, 'wecom-test-'));
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    const harness = channel as unknown as {
      rememberAttachmentDir(
        dir: string,
        messageId?: string,
        routeKey?: string,
      ): void;
      cleanupAllAttachmentDirs(): void;
    };
    harness.rememberAttachmentDir(firstDir, 'msg-first');
    harness.rememberAttachmentDir(secondDir, 'msg-second');
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      harness.cleanupAllAttachmentDirs();

      expect(existsSync(firstDir)).toBe(true);
      expect(existsSync(secondDir)).toBe(false);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('failed to remove attachment dir'),
      );
    } finally {
      stderr.mockRestore();
      chmodSync(blockedParent, 0o700);
      rmSync(blockedParent, { recursive: true, force: true });
      rmSync(secondDir, { recursive: true, force: true });
    }
  });

  it('removes session attachment dirs when prompt end has no message id', async () => {
    const bridge = makeBridge();
    (bridge.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<string>(() => {}),
    );
    const channel = new PromptEndWeComChannel('bot', makeConfig(), bridge);
    await channel.connect();
    const client = lastClient();

    client.emit('message.file', {
      msgid: 'msg-session-cleanup',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'report.txt',
      },
    });

    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(1));
    const prompt = (bridge.prompt as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    const attachmentPath = prompt.match(/saved to: (.*report\.txt)/)?.[1];
    expect(attachmentPath).toBeDefined();
    expect(existsSync(dirname(attachmentPath!))).toBe(true);

    channel.finishPrompt('alice', 'session-1');

    await vi.waitFor(() =>
      expect(existsSync(dirname(attachmentPath!))).toBe(false),
    );
  });

  it('removes no-message-id attachment dirs when prompt end has no message id', async () => {
    const bridge = makeBridge();
    (bridge.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<string>(() => {}),
    );
    const channel = new PromptEndWeComChannel('bot', makeConfig(), bridge);
    await channel.connect();
    const client = lastClient();

    client.emit('message.file', {
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'report.txt',
      },
    });

    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(1));
    const prompt = (bridge.prompt as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    const attachmentPath = prompt.match(/saved to: (.*report\.txt)/)?.[1];
    expect(attachmentPath).toBeDefined();
    expect(existsSync(dirname(attachmentPath!))).toBe(true);

    channel.finishPrompt('alice', 'session-1');

    await vi.waitFor(() =>
      expect(existsSync(dirname(attachmentPath!))).toBe(false),
    );
  });

  it('keeps no-message-id attachment dirs scoped to their session while another session completes', async () => {
    const bridge = makeBridge();
    const channel = new BlockingAliceProcessWeComChannel(
      'bot',
      makeConfig(),
      bridge,
    );
    await channel.connect();
    const client = lastClient();

    client.emit('message.file', {
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'alice.txt',
      },
    });

    await vi.waitFor(() => expect(channelFileDirs()).toHaveLength(1));
    const aliceDir = channelFileDirs().find((dir) =>
      existsSync(join(dir, 'alice.txt')),
    );
    expect(aliceDir).toBeDefined();
    expect(bridge.prompt).not.toHaveBeenCalled();

    client.emit('message.file', {
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'bob' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'bob.txt',
      },
    });

    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(channelFileDirs()).toHaveLength(1));
    expect(existsSync(aliceDir!)).toBe(true);

    channel.releaseAlice();

    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(channelFileDirs()).toHaveLength(0));
  });

  it('sanitizes message ids before writing drop logs', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('message.text', {
      msgid: 'msg-1\nfake log',
      msgtype: 'text',
      chattype: 'single',
      text: { content: 'hello' },
    });

    await vi.waitFor(() =>
      expect(stderr).toHaveBeenCalledWith(
        '[WeCom:bot] dropping message msg-1\\nfake log: missing senderId.\n',
      ),
    );
    stderr.mockRestore();
  });

  it('cleans untracked session dirs without scanning every message dir', () => {
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    const untrackedDir = mkdtempSync(join(tmpdir(), 'wecom-untracked-'));
    const trackedDir = mkdtempSync(join(tmpdir(), 'wecom-tracked-'));
    const inspectable = channel as unknown as {
      attachmentDirsBySession: Map<string, string[]>;
      attachmentDirsByMessage: Map<string, string[]>;
      attachmentMessageByDir: Map<string, string>;
      cleanupUntrackedAttachmentDirsForSession(sessionId: string): void;
    };
    const messageDirs = new Map<string, string[]>([['msg-1', [trackedDir]]]);
    messageDirs.values = vi.fn(() => {
      throw new Error('full message-dir scan');
    });
    inspectable.attachmentDirsBySession.set('session-1', [
      trackedDir,
      untrackedDir,
    ]);
    inspectable.attachmentDirsByMessage = messageDirs;
    inspectable.attachmentMessageByDir = new Map([[trackedDir, 'msg-1']]);

    inspectable.cleanupUntrackedAttachmentDirsForSession('session-1');

    expect(existsSync(untrackedDir)).toBe(false);
    expect(existsSync(trackedDir)).toBe(true);
  });

  it('removes downloaded file attachments when no prompt starts', async () => {
    const bridge = makeBridge();
    const channel = new WeComChannel('bot', makeConfig(), bridge);
    await channel.connect();
    const client = lastClient();

    client.emit('message.file', {
      msgid: 'msg-command-cleanup',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'report.txt',
      },
      text: {
        content: '/status',
      },
    });

    await vi.waitFor(() =>
      expect(client.sendMessage).toHaveBeenCalledWith(
        'alice',
        expect.objectContaining({ msgtype: 'markdown' }),
      ),
    );
    expect(bridge.prompt).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(channelFileDirs()).toHaveLength(0));
  });

  it('removes every collected file attachment after the coalesced prompt finishes', async () => {
    const bridge = makeBridge();
    let finishPrompt: (() => void) | undefined;
    (bridge.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishPrompt = () => resolve('');
        }),
    );
    const channel = new WeComChannel(
      'bot',
      makeConfig({ dispatchMode: 'collect' }),
      bridge,
    );
    await channel.connect();
    const client = lastClient();

    client.emit('message.file', {
      msgid: 'msg-active',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'active.txt',
      },
    });
    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(1));

    client.emit('message.file', {
      msgid: 'msg-buffered-1',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'first.txt',
      },
    });
    client.emit('message.file', {
      msgid: 'msg-buffered-2',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'second.txt',
      },
    });

    await vi.waitFor(() => expect(channelFileDirs()).toHaveLength(3));

    finishPrompt?.();

    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(channelFileDirs()).toHaveLength(0));
  });

  it('removes no-message-id attachments from a coalesced collect prompt', async () => {
    const bridge = makeBridge();
    let finishFirst: (() => void) | undefined;
    let finishSecond: (() => void) | undefined;
    (bridge.prompt as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishFirst = () => resolve('');
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishSecond = () => resolve('');
          }),
      );
    const channel = new WeComChannel(
      'bot',
      makeConfig({ dispatchMode: 'collect' }),
      bridge,
    );
    await channel.connect();
    const client = lastClient();

    client.emit('message.file', {
      msgid: 'msg-active',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'active.txt',
      },
    });
    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(1));

    client.emit('message.file', {
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'untracked.txt',
      },
    });
    client.emit('message.file', {
      msgid: 'msg-buffered',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'buffered.txt',
      },
    });

    await vi.waitFor(() => expect(channelFileDirs()).toHaveLength(3));

    finishFirst?.();
    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(2));

    finishSecond?.();
    await vi.waitFor(() => expect(channelFileDirs()).toHaveLength(0));
  });

  it('keeps buffered attachment files until their coalesced prompt runs', async () => {
    const bridge = makeBridge();
    let finishFirst: (() => void) | undefined;
    let finishSecond: (() => void) | undefined;
    (bridge.prompt as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishFirst = () => resolve('');
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishSecond = () => resolve('');
          }),
      );
    const channel = new WeComChannel(
      'bot',
      makeConfig({ dispatchMode: 'collect' }),
      bridge,
    );
    await channel.connect();
    const client = lastClient();

    client.emit('message.file', {
      msgid: 'msg-active',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'active.txt',
      },
    });
    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(1));

    client.emit('message.file', {
      msgid: 'msg-buffered',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'buffered.txt',
      },
    });

    await vi.waitFor(() => expect(channelFileDirs()).toHaveLength(2));
    const bufferedDir = channelFileDirs().find((dir) =>
      existsSync(join(dir, 'buffered.txt')),
    );
    expect(bufferedDir).toBeDefined();

    finishFirst?.();

    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(2));
    expect(existsSync(join(bufferedDir!, 'buffered.txt'))).toBe(true);

    finishSecond?.();

    await vi.waitFor(() => expect(channelFileDirs()).toHaveLength(0));
  });

  it('removes buffered attachment files when a collect buffer is cleared', async () => {
    const bridge = makeBridge();
    (bridge.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<string>(() => {}),
    );
    const channel = new WeComChannel(
      'bot',
      makeConfig({ dispatchMode: 'collect' }),
      bridge,
    );
    await channel.connect();
    const client = lastClient();

    client.emit('message.file', {
      msgid: 'msg-active',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'active.txt',
      },
    });
    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(1));

    client.emit('message.file', {
      msgid: 'msg-buffered',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'buffered.txt',
      },
    });

    await vi.waitFor(() => expect(channelFileDirs()).toHaveLength(2));
    const bufferedDir = channelFileDirs().find((dir) =>
      existsSync(join(dir, 'buffered.txt')),
    );
    expect(bufferedDir).toBeDefined();

    client.emit('message.text', {
      msgid: 'msg-clear',
      msgtype: 'text',
      chattype: 'single',
      from: { userid: 'alice' },
      text: { content: '/clear' },
    });

    await vi.waitFor(() => expect(existsSync(bufferedDir!)).toBe(false));
  });

  it('keeps files buffered during a coalesced prompt for the next prompt', async () => {
    const bridge = makeBridge();
    let finishFirst: (() => void) | undefined;
    let finishSecond: (() => void) | undefined;
    let finishThird: (() => void) | undefined;
    (bridge.prompt as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishFirst = () => resolve('');
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishSecond = () => resolve('');
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishThird = () => resolve('');
          }),
      );
    const channel = new WeComChannel(
      'bot',
      makeConfig({ dispatchMode: 'collect' }),
      bridge,
    );
    await channel.connect();
    const client = lastClient();

    client.emit('message.file', {
      msgid: 'msg-active',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'active.txt',
      },
    });
    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(1));

    client.emit('message.file', {
      msgid: 'msg-buffered-1',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'first.txt',
      },
    });
    await vi.waitFor(() => expect(channelFileDirs()).toHaveLength(2));

    finishFirst?.();
    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(2));

    client.emit('message.file', {
      msgid: 'msg-buffered-2',
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'second.txt',
      },
    });
    await vi.waitFor(() => expect(channelFileDirs()).toHaveLength(2));

    finishSecond?.();
    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(3));
    const prompt = (bridge.prompt as ReturnType<typeof vi.fn>).mock
      .calls[2][1] as string;
    const filePath = prompt.match(/saved to: (.*second\.txt)/)?.[1];
    expect(filePath).toBeDefined();
    expect(existsSync(filePath!)).toBe(true);

    finishThird?.();
    await vi.waitFor(() => expect(channelFileDirs()).toHaveLength(0));
  });

  it('tracks attachment dirs for messages without msgid by synthetic message id', async () => {
    const bridge = makeBridge();
    (bridge.prompt as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<string>(() => {}),
    );
    const channel = new WeComChannel('bot', makeConfig(), bridge);
    await channel.connect();

    lastClient().emit('message.file', {
      msgtype: 'file',
      chattype: 'single',
      from: { userid: 'alice' },
      file: {
        url: 'https://example.invalid/file',
        filename: 'no-id.txt',
      },
    });

    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(1));
    const prompt = (bridge.prompt as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    const filePath = prompt.match(/saved to: (.*no-id\.txt)/)?.[1];
    expect(filePath).toBeDefined();
    expect(existsSync(filePath!)).toBe(true);
    expect(
      Array.from(
        (
          channel as unknown as {
            attachmentDirsByMessage: Map<string, string[]>;
          }
        ).attachmentDirsByMessage.keys(),
      ).some((messageId) => messageId.startsWith('synthetic-')),
    ).toBe(true);
    expect(
      (
        channel as unknown as {
          attachmentDirsWithoutMessageByRoute: Map<string, string[]>;
        }
      ).attachmentDirsWithoutMessageByRoute.size,
    ).toBe(0);

    channel.disconnect();
  });

  it('sends markdown text and local media through the SDK', async () => {
    const parent = join(tmpdir(), 'channel-files');
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(join(parent, 'wecom-test-'));
    const imagePath = join(dir, 'out.png');
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    await channel.sendMessage(
      'chat-1',
      `result\n[IMAGE: ${imagePath}]\n\n\`[IMAGE: /tmp/example.png]\``,
    );

    expect(client.sendMessage).toHaveBeenCalledWith('chat-1', {
      msgtype: 'markdown',
      markdown: { content: 'result\n\n`[IMAGE: /tmp/example.png]`' },
    });
    expect(client.uploadMedia).toHaveBeenCalledWith(expect.any(Buffer), {
      type: 'image',
      filename: 'out.png',
    });
    expect(client.sendMediaMessage).toHaveBeenCalledWith(
      'chat-1',
      'image',
      'media-1',
    );
  });

  it('closes unclosed fenced code blocks while leaving media markers as text', async () => {
    const parent = join(tmpdir(), 'channel-files');
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(join(parent, 'wecom-test-'));
    const imagePath = join(dir, 'out.png');
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const text = `debug:\n\`\`\`text\n[IMAGE: ${imagePath}]`;

    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    await channel.sendMessage('chat-1', text);

    expect(client.uploadMedia).not.toHaveBeenCalled();
    expect(client.sendMediaMessage).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledWith('chat-1', {
      msgtype: 'markdown',
      markdown: { content: `${text}\n\`\`\`` },
    });
  });

  it('leaves media markers inside tilde fenced code blocks as text', async () => {
    const parent = join(tmpdir(), 'channel-files');
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(join(parent, 'wecom-test-'));
    const imagePath = join(dir, 'out.png');
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const text = `debug:\n~~~text\n[IMAGE: ${imagePath}]\n~~~`;

    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    await channel.sendMessage('chat-1', text);

    expect(client.uploadMedia).not.toHaveBeenCalled();
    expect(client.sendMediaMessage).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledWith('chat-1', {
      msgtype: 'markdown',
      markdown: { content: text },
    });
  });

  it('leaves media markers inside multi-backtick inline code spans as text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
    const filePath = join(dir, 'secret.txt');
    writeFileSync(filePath, 'secret');
    const text = `debug \`\`[FILE: ${filePath}]\`\``;

    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    await channel.sendMessage('chat-1', text);

    expect(client.uploadMedia).not.toHaveBeenCalled();
    expect(client.sendMediaMessage).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledWith('chat-1', {
      msgtype: 'markdown',
      markdown: { content: text },
    });
  });

  it('splits long markdown responses before sending', async () => {
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    await channel.sendMessage('chat-1', 'a'.repeat(3900));

    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    const first = client.sendMessage.mock.calls[0]?.[1] as unknown as {
      markdown: { content: string };
    };
    const second = client.sendMessage.mock.calls[1]?.[1] as unknown as {
      markdown: { content: string };
    };
    expect(Buffer.byteLength(first.markdown.content, 'utf8')).toBeLessThan(
      4096,
    );
    expect(Buffer.byteLength(second.markdown.content, 'utf8')).toBeLessThan(
      4096,
    );
    expect(first.markdown.content + second.markdown.content).toBe(
      'a'.repeat(3900),
    );
  });

  it('splits long markdown responses without array-copying the remaining line', async () => {
    const arrayFrom = vi.spyOn(Array, 'from');
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();

    await channel.sendMessage('chat-1', 'a'.repeat(3900));

    expect(
      arrayFrom.mock.calls.some(
        ([value]) => typeof value === 'string' && value.length > 100,
      ),
    ).toBe(false);
    arrayFrom.mockRestore();
  });

  it('keeps fenced code blocks balanced across markdown chunks', async () => {
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();
    const text = `intro\n\`\`\`ts\n${'a'.repeat(3900)}\n\`\`\`\noutro`;

    await channel.sendMessage('chat-1', text);

    const chunks = client.sendMessage.mock.calls.map((call) => {
      const message = call[1] as { markdown: { content: string } };
      return message.markdown.content;
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThan(4096);
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(chunks[0]).toMatch(/^intro\n```ts\n/);
    expect(chunks[0]).toMatch(/\n```$/);
    expect(chunks[1]).toMatch(/^```/);
    expect(chunks.at(-1)).toContain('outro');
  });

  it('keeps fenced code blocks balanced when a long line is split', async () => {
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();
    const text = `${'a'.repeat(3790)}\`\`\`${'b'.repeat(100)}\`\`\`outro`;

    await channel.sendMessage('chat-1', text);

    const chunks = client.sendMessage.mock.calls.map((call) => {
      const message = call[1] as { markdown: { content: string } };
      return message.markdown.content;
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(3800);
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(chunks.join('')).toContain('outro');
  });

  it('does not switch fence type when splitting a long fenced line', async () => {
    const parent = join(tmpdir(), 'channel-files');
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(join(parent, 'wecom-test-'));
    const imagePath = join(dir, 'out.png');
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();
    const text = `intro\n\`\`\`text\n${'a'.repeat(3790)}~~~[IMAGE: ${imagePath}]${'b'.repeat(100)}\n\`\`\``;

    await channel.sendMessage('chat-1', text);

    const chunks = client.sendMessage.mock.calls.map((call) => {
      const message = call[1] as { markdown: { content: string } };
      return message.markdown.content;
    });
    expect(client.uploadMedia).not.toHaveBeenCalled();
    expect(client.sendMediaMessage).not.toHaveBeenCalled();
    expect(chunks.length).toBeGreaterThan(1);
    expect((chunks.join('\n').match(/~~~/g) ?? []).length).toBe(1);
    for (const chunk of chunks) {
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  it('resolves relative outbound image paths from channel cwd', async () => {
    const parent = join(tmpdir(), 'channel-files');
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(join(parent, 'wecom-test-'));
    writeFileSync(join(dir, 'out.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const channel = new WeComChannel(
      'bot',
      makeConfig({ cwd: dir }),
      makeBridge(),
    );
    await channel.connect();
    const client = lastClient();

    await channel.sendMessage('chat-1', '[IMAGE: out.png]');

    expect(mocks.open).toHaveBeenCalledWith(
      realpathSync(join(dir, 'out.png')),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const handle = mocks.openHandles.at(-1);
    expect(handle?.stat).toHaveBeenCalled();
    expect(handle?.readFile).toHaveBeenCalled();
    expect(handle?.close).toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(client.uploadMedia).toHaveBeenCalledWith(expect.any(Buffer), {
      type: 'image',
      filename: 'out.png',
    });
    expect(client.sendMediaMessage).toHaveBeenCalledWith(
      'chat-1',
      'image',
      'media-1',
    );
  });

  it('logs and sends later media when one upload returns no media id', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const parent = join(tmpdir(), 'channel-files');
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(join(parent, 'wecom-test-'));
    writeFileSync(
      join(dir, 'first.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    writeFileSync(
      join(dir, 'second.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    const channel = new WeComChannel(
      'bot',
      makeConfig({ cwd: dir }),
      makeBridge(),
    );
    await channel.connect();
    const client = lastClient();
    client.uploadMedia = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ media_id: 'media-2' });

    await channel.sendMessage(
      'chat-1',
      '[IMAGE: first.png]\n[IMAGE: second.png]',
    );

    expect(client.uploadMedia).toHaveBeenCalledTimes(2);
    expect(client.sendMediaMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMediaMessage).toHaveBeenCalledWith(
      'chat-1',
      'image',
      'media-2',
    );
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('upload returned no media_id'),
    );
    stderr.mockRestore();
  });

  it('logs and sends later media when one media send fails', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const parent = join(tmpdir(), 'channel-files');
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(join(parent, 'wecom-test-'));
    writeFileSync(
      join(dir, 'first.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    writeFileSync(
      join(dir, 'second.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    const channel = new WeComChannel(
      'bot',
      makeConfig({ cwd: dir }),
      makeBridge(),
    );
    await channel.connect();
    const client = lastClient();
    client.uploadMedia = vi
      .fn()
      .mockResolvedValueOnce({ media_id: 'media-1' })
      .mockResolvedValueOnce({ media_id: 'media-2' });
    client.sendMediaMessage = vi
      .fn()
      .mockRejectedValueOnce({
        errcode: 45009,
        errmsg: 'api freq out of limit',
      })
      .mockResolvedValueOnce({ headers: { req_id: 'media-req-2' } });

    await channel.sendMessage(
      'chat-1',
      '[IMAGE: first.png]\n[IMAGE: second.png]',
    );

    expect(client.uploadMedia).toHaveBeenCalledTimes(2);
    expect(client.sendMediaMessage).toHaveBeenCalledTimes(2);
    expect(client.sendMediaMessage).toHaveBeenLastCalledWith(
      'chat-1',
      'image',
      'media-2',
    );
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        'media send failed for image: errcode=45009 errmsg=api freq out of limit',
      ),
    );
    expect(stderr).toHaveBeenCalledWith(
      '[WeCom:bot] 1 media send(s) failed (markdown text may already be delivered): image: errcode=45009 errmsg=api freq out of limit\n',
    );
    stderr.mockRestore();
  });

  it('does not upload arbitrary files from non-image media markers', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const dir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
    const filePath = join(dir, 'secret.txt');
    writeFileSync(filePath, 'secret');
    const channel = new WeComChannel(
      'bot',
      makeConfig({ cwd: dir }),
      makeBridge(),
    );
    await channel.connect();
    const client = lastClient();

    await channel.sendMessage('chat-1', `[FILE: ${filePath}]`);

    expect(client.uploadMedia).not.toHaveBeenCalled();
    expect(client.sendMediaMessage).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('skipping unsupported outbound media marker'),
    );
    stderr.mockRestore();
  });

  it('skips model-emitted image paths outside the channel file directory', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const dir = mkdtempSync(join(tmpdir(), 'wecom-cwd-'));
    const secretPath = join(dir, '.env');
    writeFileSync(secretPath, 'OPENAI_API_KEY=sk-secret');
    const channel = new WeComChannel(
      'bot',
      makeConfig({ cwd: dir }),
      makeBridge(),
    );
    await channel.connect();
    const client = lastClient();

    await channel.sendMessage('chat-1', `[IMAGE: ${secretPath}]`);

    expect(client.uploadMedia).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('outside allowed outbound directory'),
    );
    expect(stderr).not.toHaveBeenCalledWith(
      expect.stringContaining(secretPath),
    );
    stderr.mockRestore();
  });

  it('reports unsafe channel file directory setup failures', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const parent = join(tmpdir(), 'channel-files');
    writeFileSync(parent, 'not a directory');
    const dir = mkdtempSync(join(tmpdir(), 'wecom-cwd-'));
    const imagePath = join(dir, 'out.png');
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const channel = new WeComChannel(
      'bot',
      makeConfig({ cwd: dir }),
      makeBridge(),
    );
    await channel.connect();
    const client = lastClient();

    await channel.sendMessage('chat-1', `[IMAGE: ${imagePath}]`);

    expect(client.uploadMedia).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('Cannot prepare outbound media directory'),
    );
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('channel-files'),
    );
    stderr.mockRestore();
  });

  it('does not allow a hardcoded /tmp channel-files fallback', async () => {
    if (tmpdir() === '/tmp') return;

    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const parent = '/tmp/channel-files';
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(join(parent, 'wecom-test-'));
    const imagePath = join(dir, 'out.png');
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    try {
      await channel.sendMessage('chat-1', `[IMAGE: ${imagePath}]`);

      expect(client.uploadMedia).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('outside allowed outbound directory'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      stderr.mockRestore();
    }
  });

  it('registers the wecom plugin with botId and secret fields', () => {
    expect(plugin.channelType).toBe('wecom');
    expect(plugin.requiredConfigFields).toEqual(['botId', 'secret']);
  });
});
