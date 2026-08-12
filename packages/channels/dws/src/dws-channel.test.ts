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
import type {
  DwsClientLike,
  DwsDocumentComment,
  DwsIdentity,
  DwsImMessage,
  DwsImSource,
  DwsImTarget,
} from './dws-client.js';
import type { DwsEventSubscription } from './dws-event-stream.js';

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
    disableAtMessages: false,
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
    userId: 'user-self',
    openDingTalkId: 'open-self',
  };
  comments = new Map<string, DwsDocumentComment[]>([['doc-1', []]]);
  wikiDocuments = new Map<string, string[]>([['wiki-1', ['doc-1']]]);
  streams: FakeStream[] = [];
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
  it('starts supported DWS message sources and ignores legacy groups', async () => {
    const client = new FakeDwsClient();

    await readyChannel(
      client,
      makeConfig({ imUserIds: ['user-2'], imGroupIds: ['cid-2'] }),
    );

    expect(client.assertAuthenticated).toHaveBeenCalledOnce();
    expect(client.streams.map((item) => item.source)).toEqual([
      { kind: 'at' },
      { kind: 'direct', userId: 'user-2' },
    ]);
  });

  it('requires a DWS user ID when document mentions are enabled', async () => {
    const client = new FakeDwsClient();
    client.identity = { openDingTalkId: 'open-self' };

    await expect(
      readyChannel(
        client,
        makeConfig({ disableAtMessages: true, wikiSpaceIds: ['wiki-1'] }),
      ),
    ).rejects.toThrow('user ID');
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
      makeConfig({ disableAtMessages: true, documentIds: ['doc-1'] }),
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
          disableAtMessages: true,
          documentIds: ['doc-1'],
          approvalMode: 'yolo',
        }),
      ),
    ).rejects.toThrow('require approvalMode');
  });

  it('gives workspace actions the configured DWS executable and profile', async () => {
    const client = new FakeDwsClient();
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

      expect(client.streams).toHaveLength(2);
      expect(client.streams[1]?.source).toEqual({ kind: 'at' });
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

  it('accepts direct messages from configured users and replies to that user', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(
      client,
      makeConfig({ disableAtMessages: true, imUserIds: ['user-2'] }),
    );

    await client.emit(
      0,
      message('user_im_message_receive_o2o', 'message-1', 'check my todo'),
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

  it('drops direct messages when direct-message access is disabled', async () => {
    const client = new FakeDwsClient();
    const { bridge } = await readyPolicyChannel(
      client,
      makeConfig({
        disableAtMessages: true,
        imUserIds: ['user-2'],
        dmPolicy: 'disabled',
      }),
    );

    await client.emit(
      0,
      message('user_im_message_receive_o2o', 'disabled-dm', 'please help'),
    );

    expect(bridge.prompt).not.toHaveBeenCalled();
  });

  it('applies group access policy to document comment threads', async () => {
    const client = new FakeDwsClient();
    client.comments.set('doc-2', []);
    const { channel, bridge } = await readyPolicyChannel(
      client,
      makeConfig({
        disableAtMessages: true,
        documentIds: ['doc-1', 'doc-2'],
        groupPolicy: 'allowlist',
        groups: { 'doc-2': {} },
      }),
    );
    await channel.poll();
    client.comments.set('doc-1', [
      comment('denied-document', 'do not run', {
        mentionedUserIds: ['user-self'],
      }),
    ]);
    client.comments.set('doc-2', [
      comment('allowed-document', 'please run', {
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
      makeConfig({ disableAtMessages: true, documentIds: ['doc-1'] }),
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
      makeConfig({ disableAtMessages: true, documentIds: ['doc-1'] }),
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
      makeConfig({ disableAtMessages: true, documentIds: ['doc-1'] }),
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
      makeConfig({ disableAtMessages: true, documentIds: ['doc-1'] }),
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
      makeConfig({ disableAtMessages: true, wikiSpaceIds: ['wiki-1'] }),
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
      makeConfig({ disableAtMessages: true, documentIds: ['doc-1'] }),
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
        disableAtMessages: true,
        documentIds: ['doc-1'],
        wikiSpaceIds: ['wiki-1'],
      }),
    );

    await expect(channel.poll()).resolves.toBeUndefined();
  });

  it('caches knowledge-base discovery between configured refreshes', async () => {
    const client = new FakeDwsClient();
    const channel = await readyChannel(
      client,
      makeConfig({
        disableAtMessages: true,
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
      makeConfig({ disableAtMessages: true, wikiSpaceIds: ['wiki-1'] }),
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
      makeConfig({ disableAtMessages: true, wikiSpaceIds: ['wiki-1'] }),
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
      makeConfig({ disableAtMessages: true, wikiSpaceIds: ['wiki-1'] }),
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

  it('persists successful document work across channel restarts', async () => {
    const client = new FakeDwsClient();
    const config = makeConfig({
      disableAtMessages: true,
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
      makeConfig({ disableAtMessages: true, documentIds: ['doc-1'] }),
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
      makeConfig({ disableAtMessages: true, documentIds: ['doc-1'] }),
    );
    channel.responseThreadId = 'root-1';

    await channel.respond('doc-1', 'final answer');

    expect(client.replyToComment).toHaveBeenCalledWith(
      'doc-1',
      'root-1',
      'final answer',
    );
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
        disableAtMessages: true,
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
      disableAtMessages: true,
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
      makeConfig({ disableAtMessages: true, wikiSpaceIds: ['wiki-1'] }),
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
        disableAtMessages: true,
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
