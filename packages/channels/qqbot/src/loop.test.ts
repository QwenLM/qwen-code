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

const { QQChannel } = await import('./QQChannel.js');
import type {
  ChannelAgentBridge,
  ChannelLoop,
  ChannelLoopController,
  ChannelLoopInput,
  ChannelLoopToolHandler,
  SessionRouter,
} from '@qwen-code/channel-base';

const CHAT_ID = 'group-openid-1';
const SENDER_ID = 'member-1';
const SESSION_ID = 'session-1';

interface RawChannel {
  accessToken: string;
  tokenExpiresAt: number;
  chatTypeMap: Map<string, 'c2c' | 'group'>;
  replyMsgId: Map<string, { msgId: string; timestamp: number }>;
  groupActiveMsgEnabled: Map<string, boolean>;
  router: SessionRouter;
}

function makeBridge(): {
  bridge: ChannelAgentBridge;
  getLoopHandler: () => ChannelLoopToolHandler | undefined;
} {
  let loopHandler: ChannelLoopToolHandler | undefined;
  const bridge = {
    newSession: mockNewSession,
    prompt: mockPrompt,
    on: vi.fn(),
    off: vi.fn(),
    registerChannelLoopToolHandler: vi.fn((handler: ChannelLoopToolHandler) => {
      loopHandler = handler;
    }),
  };
  return {
    bridge: bridge as unknown as ChannelAgentBridge,
    getLoopHandler: () => loopHandler,
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

function makeChannel(): {
  ch: InstanceType<typeof QQChannel>;
  raw: RawChannel;
  controller: ChannelLoopController;
  getLoopHandler: () => ChannelLoopToolHandler | undefined;
} {
  const { controller } = makeLoopController();
  const { bridge, getLoopHandler } = makeBridge();
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
    },
    bridge,
    { loopController: controller, registerBridgeEvents: false },
  );
  const raw = ch as unknown as RawChannel;
  raw.accessToken = 'test-token';
  raw.tokenExpiresAt = Date.now() + 3_600_000;
  raw.chatTypeMap.set(CHAT_ID, 'group');
  return { ch, raw, controller, getLoopHandler };
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

  it('surfaces active messages being disabled instead of dropping the result', async () => {
    const { ch, raw } = makeChannel();
    await bindSession(raw);
    // The anchor must not turn the loop delivery into a passive reply that
    // bypasses the active-message toggle.
    raw.replyMsgId.set(CHAT_ID, {
      msgId: 'inbound-anchor-msg-1',
      timestamp: Date.now(),
    });
    raw.groupActiveMsgEnabled.set(CHAT_ID, false);
    mockPrompt.mockResolvedValue('Scheduled summary');

    await expect(ch.runLoopPrompt(loopJob())).rejects.toMatchObject({
      name: 'DeliveryError',
      code: 'ACTIVE_MSG_DISABLED',
      message: expect.stringMatching(/Active messages disabled/u),
    });
    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });
});
