import { describe, it, expect, vi, beforeEach } from 'vitest';

type SendResult = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

const { mockSendQQMessage, mockFetchAccessToken, mockNewSession, mockPrompt } =
  vi.hoisted(() => ({
    mockSendQQMessage:
      vi.fn<
        (
          base: string,
          path: string,
          accessToken: string,
          body: Record<string, unknown>,
        ) => Promise<SendResult>
      >(),
    mockFetchAccessToken: vi.fn(),
    mockNewSession: vi.fn(),
    mockPrompt: vi.fn(),
  }));

vi.mock('ws', () => ({
  default: class {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    on(): this {
      return this;
    }
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    appendFileSync: vi.fn(),
    chmodSync: vi.fn(),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    mkdtempSync: vi.fn(() => '/tmp/test-qq-loop-'),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(),
    renameSync: vi.fn(),
    rmSync: vi.fn(),
    statSync: vi.fn(),
    symlinkSync: vi.fn(),
    unlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

vi.mock('./api.js', () => ({
  sendQQMessage: mockSendQQMessage,
  requestQQApi: vi.fn(),
  getApiBase: () => 'https://api.sgroup.qq.com',
  fetchAccessToken: mockFetchAccessToken,
  fetchGatewayUrl: vi.fn(),
  uploadQQRichMedia: vi.fn(),
  parseQQErrorCode: () => undefined,
  QQRichMediaError: class extends Error {},
}));

vi.mock('./accounts.js', () => ({
  getCredsFilePath: () => '/tmp/test-creds.json',
  loadCredentials: () => null,
  saveCredentials: vi.fn(),
}));

vi.mock('./login.js', () => ({
  qrCodeLogin: vi.fn(),
}));

const { QQChannel, DeliveryError } = await import('./QQChannel.js');
import { OpCode } from './types.js';
import { isChannelProactiveDeliveryError } from '@qwen-code/channel-base';
import type {
  ChannelAgentBridge,
  ChannelLoop,
  ChannelLoopController,
  ChannelLoopInput,
  ChannelLoopToolHandler,
  SessionRouter,
  SessionTarget,
} from '@qwen-code/channel-base';

const CHAT_ID = 'group-openid-1';
const SENDER_ID = 'member-1';
const SESSION_ID = 'session-1';

interface RawChannel {
  accessToken: string;
  tokenExpiresAt: number;
  chatTypeMap: Map<string, 'c2c' | 'group'>;
  replyMsgId: Map<string, { msgId: string; timestamp: number }>;
  replyContextByMessageId: Map<
    string,
    { chatId: string; msgId: string; timestamp: number }
  >;
  activePrompts: Map<string, { messageId?: string }>;
  groupActiveMsgEnabled: Map<string, boolean>;
  router: SessionRouter;
}

type ChunkListener = (sessionId: string, chunk: string) => void;

function makeBridge(): {
  bridge: ChannelAgentBridge;
  getLoopHandler: () => ChannelLoopToolHandler | undefined;
  getChunkListener: () => ChunkListener | undefined;
} {
  let loopHandler: ChannelLoopToolHandler | undefined;
  let chunkListener: ChunkListener | undefined;
  const bridge = {
    newSession: mockNewSession,
    prompt: mockPrompt,
    on: vi.fn((event: string, listener: ChunkListener) => {
      if (event === 'textChunk') chunkListener = listener;
    }),
    off: vi.fn(),
    registerChannelLoopToolHandler: vi.fn((handler: ChannelLoopToolHandler) => {
      loopHandler = handler;
    }),
  };
  return {
    bridge: bridge as unknown as ChannelAgentBridge,
    getLoopHandler: () => loopHandler,
    getChunkListener: () => chunkListener,
  };
}

function makeLoopController(): {
  controller: ChannelLoopController;
  jobs: Map<string, ChannelLoop>;
} {
  const jobs = new Map<string, ChannelLoop>();
  const controller: ChannelLoopController = {
    create: vi.fn(async () => {
      throw new Error('create must not be called');
    }),
    createForTarget: vi.fn(
      async (input: ChannelLoopInput): Promise<ChannelLoop> => {
        const job: ChannelLoop = {
          ...input,
          id: `job-${jobs.size + 1}`,
          enabled: true,
          createdAt: '2026-06-30T01:02:03.000Z',
          consecutiveFailures: 0,
          runCount: 0,
        };
        jobs.set(job.id, job);
        return job;
      },
    ),
    listForTarget: vi.fn(async () => [...jobs.values()]),
    listForChat: vi.fn(async (channelName: string, chatId: string) =>
      [...jobs.values()].filter(
        (job) =>
          job.channelName === channelName && job.target.chatId === chatId,
      ),
    ),
    disable: vi.fn(async (id: string) => {
      const job = jobs.get(id);
      if (!job) return false;
      job.enabled = false;
      return true;
    }),
    validateCron: vi.fn(),
  };
  return { controller, jobs };
}

function makeChannel(configOverrides: Record<string, unknown> = {}): {
  ch: InstanceType<typeof QQChannel>;
  raw: RawChannel;
  controller: ChannelLoopController;
  jobs: Map<string, ChannelLoop>;
  getLoopHandler: () => ChannelLoopToolHandler | undefined;
  getChunkListener: () => ChunkListener | undefined;
} {
  const { controller, jobs } = makeLoopController();
  const { bridge, getLoopHandler, getChunkListener } = makeBridge();
  const ch = new QQChannel(
    'test-bot',
    {
      type: 'qq',
      token: '',
      senderPolicy: 'open' as const,
      allowedUsers: [],
      sessionScope: 'user' as const,
      cwd: '/tmp',
      groupPolicy: 'open' as const,
      groups: {},
      dmPolicy: 'open' as const,
      appID: 'test-app-id',
      appSecret: 'test-secret',
      ...configOverrides,
    },
    bridge,
    { loopController: controller, registerBridgeEvents: false },
  );
  const raw = ch as unknown as RawChannel;
  raw.accessToken = 'test-token';
  raw.tokenExpiresAt = Date.now() + 3_600_000;
  raw.chatTypeMap.set(CHAT_ID, 'group');
  return { ch, raw, controller, jobs, getLoopHandler, getChunkListener };
}

type GroupLifecycleHandler = 'handleGroupDelRobot' | 'handleGroupMsgToggle';

async function invokeGroupLifecycleHandler(
  ch: InstanceType<typeof QQChannel>,
  handler: GroupLifecycleHandler,
  ...args: unknown[]
): Promise<void> {
  const pvt = ch as unknown as Record<
    string,
    (...params: unknown[]) => unknown
  >;
  await pvt[handler]!(...args);
}

function isProactiveTargetSupported(
  ch: InstanceType<typeof QQChannel>,
  target: SessionTarget,
): boolean {
  const pvt = ch as unknown as {
    supportsProactiveTarget(target: SessionTarget): boolean;
  };
  return pvt.supportsProactiveTarget(target);
}

function loopJob(): ChannelLoop {
  return {
    id: 'job-1',
    channelName: 'test-bot',
    target: {
      channelName: 'test-bot',
      senderId: SENDER_ID,
      chatId: CHAT_ID,
      isGroup: true,
    },
    cwd: '/tmp',
    cron: '*/5 * * * *',
    prompt: 'summarize the day',
    label: 'summarize the day',
    recurring: true,
    enabled: true,
    createdBy: SENDER_ID,
    createdAt: '2026-06-30T01:02:03.000Z',
    consecutiveFailures: 0,
    runCount: 0,
  };
}

async function bindSession(raw: RawChannel): Promise<string> {
  return raw.router.resolve(
    'test-bot',
    SENDER_ID,
    CHAT_ID,
    undefined,
    '/tmp',
    true,
  );
}

function groupTarget(): SessionTarget {
  return {
    channelName: 'test-bot',
    senderId: SENDER_ID,
    chatId: CHAT_ID,
    isGroup: true,
  };
}

/**
 * A fresh inbound anchor for a live turn: the per-session message id plus its
 * reply context, exactly what resolveResponseReplyContext reads.
 */
function primeFreshAnchor(
  raw: RawChannel,
  sessionId: string,
  msgId: string,
): void {
  raw.replyContextByMessageId.set(msgId, {
    chatId: CHAT_ID,
    msgId,
    timestamp: Date.now(),
  });
  raw.activePrompts.set(sessionId, { messageId: msgId });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNewSession.mockResolvedValue(SESSION_ID);
});

describe('QQ channel proactive loops', () => {
  it('supports proactive send', () => {
    const { ch } = makeChannel();
    expect(ch.supportsProactiveSend()).toBe(true);
  });

  it('creates a loop through the channel loop tool', async () => {
    const { raw, controller, getLoopHandler } = makeChannel();
    const sessionId = await bindSession(raw);
    const handler = getLoopHandler();
    expect(handler).toBeDefined();

    const result = await handler!.create(sessionId, {
      cron: '*/5 * * * *',
      prompt: 'drink water',
    });

    expect(result).toBe('Loop job-1: */5 * * * *');
    expect(controller.createForTarget).toHaveBeenCalledWith(
      {
        channelName: 'test-bot',
        target: {
          channelName: 'test-bot',
          senderId: SENDER_ID,
          chatId: CHAT_ID,
          threadId: undefined,
          isGroup: true,
        },
        cwd: '/tmp',
        cron: '*/5 * * * *',
        prompt: 'drink water',
        label: 'drink water',
        recurring: true,
        createdBy: SENDER_ID,
      },
      10,
    );
  });

  it('lists and cancels the loop for the session target', async () => {
    const { raw, getLoopHandler } = makeChannel();
    const sessionId = await bindSession(raw);
    const handler = getLoopHandler()!;
    await handler.create(sessionId, {
      cron: '*/5 * * * *',
      prompt: 'drink water',
    });

    const listed = await handler.list(sessionId);
    expect(listed).toContain('job-1');
    expect(listed).toContain('enabled');

    await expect(handler.cancel(sessionId, 'job-1')).resolves.toBe(
      'Cancelled loop job-1.',
    );
    const after = await handler.list(sessionId);
    expect(after).toContain('disabled');
  });

  it('delivers the loop result as an active QQ group message', async () => {
    const { ch, raw } = makeChannel();
    await bindSession(raw);
    mockPrompt.mockResolvedValue('Scheduled summary');
    mockSendQQMessage.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    });

    await expect(ch.runLoopPrompt(loopJob())).resolves.toBe(
      'Scheduled summary',
    );

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const [base, path, , body] = mockSendQQMessage.mock.calls[0]!;
    expect(base).toBe('https://api.sgroup.qq.com');
    expect(path).toBe(`/v2/groups/${CHAT_ID}/messages`);
    expect(body).toEqual({
      msg_type: 2,
      markdown: { content: 'Scheduled summary' },
    });
    expect(body).not.toHaveProperty('msg_id');
    expect(body).not.toHaveProperty('msg_seq');
  });

  it('keeps the loop delivery active when the chat has a fresh inbound anchor', async () => {
    const { ch, raw } = makeChannel();
    await bindSession(raw);
    // A recent inbound message leaves a chat-level reply anchor; a loop
    // delivery must not be re-parented onto it as a passive reply.
    raw.replyMsgId.set(CHAT_ID, {
      msgId: 'inbound-anchor-msg-1',
      timestamp: Date.now(),
    });
    mockPrompt.mockResolvedValue('Scheduled summary');
    mockSendQQMessage.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    });

    await expect(ch.runLoopPrompt(loopJob())).resolves.toBe(
      'Scheduled summary',
    );

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const body = mockSendQQMessage.mock.calls[0]![3];
    expect(body).not.toHaveProperty('msg_id');
    expect(body).not.toHaveProperty('msg_seq');
  });

  it('falls back to an active plain-text send when active markdown is rejected', async () => {
    const { ch, raw } = makeChannel();
    await bindSession(raw);
    mockPrompt.mockResolvedValue('Scheduled summary');
    mockSendQQMessage
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });

    await expect(ch.runLoopPrompt(loopJob())).resolves.toBe(
      'Scheduled summary',
    );

    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    const fallbackBody = mockSendQQMessage.mock.calls[1]![3];
    expect(fallbackBody).toEqual({
      content: 'Scheduled summary',
      msg_type: 0,
    });
    expect(fallbackBody).not.toHaveProperty('msg_id');
    expect(fallbackBody).not.toHaveProperty('msg_seq');
  });

  it('refuses to start a loop when the group active-message toggle is off', async () => {
    const { ch, raw } = makeChannel();
    await bindSession(raw);
    // The anchor must not turn the loop delivery into a passive reply that
    // bypasses the active-message toggle.
    raw.replyMsgId.set(CHAT_ID, {
      msgId: 'inbound-anchor-msg-1',
      timestamp: Date.now(),
    });
    raw.groupActiveMsgEnabled.set(CHAT_ID, false);

    await expect(ch.runLoopPrompt(loopJob())).rejects.toThrow(
      'Channel does not support proactive loop messages for this chat target.',
    );
    // The gate runs before the turn starts, so no unattended agent turn is
    // burned on a target that cannot receive the result.
    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('refuses to create a loop when the group active-message toggle is off', async () => {
    const { raw, controller, getLoopHandler } = makeChannel();
    const sessionId = await bindSession(raw);
    raw.groupActiveMsgEnabled.set(CHAT_ID, false);

    const result = await getLoopHandler()!.create(sessionId, {
      cron: '*/5 * * * *',
      prompt: 'drink water',
    });

    expect(result).toEqual({
      text: 'This channel does not support proactive loop messages for this chat target.',
      isError: true,
    });
    expect(controller.createForTarget).not.toHaveBeenCalled();
  });

  it('does not apply the group active-message toggle to direct messages', () => {
    const { ch, raw } = makeChannel();
    // A stale/foreign group toggle entry must never block a C2C target.
    raw.groupActiveMsgEnabled.set('dm-chat-1', false);
    raw.chatTypeMap.set('dm-chat-1', 'c2c');

    expect(
      isProactiveTargetSupported(ch, {
        channelName: 'test-bot',
        senderId: SENDER_ID,
        chatId: 'dm-chat-1',
        isGroup: false,
      }),
    ).toBe(true);
  });

  it('gates a group declared only in qqConfig.chatTypes on the toggle', async () => {
    // The chat type is learned from the channel config, not chatTypeMap, so
    // the gate must resolve it through chatTypeFor — the same accessor
    // resolveRoute routes on. The target omits isGroup (the webhook and
    // persisted-loop shape).
    const { ch, raw } = makeChannel({
      chatTypes: { [CHAT_ID]: 'group' },
    });
    // Declared only in the channel config: chatTypeMap has never learned it.
    raw.chatTypeMap.delete(CHAT_ID);
    raw.groupActiveMsgEnabled.set(CHAT_ID, false);
    const target: SessionTarget = {
      channelName: 'test-bot',
      senderId: SENDER_ID,
      chatId: CHAT_ID,
    };

    expect(isProactiveTargetSupported(ch, target)).toBe(false);
    await expect(ch.runLoopPrompt({ ...loopJob(), target })).rejects.toThrow(
      'Channel does not support proactive loop messages for this chat target.',
    );
    // The gate runs before the turn starts, so no unattended agent turn is
    // burned on a target that cannot receive the result.
    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('rejects a group target whose chat type was never learned', () => {
    const { ch } = makeChannel();
    const target: SessionTarget = {
      channelName: 'test-bot',
      senderId: SENDER_ID,
      chatId: 'group-openid-unseen',
      isGroup: true,
    };

    // resolveRoute would refuse this after the turn ran (no chat type), so the
    // gate must reject it up front to avoid burning the unattended turn.
    expect(isProactiveTargetSupported(ch, target)).toBe(false);
  });

  it('disables the group loops when the bot is removed from the group', async () => {
    const { ch, raw, controller, jobs, getLoopHandler } = makeChannel();
    const sessionId = await bindSession(raw);
    await getLoopHandler()!.create(sessionId, {
      cron: '*/5 * * * *',
      prompt: 'drink water',
    });
    expect(jobs.get('job-1')?.enabled).toBe(true);

    await invokeGroupLifecycleHandler(ch, 'handleGroupDelRobot', {
      group_openid: CHAT_ID,
      op_member_openid: 'admin-1',
      timestamp: Date.now(),
    });

    expect(controller.listForChat).toHaveBeenCalledWith('test-bot', CHAT_ID);
    expect(controller.disable).toHaveBeenCalledWith('job-1');
    expect(jobs.get('job-1')?.enabled).toBe(false);
  });

  it('keeps the group loops when active messages are toggled off and on', async () => {
    const { ch, raw, controller, jobs, getLoopHandler } = makeChannel();
    const sessionId = await bindSession(raw);
    await getLoopHandler()!.create(sessionId, {
      cron: '*/5 * * * *',
      prompt: 'drink water',
    });
    expect(jobs.get('job-1')?.enabled).toBe(true);

    const toggle = { group_openid: CHAT_ID, timestamp: Date.now() };
    await invokeGroupLifecycleHandler(
      ch,
      'handleGroupMsgToggle',
      { ...toggle, op_member_openid: 'admin-1' },
      false,
    );
    await invokeGroupLifecycleHandler(
      ch,
      'handleGroupMsgToggle',
      { ...toggle, op_member_openid: 'admin-1' },
      true,
    );

    // A toggle is reversible, so the handler must not retire loops: the
    // pre-flight target gate already refuses the next fire (no turn burned)
    // while the toggle is off, and a loop left failing is retired by the
    // scheduler's 5-consecutive-failure limit. Only handleGroupDelRobot
    // disables eagerly, because the gate cannot see a removal.
    expect(controller.disable).not.toHaveBeenCalled();
    expect(jobs.get('job-1')?.enabled).toBe(true);
    expect(raw.groupActiveMsgEnabled.get(CHAT_ID)).toBe(true);
  });

  it('delivers a background response unanchored despite a fresh anchor', async () => {
    const { ch, raw } = makeChannel();
    const sessionId = await bindSession(raw);
    // A live turn leaves a chat-level reply anchor behind. An unattended
    // background/named-task result is not that turn's reply and must not be
    // re-parented onto it as a passive reply.
    primeFreshAnchor(raw, sessionId, 'inbound-bg-anchor-1');
    mockSendQQMessage.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    });

    await ch.dispatchBackgroundResponse(sessionId, 'background result');

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const [base, path, , body] = mockSendQQMessage.mock.calls[0]!;
    expect(base).toBe('https://api.sgroup.qq.com');
    expect(path).toBe(`/v2/groups/${CHAT_ID}/messages`);
    expect(body).toEqual({
      msg_type: 2,
      markdown: { content: 'background result' },
    });
    expect(body).not.toHaveProperty('msg_id');
    expect(body).not.toHaveProperty('msg_seq');
  });

  it('fails a background response for a toggle-off group instead of anchoring it', async () => {
    const { ch, raw } = makeChannel();
    const sessionId = await bindSession(raw);
    primeFreshAnchor(raw, sessionId, 'inbound-bg-anchor-2');
    raw.groupActiveMsgEnabled.set(CHAT_ID, false);

    const err: unknown = await ch
      .dispatchBackgroundResponse(sessionId, 'background result')
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // The anchored fallback (base's deliverBackgroundReply) would bypass the
    // active-message toggle through msg_id/msg_seq, so the delivery must fail
    // permanently instead of quietly receiving it as a passive reply.
    expect(isChannelProactiveDeliveryError(err)).toBe(true);
    expect(err).toMatchObject({ disposition: 'permanent' });
    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('reports a disabled active-message toggle as a permanent proactive failure', async () => {
    const { ch, raw } = makeChannel();
    raw.groupActiveMsgEnabled.set(CHAT_ID, false);

    const err: unknown = await ch
      .deliverProactive(
        { channelName: 'test-bot', type: 'chat', id: CHAT_ID },
        'Scheduled summary',
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(isChannelProactiveDeliveryError(err)).toBe(true);
    expect(err).toMatchObject({ disposition: 'permanent' });
    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('keeps a mid-flight disabled toggle permanent on the delivery arm', async () => {
    const { ch, raw } = makeChannel();
    raw.groupActiveMsgEnabled.set(CHAT_ID, false);
    const target: SessionTarget = {
      channelName: 'test-bot',
      senderId: SENDER_ID,
      chatId: CHAT_ID,
      isGroup: true,
    };

    // The target gate can pass before the toggle flips; the delivery arm must
    // still classify the resulting ACTIVE_MSG_DISABLED as permanent.
    const err: unknown = await (
      ch as unknown as {
        pushProactive(target: SessionTarget, text: string): Promise<void>;
      }
    )
      .pushProactive(target, 'Scheduled summary')
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(isChannelProactiveDeliveryError(err)).toBe(true);
    expect(err).toMatchObject({ disposition: 'permanent' });
    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('classifies an exhausted fallback as a permanent proactive failure', async () => {
    const { ch } = makeChannel();
    // Both the markdown attempt and the plain-text fallback fail.
    mockSendQQMessage.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => '',
    });

    const err: unknown = await (
      ch as unknown as {
        pushProactive(target: SessionTarget, text: string): Promise<void>;
      }
    )
      .pushProactive(groupTarget(), 'Scheduled summary')
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(isChannelProactiveDeliveryError(err)).toBe(true);
    expect(err).toMatchObject({ disposition: 'permanent' });
    expect((err as { cause?: unknown }).cause).toMatchObject({
      name: 'DeliveryError',
      code: 'FALLBACK_FAILED',
    });
    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
  });

  it('leaves a rate-limited proactive failure unwrapped for retry', async () => {
    const { ch } = makeChannel();
    mockSendQQMessage.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => '',
    });

    const err: unknown = await (
      ch as unknown as {
        pushProactive(target: SessionTarget, text: string): Promise<void>;
      }
    )
      .pushProactive(groupTarget(), 'Scheduled summary')
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // A throttle is transient: it must reach base's delivery wrapper as the
    // raw DeliveryError, not as a permanent proactive-error wrapper.
    expect(err).toBeInstanceOf(DeliveryError);
    expect((err as DeliveryError).code).toBe('RATE_LIMITED');
    expect(isChannelProactiveDeliveryError(err)).toBe(false);
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
  });

  it('fails the loop when the route block is permanent', async () => {
    const { ch, raw } = makeChannel();
    await bindSession(raw);
    // The channel is disposed after the gate ran, so the send resolves to a
    // permanent route block: the delivery is dropped before the wire and must
    // not be recorded as delivered.
    (ch as unknown as Record<string, unknown>)['disposed'] = true;
    mockPrompt.mockResolvedValue('Scheduled summary');

    await expect(ch.runLoopPrompt(loopJob())).rejects.toMatchObject({
      name: 'ChannelProactiveDeliveryError',
      disposition: 'permanent',
      message: `outgoing route unresolved (permanent) for ${CHAT_ID}`,
    });
    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('fails the loop when the route block is transient', async () => {
    const { ch, raw } = makeChannel();
    await bindSession(raw);
    raw.tokenExpiresAt = 0;
    mockFetchAccessToken.mockRejectedValue(new Error('token refresh failed'));
    mockPrompt.mockResolvedValue('Scheduled summary');

    await expect(ch.runLoopPrompt(loopJob())).rejects.toMatchObject({
      name: 'ChannelProactiveDeliveryError',
      disposition: 'transient',
      // The retry class is part of the operator-visible message so a route
      // block is distinguishable in /loop inspect's lastError.
      message: `outgoing route unresolved (transient) for ${CHAT_ID}`,
    });
    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('delivers the loop result once, not the streamed chunks as well', async () => {
    const { ch, raw, getChunkListener } = makeChannel();
    await bindSession(raw);
    const chunks = [
      'A'.repeat(1500),
      'B'.repeat(1500),
      'C'.repeat(1500),
      'D'.repeat(1500),
    ];
    const response = chunks.join('');
    mockPrompt.mockImplementation(async () => {
      const emit = getChunkListener();
      expect(emit).toBeDefined();
      for (const chunk of chunks) emit!(SESSION_ID, chunk);
      return response;
    });
    mockSendQQMessage.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    });

    await expect(ch.runLoopPrompt(loopJob())).resolves.toBe(response);

    // pushProactive is the single delivery arm for an unattended turn: the
    // streamed chunks must not also be flushed to the group.
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(mockSendQQMessage.mock.calls[0]![3]).toEqual({
      msg_type: 2,
      markdown: { content: response },
    });
  });

  it('logs a rejecting loop store from the GROUP_DEL_ROBOT dispatch with the group id', async () => {
    const { ch, raw, controller } = makeChannel();
    await bindSession(raw);
    // The realistic store failure: readJobs() throws on a corrupt file, and
    // the dispatch arm's .catch guard is what keeps it from becoming an
    // unhandled rejection in the daemon worker.
    const storeError = new Error(
      'Malformed JSON in /tmp/qwen/loops.json; fix or delete the file.',
    );
    vi.mocked(controller.listForChat).mockRejectedValue(storeError);

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    let logged = '';
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      (
        ch as unknown as {
          handleGatewayMessage(
            msg: Record<string, unknown>,
            onReady: () => void,
          ): void;
        }
      ).handleGatewayMessage(
        {
          op: OpCode.DISPATCH,
          t: 'GROUP_DEL_ROBOT',
          d: {
            group_openid: CHAT_ID,
            op_member_openid: 'admin-1',
            timestamp: Date.now(),
          },
        },
        () => {},
      );
      // Two macrotask turns: the rejection propagates through the handler's
      // awaits and, if unguarded, Node emits unhandledRejection.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      logged = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    } finally {
      process.off('unhandledRejection', onUnhandled);
      stderrSpy.mockRestore();
    }

    expect(unhandled).toEqual([]);
    // The failure line carries the group so a daemon serving several groups
    // can tell whose cleanup was discarded.
    expect(logged).toContain(`handleGroupDelRobot failed for group ${CHAT_ID}`);
    expect(logged).toContain(storeError.message);
  });
});
