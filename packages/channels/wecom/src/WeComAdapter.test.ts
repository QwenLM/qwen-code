import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ChannelAgentBridge,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';

const mocks = vi.hoisted(() => {
  const instances: MockWSClient[] = [];

  class MockWSClient {
    readonly options: Record<string, unknown>;
    readonly handlers = new Map<string, Array<(payload: unknown) => void>>();
    connect = vi.fn(async () => {});
    disconnect = vi.fn();
    sendMessage = vi.fn(async () => ({ headers: { req_id: 'req-1' } }));
    uploadMedia = vi.fn(async () => ({ media_id: 'media-1' }));
    sendMediaMessage = vi.fn(async () => ({
      headers: { req_id: 'media-req-1' },
    }));
    downloadFile = vi.fn(async () => ({
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

  return { MockWSClient, instances };
});

vi.mock('@wecom/aibot-node-sdk', () => ({
  WSClient: mocks.MockWSClient,
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

  override async handleInbound(envelope: Envelope): Promise<void> {
    this.envelopes.push(envelope);
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
    vi.clearAllMocks();
  });

  it('requires botId and secret', () => {
    expect(
      () => new WeComChannel('bot', makeConfig({ botId: '' }), makeBridge()),
    ).toThrow('requires botId and secret');
    expect(
      () => new WeComChannel('bot', makeConfig({ secret: '' }), makeBridge()),
    ).toThrow('requires botId and secret');
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
      expect.stringContaining('[WeCom:bot] SDK warn: No aesKey provided:'),
    );
    stderr.mockRestore();
  });

  it('normalizes text messages into envelopes', async () => {
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
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
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
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
  });

  it('honors explicit group mention metadata when present', async () => {
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
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

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(2));
    expect(channel.envelopes.map((envelope) => envelope.isMentioned)).toEqual([
      false,
      true,
    ]);
  });

  it('skips inbound attachments that exceed the media size cap', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const channel = new TestWeComChannel('bot', makeConfig(), makeBridge());
    await channel.connect();
    const client = lastClient();
    client.downloadFile = vi.fn(async () => ({
      buffer: Buffer.alloc(20 * 1024 * 1024 + 1),
    }));

    client.emit('message.image', {
      msgid: 'msg-large-image',
      msgtype: 'image',
      chattype: 'single',
      from: { userid: 'alice' },
      image: { url: 'https://example.invalid/large-image', aeskey: 'k1' },
    });

    await vi.waitFor(() => expect(channel.envelopes).toHaveLength(1));
    expect(channel.envelopes[0]?.attachments).toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('skipping oversized attachment'),
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
    const first = client.sendMessage.mock.calls[0]?.[1] as {
      markdown: { content: string };
    };
    const second = client.sendMessage.mock.calls[1]?.[1] as {
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

  it('rejects model-emitted image paths outside the channel file directory', async () => {
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

    await expect(
      channel.sendMessage('chat-1', `[IMAGE: ${secretPath}]`),
    ).rejects.toThrow('outside allowed outbound directory');
    expect(client.uploadMedia).not.toHaveBeenCalled();
  });

  it('ignores missing optional media allowlist directories', () => {
    expect(safeRealpath('/definitely/missing/wecom-dir')).toBe(undefined);
  });

  it('registers the wecom plugin with botId and secret fields', () => {
    expect(plugin.channelType).toBe('wecom');
    expect(plugin.requiredConfigFields).toEqual(['botId', 'secret']);
  });
});
