import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QQChannel as QQChannelClass } from './QQChannel.js';

const { mockSendQQMessage, mockFetchAccessToken } = vi.hoisted(() => ({
  mockSendQQMessage: vi.fn(),
  mockFetchAccessToken: vi.fn(),
}));

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  renameSync: vi.fn(),
}));

vi.mock('./api.js', () => ({
  sendQQMessage: mockSendQQMessage,
  getApiBase: () => 'https://api.sgroup.qq.com',
  fetchAccessToken: mockFetchAccessToken,
  fetchGatewayUrl: vi.fn(),
}));

vi.mock('./accounts.js', () => ({
  getCredsFilePath: () => '/tmp/test-creds.json',
  loadCredentials: () => null,
  saveCredentials: vi.fn(),
}));

vi.mock('./login.js', () => ({
  qrCodeLogin: vi.fn(),
}));

vi.mock('@qwen-code/channel-base', () => ({
  ChannelBase: class {
    protected config: Record<string, unknown> = {};
    protected bridge: Record<string, unknown> = {};
    protected router: Record<string, unknown> = {};
    protected name: string = '';
    constructor(
      name: string,
      config: Record<string, unknown>,
      bridge: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) {
      this.name = name;
      this.config = config;
      this.bridge = bridge;
      this.router = (options?.['router'] ?? {}) as Record<string, unknown>;
    }
    protected handleInbound(_env: unknown): Promise<void> {
      return Promise.resolve();
    }
  },
  SessionRouter: class {
    restoreSessions(): Promise<void> {
      return Promise.resolve();
    }
  },
  getGlobalQwenDir: () => '/tmp/test-qwen',
}));

const { QQChannel } = await import('./QQChannel.js');

/** Shared array holding textChunk handler references captured by the bridge. */
const textChunkHandlers: Array<(sessionId: string, text: string) => void> = [];

function mockResponse(
  ok: boolean,
  status = 200,
): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok, status, text: async () => '' };
}

function makeChannel(): QQChannelClass {
  textChunkHandlers.length = 0;

  const router = {
    getTarget: vi.fn().mockReturnValue({ chatId: 'test-chat' }),
  };

  const bridge = {
    on: vi.fn(
      (event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'textChunk') {
          textChunkHandlers.push(
            handler as (sessionId: string, text: string) => void,
          );
        }
      },
    ),
    off: vi.fn(),
  };

  const ch = new QQChannel(
    'test-bot',
    {
      type: 'qq',
      token: '',
      senderPolicy: 'open' as const,
      allowedUsers: [],
      sessionScope: 'user' as const,
      cwd: '/tmp',
      groupPolicy: 'disabled' as const,
      groups: {},
      appID: 'test-app-id',
      appSecret: 'test-secret',
      'cron-msg-experimental': true,
    },
    bridge as unknown as import('@qwen-code/channel-base').AcpBridge,
    { router } as unknown as Record<string, unknown>,
  );

  const chp = ch as unknown as Record<string, unknown>;
  chp['accessToken'] = 'test-token';
  chp['tokenExpiresAt'] = Date.now() + 3600_000;
  (chp['chatTypeMap'] as Map<string, string>).set('test-chat', 'c2c');

  return ch;
}

function triggerTextChunk(sessionId: string, text: string): void {
  for (const handler of textChunkHandlers) {
    handler(sessionId, text);
  }
}

// ---------------------------------------------------------------------------
// cronTextHandler
// ---------------------------------------------------------------------------
describe('cronTextHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    textChunkHandlers.length = 0;
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Wait for the setImmediate inside _cronTextHandler to fire.
   *  With fake timers, setImmediate is treated as setTimeout(fn, 0). */
  async function flushSetImmediate(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  it('accumulates chunks and flushes after 2s idle timer', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as Record<string, unknown>;
    // Mark the channel as ready so the cron handler processes chunks
    pvt['_ready'] = true;

    triggerTextChunk('sess-1', 'hello ');
    await flushSetImmediate();

    const cronBuffer = pvt['cronBuffer'] as Map<
      string,
      { buffer: string; timer: unknown }
    >;
    expect(cronBuffer.has('sess-1')).toBe(true);
    expect(cronBuffer.get('sess-1')!.buffer).toBe('hello ');

    // Send another chunk before the timer fires
    triggerTextChunk('sess-1', 'world');
    await flushSetImmediate();

    expect(cronBuffer.get('sess-1')!.buffer).toBe('hello world');

    // Advance past the 2s idle timer
    // Use async timer advancement so all promise chains (.then on
    // sendMessage) settle before assertions.
    await vi.advanceTimersByTimeAsync(2000);

    // Flush should have called sendQQMessage via sendMessage
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(mockSendQQMessage).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat/messages',
      'test-token',
      { markdown: { content: 'hello world' }, msg_type: 2 },
    );

    // Buffer should be cleared and entry deleted
    expect(cronBuffer.has('sess-1')).toBe(false);
  });

  it('skips chunks when _ready is false', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as Record<string, unknown>;
    // _ready defaults to false — do NOT set it to true

    triggerTextChunk('sess-1', 'should be ignored');
    await flushSetImmediate();

    const cronBuffer = pvt['cronBuffer'] as Map<string, unknown>;
    expect(cronBuffer.has('sess-1')).toBe(false);
    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('maintains separate buffers for different sessionIds', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as Record<string, unknown>;
    pvt['_ready'] = true;

    triggerTextChunk('sess-a', 'buffer-a ');
    triggerTextChunk('sess-b', 'buffer-b ');
    await flushSetImmediate();

    const cronBuffer = pvt['cronBuffer'] as Map<
      string,
      { buffer: string; timer: unknown }
    >;
    expect(cronBuffer.get('sess-a')!.buffer).toBe('buffer-a ');
    expect(cronBuffer.get('sess-b')!.buffer).toBe('buffer-b ');
    expect(cronBuffer.size).toBe(2);
  });

  it('resolves target via router.getTarget and sends accumulated text', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as Record<string, unknown>;
    pvt['_ready'] = true;

    const router = (ch as unknown as Record<string, unknown>)[
      'router'
    ] as { getTarget: ReturnType<typeof vi.fn> };

    triggerTextChunk('sess-route', 'routed text');
    await flushSetImmediate();

    // Advance past the idle timer — getTarget is called inside it
    vi.advanceTimersByTime(2000);
    await Promise.resolve();

    expect(router.getTarget).toHaveBeenCalledWith('sess-route');
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(mockSendQQMessage).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat/messages',
      'test-token',
      { markdown: { content: 'routed text' }, msg_type: 2 },
    );
  });
});
