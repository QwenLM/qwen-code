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
  type DwsDocumentComment,
  type DwsIdentity,
  type DwsImMessage,
  type DwsImSource,
  type DwsImTarget,
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
    documentIds: [],
    wikiSpaceIds: [],
    wikiDiscoveryInterval: 0,
    trigger: '/qwen',
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

function comment(
  key: string,
  content: string,
  overrides: Partial<DwsDocumentComment> = {},
): DwsDocumentComment {
  return {
    key,
    content,
    authorId: 'alice',
    authorName: 'Alice',
    mentionedUserIds: [],
    replies: [],
    ...overrides,
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
    userId: 'user-self',
    openDingTalkId: 'open-self',
  };
  comments = new Map<string, DwsDocumentComment[]>([['doc-1', []]]);
  wikiDocuments = new Map<string, string[]>([['wiki-1', ['doc-1']]]);
  streams: FakeStream[] = [];
  assertAuthenticated = vi.fn(async () => Promise.resolve(this.identity));
  resolveCurrentOpenDingTalkId = vi.fn(async () =>
    Promise.resolve('open-self'),
  );
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
  listUnresolvedComments = vi.fn(
    async (documentId: string, _signal?: AbortSignal) =>
      Promise.resolve(this.comments.get(documentId) ?? []),
  );
  listWikiDocuments = vi.fn(
    async (wikiSpaceId: string, _signal?: AbortSignal) =>
      Promise.resolve(this.wikiDocuments.get(wikiSpaceId) ?? []),
  );
  readDocument = vi.fn(async (_documentId: string, _signal?: AbortSignal) =>
    Promise.resolve('# Plan\nUse DWS.'),
  );
  replyToComment = vi.fn().mockResolvedValue(undefined);

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

  it('requires a DWS user ID when document mentions are enabled', async () => {
    const client = new FakeDwsClient();
    client.identity = {
      profile: 'corp:user-self',
      openDingTalkId: 'open-self',
    };

    await expect(
      readyChannel(client, makeConfig({ wikiSpaceIds: ['wiki-1'] })),
    ).rejects.toThrow('user ID');
  });

  it('starts direct messages when DWS cannot resolve the current open DingTalk ID', async () => {
    const client = new FakeDwsClient();
    client.identity = { profile: 'corp:user-self' };
    client.resolveCurrentOpenDingTalkId.mockResolvedValue(undefined);

    await expect(readyChannel(client, makeConfig())).resolves.toBeDefined();
    expect(client.streams.map((item) => item.source)).toEqual([
      { kind: 'at' },
      { kind: 'direct' },
    ]);
  });

  it('falls back to echo learning when current open DingTalk ID lookup fails', async () => {
    const client = new FakeDwsClient();
    client.identity = { profile: 'corp:user-self', userId: 'user-self' };
    client.resolveCurrentOpenDingTalkId.mockRejectedValue(
      new Error('current-user lookup unavailable'),
    );

    await expect(readyChannel(client, makeConfig())).resolves.toBeDefined();
    expect(client.streams.map((item) => item.source)).toEqual([
      { kind: 'at' },
      { kind: 'direct' },
    ]);
  });

  it('starts ambient groups when DWS cannot resolve the current open DingTalk ID', async () => {
    const client = new FakeDwsClient();
    client.identity = { profile: 'corp:user-self' };
    client.resolveCurrentOpenDingTalkId.mockResolvedValue(undefined);

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
      makeConfig({ documentIds: ['doc-1'] }),
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
          documentIds: ['doc-1'],
          approvalMode: 'yolo',
        }),
      ),
    ).rejects.toThrow('require approvalMode');
  });

  it('gives workspace actions the configured DWS executable and profile', async () => {
    const client = new FakeDwsClient();
    client.identity.profile = 'corp:user';
    const channel = await readyChannel(
      client,
      makeConfig({ dwsPath: '/opt/dws', profile: 'corp:user' }),
    );

    expect(channel.instructions()).toContain(
      'invoke "/opt/dws" --profile "corp:user"',
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

  it('drops messages sent by the current DWS identity before pairing', async () => {
    const client = new FakeDwsClient();
    client.identity = { profile: 'corp:user-self', userId: 'user-self' };
    const { channel, bridge } = await readyPolicyChannel(
      client,
      makeConfig({ senderPolicy: 'pairing' }),
    );

    await client.emit(
      1,
      message(
        'user_im_message_receive_o2o_all',
        'self-message',
        'Your pairing code is ABC12345',
        { senderId: 'open-self', senderName: 'DataWorksAgent' },
      ),
    );

    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(client.sendImMessage).not.toHaveBeenCalled();
    expect(client.resolveCurrentOpenDingTalkId).toHaveBeenCalledWith(
      'user-self',
      expect.any(AbortSignal),
    );
    await expect(channel.sendMessage('cid-1', 'reply')).rejects.toThrow(
      'no DWS message target',
    );
  });

  it('consumes a tracked echo even when the self sender ID was already known', async () => {
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

  it('applies sender access policy independently to document comments', async () => {
    const client = new FakeDwsClient();
    const { channel, bridge } = await readyPolicyChannel(
      client,
      makeConfig({
        documentIds: ['doc-1'],
        groupPolicy: 'allowlist',
        groups: {},
        senderPolicy: 'allowlist',
        allowedUsers: ['bob'],
      }),
    );
    await channel.poll();
    client.comments.set('doc-1', [
      comment('denied-document', 'do not run', {
        authorId: 'alice',
        mentionedUserIds: ['user-self'],
      }),
      comment('allowed-document', 'please run', {
        authorId: 'bob',
        mentionedUserIds: ['user-self'],
      }),
    ]);

    await channel.poll();

    expect(bridge.prompt).toHaveBeenCalledOnce();
    expect(bridge.prompt).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('please run'),
      expect.any(Object),
    );
  });

  it('retries a document pairing notification that was not delivered', async () => {
    const client = new FakeDwsClient();
    const { channel, bridge } = await readyPolicyChannel(
      client,
      makeConfig({
        documentIds: ['doc-1'],
        senderPolicy: 'pairing',
      }),
    );
    await channel.poll();
    client.comments.set('doc-1', [
      comment('pair-document', 'please help', {
        mentionedUserIds: ['user-self'],
      }),
    ]);
    client.replyToComment.mockRejectedValueOnce(new Error('not sent'));

    await channel.poll();
    await channel.poll();

    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(client.replyToComment).toHaveBeenCalledTimes(2);
    expect(client.replyToComment).toHaveBeenLastCalledWith(
      'doc-1',
      'pair-document',
      expect.stringContaining('pairing code'),
    );
  });

  it('supports wildcard and per-document mention settings', async () => {
    const client = new FakeDwsClient();
    client.comments.set('doc-2', []);
    const channel = await readyChannel(
      client,
      makeConfig({
        documentIds: ['doc-1', 'doc-2'],
        documents: {
          '*': { requireMention: false },
          'doc-2': { requireMention: true },
        },
      }),
    );
    await channel.poll();
    client.comments.set('doc-1', [comment('ambient', 'run everywhere')]);
    client.comments.set('doc-2', [comment('needs-at', 'do not run')]);

    await channel.poll();

    expect(channel.inbound).toEqual([
      expect.objectContaining({ chatId: 'doc-1', text: 'run everywhere' }),
    ]);
  });

  it('rejects unsafe document polling intervals', () => {
    expect(
      () =>
        new DwsChannel(
          'fast-dws',
          makeConfig({ pollInterval: 1 }),
          makeBridge(),
        ),
    ).toThrow('at least 5000');
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

  it('bootstraps document comments, then dispatches new work with context', async () => {
    const client = new FakeDwsClient();
    client.comments.set('doc-1', [comment('old', '/qwen old request')]);
    const channel = await readyChannel(
      client,
      makeConfig({ documentIds: ['doc-1'] }),
    );

    await channel.poll();
    client.comments.set('doc-1', [
      comment('old', '/qwen old request'),
      comment('new', '/qwen summarize this', {
        selectedText: 'Use DWS.',
      }),
    ]);
    await channel.poll();

    expect(channel.inbound).toEqual([
      expect.objectContaining({
        chatId: 'doc-1',
        threadId: 'new',
        text: 'summarize this',
        referencedText: 'Use DWS.',
      }),
    ]);
    expect(channel.inbound[0]?.metadata).toContain('# Plan\nUse DWS.');
  });

  it('dispatches when an existing comment is edited to mention the DWS user', async () => {
    const client = new FakeDwsClient();
    client.comments.set('doc-1', [comment('existing', 'please review')]);
    const channel = await readyChannel(
      client,
      makeConfig({ documentIds: ['doc-1'] }),
    );

    await channel.poll();
    client.comments.set('doc-1', [
      comment('existing', 'please review', {
        mentionedUserIds: ['user-self'],
      }),
    ]);
    await channel.poll();

    expect(channel.inbound).toEqual([
      expect.objectContaining({ text: 'please review' }),
    ]);
  });

  it('ignores document mentions for other users and comments from itself', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(
      client,
      makeConfig({ documentIds: ['doc-1'] }),
    );
    await channel.poll();
    client.comments.set('doc-1', [
      comment('other', 'review for someone else', {
        mentionedUserIds: ['user-other'],
      }),
      comment('self', 'self-authored review', {
        authorId: 'user-self',
        mentionedUserIds: ['user-self'],
      }),
    ]);

    await channel.poll();

    expect(channel.inbound).toHaveLength(0);
  });

  it('keeps processed comment versions per document beyond the global message cache', async () => {
    const client = new FakeDwsClient();
    client.comments.set(
      'doc-1',
      Array.from({ length: 5_001 }, (_, index) =>
        comment(`comment-${index}`, `request ${index}`, {
          mentionedUserIds: ['user-self'],
        }),
      ),
    );
    const channel = await readyChannel(
      client,
      makeConfig({ documentIds: ['doc-1'] }),
    );

    await channel.poll();
    await channel.poll();

    expect(channel.inbound).toHaveLength(0);
  });

  it('stops an in-progress knowledge-base discovery without dispatching work', async () => {
    const client = new FakeDwsClient();
    client.listWikiDocuments.mockImplementation(
      async (_wikiSpaceId: string, signal?: AbortSignal) =>
        new Promise<string[]>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const channel = await readyChannel(
      client,
      makeConfig({ wikiSpaceIds: ['wiki-1'] }),
    );

    const poll = channel.poll();
    channel.disconnect();

    await expect(poll).resolves.toBeUndefined();
    expect(channel.inbound).toHaveLength(0);
  });

  it('bounds untrusted document comment and selected-text input', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(
      client,
      makeConfig({ documentIds: ['doc-1'] }),
    );
    await channel.poll();
    client.comments.set('doc-1', [
      comment('large', 'x'.repeat(6_000), {
        mentionedUserIds: ['user-self'],
        selectedText: 'y'.repeat(3_000),
      }),
    ]);

    await channel.poll();

    expect(channel.inbound[0]?.text).toHaveLength(4_000);
    expect(channel.inbound[0]?.referencedText).toHaveLength(2_000);
    expect(channel.inbound[0]?.metadata).not.toContain('y'.repeat(100));
  });

  it('keeps the configured poll cadence when one knowledge base fails', async () => {
    const client = new FakeDwsClient();
    client.listWikiDocuments.mockRejectedValue(new Error('forbidden'));
    const channel = await readyChannel(
      client,
      makeConfig({
        documentIds: ['doc-1'],
        wikiSpaceIds: ['wiki-1'],
      }),
    );

    await expect(channel.poll()).resolves.toBeUndefined();
  });

  it('keeps newly discovered wiki documents live after an initial document failure', async () => {
    const client = new FakeDwsClient();
    client.listUnresolvedComments.mockRejectedValueOnce(new Error('forbidden'));
    const channel = await readyChannel(
      client,
      makeConfig({ wikiSpaceIds: ['wiki-1'] }),
    );

    await channel.poll();
    client.wikiDocuments.set('wiki-1', ['doc-1', 'doc-2']);
    client.comments.set('doc-2', [
      comment('new', 'review the new document', {
        mentionedUserIds: ['user-self'],
      }),
    ]);
    await channel.poll();

    expect(channel.inbound).toEqual([
      expect.objectContaining({
        chatId: 'doc-2',
        text: 'review the new document',
      }),
    ]);
  });

  it('caches knowledge-base discovery between configured refreshes', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(
      client,
      makeConfig({
        wikiSpaceIds: ['wiki-1'],
        wikiDiscoveryInterval: 300_000,
      }),
    );

    await channel.poll();
    await channel.poll();

    expect(client.listWikiDocuments).toHaveBeenCalledOnce();
    expect(client.listUnresolvedComments).toHaveBeenCalledTimes(2);
  });

  it('bootstraps a wiki document that disappears and later returns', async () => {
    const client = new FakeDwsClient();
    client.comments.set('doc-1', [
      comment('existing', 'already handled', {
        mentionedUserIds: ['user-self'],
      }),
    ]);
    const channel = await readyChannel(
      client,
      makeConfig({ wikiSpaceIds: ['wiki-1'] }),
    );

    await channel.poll();
    client.wikiDocuments.set('wiki-1', []);
    await channel.poll();
    await channel.poll();
    client.wikiDocuments.set('wiki-1', ['doc-1']);
    await channel.poll();

    expect(channel.inbound).toHaveLength(0);
  });

  it('keeps remaining wiki documents live while another document is absent', async () => {
    const client = new FakeDwsClient();
    client.wikiDocuments.set('wiki-1', ['doc-1', 'doc-2']);
    client.comments.set('doc-1', [
      comment('existing-1', 'already handled one', {
        mentionedUserIds: ['user-self'],
      }),
    ]);
    client.comments.set('doc-2', [
      comment('existing-2', 'already handled two', {
        mentionedUserIds: ['user-self'],
      }),
    ]);
    const channel = await readyChannel(
      client,
      makeConfig({ wikiSpaceIds: ['wiki-1'] }),
    );
    await channel.poll();

    client.wikiDocuments.set('wiki-1', ['doc-2']);
    client.comments.get('doc-2')?.push(
      comment('new-2', 'new work two', {
        mentionedUserIds: ['user-self'],
      }),
    );
    await channel.poll();
    await channel.poll();

    client.wikiDocuments.set('wiki-1', ['doc-1', 'doc-2']);
    client.comments.get('doc-1')?.push(
      comment('new-1', 'new work one', {
        mentionedUserIds: ['user-self'],
      }),
    );
    await channel.poll();

    expect(channel.inbound.map((item) => item.text)).toEqual([
      'new work two',
      'new work one',
    ]);
  });

  it('scans large knowledge bases with a bounded round-robin budget', async () => {
    const client = new FakeDwsClient();
    const documents = Array.from({ length: 120 }, (_, index) => `doc-${index}`);
    client.wikiDocuments.set('wiki-1', documents);
    const channel = await readyChannel(
      client,
      makeConfig({ wikiSpaceIds: ['wiki-1'] }),
    );

    await channel.poll();
    const firstPollCalls = client.listUnresolvedComments.mock.calls.length;
    await channel.poll();
    const secondPollCalls =
      client.listUnresolvedComments.mock.calls.length - firstPollCalls;
    await channel.poll();
    const thirdPollCalls =
      client.listUnresolvedComments.mock.calls.length -
      firstPollCalls -
      secondPollCalls;
    const polledDocuments = new Set(
      client.listUnresolvedComments.mock.calls.map(([documentId]) =>
        String(documentId),
      ),
    );

    expect([firstPollCalls, secondPollCalls, thirdPollCalls]).toEqual([
      50, 50, 50,
    ]);
    expect(polledDocuments).toEqual(new Set(documents));
  });

  it('rotates past persistently failing uninitialized wiki documents', async () => {
    const client = new FakeDwsClient();
    const documents = Array.from({ length: 60 }, (_, index) => `doc-${index}`);
    client.wikiDocuments.set('wiki-1', documents);
    client.listUnresolvedComments.mockImplementation(async (documentId) => {
      if (Number(documentId.slice(4)) < 50) throw new Error('forbidden');
      return [];
    });
    const channel = await readyChannel(
      client,
      makeConfig({ wikiSpaceIds: ['wiki-1'] }),
    );

    await channel.poll();
    await channel.poll();

    expect(client.listUnresolvedComments).toHaveBeenCalledWith(
      'doc-55',
      expect.any(AbortSignal),
    );
  });

  it('persists successful document work across channel restarts', async () => {
    const client = new FakeDwsClient();
    const config = makeConfig({
      documentIds: ['doc-1'],
    });
    const first = await readyChannel(client, config, 'persistent-doc');
    await first.poll();
    client.comments.set('doc-1', [comment('new', '/qwen once')]);
    await first.poll();
    first.disconnect();

    const second = await readyChannel(client, config, 'persistent-doc');
    await second.poll();

    expect(first.inbound.map((item) => item.text)).toEqual(['once']);
    expect(second.inbound).toHaveLength(0);
  });

  it('does not redispatch a document comment after it is reopened', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(
      client,
      makeConfig({ documentIds: ['doc-1'] }),
    );
    await channel.poll();
    const request = comment('new', '/qwen once');
    client.comments.set('doc-1', [request]);
    await channel.poll();
    client.comments.set('doc-1', []);
    await channel.poll();
    client.comments.set('doc-1', [request]);
    await channel.poll();

    expect(channel.inbound.map((item) => item.text)).toEqual(['once']);
  });

  it('returns document output to the originating root comment', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(
      client,
      makeConfig({ documentIds: ['doc-1'] }),
    );
    channel.responseThreadId = 'root-1';

    await channel.respond('doc-1', 'final answer');

    expect(client.replyToComment).toHaveBeenCalledWith(
      'doc-1',
      'root-1',
      'final answer',
    );
  });

  it('does not rerun a document task after an ambiguous reply failure', async () => {
    const client = new FakeDwsClient();
    const { channel, bridge } = await readyPolicyChannel(
      client,
      makeConfig({ documentIds: ['doc-1'] }),
      'ambiguous-doc-reply',
    );
    await channel.poll();
    client.comments.set('doc-1', [comment('new', '/qwen once')]);
    client.replyToComment.mockRejectedValue(
      new DwsCommandError('connection reset', 'unknown'),
    );

    await channel.poll();
    await channel.poll();

    expect(bridge.prompt).toHaveBeenCalledOnce();
    expect(client.replyToComment).toHaveBeenCalledOnce();
  });

  it('does not swallow a document reply that failed before delivery', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(
      client,
      makeConfig({ documentIds: ['doc-1'] }),
    );

    channel.responseThreadId = 'root-1';
    client.replyToComment.mockRejectedValueOnce(
      new DwsCommandError('not sent', 'not_sent'),
    );

    await expect(channel.respond('doc-1', 'final answer')).rejects.toThrow(
      'not sent',
    );
    expect(client.replyToComment).toHaveBeenCalledOnce();
  });

  it('reacts to a mention in a document added to a watched knowledge base', async () => {
    const client = new FakeDwsClient();
    client.comments.set('doc-1', [
      comment('old', 'historical request', {
        mentionedUserIds: ['user-self'],
      }),
    ]);
    const channel = await readyChannel(
      client,
      makeConfig({
        wikiSpaceIds: ['https://alidocs.dingtalk.com/i/spaces/wiki-1/overview'],
      }),
    );

    await channel.poll();
    client.wikiDocuments.set('wiki-1', ['doc-1', 'doc-2']);
    client.comments.set('doc-2', [
      comment('new', 'summarize this document', {
        mentionedUserIds: ['user-self'],
      }),
    ]);
    await channel.poll();

    expect(channel.inbound).toEqual([
      expect.objectContaining({
        chatId: 'doc-2',
        threadId: 'new',
        text: 'summarize this document',
      }),
    ]);
    channel.responseThreadId = 'new';
    await channel.respond('doc-2', 'final answer');
    expect(client.replyToComment).toHaveBeenCalledWith(
      'doc-2',
      'new',
      'final answer',
    );
  });

  it('discovers documents added to a knowledge base while the channel was stopped', async () => {
    const client = new FakeDwsClient();
    const config = makeConfig({
      wikiSpaceIds: ['wiki-1'],
    });
    const first = await readyChannel(client, config, 'persistent-wiki');
    await first.poll();
    first.disconnect();

    client.wikiDocuments.set('wiki-1', ['doc-1', 'doc-2']);
    client.comments.set('doc-2', [
      comment('new', 'review after restart', {
        mentionedUserIds: ['user-self'],
      }),
    ]);
    const second = await readyChannel(client, config, 'persistent-wiki');
    await second.poll();

    expect(second.inbound).toEqual([
      expect.objectContaining({
        chatId: 'doc-2',
        text: 'review after restart',
      }),
    ]);
  });

  it('keeps knowledge-base live semantics when a new document is also configured directly', async () => {
    const client = new FakeDwsClient();
    const first = await readyChannel(
      client,
      makeConfig({ wikiSpaceIds: ['wiki-1'] }),
      'merged-sources',
    );
    await first.poll();
    first.disconnect();

    client.wikiDocuments.set('wiki-1', ['doc-1', 'doc-2']);
    client.comments.set('doc-2', [
      comment('new', 'review merged source', {
        mentionedUserIds: ['user-self'],
      }),
    ]);
    client.listUnresolvedComments.mockClear();
    const second = await readyChannel(
      client,
      makeConfig({
        documentIds: ['doc-2'],
        wikiSpaceIds: ['wiki-1'],
      }),
      'merged-sources',
    );
    await second.poll();

    expect(second.inbound).toEqual([
      expect.objectContaining({ text: 'review merged source' }),
    ]);
    expect(client.listUnresolvedComments).toHaveBeenCalledTimes(2);
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
