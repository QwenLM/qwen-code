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
      _fullText: string,
      _sessionId: string,
    ): Promise<void> {
      await (
        this as unknown as {
          sendMessage: (c: string, t: string) => Promise<void>;
        }
      ).sendMessage(_chatId, _fullText);
    }
  },
  SessionRouter: class {
    restoreSessions(): Promise<void> {
      return Promise.resolve();
    }
  },
  getGlobalQwenDir: () => '/tmp/test-qwen',
  sanitizeLogText: (text: string, maxLen: number): string => {
    const sanitized = Array.from(text, (c) => {
      const cp = c.codePointAt(0)!;
      if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d)
        return `\\x${cp.toString(16).padStart(2, '0')}`;
      if (cp === 0x7f || (cp >= 0x80 && cp <= 0x9f))
        return `\\x${cp.toString(16).padStart(2, '0')}`;
      if (cp === 0x1b) return '\\x1B';
      return c;
    }).join('');
    return sanitized.slice(0, maxLen);
  },
  sanitizeSenderName: (name: string): string => {
    const cleaned = Array.from(name, (c) => {
      const cp = c.codePointAt(0)!;
      if (cp < 0x20 || cp === 0x7f) return ' ';
      if (c === '[' || c === ']') return ' ';
      return c;
    }).join('');
    return cleaned.replace(/\s+/g, ' ').trim() || 'QQ User';
  },
  sanitizePromptText: (text: string): string => text,
}));

const { QQChannel } = await import('./QQChannel.js');

function mockResponse(
  ok: boolean,
  status = 200,
): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok, status, text: async () => '' };
}

function makeChannel(): QQChannelClass {
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
    },
    {} as unknown as import('@qwen-code/channel-base').AcpBridge,
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
      onResponseChunk: (
        chatId: string,
        chunk: string,
        sessionId: string,
      ) => void;
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
      onResponseComplete: (
        chatId: string,
        fullText: string,
        sessionId: string,
      ) => Promise<void>;
    }
  ).onResponseComplete(chatId, fullText, sessionId);
}

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

    const st = streamState(ch);
    expect(st.get('sess-1')!.buffer).toBe('hello world!');
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

  it('fires idleFlush 2 seconds after the last chunk', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'hello', 'sess-1');

    // Not yet flushed
    vi.advanceTimersByTime(1999);
    expect(mockSendQQMessage).not.toHaveBeenCalled();

    // At exactly 2s the idle timer fires
    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
  });

  it('clears the buffer after idleFlush', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'hello', 'sess-1');

    await vi.advanceTimersByTimeAsync(2000);
    expect(streamState(ch).get('sess-1')!.buffer).toBe('');
  });

  it('resets the idle timer on each new chunk', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'part1', 'sess-1');

    // 1.5s later another chunk arrives
    vi.advanceTimersByTime(1500);
    onResponseChunk(ch, 'test-chat', 'part2', 'sess-1');

    // 1.5s after that (3s total) still not flushed
    vi.advanceTimersByTime(1500);
    expect(mockSendQQMessage).not.toHaveBeenCalled();

    // At 3.5s total (2s after last chunk) it flushes
    vi.advanceTimersByTime(500);
    await Promise.resolve();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
  });
});

describe('onToolCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function toolCall(sessionId: string): ToolCallEvent {
    return {
      sessionId,
      toolCallId: 'tc-1',
      toolName: 'search',
      args: { q: 'weather' },
    } as unknown as ToolCallEvent;
  }

  it('flushes the buffer and sends a message when buffer is non-empty', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'let me search...', 'sess-1');

    const flushed = ch.onToolCall('test-chat', toolCall('sess-1'));
    await Promise.resolve();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(mockSendQQMessage).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat/messages',
      'test-token',
      { markdown: { content: 'let me search...' }, msg_type: 2 },
    );
    expect(flushed).toBeUndefined(); // sendMessage is fire-and-forget via .catch
  });

  it('does nothing when there is no buffer for the session', () => {
    const ch = makeChannel();
    const flushed = ch.onToolCall('test-chat', toolCall('sess-unknown'));

    expect(mockSendQQMessage).not.toHaveBeenCalled();
    expect(flushed).toBeUndefined();
  });

  it('cancels the idle timer when flushing', () => {
    const ch = makeChannel();
    vi.spyOn(global, 'clearTimeout');

    onResponseChunk(ch, 'test-chat', 'text', 'sess-1');
    const timer = streamState(ch).get('sess-1')!.timer;

    ch.onToolCall('test-chat', toolCall('sess-1'));
    expect(clearTimeout).toHaveBeenCalledWith(timer);
  });

  it('clears the buffer after flushing', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'text before tool', 'sess-1');

    ch.onToolCall('test-chat', toolCall('sess-1'));

    // Buffer clearing is now async (in .then()) — wait for sendMessage to complete
    await vi.waitFor(
      () => {
        expect(streamState(ch).get('sess-1')!.buffer).toBe('');
      },
      { timeout: 1000, interval: 1 },
    );
  });

  it('only flushes the triggering session, not other sessions', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'chat-a', 'buffer-a', 'sess-a');
    onResponseChunk(ch, 'chat-b', 'buffer-b', 'sess-b');

    ch.onToolCall('chat-a', toolCall('sess-a'));
    await Promise.resolve();

    // Only sess-a was flushed
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(mockSendQQMessage).toHaveBeenCalledWith(
      expect.any(String),
      '/v2/users/chat-a/messages',
      expect.any(String),
      { markdown: { content: 'buffer-a' }, msg_type: 2 },
    );
    // sess-b's buffer is undisturbed
    expect(streamState(ch).get('sess-b')!.buffer).toBe('buffer-b');
  });

  it('does nothing when buffer is already empty', () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'txt', 'sess-1');
    ch.onToolCall('test-chat', toolCall('sess-1')); // first flush
    mockSendQQMessage.mockClear();

    // second call with same session — buffer is now empty
    ch.onToolCall('test-chat', toolCall('sess-1'));
    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('clears pendingStreamDelete when onToolCall send fails', async () => {
    const ch = makeChannel();
    // Use a deferred promise to control when the send resolves/rejects
    let rejectSend: (err: Error) => void;
    const sendPromise = new Promise((_resolve, reject) => {
      rejectSend = reject;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    // Start streaming
    onResponseChunk(ch, 'test-chat', 'text before tool', 'sess-1');

    // onToolCall starts the flush (async send in-flight)
    ch.onToolCall('test-chat', toolCall('sess-1'));

    // onResponseComplete fires while flushing → sets pendingStreamDelete
    await onResponseComplete(ch, 'test-chat', 'text before tool', 'sess-1');

    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    expect(pendingStreamDelete.has('sess-1')).toBe(true);

    // The send fails
    rejectSend!(new Error('send failed'));

    // Wait for the promise chain to settle
    try { await sendPromise; } catch { /* expected */ }
    await Promise.resolve();
    await Promise.resolve();

    // pendingStreamDelete should be cleared
    expect(pendingStreamDelete.has('sess-1')).toBe(false);

    // Buffer should be restored (the catch handler restores it)
    expect(streamState(ch).get('sess-1')!.buffer).toBe('text before tool');
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

  it('cancels the idle timer and sends the remaining buffer', async () => {
    const ch = makeChannel();
    vi.spyOn(global, 'clearTimeout');

    onResponseChunk(ch, 'test-chat', 'remaining text', 'sess-1');
    const timer = streamState(ch).get('sess-1')!.timer;

    await onResponseComplete(ch, 'test-chat', 'remaining text', 'sess-1');

    expect(clearTimeout).toHaveBeenCalledWith(timer);
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(mockSendQQMessage).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat/messages',
      'test-token',
      { markdown: { content: 'remaining text' }, msg_type: 2 },
    );
  });

  it('deletes the streamState entry after completion', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'done', 'sess-1');

    await onResponseComplete(ch, 'test-chat', 'done', 'sess-1');

    expect(streamState(ch).has('sess-1')).toBe(false);
  });

  it('falls back to fullText when there is no streamState for the session', async () => {
    const ch = makeChannel();

    await onResponseComplete(ch, 'test-chat', 'nothing', 'sess-none');

    expect(mockSendQQMessage).toHaveBeenCalled();
  });

  it('does not send when buffer is empty', async () => {
    // Simulate: onToolCall already flushed, then onResponseComplete fires
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'all flushed', 'sess-1');
    ch.onToolCall('test-chat', {
      sessionId: 'sess-1',
      toolCallId: 'tc',
      toolName: 'x',
      args: {},
    } as unknown as ToolCallEvent);
    // drain the async sendMessage chain before clearing
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    mockSendQQMessage.mockClear();

    await onResponseComplete(ch, 'test-chat', 'all flushed', 'sess-1');

    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('handles completion with buffered text across multiple sessions', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'chat-a', 'text-a', 'sess-a');
    onResponseChunk(ch, 'chat-b', 'text-b', 'sess-b');

    await onResponseComplete(ch, 'chat-a', 'text-a', 'sess-a');

    // sess-a is gone
    expect(streamState(ch).has('sess-a')).toBe(false);
    // sess-b is still there
    expect(streamState(ch).has('sess-b')).toBe(true);
    expect(streamState(ch).get('sess-b')!.buffer).toBe('text-b');
    // only sess-a's buffer was sent
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(mockSendQQMessage).toHaveBeenCalledWith(
      expect.any(String),
      '/v2/users/chat-a/messages',
      expect.any(String),
      { markdown: { content: 'text-a' }, msg_type: 2 },
    );
  });

  it('defers cleanup via pendingStreamDelete when idle-flush is in flight', async () => {
    const ch = makeChannel();
    // Set idle-flush to resolve slowly
    const sendPromise = Promise.resolve(mockResponse(true));
    mockSendQQMessage.mockReturnValue(sendPromise);

    // Start streaming → idle timer will fire
    onResponseChunk(ch, 'test-chat', 'streaming text', 'sess-1');

    // Advance to fire the idle timer (2s)
    vi.advanceTimersByTime(2000);
    await Promise.resolve();

    // The idle-flush should have sent the text; flushingSessions has the session
    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Set<string>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(flushingSessions.has('sess-1')).toBe(true);

    // Now onResponseComplete fires while idle-flush is in-flight
    await onResponseComplete(ch, 'test-chat', 'streaming text', 'sess-1');

    // Should defer through pendingStreamDelete — streamState still exists
    expect(pendingStreamDelete.has('sess-1')).toBe(true);
    expect(streamState(ch).has('sess-1')).toBe(true);

    // Let the idle-flush send promise resolve
    await sendPromise;
    // Drain the .then() and .finally() microtasks
    await Promise.resolve();
    await Promise.resolve();

    // StreamState should now be cleaned up
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
    expect(streamState(ch).has('sess-1')).toBe(false);
    expect(flushingSessions.has('sess-1')).toBe(false);
  });

  it('flushes orphaned buffer when pendingStreamDelete is set and new chunks arrive during idle-flush', async () => {
    const ch = makeChannel();
    // Use a pre-resolved promise (same pattern as the deferral test above)
    const sendPromise = Promise.resolve(mockResponse(true));
    mockSendQQMessage.mockReturnValue(sendPromise);

    // Start streaming
    onResponseChunk(ch, 'test-chat', 'initial text', 'sess-1');

    // Fire the idle timer (2s)
    vi.advanceTimersByTime(2000);
    await Promise.resolve();

    // idle-flush should have sent the text
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);

    // onResponseComplete fires while idle-flush is in-flight → pendingStreamDelete
    await onResponseComplete(ch, 'test-chat', 'initial text', 'sess-1');

    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    expect(pendingStreamDelete.has('sess-1')).toBe(true);
    expect(streamState(ch).has('sess-1')).toBe(true);

    // New chunk arrives during the async send → buffer is re-populated
    onResponseChunk(ch, 'test-chat', ' + orphaned', 'sess-1');
    expect(streamState(ch).get('sess-1')!.buffer).toBe(' + orphaned');

    // Resolve the send → .then() fires with pendingStreamDelete + non-empty buffer
    await sendPromise;
    // Drain the .then() and .finally() microtasks
    await Promise.resolve();
    await Promise.resolve();

    // Orphaned buffer should have been sent
    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    expect(mockSendQQMessage).toHaveBeenNthCalledWith(
      2,
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat/messages',
      'test-token',
      { markdown: { content: ' + orphaned' }, msg_type: 2 },
    );

    // StreamState should be cleaned up
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
    expect(streamState(ch).has('sess-1')).toBe(false);
  });
});

describe('idleFlush timeout', () => {
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
    await Promise.resolve();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(mockSendQQMessage).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat/messages',
      'test-token',
      { markdown: { content: 'auto-flush me' }, msg_type: 2 },
    );
  });

  it('sets timer to null after idleFlush fires', () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'hello', 'sess-1');

    vi.advanceTimersByTime(2000);

    expect(streamState(ch).get('sess-1')!.timer).toBeNull();
  });

  it('does not flush if buffer was already emptied by onToolCall', () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'pre-tool text', 'sess-1');
    ch.onToolCall('test-chat', {
      sessionId: 'sess-1',
      toolCallId: 'tc',
      toolName: 'x',
      args: {},
    } as unknown as ToolCallEvent);
    mockSendQQMessage.mockClear();

    // Advance past the original 2s mark — the timer was cancelled by onToolCall
    vi.advanceTimersByTime(2000);

    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('each session has its own independent idle timer', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'chat-a', 'a', 'sess-a');
    // Advance 1.5s before starting session b
    vi.advanceTimersByTime(1500);
    onResponseChunk(ch, 'chat-b', 'b', 'sess-b');

    // At 2s total: sess-a's timer fires, sess-b still has 0.5s
    vi.advanceTimersByTime(500);
    await Promise.resolve();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(mockSendQQMessage).toHaveBeenCalledWith(
      expect.any(String),
      '/v2/users/chat-a/messages',
      expect.any(String),
      { markdown: { content: 'a' }, msg_type: 2 },
    );

    // At 3.5s total (2s after sess-b's last chunk): sess-b's timer fires
    vi.advanceTimersByTime(1500);
    await Promise.resolve();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    expect(mockSendQQMessage).toHaveBeenCalledWith(
      expect.any(String),
      '/v2/users/chat-b/messages',
      expect.any(String),
      { markdown: { content: 'b' }, msg_type: 2 },
    );
  });
});
