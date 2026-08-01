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
    onSessionDied(_sessionId: string): void {
      // no-op in mock; overridden by QQChannel
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
      dmPolicy: 'open',
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
      msgId?: string;
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

function onResponseBoundary(
  ch: QQChannelClass,
  chatId: string,
  sessionId: string,
) {
  return (
    ch as unknown as {
      onResponseBoundary: (c: string, s: string) => void;
    }
  ).onResponseBoundary(chatId, sessionId);
}

function setReplyMsgId(
  ch: QQChannelClass,
  chatId: string,
  msgId: string,
) {
  (
    ch as unknown as {
      setReplyMsgId: (c: string, m: string) => void;
    }
  ).setReplyMsgId(chatId, msgId);
}

function onPromptStart(
  ch: QQChannelClass,
  chatId: string,
  sessionId: string,
  messageId?: string,
) {
  (
    ch as unknown as {
      onPromptStart: (
        c: string,
        s: string,
        m?: string,
      ) => void;
    }
  ).onPromptStart(chatId, sessionId, messageId);
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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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

  it('snaps the onPromptStart anchor into the streamState entry on creation', () => {
    const ch = makeChannel();
    // onPromptStart anchors the session; the first chunk carries it into
    // the new streamState entry.
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');

    onResponseChunk(ch, 'test-chat', 'hello', 'sess-1');

    expect(streamState(ch).get('sess-1')!.msgId).toBe('msg-A');
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
    // Verify content was sent (sendQQMessage takes 4 args, body is 4th)
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    expect((body.markdown as Record<string, string>).content).toBe(
      'auto-flush me',
    );
  });

  it('deletes streamState on successful idle flush', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'hello', 'sess-1');

    vi.advanceTimersByTime(2000);
    await drain();

    // streamState cleaned up on success
    expect(streamState(ch).has('sess-1')).toBe(false);
    // Verify content was sent
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    expect((body.markdown as Record<string, string>).content).toBe('hello');
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

  it('keeps chunks anchored to the originating msgId when a newer message overwrites replyMsgId mid-stream', async () => {
    const ch = makeChannel();
    // User A's message starts a streaming reply; onPromptStart anchors it.
    onPromptStart(ch, 'test-chat', 'sess-A', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'chunk1 ', 'sess-A');

    // User B's message arrives mid-stream and overwrites the chat-level entry.
    setReplyMsgId(ch, 'test-chat', 'msg-B');

    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    // A's chunk must stay under A's msg_id — not get re-parented onto B.
    expect(body['msg_id']).toBe('msg-A');
  });

  it('two sessions on the same chat each anchor their streaming chunks to their own msgId', async () => {
    const ch = makeChannel();
    // A triggers a stream.
    onPromptStart(ch, 'test-chat', 'sess-A', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'part-A ', 'sess-A');
    // B arrives mid-stream, overwrites the entry, and triggers its own stream.
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 'sess-B', 'msg-B');
    onResponseChunk(ch, 'test-chat', 'part-B ', 'sess-B');

    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    const msgIds = mockSendQQMessage.mock.calls
      .map((c) => (c[3] as Record<string, unknown>)['msg_id'])
      .sort();
    // Each session's chunk goes under the msgId that triggered it.
    expect(msgIds).toEqual(['msg-A', 'msg-B']);
  });

  it('a stream anchored to an overwritten msgId keeps its msg_seq counter (not reset by setReplyMsgId)', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;
    onPromptStart(ch, 'test-chat', 'sess-A', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'part1 ', 'sess-A');

    // A's first chunk is sent (seq 1 for msg-A).
    vi.advanceTimersByTime(2000);
    await drain();
    expect(seqMap.get('msg-A')).toBe(1);

    // B overwrites the chat-level entry while A's stream continues.
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onResponseChunk(ch, 'test-chat', 'part2 ', 'sess-A');

    // A's seq counter must survive the overwrite (setReplyMsgId guard).
    expect(seqMap.get('msg-A')).toBe(1);

    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    // Second chunk of msg-A continues at seq 2, anchored to msg-A.
    expect(seqMap.get('msg-A')).toBe(2);
    const secondBody = mockSendQQMessage.mock.calls[1][3] as Record<
      string,
      unknown
    >;
    expect(secondBody['msg_id']).toBe('msg-A');
    expect(secondBody['msg_seq']).toBe(2);
  });

  it('onPromptEnd releases a cancelled session anchor so the next prompt sets a fresh one', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    // A stale anchor left behind by a cancelled turn (onResponseComplete is
    // skipped on cancel, so only onPromptEnd can release it).
    sessionAnchors.set('sess-A', { msgId: 'msg-OLD', timestamp: Date.now() });
    // Meanwhile the chat-level entry has moved on to a newer message.
    setReplyMsgId(ch, 'test-chat', 'msg-NEW');

    // ChannelBase's finally invokes onPromptEnd even after cancellation.
    (ch as unknown as { onPromptEnd: (c: string, s: string) => void })
      .onPromptEnd('test-chat', 'sess-A');
    expect(sessionAnchors.has('sess-A')).toBe(false);

    // The next prompt on the same session anchors from ITS OWN triggering
    // message (onPromptStart) — the stale msg-OLD must not leak through.
    onPromptStart(ch, 'test-chat', 'sess-A', 'msg-NEW');
    onResponseChunk(ch, 'test-chat', 'hello ', 'sess-A');
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    expect(body['msg_id']).toBe('msg-NEW');
  });

  it('releasing a session anchor purges its orphaned msg_seq entry (but keeps live ones)', () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;
    const replyMap = chp['replyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const promptEnd = (
      ch: QQChannelClass,
      chatId: string,
      sessionId: string,
    ) =>
      (ch as unknown as { onPromptEnd: (c: string, s: string) => void })
        .onPromptEnd(chatId, sessionId);

    // Session A streams under msg-A while the chat entry still references it.
    sessionAnchors.set('sess-A', { msgId: 'msg-A', timestamp: Date.now() });
    seqMap.set('msg-A', 3);
    replyMap.set('test-chat', { msgId: 'msg-A', timestamp: Date.now() });

    // Chat entry still points at msg-A → its seq must survive the release.
    promptEnd(ch, 'test-chat', 'sess-A');
    expect(seqMap.get('msg-A')).toBe(3);

    // Chat entry moves to msg-B with no session anchored to msg-A anymore:
    // the next release must drop the orphaned seq counter.
    sessionAnchors.set('sess-A', { msgId: 'msg-A', timestamp: Date.now() });
    replyMap.set('test-chat', { msgId: 'msg-B', timestamp: Date.now() });
    promptEnd(ch, 'test-chat', 'sess-A');
    expect(seqMap.has('msg-A')).toBe(false);
  });

  it('onPromptEnd leaves a deferred (in-flight flush) session for its promise chain to finish', () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const pendingDeletes = chp['pendingStreamDelete'] as Set<string>;
    const st = streamState(ch);

    // A chunk is buffered and a flush is in flight (deferred completion).
    // onPromptStart sets the anchor; the first chunk snaps it into state.
    onPromptStart(ch, 'test-chat', 'sess-A', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'tail ', 'sess-A');
    pendingDeletes.add('sess-A');

    // onPromptEnd must NOT clear state that the in-flight flush's .then()
    // owns — clearing it would trip the identity guard and drop the
    // residual buffer. The .then() chain re-flushes and releases instead.
    (ch as unknown as { onPromptEnd: (c: string, s: string) => void })
      .onPromptEnd('test-chat', 'sess-A');
    expect(st.has('sess-A')).toBe(true);
    expect(pendingDeletes.has('sess-A')).toBe(true);
    expect(sessionAnchors.has('sess-A')).toBe(true);
    expect(st.get('sess-A')!.buffer).toBe('tail ');
  });

  it('anchors a slow turn to its triggering msgId even after the chat entry expires or moves on', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const replyMap = chp['replyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;

    // User A triggers a turn. The chat-level entry is already stale by the
    // time the model's first chunk arrives (slow turn > 5-minute TTL), and a
    // concurrent message from user B has since overwritten it.
    onPromptStart(ch, 'test-chat', 'sess-A', 'msg-A');
    replyMap.set('test-chat', {
      msgId: 'msg-A',
      timestamp: Date.now() - 10 * 60_000,
    });
    setReplyMsgId(ch, 'test-chat', 'msg-B');

    onResponseChunk(ch, 'test-chat', 'slow reply ', 'sess-A');
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    // Anchored to A's triggering message — the opportunistic capture would
    // have picked up B's msgId here.
    expect(body['msg_id']).toBe('msg-A');
    expect(sessionAnchors.get('sess-A')!.msgId).toBe('msg-A');
  });

  it('drops the anchor past its TTL so chunks go out as active sends', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const replyMap = chp['replyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;

    // Anchor set at prompt start, but the first chunk only arrives after the
    // TTL elapsed (model thought for > 5 minutes) — and the chat-level entry
    // is gone/expired too, so the send must be fully active (no msg_id).
    sessionAnchors.set('sess-A', {
      msgId: 'msg-STALE',
      timestamp: Date.now() - (300_000 + 1000),
    });
    replyMap.delete('test-chat');

    onResponseChunk(ch, 'test-chat', 'late ', 'sess-A');
    vi.advanceTimersByTime(2000);
    await drain();

    // The stale anchor was dropped at read time.
    expect(sessionAnchors.has('sess-A')).toBe(false);
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    expect(body['msg_id']).toBeUndefined();
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
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    expect((body.markdown as Record<string, string>).content).toBe(
      'let me search...',
    );
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

  it('send failure re-buffers and retries (not silently lost)', async () => {
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

    rejectSend!(new Error('send failed'));
    try {
      await sendPromise;
    } catch {
      /* expected */
    }
    await drain();

    // Re-buffered for retry instead of silently dropped. The pending flag is
    // re-armed for the retry chain so its settle path releases the reply
    // anchor exactly once (the anchor must survive until the tail's send has
    // resolved its msg_seq from msgSeqMap).
    expect(pendingStreamDelete.has('sess-1')).toBe(true);
    expect(streamState(ch).has('sess-1')).toBe(true);
    expect(streamState(ch).get('sess-1')!.buffer).toBe('text before tool');

    // After MAX_FLUSH_RETRIES retries, streamState is cleaned up
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(2000);
      await drain();
    }
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
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    expect((body.markdown as Record<string, string>).content).toBe(
      'remaining text',
    );
    expect(streamState(ch).has('sess-1')).toBe(false);
  });

  it('final segment keeps the captured per-session msgId even after replyMsgId is overwritten', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    // onPromptStart anchors sess-A to msg-A; the chat-level entry also
    // points at msg-A initially.
    onPromptStart(ch, 'test-chat', 'sess-A', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'final tail', 'sess-A');
    // A concurrent message overwrites the chat-level entry mid-stream.
    (
      chp['replyMsgId'] as Map<string, { msgId: string; timestamp: number }>
    ).set('test-chat', { msgId: 'msg-B', timestamp: Date.now() });

    await onResponseComplete(ch, 'test-chat', 'ignored-fulltext', 'sess-A');

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    expect((body.markdown as Record<string, string>).content).toBe(
      'final tail',
    );
    expect(body['msg_id']).toBe('msg-A');
  });

  it('final segment goes out as an active send when the anchor has expired (TTL)', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    // onPromptStart anchors sess-A to msg-A; the first chunk snaps it into
    // streamState while it is still fresh.
    onPromptStart(ch, 'test-chat', 'sess-A', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'final tail', 'sess-A');
    // The final segment only arrives after the 5-minute TTL elapsed — the
    // anchor is stale by the time onResponseComplete reads it, so the send
    // must fall back to the active path (no msg_id, no msg_seq).
    sessionAnchors.set('sess-A', {
      msgId: 'msg-A',
      timestamp: Date.now() - (300_000 + 1000),
    });

    await onResponseComplete(ch, 'test-chat', 'ignored-fulltext', 'sess-A');

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    expect((body.markdown as Record<string, string>).content).toBe(
      'final tail',
    );
    expect(body['msg_id']).toBeUndefined();
    // The stale anchor is dropped via the release path.
    expect(sessionAnchors.has('sess-A')).toBe(false);
  });

  it('falls back to fullText when no streamState', async () => {
    const ch = makeChannel();
    await onResponseComplete(ch, 'test-chat', 'nothing', 'sess-none');
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    expect((body.markdown as Record<string, string>).content).toBe('nothing');
  });

  it('drops accumulated buffer at response boundary', async () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'intermediate ', 'sess-1');

    onResponseBoundary(ch, 'test-chat', 'sess-1');
    await onResponseComplete(ch, 'test-chat', 'final', 'sess-1');

    expect(streamState(ch).has('sess-1')).toBe(false);
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    expect((body.markdown as Record<string, string>).content).toBe('final');
  });

  it('clears an in-flight flush marker at response boundary', () => {
    const ch = makeChannel();
    const channel = ch as unknown as Record<string, unknown>;
    const flushingSessions = channel['flushingSessions'] as Set<string>;
    flushingSessions.add('sess-1');

    onResponseBoundary(ch, 'test-chat', 'sess-1');

    expect(flushingSessions.has('sess-1')).toBe(false);
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

  it('pendingStreamDelete failure re-buffers and retries (no leak)', async () => {
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

    // Re-buffered for retry instead of silently dropped. The pending flag is
    // re-armed for the retry chain so its settle path releases the reply
    // anchor exactly once (the anchor must survive until the tail's send has
    // resolved its msg_seq from msgSeqMap).
    expect(pendingStreamDelete.has('sess-1')).toBe(true);
    expect(streamState(ch).has('sess-1')).toBe(true);
    expect(streamState(ch).get('sess-1')!.buffer).toBe('text');

    // After retries exhausted, streamState is cleaned up
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(2000);
      await drain();
    }
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

describe('error recovery paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('idleFlush retries after send failure and succeeds', async () => {
    const ch = makeChannel();
    mockSendQQMessage
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue(mockResponse(true));

    onResponseChunk(ch, 'test-chat', 'retry me', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();

    // First send failed
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);

    // Advance retry timer
    vi.advanceTimersByTime(2000);
    await drain();

    // Retry succeeded
    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
  });

  it('idleFlush stops retrying after MAX_FLUSH_RETRIES failures', async () => {
    const ch = makeChannel();
    mockSendQQMessage.mockRejectedValue(new Error('persistent error'));

    onResponseChunk(ch, 'test-chat', 'doomed', 'sess-1');

    // Each idleFlush fires + MAX_FLUSH_RETRIES retries before giving up
    for (let i = 0; i <= 3; i++) {
      vi.advanceTimersByTime(2000);
      await drain();
    }

    // After retries exhausted, streamState is deleted
    expect(streamState(ch).has('sess-1')).toBe(false);
  });

  it('retries when pendingStreamDelete is set and send fails (no silent data loss)', async () => {
    const ch = makeChannel();
    mockSendQQMessage
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue(mockResponse(true));

    onResponseChunk(ch, 'test-chat', 'last words', 'sess-1');

    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    pendingStreamDelete.add('sess-1');

    // Trigger first idleFlush
    vi.advanceTimersByTime(2000);
    await drain();

    // pendingStreamDelete should be re-armed for the retry chain (the anchor
    // must survive until the retried tail's send has read its msg_seq), buffer
    // restored for retry
    expect(pendingStreamDelete.has('sess-1')).toBe(true);
    expect(streamState(ch).get('sess-1')!.buffer).toBe('last words');

    // Advance retry timer
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    expect(streamState(ch).has('sess-1')).toBe(false);
    // The retry chain's .then() released the pending flag on success.
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
  });

  it('onToolCall retries after send failure', async () => {
    const ch = makeChannel();
    mockSendQQMessage
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue(mockResponse(true));

    onResponseChunk(ch, 'test-chat', 'tool text', 'sess-1');
    ch.onToolCall('test-chat', toolCall('sess-1'));
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);

    // Advance retry timer
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
  });

  it('onToolCall catch uses fresh streamState (stale closure fix)', async () => {
    const ch = makeChannel();
    let rejectSend: (err: Error) => void;
    const sendPromise = new Promise<MockResponse>((_r, rej) => {
      rejectSend = rej as (err: Error) => void;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    onResponseChunk(ch, 'test-chat', 'before tool', 'sess-1');
    ch.onToolCall('test-chat', toolCall('sess-1'));

    // While send is in flight, simulate new chunks arriving via onResponseChunk
    // The current streamState still exists so onResponseChunk mutates it
    (ch as unknown as Record<string, unknown>)['onResponseChunk'](
      'test-chat',
      ' fresh',
      'sess-1',
    );

    // Let the original send fail
    rejectSend!(new Error('send failed'));
    try {
      await sendPromise;
    } catch {
      /* expected */
    }
    await drain();

    // The retry buffer should include the fresh chunk (appended by .catch())
    const st = streamState(ch).get('sess-1');
    expect(st).toBeDefined();
    expect(st!.buffer).toContain('before tool');
    expect(st!.buffer).toContain(' fresh');
  });

  it('disconnect() clears all streaming state', () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'buffered', 'sess-1');

    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Set<string>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const flushedSessions = chp['flushedSessions'] as Set<string>;

    flushingSessions.add('sess-1');
    pendingStreamDelete.add('sess-1');
    flushedSessions.add('sess-1');

    (chp['disconnect'] as () => void)();

    expect(streamState(ch).size).toBe(0);
    expect(flushingSessions.size).toBe(0);
    expect(pendingStreamDelete.size).toBe(0);
    expect(flushedSessions.size).toBe(0);
  });

  it('onSessionDied cleans up stream state for dead session', () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    // Anchor the session to its triggering message (onPromptStart), then
    // stream a chunk so onSessionDied must clean up both the stream state
    // and the reply anchor (releaseSessionReplyAnchor).
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-1');
    expect(sessionAnchors.has('sess-1')).toBe(true);
    onResponseChunk(ch, 'test-chat', 'alive', 'sess-1');

    vi.spyOn(global, 'clearTimeout');
    const entry = streamState(ch).get('sess-1');
    const timer = entry!.timer;

    ch.onSessionDied('sess-1');

    expect(clearTimeout).toHaveBeenCalledWith(timer);
    expect(streamState(ch).has('sess-1')).toBe(false);
    // releaseSessionReplyAnchor drops the dead session's reply anchor too.
    expect(sessionAnchors.has('sess-1')).toBe(false);

    expect((chp['flushingSessions'] as Set<string>).has('sess-1')).toBe(false);
    expect((chp['pendingStreamDelete'] as Set<string>).has('sess-1')).toBe(
      false,
    );
    expect((chp['flushedSessions'] as Set<string>).has('sess-1')).toBe(false);
  });

  it('flushingSessions guard prevents retry while already flushing', async () => {
    const ch = makeChannel();
    mockSendQQMessage.mockRejectedValue(new Error('fail'));

    onResponseChunk(ch, 'test-chat', 'hello', 'sess-1');

    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Set<string>;

    // First idleFlush triggers
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);

    // Simulate that the session is now marked as flushing (duplicate prevention)
    flushingSessions.add('sess-1');

    // Retry timer fires but idleFlush bails due to flushingSessions guard
    vi.advanceTimersByTime(2000);
    await drain();

    // No additional send call
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
  });

  it('disconnect() calls clearTimeout on streamState timers', () => {
    const ch = makeChannel();
    vi.spyOn(global, 'clearTimeout');

    onResponseChunk(ch, 'test-chat', 'buffered', 'sess-1');
    const entry = streamState(ch).get('sess-1');
    expect(entry!.timer).not.toBeNull();

    const chp = ch as unknown as Record<string, unknown>;
    (chp['disconnect'] as () => void)();

    expect(clearTimeout).toHaveBeenCalledWith(entry!.timer);
  });

  it('wasFlushed dedup skips send in onResponseComplete', async () => {
    const ch = makeChannel();
    // Reset mock implementation (previous test may have left it rejecting)
    mockSendQQMessage.mockResolvedValue(mockResponse(true));

    const chp = ch as unknown as Record<string, unknown>;
    const flushedSessions = chp['flushedSessions'] as Set<string>;
    flushedSessions.add('sess-1');

    await onResponseComplete(ch, 'test-chat', 'full text', 'sess-1');

    // wasFlushed=true + no streamState => remaining='' => no send
    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('onToolCall flushingSessions guard prevents send while flushing', () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'tool text', 'sess-1');

    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Set<string>;
    flushingSessions.add('sess-1');

    ch.onToolCall('test-chat', toolCall('sess-1'));

    // Buffer should NOT be cleared (guard prevented the send path)
    expect(streamState(ch).get('sess-1')!.buffer).toBe('tool text');
    // sendMessage should NOT have been called
    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });
});

describe('buffer limit flush (#11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes immediately when buffer exceeds MAX_BUFFER_LENGTH', async () => {
    const ch = makeChannel();
    // MAX_BUFFER_LENGTH = 4096, send a chunk that pushes past it
    const bigChunk = 'a'.repeat(3000);
    onResponseChunk(ch, 'test-chat', bigChunk, 'sess-1');

    // Buffer is under limit, no immediate flush
    expect(mockSendQQMessage).not.toHaveBeenCalled();

    // Push over the limit
    onResponseChunk(ch, 'test-chat', 'b'.repeat(2000), 'sess-1');
    await drain();

    // Should flush immediately
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    expect((body.markdown as Record<string, string>).content).toBe(
      bigChunk + 'b'.repeat(2000),
    );
  });
});

describe('idleFlush guard re-schedule (#5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-schedules timer when flushing guard blocks idleFlush', async () => {
    const ch = makeChannel();
    // Resolve the send eventually
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    onResponseChunk(ch, 'test-chat', 'hello', 'sess-1');

    // Fire idleFlush timer
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);

    // Now the session is flushing. Simulate another idleFlush firing.
    // idleFlush should set a new timer and return.
    const st = streamState(ch).get('sess-1')!;
    expect(st.buffer).toBe(''); // buffer was cleared

    // Simulate: buffer gets content while flushing
    st.buffer = 'new content';

    // Another idleFlush fires but flushingSessions guard blocks
    const chp = ch as unknown as Record<string, unknown>;
    const prevTimer = st.timer;
    (chp['idleFlush'] as (sid: string, rid: number) => void)(
      'sess-1',
      chp['_reconnectId'] as number,
    );

    // A new timer should have been set for re-schedule
    expect(st.timer).not.toBeNull();
    expect(st.timer).not.toBe(prevTimer);

    // Clean up
    resolveSend!(mockResponse(true));
    // Clean up
    resolveSend!(mockResponse(true));
  });
});

describe('in-flight send + new chunk + onResponseComplete (#4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('new content during send re-scheduled by .then() after onResponseComplete', async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    onResponseChunk(ch, 'test-chat', 'part1', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();

    // First send in-flight. New content arrives.
    onResponseChunk(ch, 'test-chat', ' part2', 'sess-1');

    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    pendingStreamDelete.add('sess-1');

    // Resolve the send
    resolveSend!(mockResponse(true));
    await drain();

    // .then() should: delete pendingStreamDelete, re-arm it for the re-flush
    // chain (residual buffer still queued — the anchor must survive until the
    // tail's send has read its msg_seq), and schedule a new idleFlush timer
    expect(pendingStreamDelete.has('sess-1')).toBe(true);
    expect(streamState(ch).has('sess-1')).toBe(true);
    expect(streamState(ch).get('sess-1')!.buffer).toBe(' part2');
    expect(streamState(ch).get('sess-1')!.timer).not.toBeNull();
  });
});

describe('.then() retains streamState during send (#12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retains streamState when new chunk arrives during in-flight send', async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    onResponseChunk(ch, 'test-chat', 'initial', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();

    // First send is in-flight
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);

    // New chunk arrives while send is in-flight
    onResponseChunk(ch, 'test-chat', ' additional', 'sess-1');

    const st = streamState(ch);
    expect(st.has('sess-1')).toBe(true);
    expect(st.get('sess-1')!.buffer).toContain('additional');

    // Resolve the send
    resolveSend!(mockResponse(true));
    await drain();

    // .then() should see buffer is non-empty and retain streamState
    expect(st.has('sess-1')).toBe(true);
    expect(st.get('sess-1')!.buffer).toBe(' additional');
  });
});

describe('identity guard (#3, #6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('.then() does not modify state when session died during send', async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    onResponseChunk(ch, 'test-chat', 'dying session', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();

    // First send is in-flight
    // Kill the session
    ch.onSessionDied('sess-1');

    expect(streamState(ch).has('sess-1')).toBe(false);

    // Now a new session starts with the same ID
    onResponseChunk(ch, 'test-chat', 'new session', 'sess-1');

    const newState = streamState(ch).get('sess-1');
    expect(newState).toBeDefined();
    expect(newState!.buffer).toBe('new session');

    // Now resolve the OLD send
    resolveSend!(mockResponse(true));
    await drain();

    // .then() should detect current !== state and return early
    // The NEW session should NOT be affected
    expect(streamState(ch).has('sess-1')).toBe(true);
    expect(streamState(ch).get('sess-1')!.buffer).toBe('new session');
    // flushedSessions should NOT include the new session (old send added it,
    // but the guard skips that addition for the wrong state)
    // The old send would add flushedSessions but since the session was re-created,
    // it's a different state object, so the guard returns early.
    // flushedSessions may or may not have sess-1 depending on if the first send
    // added it before onSessionDied cleared it. onSessionDied clears flushedSessions.
  });
});
