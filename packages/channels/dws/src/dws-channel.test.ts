/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelAgentBridge,
  ChannelConfig,
  Envelope,
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
  };
  streams: FakeStream[] = [];
  directMessages: DwsImMessage[] = [];
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
      Promise.resolve(this.directMessages),
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

  instructions(): string | undefined {
    return this.config.instructions;
  }

  approvalMode(): string | undefined {
    return this.config.approvalMode;
  }

  resolveSession(): Promise<string> {
    return this.router.resolve(this.name, 'alice', 'doc-1', 'comment-1');
  }

  resolveImSession(): Promise<string> {
    return this.router.resolve(this.name, 'alice', 'cid-1');
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

  it('starts ambient groups without querying account identity metadata', async () => {
    const client = new FakeDwsClient();

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

  it('requires manual tool approval for document-triggered sessions', async () => {
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
    await expect(
      readyChannel(
        client,
        makeConfig({
          approvalMode: 'yolo',
        }),
      ),
    ).rejects.toThrow('require approvalMode');
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

  it('uses the full retry budget while creating a replacement stream', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeDwsClient();
      await readyChannel(client);
      const subscribe = vi
        .spyOn(client, 'subscribeToIm')
        .mockRejectedValueOnce(new DwsEventProcessError('retry one', true))
        .mockRejectedValueOnce(new DwsEventProcessError('retry two', true));

      client.streams[0]?.subscription.close();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(6_000);

      expect(subscribe).toHaveBeenCalledTimes(3);
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
      message('user_im_message_receive_at', 'message-1', 'please help'),
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
      }),
    ]);
    expect(client.sendImMessage).toHaveBeenCalledWith(
      { kind: 'group', conversationId: 'cid-1' },
      'done',
      expect.any(String),
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
        text: 'reply with the document code',
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
        text: 'reply with the document code',
      }),
    ]);
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

    expect(second.inbound).toHaveLength(0);
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

  it('does not repeat a pairing notification after an ambiguous delivery failure', async () => {
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

    expect(client.sendImMessage).toHaveBeenCalledOnce();
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

  it('does not treat matching peer text as an echo after the tracking window expires', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeDwsClient();
      client.identity = { profile: 'corp-only' };
      const channel = await readyChannel(client);
      await client.emit(
        1,
        message('user_im_message_receive_o2o_all', 'request', 'hello'),
      );
      await channel.sendMessage('cid-1', 'shared text');
      await vi.advanceTimersByTimeAsync(30_001);

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
    } finally {
      vi.useRealTimers();
    }
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

  it('learns its sender ID from an outbound echo when authentication omits user IDs', async () => {
    const client = new FakeDwsClient();
    client.identity = { profile: 'corp-only' };
    const { bridge } = await readyPolicyChannel(
      client,
      makeConfig({ senderPolicy: 'pairing' }),
      'learn-self-dws',
    );

    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'self-request', 'hello', {
        senderId: 'open-self',
        senderName: 'DataWorksAgent',
      }),
    );
    const pairingText = client.sendImMessage.mock.calls[0]?.[1];
    expect(pairingText).toContain('pairing code');

    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'pairing-echo', pairingText!, {
        senderId: 'open-self',
        senderName: 'DataWorksAgent',
      }),
    );
    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'later-self-message',
        'still me',
        { senderId: 'open-self', senderName: 'DataWorksAgent' },
      ),
    );

    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(client.sendImMessage).toHaveBeenCalledOnce();
  });

  it('learns its sender ID from a JSON-wrapped Markdown echo', async () => {
    const client = new FakeDwsClient();
    client.identity = { profile: 'corp-only' };
    const { bridge } = await readyPolicyChannel(
      client,
      makeConfig({ senderPolicy: 'pairing' }),
      'markdown-echo-dws',
    );

    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'peer-request', 'hello'),
    );
    const pairingText = client.sendImMessage.mock.calls[0]?.[1];
    expect(pairingText).toContain('pairing code');

    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'pairing-markdown-echo',
        JSON.stringify({ text: pairingText, title: 'Your pairing code' }),
        { senderId: 'open-self', senderName: 'DataWorksAgent' },
      ),
    );

    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(client.sendImMessage).toHaveBeenCalledOnce();
  });

  it('learns its sender ID when DWS folds Markdown whitespace', async () => {
    const client = new FakeDwsClient();
    client.identity = { profile: 'corp-only' };
    const { bridge } = await readyPolicyChannel(
      client,
      makeConfig({ senderPolicy: 'pairing' }),
      'folded-markdown-echo-dws',
    );

    await client.emit(
      1,
      message('user_im_message_receive_o2o_all', 'peer-request', 'hello'),
    );
    const pairingText = client.sendImMessage.mock.calls[0]?.[1];
    expect(pairingText).toContain('\n\n');
    const folded = pairingText!.replace('\n\n', '  \n').replace(/\n\s+/gu, ' ');

    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'pairing-markdown-echo',
        folded,
        {
          senderId: 'open-self',
          senderName: 'DataWorksAgent',
        },
      ),
    );

    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(client.sendImMessage).toHaveBeenCalledOnce();
  });

  it('remembers a learned self sender ID across channel restarts', async () => {
    const firstClient = new FakeDwsClient();
    firstClient.identity = { profile: 'corp-only' };
    const { channel: first } = await readyPolicyChannel(
      firstClient,
      makeConfig({ senderPolicy: 'pairing' }),
      'persistent-self-dws',
    );
    await firstClient.emit(
      1,
      message('user_im_message_receive_o2o_all', 'self-request', 'hello', {
        senderId: 'open-self',
        senderName: 'DataWorksAgent',
      }),
    );
    const pairingText = firstClient.sendImMessage.mock.calls[0]?.[1];
    await firstClient.emit(
      1,
      message('user_im_message_receive_o2o_all', 'pairing-echo', pairingText!, {
        senderId: 'open-self',
        senderName: 'DataWorksAgent',
      }),
    );
    first.disconnect();

    const secondClient = new FakeDwsClient();
    secondClient.identity = { profile: 'corp-only' };
    const { bridge } = await readyPolicyChannel(
      secondClient,
      makeConfig({ senderPolicy: 'pairing' }),
      'persistent-self-dws',
    );
    await secondClient.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'later-self-message',
        'still me',
        { senderId: 'open-self', senderName: 'DataWorksAgent' },
      ),
    );

    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(secondClient.sendImMessage).not.toHaveBeenCalled();
  });

  it('does not reuse a learned self sender ID after the DWS profile changes', async () => {
    const firstClient = new FakeDwsClient();
    firstClient.identity = { profile: 'corp-one' };
    const { channel: first } = await readyPolicyChannel(
      firstClient,
      makeConfig({ senderPolicy: 'pairing' }),
      'profile-scoped-self-dws',
    );
    await firstClient.emit(
      1,
      message('user_im_message_receive_o2o_all', 'self-request', 'hello', {
        senderId: 'open-account-one',
      }),
    );
    const pairingText = firstClient.sendImMessage.mock.calls[0]?.[1];
    await firstClient.emit(
      1,
      message('user_im_message_receive_o2o_all', 'pairing-echo', pairingText!, {
        senderId: 'open-account-one',
      }),
    );
    first.disconnect();

    const secondClient = new FakeDwsClient();
    secondClient.identity = { profile: 'corp-two' };
    await readyPolicyChannel(
      secondClient,
      makeConfig({ senderPolicy: 'pairing' }),
      'profile-scoped-self-dws',
    );
    await secondClient.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'account-one-as-a-peer',
        'hello from another account',
        { senderId: 'open-account-one' },
      ),
    );

    expect(secondClient.sendImMessage).toHaveBeenCalledOnce();
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
