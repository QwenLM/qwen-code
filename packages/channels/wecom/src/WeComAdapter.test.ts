import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ChannelAgentBridge,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';

const mocks = vi.hoisted(() => {
  const instances: MockWSClient[] = [];
  const lookup = vi.fn(async () => [{ address: '203.0.113.10', family: 4 }]);
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

    emit(event: string, payload: unknown): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(payload);
      }
    }
  }

  return { MockWSClient, instances, lookup, state };
});

vi.mock('@wecom/aibot-node-sdk', () => ({
  WSClient: mocks.MockWSClient,
}));
vi.mock('node:dns/promises', () => ({
  lookup: mocks.lookup,
}));

import { WeComChannel, safeRealpath } from './WeComAdapter.js';
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

function lastClient(): MockWSClient {
  const client = mocks.instances.at(-1);
  if (!client) throw new Error('missing mock client');
  return client;
}

describe('WeComChannel', () => {
  beforeEach(() => {
    mocks.instances.length = 0;
    mocks.state.autoAuthenticate = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok')),
    );
    vi.clearAllMocks();
    mocks.lookup.mockResolvedValue([{ address: '203.0.113.10', family: 4 }]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    expect(stderr).toHaveBeenCalledWith('[WeCom:bot] SDK warn event.\n');
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

  it('rejects startup when the SDK disconnects before authentication', async () => {
    mocks.state.autoAuthenticate = false;
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());

    const connecting = channel.connect();
    const client = lastClient();
    client.emit('disconnected', 'auth failed');

    await expect(connecting).rejects.toThrow(
      'WeCom disconnected before authentication',
    );
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    stderr.mockRestore();
  });

  it('clears the active SDK client when the websocket disconnects', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new WeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();

    client.emit('disconnected', 'closed');
    await channel.sendMessage('chat-1', 'hello');

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith('[WeCom:bot] WebSocket closed.\n');
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('No active SDK client'),
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
    client.downloadFile = vi.fn(async (url: string) =>
      url.includes('image')
        ? { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }
        : { buffer: Buffer.from('file-body'), filename: 'downloaded.txt' },
    );

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
    expect(client.downloadFile).toHaveBeenCalledWith(
      'https://example.invalid/image',
      'k1',
    );
    expect(client.downloadFile).toHaveBeenCalledWith(
      'https://example.invalid/file',
      'k2',
    );
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
    expect(existsSync(file.attachments?.[0]?.filePath ?? '')).toBe(false);
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
    expect(fetch).not.toHaveBeenCalled();
    expect(client.downloadFile).not.toHaveBeenCalled();
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
    expect(fetch).not.toHaveBeenCalled();
    expect(client.downloadFile).not.toHaveBeenCalled();
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
    expect(fetch).not.toHaveBeenCalled();
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('unsafe media URL'),
    );
    stderr.mockRestore();
  });

  it('does not follow redirects while probing inbound media', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );
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
    expect(fetch).toHaveBeenCalledWith('https://example.invalid/redirect', {
      method: 'GET',
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    });
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('attachment with redirect'),
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
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, {
        headers: { 'content-length': String(20 * 1024 * 1024 + 1) },
      }),
    );

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
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('skipping oversized image attachment'),
    );
    expect(stderr).not.toHaveBeenCalledWith(
      expect.stringContaining('https://example.invalid/large-image'),
    );
    stderr.mockRestore();
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
      .mockRejectedValueOnce(new Error('network failed'))
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
      expect.stringContaining('media send failed for image'),
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
    stderr.mockRestore();
  });

  it('ignores missing optional media allowlist directories', () => {
    expect(safeRealpath('/definitely/missing/wecom-dir')).toBe(undefined);
  });

  it('registers the wecom plugin with botId and secret fields', () => {
    expect(plugin.channelType).toBe('wecom');
    expect(plugin.requiredConfigFields).toEqual(['botId', 'secret']);
  });
});
