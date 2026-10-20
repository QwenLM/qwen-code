/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelAgentBridge,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';
import { DwsChannel } from './dws-channel.js';
import type {
  DwsClientLike,
  DwsImMessage,
  DwsImMessageResult,
  DwsImSource,
} from './dws-client.js';

const documentCard = [
  'Project plan',
  '@DataWorksAgent review the document',
  'Alice',
  '<https://alidocs.dingtalk.com/i/nodes/doc-1?iframeQuery=mention_source%3D2%26comment_key%3Dcomment-1>',
].join('\n');

function message(content = 'hello'): DwsImMessage {
  return {
    type: 'user_im_message_receive_o2o_all',
    eventId: 'event-1',
    messageId: 'message-1',
    conversationId: 'conversation-1',
    content,
    senderId: 'open-alice',
    senderName: 'Alice',
    eventTime: Date.now(),
  };
}

function clientFixture() {
  const streams: Array<{
    source: DwsImSource;
    onMessage: (message: DwsImMessage) => DwsImMessageResult;
  }> = [];
  const client: DwsClientLike = {
    assertAuthenticated: vi.fn().mockResolvedValue({
      profile: 'corp:test-self',
      selfSenderIds: ['open-self'],
    }),
    subscribeToIm: vi.fn(async (source, onMessage) => {
      streams.push({ source, onMessage });
      let close!: () => void;
      const closed = new Promise<void>((resolve) => {
        close = resolve;
      });
      return { closed, stop: close };
    }),
    sendImMessage: vi.fn().mockResolvedValue(undefined),
    replyToImMessage: vi.fn().mockResolvedValue(undefined),
    addImReaction: vi.fn().mockResolvedValue(undefined),
    removeImReaction: vi.fn().mockResolvedValue(undefined),
    listDirectMessages: vi.fn().mockResolvedValue({ messages: [] }),
    listMentionedMessages: vi.fn().mockResolvedValue({ messages: [] }),
    readDocument: vi.fn().mockResolvedValue('# Plan'),
    replyToComment: vi.fn().mockResolvedValue(undefined),
    listTodoTasks: vi.fn().mockResolvedValue([]),
    getTodoTask: vi.fn(),
    addTodoComment: vi.fn().mockResolvedValue(undefined),
  };
  return { client, streams };
}

class ProbeChannel extends DwsChannel {
  readonly inbound: Envelope[] = [];
  forwardToBridge = false;
  protected override startPollLoop(): void {}
  protected override get todoPollInterval(): number {
    return 0;
  }
  override async handleInbound(envelope: Envelope): Promise<void> {
    if (this.forwardToBridge) return super.handleInbound(envelope);
    this.inbound.push(envelope);
  }
  get prompt() {
    return this.bridge.prompt;
  }
  disableChats(): void {
    this.config.groupPolicy = 'disabled';
    Object.defineProperty(this, 'privatePolicy', { value: 'disabled' });
  }
  seedDirectPending(count: number): void {
    this.cursor.pendingMessages = Array.from({ length: count }, (_, index) => ({
      source: { kind: 'direct' } as const,
      message: { ...message(), messageId: `parked-${index}` },
    }));
    this.saveCursor();
  }
  async poll(): Promise<void> {
    await this.pollOnce();
  }
  seedPending(): void {
    this.cursor.pendingMessages = [
      { source: { kind: 'direct' }, message: message() },
      {
        source: { kind: 'at' },
        message: {
          ...message(),
          type: 'user_im_message_receive_at',
          messageId: 'group-message-1',
          conversationId: 'group-1',
        },
      },
    ];
    this.cursor.pendingDocumentNotifications = [
      {
        documentId: 'doc-pending',
        commentKey: 'comment-pending',
        request: 'review pending document',
        messageId: 'doc-message-1',
        conversationId: 'doc-conversation-1',
        senderId: 'open-alice',
        senderName: 'Alice',
      },
    ];
    this.cursor.mentionWatermark = 1000;
    this.cursor.notificationWatermark = 2000;
    this.cursor.mentionCheckpoint = {
      startTime: 1000,
      endTime: 2000,
      cursor: 'group-page-2',
    };
    this.cursor.notificationCheckpoint = {
      startTime: 1000,
      endTime: 2000,
      cursor: 'direct-page-2',
    };
    this.saveCursor();
  }
  state() {
    return {
      pendingMessages: this.cursor.pendingMessages,
      pendingDocuments: this.cursor.pendingDocumentNotifications,
      mentionWatermark: this.cursor.mentionWatermark,
      notificationWatermark: this.cursor.notificationWatermark,
      mentionCheckpoint: this.cursor.mentionCheckpoint,
      notificationCheckpoint: this.cursor.notificationCheckpoint,
    };
  }
}

let qwenHome: string;
let previousQwenHome: string | undefined;
const channels: ProbeChannel[] = [];
beforeEach(() => {
  previousQwenHome = process.env['QWEN_HOME'];
  qwenHome = mkdtempSync(join(tmpdir(), 'qwen-dws-switch-'));
  process.env['QWEN_HOME'] = qwenHome;
});
afterEach(() => {
  for (const channel of channels.splice(0)) channel.disconnect();
  if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
  else process.env['QWEN_HOME'] = previousQwenHome;
  rmSync(qwenHome, { recursive: true, force: true });
});

async function ready(
  client: DwsClientLike,
  overrides: Record<string, unknown> = {},
  name = 'chat-switch-probe',
) {
  const config: ChannelConfig & Record<string, unknown> = {
    type: 'dws',
    token: '',
    senderPolicy: 'open',
    allowedUsers: [],
    groupPolicy: 'open',
    dmPolicy: 'open',
    groups: { '*': {} },
    sessionScope: 'chat_thread',
    cwd: '/tmp/test',
    ...overrides,
  };
  const bridge = {
    newSession: vi.fn().mockResolvedValue('session-1'),
    loadSession: vi.fn(),
    prompt: vi.fn().mockResolvedValue('response'),
    cancelSession: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  } as unknown as ChannelAgentBridge;
  const channel = new ProbeChannel(name, config, bridge, undefined, client);
  channels.push(channel);
  await channel.connect();
  return channel;
}

async function deliver(result: DwsImMessageResult) {
  if (result && 'completed' in result) {
    await result.admitted;
    await result.completed;
  } else await result;
}

describe('DWS independent chat switches', () => {
  it.each([
    ['open', 'open', ['at', 'group', 'direct']],
    ['open', 'disabled', ['at', 'group']],
    ['disabled', 'open', ['direct']],
    ['disabled', 'disabled', []],
  ])(
    'subscribes only enabled sources: groups=%s direct=%s',
    async (groupPolicy, dmPolicy, expected) => {
      const { client, streams } = clientFixture();
      await ready(client, {
        groupPolicy,
        dmPolicy,
        groups: { 'group-1': { requireMention: false } },
      });
      expect(streams.map(({ source }) => source.kind)).toEqual(expected);
    },
  );

  it.each([
    ['open', 'open', 1, 1],
    ['open', 'disabled', 1, 0],
    ['disabled', 'open', 0, 1],
    ['disabled', 'disabled', 0, 0],
  ])(
    'polls only enabled sources: groups=%s direct=%s',
    async (groupPolicy, dmPolicy, mentions, direct) => {
      const { client } = clientFixture();
      const channel = await ready(client, {
        groupPolicy,
        dmPolicy,
        watchTodos: true,
      });
      await channel.poll();
      expect(client.listMentionedMessages).toHaveBeenCalledTimes(
        mentions as number,
      );
      expect(client.listDirectMessages).toHaveBeenCalledTimes(direct as number);
      expect(client.listTodoTasks).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['disabled', 'open', false],
    ['open', 'disabled', true],
    ['pairing', 'disabled', true],
    ['allowlist', 'disabled', true],
  ] as const)(
    'uses explicit privatePolicy=%s over dmPolicy=%s for direct sources',
    async (privatePolicy, dmPolicy, enabled) => {
      const { client, streams } = clientFixture();
      const channel = await ready(client, { privatePolicy, dmPolicy });
      await channel.poll();
      expect(streams.some(({ source }) => source.kind === 'direct')).toBe(
        enabled,
      );
      expect(client.listDirectMessages).toHaveBeenCalledTimes(enabled ? 1 : 0);
    },
  );

  it('subscribes allowlisted groups using the inherited mention setting', async () => {
    const { client, streams } = clientFixture();
    await ready(client, {
      groupPolicy: 'allowlist',
      privatePolicy: 'disabled',
      groups: {
        '*': { requireMention: false },
        'group-1': {},
        'group-2': { requireMention: true },
      },
    });
    expect(streams.map(({ source }) => source)).toEqual([
      { kind: 'at' },
      { kind: 'group', conversationId: 'group-1' },
    ]);
  });

  it('admits document notifications when direct chat is enabled', async () => {
    const { client, streams } = clientFixture();
    const channel = await ready(client);
    const direct = streams.find(({ source }) => source.kind === 'direct');
    expect(direct).toBeDefined();
    await deliver(direct!.onMessage(message(documentCard)));
    expect(client.readDocument).toHaveBeenCalledWith(
      'doc-1',
      expect.any(AbortSignal),
    );
    expect(channel.inbound).toHaveLength(1);
  });

  it('does not promote document notifications from disabled direct history', async () => {
    const { client } = clientFixture();
    vi.mocked(client.listDirectMessages).mockResolvedValue({
      messages: [message(documentCard)],
    });
    const channel = await ready(client, { dmPolicy: 'disabled' });
    await channel.poll();
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.readDocument).not.toHaveBeenCalled();
    expect(channel.inbound).toEqual([]);
  });

  it('parks disabled work and resumes pending work and old history pages after re-enabling', async () => {
    const first = await ready(clientFixture().client);
    first.seedPending();
    const initial = structuredClone(first.state());
    first.disconnect();
    const { client } = clientFixture();
    const disabled = await ready(client, {
      groupPolicy: 'disabled',
      dmPolicy: 'disabled',
    });
    await disabled.poll();
    await new Promise((resolve) => setImmediate(resolve));
    expect(disabled.inbound).toEqual([]);
    expect(client.readDocument).not.toHaveBeenCalled();
    expect(disabled.state()).toEqual(initial);
    disabled.disconnect();

    const resumedClient = clientFixture().client;
    vi.mocked(resumedClient.listDirectMessages).mockResolvedValue({
      messages: [
        {
          ...message('old direct history'),
          messageId: 'old-direct',
          eventTime: 1500,
        },
      ],
    });
    vi.mocked(resumedClient.listMentionedMessages).mockResolvedValue({
      messages: [
        {
          ...message('old group history'),
          type: 'user_im_message_receive_at',
          messageId: 'old-group',
          conversationId: 'group-1',
          eventTime: 1500,
        },
      ],
    });
    const resumed = await ready(resumedClient);
    expect(resumed.state()).toEqual(initial);
    await resumed.poll();
    await vi.waitFor(() => expect(resumed.inbound).toHaveLength(5));
    expect(resumedClient.listMentionedMessages).toHaveBeenCalledWith(
      1000,
      2000,
      expect.any(AbortSignal),
      'group-page-2',
    );
    expect(resumedClient.listDirectMessages).toHaveBeenCalledWith(
      1000,
      2000,
      expect.any(AbortSignal),
      'direct-page-2',
    );
    expect(resumed.inbound.map(({ messageId }) => messageId).sort()).toEqual([
      'doc-message-1',
      'group-message-1',
      'message-1',
      'old-direct',
      'old-group',
    ]);
    expect(resumed.state().pendingMessages).toEqual([]);
    expect(resumed.state().pendingDocuments).toEqual([]);
  });

  it('ignores retained live callbacks after their chat sources are disabled', async () => {
    const { client, streams } = clientFixture();
    const channel = await ready(client, {
      groups: { 'group-1': { requireMention: false } },
    });
    channel.disableChats();
    const before = structuredClone(channel.state());
    for (const { source, onMessage } of streams) {
      await deliver(
        onMessage({
          ...message(
            source.kind === 'direct' ? documentCard : 'late group message',
          ),
          messageId: `late-${source.kind}`,
          conversationId: source.kind === 'direct' ? 'direct-1' : 'group-1',
          type:
            source.kind === 'direct'
              ? 'user_im_message_receive_o2o_all'
              : source.kind === 'at'
                ? 'user_im_message_receive_at'
                : 'user_im_message_receive_group',
        }),
      );
    }
    expect(channel.inbound).toEqual([]);
    expect(client.readDocument).not.toHaveBeenCalled();
    expect(channel.state()).toEqual(before);
  });

  it('keeps disabled pending work from blocking enabled ambient groups at capacity', async () => {
    const { client, streams } = clientFixture();
    const channel = await ready(client, {
      dmPolicy: 'disabled',
      groups: { 'group-1': { requireMention: false } },
    });
    channel.seedDirectPending(5000);
    const group = streams.find(({ source }) => source.kind === 'group');
    expect(group).toBeDefined();
    await deliver(
      group!.onMessage({
        ...message('new group request'),
        type: 'user_im_message_receive_group',
        messageId: 'ambient-message',
        conversationId: 'group-1',
      }),
    );
    expect(channel.inbound.map(({ messageId }) => messageId)).toEqual([
      'ambient-message',
    ]);
    expect(channel.state().pendingMessages).toHaveLength(5000);
    expect(
      channel
        .state()
        .pendingMessages?.every(({ source }) => source.kind === 'direct'),
    ).toBe(true);
  });

  it('denies native todo agent work when private access is disabled', async () => {
    const { client } = clientFixture();
    const channel = await ready(client, {
      groupPolicy: 'disabled',
      privatePolicy: 'disabled',
      dmPolicy: 'open',
      watchTodos: true,
    });
    channel.forwardToBridge = true;
    await channel.poll();
    expect(channel.prompt).not.toHaveBeenCalled();
    const todo = {
      taskId: 'todo-1',
      title: 'Review todo',
      creatorId: 'open-alice',
      creatorName: 'Alice',
      data: {
        taskId: 'todo-1',
        subject: 'Review todo',
        creatorId: 'open-alice',
      },
    };
    vi.mocked(client.listTodoTasks).mockResolvedValue([todo]);
    vi.mocked(client.getTodoTask).mockResolvedValue(todo);
    await channel.poll();
    expect(channel.prompt).not.toHaveBeenCalled();
    expect(client.addTodoComment).not.toHaveBeenCalled();
    expect(client.listDirectMessages).not.toHaveBeenCalled();
    expect(client.listMentionedMessages).not.toHaveBeenCalled();
  });
});
