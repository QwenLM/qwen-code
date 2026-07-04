import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

  const instances: MockWSClient[] = [];
  const httpCalls: MockHttpCall[] = [];
  const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
  const decryptFile = vi.fn((buffer: Buffer, _aesKey: string) => buffer);
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
  };

  class MockWSClient {
    readonly options: Record<string, unknown>;
    readonly handlers = new Map<string, Array<(payload: unknown) => void>>();
    connect = vi.fn(() => {
      if (state.autoAuthenticate) {
        queueMicrotask(() => this.emit('authenticated', {}));
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
    lookup,
    decryptFile,
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
    mocks.state.autoAuthenticate = true;
    mocks.httpResponse.statusCode = 200;
    mocks.httpResponse.headers = {};
    mocks.httpResponse.body = Buffer.from('downloaded');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok')),
    );
    vi.clearAllMocks();
    mocks.decryptFile.mockImplementation((buffer: Buffer) => buffer);
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
      '[WeCom:bot] WebSocket disconnected; reconnecting after server kick.\n',
    );
    channel.disconnect();
    stderr.mockRestore();
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

  it('rolls back message dedup when preflight rejects the envelope', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    client.emit('message.text', payload);
    await vi.waitFor(() => expect(channel.preflights).toHaveBeenCalledTimes(2));
    expect(bridge.newSession).not.toHaveBeenCalled();
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

    await vi.waitFor(() =>
      expect(callback).toHaveBeenCalledWith(expect.any(Error), '', 0),
    );
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

  it('continues sending later media when one upload returns no media id', async () => {
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

  it('continues sending later media when one media send fails', async () => {
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

  it('registers the wecom plugin with botId and secret fields', () => {
    expect(plugin.channelType).toBe('wecom');
    expect(plugin.requiredConfigFields).toEqual(['botId', 'secret']);
  });
});
