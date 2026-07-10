import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  type QQChannel as QQChannelClass,
  DeliveryError,
} from './QQChannel.js';

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
  sanitizeLogText: (text: string, _maxLen: number): string =>
    String(text).slice(0, 200),
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
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'textChunk') {
        textChunkHandlers.push(
          handler as (sessionId: string, text: string) => void,
        );
      }
    }),
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

  async function flushSetImmediate(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  it('accumulates chunks and flushes after 2s idle timer', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as Record<string, unknown>;
    pvt['_ready'] = true;
    pvt['_inCronFlow'] = 1;

    triggerTextChunk('sess-1', 'hello ');
    await flushSetImmediate();

    const cronBuffer = pvt['cronBuffer'] as Map<
      string,
      { buffer: string; timer: unknown }
    >;
    expect(cronBuffer.has('sess-1')).toBe(true);
    expect(cronBuffer.get('sess-1')!.buffer).toBe('hello ');

    triggerTextChunk('sess-1', 'world');
    await flushSetImmediate();

    expect(cronBuffer.get('sess-1')!.buffer).toBe('hello world');

    await vi.advanceTimersByTimeAsync(2000);

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(mockSendQQMessage).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat/messages',
      'test-token',
      { msg_type: 2, markdown: { content: 'hello world' } },
    );

    expect(cronBuffer.has('sess-1')).toBe(false);
  });

  it('skips chunks when _ready is false', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as Record<string, unknown>;

    triggerTextChunk('sess-1', 'should be ignored');
    await flushSetImmediate();

    const cronBuffer = pvt['cronBuffer'] as Map<string, unknown>;
    expect(cronBuffer.has('sess-1')).toBe(false);
    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('ignores chunks when _inCronFlow is 0 (gate)', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as Record<string, unknown>;
    pvt['_ready'] = true;
    pvt['_inCronFlow'] = 0;

    triggerTextChunk('sess-gate', 'should be ignored');
    await flushSetImmediate();

    const cronBuffer = pvt['cronBuffer'] as Map<string, unknown>;
    expect(cronBuffer.has('sess-gate')).toBe(false);
    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('maintains separate buffers for different sessionIds', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as Record<string, unknown>;
    pvt['_ready'] = true;
    pvt['_inCronFlow'] = 1;

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

    pvt['_inCronFlow'] = 1;
    const router = (ch as unknown as Record<string, unknown>)['router'] as {
      getTarget: ReturnType<typeof vi.fn>;
    };

    triggerTextChunk('sess-route', 'routed text');
    await flushSetImmediate();

    vi.advanceTimersByTime(2000);
    await Promise.resolve();

    expect(router.getTarget).toHaveBeenCalledWith('sess-route');
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(mockSendQQMessage).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat/messages',
      'test-token',
      { msg_type: 2, markdown: { content: 'routed text' } },
    );
  });

  it('sends accumulated text and cleans up buffer after flush', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as Record<string, unknown>;
    pvt['_ready'] = true;

    pvt['_inCronFlow'] = 1;
    mockSendQQMessage.mockResolvedValue(mockResponse(true));

    triggerTextChunk('sess-cleanup', 'cleanup text');
    await flushSetImmediate();

    const cronBuffer = pvt['cronBuffer'] as Map<
      string,
      { buffer: string; timer: unknown }
    >;
    expect(cronBuffer.has('sess-cleanup')).toBe(true);

    await vi.advanceTimersByTimeAsync(2000);

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(cronBuffer.has('sess-cleanup')).toBe(false);
  });

  // A2: sendMessage failure → log + cleanup (no retry)
  it('logs error and cleans up cronBuffer on sendMessage rejection (no retry)', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as Record<string, unknown>;
    pvt['_ready'] = true;
    pvt['_inCronFlow'] = 1;

    mockSendQQMessage.mockRejectedValue(
      new DeliveryError('RETRY_EXHAUSTED', 'network error'),
    );
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    triggerTextChunk('sess-fail', 'will fail');
    await flushSetImmediate();

    const cronBuffer = pvt['cronBuffer'] as Map<
      string,
      { buffer: string; timer: unknown }
    >;
    expect(cronBuffer.has('sess-fail')).toBe(true);

    await vi.advanceTimersByTimeAsync(2000);

    // Verify error was logged
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes('Cron flush send error'))).toBe(true);

    // Verify buffer was cleaned up — no retry, no lingering entry
    // RETRY_EXHAUSTED errors clean up immediately (permanent failure)
    expect(cronBuffer.has('sess-fail')).toBe(false);
    // RETRY_EXHAUSTED errors clean up immediately (permanent failure)

    stderrSpy.mockRestore();
  });

  // A6: streamState isolation — cron handler skips sessions owned by prompt path
  it('streamState isolation: cron handler skips sessions with existing streamState entry', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as Record<string, unknown>;
    pvt['_ready'] = true;
    pvt['_inCronFlow'] = 1;

    // Pre-populate streamState for this session — prompt path owns it
    const ss = pvt['streamState'] as Map<string, unknown>;
    ss.set('sess-stream', {
      chatId: 'test-chat',
      buffer: 'existing prompt text',
      timer: null,
      retryCount: 0,
    });

    triggerTextChunk('sess-stream', 'should be ignored by cron');
    await flushSetImmediate();

    const cronBuffer = pvt['cronBuffer'] as Map<string, unknown>;
    expect(cronBuffer.has('sess-stream')).toBe(false);
  });

  it('RATE_LIMITED triggers re-schedule, retry succeeds', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as Record<string, unknown>;
    pvt['_ready'] = true;
    pvt['_inCronFlow'] = 1;

    // First call fails with RATE_LIMITED
    mockSendQQMessage.mockRejectedValueOnce(
      new DeliveryError('RATE_LIMITED', 'rate limited'),
    );
    // Retry succeeds
    mockSendQQMessage.mockResolvedValueOnce(mockResponse(true));

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    triggerTextChunk('sess-rate', 'rate limited text');
    await flushSetImmediate();

    const cronBuffer = pvt['cronBuffer'] as Map<
      string,
      { buffer: string; timer: unknown; pendingRetry?: string }
    >;
    expect(cronBuffer.has('sess-rate')).toBe(true);

    // Advance past the initial 2s flush to trigger send
    await vi.advanceTimersByTimeAsync(2000);
    // Buffer should still exist after transient failure (retry scheduled)
    expect(cronBuffer.has('sess-rate')).toBe(true);

    // Advance past the 5s retry delay
    await vi.advanceTimersByTimeAsync(5000);

    // Retry should have succeeded and cleaned up
    expect(cronBuffer.has('sess-rate')).toBe(false);
    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);

    stderrSpy.mockRestore();
  });

  it('transient failure, retry target is null → buffer cleaned up', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as Record<string, unknown>;
    const router = (ch as unknown as Record<string, unknown>)['router'] as {
      getTarget: ReturnType<typeof vi.fn>;
    };
    pvt['_ready'] = true;
    pvt['_inCronFlow'] = 1;

    // First call fails with FALLBACK_FAILED
    mockSendQQMessage.mockRejectedValueOnce(
      new DeliveryError('FALLBACK_FAILED', 'fallback failed'),
    );

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    triggerTextChunk('sess-null-target', 'text with no target');
    await flushSetImmediate();
    await vi.advanceTimersByTimeAsync(2000);

    // Reset router.getTarget to return null for retry
    router.getTarget.mockReturnValueOnce(null);

    await vi.advanceTimersByTimeAsync(5000);

    const cronBuffer = pvt['cronBuffer'] as Map<string, unknown>;
    expect(cronBuffer.has('sess-null-target')).toBe(false);

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(
      calls.some((c) =>
        c.includes('Cron flush dropped after retry: no target'),
      ),
    ).toBe(true);

    stderrSpy.mockRestore();
  });

  it('retry send also fails → error logged, buffer cleaned up', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as Record<string, unknown>;
    pvt['_ready'] = true;
    pvt['_inCronFlow'] = 1;

    // First call fails with RATE_LIMITED
    mockSendQQMessage.mockRejectedValueOnce(
      new DeliveryError('RATE_LIMITED', 'rate limited'),
    );
    // Retry also fails with a permanent error
    mockSendQQMessage.mockRejectedValueOnce(
      new DeliveryError('RETRY_EXHAUSTED', 'retries exhausted'),
    );

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    triggerTextChunk('sess-retry-fail', 'text that will fail twice');
    await flushSetImmediate();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(5000);

    const cronBuffer = pvt['cronBuffer'] as Map<string, unknown>;
    expect(cronBuffer.has('sess-retry-fail')).toBe(false);

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes('Cron flush retry failed'))).toBe(true);
    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// _inCronFlow depth counter
// ---------------------------------------------------------------------------
describe('_inCronFlow depth counter', () => {
  it('supports concurrent runCronFlow without stomping depth', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as Record<string, unknown>;

    let resolve1!: () => void;
    let resolve2!: () => void;
    const p1 = new Promise<void>((r) => {
      resolve1 = r;
    });
    const p2 = new Promise<void>((r) => {
      resolve2 = r;
    });

    const runCronFlow = (
      ch as unknown as {
        runCronFlow: (fn: () => Promise<void>) => Promise<void>;
      }
    ).runCronFlow.bind(ch);

    const flow1 = runCronFlow(async () => {
      await p1;
    });
    expect(pvt['_inCronFlow']).toBe(1);

    const flow2 = runCronFlow(async () => {
      await p2;
    });
    expect(pvt['_inCronFlow']).toBe(2);

    resolve1();
    await flow1;
    expect(pvt['_inCronFlow']).toBe(1);

    resolve2();
    await flow2;
    expect(pvt['_inCronFlow']).toBe(0);
  });

  it('runCronFlow finally decrements even when fn throws', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as Record<string, unknown>;

    const runCronFlow = (
      ch as unknown as {
        runCronFlow: (fn: () => Promise<void>) => Promise<void>;
      }
    ).runCronFlow.bind(ch);

    expect(pvt['_inCronFlow']).toBe(0);

    await expect(
      runCronFlow(async () => {
        throw new Error('cron task failed');
      }),
    ).rejects.toThrow('cron task failed');

    // Depth must be 0 even after the function threw
    expect(pvt['_inCronFlow']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// disconnect cron cleanup
// ---------------------------------------------------------------------------
describe('disconnect cron cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    textChunkHandlers.length = 0;
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears cronBuffer entries and cancels their timers on disconnect', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as Record<string, unknown>;
    pvt['_ready'] = true;
    pvt['_inCronFlow'] = 1;

    triggerTextChunk('sess-disc', 'pending cron text');
    vi.advanceTimersByTime(0); // let setImmediate fire

    const cronBuffer = pvt['cronBuffer'] as Map<
      string,
      { buffer: string; timer: ReturnType<typeof setTimeout> | null }
    >;
    expect(cronBuffer.has('sess-disc')).toBe(true);
    const entry = cronBuffer.get('sess-disc')!;
    expect(entry.timer).not.toBeNull();

    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    (ch as unknown as { disconnect: () => void }).disconnect();

    // Timer was cancelled
    expect(clearTimeoutSpy).toHaveBeenCalled();
    // Buffer was cleared
    expect(cronBuffer.size).toBe(0);

    clearTimeoutSpy.mockRestore();
  });

  it('disconnect resets _inCronFlow depth to zero', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as Record<string, unknown>;
    pvt['_inCronFlow'] = 3;

    (ch as unknown as { disconnect: () => void }).disconnect();

    expect(pvt['_inCronFlow']).toBe(0);
  });
});
