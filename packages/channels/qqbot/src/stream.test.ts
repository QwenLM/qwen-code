import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QQChannel as QQChannelClass } from './QQChannel.js';
import type { ToolCallEvent } from '@qwen-code/channel-base';

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
    protected async onResponseComplete(
      _chatId: string,
      fullText: string,
      _sessionId: string,
    ): Promise<void> {
      await (
        this as unknown as {
          sendMessage: (c: string, t: string) => Promise<void>;
        }
      ).sendMessage(_chatId, fullText);
    }
  },
  SessionRouter: class {
    restoreSessions(): Promise<void> {
      return Promise.resolve();
    }
  },
  getGlobalQwenDir: () => '/tmp/test-qwen',
  sanitizeLogText: (text: string, _maxLen: number): string =>
    String(text).slice(0, 200),
  sanitizeSenderName: (name: string): string => name || 'QQ User',
  sanitizePromptText: (text: string): string => text,
}));

const { QQChannel } = await import('./QQChannel.js');

type MockResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

function mockResponse(ok: boolean, status = 200): MockResponse {
  return { ok, status, text: async () => '' };
}

function makeChannel(overrides: Record<string, unknown> = {}): QQChannelClass {
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
      ...overrides,
    },
    {} as unknown as import('@qwen-code/channel-base').ChannelAgentBridge,
  );
  const chp = ch as unknown as Record<string, unknown>;
  chp['accessToken'] = 'test-token';
  chp['tokenExpiresAt'] = Date.now() + 3600_000;
  (chp['chatTypeMap'] as Map<string, string>).set('test-chat', 'c2c');
  (chp['chatTypeMap'] as Map<string, string>).set('chat-a', 'c2c');
  (chp['chatTypeMap'] as Map<string, string>).set('chat-b', 'c2c');
  return ch;
}

function streamState(ch: QQChannelClass) {
  return (ch as unknown as Record<string, unknown>)['streamState'] as Map<
    string,
    {
      chatId: string;
      buffer: string;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >;
}

function onResponseChunk(
  ch: QQChannelClass,
  chatId: string,
  chunk: string,
  sessionId: string,
) {
  return (
    ch as unknown as {
      onResponseChunk: (c: string, h: string, s: string) => void;
    }
  ).onResponseChunk(chatId, chunk, sessionId);
}

function onResponseComplete(
  ch: QQChannelClass,
  chatId: string,
  fullText: string,
  sessionId: string,
) {
  return (
    ch as unknown as {
      onResponseComplete: (c: string, f: string, s: string) => Promise<void>;
    }
  ).onResponseComplete(chatId, fullText, sessionId);
}

function toolCall(sessionId: string): ToolCallEvent {
  return {
    sessionId,
    toolCallId: 'tc-1',
    toolName: 'search',
    args: { q: 'weather' },
  } as unknown as ToolCallEvent;
}

/** Helper: drain microtasks to let async sendMessage chains settle. */
async function drain() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ────────────────────────────────────────────────────────────────

describe('onResponseChunk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a new streamState entry with the chunk and sets an idle timer', () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'hello', 'sess-1');

    const st = streamState(ch);
    expect(st.has('sess-1')).toBe(true);
    expect(st.get('sess-1')!.buffer).toBe('hello');
    expect(st.get('sess-1')!.chatId).toBe('test-chat');
    expect(st.get('sess-1')!.timer).not.toBeNull();
  });

  it('accumulates multiple chunks into the same session buffer', () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'hello', 'sess-1');
    onResponseChunk(ch, 'test-chat', ' world', 'sess-1');
    onResponseChunk(ch, 'test-chat', '!', 'sess-1');

    expect(streamState(ch).get('sess-1')!.buffer).toBe('hello world!');
  });

  it('maintains independent buffers for different sessions', () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'chat-a', 'aaa', 'sess-a');
    onResponseChunk(ch, 'chat-b', 'bbb', 'sess-b');

    const st = streamState(ch);
    expect(st.get('sess-a')!.buffer).toBe('aaa');
    expect(st.get('sess-a')!.chatId).toBe('chat-a');
    expect(st.get('sess-b')!.buffer).toBe('bbb');
    expect(st.get('sess-b')!.chatId).toBe('chat-b');
    expect(st.size).toBe(2);
  });

  it('cancels previous idle timer when a new chunk arrives', () => {
    const ch = makeChannel();
    vi.spyOn(global, 'clearTimeout');

    onResponseChunk(ch, 'test-chat', 'first', 'sess-1');
    const firstTimer = streamState(ch).get('sess-1')!.timer;

    onResponseChunk(ch, 'test-chat', 'second', 'sess-1');
    expect(clearTimeout).toHaveBeenCalledWith(firstTimer);
  });

  it('resets the idle timer on each new chunk', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'part1', 'sess-1');

    vi.advanceTimersByTime(1500);
    onResponseChunk(ch, 'test-chat', 'part2', 'sess-1');

    vi.advanceTimersByTime(1500);
    await drain();
    expect(mockSendQQMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
  });
});

describe('idle-flush timer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-flushes the buffer 2 seconds after the last chunk', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'auto-flush me', 'sess-1');

    expect(streamState(ch).get('sess-1')!.timer).not.toBeNull();

    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
  });

  it('deletes streamState on successful idle flush', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'hello', 'sess-1');

    vi.advanceTimersByTime(2000);
    await drain();

    // streamState cleaned up on success (wasPending=false path)
    expect(streamState(ch).has('sess-1')).toBe(false);
  });

  it('does not flush if buffer was already emptied by onToolCall', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'pre-tool text', 'sess-1');
    ch.onToolCall('test-chat', toolCall('sess-1'));
    await drain();
    mockSendQQMessage.mockClear();

    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('each session has its own independent idle timer', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'chat-a', 'a-text', 'sess-a');
    vi.advanceTimersByTime(1500);
    onResponseChunk(ch, 'chat-b', 'b-text', 'sess-b');

    vi.advanceTimersByTime(500);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1500);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
  });
});

describe('onToolCall flush', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes buffer and sends when buffer is non-empty', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'let me search...', 'sess-1');

    ch.onToolCall('test-chat', toolCall('sess-1'));
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is no buffer for the session', () => {
    const ch = makeChannel();
    ch.onToolCall('test-chat', toolCall('sess-unknown'));
    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('cancels the idle timer when flushing', () => {
    const ch = makeChannel();
    vi.spyOn(global, 'clearTimeout');

    onResponseChunk(ch, 'test-chat', 'text', 'sess-1');
    const timer = streamState(ch).get('sess-1')!.timer;

    ch.onToolCall('test-chat', toolCall('sess-1'));
    expect(clearTimeout).toHaveBeenCalledWith(timer);
  });

  it('clears the buffer before async send', () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'text before tool', 'sess-1');

    ch.onToolCall('test-chat', toolCall('sess-1'));

    expect(streamState(ch).get('sess-1')!.buffer).toBe('');
  });

  it('only flushes the triggering session, not other sessions', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'chat-a', 'buffer-a', 'sess-a');
    onResponseChunk(ch, 'chat-b', 'buffer-b', 'sess-b');

    ch.onToolCall('chat-a', toolCall('sess-a'));
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(streamState(ch).get('sess-b')!.buffer).toBe('buffer-b');
  });

  it('does nothing when buffer is already empty', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'txt', 'sess-1');
    ch.onToolCall('test-chat', toolCall('sess-1'));
    await drain();
    mockSendQQMessage.mockClear();

    ch.onToolCall('test-chat', toolCall('sess-1'));
    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('send failure is caught internally by sendMessage (then fires)', async () => {
    const ch = makeChannel();
    let rejectSend: (err: Error) => void;
    const sendPromise = new Promise<MockResponse>((_resolve, reject) => {
      rejectSend = reject;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    onResponseChunk(ch, 'test-chat', 'text before tool', 'sess-1');
    ch.onToolCall('test-chat', toolCall('sess-1'));

    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    pendingStreamDelete.add('sess-1');

    // sendMessage catches the error internally and resolves
    rejectSend!(new Error('send failed'));
    try {
      await sendPromise;
    } catch {
      /* expected */
    }
    await drain();

    // .then() fires: pendingStreamDelete cleared, streamState deleted
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
    expect(streamState(ch).has('sess-1')).toBe(false);
  });
});

describe('onResponseComplete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends remaining buffer and deletes streamState', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'remaining text', 'sess-1');

    await onResponseComplete(ch, 'test-chat', 'remaining text', 'sess-1');

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(streamState(ch).has('sess-1')).toBe(false);
  });

  it('falls back to fullText when no streamState', async () => {
    const ch = makeChannel();
    await onResponseComplete(ch, 'test-chat', 'nothing', 'sess-none');
    expect(mockSendQQMessage).toHaveBeenCalled();
  });

  it('does not send when buffer is empty (already flushed)', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'all flushed', 'sess-1');
    ch.onToolCall('test-chat', toolCall('sess-1'));
    await drain();
    mockSendQQMessage.mockClear();

    await onResponseComplete(ch, 'test-chat', 'all flushed', 'sess-1');

    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('handles completion across multiple sessions', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'chat-a', 'text-a', 'sess-a');
    onResponseChunk(ch, 'chat-b', 'text-b', 'sess-b');

    await onResponseComplete(ch, 'chat-a', 'text-a', 'sess-a');

    expect(streamState(ch).has('sess-a')).toBe(false);
    expect(streamState(ch).has('sess-b')).toBe(true);
    expect(streamState(ch).get('sess-b')!.buffer).toBe('text-b');
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
  });
});

describe('pendingStreamDelete coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defers cleanup when idle-flush in flight, cleans up on resolve', async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    onResponseChunk(ch, 'test-chat', 'streaming text', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();

    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Set<string>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(flushingSessions.has('sess-1')).toBe(true);

    // onResponseComplete fires while idle-flush is in-flight
    await onResponseComplete(ch, 'test-chat', 'streaming text', 'sess-1');

    expect(pendingStreamDelete.has('sess-1')).toBe(true);
    expect(streamState(ch).has('sess-1')).toBe(true);

    // Let the idle-flush send promise resolve
    resolveSend!(mockResponse(true));
    await drain();

    // Cleaned up
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
    expect(streamState(ch).has('sess-1')).toBe(false);
    expect(flushingSessions.has('sess-1')).toBe(false);
  });

  it('on wasPending failure: deletes streamState (no leak)', async () => {
    const ch = makeChannel();
    let rejectSend: (err: Error) => void;
    const sendPromise = new Promise<MockResponse>((_resolve, reject) => {
      rejectSend = reject;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    onResponseChunk(ch, 'test-chat', 'text', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();

    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    pendingStreamDelete.add('sess-1');

    rejectSend!(new Error('send failed'));
    try {
      await sendPromise;
    } catch {
      /* expected */
    }
    await drain();

    expect(pendingStreamDelete.has('sess-1')).toBe(false);
    expect(streamState(ch).has('sess-1')).toBe(false);
  });
});

describe('streaming guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stale _reconnectId prevents idleFlush callback', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'stale text', 'sess-1');

    const chp = ch as unknown as Record<string, unknown>;
    chp['_reconnectId'] = (chp['_reconnectId'] as number) + 1;

    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('blockStreaming=on prevents streamState accumulation', () => {
    const ch = makeChannel({ blockStreaming: 'on' });
    onResponseChunk(ch, 'test-chat', 'blocked', 'sess-1');

    expect(streamState(ch).has('sess-1')).toBe(false);
  });

  it('flushingSessions guard prevents double-send', async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    onResponseChunk(ch, 'test-chat', 'hello', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);

    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Set<string>;
    flushingSessions.add('sess-1');

    (chp['idleFlush'] as (sid: string, rid: number) => void)(
      'sess-1',
      chp['_reconnectId'] as number,
    );

    resolveSend!(mockResponse(true));
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
  });
});
