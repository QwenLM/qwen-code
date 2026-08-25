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
  DwsClient,
  DwsCommandError,
  type DwsClientLike,
  type DwsCommandRunner,
  type DwsIdentity,
  type DwsImMessage,
  type DwsImSource,
  type DwsImTarget,
  type DwsTodoTask,
} from './dws-client.js';
import {
  DwsEventProcessError,
  type DwsEventProcessStarter,
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
    // Real DWS messages always carry an event time, and history queries are
    // windowed on it. Defaulting to `undefined` made every fixture read as
    // epoch 0, which only ever worked because the fake ignored its window.
    eventTime: Date.now(),
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
  // R2-1: the real client is queried as `--start <windowStart> --end <now>`
  // and returns only what falls inside. A fake that ignores its window can
  // certify recoveries the production arithmetic cannot perform, which is
  // exactly what happened: a fixture pinned "polling recovers this" for a
  // message strictly outside every window the watermark will ever produce.
  private inWindow(message: DwsImMessage, start: number, end: number): boolean {
    const time = message.eventTime ?? 0;
    return time >= start && time <= end;
  }

  listDirectMessages = vi.fn(
    async (startTime: number, endTime: number, _signal?: AbortSignal) =>
      Promise.resolve({
        messages: this.directMessages.filter((item) =>
          this.inWindow(item, startTime, endTime),
        ),
      }),
  );
  listMentionedMessages = vi.fn(
    async (startTime: number, endTime: number, _signal?: AbortSignal) =>
      Promise.resolve({
        messages: this.mentionedMessages.filter((item) =>
          this.inWindow(item, startTime, endTime),
        ),
      }),
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

  inboundAttempts = 0;

  override async handleInbound(envelope: Envelope): Promise<void> {
    this.inboundAttempts += 1;
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

  seedInboundFailure(key: string, attempts: number): void {
    this.cursor.inboundFailures = [{ key, attempts }];
    this.saveCursor();
  }

  inboundFailures(): unknown[] {
    return this.cursor.inboundFailures ?? [];
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

  pendingDocumentNotifications(): unknown[] {
    return this.cursor.pendingDocumentNotifications ?? [];
  }

  documentSetSize(): number {
    return (this as unknown as { documentSet: Set<string> }).documentSet.size;
  }

  rememberDocumentReferences(count: number): void {
    const rememberDocumentId = (
      this as unknown as { rememberDocumentId(documentId: string): void }
    ).rememberDocumentId.bind(this);
    for (let index = 0; index < count; index += 1) {
      rememberDocumentId(`doc-${index}`);
    }
  }

  documentIds(): string[] {
    return [...(this as unknown as { documentSet: Set<string> }).documentSet];
  }

  seedPendingDocumentNotifications(count: number): void {
    this.cursor.pendingDocumentNotifications = Array.from(
      { length: count },
      (_unused, index) => ({
        documentId: `parked-doc-${index}`,
        commentKey: `parked-comment-${index}`,
        request: `parked request ${index}`,
        messageId: `parked-message-${index}`,
        conversationId: 'cid-parked',
        senderId: 'open-unpaired',
        senderName: 'Unpaired Member',
      }),
    );
    this.saveCursor();
  }

  notificationWatermark(): number | undefined {
    return this.cursor.notificationWatermark;
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
      'DWS IM sources require the authenticated identity to expose an openDingTalkId.',
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

  it('drops inbound failure budgets after a profile switch', async () => {
    const name = 'profile-inbound-failures-dws';
    const firstClient = new FakeDwsClient();
    firstClient.identity.profile = 'corp-one';
    const first = await readyChannel(firstClient, makeConfig(), name);
    first.seedInboundFailure('todo-failure:task-shared', 4);
    first.disconnect();

    const secondClient = new FakeDwsClient();
    secondClient.identity.profile = 'corp-two';
    const second = await readyChannel(secondClient, makeConfig(), name);

    expect(second.inboundFailures()).toEqual([]);
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

  it('requires authoritative self sender metadata for ambient groups', async () => {
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
    ).rejects.toThrow(
      'DWS IM sources require the authenticated identity to expose an openDingTalkId.',
    );
    expect(client.streams).toEqual([]);
  });

  it('rejects ambient groups when the real client cannot resolve self identity', async () => {
    const runner = vi
      .fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ version: '1.0.57' }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          profiles: [{ profile: 'corp:bot', isCurrent: true }],
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          authenticated: true,
          user_id: 'AI574',
          user_name: 'QwenBot',
        }),
        stderr: '',
      })
      .mockRejectedValueOnce(new Error('contact unavailable'));
    const eventStarter = vi.fn<DwsEventProcessStarter>();
    const client = new DwsClient(
      { executable: '/opt/dws', profile: 'corp:bot' },
      runner,
      eventStarter,
    );
    const channel = new TestableDwsChannel(
      'real-client-missing-self-dws',
      makeConfig({
        dmPolicy: 'disabled',
        groups: { 'cid-ambient': { requireMention: false } },
      }),
      makeBridge(),
      undefined,
      client,
    );
    channels.push(channel);

    await expect(channel.connect()).rejects.toThrow(
      'DWS IM sources require the authenticated identity to expose an openDingTalkId.',
    );
    expect(eventStarter).not.toHaveBeenCalled();
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

  // R4-3: `retryable: false` is terminal before ready (`retryLimit` returns
  // 0), but `scheduleImRestart` never consulted it, and `startImSource` resets
  // `restartAttempts` to 0 every time a subscription becomes ready — so the
  // backoff exponent stayed at 0 and a permanently denied consumer was
  // respawned at a constant ~3s, forever, while the channel reported itself
  // connected and delivered nothing for that source.
  it('stops restarting a source that died permanently after becoming ready', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeDwsClient();
      await readyChannel(client);

      client.streams[0]?.onError(
        new DwsEventProcessError('subscription is not allowed', false),
      );
      client.streams[0]?.subscription.close();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60_000);

      // No respawn — the two streams `readyChannel` opened, and nothing more.
      expect(client.streams).toHaveLength(2);
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

  // R4-4: the pullback above only rescues the replay if the poll that was in
  // flight when it happened does not finish by writing its own window's end
  // back over it. `checkpoint.endTime` is always past the replay's `eventTime`,
  // and the replay is left UNMARKED on purpose — so one clobber puts it outside
  // every future window, forever, with no log and no error.
  it('keeps the stale-replay pullback when a poll was already in flight', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const replay = message(
      'user_im_message_receive_o2o_all',
      'replayed-in-flight',
      documentMentionCard('doc-inflight', 'comment-inflight'),
      { eventTime: Date.now() - 60_000 },
    );
    const windows: Array<[number, number]> = [];
    const listDirectMessages =
      client.listDirectMessages.getMockImplementation();
    client.listDirectMessages.mockImplementation(
      async (startTime, endTime, signal, cursor) => {
        windows.push([startTime, endTime]);
        // The replay lands while this window's fetch is awaiting — the exact
        // race `runLoop` opens on connect, since the IM subscriptions start
        // before the first poll.
        if (windows.length === 1) await client.emit(1, replay);
        return listDirectMessages!(startTime, endTime, signal, cursor);
      },
    );

    await channel.poll();
    client.directMessages = [replay];
    await channel.poll();

    expect(channel.inbound).toEqual([
      expect.objectContaining({
        chatId: 'doc-inflight',
        threadId: 'comment-inflight',
      }),
    ]);
    // The second window has to actually reach back over the replay; asserting
    // only on `inbound` would pass on a fake that ignored its window.
    expect(windows[1][0]).toBeLessThanOrEqual(replay.eventTime!);
  });

  // R6-1: the flag `pollOnce` consults is cleared before every fetch, so it
  // only ever covers a replay that landed DURING one. A pullback in the gap
  // between two polls is reset before it is read, and a persisted multi-page
  // checkpoint then resumes a window that starts after the replay and finishes
  // by writing its own `endTime` back over the pulled-back watermark — the
  // same permanent loss R4-4 closed, through the other door.
  it('keeps a stale-replay pullback that arrives between two polls', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const replay = message(
      'user_im_message_receive_o2o_all',
      'replayed-between-polls',
      documentMentionCard('doc-between', 'comment-between'),
      { eventTime: Date.now() - 60_000 },
    );
    const windows: Array<[number, number]> = [];
    const listDirectMessages =
      client.listDirectMessages.getMockImplementation();
    client.listDirectMessages.mockImplementation(
      async (startTime, endTime, signal, cursor) => {
        windows.push([startTime, endTime]);
        const page = await listDirectMessages!(
          startTime,
          endTime,
          signal,
          cursor,
        );
        // The first window is bounded, so the poll persists a checkpoint to
        // resume from — the restart-after-downtime state.
        return windows.length === 1
          ? { ...page, nextCursor: 'cursor-page-2' }
          : page;
      },
    );

    await channel.poll();
    expect(channel.notificationCheckpoint()).toEqual(
      expect.objectContaining({ cursor: 'cursor-page-2' }),
    );

    // No poll is in flight here: this is the 5-second gap between them.
    await client.emit(1, replay);
    expect(channel.notificationCheckpoint()).toBeUndefined();

    client.directMessages = [replay];
    await channel.poll();

    expect(channel.inbound).toEqual([
      expect.objectContaining({
        chatId: 'doc-between',
        threadId: 'comment-between',
      }),
    ]);
    // The resumed checkpoint's window would have opened past the replay; the
    // one actually issued has to reach back over it.
    expect(windows[1][0]).toBeLessThanOrEqual(replay.eventTime!);
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

  it('reprocesses an actionable todo edit made during its turn', async () => {
    const client = new FakeDwsClient();
    client.todoTasks = [todoTask('task-1', 'Initial title')];
    const channel = await readyChannel(
      client,
      makeConfig({ watchTodos: true }),
    );
    await channel.poll();
    client.todoTasks = [todoTask('task-1', 'First actionable edit')];
    channel.inboundHandler = async () => {
      client.todoTasks = [todoTask('task-1', 'Edit made during the turn')];
    };

    await channel.poll();
    await channel.poll();
    await channel.poll();

    expect(channel.inboundAttempts).toBe(2);
    expect(client.getTodoTask).toHaveBeenCalledTimes(2);
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

  // The pending pairing request behind a stuck todo expires after an hour and
  // the gate mints a fresh code; the code-keyed in-memory dedup had never seen
  // it, so the todo collected one duplicate pairing comment per expiry, plus
  // one more per daemon restart.
  it('keeps one todo pairing comment across pairing-code expiry and restarts', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-20T08:00:00Z'));
      const config = makeConfig({
        watchTodos: true,
        senderPolicy: 'pairing',
      });
      const name = 'sticky-todo-pairing-dws';
      const client = new FakeDwsClient();
      client.todoTasks = [todoTask('task-existing', 'Historical task')];
      const { channel, bridge } = await readyPolicyChannel(
        client,
        config,
        name,
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
      const firstCode = client.addTodoComment.mock.calls[0]?.[1]?.match(
        /pairing code is: ([A-Z0-9]+)/u,
      )?.[1];
      expect(firstCode).toBeDefined();

      vi.setSystemTime(new Date('2026-08-20T09:01:00Z'));
      await channel.poll();

      const pending = new PairingStore(name, config.cwd).listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.code).not.toBe(firstCode);
      expect(client.addTodoComment).toHaveBeenCalledTimes(1);

      channel.disconnect();
      const restartedClient = new FakeDwsClient();
      restartedClient.todoTasks = client.todoTasks;
      const { channel: restarted } = await readyPolicyChannel(
        restartedClient,
        config,
        name,
      );
      await restarted.poll();

      expect(restartedClient.addTodoComment).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-notifies a revoked todo creator when the todo changes again', async () => {
    const config = makeConfig({ watchTodos: true, senderPolicy: 'pairing' });
    const name = 'revoked-todo-pairing-dws';
    const client = new FakeDwsClient();
    client.todoTasks = [todoTask('task-existing', 'Historical task')];
    const { channel, bridge } = await readyPolicyChannel(client, config, name);
    await channel.poll();
    client.todoTasks = [
      ...client.todoTasks,
      todoTask('task-new', 'Pair before running'),
    ];

    await channel.poll();

    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(client.addTodoComment).toHaveBeenCalledTimes(1);
    const code = client.addTodoComment.mock.calls[0]?.[1]?.match(
      /pairing code is: ([A-Z0-9]+)/u,
    )?.[1];
    expect(code).toBeDefined();

    const store = new PairingStore(name, config.cwd);
    expect(store.approve(code!)).not.toBeNull();
    await channel.poll();

    expect(bridge.prompt).toHaveBeenCalledTimes(1);
    // The approved turn published its response to the todo thread.
    expect(client.addTodoComment).toHaveBeenLastCalledWith(
      'task-new',
      'response',
    );

    expect(store.revoke('alice')).toBe(true);
    client.todoTasks = [
      todoTask('task-existing', 'Historical task'),
      todoTask('task-new', 'Pair before running', { priority: 40 }),
    ];

    await channel.poll();

    expect(bridge.prompt).toHaveBeenCalledTimes(1);
    expect(client.addTodoComment).toHaveBeenCalledTimes(3);
    expect(client.addTodoComment).toHaveBeenLastCalledWith(
      'task-new',
      expect.stringContaining('pairing code'),
    );
  });

  // R16-1: an approved creator whose turn fails must not keep the persisted
  // pairing marker. The marker was cleared only after a *successful* turn, so a
  // failed turn left it behind; after a later revocation the stale marker
  // matched the fresh pairing result and suppressed the re-pairing comment,
  // locking the creator out of the todo surface for this chat.
  it('re-notifies a revoked todo creator whose approved turn failed', async () => {
    const config = makeConfig({ watchTodos: true, senderPolicy: 'pairing' });
    const name = 'failed-turn-todo-pairing-dws';
    const client = new FakeDwsClient();
    client.todoTasks = [todoTask('task-existing', 'Historical task')];
    const { channel, bridge } = await readyPolicyChannel(client, config, name);
    await channel.poll();
    client.todoTasks = [
      ...client.todoTasks,
      todoTask('task-new', 'Pair before running'),
    ];

    await channel.poll();

    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(client.addTodoComment).toHaveBeenCalledTimes(1);
    const code = client.addTodoComment.mock.calls[0]?.[1]?.match(
      /pairing code is: ([A-Z0-9]+)/u,
    )?.[1];
    expect(code).toBeDefined();

    const store = new PairingStore(name, config.cwd);
    expect(store.approve(code!)).not.toBeNull();
    // The approved turn fails; the pairing marker must still be cleared.
    bridge.prompt.mockRejectedValueOnce(new Error('turn failed'));
    await channel.poll();

    expect(bridge.prompt).toHaveBeenCalledTimes(1);
    expect(client.addTodoComment).toHaveBeenCalledTimes(1);

    expect(store.revoke('alice')).toBe(true);
    client.todoTasks = [
      todoTask('task-existing', 'Historical task'),
      todoTask('task-new', 'Pair before running', { priority: 40 }),
    ];

    await channel.poll();

    expect(bridge.prompt).toHaveBeenCalledTimes(1);
    expect(client.addTodoComment).toHaveBeenCalledTimes(2);
    expect(client.addTodoComment).toHaveBeenLastCalledWith(
      'task-new',
      expect.stringContaining('pairing code'),
    );
  });

  it('keeps polling when a direct pairing notification cannot be sent', async () => {
    const client = new FakeDwsClient();
    client.sendImMessage.mockRejectedValueOnce(
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
    expect(client.sendImMessage).toHaveBeenCalledWith(
      { kind: 'direct', openDingTalkId: 'open-alice' },
      expect.stringContaining('pairing code'),
      expect.any(String),
    );
  });

  it('bounds live document routing references', async () => {
    const client = new FakeDwsClient();
    const { channel } = await readyPolicyChannel(
      client,
      makeConfig({ senderPolicy: 'pairing' }),
    );
    channel.rememberDocumentReferences(5_001);

    expect(channel.documentSetSize()).toBe(5_000);
    expect(channel.documentIds()[0]).toBe('doc-1');
    expect(channel.documentIds().at(-1)).toBe('doc-5000');
  });

  // The pending queue's only drain is an ALLOWED sender later processing the
  // same comment, so notifications parked for unapproved senders persist for
  // good — and the list persists in the cursor across restarts. Throwing at
  // the cap aborted `pollOnce`'s direct-message loop before the checkpoint,
  // the watermark and `markProcessedMessage`, so every 5s poll re-scanned a
  // growing window and re-threw on the same never-marked message: document
  // history polling stayed broken until manual cursor surgery. One unpaired
  // member @-mentioning the bot in 5,000 distinct comments was enough.
  it('keeps polling when the pending document queue is at its cap', async () => {
    const client = new FakeDwsClient();
    const { channel } = await readyPolicyChannel(
      client,
      makeConfig({ senderPolicy: 'pairing' }),
    );
    channel.seedPendingDocumentNotifications(5_000);
    client.directMessages = [
      message(
        'user_im_message_receive_o2o_all',
        'document-at-cap',
        documentMentionCard('doc-at-cap', 'comment-at-cap'),
        { eventTime: Date.now() },
      ),
    ];

    await expect(channel.poll()).resolves.toBeUndefined();

    // The queue stayed bounded, the newest notification is parked, and the
    // oldest was evicted rather than the poll aborting.
    const pending = channel.pendingDocumentNotifications();
    expect(pending).toHaveLength(5_000);
    expect(pending).toContainEqual(
      expect.objectContaining({ documentId: 'doc-at-cap' }),
    );
    expect(pending).not.toContainEqual(
      expect.objectContaining({ documentId: 'parked-doc-0' }),
    );
    // And the poll actually finished: the watermark advanced, so the next one
    // does not re-scan this message forever.
    expect(channel.notificationWatermark()).toBeGreaterThan(0);
  });

  // R7-1: `(documentId, commentKey)` is reconstructed from rendered message
  // text by a hand-rolled regex set, so a bare URL in an ordinary DM forges a
  // card the channel cannot tell apart from a real platform notification. The
  // forged document id then drove `readDocumentContext` BEFORE the sender gate
  // resolved, so under the documented default `senderPolicy: 'pairing'` an
  // unpaired stranger could force this profile to read any document it can
  // reach — a turn it would never be served. The read now waits for the gate.
  it('does not read a forged document mention before the sender gate resolves', async () => {
    const client = new FakeDwsClient();
    const { channel, bridge } = await readyPolicyChannel(
      client,
      makeConfig({ senderPolicy: 'pairing' }),
    );
    const forged =
      'https://alidocs.dingtalk.com/i/nodes/secretDoc123?iframeQuery=comment_key%3DvictimCommentKey%26mention_source%3D2';
    client.directMessages = [
      message('user_im_message_receive_o2o_all', 'forged-mention', forged, {
        senderId: 'open-stranger',
        senderName: 'Stranger',
      }),
    ];

    await expect(channel.poll()).resolves.toBeUndefined();

    expect(client.readDocument).not.toHaveBeenCalled();
    expect(client.replyToComment).not.toHaveBeenCalled();
    expect(channel.documentSetSize()).toBe(0);
    expect(client.sendImMessage).toHaveBeenCalledWith(
      { kind: 'direct', openDingTalkId: 'open-stranger' },
      expect.stringContaining('pairing code'),
      expect.any(String),
    );
    expect(bridge.prompt).not.toHaveBeenCalled();
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
    const pairingText = client.sendImMessage.mock.calls[0]?.[1];
    const code = pairingText?.match(/pairing code is: ([A-Z0-9]+)/u)?.[1];
    expect(code).toBeDefined();
    expect(bridge.prompt).not.toHaveBeenCalled();
    // R7-1: this used to be 1. The parked sender is one the channel refuses to
    // serve, so reading the document for them was an authenticated read driven
    // by an unapproved stranger — the read now waits for approval like the turn
    // already did.
    expect(client.readDocument).not.toHaveBeenCalled();

    client.directMessages = [];
    await channel.poll();
    await channel.poll();
    expect(client.readDocument).not.toHaveBeenCalled();

    expect(new PairingStore(name, config.cwd).approve(code!)).not.toBeNull();
    await channel.poll();

    // The deferred read happens on replay, so the approved turn still gets its
    // document context.
    expect(client.readDocument).toHaveBeenCalledTimes(1);
    expect(bridge.prompt).toHaveBeenCalledOnce();
    expect(bridge.prompt).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('reply with the document code'),
      expect.any(Object),
    );

    await channel.poll();
    expect(client.readDocument).toHaveBeenCalledTimes(1);
  });

  it('parks the same document mention separately for each denied sender', async () => {
    const client = new FakeDwsClient();
    const config = makeConfig({ senderPolicy: 'pairing' });
    const name = 'multi-sender-pending-document-dws';
    const { channel, bridge } = await readyPolicyChannel(client, config, name);
    const card = documentMentionCard('doc-shared', 'comment-shared');
    const now = Date.now();
    client.directMessages = [
      message('user_im_message_receive_o2o_all', 'alice-document', card, {
        eventTime: now,
      }),
      message('user_im_message_receive_o2o_all', 'bob-document', card, {
        eventTime: now,
        senderId: 'open-bob',
        senderName: 'Bob',
      }),
    ];

    await channel.poll();

    expect(channel.pendingDocumentNotifications()).toEqual([
      expect.objectContaining({ senderId: 'open-alice' }),
      expect.objectContaining({ senderId: 'open-bob' }),
    ]);
    const bobPairingText = client.sendImMessage.mock.calls.find(
      ([target]) =>
        target.kind === 'direct' && target.openDingTalkId === 'open-bob',
    )?.[1];
    const bobCode = bobPairingText?.match(/pairing code is: ([A-Z0-9]+)/u)?.[1];
    expect(bobCode).toBeDefined();
    expect(new PairingStore(name, config.cwd).approve(bobCode!)).not.toBeNull();
    client.directMessages = [];

    await channel.poll();
    await channel.poll();

    expect(bridge.prompt).toHaveBeenCalledOnce();
    expect(channel.pendingDocumentNotifications()).toEqual([]);
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
    const pairingText = firstClient.sendImMessage.mock.calls[0]?.[1];
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
      const pairingText = client.sendImMessage.mock.calls[0]?.[1];
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

  it('removes an active working reaction when the agent session dies', async () => {
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
    channel.onSessionDied('session-1');

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

  it('does not suppress peer text matching bot output', async () => {
    const client = new FakeDwsClient();
    client.identity = {
      profile: 'corp-only',
      selfSenderIds: ['open-self'],
    };
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
    client.identity = {
      profile: 'corp-only',
      selfSenderIds: ['open-self'],
    };
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

  // R2-4: `notificationKey` is (document, comment) with NO sender in it, so a
  // denied sender's mention used to consume the slot permanently -- every later
  // mention of the same comment, including one from an allowed reviewer, was
  // dropped silently and forever (the cursor persists across restarts). The
  // test above cannot catch this: its denied and allowed notifications sit on
  // DIFFERENT comments.
  it('lets an allowed sender through after a denied one on the same comment', async () => {
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
    expect(bridge.prompt).not.toHaveBeenCalled();

    // Bob IS allowlisted, and mentions the bot on the SAME comment thread --
    // the ordinary multi-reviewer document flow.
    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'allowed-document',
        documentMentionCard('doc-1', 'comment-1'),
        { senderId: 'open-bob', senderName: 'Bob' },
      ),
    );

    expect(bridge.prompt).toHaveBeenCalledOnce();
  });

  // R6-2: the same slot, taken concurrently. The test above lets the denied
  // turn finish first; when it is still IN FLIGHT, the allowed sender joins
  // the awaiter instead, and a parked outcome there used to mark the allowed
  // sender's own message processed without ever running it. Replay re-drives
  // a parked entry only for its own (denied) sender, and history skips a
  // marked key forever -- so the allowed reviewer's request was answered by
  // nothing, with no log, permanently.
  it('lets an allowed sender through while a denied turn on the same comment is in flight', async () => {
    const client = new FakeDwsClient();
    let releaseDocument!: () => void;
    const documentRead = new Promise<void>((resolve) => {
      releaseDocument = resolve;
    });
    const readDocument = client.readDocument.getMockImplementation();
    client.readDocument.mockImplementation(async (documentId, signal) => {
      await documentRead;
      return readDocument!(documentId, signal);
    });
    const { channel, bridge } = await readyPolicyChannel(
      client,
      makeConfig({
        groupPolicy: 'allowlist',
        groups: {},
        senderPolicy: 'allowlist',
        allowedUsers: ['open-bob'],
      }),
    );

    const denied = client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'denied-document',
        documentMentionCard('doc-1', 'comment-1'),
      ),
    );
    // Bob mentions the bot on the same comment seconds later, while the first
    // turn is still reading the document -- the ordinary multi-reviewer flow.
    const allowed = client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'allowed-document',
        documentMentionCard('doc-1', 'comment-1'),
        { senderId: 'open-bob', senderName: 'Bob' },
      ),
    );
    releaseDocument();
    await Promise.all([denied, allowed]);

    // Bob's mention was left for the next poll rather than served inline, so
    // history has to be able to reach it -- which it cannot once his message
    // key is marked.
    client.directMessages = [
      message(
        'user_im_message_receive_o2o_all',
        'allowed-document',
        documentMentionCard('doc-1', 'comment-1'),
        { senderId: 'open-bob', senderName: 'Bob' },
      ),
    ];
    await channel.poll();

    expect(bridge.prompt).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('doc-1'),
      expect.any(Object),
    );
  });

  it('replays an allowed catch-up mention after a denied turn was in flight', async () => {
    const client = new FakeDwsClient();
    let releasePairing!: () => void;
    const pairing = new Promise<void>((resolve) => {
      releasePairing = resolve;
    });
    client.sendImMessage.mockImplementation(async () => {
      await pairing;
    });
    const { channel, bridge } = await readyPolicyChannel(
      client,
      makeConfig({
        senderPolicy: 'pairing',
        allowedUsers: ['open-bob'],
      }),
    );
    const catchUp = message(
      'user_im_message_receive_o2o_all',
      'allowed-catch-up',
      documentMentionCard('doc-1', 'comment-1'),
      {
        senderId: 'open-bob',
        senderName: 'Bob',
        eventTime: Date.now() - 100_000,
      },
    );

    await client.emit(1, catchUp);
    client.directMessages = [catchUp];
    const denied = client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'denied-live',
        documentMentionCard('doc-1', 'comment-1'),
      ),
    );
    await vi.waitFor(() => expect(client.sendImMessage).toHaveBeenCalledOnce());
    const catchUpPoll = channel.poll();
    await vi.waitFor(() =>
      expect(client.listDirectMessages).toHaveBeenCalled(),
    );
    releasePairing();
    await Promise.all([denied, catchUpPoll]);

    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(channel.pendingDocumentNotifications()).toContainEqual(
      expect.objectContaining({ messageId: 'allowed-catch-up' }),
    );
    expect(channel.notificationWatermark()).toBeGreaterThan(
      catchUp.eventTime! + 5_000,
    );

    client.directMessages = [];
    await channel.poll();

    expect(bridge.prompt).toHaveBeenCalledOnce();
    expect(bridge.prompt).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('doc-1'),
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

  // R2-2: a message whose turn throws was never marked processed and never
  // advanced the watermark, so history polling re-ran it as a FULL agent turn
  // every poll — one model call per iteration, forever, with no cap and no
  // backoff — while the pinned watermark grew the query window without bound
  // and the throw starved every newer message behind it. Pending-document
  // replay already had this accounting; this path had none.
  it('drops a message whose turn keeps failing, and moves the watermark on', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    channel.inboundError = new DwsCommandError('comment rejected', 'not_sent');
    client.mentionedMessages = [
      message('user_im_message_receive_at', 'poison', '@QwenBot hi', {
        eventTime: Date.now(),
      }),
    ];

    // The poll swallows a failed turn into a log line, so the observable is
    // the re-run count: unbounded before (one full agent turn per poll, for
    // the life of the channel), capped at the budget now.
    for (let round = 0; round < 8; round += 1) {
      await expect(channel.poll()).resolves.toBeUndefined();
    }

    expect(channel.inboundAttempts).toBe(5);
    // And the watermark is free to move again, so the query window stops
    // growing and newer mentions are no longer starved behind this one.
    expect(channel.mentionWatermark()).toBeGreaterThan(0);
  });

  it('replays a failed ambient group message after restart', async () => {
    const config = makeConfig({ groups: { '*': { requireMention: false } } });
    const name = 'pending-ambient-group-dws';
    const firstClient = new FakeDwsClient();
    const first = await readyChannel(firstClient, config, name);
    first.inboundError = new Error('agent unavailable');
    const event = message(
      'user_im_message_receive_group_all',
      'ambient-retry',
      'please retry this group request',
      { conversationId: 'cid-group' },
    );

    await expect(firstClient.emit(1, event)).rejects.toThrow(
      'agent unavailable',
    );
    first.disconnect();

    const restartedClient = new FakeDwsClient();
    const restarted = await readyChannel(restartedClient, config, name);
    await restarted.poll();
    await restarted.poll();

    expect(restarted.inboundAttempts).toBe(1);
    expect(restarted.inbound).toEqual([
      expect.objectContaining({
        chatId: 'cid-group',
        messageId: 'ambient-retry',
      }),
    ]);
  });

  it('caps retries for a persistently failing ambient group message', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(
      client,
      makeConfig({ groups: { '*': { requireMention: false } } }),
    );
    channel.inboundError = new Error('agent unavailable');
    const event = message(
      'user_im_message_receive_group_all',
      'ambient-poison',
      'this group request keeps failing',
      { conversationId: 'cid-group' },
    );

    await expect(client.emit(1, event)).rejects.toThrow('agent unavailable');
    for (let round = 0; round < 7; round += 1) {
      await channel.poll();
    }

    expect(channel.inboundAttempts).toBe(5);
  });

  // R12-1: a plain direct message whose turn throws had no redelivery path —
  // the at-most-once event stream already consumed it, the DM history loop
  // dispatches only document-mention notifications, and the pending queue
  // parked only group sources. One transient failure lost it forever.
  it('replays a failed direct message on the next poll', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    channel.inboundError = new Error('agent unavailable');
    const event = message(
      'user_im_message_receive_o2o_all',
      'direct-retry',
      'please retry this direct request',
    );

    await expect(client.emit(1, event)).rejects.toThrow('agent unavailable');
    channel.inboundError = undefined;
    await channel.poll();

    expect(channel.inboundAttempts).toBe(2);
    expect(channel.inbound).toEqual([
      expect.objectContaining({
        chatId: 'cid-1',
        messageId: 'direct-retry',
      }),
    ]);
  });

  it('replays a failed direct message after restart', async () => {
    const config = makeConfig();
    const name = 'pending-direct-dws';
    const firstClient = new FakeDwsClient();
    const first = await readyChannel(firstClient, config, name);
    first.inboundError = new Error('agent unavailable');
    const event = message(
      'user_im_message_receive_o2o',
      'direct-restart-retry',
      'please retry this direct request after restart',
    );

    await expect(firstClient.emit(1, event)).rejects.toThrow(
      'agent unavailable',
    );
    first.disconnect();

    const restartedClient = new FakeDwsClient();
    const restarted = await readyChannel(restartedClient, config, name);
    await restarted.poll();

    expect(restarted.inboundAttempts).toBe(1);
    expect(restarted.inbound).toEqual([
      expect.objectContaining({
        chatId: 'cid-1',
        messageId: 'direct-restart-retry',
      }),
    ]);
  });

  it('caps retries for a persistently failing direct message', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    channel.inboundError = new Error('agent unavailable');
    const event = message(
      'user_im_message_receive_o2o_all',
      'direct-poison',
      'this direct request keeps failing',
    );

    await expect(client.emit(1, event)).rejects.toThrow('agent unavailable');
    for (let round = 0; round < 7; round += 1) {
      await channel.poll();
    }

    expect(channel.inboundAttempts).toBe(5);
  });

  // R4-1: the budget above was wired into the mention path only. A document
  // notification whose turn throws escaped `pollOnce`'s sorted loop, so
  // nothing was marked processed, the checkpoint and watermark never advanced,
  // and every 5s poll re-ran the same full agent turn — starving every newer
  // notification behind it, forever.
  it('drops a document notification whose turn keeps failing, and stops starving newer ones', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const now = Date.now();
    client.directMessages = [
      message(
        'user_im_message_receive_o2o_all',
        'poison-notification',
        documentMentionCard('doc-poison', 'a'.repeat(45)),
        { eventTime: now },
      ),
      message(
        'user_im_message_receive_o2o_all',
        'fresh-notification',
        documentMentionCard('doc-fresh', 'b'.repeat(45)),
        { eventTime: now + 1 },
      ),
    ];
    channel.inboundHandler = async (envelope) => {
      if (envelope.chatId === 'doc-poison')
        throw new Error('agent unavailable');
      channel.inbound.push(envelope);
    };

    for (let round = 0; round < 8; round += 1) {
      await expect(channel.poll()).resolves.toBeUndefined();
    }

    // Five turns for the poison notification, then one for the newer one that
    // it used to stand in front of. Unbounded before, and `doc-fresh` was
    // never reached at all.
    expect(channel.inboundAttempts).toBe(6);
    expect(channel.inbound.map((envelope) => envelope.chatId)).toEqual([
      'doc-fresh',
    ]);
  });

  // R6-3: exhausting that budget takes five polls -- about 25s of transient
  // model or bridge trouble -- and the drop closure marked the sender-agnostic
  // `notificationKey`. So one bad minute killed every FUTURE mention of that
  // comment from anyone: `processedMessages` is persisted, and
  // `processDocumentNotification` returns on it before doing anything else.
  it('lets a later mention of a dropped comment retry with a fresh budget', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const now = Date.now();
    const commentKey = 'c'.repeat(45);
    client.directMessages = [
      message(
        'user_im_message_receive_o2o_all',
        'outage-notification',
        documentMentionCard('doc-outage', commentKey),
        { eventTime: now },
      ),
    ];
    let bridgeIsDown = true;
    channel.inboundHandler = async (envelope) => {
      if (bridgeIsDown) throw new Error('agent unavailable');
      channel.inbound.push(envelope);
    };

    for (let round = 0; round < 6; round += 1) {
      await expect(channel.poll()).resolves.toBeUndefined();
    }
    expect(channel.inbound).toEqual([]);

    // The outage passes, and a different reviewer mentions the bot on the very
    // same comment. Nothing about the dropped message says anything about
    // this one.
    bridgeIsDown = false;
    client.directMessages = [
      message(
        'user_im_message_receive_o2o_all',
        'later-notification',
        documentMentionCard('doc-outage', commentKey),
        { eventTime: now + 1, senderId: 'open-bob', senderName: 'Bob' },
      ),
    ];

    await channel.poll();

    expect(channel.inbound).toEqual([
      expect.objectContaining({ chatId: 'doc-outage', senderId: 'open-bob' }),
    ]);
  });

  it('keeps another sender pending when an allowed turn exhausts its budget', async () => {
    const client = new FakeDwsClient();
    const config = makeConfig({
      senderPolicy: 'pairing',
      allowedUsers: ['open-bob'],
    });
    const name = 'sender-scoped-document-failure-dws';
    const { channel, bridge } = await readyPolicyChannel(client, config, name);
    vi.mocked(bridge.prompt).mockRejectedValue(new Error('agent unavailable'));
    const now = Date.now();
    const commentKey = 'd'.repeat(45);
    client.directMessages = [
      message(
        'user_im_message_receive_o2o_all',
        'alice-pending',
        documentMentionCard('doc-shared', commentKey),
        { eventTime: now - 1 },
      ),
      message(
        'user_im_message_receive_o2o_all',
        'bob-failing',
        documentMentionCard('doc-shared', commentKey),
        { eventTime: now, senderId: 'open-bob', senderName: 'Bob' },
      ),
    ];

    for (let round = 0; round < 6; round += 1) {
      await channel.poll();
    }

    expect(bridge.prompt).toHaveBeenCalledTimes(5);
    expect(channel.pendingDocumentNotifications()).toEqual([
      expect.objectContaining({
        documentId: 'doc-shared',
        commentKey,
        senderId: 'open-alice',
      }),
    ]);

    const pairingText = client.sendImMessage.mock.calls[0]?.[1];
    const code = pairingText?.match(/pairing code is: ([A-Z0-9]+)/u)?.[1];
    expect(code).toBeDefined();
    expect(new PairingStore(name, config.cwd).approve(code!)).not.toBeNull();
    vi.mocked(bridge.prompt).mockResolvedValue('recovered');
    client.directMessages = [];

    await channel.poll();

    expect(bridge.prompt).toHaveBeenCalledTimes(6);
    expect(channel.pendingDocumentNotifications()).toEqual([]);
  });

  // R4-1: `pollTodos` remembers a fingerprint only on success, so a todo whose
  // turn keeps throwing was re-fetched and re-run as a full agent turn on
  // every poll, forever.
  it('drops a native todo whose turn keeps failing', async () => {
    const client = new FakeDwsClient();
    client.todoTasks = [todoTask('task-existing', 'Historical task')];
    const channel = await readyChannel(
      client,
      makeConfig({ watchTodos: true }),
    );
    await channel.poll();
    expect(channel.inboundAttempts).toBe(0);

    client.todoTasks = [
      ...client.todoTasks,
      todoTask('task-poison', 'Unrunnable task'),
    ];
    channel.inboundError = new Error('agent unavailable');

    for (let round = 0; round < 8; round += 1) {
      await expect(channel.poll()).resolves.toBeUndefined();
    }

    expect(channel.inboundAttempts).toBe(5);
  });

  // R13-2: the R4-1 budget above is for turns that keep throwing. A
  // `getTodoTask` fetch failure runs no agent turn, so charging the budget
  // for it permanently fingerprinted away a still-open todo after a mere
  // transient outage.
  it('processes a todo once its repeatedly failing detail fetch recovers', async () => {
    const client = new FakeDwsClient();
    client.todoTasks = [todoTask('task-existing', 'Historical task')];
    const channel = await readyChannel(
      client,
      makeConfig({ watchTodos: true }),
    );
    await channel.poll();

    client.todoTasks = [
      ...client.todoTasks,
      todoTask('task-flaky', 'Flaky task'),
    ];
    let fetchFailures = 0;
    client.getTodoTask.mockImplementation(async (taskId) => {
      const task = client.todoTasks.find((item) => item.taskId === taskId);
      if (!task) throw new Error(`Missing fake todo ${taskId}.`);
      if (taskId === 'task-flaky' && fetchFailures < 5) {
        fetchFailures += 1;
        throw new Error('transient dws failure');
      }
      return task;
    });

    for (let round = 0; round < 5; round += 1) {
      await expect(channel.poll()).resolves.toBeUndefined();
    }
    expect(fetchFailures).toBe(5);
    expect(channel.inboundAttempts).toBe(0);

    await channel.poll();

    expect(channel.inbound).toEqual([
      expect.objectContaining({ threadId: 'task-flaky' }),
    ]);
  });

  it('does not let a deeply nested todo block later tasks', async () => {
    let nested: Record<string, unknown> = { value: 'leaf' };
    for (let depth = 0; depth < 20_000; depth += 1) {
      nested = { child: nested };
    }
    const client = new FakeDwsClient();
    client.todoTasks = [
      todoTask('task-deep', 'Deep task', { nested }),
      todoTask('task-healthy', 'Healthy task'),
    ];
    const channel = await readyChannel(
      client,
      makeConfig({ watchTodos: true }),
    );

    await channel.poll();
    client.todoTasks = [
      client.todoTasks[0]!,
      todoTask('task-healthy', 'Healthy task changed'),
    ];
    await channel.poll();
    await channel.poll();

    expect(channel.inbound).toEqual([
      expect.objectContaining({
        threadId: 'task-healthy',
        text: expect.stringContaining('Healthy task changed'),
      }),
    ]);
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

  // R1-7: the unknown-outcome swallow decides whether a finished task is
  // rerun and its final comment posted twice. Pin both directions: an
  // ambiguous CLI outcome resolves the turn, a definitive rejection
  // rethrows so the inbound budget can retry.
  it('keeps a todo task finished when the final comment outcome is unknown', async () => {
    const client = new FakeDwsClient();
    client.todoTasks = [todoTask('task-1', 'Ambiguous task')];
    const channel = await readyChannel(
      client,
      makeConfig({ watchTodos: true }),
    );
    await channel.poll();
    // The first poll only baselines todos; the second registers the target.
    await channel.poll();
    client.addTodoComment.mockRejectedValue(
      new DwsCommandError('timed out', 'unknown'),
    );

    await expect(
      channel.respond('todo:task-1', 'the answer'),
    ).resolves.toBeUndefined();

    expect(client.addTodoComment).toHaveBeenCalledOnce();
  });

  it('rethrows a definitive todo comment rejection', async () => {
    const client = new FakeDwsClient();
    client.todoTasks = [todoTask('task-1', 'Rejected task')];
    const channel = await readyChannel(
      client,
      makeConfig({ watchTodos: true }),
    );
    await channel.poll();
    // The first poll only baselines todos; the second registers the target.
    await channel.poll();
    client.addTodoComment.mockRejectedValue(
      new DwsCommandError('comment rejected', 'not_sent'),
    );

    await expect(channel.respond('todo:task-1', 'the answer')).rejects.toThrow(
      'comment rejected',
    );
  });

  it('keeps a document task finished when the final reply outcome is unknown', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const commentKey = '1786589783750e2a797d2c2c141c295519dbcb07f2274';
    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'notification-ambiguous',
        documentMentionCard('doc-1', commentKey),
      ),
    );
    client.replyToComment.mockRejectedValue(
      new DwsCommandError('timed out', 'unknown'),
    );

    channel.responseThreadId = commentKey;
    await expect(
      channel.respond('doc-1', 'the code is 42'),
    ).resolves.toBeUndefined();

    expect(client.replyToComment).toHaveBeenCalledOnce();
  });

  it('rethrows a definitive document reply rejection', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    const commentKey = '1786589783750e2a797d2c2c141c295519dbcb07f2274';
    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'notification-rejected',
        documentMentionCard('doc-1', commentKey),
      ),
    );
    client.replyToComment.mockRejectedValue(
      new DwsCommandError('comment deleted', 'not_sent'),
    );

    channel.responseThreadId = commentKey;
    await expect(channel.respond('doc-1', 'the code is 42')).rejects.toThrow(
      'comment deleted',
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

  it('suppresses the no-reply sentinel wrapped in fences or inline code', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(client);
    channel.responseMessageId = 'message-1';
    channel.responseSenderId = 'open-alice';

    for (const wrapped of [
      '```\n[NO_REPLY]\n```',
      '```md\n[NO_REPLY]\n```',
      '```[NO_REPLY]```',
      '`[NO_REPLY]`',
      '``[NO_REPLY]``',
    ]) {
      await channel.respond('cid-1', wrapped);
    }
    // A fenced reply that is NOT the sentinel must still be published.
    await channel.respond('cid-1', '```\nreal answer\n```');

    expect(client.replyToImMessage).toHaveBeenCalledOnce();
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
