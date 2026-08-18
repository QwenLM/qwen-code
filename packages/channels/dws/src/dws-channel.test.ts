/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PairingStore,
  type ChannelAgentBridge,
  type ChannelConfig,
  type Envelope,
} from '@qwen-code/channel-base';
import { DwsChannel } from './dws-channel.js';
import {
  DwsCommandError,
  type DwsClientLike,
  type DwsIdentity,
  type DwsImMessage,
  type DwsImSource,
  type DwsImTarget,
  type DwsTodoTask,
} from './dws-client.js';
import {
  DwsEventProcessError,
  type DwsEventSubscription,
} from './dws-event-stream.js';

function makeConfig(
  overrides: Record<string, unknown> = {},
): ChannelConfig & Record<string, unknown> {
  return {
    type: 'dws',
    token: '',
    senderPolicy: 'open',
    allowedUsers: [],
    sessionScope: 'chat_thread',
    cwd: '/tmp/test',
    groupPolicy: 'open',
    dmPolicy: 'open',
    groups: { '*': {} },
    ...overrides,
  };
}

function makeBridge(): ChannelAgentBridge {
  return {
    newSession: vi.fn().mockResolvedValue('session-1'),
    loadSession: vi.fn(),
    prompt: vi.fn().mockResolvedValue('response'),
    cancelSession: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  } as unknown as ChannelAgentBridge;
}

function message(
  type: DwsImMessage['type'],
  messageId: string,
  content: string,
  overrides: Partial<DwsImMessage> = {},
): DwsImMessage {
  return {
    type,
    eventId: `event-${messageId}`,
    messageId,
    conversationId: 'cid-1',
    content,
    senderId: 'open-alice',
    senderName: 'Alice',
    ...overrides,
  };
}

function documentMentionCard(
  documentId = 'doc-1',
  commentKey = '1786589783750e2a797d2c2c141c295519dbcb07f2274',
): string {
  const query = new URLSearchParams({
    corpId: 'corp-1',
    utm_medium: 'im_card',
    iframeQuery: new URLSearchParams({
      mention_source: '2',
      comment_stid: 'global',
      comment_key: commentKey,
      comment_id: commentKey.slice(13),
      sender_id: '5724713341',
    }).toString(),
    utm_source: 'im',
  });
  const url = `https://alidocs.dingtalk.com/i/nodes/${documentId}?${query}`;
  return [
    'Project plan',
    ' @DataWorksAgent reply with the document code',
    'Alice',
    '  @DataWorksAgent  reply with the document code',
    'View now',
    'DingTalk Docs',
    `[${url}](${url})`,
  ].join('\n');
}

function todoTask(
  taskId: string,
  title: string,
  overrides: Record<string, unknown> = {},
): DwsTodoTask {
  const data = {
    taskId,
    subject: title,
    creatorId: 'alice',
    creatorName: 'Alice',
    priority: 20,
    ...overrides,
  };
  return {
    taskId,
    title,
    creatorId: 'alice',
    creatorName: 'Alice',
    data,
  };
}

class FakeSubscription implements DwsEventSubscription {
  readonly stop = vi.fn(() => this.close());
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;

  constructor() {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  close(): void {
    this.resolveClosed();
  }
}

interface FakeStream {
  source: DwsImSource;
  onMessage: (message: DwsImMessage) => void | Promise<void>;
  onError: (error: Error) => void;
  subscription: FakeSubscription;
}

class FakeDwsClient implements DwsClientLike {
  identity: DwsIdentity = {
    profile: 'corp:user-self',
    selfSenderIds: ['open-self'],
  };
  streams: FakeStream[] = [];
  directMessages: DwsImMessage[] = [];
  mentionedMessages: DwsImMessage[] = [];
  todoTasks: DwsTodoTask[] = [];
  assertAuthenticated = vi.fn(async () => Promise.resolve(this.identity));
  sendImMessage = vi
    .fn<(target: DwsImTarget, content: string, key: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  replyToImMessage = vi
    .fn<
      (
        conversationId: string,
        messageId: string,
        senderId: string,
        content: string,
        key: string,
      ) => Promise<void>
    >()
    .mockResolvedValue(undefined);
  addImReaction = vi.fn().mockResolvedValue(undefined);
  removeImReaction = vi.fn().mockResolvedValue(undefined);
  listDirectMessages = vi.fn(
    async (_startTime: number, _endTime: number, _signal?: AbortSignal) =>
      Promise.resolve({ messages: this.directMessages }),
  );
  listMentionedMessages = vi.fn(
    async (_startTime: number, _endTime: number, _signal?: AbortSignal) =>
      Promise.resolve({ messages: this.mentionedMessages }),
  );
  readDocument = vi.fn(async (_documentId: string, _signal?: AbortSignal) =>
    Promise.resolve('# Plan\nUse DWS.'),
  );
  replyToComment = vi.fn().mockResolvedValue(undefined);
  listTodoTasks = vi.fn(async (_signal?: AbortSignal) =>
    Promise.resolve(this.todoTasks),
  );
  getTodoTask = vi.fn(async (taskId: string, _signal?: AbortSignal) => {
    const task = this.todoTasks.find(
      (candidate) => candidate.taskId === taskId,
    );
    if (!task) throw new Error(`Missing fake todo ${taskId}.`);
    return Promise.resolve(task);
  });
  addTodoComment = vi.fn().mockResolvedValue(undefined);

  async subscribeToIm(
    source: DwsImSource,
    onMessage: (message: DwsImMessage) => void | Promise<void>,
    onError: (error: Error) => void,
  ): Promise<DwsEventSubscription> {
    const subscription = new FakeSubscription();
    this.streams.push({ source, onMessage, onError, subscription });
    return subscription;
  }

  async emit(sourceIndex: number, event: DwsImMessage): Promise<void> {
    const stream = this.streams[sourceIndex];
    if (!stream) throw new Error(`Missing fake stream ${sourceIndex}.`);
    await stream.onMessage(event);
  }
}

class TestableDwsChannel extends DwsChannel {
  inbound: Envelope[] = [];
  inboundError?: Error;
  inboundHandler?: (envelope: Envelope) => Promise<void>;
  responseMessageId?: string;
  responseSenderId?: string;
  responseThreadId?: string;

  protected override startPollLoop(): void {}

  protected override get todoPollInterval(): number {
    return 0;
  }

  override async handleInbound(envelope: Envelope): Promise<void> {
    if (this.inboundError) throw this.inboundError;
    if (this.inboundHandler) return this.inboundHandler(envelope);
    this.inbound.push(envelope);
  }

  protected override getResponseMessageId(): string | undefined {
    return this.responseMessageId;
  }

  protected override getResponseSenderId(): string | undefined {
    return this.responseSenderId;
  }

  protected override getResponseThreadId(): string | undefined {
    return this.responseThreadId;
  }

  async poll(): Promise<void> {
    await this.pollOnce();
  }

  async respond(chatId: string, text: string): Promise<void> {
    await this.sendResponseMessage(chatId, text, 'session-1');
  }

  async sendThread(
    chatId: string,
    threadId: string,
    text: string,
  ): Promise<void> {
    await this.sendThreadMessage(chatId, threadId, text);
  }

  instructions(): string | undefined {
    return this.config.instructions;
  }

  approvalMode(): string | undefined {
    return this.config.approvalMode;
  }

  notificationWatermark(): number | undefined {
    return this.cursor.notificationWatermark;
  }

  notificationCheckpoint(): unknown {
    return this.cursor.notificationCheckpoint;
  }

  mentionCheckpoint(): unknown {
    return this.cursor.mentionCheckpoint;
  }

  mentionWatermark(): number | undefined {
    return this.cursor.mentionWatermark;
  }

  resolveSession(): Promise<string> {
    return this.router.resolve(this.name, 'alice', 'doc-1', 'comment-1');
  }

  resolveImSession(): Promise<string> {
    return this.router.resolve(this.name, 'alice', 'cid-1');
  }

  seedLegacyDirectTarget(profile: string): void {
    this.cursor.selfProfile = profile;
    this.cursor.selfSenderIds = [];
    this.cursor.imTargets = [
      {
        conversationId: 'cid-1',
        target: { kind: 'direct', openDingTalkId: 'open-operator' },
      },
    ];
    this.saveCursor();
  }
}

class PolicyDwsChannel extends DwsChannel {
  protected override startPollLoop(): void {}

  protected override get todoPollInterval(): number {
    return 0;
  }

  async poll(): Promise<void> {
    await this.pollOnce();
  }
}

let qwenHome: string;
let previousQwenHome: string | undefined;
const channels: DwsChannel[] = [];

beforeEach(() => {
  previousQwenHome = process.env['QWEN_HOME'];
  qwenHome = mkdtempSync(join(tmpdir(), 'qwen-dws-channel-'));
  process.env['QWEN_HOME'] = qwenHome;
});

afterEach(() => {
  for (const channel of channels.splice(0)) channel.disconnect();
  if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
  else process.env['QWEN_HOME'] = previousQwenHome;
  rmSync(qwenHome, { recursive: true, force: true });
});

async function readyChannel(
  client: FakeDwsClient,
  config = makeConfig(),
  name = 'test-dws',
): Promise<TestableDwsChannel> {
  const channel = new TestableDwsChannel(
    name,
    config,
    makeBridge(),
    undefined,
    client,
  );
  channels.push(channel);
  await channel.connect();
  return channel;
}

async function readyPolicyChannel(
  client: FakeDwsClient,
  config = makeConfig(),
  name = 'policy-dws',
): Promise<{ channel: PolicyDwsChannel; bridge: ChannelAgentBridge }> {
  const bridge = makeBridge();
  const channel = new PolicyDwsChannel(name, config, bridge, undefined, client);
  channels.push(channel);
  await channel.connect();
  return { channel, bridge };
}

describe('DwsChannel', () => {
  it('reprocesses document notifications after a DWS profile switch', async () => {
    const name = 'profile-scoped-notification-dws';
    const card = documentMentionCard('doc-shared', 'comment-shared');
    const firstClient = new FakeDwsClient();
    firstClient.identity = {
      profile: 'corp-one',
      selfSenderIds: ['open-account-one'],
    };
    const first = await readyChannel(firstClient, makeConfig(), name);
    firstClient.directMessages = [
      message('user_im_message_receive_o2o_all', 'notification-one', card),
    ];
    await first.poll();
    expect(first.inbound).toHaveLength(1);
    first.disconnect();

    const secondClient = new FakeDwsClient();
    secondClient.identity = {
      profile: 'corp-two',
      selfSenderIds: ['open-account-two'],
    };
    const second = await readyChannel(secondClient, makeConfig(), name);
    secondClient.directMessages = [
      message('user_im_message_receive_o2o_all', 'notification-two', card),
    ];

    await second.poll();

    expect(second.inbound).toHaveLength(1);
  });

  it('starts @ and all direct messages while ignoring legacy source settings', async () => {
    const client = new FakeDwsClient();

    await readyChannel(
      client,
      makeConfig({
        disableAtMessages: true,
        imUserIds: ['user-2'],
        imGroupIds: ['cid-legacy'],
      }),
    );

    expect(client.assertAuthenticated).toHaveBeenCalledOnce();
    expect(client.streams.map((item) => item.source)).toEqual([
      { kind: 'at' },
      { kind: 'direct' },
    ]);
  });

  it('subscribes to all groups when wildcard mention gating is disabled', async () => {
    const client = new FakeDwsClient();

    await readyChannel(
      client,
      makeConfig({
        groups: {
          '*': { requireMention: false },
          'cid-mentioned': { requireMention: true },
          'cid-ambient': { requireMention: false },
        },
      }),
    );

    expect(client.streams.map((item) => item.source)).toEqual([
      { kind: 'at' },
      { kind: 'group-all' },
      { kind: 'direct' },
    ]);
  });

  it('subscribes only to explicit ambient groups in allowlist mode', async () => {
    const client = new FakeDwsClient();

    await readyChannel(
      client,
      makeConfig({
        groupPolicy: 'allowlist',
        groups: {
          '*': { requireMention: false },
          'cid-ambient': { requireMention: false },
        },
      }),
    );

    expect(client.streams.map((item) => item.source)).toEqual([
      { kind: 'at' },
      { kind: 'group', conversationId: 'cid-ambient' },
      { kind: 'direct' },
    ]);
  });

  it('starts direct messages without querying account identity metadata', async () => {
    const client = new FakeDwsClient();

    await expect(readyChannel(client, makeConfig())).resolves.toBeDefined();
    expect(client.streams.map((item) => item.source)).toEqual([
      { kind: 'at' },
      { kind: 'direct' },
    ]);
  });

  it('requires authoritative self sender metadata for direct messages', async () => {
    const client = new FakeDwsClient();
    client.identity = { profile: 'corp-only' };

    await expect(readyChannel(client, makeConfig())).rejects.toThrow(
      'DWS direct messages require the authenticated identity to expose an openDingTalkId.',
    );
    expect(client.streams).toEqual([]);
  });

  it('preserves self sender history across degraded group reconnects', async () => {
    const config = makeConfig({
      dmPolicy: 'disabled',
      groups: { '*': { requireMention: false } },
    });
    const name = 'degraded-self-id-dws';
    const firstClient = new FakeDwsClient();
    firstClient.identity = {
      profile: 'corp:bot',
      selfSenderIds: ['open-self-old'],
    };
    const first = await readyChannel(firstClient, config, name);
    first.disconnect();

    const secondClient = new FakeDwsClient();
    secondClient.identity = { profile: 'corp:bot' };
    const second = await readyChannel(secondClient, config, name);
    await secondClient.emit(
      1,
      message(
        'user_im_message_receive_group_all',
        'degraded-self-1',
        'own echo',
        {
          senderId: 'open-self-old',
        },
      ),
    );
    expect(second.inbound).toEqual([]);
    second.disconnect();

    const thirdClient = new FakeDwsClient();
    thirdClient.identity = { profile: 'corp:bot' };
    const third = await readyChannel(thirdClient, config, name);
    await thirdClient.emit(
      1,
      message(
        'user_im_message_receive_group_all',
        'degraded-self-2',
        'own echo',
        {
          senderId: 'open-self-old',
        },
      ),
    );
    expect(third.inbound).toEqual([]);
  });

  it('retains rotated self sender IDs within the same profile', async () => {
    const config = makeConfig({
      dmPolicy: 'disabled',
      groups: { '*': { requireMention: false } },
    });
    const name = 'rotated-self-id-dws';
    const firstClient = new FakeDwsClient();
    firstClient.identity = {
      profile: 'corp:bot',
      selfSenderIds: ['open-self-a'],
    };
    const first = await readyChannel(firstClient, config, name);
    first.disconnect();

    const secondClient = new FakeDwsClient();
    secondClient.identity = {
      profile: 'corp:bot',
      selfSenderIds: ['open-self-b'],
    };
    const second = await readyChannel(secondClient, config, name);
    await secondClient.emit(
      1,
      message(
        'user_im_message_receive_group_all',
        'rotated-self-a',
        'old echo',
        {
          senderId: 'open-self-a',
        },
      ),
    );
    await secondClient.emit(
      1,
      message(
        'user_im_message_receive_group_all',
        'rotated-self-b',
        'new echo',
        {
          senderId: 'open-self-b',
        },
      ),
    );
    expect(second.inbound).toEqual([]);
  });

  it('drops self sender history after a profile switch', async () => {
    const config = makeConfig({
      dmPolicy: 'disabled',
      groups: { '*': { requireMention: false } },
    });
    const name = 'profile-self-id-dws';
    const firstClient = new FakeDwsClient();
    firstClient.identity = {
      profile: 'corp:one',
      selfSenderIds: ['open-self-a'],
    };
    const first = await readyChannel(firstClient, config, name);
    first.disconnect();

    const secondClient = new FakeDwsClient();
    secondClient.identity = {
      profile: 'corp:two',
      selfSenderIds: ['open-self-b'],
    };
    const second = await readyChannel(secondClient, config, name);
    await secondClient.emit(
      1,
      message(
        'user_im_message_receive_group_all',
        'old-profile-sender',
        'peer text',
        {
          senderId: 'open-self-a',
        },
      ),
    );
    expect(second.inbound.map((item) => item.text)).toEqual(['peer text']);
  });

  it('drops unverified direct targets after self identity becomes authoritative', async () => {
    const name = 'legacy-direct-target-dws';
    const client = new FakeDwsClient();
    client.identity = {
      profile: 'corp:user-self',
      selfSenderIds: ['open-self'],
    };
    const channel = new TestableDwsChannel(
      name,
      makeConfig(),
      makeBridge(),
      undefined,
      client,
    );
    channels.push(channel);
    channel.seedLegacyDirectTarget(client.identity.profile!);

    await channel.connect();

    await expect(channel.sendMessage('cid-1', 'hello')).rejects.toThrow(
      'no DWS message target is known',
    );
  });

  it('starts ambient groups without querying account identity metadata', async () => {
    const client = new FakeDwsClient();
    client.identity = { profile: 'corp-only' };

    await expect(
      readyChannel(
        client,
        makeConfig({
          dmPolicy: 'disabled',
          groups: { 'cid-ambient': { requireMention: false } },
        }),
      ),
    ).resolves.toBeDefined();
    expect(client.streams.map((item) => item.source)).toEqual([
      { kind: 'at' },
      { kind: 'group', conversationId: 'cid-ambient' },
    ]);
  });

  it('cancels a connection that finishes authenticating after disconnect', async () => {
    const client = new FakeDwsClient();
    let resolveIdentity!: (identity: DwsIdentity) => void;
    client.assertAuthenticated.mockImplementation(
      async () =>
        new Promise<DwsIdentity>((resolve) => {
          resolveIdentity = resolve;
        }),
    );
    const channel = new TestableDwsChannel(
      'cancelled-dws',
      makeConfig(),
      makeBridge(),
      undefined,
      client,
    );
    channels.push(channel);

    const connecting = channel.connect();
    await Promise.resolve();
    channel.disconnect();
    resolveIdentity(client.identity);

    await expect(connecting).rejects.toThrow('connection was cancelled');
    expect(client.streams).toHaveLength(0);
  });

  it('defaults new sessions to the default approval mode', async () => {
    const client = new FakeDwsClient();
    const bridge = makeBridge();
    const channel = new TestableDwsChannel(
      'test-dws',
      makeConfig(),
      bridge,
      undefined,
      client,
    );
    channels.push(channel);
    await channel.connect();
    await channel.resolveSession();

    expect(channel.approvalMode()).toBe('default');
    expect(bridge.newSession).toHaveBeenCalledWith(
      '/tmp/test',
      { approvalMode: 'default', sourceId: 'test-dws' },
      expect.any(Object),
    );
  });

  it('rejects unsupported approval modes', () => {
    expect(
      () =>
        new TestableDwsChannel(
          'auto-dws',
          makeConfig({ approvalMode: 'auto' }),
          makeBridge(),
          undefined,
          new FakeDwsClient(),
        ),
    ).toThrow('require approvalMode');
  });

  it('propagates yolo approval mode to sessions', async () => {
    const client = new FakeDwsClient();
    const bridge = makeBridge();
    const channel = new TestableDwsChannel(
      'yolo-dws',
      makeConfig({ approvalMode: 'yolo' }),
      bridge,
      undefined,
      client,
    );
    channels.push(channel);
    await channel.connect();
    await channel.resolveImSession();

    expect(channel.approvalMode()).toBe('yolo');
    expect(bridge.newSession).toHaveBeenCalledWith(
      '/tmp/test',
      { approvalMode: 'yolo', sourceId: 'yolo-dws' },
      expect.any(Object),
    );
  });

  it('gives workspace actions the pinned DWS profile', async () => {
    const client = new FakeDwsClient();
    client.identity.profile = 'corp:user';
    const channel = await readyChannel(
      client,
      makeConfig({ profile: 'corp:user' }),
    );

    expect(channel.instructions()).toContain(
      'invoke dws --profile "corp:user"',
    );
  });

  it('restarts an event source after its consumer closes unexpectedly', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeDwsClient();
      await readyChannel(client);

      client.streams[0]?.subscription.close();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(client.streams).toHaveLength(3);
      expect(client.streams[2]?.source).toEqual({ kind: 'at' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a retryable initial event subscription before failing startup', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeDwsClient();
      vi.spyOn(client, 'subscribeToIm').mockRejectedValueOnce(
        new DwsEventProcessError('try again', true),
      );

      const connecting = readyChannel(client);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(connecting).resolves.toBeInstanceOf(DwsChannel);

      expect(client.subscribeToIm).toHaveBeenCalledTimes(3);
      expect(client.streams.map((item) => item.source)).toEqual([
        { kind: 'direct' },
        { kind: 'at' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps retryable initial event subscription delay', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeDwsClient();
      vi.spyOn(client, 'subscribeToIm').mockRejectedValueOnce(
        new DwsEventProcessError('try much later', true, 7 * 24 * 60 * 60_000),
      );

      const connecting = readyChannel(client);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await expect(connecting).resolves.toBeInstanceOf(DwsChannel);

      expect(client.subscribeToIm).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets restart allowance when a replacement stream becomes ready', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeDwsClient();
      await readyChannel(client);

      client.streams[0]?.subscription.close();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      client.streams[2]?.subscription.close();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(client.streams[3]?.source).toEqual({ kind: 'at' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps retrying after the replacement retry budget is exhausted', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeDwsClient();
      await readyChannel(client);
      const subscribe = vi
        .spyOn(client, 'subscribeToIm')
        .mockRejectedValueOnce(new DwsEventProcessError('retry one', true))
        .mockRejectedValueOnce(new DwsEventProcessError('retry two', true))
        .mockRejectedValueOnce(new DwsEventProcessError('retry three', true));

      client.streams[0]?.subscription.close();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(subscribe).toHaveBeenCalledTimes(4);
      expect(client.streams[2]?.source).toEqual({ kind: 'at' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispatches an @ message and remembers its group delivery target', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);

    await client.emit(
      0,
      message('user_im_message_receive_at', 'message-1', 'please help', {
        referencedText: 'Qwen Code is slow after connecting over SSH.',
      }),
    );
    await channel.sendMessage('cid-1', 'done');

    expect(channel.inbound).toEqual([
      expect.objectContaining({
        chatId: 'cid-1',
        messageId: 'message-1',
        senderId: 'open-alice',
        text: 'please help',
        isGroup: true,
        isMentioned: true,
        isReplyToBot: false,
        referencedText: 'Qwen Code is slow after connecting over SSH.',
      }),
    ]);
    expect(client.sendImMessage).toHaveBeenCalledWith(
      { kind: 'group', conversationId: 'cid-1' },
      'done',
      expect.any(String),
    );
  });

  it('adds live quoted text to the agent prompt as reply context', async () => {
    const client = new FakeDwsClient();
    const { bridge } = await readyPolicyChannel(client);

    await client.emit(
      0,
      message('user_im_message_receive_at', 'quoted-message', 'please help', {
        referencedText: 'Qwen Code is slow after connecting over SSH.',
      }),
    );

    expect(bridge.prompt).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining(
        '[Replying to: "Qwen Code is slow after connecting over SSH."]',
      ),
      expect.any(Object),
    );
  });

  it('does not create pairing requests from historical replayed events', async () => {
    const client = new FakeDwsClient();
    const { bridge } = await readyPolicyChannel(client);

    await client.emit(1, {
      type: 'user_im_message_receive_o2o_all',
      eventId: 'old-event',
      messageId: 'old-message',
      conversationId: 'old-conversation',
      content: 'old message',
      senderId: 'open-old-sender',
      senderName: 'Old sender',
      eventTime: Date.now() - 60_000,
    });

    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(client.sendImMessage).not.toHaveBeenCalled();
  });

  it('lets polling recover a stale replayed document notification', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const replay = message(
      'user_im_message_receive_o2o_all',
      'replayed-document',
      documentMentionCard('doc-replayed', 'comment-replayed'),
      { eventTime: Date.now() - 60_000 },
    );
    client.directMessages = [replay];

    await client.emit(1, replay);
    await channel.poll();

    expect(channel.inbound).toEqual([
      expect.objectContaining({
        chatId: 'doc-replayed',
        threadId: 'comment-replayed',
      }),
    ]);
  });

  it('accepts ordinary direct messages and replies to that user', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);

    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'message-1', 'check my todo'),
    );
    await channel.sendMessage('cid-1', 'done');

    expect(channel.inbound[0]).toMatchObject({
      text: 'check my todo',
      isGroup: false,
      isMentioned: false,
    });
    expect(client.sendImMessage).toHaveBeenCalledWith(
      { kind: 'direct', openDingTalkId: 'open-alice' },
      'done',
      expect.any(String),
    );
  });

  it('turns a document mention notification into a document task and replies to its comment', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const commentKey = '1786589783750e2a797d2c2c141c295519dbcb07f2274';

    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'notification-1',
        documentMentionCard('doc-1', commentKey),
      ),
    );

    expect(channel.inbound).toEqual([
      expect.objectContaining({
        chatId: 'doc-1',
        threadId: commentKey,
        messageId: 'notification-1',
        senderId: 'open-alice',
        text: expect.stringContaining('reply with the document code'),
        isMentioned: true,
      }),
    ]);
    expect(client.readDocument).toHaveBeenCalledWith(
      'doc-1',
      expect.any(AbortSignal),
    );

    channel.responseThreadId = commentKey;
    await channel.respond('doc-1', 'the code is 42');
    expect(client.replyToComment).toHaveBeenCalledWith(
      'doc-1',
      commentKey,
      'the code is 42',
    );
  });

  it('extracts a document request when CJK text precedes the mention', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const url = documentMentionCard('doc-1', 'comment-1').match(
      /https:\/\/alidocs\.dingtalk\.com\/i\/nodes\/[^\]]+/u,
    )?.[0];
    expect(url).toBeDefined();

    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'notification-cjk-prefix',
        `${url}\n麻烦@DataWorksAgent 把表格汇总一下`,
      ),
    );

    expect(channel.inbound).toEqual([
      expect.objectContaining({
        chatId: 'doc-1',
        threadId: 'comment-1',
        text: expect.stringContaining('把表格汇总一下'),
      }),
    ]);
  });

  it('rejects a decoded document id that collides with the todo namespace', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const url =
      'https://alidocs.dingtalk.com/i/nodes/todo%3Atask-9?' +
      'iframeQuery=mention_source%3D2%26comment_key%3Dcomment-1';

    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'notification-doc-todo-collision',
        `${url}\n@DataWorksAgent summarize this thread`,
      ),
    );

    expect(channel.inbound).toEqual([
      expect.objectContaining({ chatId: 'cid-1' }),
    ]);
    expect(channel.inbound[0]).not.toHaveProperty('threadId');
  });

  it('restores document reply routing across a cold restart', async () => {
    const name = 'persistent-document-route';
    const firstClient = new FakeDwsClient();
    const first = await readyChannel(firstClient, makeConfig(), name);
    await firstClient.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'notification-persist-document',
        documentMentionCard('doc-restart', 'comment-restart'),
      ),
    );
    expect(first.inbound).toHaveLength(1);
    first.disconnect();

    const secondClient = new FakeDwsClient();
    const second = await readyChannel(secondClient, makeConfig(), name);
    second.responseThreadId = 'comment-restart';
    await second.respond('doc-restart', 'response after restart');
    await second.sendThread(
      'doc-restart',
      'comment-restart',
      'thread after restart',
    );

    expect(secondClient.replyToComment).toHaveBeenNthCalledWith(
      1,
      'doc-restart',
      'comment-restart',
      'response after restart',
    );
    expect(secondClient.replyToComment).toHaveBeenNthCalledWith(
      2,
      'doc-restart',
      'comment-restart',
      'thread after restart',
    );
  });

  it('does not guess a document route after a bare URL suffix', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const card = documentMentionCard('doc-1', 'comment-1').replace(
      /\[(https:[^\]]+)\]\([^)]+\)/u,
      '$1，尽快',
    );

    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'notification-1', card),
    );

    expect(channel.inbound).toEqual([
      expect.objectContaining({ chatId: 'cid-1' }),
    ]);
    expect(channel.inbound[0]).not.toHaveProperty('threadId');
  });

  it.each([',', '.', ';', '!', '?', '…', '~'])(
    'does not guess a document route after a bare URL followed by %s',
    async (punctuation) => {
      const client = new FakeDwsClient();
      const channel = await readyChannel(client);
      const url = documentMentionCard('doc-1', 'comment-1').match(
        /https:\/\/alidocs\.dingtalk\.com\/i\/nodes\/[^\]]+/u,
      )?.[0];
      expect(url).toBeDefined();

      await client.emit(
        1,
        message(
          'user_im_message_receive_o2o_all',
          `notification-${punctuation}`,
          `@DataWorksAgent reply with the document code\n${url}${punctuation} thanks`,
        ),
      );

      expect(channel.inbound).toEqual([
        expect.objectContaining({ chatId: 'cid-1' }),
      ]);
      expect(channel.inbound[0]).not.toHaveProperty('threadId');
    },
  );

  it.each(['-', '_', '='])(
    'preserves a trailing %s in a document comment key',
    async (suffix) => {
      const client = new FakeDwsClient();
      const channel = await readyChannel(client);
      const commentKey = `comment${suffix}`;
      const url =
        'https://alidocs.dingtalk.com/i/nodes/doc-1?' +
        `iframeQuery=mention_source%3D2%26comment_key%3D${commentKey}`;

      await client.emit(
        1,
        message(
          'user_im_message_receive_o2o_all',
          `notification-${suffix}`,
          `${url}\n@DataWorksAgent summarize this thread`,
        ),
      );

      expect(channel.inbound).toEqual([
        expect.objectContaining({ threadId: commentKey }),
      ]);
    },
  );

  it.each([',', '.', '!', '?'])(
    'does not route a document reply when trailing %s corrupts the final comment key',
    async (punctuation) => {
      const client = new FakeDwsClient();
      const channel = await readyChannel(client);
      const url =
        'https://alidocs.dingtalk.com/i/nodes/doc-1?' +
        'iframeQuery=mention_source%3D2%26comment_key%3Dcomment-1';

      await client.emit(
        1,
        message(
          'user_im_message_receive_o2o_all',
          `notification-${punctuation}`,
          `${url}${punctuation} summarize this thread`,
        ),
      );

      expect(channel.inbound).toHaveLength(1);
      expect(channel.inbound[0]).toMatchObject({ chatId: 'cid-1' });
      expect(channel.inbound[0]).not.toHaveProperty('threadId');
    },
  );

  it.each(['。', '，', '请'])(
    'does not guess a bare document route before a non-ASCII %s suffix',
    async (suffix) => {
      const client = new FakeDwsClient();
      const channel = await readyChannel(client);
      const url =
        'https://alidocs.dingtalk.com/i/nodes/doc-1?' +
        'iframeQuery=comment_key%3Dcomment-1%26mention_source%3D2';

      await client.emit(
        1,
        message(
          'user_im_message_receive_o2o_all',
          `notification-unicode-${suffix}`,
          `${url}${suffix}\n@DataWorksAgent summarize this thread`,
        ),
      );

      expect(channel.inbound).toEqual([
        expect.objectContaining({
          chatId: 'cid-1',
          text: expect.stringContaining('summarize this thread'),
        }),
      ]);
      expect(channel.inbound[0]).not.toHaveProperty('threadId');
    },
  );

  it.each([
    ['@DataWorksAgent，请总结这个评论的上下文', '请总结这个评论的上下文'],
    ['@DataWorksAgent请总结这个评论的上下文', '请总结这个评论的上下文'],
    ['please @DataWorksAgent summarize this thread', 'summarize this thread'],
    [
      '@Data Works Agent (bot-id) summarize this thread',
      'summarize this thread',
    ],
    ['@DataWorksAgent\nsummarize this thread', 'summarize this thread'],
  ])('extracts document request from %s', async (mention, request) => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const url = documentMentionCard('doc-1', 'comment-1').match(
      /https:\/\/alidocs\.dingtalk\.com\/i\/nodes\/[^\]]+/u,
    )?.[0];
    expect(url).toBeDefined();

    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        `notification-${request}`,
        `${url}\n${mention}`,
      ),
    );

    expect(channel.inbound).toEqual([
      expect.objectContaining({ text: expect.stringContaining(request) }),
    ]);
  });

  it.each([
    [
      'a non-ASCII account name without a separator',
      '@数据助手请总结这个评论的上下文',
    ],
    [
      'a parenthetical request',
      '@DataWorksAgent summarize this doc (focus on section 2)',
    ],
    ['a dotted account handle', '@Qwen.Code summarize the doc'],
  ])(
    'preserves document request text for %s',
    async (_description, mention) => {
      const client = new FakeDwsClient();
      const channel = await readyChannel(client);
      const url = documentMentionCard('doc-1', 'comment-1').match(
        /https:\/\/alidocs\.dingtalk\.com\/i\/nodes\/[^\]]+/u,
      )?.[0];
      expect(url).toBeDefined();

      await client.emit(
        1,
        message(
          'user_im_message_receive_o2o_all',
          `notification-${_description}`,
          `${url}\n${mention}`,
        ),
      );

      expect(channel.inbound).toEqual([
        expect.objectContaining({
          chatId: 'doc-1',
          threadId: 'comment-1',
          text: expect.stringContaining(mention),
        }),
      ]);
    },
  );

  it('preserves a document request at the end of the comment budget', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const url = documentMentionCard('doc-1', 'comment-1').match(
      /https:\/\/alidocs\.dingtalk\.com\/i\/nodes\/[^\]]+/u,
    )?.[0];
    const request = '@DataWorksAgent summarize the tail';
    expect(url).toBeDefined();

    const padding = 'x'.repeat(4_000 - url!.length - request.length - 2);
    const content = `${url}\n${padding}\n${request}`;
    expect(content).toHaveLength(4_000);

    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'notification-comment-budget',
        content,
      ),
    );

    expect(channel.inbound).toEqual([
      expect.objectContaining({
        chatId: 'doc-1',
        threadId: 'comment-1',
        text: expect.stringContaining(request),
      }),
    ]);
  });

  it.each([
    '@王五 你确认下数据\n@DataWorksAgent 总结文档',
    'CC @李四\n@DataWorksAgent 总结文档',
    '说的对不对 @王五\n@DataWorksAgent 总结文档',
    '@王五 CC @李四',
  ])(
    'does not guess an account request when document notification mentions are ambiguous',
    async (mention) => {
      const client = new FakeDwsClient();
      const channel = await readyChannel(client);
      const url = documentMentionCard('doc-1', 'comment-1').match(
        /https:\/\/alidocs\.dingtalk\.com\/i\/nodes\/[^\]]+/u,
      )?.[0];
      expect(url).toBeDefined();

      await client.emit(
        1,
        message(
          'user_im_message_receive_o2o_all',
          `notification-${mention}`,
          `${url}\n${mention}`,
        ),
      );

      expect(channel.inbound).toEqual([
        expect.objectContaining({
          chatId: 'cid-1',
          text: expect.stringContaining(mention),
        }),
      ]);
      expect(channel.inbound[0]).not.toHaveProperty('threadId');
    },
  );

  it('does not pair request text from another document link with a validated comment', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const firstUrl = documentMentionCard('doc-a', 'comment-a')
      .match(/https:\/\/alidocs\.dingtalk\.com\/i\/nodes\/[^\]]+/u)?.[0]
      ?.replace('mention_source%3D2', 'mention_source%3D1');
    const secondUrl = documentMentionCard('doc-b', 'comment-b').match(
      /https:\/\/alidocs\.dingtalk\.com\/i\/nodes\/[^\]]+/u,
    )?.[0];
    expect(firstUrl).toBeDefined();
    expect(secondUrl).toBeDefined();

    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'notification-two-links',
        `@DataWorksAgent summarize the first link\n${firstUrl}\n${secondUrl}`,
      ),
    );

    expect(channel.inbound).toEqual([
      expect.objectContaining({
        chatId: 'cid-1',
        text: expect.stringContaining('summarize the first link'),
      }),
    ]);
    expect(channel.inbound[0]).not.toHaveProperty('threadId');
  });

  it('does not parse an email address as a document request mention', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const url = documentMentionCard('doc-1', 'comment-1').match(
      /https:\/\/alidocs\.dingtalk\.com\/i\/nodes\/[^\]]+/u,
    )?.[0];
    expect(url).toBeDefined();

    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'notification-email',
        `${url}\nContact alice@example.com for details`,
      ),
    );

    expect(channel.inbound).toEqual([
      expect.objectContaining({
        text: 'Review the referenced DingTalk document comment and respond.',
      }),
    ]);
  });

  it('does not guess a document request when a later cc mention follows', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const url = documentMentionCard('doc-1', 'comment-1').match(
      /https:\/\/alidocs\.dingtalk\.com\/i\/nodes\/[^\]]+/u,
    )?.[0];
    expect(url).toBeDefined();

    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'notification-cc',
        `${url}\n@DataWorksAgent summarize this thread\ncc @Alice for visibility`,
      ),
    );

    expect(channel.inbound).toEqual([
      expect.objectContaining({
        chatId: 'cid-1',
        text: expect.stringContaining('summarize this thread'),
      }),
    ]);
    expect(channel.inbound[0]).not.toHaveProperty('threadId');
  });

  it('finds document mention notifications in direct-message history when the event stream misses them', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const commentKey = '1786589783750e2a797d2c2c141c295519dbcb07f2274';
    client.directMessages = [
      message(
        'user_im_message_receive_o2o_all',
        'history-notification',
        documentMentionCard('doc-history', commentKey),
        { eventTime: Date.now() },
      ),
    ];

    await channel.poll();

    expect(client.listDirectMessages).toHaveBeenCalledOnce();
    expect(channel.inbound).toEqual([
      expect.objectContaining({
        chatId: 'doc-history',
        threadId: commentKey,
        text: expect.stringContaining('reply with the document code'),
      }),
    ]);
  });

  it('dispatches a group mention when the event stream misses it', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    client.mentionedMessages = [
      message('user_im_message_receive_at', 'history-mention', '@QwenBot hi', {
        conversationId: 'external-group',
        eventTime: Date.now(),
        referencedText: 'Qwen Code is slow after connecting over SSH.',
      }),
    ];

    await channel.poll();

    expect(channel.inbound).toEqual([
      expect.objectContaining({
        chatId: 'external-group',
        messageId: 'history-mention',
        text: '@QwenBot hi',
        isGroup: true,
        isMentioned: true,
        referencedText: 'Qwen Code is slow after connecting over SSH.',
      }),
    ]);
  });

  it('deduplicates a mention delivered by history and the live stream', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const mention = message(
      'user_im_message_receive_at',
      'history-and-live',
      '@QwenBot hi',
      { eventTime: Date.now() },
    );
    client.mentionedMessages = [mention];

    await channel.poll();
    await client.emit(0, mention);

    expect(channel.inbound).toHaveLength(1);
  });

  it('starts group pairing for a mention recovered from history', async () => {
    const client = new FakeDwsClient();
    const { channel, bridge } = await readyPolicyChannel(
      client,
      makeConfig({ groupPolicy: 'pairing' }),
    );
    client.mentionedMessages = [
      message('user_im_message_receive_at', 'history-pairing', 'please help', {
        conversationId: 'external-group',
        eventTime: Date.now(),
      }),
    ];

    await channel.poll();

    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(client.sendImMessage).toHaveBeenCalledWith(
      { kind: 'group', conversationId: 'external-group' },
      expect.stringContaining('pairing code'),
      expect.any(String),
    );
  });

  it('resumes a bounded notification-history checkpoint after restart', async () => {
    const firstClient = new FakeDwsClient();
    firstClient.listDirectMessages.mockResolvedValueOnce({
      messages: [],
      nextCursor: 'cursor-100',
    });
    const first = await readyChannel(
      firstClient,
      makeConfig(),
      'checkpoint-dws',
    );

    await first.poll();
    expect(first.notificationCheckpoint()).toEqual(
      expect.objectContaining({ cursor: 'cursor-100' }),
    );
    first.disconnect();

    const secondClient = new FakeDwsClient();
    const second = await readyChannel(
      secondClient,
      makeConfig(),
      'checkpoint-dws',
    );
    await second.poll();

    expect(secondClient.listDirectMessages.mock.calls[0]?.[3]).toBe(
      'cursor-100',
    );
    expect(second.notificationCheckpoint()).toBeUndefined();
  });

  it('resumes a bounded mention-history checkpoint after restart', async () => {
    const firstClient = new FakeDwsClient();
    firstClient.listMentionedMessages.mockResolvedValueOnce({
      messages: [],
      nextCursor: 'mention-cursor-100',
    });
    const first = await readyChannel(
      firstClient,
      makeConfig(),
      'mention-checkpoint-dws',
    );

    await first.poll();
    expect(first.mentionCheckpoint()).toEqual(
      expect.objectContaining({ cursor: 'mention-cursor-100' }),
    );
    first.disconnect();

    const secondClient = new FakeDwsClient();
    const second = await readyChannel(
      secondClient,
      makeConfig(),
      'mention-checkpoint-dws',
    );
    await second.poll();

    expect(secondClient.listMentionedMessages.mock.calls[0]?.[3]).toBe(
      'mention-cursor-100',
    );
    expect(second.mentionCheckpoint()).toBeUndefined();
  });

  it('keeps other polling healthy when mention history is unavailable', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-17T05:00:00Z'));
      const client = new FakeDwsClient();
      client.listMentionedMessages.mockRejectedValue(
        new Error('mention history unavailable'),
      );
      const channel = await readyChannel(
        client,
        makeConfig({ watchTodos: true }),
      );
      const initialWatermark = channel.mentionWatermark();
      vi.setSystemTime(new Date('2026-08-17T05:01:00Z'));

      await expect(channel.poll()).resolves.toBeUndefined();

      expect(client.listTodoTasks).toHaveBeenCalledOnce();
      expect(channel.mentionWatermark()).toBe(initialWatermark);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers group mentions when direct-message history is unavailable', async () => {
    const client = new FakeDwsClient();
    client.listDirectMessages.mockRejectedValue(
      new Error('direct history unavailable'),
    );
    const channel = await readyChannel(client);
    client.mentionedMessages = [
      message(
        'user_im_message_receive_at',
        'mention-during-direct-outage',
        'hi',
        {
          conversationId: 'external-group',
          eventTime: Date.now(),
        },
      ),
    ];

    await expect(channel.poll()).resolves.toBeUndefined();

    expect(channel.inbound).toEqual([
      expect.objectContaining({ messageId: 'mention-during-direct-outage' }),
    ]);
  });

  it('polls group mentions before direct-message history', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);

    await channel.poll();

    expect(client.listMentionedMessages).toHaveBeenCalledOnce();
    expect(client.listDirectMessages).toHaveBeenCalledOnce();
    expect(
      client.listMentionedMessages.mock.invocationCallOrder[0],
    ).toBeLessThan(client.listDirectMessages.mock.invocationCallOrder[0] ?? 0);
  });

  it('deduplicates the same document notification across different message IDs', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const card = documentMentionCard('doc-1', 'comment-1');

    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'notification-1', card),
    );
    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'notification-2', card),
    );

    expect(channel.inbound).toHaveLength(1);
  });

  it('baselines existing native todos and processes newly assigned todos once', async () => {
    const client = new FakeDwsClient();
    client.todoTasks = [todoTask('task-existing', 'Historical task')];
    const channel = await readyChannel(
      client,
      makeConfig({ watchTodos: true }),
    );

    await channel.poll();
    expect(channel.inbound).toHaveLength(0);

    client.todoTasks = [
      ...client.todoTasks,
      todoTask('task-new', 'Investigate the new failure'),
    ];
    await channel.poll();

    expect(channel.inbound).toEqual([
      expect.objectContaining({
        chatId: 'todo:task-new',
        threadId: 'task-new',
        senderId: 'alice',
        displayText: 'Investigate the new failure',
        text: expect.stringContaining('Investigate the new failure'),
        metadata: expect.stringContaining('DWS native todo ID: task-new'),
      }),
    ]);
    await channel.respond('todo:task-new', 'Completed safely');
    expect(client.addTodoComment).toHaveBeenCalledWith(
      'task-new',
      'Completed safely',
    );

    await channel.poll();
    expect(channel.inbound).toHaveLength(1);
  });

  it('runs an accepted native todo and posts the final response as a comment', async () => {
    const client = new FakeDwsClient();
    client.todoTasks = [todoTask('task-existing', 'Historical task')];
    const { channel, bridge } = await readyPolicyChannel(
      client,
      makeConfig({ watchTodos: true }),
      'accepted-todos',
    );
    await channel.poll();
    client.todoTasks = [
      ...client.todoTasks,
      todoTask('task-new', 'Investigate the new failure'),
    ];

    await channel.poll();

    expect(bridge.prompt).toHaveBeenCalledOnce();
    expect(client.addTodoComment).toHaveBeenCalledWith('task-new', 'response');
  });

  it('posts an in-flight todo response after the task leaves the open list', async () => {
    const client = new FakeDwsClient();
    client.todoTasks = [todoTask('task-existing', 'Historical task')];
    const { channel, bridge } = await readyPolicyChannel(
      client,
      makeConfig({ watchTodos: true }),
      'completed-todos',
    );
    await channel.poll();
    let finishPrompt!: (value: string) => void;
    const prompt = bridge.prompt as ReturnType<typeof vi.fn>;
    prompt.mockImplementation(
      async () =>
        new Promise<string>((resolve) => {
          finishPrompt = resolve;
        }),
    );
    client.todoTasks = [
      ...client.todoTasks,
      todoTask('task-in-flight', 'Finish after completion'),
    ];

    const delivery = channel.poll();
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    client.todoTasks = client.todoTasks.filter(
      (task) => task.taskId !== 'task-in-flight',
    );
    await channel.poll();
    finishPrompt('final response');
    await delivery;

    expect(client.addTodoComment).toHaveBeenCalledWith(
      'task-in-flight',
      'final response',
    );
    expect(client.replyToImMessage).not.toHaveBeenCalled();
  });

  it('continues polling after one todo detail fetch fails', async () => {
    const client = new FakeDwsClient();
    client.todoTasks = [todoTask('task-existing', 'Historical task')];
    const channel = await readyChannel(
      client,
      makeConfig({ watchTodos: true }),
    );
    await channel.poll();
    client.todoTasks = [
      ...client.todoTasks,
      todoTask('task-failing', 'Unreadable task'),
      todoTask('task-good', 'Readable task'),
    ];
    client.getTodoTask.mockImplementation(async (taskId) => {
      if (taskId === 'task-failing') throw new Error('permission denied');
      const task = client.todoTasks.find((item) => item.taskId === taskId);
      if (!task) throw new Error(`Missing fake todo ${taskId}.`);
      return task;
    });

    await expect(channel.poll()).resolves.toBeUndefined();

    expect(channel.inbound).toEqual([
      expect.objectContaining({ threadId: 'task-good' }),
    ]);
  });

  it('advances notification history while the todo list is unavailable', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-14T08:00:00Z'));
      const client = new FakeDwsClient();
      client.listTodoTasks.mockRejectedValue(new Error('todo unavailable'));
      const channel = await readyChannel(
        client,
        makeConfig({ watchTodos: true }),
        'todo-outage-dws',
      );
      vi.setSystemTime(new Date('2026-08-14T08:01:00Z'));

      await expect(channel.poll()).resolves.toBeUndefined();
      const firstWatermark = channel.notificationWatermark();
      vi.setSystemTime(new Date('2026-08-14T08:02:00Z'));
      await expect(channel.poll()).resolves.toBeUndefined();

      expect(firstWatermark).toBe(new Date('2026-08-14T08:01:00Z').getTime());
      expect(channel.notificationWatermark()).toBe(
        new Date('2026-08-14T08:02:00Z').getTime(),
      );
      expect(client.listTodoTasks).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reacts to actionable todo changes but ignores comment metadata', async () => {
    const client = new FakeDwsClient();
    client.todoTasks = [todoTask('task-1', 'Review the change')];
    const channel = await readyChannel(
      client,
      makeConfig({ watchTodos: true }),
    );
    await channel.poll();

    client.todoTasks = [
      todoTask('task-1', 'Review the change', {
        commentCount: 1,
        modifiedTime: 1_786_592_400_000,
        update_time: 1_786_592_400_000,
      }),
    ];
    await channel.poll();
    expect(channel.inbound).toHaveLength(0);

    client.todoTasks = [
      todoTask('task-1', 'Review the change', {
        commentCount: 2,
        modifiedTime: 1_786_592_430_000,
        update_time: 1_786_592_430_000,
        priority: 40,
      }),
    ];
    await channel.poll();
    await channel.poll();

    expect(channel.inbound).toHaveLength(1);
    expect(client.getTodoTask).toHaveBeenCalledTimes(1);
  });

  it('persists native todo fingerprints across restarts', async () => {
    const firstClient = new FakeDwsClient();
    firstClient.todoTasks = [todoTask('task-1', 'Existing task')];
    const first = await readyChannel(
      firstClient,
      makeConfig({ watchTodos: true }),
      'persistent-todos',
    );
    await first.poll();
    firstClient.todoTasks = [
      ...firstClient.todoTasks,
      todoTask('task-2', 'New task'),
    ];
    await first.poll();
    expect(first.inbound).toHaveLength(1);
    first.disconnect();

    const secondClient = new FakeDwsClient();
    secondClient.todoTasks = firstClient.todoTasks;
    const second = await readyChannel(
      secondClient,
      makeConfig({ watchTodos: true }),
      'persistent-todos',
    );
    await second.poll();

    await second.sendThread('todo:task-1', 'task-1', 'continued after restart');

    expect(second.inbound).toHaveLength(0);
    expect(secondClient.addTodoComment).toHaveBeenCalledWith(
      'task-1',
      'continued after restart',
    );
  });

  it('comments one pairing code while keeping the todo pending for approval', async () => {
    const client = new FakeDwsClient();
    client.todoTasks = [todoTask('task-existing', 'Historical task')];
    const { channel, bridge } = await readyPolicyChannel(
      client,
      makeConfig({ watchTodos: true, senderPolicy: 'pairing' }),
      'paired-todos',
    );
    await channel.poll();
    client.todoTasks = [
      ...client.todoTasks,
      todoTask('task-new', 'Pair before running'),
    ];

    await channel.poll();
    await channel.poll();

    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(client.addTodoComment).toHaveBeenCalledTimes(1);
    expect(client.addTodoComment).toHaveBeenCalledWith(
      'task-new',
      expect.stringContaining('pairing code'),
    );
  });

  it('keeps polling when a document pairing notification cannot be sent', async () => {
    const client = new FakeDwsClient();
    client.replyToComment.mockRejectedValueOnce(
      new DwsCommandError('comment rejected', 'not_sent'),
    );
    const { channel, bridge } = await readyPolicyChannel(
      client,
      makeConfig({ senderPolicy: 'pairing' }),
    );
    client.directMessages = [
      message(
        'user_im_message_receive_o2o_all',
        'document-pairing',
        documentMentionCard('doc-pairing', 'comment-pairing'),
      ),
    ];

    await expect(channel.poll()).resolves.toBeUndefined();

    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(client.replyToComment).toHaveBeenCalledWith(
      'doc-pairing',
      'comment-pairing',
      expect.stringContaining('pairing code'),
    );
  });

  it('replays a pairing-pending document mention after approval', async () => {
    const client = new FakeDwsClient();
    const config = makeConfig({ senderPolicy: 'pairing' });
    const name = 'pending-document-dws';
    const { channel, bridge } = await readyPolicyChannel(client, config, name);
    client.directMessages = [
      message(
        'user_im_message_receive_o2o_all',
        'pending-document',
        documentMentionCard('doc-pending', 'comment-pending'),
      ),
    ];

    await channel.poll();
    const pairingText = client.replyToComment.mock.calls[0]?.[2];
    const code = pairingText?.match(/pairing code is: ([A-Z0-9]+)/u)?.[1];
    expect(code).toBeDefined();
    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(client.readDocument).toHaveBeenCalledTimes(1);

    client.directMessages = [];
    await channel.poll();
    await channel.poll();
    expect(client.readDocument).toHaveBeenCalledTimes(1);

    expect(new PairingStore(name, config.cwd).approve(code!)).not.toBeNull();
    await channel.poll();

    expect(client.readDocument).toHaveBeenCalledTimes(2);
    expect(bridge.prompt).toHaveBeenCalledOnce();
    expect(bridge.prompt).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('reply with the document code'),
      expect.any(Object),
    );

    await channel.poll();
    expect(client.readDocument).toHaveBeenCalledTimes(2);
  });

  it('drops profile-scoped document work and IM targets on profile switch', async () => {
    const config = makeConfig({ senderPolicy: 'pairing' });
    const name = 'profile-scoped-pending-document-dws';
    const firstClient = new FakeDwsClient();
    firstClient.identity = {
      profile: 'corp-one',
      selfSenderIds: ['open-account-one'],
    };
    const { channel: first } = await readyPolicyChannel(
      firstClient,
      config,
      name,
    );
    firstClient.directMessages = [
      message(
        'user_im_message_receive_o2o_all',
        'pending-document',
        documentMentionCard('doc-pending', 'comment-pending'),
      ),
    ];
    await first.poll();
    const pairingText = firstClient.replyToComment.mock.calls[0]?.[2];
    const code = pairingText?.match(/pairing code is: ([A-Z0-9]+)/u)?.[1];
    expect(code).toBeDefined();
    expect(new PairingStore(name, config.cwd).approve(code!)).not.toBeNull();
    await firstClient.emit(
      1,
      message('user_im_message_receive_o2o_all', 'remember-target', 'hello'),
    );
    first.disconnect();

    const secondClient = new FakeDwsClient();
    secondClient.identity = {
      profile: 'corp-two',
      selfSenderIds: ['open-account-two'],
    };
    const { channel: second, bridge } = await readyPolicyChannel(
      secondClient,
      config,
      name,
    );
    await second.poll();

    expect(secondClient.readDocument).not.toHaveBeenCalled();
    expect(secondClient.replyToComment).not.toHaveBeenCalled();
    expect(bridge.prompt).not.toHaveBeenCalled();
    await expect(second.sendMessage('cid-1', 'proactive')).rejects.toThrow(
      'no DWS message target is known',
    );
  });

  it('backs off persisted document notification delivery failures', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-15T00:00:00Z'));
      const client = new FakeDwsClient();
      const config = makeConfig({ senderPolicy: 'pairing' });
      const name = 'backed-off-document-dws';
      const { channel, bridge } = await readyPolicyChannel(
        client,
        config,
        name,
      );
      client.directMessages = [
        message(
          'user_im_message_receive_o2o_all',
          'pending-document',
          documentMentionCard('doc-pending', 'comment-pending'),
        ),
      ];

      await channel.poll();
      const pairingText = client.replyToComment.mock.calls[0]?.[2];
      const code = pairingText?.match(/pairing code is: ([A-Z0-9]+)/u)?.[1];
      expect(code).toBeDefined();
      expect(new PairingStore(name, config.cwd).approve(code!)).not.toBeNull();
      client.directMessages = [];
      client.replyToComment.mockRejectedValue(
        new DwsCommandError('comment deleted', 'not_sent'),
      );

      await channel.poll();
      await channel.poll();
      expect(bridge.prompt).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_000);
      await channel.poll();
      expect(bridge.prompt).toHaveBeenCalledTimes(2);
      channel.disconnect();

      const restartedClient = new FakeDwsClient();
      restartedClient.replyToComment.mockRejectedValue(
        new DwsCommandError('comment deleted', 'not_sent'),
      );
      const restarted = await readyPolicyChannel(restartedClient, config, name);
      await restarted.channel.poll();
      expect(restarted.bridge.prompt).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      await restarted.channel.poll();
      expect(restarted.bridge.prompt).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      await restarted.channel.poll();
      expect(restarted.bridge.prompt).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a working eyes reaction on the notification while a document task runs', async () => {
    const client = new FakeDwsClient();
    const { bridge } = await readyPolicyChannel(client);
    let finishPrompt!: (value: string) => void;
    const prompt = bridge.prompt as ReturnType<typeof vi.fn>;
    prompt.mockImplementation(
      async () =>
        new Promise<string>((resolve) => {
          finishPrompt = resolve;
        }),
    );

    const delivery = client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'document-notification',
        documentMentionCard('doc-1', 'comment-1'),
      ),
    );

    await vi.waitFor(() => {
      expect(client.addImReaction).toHaveBeenCalledWith(
        'cid-1',
        'document-notification',
        '暗中观察',
      );
    });

    finishPrompt('done');
    await delivery;

    await vi.waitFor(() => {
      expect(client.removeImReaction).toHaveBeenCalledWith(
        'cid-1',
        'document-notification',
        '暗中观察',
      );
    });
    expect(client.replyToComment).toHaveBeenCalledWith(
      'doc-1',
      'comment-1',
      'done',
    );
  });

  it('shows a working eyes reaction only while an accepted IM task is running', async () => {
    const client = new FakeDwsClient();
    const { bridge } = await readyPolicyChannel(client);
    let finishPrompt!: (value: string) => void;
    const prompt = bridge.prompt as ReturnType<typeof vi.fn>;
    prompt.mockImplementation(
      async () =>
        new Promise<string>((resolve) => {
          finishPrompt = resolve;
        }),
    );

    const delivery = client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'message-1', 'do the task'),
    );

    await vi.waitFor(() => {
      expect(client.addImReaction).toHaveBeenCalledWith(
        'cid-1',
        'message-1',
        '暗中观察',
      );
    });
    expect(client.removeImReaction).not.toHaveBeenCalled();

    finishPrompt('done');
    await delivery;

    await vi.waitFor(() => {
      expect(client.removeImReaction).toHaveBeenCalledWith(
        'cid-1',
        'message-1',
        '暗中观察',
      );
    });
  });

  it('removes an active working reaction when the channel disconnects', async () => {
    const client = new FakeDwsClient();
    const { channel, bridge } = await readyPolicyChannel(client);
    let finishPrompt!: (value: string) => void;
    const prompt = bridge.prompt as ReturnType<typeof vi.fn>;
    prompt.mockImplementation(
      async () =>
        new Promise<string>((resolve) => {
          finishPrompt = resolve;
        }),
    );
    const delivery = client
      .emit(
        1,
        message('user_im_message_receive_o2o_all', 'running', 'do the task'),
      )
      .catch(() => undefined);

    await vi.waitFor(() => expect(client.addImReaction).toHaveBeenCalledOnce());
    channel.disconnect();

    await vi.waitFor(() => {
      expect(client.removeImReaction).toHaveBeenCalledWith(
        'cid-1',
        'running',
        '暗中观察',
      );
    });
    finishPrompt('done');
    await delivery;
  });

  it('does not add a working reaction to a message rejected by pairing', async () => {
    const client = new FakeDwsClient();
    await readyPolicyChannel(client, makeConfig({ senderPolicy: 'pairing' }));

    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'pair-dm', 'please help'),
    );

    expect(client.addImReaction).not.toHaveBeenCalled();
  });

  it('keeps processing when the working reaction cannot be added', async () => {
    const client = new FakeDwsClient();
    client.addImReaction.mockRejectedValueOnce(new Error('reaction denied'));
    const { bridge } = await readyPolicyChannel(client);

    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'message-1', 'do the task'),
    );

    expect(bridge.prompt).toHaveBeenCalledOnce();
    expect(client.replyToImMessage).toHaveBeenCalledOnce();
  });

  it('removes a working reaction that finishes attaching after the task', async () => {
    const client = new FakeDwsClient();
    let finishReaction!: () => void;
    client.addImReaction.mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          finishReaction = resolve;
        }),
    );
    await readyPolicyChannel(client);

    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'message-1', 'do the task'),
    );
    expect(client.removeImReaction).toHaveBeenCalledOnce();

    finishReaction();

    await vi.waitFor(() => {
      expect(client.removeImReaction).toHaveBeenCalledTimes(2);
    });
  });

  it('applies sender pairing to ordinary direct messages', async () => {
    const client = new FakeDwsClient();
    const { bridge } = await readyPolicyChannel(
      client,
      makeConfig({ senderPolicy: 'pairing' }),
    );

    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'pair-dm', 'please help'),
    );

    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(client.sendImMessage).toHaveBeenCalledWith(
      { kind: 'direct', openDingTalkId: 'open-alice' },
      expect.stringContaining('pairing code'),
      expect.any(String),
    );
  });

  it('notifies a pending direct-message pairing request only once', async () => {
    const client = new FakeDwsClient();
    const { bridge } = await readyPolicyChannel(
      client,
      makeConfig({ senderPolicy: 'pairing' }),
    );

    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'automated-message',
        'Automated review completed. Do not reply.',
        { senderId: 'open-aoned', senderName: 'AoneD(Devix)' },
      ),
    );
    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'automated-response',
        'The account is not configured to interact with this bot.',
        { senderId: 'open-aoned', senderName: 'AoneD(Devix)' },
      ),
    );

    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(client.sendImMessage).toHaveBeenCalledOnce();
  });

  it('retries a pending direct-message pairing notification after delivery fails', async () => {
    const client = new FakeDwsClient();
    client.sendImMessage.mockRejectedValueOnce(
      new DwsCommandError('not sent', 'not_sent'),
    );
    await readyPolicyChannel(client, makeConfig({ senderPolicy: 'pairing' }));

    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'first-attempt', 'hello'),
    );
    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'retry-attempt',
        'hello again',
      ),
    );

    expect(client.sendImMessage).toHaveBeenCalledTimes(2);
  });

  it('retries an ambiguous pairing delivery with the same idempotency key', async () => {
    const client = new FakeDwsClient();
    client.sendImMessage.mockRejectedValueOnce(
      new DwsCommandError('connection reset', 'unknown'),
    );
    await readyPolicyChannel(client, makeConfig({ senderPolicy: 'pairing' }));

    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'first-attempt', 'hello'),
    );
    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'ambiguous-response',
        'hello again',
      ),
    );

    expect(client.sendImMessage).toHaveBeenCalledTimes(2);
    expect(client.sendImMessage.mock.calls[0]?.[2]).toBe(
      client.sendImMessage.mock.calls[1]?.[2],
    );
  });

  it('notifies different pending direct-message pairing requests', async () => {
    const client = new FakeDwsClient();
    await readyPolicyChannel(client, makeConfig({ senderPolicy: 'pairing' }));

    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'alice-request', 'hello'),
    );
    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'bob-request', 'hello', {
        conversationId: 'cid-2',
        senderId: 'open-bob',
        senderName: 'Bob',
      }),
    );

    expect(client.sendImMessage).toHaveBeenCalledTimes(2);
  });

  it('notifies a repeated pairing-cap rejection only once', async () => {
    const client = new FakeDwsClient();
    await readyPolicyChannel(client, makeConfig({ senderPolicy: 'pairing' }));

    for (let index = 0; index < 3; index++) {
      await client.emit(
        1,
        message(
          'user_im_message_receive_o2o_all',
          `pending-${index}`,
          'hello',
          {
            conversationId: `cid-pending-${index}`,
            senderId: `open-pending-${index}`,
          },
        ),
      );
    }
    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'capped-first', 'hello', {
        conversationId: 'cid-automated',
        senderId: 'open-automated',
      }),
    );
    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'capped-response',
        'This account cannot interact with the bot.',
        {
          conversationId: 'cid-automated',
          senderId: 'open-automated',
        },
      ),
    );

    const automatedNotifications = client.sendImMessage.mock.calls.filter(
      ([target]) =>
        target.kind === 'direct' && target.openDingTalkId === 'open-automated',
    );
    expect(automatedNotifications).toHaveLength(1);
  });

  it('consumes a tracked echo and still accepts matching peer text', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'request', 'hello'),
    );
    await channel.sendMessage('cid-1', 'shared text');

    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'echo', 'shared text', {
        senderId: 'open-self',
      }),
    );
    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'peer', 'shared text', {
        senderId: 'open-bob',
      }),
    );

    expect(channel.inbound.map((item) => item.text)).toEqual([
      'hello',
      'shared text',
    ]);
  });

  it('filters repeated and delayed self echoes without swallowing peer text', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeDwsClient();
      const channel = await readyChannel(client, makeConfig(), 'self-id-dws');
      await client.emit(
        1,
        message('user_im_message_receive_o2o_all', 'request', 'hello'),
      );
      await channel.sendMessage('cid-1', 'shared text');
      await channel.sendMessage('cid-1', 'shared text');

      await client.emit(
        1,
        message(
          'user_im_message_receive_o2o_all',
          'peer-first',
          'shared text',
          {
            senderId: 'open-bob',
            senderName: 'Bob',
          },
        ),
      );
      await client.emit(
        1,
        message(
          'user_im_message_receive_o2o_all',
          'self-echo-1',
          'shared text',
          {
            senderId: 'open-self',
          },
        ),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await client.emit(
        1,
        message(
          'user_im_message_receive_o2o_all',
          'self-echo-2',
          'shared text',
          {
            senderId: 'open-self',
          },
        ),
      );
      await channel.sendMessage('cid-1', 'follow up');

      expect(channel.inbound.map((item) => item.text)).toEqual([
        'hello',
        'shared text',
      ]);
      expect(client.sendImMessage.mock.calls[2]?.[0]).toEqual({
        kind: 'direct',
        openDingTalkId: 'open-bob',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not suppress matching peer text without an authoritative self sender', async () => {
    const client = new FakeDwsClient();
    client.identity = { profile: 'corp-only' };
    const channel = await readyChannel(
      client,
      makeConfig({
        dmPolicy: 'disabled',
        groups: { '*': { requireMention: false } },
      }),
    );
    await client.emit(
      1,
      message('user_im_message_receive_group_all', 'request', 'please help'),
    );
    await channel.sendMessage('cid-1', 'ok');

    await client.emit(
      1,
      message('user_im_message_receive_group_all', 'peer', 'ok', {
        senderId: 'open-bob',
      }),
    );

    expect(channel.inbound.map((item) => item.text)).toEqual([
      'please help',
      'ok',
    ]);
  });

  it('does not track group replies when their conversation requires mentions', async () => {
    const client = new FakeDwsClient();
    client.identity = { profile: 'corp-only' };
    const channel = await readyChannel(
      client,
      makeConfig({
        dmPolicy: 'disabled',
        groups: {
          '*': { requireMention: false },
          'cid-1': { requireMention: true },
        },
      }),
    );
    await client.emit(
      0,
      message('user_im_message_receive_at', 'request', 'hello'),
    );
    await channel.sendMessage('cid-1', 'shared text');

    await client.emit(
      0,
      message('user_im_message_receive_at', 'peer', 'shared text', {
        senderId: 'open-bob',
      }),
    );

    expect(channel.inbound.map((item) => item.text)).toEqual([
      'hello',
      'shared text',
    ]);
  });

  it('dispatches ambient messages from an explicit non-mention group', async () => {
    const client = new FakeDwsClient();
    const { bridge } = await readyPolicyChannel(
      client,
      makeConfig({
        groupPolicy: 'allowlist',
        groups: { 'cid-1': { requireMention: false } },
      }),
    );

    await client.emit(
      1,
      message('user_im_message_receive_group', 'ambient', 'normal chat'),
    );

    expect(bridge.prompt).toHaveBeenCalledOnce();
    expect(bridge.prompt).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('normal chat'),
      expect.any(Object),
    );
  });

  it('deduplicates a message delivered by both group and @ streams', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(
      client,
      makeConfig({ groups: { 'cid-1': { requireMention: false } } }),
    );
    const event = message(
      'user_im_message_receive_group',
      'message-1',
      'please help',
    );

    await client.emit(1, event);
    await client.emit(0, { ...event, type: 'user_im_message_receive_at' });

    expect(channel.inbound).toHaveLength(1);
  });

  it('lets an @ copy through when an ambient wildcard stream arrives first', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(
      client,
      makeConfig({
        groups: {
          '*': { requireMention: false },
          'cid-1': { requireMention: true },
        },
      }),
    );
    const event = message(
      'user_im_message_receive_group_all',
      'message-1',
      'please help',
    );

    await client.emit(1, event);
    await client.emit(0, { ...event, type: 'user_im_message_receive_at' });

    expect(channel.inbound).toEqual([
      expect.objectContaining({ text: 'please help', isMentioned: true }),
    ]);
  });

  it('requires both group and sender allowlists before dispatching', async () => {
    const client = new FakeDwsClient();
    const { bridge } = await readyPolicyChannel(
      client,
      makeConfig({
        groupPolicy: 'allowlist',
        groups: { 'cid-allowed': {} },
        senderPolicy: 'allowlist',
        allowedUsers: ['open-bob'],
      }),
    );

    await client.emit(
      0,
      message('user_im_message_receive_at', 'denied-group', 'do not run', {
        senderId: 'open-bob',
        senderName: 'Bob',
      }),
    );
    await client.emit(
      0,
      message('user_im_message_receive_at', 'denied-sender', 'do not run', {
        conversationId: 'cid-allowed',
      }),
    );
    await client.emit(
      0,
      message('user_im_message_receive_at', 'allowed', 'please run', {
        conversationId: 'cid-allowed',
        senderId: 'open-bob',
        senderName: 'Bob',
      }),
    );

    expect(bridge.prompt).toHaveBeenCalledOnce();
    expect(bridge.prompt).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('please run'),
      expect.any(Object),
    );
  });

  it('starts group pairing instead of dispatching an unapproved conversation', async () => {
    const client = new FakeDwsClient();
    const { bridge } = await readyPolicyChannel(
      client,
      makeConfig({ groupPolicy: 'pairing' }),
    );

    await client.emit(
      0,
      message('user_im_message_receive_at', 'pair-group', 'please help'),
    );

    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(client.sendImMessage).toHaveBeenCalledWith(
      { kind: 'group', conversationId: 'cid-1' },
      expect.stringContaining('pairing code'),
      expect.any(String),
    );
  });

  it('lets an @ event create pairing when its ambient copy arrives first', async () => {
    const client = new FakeDwsClient();
    const { bridge } = await readyPolicyChannel(
      client,
      makeConfig({
        groupPolicy: 'pairing',
        groups: { 'cid-1': { requireMention: false } },
      }),
    );
    const event = message(
      'user_im_message_receive_group',
      'pair-group',
      'please help',
    );

    await client.emit(1, event);
    await client.emit(0, { ...event, type: 'user_im_message_receive_at' });

    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(client.sendImMessage).toHaveBeenCalledOnce();
    expect(client.sendImMessage).toHaveBeenCalledWith(
      { kind: 'group', conversationId: 'cid-1' },
      expect.stringContaining('pairing code'),
      expect.any(String),
    );
  });

  it('drops direct messages when direct-message access is disabled', async () => {
    const client = new FakeDwsClient();
    const { bridge } = await readyPolicyChannel(
      client,
      makeConfig({
        dmPolicy: 'disabled',
      }),
    );

    expect(client.streams.map((stream) => stream.source)).toEqual([
      { kind: 'at' },
    ]);
    expect(bridge.prompt).not.toHaveBeenCalled();
  });

  it('applies sender access policy to document mention notifications', async () => {
    const client = new FakeDwsClient();
    const { bridge } = await readyPolicyChannel(
      client,
      makeConfig({
        groupPolicy: 'allowlist',
        groups: {},
        senderPolicy: 'allowlist',
        allowedUsers: ['open-bob'],
      }),
    );

    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'denied-document',
        documentMentionCard('doc-1', 'comment-1'),
      ),
    );
    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'allowed-document',
        documentMentionCard('doc-2', 'comment-2'),
        { senderId: 'open-bob', senderName: 'Bob' },
      ),
    );

    expect(bridge.prompt).toHaveBeenCalledOnce();
    expect(bridge.prompt).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('reply with the document code'),
      expect.any(Object),
    );
  });

  it('deduplicates a successful message across restarts', async () => {
    const client = new FakeDwsClient();
    const first = await readyChannel(client, makeConfig(), 'persistent-dws');
    const duplicate = message(
      'user_im_message_receive_at',
      'message-1',
      'please help',
    );

    await client.emit(0, duplicate);
    first.disconnect();

    const secondClient = new FakeDwsClient();
    const second = await readyChannel(
      secondClient,
      makeConfig(),
      'persistent-dws',
    );
    await secondClient.emit(0, duplicate);

    expect(first.inbound).toHaveLength(1);
    expect(second.inbound).toHaveLength(0);
  });

  it('allows a redelivered event to retry after inbound dispatch fails', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const event = message(
      'user_im_message_receive_at',
      'message-1',
      'please retry',
    );
    channel.inboundError = new Error('agent unavailable');

    await expect(client.emit(0, event)).rejects.toThrow('agent unavailable');
    channel.inboundError = undefined;
    await client.emit(0, event);

    expect(channel.inbound.map((item) => item.text)).toEqual(['please retry']);
  });

  it('lets concurrent duplicates retry once after the first dispatch fails', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const duplicate = message(
      'user_im_message_receive_at',
      'message-1',
      'please retry',
    );
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let attempts = 0;
    channel.inboundHandler = async (envelope) => {
      attempts += 1;
      if (attempts === 1) {
        await firstGate;
        throw new Error('agent unavailable');
      }
      channel.inbound.push(envelope);
    };

    const first = client.emit(0, duplicate);
    await vi.waitFor(() => expect(attempts).toBe(1));
    const second = client.emit(0, duplicate);
    const third = client.emit(0, duplicate);
    releaseFirst();

    await expect(first).rejects.toThrow('agent unavailable');
    await expect(second).resolves.toBeUndefined();
    await expect(third).resolves.toBeUndefined();
    expect(channel.inbound.map((item) => item.text)).toEqual(['please retry']);
  });

  it('does not automatically rerun an event after inbound dispatch fails', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeDwsClient();
      const channel = await readyChannel(client);
      const event = message(
        'user_im_message_receive_at',
        'message-1',
        'please retry automatically',
      );
      channel.inboundError = new Error('agent unavailable');

      await expect(client.emit(0, event)).rejects.toThrow('agent unavailable');
      channel.inboundError = undefined;
      await vi.advanceTimersByTimeAsync(10_000);

      expect(channel.inbound).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the originating message for an idempotent final reply', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    channel.responseMessageId = 'message-1';
    channel.responseSenderId = 'open-alice';

    await channel.respond('cid-1', 'final answer');

    expect(client.replyToImMessage).toHaveBeenCalledWith(
      'cid-1',
      'message-1',
      'open-alice',
      'final answer',
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    );
  });

  it('suppresses the no-reply sentinel for every DWS source', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    channel.responseMessageId = 'message-1';
    channel.responseSenderId = 'open-alice';

    await channel.respond('cid-1', '[NO_REPLY]');

    expect(client.replyToImMessage).not.toHaveBeenCalled();
    expect(client.sendImMessage).not.toHaveBeenCalled();
  });

  it('suppresses the no-reply sentinel for proactive IM delivery', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    await client.emit(
      0,
      message('user_im_message_receive_at', 'message-1', 'please help'),
    );
    const sessionId = await channel.resolveImSession();

    await channel.dispatchBackgroundResponse(sessionId, '[NO_REPLY]');

    expect(client.sendImMessage).not.toHaveBeenCalled();
  });
});
