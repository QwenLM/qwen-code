import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  type QQChannel as QQChannelClass,
  DeliveryError,
} from './QQChannel.js';
import type { ToolCallEvent } from '@qwen-code/channel-base';

const { mockSendQQMessage, mockFetchAccessToken, responseMessageIdRef } =
  vi.hoisted(() => ({
    mockSendQQMessage: vi.fn(),
    mockFetchAccessToken: vi.fn(),
    // Mutable so a test can make the mocked ChannelBase report the messageId of
    // the turn a response belongs to, and change it mid-flight to simulate a
    // successor turn taking the slot.
    responseMessageIdRef: { current: undefined as string | undefined },
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
    protected getResponseMessageId(_sessionId: string): string | undefined {
      return responseMessageIdRef.current;
    }
    protected getResponseSourceLabel(_sessionId: string): undefined {
      return undefined;
    }
    protected formatMarkdownAttributedText(
      text: string,
      sourceLabel?: string,
    ): string {
      const label = sourceLabel?.replace(/([\\`*_[\]{}()#+.!|>~-])/gu, '\\$1');
      return label ? `${label}\n${text}` : text;
    }
    protected formatAttributedText(text: string, sourceLabel?: string): string {
      return sourceLabel ? `${sourceLabel} ${text}` : text;
    }
    protected async onResponseComplete(
      _chatId: string,
      fullText: string,
      sessionId: string,
    ): Promise<void> {
      await (
        this as unknown as {
          sendResponseMessage: (
            c: string,
            t: string,
            s: string,
          ) => Promise<void>;
        }
      ).sendResponseMessage(_chatId, fullText, sessionId);
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
  truncateCodePoints: (text: string, max: number): string =>
    [...text].slice(0, max).join(''),
  // Mirrors @qwen-code/channel-base: at most `max` UTF-16 units, cut on
  // code-point boundaries, so a pair is never split.
  truncateUtf16Units: (text: string, max: number): string => {
    if (text.length <= max) return text;
    let kept = '';
    for (const ch of text) {
      if (kept.length + ch.length > max) break;
      kept += ch;
    }
    return kept;
  },
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

function makeChannel(
  overrides: Record<string, unknown> = {},
  bridgeOverride: Record<string, unknown> = {},
): QQChannelClass {
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
    bridgeOverride as unknown as import('@qwen-code/channel-base').ChannelAgentBridge,
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
      sourceLabel?: string;
      msgId?: string;
      turn: number;
    }
  >;
}

/**
 * The ownership-keyed flush marker's value is the awaited streamState entry —
 * production never stores `undefined`, so fixtures seed a real entry shape.
 */
type FlushMarkerState = {
  chatId: string;
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
  retryCount: number;
  turn: number;
};

function flushMarkerState(turn = 1): FlushMarkerState {
  return {
    chatId: 'test-chat',
    buffer: '',
    timer: null,
    retryCount: 0,
    turn,
  };
}

function onResponseChunk(
  ch: QQChannelClass,
  chatId: string,
  chunk: string,
  sessionId: string,
  messageId?: string,
  sourceLabel?: string,
) {
  return (
    ch as unknown as {
      onResponseChunk: (
        c: string,
        h: string,
        s: string,
        segment?: { messageId?: string; sourceLabel?: string },
      ) => void;
    }
  ).onResponseChunk(
    chatId,
    chunk,
    sessionId,
    messageId || sourceLabel ? { messageId, sourceLabel } : undefined,
  );
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

function setReplyMsgId(ch: QQChannelClass, chatId: string, msgId: string) {
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
      onPromptStart: (c: string, s: string, m?: string) => void;
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

/** Join everything written to process.stderr since the last spy call. */
function capturedStderr(): string {
  return vi
    .mocked(process.stderr.write)
    .mock.calls.map((c) => String(c[0]))
    .join('');
}

/** No lone surrogate: the runtime check behind String#isWellFormed. */
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
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

  it('keeps source metadata separate from the raw retry buffer and labels the flush once', async () => {
    const ch = makeChannel();
    onResponseChunk(
      ch,
      'test-chat',
      'raw response',
      'sess-1',
      undefined,
      '[review_*]',
    );

    expect(streamState(ch).get('sess-1')).toMatchObject({
      buffer: 'raw response',
      sourceLabel: '[review_*]',
    });

    vi.advanceTimersByTime(2000);
    await drain();
    const body = mockSendQQMessage.mock.calls[0]?.[3] as {
      markdown: { content: string };
    };
    expect(body.markdown.content).toBe('\\[review\\_\\*\\]\nraw response');
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

  it('drops stale state from a previous turn and clears its parking flags', async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);
    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Map<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const flushedSessions = chp['flushedSessions'] as Set<string>;

    // Turn 1 anchors and streams; its idle flush captured the buffer and is
    // in flight (send pending), and the completion deferred the teardown
    // (pendingStreamDelete parked) when the new prompt starts before the
    // send settles. The stale entry carries NO residual (the flush already
    // took it), so the drop path runs.
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-1');
    onResponseChunk(ch, 'test-chat', 'turn-1-buffer', 'sess-1');
    expect(streamState(ch).get('sess-1')!.turn).toBe(1);
    vi.advanceTimersByTime(2000);
    await drain();
    // Flush in flight: buffer captured, flushingSessions armed. Seed a
    // flushed record too — the stale-drop must clear it along with the
    // other turn-1 parking flags (thread 56).
    expect(streamState(ch).get('sess-1')!.buffer).toBe('');
    expect(flushingSessions.has('sess-1')).toBe(true);
    flushedSessions.add('sess-1');
    pendingStreamDelete.add('sess-1');

    // Turn 2 starts: bumps the turn counter and overwrites the anchor.
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-2');

    // The first chunk of turn 2 hits the stale-state branch: the old entry
    // (turn=1) is dropped along with its parking flags, and a fresh entry is
    // created under turn 2's anchor.
    onResponseChunk(ch, 'test-chat', 'turn-2-chunk', 'sess-1');

    const st = streamState(ch).get('sess-1')!;
    expect(st.buffer).toBe('turn-2-chunk');
    expect(st.msgId).toBe('msg-2');
    expect(st.turn).toBe(2);
    // The turn-1 parking flags are cleared so turn 2's onResponseComplete /
    // onPromptEnd are not short-circuited into a silent reply loss.
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
    expect(flushedSessions.has('sess-1')).toBe(false);
    // The flush marker is NOT cleared here: it is ownership-keyed, and only
    // the chain whose send is still in flight may release it.
    expect(flushingSessions.has('sess-1')).toBe(true);

    const seqMap = chp['msgSeqMap'] as Map<string, number>;

    // Clean up the still-pending turn-1 send; its own chain releases both
    // the marker and the superseded turn's msg_seq counter on settle.
    resolveSend!(mockResponse(true));
    await drain();
    expect(flushingSessions.has('sess-1')).toBe(false);
    // The superseded turn's counter was released by the in-flight chain's
    // own settle, not by the superseded branch (its release was vetoed by
    // the live flush marker).
    expect(seqMap.has('msg-1')).toBe(false);
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

  it('keeps same-chat streams bound to their originating messages', async () => {
    const ch = makeChannel();
    const replyContexts = (
      ch as unknown as {
        replyContextByMessageId: Map<
          string,
          { chatId: string; msgId: string; timestamp: number }
        >;
      }
    ).replyContextByMessageId;
    const timestamp = Date.now();
    replyContexts.set('msg-a', {
      chatId: 'test-chat',
      msgId: 'msg-a',
      timestamp,
    });
    replyContexts.set('msg-b', {
      chatId: 'test-chat',
      msgId: 'msg-b',
      timestamp,
    });

    onResponseChunk(ch, 'test-chat', 'a-1', 'session-a', 'msg-a');
    onResponseChunk(ch, 'test-chat', 'b-1', 'session-b', 'msg-b');
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    expect(mockSendQQMessage.mock.calls[0][3]).toMatchObject({
      msg_id: 'msg-a',
      msg_seq: 1,
    });
    expect(mockSendQQMessage.mock.calls[1][3]).toMatchObject({
      msg_id: 'msg-b',
      msg_seq: 1,
    });

    onResponseChunk(ch, 'test-chat', 'a-2', 'session-a', 'msg-a');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage.mock.calls[2][3]).toMatchObject({
      msg_id: 'msg-a',
      msg_seq: 2,
    });
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
    // Establish the chat-level entry pointing at msg-A FIRST, then overwrite
    // it with msg-B while A's stream is live. setReplyMsgId itself never drops
    // the previous msgId's counter (see its NOTE); this pins that the
    // overwrite is not what reclaims it — the counter survives because the
    // session anchor still names msg-A.
    setReplyMsgId(ch, 'test-chat', 'msg-A');
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
    (
      ch as unknown as { onPromptEnd: (c: string, s: string) => void }
    ).onPromptEnd('test-chat', 'sess-A');
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
    const promptEnd = (ch: QQChannelClass, chatId: string, sessionId: string) =>
      (
        ch as unknown as { onPromptEnd: (c: string, s: string) => void }
      ).onPromptEnd(chatId, sessionId);

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

  it('releasing one of two sessions anchored to the same msgId keeps the shared seq counter', () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;
    const promptEnd = (ch: QQChannelClass, chatId: string, sessionId: string) =>
      (
        ch as unknown as { onPromptEnd: (c: string, s: string) => void }
      ).onPromptEnd(chatId, sessionId);

    // Two concurrent sessions both stream under msg-X (e.g. two sessions in
    // the same chat triggered by the same message). Releasing one of them
    // must NOT purge msg-X's seq counter while the other is still anchored.
    sessionAnchors.set('sess-A', { msgId: 'msg-X', timestamp: Date.now() });
    sessionAnchors.set('sess-B', { msgId: 'msg-X', timestamp: Date.now() });
    seqMap.set('msg-X', 3);

    promptEnd(ch, 'test-chat', 'sess-A');

    // sess-B still anchors msg-X → isMsgIdAnchoredBySession keeps the seq.
    expect(seqMap.get('msg-X')).toBe(3);
    expect(sessionAnchors.has('sess-A')).toBe(false);
    expect(sessionAnchors.has('sess-B')).toBe(true);
  });

  it('onPromptStart releases the previous turn anchor before overwriting, cascading its orphaned seq', () => {
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

    // The previous turn's anchor is live with a real msg_seq counter, the
    // chat entry has moved on to msg-B, and no streamState entry holds msg-A
    // (no residual buffer) — so the release on the next prompt must cascade
    // the orphaned counter away. A bare set() overwrite (no release) would
    // skip the cascade and leak msg-A's counter forever.
    sessionAnchors.set('sess-1', { msgId: 'msg-A', timestamp: Date.now() });
    seqMap.set('msg-A', 2);
    replyMap.set('test-chat', { msgId: 'msg-B', timestamp: Date.now() });

    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-B');

    expect(sessionAnchors.get('sess-1')!.msgId).toBe('msg-B');
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
    (
      ch as unknown as { onPromptEnd: (c: string, s: string) => void }
    ).onPromptEnd('test-chat', 'sess-A');
    expect(st.has('sess-A')).toBe(true);
    expect(pendingDeletes.has('sess-A')).toBe(true);
    expect(sessionAnchors.has('sess-A')).toBe(true);
    expect(st.get('sess-A')!.buffer).toBe('tail ');
  });

  it('onPromptEnd flushes the residual buffer before tearing down stream state (cancel keeps partial output)', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Map<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const flushedSessions = chp['flushedSessions'] as Set<string>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const turnCounter = chp['turnCounter'] as Map<string, number>;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;

    // A real turn streams a partial reply and is then cancelled mid-stream:
    // ChannelBase skips onResponseComplete on cancel, so only onPromptEnd
    // runs. The buffered tail must still be delivered — on origin/main the
    // idle timer would have flushed it; dropping it here would be a silent
    // reply loss (wenshao probe: main sends once, the old PR path sent
    // zero times).
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'partial reply ', 'sess-1');

    (
      ch as unknown as { onPromptEnd: (c: string, s: string) => void }
    ).onPromptEnd('test-chat', 'sess-1');

    // The flush fires immediately (no idle-timer advance needed); sendMessage
    // awaits resolveRoute, so drive the async chain to settle.
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    expect((body.markdown as Record<string, string>).content).toBe(
      'partial reply ',
    );
    expect(body['msg_id']).toBe('msg-A');
    expect(body['msg_seq']).toBe(1);

    // Every structure the turn touched is back to empty — nothing leaks.
    expect(streamState(ch).size).toBe(0);
    expect(flushingSessions.size).toBe(0);
    expect(pendingStreamDelete.size).toBe(0);
    expect(flushedSessions.size).toBe(0);
    expect(sessionAnchors.size).toBe(0);
    expect(turnCounter.size).toBe(0);
    // The chat-level entry still points at msg-A, so its msg_seq counter is
    // deliberately kept (cascaded away only when the chat entry moves on or
    // expires — the TTL eviction).
    expect(seqMap.has('msg-A')).toBe(true);
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
    const seqMap = chp['msgSeqMap'] as Map<string, number>;
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    // Anchor set at prompt start, but the first chunk only arrives after the
    // TTL elapsed (model thought for > 5 minutes) — and the chat-level entry
    // is gone/expired too, so the send must be fully active (no msg_id).
    sessionAnchors.set('sess-A', {
      msgId: 'msg-STALE',
      timestamp: Date.now() - (300_000 + 1000),
    });
    replyMap.delete('test-chat');
    // The stale anchor's seq counter: the drop must go through the release
    // path so this orphaned counter is cascaded away too (a raw delete of
    // the anchor would leave it behind — thread 49).
    seqMap.set('msg-STALE', 3);

    onResponseChunk(ch, 'test-chat', 'late ', 'sess-A');
    vi.advanceTimersByTime(2000);
    await drain();

    // The stale anchor was dropped at read time, cascading its seq counter.
    expect(sessionAnchors.has('sess-A')).toBe(false);
    expect(seqMap.has('msg-STALE')).toBe(false);
    expect(capturedStderr()).toContain('per-session reply anchor expired');
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    expect(body['msg_id']).toBeUndefined();
    stderrSpy.mockRestore();
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

  it('flushes the tool-call buffer anchored to the session triggering msgId', async () => {
    const ch = makeChannel();
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'thinking before tool', 'sess-1');

    ch.onToolCall('test-chat', toolCall('sess-1'));
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    expect((body['markdown'] as Record<string, string>)['content']).toBe(
      'thinking before tool',
    );
    // The tool-call flush goes out under the session's own triggering msgId,
    // not whatever the chat-level entry points at.
    expect(body['msg_id']).toBe('msg-A');
    expect(body['msg_seq']).toBe(1);
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

    // Anchor the session (a real turn triggered the stream) and simulate an
    // already-succeeded flush record; the retry-exhaustion path must clean
    // up both along with the reply anchor.
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'text before tool', 'sess-1');
    ch.onToolCall('test-chat', toolCall('sess-1'));

    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const flushedSessions = chp['flushedSessions'] as Set<string>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    flushedSessions.add('sess-1');
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
    // Retry exhaustion releases the pending flag, the flushed record, and
    // the session's reply anchor (all exactly once).
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
    expect(flushedSessions.has('sess-1')).toBe(false);
    expect(sessionAnchors.has('sess-1')).toBe(false);
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

  it('a complete turn leaves all six streaming structures empty', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Map<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const flushedSessions = chp['flushedSessions'] as Set<string>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const turnCounter = chp['turnCounter'] as Map<string, number>;

    // A full turn: prompt starts (anchors + bumps the turn counter), chunks
    // stream, the response completes (final flush), then the prompt ends
    // (ChannelBase's finally). Every structure the turn touched must be back
    // to empty — nothing may leak into the next turn.
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'hello', 'sess-1');
    await onResponseComplete(ch, 'test-chat', 'hello', 'sess-1');
    (
      ch as unknown as { onPromptEnd: (c: string, s: string) => void }
    ).onPromptEnd('test-chat', 'sess-1');

    expect(streamState(ch).size).toBe(0);
    expect(flushingSessions.size).toBe(0);
    expect(pendingStreamDelete.size).toBe(0);
    expect(flushedSessions.size).toBe(0);
    expect(sessionAnchors.size).toBe(0);
    expect(turnCounter.size).toBe(0);
  });

  it('final segment keeps the captured per-session msgId even after replyMsgId is overwritten', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    // Real flow: the triggering message sets the chat-level entry, the
    // session anchors to it, and the stream has already sent two segments
    // under msg-A (seq counter at 2).
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 'sess-A', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'final tail', 'sess-A');
    seqMap.set('msg-A', 2);

    // A concurrent message overwrites the chat-level entry mid-stream via
    // the real setReplyMsgId path. sess-A still anchors msg-A, so the
    // isMsgIdAnchoredBySession guard inside setReplyMsgId must keep msg-A's
    // seq counter alive — the previous version wrote the map directly and
    // never exercised that guard.
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    expect(seqMap.get('msg-A')).toBe(2);

    await onResponseComplete(ch, 'test-chat', 'ignored-fulltext', 'sess-A');

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    expect((body.markdown as Record<string, string>).content).toBe(
      'final tail',
    );
    // The final segment stays under A's msg_id and continues its seq counter.
    expect(body['msg_id']).toBe('msg-A');
    expect(body['msg_seq']).toBe(3);
    // The anchor is released after the final segment goes out. The counter is
    // NOT cascaded away: replyContextByMessageId still names msg-A, so a send
    // could still resolve it. The retention is bounded — evicting
    // that routing entry reclaims the counter.
    expect(sessionAnchors.has('sess-A')).toBe(false);
    expect(seqMap.get('msg-A')).toBe(3);
    (chp['deleteReplyContext'] as (c: unknown) => void).call(ch, {
      chatId: 'test-chat',
      msgId: 'msg-A',
      timestamp: Date.now(),
    });
    expect(seqMap.has('msg-A')).toBe(false);
  });

  it('final segment continues the msg_seq counter of its session anchor', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;

    // Part 1 streams and is flushed by the idle timer → msg_seq 1 for msg-A.
    onPromptStart(ch, 'test-chat', 'sess-A', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'part-1 ', 'sess-A');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(seqMap.get('msg-A')).toBe(1);

    // Residual buffer arrives, then the response completes. The final send
    // must continue the counter (msg_seq 2) — releasing the anchor before
    // it would drop msgSeqMap['msg-A'] and reset the sequence to 1, which
    // QQ dedupes on (msg_id + msg_seq) and silently drops the reply tail.
    onResponseChunk(ch, 'test-chat', 'residual', 'sess-A');
    await onResponseComplete(ch, 'test-chat', 'ignored-fulltext', 'sess-A');

    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    const finalBody = mockSendQQMessage.mock.calls[1][3] as Record<
      string,
      unknown
    >;
    expect((finalBody.markdown as Record<string, string>).content).toBe(
      'residual',
    );
    expect(finalBody['msg_id']).toBe('msg-A');
    expect(finalBody['msg_seq']).toBe(2);
    // The terminal release cascades msg-A's counter away: the turn is over
    // and nothing else is anchored to msg-A (no chat-level entry was ever
    // established in this test).
    expect(seqMap.has('msg-A')).toBe(false);
  });

  it('final segment goes out as an active send when the anchor has expired (TTL)', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
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
    // The fallback to the active path is logged, not silent (a silent
    // fallback here is what made the final segment race the chat-level
    // entry in the first place — thread 46).
    expect(capturedStderr()).toContain('expired for final segment');
    // The stale anchor is dropped via the release path.
    expect(sessionAnchors.has('sess-A')).toBe(false);
    stderrSpy.mockRestore();
  });

  it('falls back to fullText when no streamState', async () => {
    const ch = makeChannel();
    await onResponseComplete(ch, 'test-chat', 'nothing', 'sess-none');
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    expect((body.markdown as Record<string, string>).content).toBe('nothing');
  });

  it('preserves the buffer a following tool call flushes at a response boundary (Fix B)', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'intermediate ', 'sess-1');

    // Production emits the boundary immediately before the tool-call event
    // that flushAndTrack's caller (onToolCall) reads the buffer with, so the
    // entry and its residual must survive the boundary rather than be deleted.
    onResponseBoundary(ch, 'test-chat', 'sess-1');
    const kept = streamState(ch).get('sess-1');
    expect(kept).toBeDefined();
    expect(kept!.buffer).toBe('intermediate ');
    // A window gap between response windows must keep the reply anchor alive.
    expect(sessionAnchors.has('sess-1')).toBe(true);

    ch.onToolCall('test-chat', toolCall('sess-1'));
    await drain();
    expect(sentContents().filter((c) => c === 'intermediate ')).toHaveLength(1);

    // The post-tool text completes the turn normally, and the pre-boundary
    // text must not be re-sent alongside it.
    onResponseChunk(ch, 'test-chat', 'final', 'sess-1');
    await onResponseComplete(ch, 'test-chat', 'final', 'sess-1');

    const contents = sentContents();
    expect(contents.filter((c) => c === 'intermediate ')).toHaveLength(1);
    expect(contents.filter((c) => c === 'final')).toHaveLength(1);
    expect(streamState(ch).has('sess-1')).toBe(false);
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
    // Exact total, not just the per-content counts above: an extra send
    // anywhere in the boundary/keep path must fail this test.
    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
  });

  it('hands a pre-boundary buffer to the idle timer when no tool call follows (Fix B)', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const flushingSessions = chp['flushingSessions'] as Map<string, unknown>;
    const flushedSessions = chp['flushedSessions'] as Set<string>;
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'intermediate ', 'sess-1');

    // A plan update emits the boundary alone; the buffer must survive it and
    // merge with the post-boundary chunk rather than be dropped.
    onResponseBoundary(ch, 'test-chat', 'sess-1');
    expect(streamState(ch).get('sess-1')!.buffer).toBe('intermediate ');
    onResponseChunk(ch, 'test-chat', 'final', 'sess-1');
    expect(streamState(ch).get('sess-1')!.buffer).toBe('intermediate final');

    vi.advanceTimersByTime(2000);
    await drain();

    const contents = sentContents();
    expect(contents.filter((c) => c === 'intermediate final')).toHaveLength(1);
    expect(contents.some((c) => c.includes('intermediate intermediate'))).toBe(
      false,
    );

    // The completion is a no-op: the idle flush already delivered the text.
    await onResponseComplete(ch, 'test-chat', 'final', 'sess-1');
    expect(
      sentContents().filter((c) => c === 'intermediate final'),
    ).toHaveLength(1);
    expect(streamState(ch).has('sess-1')).toBe(false);
    expect(flushingSessions.has('sess-1')).toBe(false);
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
    expect(flushedSessions.has('sess-1')).toBe(false);
    // Exact total: the idle flush is the only send, and the completion after
    // it is a no-op. An extra delivery anywhere in the path must fail.
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
  });

  it('clears an in-flight flush marker at response boundary', () => {
    const ch = makeChannel();
    const channel = ch as unknown as Record<string, unknown>;
    const flushingSessions = channel['flushingSessions'] as Map<
      string,
      FlushMarkerState
    >;
    flushingSessions.set('sess-1', flushMarkerState());

    onResponseBoundary(ch, 'test-chat', 'sess-1');

    expect(flushingSessions.has('sess-1')).toBe(false);
  });

  it('does not let a superseded orphan side-buffer entry prepend to the next window (wenshao §3)', () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<
      string,
      { turn: number; text: string; pre?: string }
    >;
    const turnCounter = chp['turnCounter'] as Map<string, number>;
    turnCounter.set('sess-1', 1);
    // A superseded turn's stashed head is still parked in the side buffer
    // when the response boundary fires (new response window on the same
    // session). The boundary preserves it — a mid-turn boundary must not
    // destroy a live turn's stash — but the next window's first fresh
    // entry must not prepend it: the drain site drops entries whose turn is
    // not the live turn.
    orphanBuffer.set('sess-1', {
      turn: 0,
      text: 'stale-orphan',
    });

    onResponseBoundary(ch, 'test-chat', 'sess-1');

    expect(orphanBuffer.has('sess-1')).toBe(true);

    // A chunk after the boundary creates a fresh entry under the next
    // window's text — the dead-turn stash is dropped, not prepended.
    onResponseChunk(ch, 'test-chat', 'fresh', 'sess-1');
    expect(streamState(ch).get('sess-1')!.buffer).toBe('fresh');
    expect(orphanBuffer.has('sess-1')).toBe(false);
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

  it("a fast turn whose chunks were dropped by the stale guard delivers its own text (not the previous turn's residual)", async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const turnCounter = chp['turnCounter'] as Map<string, number>;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;

    // Turn 1 streams and its deferred flush chain still owns the entry
    // (pendingStreamDelete parked, buffered residual, live idle timer).
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'turn-1-residual', 'sess-1');
    pendingStreamDelete.add('sess-1');

    // Turn 2 starts: bumps the turn counter and anchors the session to its
    // OWN triggering message (msg-B). Its chunks are ALL dropped by the
    // stale guard (state.buffer + pendingStreamDelete early-return), so no
    // fresh entry is created — onResponseComplete still sees turn 1's.
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-B');
    expect(turnCounter.get('sess-1')).toBe(2);
    // Seed msg-B's seq counter (a first flush of this reply would have
    // consumed it) so the stale-branch release's cascade is observable.
    seqMap.set('msg-B', 1);

    // The response completes: the stale branch sends turn 2's full text
    // under THIS turn's own anchor (msg-B, set by onPromptStart) rather than
    // falling back to the racy chat-level entry — and turn 1's entry must
    // survive for its own chain.
    await onResponseComplete(ch, 'test-chat', 'TURN-2-FULL', 'sess-1');

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    expect((body.markdown as Record<string, string>).content).toBe(
      'TURN-2-FULL',
    );
    // The stale branch anchors the send to this turn's own msg-B, then
    // releases it — cascading msg-B's orphaned seq counter away.
    expect(body['msg_id']).toBe('msg-B');
    expect(seqMap.has('msg-B')).toBe(false);
    // Turn 1's entry is left untouched for its deferred flush chain.
    expect(streamState(ch).get('sess-1')!.buffer).toBe('turn-1-residual');
    expect(streamState(ch).get('sess-1')!.turn).toBe(1);
    expect(pendingStreamDelete.has('sess-1')).toBe(true);
    // Turn 2's anchor is released (its reply already went out).
    expect(sessionAnchors.has('sess-1')).toBe(false);

    // Turn 1's deferred chain settles on its idle timer and delivers its own
    // residual as the second message — the full reply is continuous.
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    const residualBody = mockSendQQMessage.mock.calls[1][3] as Record<
      string,
      unknown
    >;
    expect((residualBody.markdown as Record<string, string>).content).toBe(
      'turn-1-residual',
    );
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

    // A real turn anchored the session; the deferred-complete .then() else
    // branch must release that anchor (previously a no-op because no test
    // built an anchor, so the release path was never exercised).
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'streaming text', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();

    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Map<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const completedTurns = chp['completedTurns'] as Map<string, number>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(flushingSessions.has('sess-1')).toBe(true);

    // onResponseComplete fires while idle-flush is in-flight
    await onResponseComplete(ch, 'test-chat', 'streaming text', 'sess-1');

    expect(pendingStreamDelete.has('sess-1')).toBe(true);
    expect(streamState(ch).has('sess-1')).toBe(true);
    // The deferred completion recorded this turn; the chain's own terminal
    // settle is the only teardown that can drop it.
    expect(completedTurns.get('sess-1')).toBe(1);

    // Let the idle-flush send promise resolve
    resolveSend!(mockResponse(true));
    await drain();

    // Cleaned up
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
    expect(streamState(ch).has('sess-1')).toBe(false);
    expect(flushingSessions.has('sess-1')).toBe(false);
    expect(completedTurns.has('sess-1')).toBe(false);
    // The deferred chain's else branch released the anchor; the chat-level
    // entry still points at msg-A, so its msg_seq counter is kept (cascaded
    // away only when the chat entry moves on or expires).
    expect(sessionAnchors.has('sess-1')).toBe(false);
    expect(seqMap.has('msg-A')).toBe(true);
  });

  it('pendingStreamDelete failure re-buffers and retries (no leak)', async () => {
    const ch = makeChannel();
    let rejectSend: (err: Error) => void;
    const sendPromise = new Promise<MockResponse>((_resolve, reject) => {
      rejectSend = reject;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    // A real turn anchored the session; simulate an already-succeeded flush
    // record so the retry-exhaustion path is verified to clean up the
    // pending flag, the flushed record, AND the reply anchor.
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'text', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();

    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const flushedSessions = chp['flushedSessions'] as Set<string>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;
    flushedSessions.add('sess-1');
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

    // A successor turn starts while the retry chain is still running: its
    // onPromptStart overwrote the anchor with msg-B. The exhaustion release
    // must keep the successor's anchor (expectedMsgId identity check) while
    // still cascading the superseded turn's msg_seq away (thread 55). (The
    // first send rolled msg-A's counter back to 0 on failure — it is tracked,
    // which is what matters for the cascade.)
    sessionAnchors.set('sess-1', { msgId: 'msg-B', timestamp: Date.now() });
    seqMap.set('msg-B', 5);
    expect(seqMap.has('msg-A')).toBe(true);

    // After retries exhausted, streamState is cleaned up
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(2000);
      await drain();
    }
    expect(streamState(ch).has('sess-1')).toBe(false);
    // Exhaustion releases the pending flag and the flushed record...
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
    expect(flushedSessions.has('sess-1')).toBe(false);
    // ...but the successor's anchor and its counter survive the release
    // (the expectedMsgId identity check sees the overwritten entry)...
    expect(sessionAnchors.get('sess-1')!.msgId).toBe('msg-B');
    expect(seqMap.get('msg-B')).toBe(5);
    // ...while the superseded turn's own counter was cascaded away.
    expect(seqMap.has('msg-A')).toBe(false);
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

    // A residual arrives while that send is still in flight, so the manual
    // idleFlush below reaches the flushingSessions guard instead of
    // returning early on an empty buffer.
    onResponseChunk(ch, 'test-chat', ' residual', 'sess-1');
    expect(streamState(ch).get('sess-1')!.buffer).toBe(' residual');

    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Map<
      string,
      FlushMarkerState
    >;
    flushingSessions.set('sess-1', flushMarkerState());

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

  it("a superseded turn's permanent failure keeps the successor anchor and does not orphan its msg_seq", async () => {
    const ch = makeChannel();
    let rejectSend: (err: Error) => void;
    const sendPromise = new Promise<MockResponse>((_r, rej) => {
      rejectSend = rej as (err: Error) => void;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const chp = ch as unknown as Record<string, unknown>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;

    // Turn 1 streams and its flush stays in flight (msg-A's seq recorded).
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'part1', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(seqMap.get('msg-A')).toBe(1);

    // A residual arrives while the send is still in flight — the turn-1
    // entry now holds buffer + timer, which is what keeps msg-A's counter
    // alive through turn 2's onPromptStart cascade below.
    onResponseChunk(ch, 'test-chat', ' residual', 'sess-1');

    // Turn 2 starts: its triggering message overwrites the chat entry, then
    // onPromptStart bumps the turn. The superseded entry's residual keeps
    // seqMap['msg-A'] alive for now.
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-B');
    expect(seqMap.get('msg-A')).toBe(1);

    // Turn 2's first chunk replaces the entry (stale branch, no
    // pendingStreamDelete): turn 1's state and flags are dropped — its
    // residual is discarded with an observable log line rather than
    // silently — and a fresh entry is created, but turn 1's send is still
    // in flight with its captured state object.
    onResponseChunk(ch, 'test-chat', 'turn-2', 'sess-1');
    expect(streamState(ch).get('sess-1')!.turn).toBe(2);
    expect(streamState(ch).get('sess-1')!.msgId).toBe('msg-B');
    expect(capturedStderr()).toContain('superseded turn');

    // The superseded turn's send fails permanently. The identity guard
    // (current !== state) must NOT release the successor's anchor — but
    // msg-A's seq counter must STILL be cascaded away (the release runs
    // outside the guard with the expectedMsgId check), otherwise it orphans.
    rejectSend!(new DeliveryError('RETRY_EXHAUSTED', 'permanent failure'));
    try {
      await sendPromise;
    } catch {
      /* expected */
    }
    await drain();

    // Turn 2's state and anchor survive untouched...
    expect(streamState(ch).get('sess-1')!.turn).toBe(2);
    expect(streamState(ch).get('sess-1')!.msgId).toBe('msg-B');
    expect(sessionAnchors.get('sess-1')!.msgId).toBe('msg-B');
    // ...but the superseded turn's counter is not orphaned either: the release
    // ran and the counter is retained because replyContextByMessageId still
    // names msg-A. Evicting that routing entry reclaims it.
    expect(seqMap.has('msg-A')).toBe(true);
    (chp['deleteReplyContext'] as (c: unknown) => void).call(ch, {
      chatId: 'test-chat',
      msgId: 'msg-A',
      timestamp: Date.now(),
    });
    expect(seqMap.has('msg-A')).toBe(false);
    // The permanent failure sent exactly once (the superseded 'part1'); the
    // replacement entry's 'turn-2' buffer is never sent before teardown.
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
  });

  it('a permanent failure of a deferred (pending) session cleans the pending flag, flush record and turn counter', async () => {
    const ch = makeChannel();
    mockSendQQMessage.mockRejectedValue(
      new DeliveryError('RETRY_EXHAUSTED', 'permanent failure'),
    );
    const chp = ch as unknown as Record<string, unknown>;
    const st = streamState(ch);
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const flushedSessions = chp['flushedSessions'] as Set<string>;
    const turnCounter = chp['turnCounter'] as Map<string, number>;
    const completedTurns = chp['completedTurns'] as Map<string, number>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;

    // A deferred turn (cancelled/ended while its final flush was in flight):
    // the flush chain owns a live streamState entry, the session is parked
    // in pendingStreamDelete with a flushed record, and the turn counter
    // still belongs to this turn.
    const state = {
      chatId: 'test-chat',
      buffer: 'residual',
      timer: null as ReturnType<typeof setTimeout> | null,
      retryCount: 0,
      msgId: 'msg-P',
      turn: 5,
    };
    st.set('sess-1', state);
    pendingStreamDelete.add('sess-1');
    flushedSessions.add('sess-1');
    turnCounter.set('sess-1', 5);
    completedTurns.set('sess-1', 5);
    sessionAnchors.set('sess-1', { msgId: 'msg-P', timestamp: Date.now() });
    seqMap.set('msg-P', 2);

    (
      chp['flushAndTrack'] as (
        sessionId: string,
        buffer: string,
        state: typeof state,
        logLabel: string,
      ) => void
    )('sess-1', 'residual', state, 'test');

    await drain();

    // The permanent failure drops the entry and releases the anchor
    // (cascading the orphaned seq) — and because the session was parked in
    // pendingStreamDelete, the pending flag, the flushed record and this
    // turn's counter are all cleaned in one go.
    expect(st.has('sess-1')).toBe(false);
    expect(sessionAnchors.has('sess-1')).toBe(false);
    expect(seqMap.has('msg-P')).toBe(false);
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
    expect(flushedSessions.has('sess-1')).toBe(false);
    expect(turnCounter.has('sess-1')).toBe(false);
    expect(completedTurns.has('sess-1')).toBe(false);
  });

  it('a permanent failure of a proactive turn never releases the successor anchor', async () => {
    const ch = makeChannel();
    mockSendQQMessage.mockRejectedValue(
      new DeliveryError('RETRY_EXHAUSTED', 'permanent failure'),
    );
    const chp = ch as unknown as Record<string, unknown>;
    const st = streamState(ch);
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;

    // A proactive turn (no triggering message → state.msgId is undefined)
    // streams and its send fails permanently. Meanwhile a user turn already
    // overwrote the session anchor with msg-B. The permanent-catch release
    // is guarded on state.msgId — without the guard, the legacy
    // release-by-sessionId would delete the successor's anchor and cascade
    // its seq counter away.
    const state = {
      chatId: 'test-chat',
      buffer: 'proactive',
      timer: null as ReturnType<typeof setTimeout> | null,
      retryCount: 0,
      msgId: undefined,
      turn: 1,
    };
    st.set('sess-1', state);
    sessionAnchors.set('sess-1', { msgId: 'msg-B', timestamp: Date.now() });
    seqMap.set('msg-B', 5);

    (
      chp['flushAndTrack'] as (
        sessionId: string,
        buffer: string,
        state: typeof state,
        logLabel: string,
      ) => void
    )('sess-1', 'proactive', state, 'test');

    await drain();

    expect(sessionAnchors.get('sess-1')!.msgId).toBe('msg-B');
    expect(seqMap.get('msg-B')).toBe(5);
  });

  it('disconnect() clears all streaming state', () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'buffered', 'sess-1');

    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Map<
      string,
      FlushMarkerState
    >;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const flushedSessions = chp['flushedSessions'] as Set<string>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const turnCounter = chp['turnCounter'] as Map<string, number>;
    const completedTurns = chp['completedTurns'] as Map<string, number>;

    flushingSessions.set('sess-1', flushMarkerState());
    pendingStreamDelete.add('sess-1');
    flushedSessions.add('sess-1');
    sessionAnchors.set('sess-1', { msgId: 'msg-A', timestamp: Date.now() });
    turnCounter.set('sess-1', 3);
    completedTurns.set('sess-1', 3);

    (chp['disconnect'] as () => void)();

    expect(streamState(ch).size).toBe(0);
    expect(flushingSessions.size).toBe(0);
    expect(pendingStreamDelete.size).toBe(0);
    expect(flushedSessions.size).toBe(0);
    expect(sessionAnchors.size).toBe(0);
    expect(turnCounter.size).toBe(0);
    expect(completedTurns.size).toBe(0);
  });

  it('onSessionDied cleans up stream state for dead session', () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;
    // Anchor the session to its triggering message (onPromptStart), then
    // stream a chunk so onSessionDied must clean up both the stream state
    // and the reply anchor (releaseSessionReplyAnchor).
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-1');
    expect(sessionAnchors.has('sess-1')).toBe(true);
    onResponseChunk(ch, 'test-chat', 'alive', 'sess-1');
    // A completion record for this session must not outlive it, or a later
    // session reusing the session id would inherit it.
    const completedTurns = chp['completedTurns'] as Map<string, number>;
    completedTurns.set('sess-1', 1);
    // The anchor's seq counter: onSessionDied disarms the entry (timer nulled,
    // buffer cleared) before its release, so the dead session's residual is
    // dropped by the same call and the only remaining vetoes are a genuine
    // in-flight flush or an anchored in-flight send — neither is armed here.
    seqMap.set('msg-1', 2);

    vi.spyOn(global, 'clearTimeout');
    const entry = streamState(ch).get('sess-1');
    const timer = entry!.timer;

    ch.onSessionDied('sess-1');

    expect(clearTimeout).toHaveBeenCalledWith(timer);
    expect(streamState(ch).has('sess-1')).toBe(false);
    // releaseSessionReplyAnchor drops the dead session's reply anchor too.
    expect(sessionAnchors.has('sess-1')).toBe(false);
    // No send is in flight (flushingSessions/inFlightMsgSeqSends empty), so
    // the residual this same call discards must not keep the counter alive. A
    // genuine in-flight flush keeping it is pinned by events.test.ts B5.
    expect(seqMap.has('msg-1')).toBe(false);

    expect(
      (chp['flushingSessions'] as Map<string, unknown>).has('sess-1'),
    ).toBe(false);
    expect((chp['pendingStreamDelete'] as Set<string>).has('sess-1')).toBe(
      false,
    );
    expect((chp['flushedSessions'] as Set<string>).has('sess-1')).toBe(false);
    expect(completedTurns.has('sess-1')).toBe(false);
    // The dead session's turn counter is dropped too.
    expect((chp['turnCounter'] as Map<string, number>).has('sess-1')).toBe(
      false,
    );
  });

  it("cascades a superseded turn's msg_seq counter when it discards the buffer", () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;
    const streamState = chp['streamState'] as Map<
      string,
      { msgId?: string; buffer: string }
    >;

    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-1');
    onResponseChunk(ch, 'test-chat', 'alive', 'sess-1');
    const entry = streamState.get('sess-1')!;
    expect(entry.msgId).toBe('msg-1');
    expect(entry.buffer).toBe('alive');
    seqMap.set('msg-1', 2);

    // A new prompt bumps the turn generation, so the next chunk finds turn 1's
    // entry superseded: it logs and discards the buffer and deletes the entry.
    // The release must therefore not let that same buffer veto the cascade —
    // no path can re-drive the flush it claims to protect.
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-1');
    onResponseChunk(ch, 'test-chat', 'next', 'sess-1');

    expect(seqMap.has('msg-1')).toBe(false);
  });
  it('flushingSessions guard prevents retry while already flushing', async () => {
    const ch = makeChannel();
    mockSendQQMessage.mockRejectedValue(new Error('fail'));

    onResponseChunk(ch, 'test-chat', 'hello', 'sess-1');

    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Map<
      string,
      FlushMarkerState
    >;

    // First idleFlush triggers
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);

    // Simulate that the session is now marked as flushing (duplicate prevention)
    flushingSessions.set('sess-1', flushMarkerState());

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
    const flushingSessions = chp['flushingSessions'] as Map<
      string,
      FlushMarkerState
    >;
    flushingSessions.set('sess-1', flushMarkerState());

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

  it('re-buffers and re-arms the timer when the size cap is hit while a send is in flight', async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Map<string, unknown>;

    // Start a flush and leave the send in flight (flushingSessions armed).
    onResponseChunk(ch, 'test-chat', 'first part', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(flushingSessions.has('sess-1')).toBe(true);

    // Chunks that push the buffer past the cap while the send is still in
    // flight must NOT fire a concurrent send — the size-cap branch re-buffers
    // and re-arms the idle timer. Note the overflow is delivered by THAT
    // re-armed timer, not the in-flight chain's .then() (pendingStreamDelete
    // is not set here, so .then() never re-flushes).
    const bigChunk = 'a'.repeat(3000);
    onResponseChunk(ch, 'test-chat', bigChunk, 'sess-1');
    onResponseChunk(ch, 'test-chat', 'b'.repeat(2000), 'sess-1');

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const st = streamState(ch).get('sess-1')!;
    expect(st.buffer).toBe(bigChunk + 'b'.repeat(2000));
    expect(st.timer).not.toBeNull();

    // The in-flight send settles (no re-flush — .then() sees the non-empty
    // buffer and keeps the entry), then the re-armed idle timer fires and
    // delivers the overflow. Without it the buffered overflow is stranded.
    resolveSend!(mockResponse(true));
    await drain();
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    const overflowBody = mockSendQQMessage.mock.calls[1][3] as Record<
      string,
      unknown
    >;
    expect(
      (overflowBody['markdown'] as Record<string, string>)['content'],
    ).toBe(bigChunk + 'b'.repeat(2000));
  });

  it('caps a parked session diverting chunks into the orphan side buffer', async () => {
    const ch = makeChannel({ bufferFlushLength: 40 });
    const chp = ch as unknown as Record<string, unknown>;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<
      string,
      { turn: number; text: string; pre?: string }
    >;
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    // The predecessor send never settles, so every successor chunk takes the
    // parked early return and appends to the side buffer — the one accumulator
    // with no flush outlet of its own.
    const { resolveSend } = await reachStaleStash(ch);
    expect(orphanBuffer.get('s1')!.text).toBe('T2-HEAD ');

    for (let i = 0; i < 12; i++) {
      onResponseChunk(ch, 'test-chat', 'x'.repeat(10), 's1');
      expect(orphanBuffer.get('s1')!.text.length).toBeLessThanOrEqual(40);
    }
    expect(orphanBuffer.get('s1')!.text.length).toBe(40);
    expect(
      stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes('over the buffer limit')),
    ).not.toHaveLength(0);

    stderrSpy.mockRestore();
    resolveSend(mockResponse(true));
    await drain();
  });

  it('trims a sealed pre to stay a prefix of the capped stash', async () => {
    const ch = makeChannel({ bufferFlushLength: 40 });
    const chp = ch as unknown as Record<string, unknown>;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<
      string,
      { turn: number; text: string; pre?: string }
    >;
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const { resolveSend } = await reachStaleStash(ch);

    // Grow the stash under the cap, then seal the whole stash at a boundary.
    for (let i = 0; i < 3; i++) {
      onResponseChunk(ch, 'test-chat', '0123456789', 's1');
    }
    onResponseBoundary(ch, 'test-chat', 's1');
    const before = orphanBuffer.get('s1')!;
    expect(before.text.length).toBe(38);
    expect(before.pre).toBe(before.text);

    // Shrink the limit under the sealed prefix's length and force a trim: the
    // cap then crosses the sealed region, so `pre` is longer than the kept
    // text and must be trimmed with it or the prefix invariant breaks.
    const state = (
      chp['streamState'] as Map<string, { sourceLabel?: string }>
    ).get('s1')!;
    state.sourceLabel = 'L'.repeat(20); // limit 19
    onResponseChunk(ch, 'test-chat', '0123456789', 's1');

    const after = orphanBuffer.get('s1')!;
    expect(after.text.length).toBe(19);
    expect(after.text.startsWith('T2-HEAD ')).toBe(true);
    expect(after.pre).toBe(after.text);
    expect(after.text.startsWith(after.pre!)).toBe(true);
    const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain('dropping 29 chars');

    stderrSpy.mockRestore();
    resolveSend(mockResponse(true));
    await drain();
  });

  it('caps the stash on a code-point boundary, never a lone surrogate', async () => {
    const ch = makeChannel({ bufferFlushLength: 40 });
    const chp = ch as unknown as Record<string, unknown>;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<
      string,
      { turn: number; text: string; pre?: string }
    >;
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const { resolveSend } = await reachStaleStash(ch);

    // A 9-unit budget with an astral character straddling unit 9: a raw
    // `slice(0, 9)` would keep a lone high surrogate and put invalid UTF-16 on
    // the wire; the code-point-aware cut drops the character whole.
    const state = (
      chp['streamState'] as Map<string, { sourceLabel?: string }>
    ).get('s1')!;
    state.sourceLabel = 'L'.repeat(30); // limit 9
    onResponseChunk(ch, 'test-chat', '\u{1f600}', 's1');

    const stashed = orphanBuffer.get('s1')!;
    expect(stashed.text).toBe('T2-HEAD ');
    expect(stashed.text.length).toBe(8);
    expect(wellFormed(stashed.text)).toBe(true);
    const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain('dropping 2 chars'); // 10 units in, 8 kept

    stderrSpy.mockRestore();
    resolveSend(mockResponse(true));
    await drain();
  });

  it('caps the handed-off stash merge while keeping the sealed head', async () => {
    const ch = makeChannel({ bufferFlushLength: 40 });
    const chp = ch as unknown as Record<string, unknown>;
    const stateMap = chp['streamState'] as Map<
      string,
      { sealedPre?: string; boundaryClearedInFlight?: string }
    >;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<
      string,
      { turn: number; text: string; pre?: string }
    >;
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    // Turn 1: 'HEAD' buffers, a boundary seals it, and the drain takes it with
    // the send still unresolved.
    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    let rejectSend!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectSend = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    // A residual buffers, completion parks turn 1, and turn 2's chunk diverts
    // into the side buffer under turn 2; a boundary then seals its `pre`.
    onResponseChunk(ch, 'test-chat', 'Q', 's1');
    await onResponseComplete(ch, 'test-chat', 'HEAD', 's1');
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    const long = 'X'.repeat(38);
    onResponseChunk(ch, 'test-chat', long, 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    expect(orphanBuffer.get('s1')).toEqual({ turn: 2, text: long, pre: long });
    const state = stateMap.get('s1')!;

    // Turn 1's permanent failure hands its sealed head off in front of that
    // 38-char stash: 4 + 38 = 42 exceeds the 40-char limit.
    rejectSend(new DeliveryError('RETRY_EXHAUSTED', 'permanent failure'));
    await drain();

    const limit = (chp['streamBufferLimit'] as (s: unknown) => number).call(
      ch,
      state,
    );
    expect(limit).toBe(40);
    const stashed = orphanBuffer.get('s1')!;
    expect(stashed.turn).toBe(2);
    expect(stashed.text.length).toBeLessThanOrEqual(limit);
    // The sealed head is the reason the handoff exists, so it survives whole.
    expect(stashed.text).toBe('HEAD' + 'X'.repeat(36));
    expect(stashed.text.startsWith('HEAD')).toBe(true);
    expect(stashed.pre).toBe(stashed.text);
    expect(stashed.text.startsWith(stashed.pre!)).toBe(true);
    const drops = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('successor stash over the buffer limit'))
      .map((line) => Number(/dropping (\d+) chars/.exec(line)?.[1] ?? '0'));
    expect(drops).toEqual([2]);
    // The logged loss telescopes: kept + dropped is what the merge held.
    expect(stashed.text.length + drops[0]).toBe('HEAD'.length + long.length);
    stderrSpy.mockRestore();
  });

  it('keeps the sealed head whole when the limit is smaller than the head', async () => {
    const ch = makeChannel({ bufferFlushLength: 40 });
    const chp = ch as unknown as Record<string, unknown>;
    const stateMap = chp['streamState'] as Map<
      string,
      { sealedPre?: string; sourceLabel?: string }
    >;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<
      string,
      { turn: number; text: string; pre?: string }
    >;
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    let rejectSend!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectSend = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    onResponseChunk(ch, 'test-chat', 'Q', 's1');
    await onResponseComplete(ch, 'test-chat', 'HEAD', 's1');
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    const long = 'X'.repeat(38);
    onResponseChunk(ch, 'test-chat', long, 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    expect(orphanBuffer.get('s1')).toEqual({ turn: 2, text: long, pre: long });
    const state = stateMap.get('s1')!;
    // A very long rendered source label shrinks this state's limit below the
    // sealed head's own length: the head must still survive whole.
    state.sourceLabel = 'L'.repeat(36); // limit 3

    rejectSend(new DeliveryError('RETRY_EXHAUSTED', 'permanent failure'));
    await drain();

    const limit = (chp['streamBufferLimit'] as (s: unknown) => number).call(
      ch,
      state,
    );
    expect(limit).toBe(3);
    const stashed = orphanBuffer.get('s1')!;
    expect(stashed.turn).toBe(2);
    // The sealed head is the reason the handoff exists, so it is kept whole
    // even though it is longer than the limit...
    expect(stashed.text).toBe('HEAD');
    expect(stashed.text.length).toBeGreaterThan(limit);
    // ...and the successor's contribution is dropped entirely.
    expect(stashed.text).not.toContain('X');
    expect(stashed.pre).toBe('HEAD');
    expect(stashed.text.startsWith(stashed.pre!)).toBe(true);
    const drops = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('successor stash over the buffer limit'))
      .map((line) => Number(/dropping (\d+) chars/.exec(line)?.[1] ?? '0'));
    // The whole successor tail, measured from what was kept.
    expect(drops).toEqual([long.length]);
    expect(stashed.text.length + drops[0]).toBe('HEAD'.length + long.length);
    stderrSpy.mockRestore();
  });
});

// The send path now reports why it did not reach the wire, but only
// deliverCancelledStash acts on it: the streaming path must keep treating a
// route it could not resolve as a settled (dropped) send, exactly as before.
describe('send path route reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushAndTrack still drops silently when the route cannot resolve', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    (chp['chatTypeMap'] as Map<string, string>).delete('test-chat');
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    onResponseChunk(ch, 'test-chat', 'text', 's1');
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).not.toHaveBeenCalled();
    expect(streamState(ch).has('s1')).toBe(false);
    stderrSpy.mockRestore();
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

  it('a flush blocked by an in-flight send re-arms its expired timer so the tail is never stranded', async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);
    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Map<string, unknown>;

    // The turn streams; the first idle flush captures the buffer and its
    // send stays in flight (flushingSessions armed, buffer emptied).
    onResponseChunk(ch, 'test-chat', 'first', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(flushingSessions.has('sess-1')).toBe(true);

    // A chunk arriving during the in-flight send arms a fresh idle timer —
    // this is the handle idleFlush finds truthy-but-expired when it fires.
    onResponseChunk(ch, 'test-chat', ' tail', 'sess-1');
    const st = streamState(ch).get('sess-1')!;
    const expiredTimer = st.timer;
    expect(expiredTimer).not.toBeNull();

    // The idle timer fires while the send is still blocked. idleFlush must
    // clear the expired handle and re-arm unconditionally — a plain
    // `if (!state.timer)` guard would see the truthy expired handle and skip
    // the re-arm, stranding the tail forever.
    vi.advanceTimersByTime(2000);
    expect(st.timer).not.toBeNull();
    expect(st.timer).not.toBe(expiredTimer);

    // The re-armed timer actually delivers the tail once the send settles.
    resolveSend!(mockResponse(true));
    await drain();
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    const tailBody = mockSendQQMessage.mock.calls[1][3] as Record<
      string,
      unknown
    >;
    expect((tailBody['markdown'] as Record<string, string>)['content']).toBe(
      ' tail',
    );
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

    // Anchor the session to msg-A so the residual tail resolves the same
    // msg_id and continues its msg_seq. The anchor is released when the tail
    // settles, but the counter is deliberately KEPT while the chat-level entry
    // still names msg-A (both asserted below).
    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;

    // Production flow: the triggering message sets the chat-level entry
    // before onPromptStart anchors the session to the same id.
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'part1', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();

    // First send in-flight. New content arrives.
    onResponseChunk(ch, 'test-chat', ' part2', 'sess-1');

    pendingStreamDelete.add('sess-1');

    // Resolve the send
    resolveSend!(mockResponse(true));
    await drain();

    // .then() should: delete pendingStreamDelete, re-arm it for the re-flush
    // chain (residual buffer still queued — the anchor must survive until the
    // tail's send has read its msg_seq), and schedule a new idleFlush timer
    // (the immediate re-flush is blocked by the flushingSessions guard until
    // .finally() clears it).
    expect(pendingStreamDelete.has('sess-1')).toBe(true);
    expect(streamState(ch).has('sess-1')).toBe(true);
    expect(streamState(ch).get('sess-1')!.buffer).toBe(' part2');
    expect(streamState(ch).get('sess-1')!.timer).not.toBeNull();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    // The anchor survived the first chain — the residual tail still needs it.
    expect(sessionAnchors.has('sess-1')).toBe(true);

    // The re-armed idle timer fires the residual re-flush; the shared mock
    // promise is already resolved so the tail send settles within the drain.
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    const tailBody = mockSendQQMessage.mock.calls[1][3] as Record<
      string,
      unknown
    >;
    expect((tailBody['markdown'] as Record<string, string>)['content']).toBe(
      ' part2',
    );
    // Tail continues msg-A's sequence (msg_seq 2) instead of resetting.
    expect(tailBody['msg_id']).toBe('msg-A');
    expect(tailBody['msg_seq']).toBe(2);

    // The tail's settle path released the anchor. The chat-level entry still
    // points at msg-A, so its msg_seq counter is deliberately KEPT — it is
    // only cascaded away when the chat entry moves on or expires (TTL).
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
    expect(streamState(ch).has('sess-1')).toBe(false);
    expect(sessionAnchors.has('sess-1')).toBe(false);
    expect(seqMap.has('msg-A')).toBe(true);
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

describe('cancel/flush coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks does not clear implementations, so install the default
    // send mock here: otherwise individual cases pass only through leakage
    // from an earlier test's mockResolvedValue and fail standalone.
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    mockFetchAccessToken.mockReset();
    vi.useRealTimers();
  });

  it('cancel with a buffered residual while a send is in flight eventually delivers the tail', async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Map<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const flushedSessions = chp['flushedSessions'] as Set<string>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const turnCounter = chp['turnCounter'] as Map<string, number>;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;

    // Turn 1 streams and its first flush stays in flight.
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'part1 ', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(flushingSessions.has('sess-1')).toBe(true);

    // A tail arrives while the send is in flight, then the turn is cancelled
    // (ChannelBase skips onResponseComplete on cancel — only onPromptEnd
    // runs, which defers to the in-flight chain).
    onResponseChunk(ch, 'test-chat', 'tail', 'sess-1');
    (
      ch as unknown as { onPromptEnd: (c: string, s: string) => void }
    ).onPromptEnd('test-chat', 'sess-1');

    expect(pendingStreamDelete.has('sess-1')).toBe(true);
    const st = streamState(ch).get('sess-1')!;
    expect(st.buffer).toBe('tail');
    expect(st.timer).not.toBeNull();

    // The in-flight send is still unresolved past the re-schedule window: the
    // expired-but-truthy timer handle must not prevent a re-arm.
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(st.timer).not.toBeNull();

    // Resolve the in-flight send: .then() re-arms the tail flush (still
    // blocked until .finally() clears flushingSessions), and the fresh idle
    // timer delivers the tail.
    resolveSend!(mockResponse(true));
    await drain();
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    const tailBody = mockSendQQMessage.mock.calls[1][3] as Record<
      string,
      unknown
    >;
    expect((tailBody['markdown'] as Record<string, string>)['content']).toBe(
      'tail',
    );
    // The tail continues msg-A's sequence (msg_seq 2) instead of resetting.
    expect(tailBody['msg_id']).toBe('msg-A');
    expect(tailBody['msg_seq']).toBe(2);

    // Every structure the turn touched is back to empty — except the
    // chat-level entry still pointing at msg-A, whose msg_seq counter is
    // deliberately kept until the entry moves on or expires (TTL).
    expect(streamState(ch).size).toBe(0);
    expect(flushingSessions.size).toBe(0);
    expect(pendingStreamDelete.size).toBe(0);
    expect(flushedSessions.size).toBe(0);
    expect(sessionAnchors.size).toBe(0);
    expect(turnCounter.size).toBe(0);
    expect(seqMap.has('msg-A')).toBe(true);
  });

  it('onPromptEnd defers a cancelled turn whose send is in flight so the tail keeps its anchor', async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;

    // Turn 1 streams; the flush captures the whole buffer and stays in
    // flight (nothing left buffered).
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'part1', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(streamState(ch).get('sess-1')!.buffer).toBe('');

    // Cancel with NO buffered residual: onPromptEnd must defer like
    // onResponseComplete does — purging the entry here would trip the
    // in-flight chain's identity guard, and releasing the anchor now would
    // drop msg-A's seq counter while the chain's tail still needs it.
    (
      ch as unknown as { onPromptEnd: (c: string, s: string) => void }
    ).onPromptEnd('test-chat', 'sess-1');

    expect(streamState(ch).has('sess-1')).toBe(true);
    expect(pendingStreamDelete.has('sess-1')).toBe(true);
    expect(sessionAnchors.get('sess-1')!.msgId).toBe('msg-A');

    // A tail arrives while the send is still in flight; it must keep the
    // session's anchor (msg-A) and continue its seq instead of going out as
    // an active message.
    onResponseChunk(ch, 'test-chat', ' tail', 'sess-1');
    expect(streamState(ch).get('sess-1')!.buffer).toBe(' tail');

    resolveSend!(mockResponse(true));
    await drain();
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    const body = mockSendQQMessage.mock.calls[1][3] as Record<string, unknown>;
    expect((body['markdown'] as Record<string, string>)['content']).toBe(
      ' tail',
    );
    expect(body['msg_id']).toBe('msg-A');
    expect(body['msg_seq']).toBe(2);
    expect(streamState(ch).has('sess-1')).toBe(false);
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
    expect(sessionAnchors.has('sess-1')).toBe(false);
    // The chat-level entry still points at msg-A, so its msg_seq counter is
    // kept until the entry moves on or expires.
    expect(seqMap.has('msg-A')).toBe(true);
  });

  it("keeps a cancelled turn's deferred residual when a new turn's chunk arrives", async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const turnCounter = chp['turnCounter'] as Map<string, number>;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;

    // Turn 1 streams, its flush is in flight, a tail is buffered, then the
    // turn is cancelled: the deferred flush chain owns the tail.
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'part1 ', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    onResponseChunk(ch, 'test-chat', 'tail', 'sess-1');
    (
      ch as unknown as { onPromptEnd: (c: string, s: string) => void }
    ).onPromptEnd('test-chat', 'sess-1');
    expect(pendingStreamDelete.has('sess-1')).toBe(true);

    // Turn 2 starts and its first chunk hits the stale branch while the
    // deferred flush still owns the residual: the entry, live timer and
    // flags must survive so the chain can deliver the tail — dropping them
    // here would trip the chain's identity guard and strand the tail.
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-B');
    // Turn 2's onPromptStart released turn 1's anchor, but the cascaded
    // msg_seq must survive while the streamState entry still holds the msgId
    // with a pending flush (thread 29) — the tail continues at seq 2 below.
    expect(seqMap.get('msg-A')).toBe(1);
    onResponseChunk(ch, 'test-chat', 'turn-2', 'sess-1');

    expect(streamState(ch).get('sess-1')!.buffer).toBe('tail');
    expect(streamState(ch).get('sess-1')!.timer).not.toBeNull();
    expect(pendingStreamDelete.has('sess-1')).toBe(true);
    expect(turnCounter.get('sess-1')).toBe(2);

    // The in-flight send settles: the chain re-flushes the tail and its
    // terminal settle cleans its own flags WITHOUT deleting turn 2's counter.
    resolveSend!(mockResponse(true));
    await drain();
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    const tailBody = mockSendQQMessage.mock.calls[1][3] as Record<
      string,
      unknown
    >;
    expect((tailBody['markdown'] as Record<string, string>)['content']).toBe(
      'tail',
    );
    expect(tailBody['msg_id']).toBe('msg-A');
    // The stale entry is gone; turn 2's counter and anchor survive the settle.
    expect(streamState(ch).has('sess-1')).toBe(false);
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
    expect(turnCounter.get('sess-1')).toBe(2);
    expect(sessionAnchors.get('sess-1')!.msgId).toBe('msg-B');

    // Turn 2's next chunk starts fresh under its own anchor — with the
    // side-buffered 'turn-2' chunk prepended (its HEAD was stashed while the
    // deferred chain owned the entry, so it is not silently dropped).
    onResponseChunk(ch, 'test-chat', ' turn-2-more', 'sess-1');
    const st = streamState(ch).get('sess-1')!;
    expect(st.buffer).toBe('turn-2 turn-2-more');
    expect(st.msgId).toBe('msg-B');
    expect(st.turn).toBe(2);

    // Clean up turn 2's idle flush — the side-buffered HEAD + the fresh
    // chunk go out as a single message under turn 2's anchor.
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(3);
  });

  it("a deferred proactive turn's flush does not erase the successor's anchor", async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    const chp = ch as unknown as Record<string, unknown>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const turnCounter = chp['turnCounter'] as Map<string, number>;

    // Proactive turn (cron/loop/webhook): no triggering message → no anchor,
    // but the turn counter is still bumped so its streamState entries carry
    // a distinct generation (a messageId-gated bump would keep the counter
    // at 0 and stale-state detection would never engage).
    onPromptStart(ch, 'test-chat', 'sess-1');
    expect(turnCounter.get('sess-1')).toBe(1);
    onResponseChunk(ch, 'test-chat', 'proactive ', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(sessionAnchors.has('sess-1')).toBe(false);

    // Completion is deferred while the send is in flight.
    await onResponseComplete(ch, 'test-chat', 'proactive ', 'sess-1');
    expect(pendingStreamDelete.has('sess-1')).toBe(true);

    // A user turn starts and anchors msg-B while the deferred chain settles.
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-B');
    expect(sessionAnchors.get('sess-1')!.msgId).toBe('msg-B');

    // The deferred chain settles with state.msgId === undefined: it must not
    // release anything — an unconditional release would delete msg-B.
    resolveSend!(mockResponse(true));
    await drain();

    expect(sessionAnchors.get('sess-1')!.msgId).toBe('msg-B');
    expect(pendingStreamDelete.has('sess-1')).toBe(false);

    // Turn 2's chunks stream under its own anchor.
    onResponseChunk(ch, 'test-chat', 'user reply ', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    const body = mockSendQQMessage.mock.calls[1][3] as Record<string, unknown>;
    expect(body['msg_id']).toBe('msg-B');
    expect(sessionAnchors.get('sess-1')!.msgId).toBe('msg-B');
  });

  it('a transient failure during a cancelled turn preserves the residual accumulated during the in-flight send', async () => {
    const ch = makeChannel();
    let rejectSend: (err: Error) => void;
    const sendPromise = new Promise<MockResponse>((_r, rej) => {
      rejectSend = rej as (err: Error) => void;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;

    // Production flow: the triggering message sets the chat-level entry
    // before onPromptStart anchors the session to the same id.
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'part1', 'sess-1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);

    // The turn is ending (deferred); a residual arrives during the send.
    pendingStreamDelete.add('sess-1');
    onResponseChunk(ch, 'test-chat', ' fresh', 'sess-1');

    // The in-flight send fails transiently: the retry buffer must keep BOTH
    // the failed payload and the residual that arrived during the send (the
    // pending branch previously overwrote the residual).
    rejectSend!(new Error('send failed'));
    try {
      await sendPromise;
    } catch {
      /* expected */
    }
    await drain();

    expect(streamState(ch).get('sess-1')!.buffer).toBe('part1 fresh');
    expect(pendingStreamDelete.has('sess-1')).toBe(true); // re-armed for retry

    // The retry succeeds and settles.
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    const body = mockSendQQMessage.mock.calls[1][3] as Record<string, unknown>;
    expect((body['markdown'] as Record<string, string>)['content']).toBe(
      'part1 fresh',
    );
    expect(streamState(ch).has('sess-1')).toBe(false);
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
    // The chat-level entry still points at msg-A, so its msg_seq counter is
    // kept until the entry moves on or expires.
    expect(seqMap.has('msg-A')).toBe(true);
  });

  it('onPromptEnd fallthrough releases the anchor and clears every structure when no stream is active', () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Map<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const flushedSessions = chp['flushedSessions'] as Set<string>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const turnCounter = chp['turnCounter'] as Map<string, number>;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<
      string,
      { turn: number; text: string; pre?: string }
    >;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;
    const promptEnd = (ch: QQChannelClass, chatId: string, sessionId: string) =>
      (
        ch as unknown as { onPromptEnd: (c: string, s: string) => void }
      ).onPromptEnd(chatId, sessionId);

    // A prompt that never streamed (e.g. cancelled before the first chunk)
    // still leaves a stale anchor + turn counter; the fallthrough teardown
    // must release all structures. Seed every structure the fallthrough
    // touches — with an empty-buffer stream entry (a buffered residual would
    // take the ownership-transfer path instead of this one), the flushed
    // record, the turn counter, the reply anchor and the orphan side buffer.
    streamState(ch).set('sess-1', {
      chatId: 'test-chat',
      buffer: '',
      timer: null,
      retryCount: 0,
      msgId: 'msg-A',
      turn: 1,
    });
    flushedSessions.add('sess-1');
    turnCounter.set('sess-1', 1);
    sessionAnchors.set('sess-1', { msgId: 'msg-A', timestamp: Date.now() });
    // A superseded turn's stash (turn 0 vs the live turn 1) is dropped here,
    // not delivered, so the fallthrough still clears everything.
    orphanBuffer.set('sess-1', { turn: 0, text: 'stray' });
    seqMap.set('msg-A', 3);

    promptEnd(ch, 'test-chat', 'sess-1');

    expect(streamState(ch).size).toBe(0);
    expect(flushingSessions.size).toBe(0);
    expect(pendingStreamDelete.size).toBe(0);
    expect(flushedSessions.size).toBe(0);
    expect(sessionAnchors.size).toBe(0);
    expect(turnCounter.size).toBe(0);
    expect(orphanBuffer.size).toBe(0);
    // The anchor release cascades msg-A's orphaned counter away.
    expect(seqMap.has('msg-A')).toBe(false);
  });

  it('release with a mismatched expectedMsgId keeps the successor anchor but cascades the old seq', () => {
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

    // A successor turn overwrote the anchor (msg-B) while the superseded
    // turn's deferred chain settles with its own expectedMsgId (msg-A).
    sessionAnchors.set('sess-1', { msgId: 'msg-B', timestamp: Date.now() });
    seqMap.set('msg-A', 2);
    seqMap.set('msg-B', 1);
    replyMap.set('test-chat', { msgId: 'msg-B', timestamp: Date.now() });

    (
      ch as unknown as {
        releaseSessionReplyAnchor: (s: string, m?: string) => void;
      }
    ).releaseSessionReplyAnchor('sess-1', 'msg-A');

    // The successor's anchor survives the stale release...
    expect(sessionAnchors.get('sess-1')!.msgId).toBe('msg-B');
    // ...but the superseded turn's seq counter is cascaded away.
    expect(seqMap.has('msg-A')).toBe(false);
    expect(seqMap.get('msg-B')).toBe(1);
  });

  it('onPromptEnd hands the buffered state to the flush chain, so a residual arriving during the send is still delivered', async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;

    // A turn streams a partial reply and is cancelled while the tail is
    // still buffered. onPromptEnd parks the session and hands the state to
    // the in-flight flush chain (ownership transfer). If it fell through to
    // the teardown instead, the chain's identity guard would trip on
    // resolve and the residual arriving during the send would go out as a
    // fresh, anchor-less entry — losing the reply anchor mid-stream.
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'partial ', 'sess-1');
    (
      ch as unknown as { onPromptEnd: (c: string, s: string) => void }
    ).onPromptEnd('test-chat', 'sess-1');
    await drain();

    // The session is parked and the flush is in flight with 'partial '
    // captured under the reply anchor.
    expect(pendingStreamDelete.has('sess-1')).toBe(true);
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const firstBody = mockSendQQMessage.mock.calls[0][3] as Record<
      string,
      unknown
    >;
    expect((firstBody['markdown'] as Record<string, string>)['content']).toBe(
      'partial ',
    );
    expect(firstBody['msg_id']).toBe('msg-A');

    // A residual arrives while the flush is in flight; the entry survived
    // (onPromptEnd returned), so it accumulates instead of being dropped.
    onResponseChunk(ch, 'test-chat', 'tail', 'sess-1');

    // The in-flight send settles; the chain re-flushes the residual on its
    // re-armed idle timer — still under msg-A, so the reply content is
    // continuous and stays anchored (msg_seq continues at 2).
    resolveSend!(mockResponse(true));
    await drain();
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    const tailBody = mockSendQQMessage.mock.calls[1][3] as Record<
      string,
      unknown
    >;
    expect((tailBody['markdown'] as Record<string, string>)['content']).toBe(
      'tail',
    );
    expect(tailBody['msg_id']).toBe('msg-A');
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
  });

  it('release while a tail flush is in flight keeps msg-A seq instead of resetting it to 1, then reclaims it once the routing entry is evicted', async () => {
    const ch = makeChannel();
    let resolveTailSend: (v: MockResponse) => void;
    const tailSendPromise = new Promise<MockResponse>((r) => {
      resolveTailSend = r;
    });
    mockSendQQMessage.mockResolvedValue(mockResponse(true));

    const chp = ch as unknown as Record<string, unknown>;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;
    const flushingSessions = chp['flushingSessions'] as Map<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;

    // Turn 1 streams; its first flush delivers (msg-A, seq 1) and settles.
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'hello ', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(seqMap.get('msg-A')).toBe(1);

    // A tail arrives and the turn is cancelled: onPromptEnd hands the
    // residual to an immediate flush and keeps its send in flight. The
    // streamState entry is now drained (buffer '', timer null) — the only
    // marker that the tail flush is still alive is the flushingSessions flag.
    mockSendQQMessage.mockReturnValueOnce(tailSendPromise);
    onResponseChunk(ch, 'test-chat', 'world', 's1');
    (
      ch as unknown as { onPromptEnd: (c: string, s: string) => void }
    ).onPromptEnd('test-chat', 's1');
    await drain();

    // The tail flush captured the residual and is suspended in flight.
    expect(seqMap.get('msg-A')).toBe(2); // seq already assigned to the tail send
    expect(flushingSessions.has('s1')).toBe(true);
    expect(pendingStreamDelete.has('s1')).toBe(true);
    const st = streamState(ch).get('s1')!;
    expect(st.buffer).toBe('');
    expect(st.timer).toBeNull();
    expect(st.msgId).toBe('msg-A');

    // The next turn starts with a newer message: onPromptStart releases the
    // superseded anchor. The release must NOT cascade msg-A's counter away —
    // the in-flight flush still owns the tail. The old (buffer || timer)
    // guard missed this drained-entry window and reset the tail's msg_seq to
    // 1 on its re-flush, which QQ dedupes on msg_id + msg_seq and silently
    // drops.
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');

    expect(sessionAnchors.get('s1')!.msgId).toBe('msg-B');
    expect(seqMap.get('msg-A')).toBe(2);

    // The tail send settles; the chain's terminal release is deferred to its
    // .finally(), after the in-flight marker is cleared. The counter is then
    // retained because replyContextByMessageId still names msg-A —
    // a later send could still resolve it — and is reclaimed once that routing
    // entry is evicted.
    resolveTailSend!(mockResponse(true));
    await drain();

    expect(seqMap.get('msg-A')).toBe(2);
    (chp['deleteReplyContext'] as (c: unknown) => void).call(ch, {
      chatId: 'test-chat',
      msgId: 'msg-A',
      timestamp: Date.now(),
    });
    expect(seqMap.has('msg-A')).toBe(false);
    expect(streamState(ch).has('s1')).toBe(false);
    expect(flushingSessions.has('s1')).toBe(false);
    expect(pendingStreamDelete.has('s1')).toBe(false);
  });

  it('stale-drop release during an in-flight tail flush keeps msg-A seq (wenshao blocking 1)', async () => {
    const ch = makeChannel();
    let releaseTokenGate: () => void;
    const tokenGate = new Promise<void>((r) => {
      releaseTokenGate = r;
    });
    const chp = ch as unknown as Record<string, unknown>;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;
    const flushingSessions = chp['flushingSessions'] as Map<string, unknown>;

    // Turn 1, segment 1 → (msg-A, seq 1): the idle flush delivers and
    // settles, recording msg-A's counter.
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'hello ', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(seqMap.get('msg-A')).toBe(1);

    // Tail arrives, turn cancelled. Expire the token so the tail's
    // sendMessage suspends in resolveRoute → fetchToken, BEFORE it reads
    // msgSeqMap. The tail send is now live in flushingSessions but has not
    // yet consumed the counter.
    chp['tokenExpiresAt'] = Date.now() - 1;
    mockFetchAccessToken.mockImplementation(async () => {
      await tokenGate; // held open by the test
      return { accessToken: 'test-token', expiresIn: 7200 };
    });
    onResponseChunk(ch, 'test-chat', 'world', 's1');
    (
      ch as unknown as { onPromptEnd: (c: string, s: string) => void }
    ).onPromptEnd('test-chat', 's1');
    await drain();

    expect(flushingSessions.has('s1')).toBe(true); // tail send is live
    expect(seqMap.get('msg-A')).toBe(1); // seq not yet assigned to the tail

    // Next turn starts; its first chunk arrives while the tail is still
    // suspended. The stale-drop branch releases the superseded anchor — the
    // release must run BEFORE the streamState/flushingSessions teardown so
    // the in-flight guard sees the live tail send and keeps msg-A's counter
    // (the old delete-then-release order dropped the counter here, and the
    // tail's re-flush would resolve nextSeq = 1 — QQ dedupes on msg_id +
    // msg_seq and silently drops the reply tail).
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    expect(seqMap.get('msg-A')).toBe(1); // onPromptStart's release IS guarded
    onResponseChunk(ch, 'test-chat', 'next turn text', 's1'); // stale-drop branch
    expect(seqMap.has('msg-A')).toBe(true); // counter kept while the tail is live

    // The stale branch dropped turn 1's entry and flags; turn 2's chunk
    // created a fresh entry under msg-B.
    expect(streamState(ch).get('s1')!.turn).toBe(2);
    expect(streamState(ch).get('s1')!.msgId).toBe('msg-B');

    // Settle the suspended tail send so nothing dangles: its chain's
    // identity guard sees the replaced entry and touches nothing.
    releaseTokenGate!();
    await drain();
    // Turn 2's idle timer delivers its own chunk under msg-B.
    vi.advanceTimersByTime(2000);
    await drain();
  });

  it("cancelled turn's orphaned head does not leak into the next turn's reply (wenshao blocking 2)", async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    // Turn 1: first flush goes in flight and stays suspended; more text
    // buffers behind it; onResponseComplete defers into pendingStreamDelete.
    onResponseChunk(ch, 'test-chat', 'T1-head ', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    onResponseChunk(ch, 'test-chat', 'T1-tail', 's1');
    void onResponseComplete(ch, 'test-chat', 'T1-head T1-tail', 's1');
    await drain();

    // Turn 2 streams — its chunk lands in streamOrphanBuffer (the deferred
    // chain still owns the entry) — then is cancelled. onPromptEnd must
    // deliver that stashed HEAD on turn 2's own anchor (msg-B) rather than
    // leaving it for turn 3 to drop as superseded.
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    onResponseChunk(ch, 'test-chat', 'T2-SECRET', 's1');
    (
      ch as unknown as { onPromptEnd: (c: string, s: string) => void }
    ).onPromptEnd('test-chat', 's1');

    // Turn 1's chain settles: the deferred re-flush delivers T1-tail, then
    // frees the entry.
    resolveSend!(mockResponse(true));
    await vi.advanceTimersByTimeAsync(20_000);
    await drain();
    expect(streamState(ch).has('s1')).toBe(false);

    // Turn 3 — in thread scope, another member's question on the same
    // session. Turn 2's HEAD went out as its own message, so turn 3's reply
    // head is its own text, not "T2-SECRETT3-answer".
    setReplyMsgId(ch, 'test-chat', 'msg-C');
    onPromptStart(ch, 'test-chat', 's1', 'msg-C');
    onResponseChunk(ch, 'test-chat', 'T3-answer', 's1');
    vi.advanceTimersByTime(2000);
    await drain();

    // Four sends: T1-head, the cancelled turn's own T2-SECRET, T1-tail and
    // T3-answer. The cancelled text is delivered once as its own message and
    // never concatenated into turn 3's reply. Each expected message must
    // appear exactly once (order-free), so a duplication cannot pass.
    expect(mockSendQQMessage).toHaveBeenCalledTimes(4);
    const contents = sentContents();
    for (const expected of ['T1-head ', 'T2-SECRET', 'T1-tail', 'T3-answer']) {
      expect(contents.filter((c) => c === expected)).toHaveLength(1);
    }
    expect(contents.some((c) => c.includes('T2-SECRETT3-answer'))).toBe(false);
    const body = mockSendQQMessage.mock.calls[3][3] as Record<string, unknown>;
    expect((body['markdown'] as Record<string, string>)['content']).toBe(
      'T3-answer',
    );
  });

  it('final segment suspended in resolveRoute keeps msg-A seq when the session dies', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;
    const streamState = chp['streamState'] as Map<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Map<string, unknown>;

    // Turn 1's first segment delivers (msg-A, seq 1) and settles.
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'head ', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(seqMap.get('msg-A')).toBe(1);

    // A newer message moves the chat-level entry (ordinary group traffic), so
    // only the in-flight marker can protect the counter.
    setReplyMsgId(ch, 'test-chat', 'msg-C');

    // Expire the token: the terminal send suspends in resolveRoute →
    // fetchToken, BEFORE it reads msgSeqMap.
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((r) => {
      releaseToken = r;
    });
    chp['tokenExpiresAt'] = Date.now() - 1;
    mockFetchAccessToken.mockImplementation(async () => {
      await tokenGate;
      return { accessToken: 'test-token', expiresIn: 7200 };
    });

    onResponseChunk(ch, 'test-chat', 'tail', 's1');
    const completion = onResponseComplete(ch, 'test-chat', 'head tail', 's1');
    await drain();

    // The terminal send is suspended with no streamState entry and no
    // flushingSessions marker — only the in-flight refcount can see it.
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(streamState.has('s1')).toBe(false);
    expect(flushingSessions.has('s1')).toBe(false);

    // Session death lands in that window: the guard must keep the counter so
    // the suspended send still resolves msg_seq 2, not a duplicate of (msg-A,1).
    ch.onSessionDied('s1');

    releaseToken();
    await completion;
    await drain();

    const tailBody = mockSendQQMessage.mock.calls[1][3] as Record<
      string,
      unknown
    >;
    expect(tailBody['msg_id']).toBe('msg-A');
    expect(tailBody['msg_seq']).toBe(2);
  });

  it("deleteReplyContext keeps a parked residual's msg_seq counter", async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;
    const streamState = chp['streamState'] as Map<
      string,
      { msgId?: string; buffer: string }
    >;
    const flushingSessions = chp['flushingSessions'] as Map<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;

    // Turn 1's head delivers (msg-A, seq 1) and settles.
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'T1-head ', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(seqMap.get('msg-A')).toBe(1);

    // The next flush suspends; a residual buffers behind it and the turn parks.
    let resolveSend!: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValueOnce(sendPromise);
    onResponseChunk(ch, 'test-chat', 'T1-tail ', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(flushingSessions.has('s1')).toBe(true);
    onResponseChunk(ch, 'test-chat', 'T1-resid ', 's1');
    onPromptEnd(ch, 'test-chat', 's1');
    expect(pendingStreamDelete.has('s1')).toBe(true);
    expect(streamState.get('s1')!.msgId).toBe('msg-A');
    expect(streamState.get('s1')!.buffer).toBe('T1-resid ');

    // A successor turn moves the anchor; the release veto keeps the counter
    // because the parked entry still holds msg-A with a buffered residual.
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    expect(seqMap.get('msg-A')).toBe(2);

    // The sweep's exact call for the expired msg-A context: the shared
    // predicate must keep the counter while the parked residual owns it.
    const contexts = chp['replyContextByMessageId'] as Map<
      string,
      { chatId: string; msgId: string; timestamp: number }
    >;
    (
      chp['deleteReplyContext'] as (c: {
        chatId: string;
        msgId: string;
        timestamp: number;
      }) => void
    )(contexts.get('msg-A')!);

    // The parked residual flushes and continues at seq 3, not 1.
    resolveSend(mockResponse(true));
    await drain();
    vi.advanceTimersByTime(6000);
    await drain();

    const residualBody = mockSendQQMessage.mock.calls[2][3] as Record<
      string,
      unknown
    >;
    expect(residualBody['msg_id']).toBe('msg-A');
    expect(residualBody['msg_seq']).toBe(3);

    // Once the parked residual has settled and the anchor has moved on, the
    // counter is no longer held by anything and must be reclaimed — the other
    // direction of the guard, so "kept while parked" cannot be confused with
    // "never reclaimed".
    expect(seqMap.has('msg-A')).toBe(false);
  });

  it('a failed concurrent send does not roll back a seq another send accepted', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;

    setReplyMsgId(ch, 'test-chat', 'msg-A');

    // Session s2's anchored send starts first (msg-A, seq 1) and suspends.
    onPromptStart(ch, 'test-chat', 's2', 'msg-A');
    let rejectB!: (e: unknown) => void;
    const promiseB = new Promise<MockResponse>((_res, rej) => {
      rejectB = rej;
    });
    mockSendQQMessage.mockReturnValueOnce(promiseB);
    onResponseChunk(ch, 'test-chat', 'B-text', 's2');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(seqMap.get('msg-A')).toBe(1);

    // Session s1's anchored send runs under the SAME msgId and succeeds seq 2.
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    mockSendQQMessage.mockResolvedValueOnce(mockResponse(true));
    onResponseChunk(ch, 'test-chat', 'A-text', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(seqMap.get('msg-A')).toBe(2);
    const aBody = sentBodies().at(-1)!;
    expect(aBody['msg_id']).toBe('msg-A');
    expect(aBody['msg_seq']).toBe(2);

    // s2's suspended send now fails: the rollback must not forget s1's
    // accepted seq 2 while s1's anchor is still live.
    rejectB(new Error('network down'));
    await drain();

    // Clear s2's retry timer so the next advanceTimersByTime does not replay it.
    const s2state = (chp['streamState'] as Map<string, { timer: unknown }>).get(
      's2',
    );
    if (s2state?.timer) {
      clearTimeout(s2state.timer as ReturnType<typeof setTimeout>);
      (s2state as { timer: unknown }).timer = null;
    }

    // The counter must still reflect the accepted seq 2.
    expect(seqMap.get('msg-A')).toBe(2);

    // The next two sends continue at 3 and 4; a replay of 1 and 2 would
    // duplicate an accepted (msg_id, msg_seq) pair that QQ dedupes and drops.
    onResponseChunk(ch, 'test-chat', 'C-text', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    onResponseChunk(ch, 'test-chat', 'D-text', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    const replayed = sentBodies()
      .filter((b) => b['msg_id'] === 'msg-A')
      .map((b) => b['msg_seq']);
    expect(replayed).toEqual([1, 2, 3, 4]);
  });

  it('holds a cancelled-stash msg_seq counter across its retry backoff and a TTL sweep', async () => {
    // Unlimited retries keep the cancelled-stash delivery in its loop long
    // enough for a sweep tick to land inside a 2s/4s backoff window — the
    // window the in-flight registration must cover.
    const ch = makeChannel({ maxFlushRetries: 0 });
    const chp = ch as unknown as Record<string, unknown>;
    const msgSeqMap = chp['msgSeqMap'] as Map<string, number>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'part-1 ', 's1');
    await vi.advanceTimersByTimeAsync(2100);
    await drain();
    expect(msgSeqMap.get('msg-A')).toBe(1);

    // Age every naming entry past the TTL so one sweep tick can evict the last
    // holder while the cancelled stash is still being retried.
    const stale = Date.now() - 300_001;
    sessionAnchors.set('s1', { msgId: 'msg-A', timestamp: stale });
    (
      chp['replyMsgId'] as Map<string, { msgId: string; timestamp: number }>
    ).set('test-chat', { msgId: 'msg-A', timestamp: stale });
    const contexts = chp['replyContextByMessageId'] as Map<
      string,
      { chatId: string; msgId: string; timestamp: number }
    >;
    const context = contexts.get('msg-A');
    expect(context).toBeDefined();
    context!.timestamp = stale;

    mockSendQQMessage.mockRejectedValue(new Error('transient'));
    const delivery = (
      ch as unknown as {
        deliverCancelledStash: (
          c: string,
          s: string,
          t: string,
          a?: string | null,
        ) => Promise<void>;
      }
    ).deliverCancelledStash('test-chat', 's1', 'STASHED-HEAD', 'msg-A');
    await drain();

    // One sweep tick lands inside a backoff sleep, where no send is awaiting
    // but the pending attempt still needs its counter.
    (chp['startReplyMsgIdCleanup'] as () => void).call(ch);
    await vi.advanceTimersByTimeAsync(61_000);
    await drain();
    expect(msgSeqMap.has('msg-A')).toBe(true);

    // The retry then succeeds and continues the counter instead of restarting
    // at 1, which QQ would dedupe against the accepted (msg-A, 1).
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await vi.advanceTimersByTimeAsync(5_000);
    await delivery;
    const stashAttempts = sentBodies().filter((b) =>
      String(
        (b['markdown'] as { content?: string } | undefined)?.content ?? '',
      ).includes('STASHED-HEAD'),
    );
    expect(stashAttempts.length).toBeGreaterThan(1);
    expect(stashAttempts.at(-1)!['msg_seq']).toBe(2);
  });
});

describe('verified fix regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the [sender · task] label on the anchored final segment (Fix 1)', async () => {
    const ch = makeChannel();

    // The labeled chunk is flushed by the idle timer and its state entry is
    // torn down; the later residual creates a fresh entry with no label of
    // its own, so the label can only come from the completion segment.
    onPromptStart(ch, 'test-chat', 'sess-A', 'msg-A');
    onResponseChunk(
      ch,
      'test-chat',
      'part-1 ',
      'sess-A',
      undefined,
      '[Alice · fix]',
    );
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);

    onResponseChunk(ch, 'test-chat', 'part-2', 'sess-A');
    await (
      ch as unknown as {
        onResponseComplete: (
          c: string,
          f: string,
          s: string,
          seg?: { sourceLabel?: string },
        ) => Promise<void>;
      }
    ).onResponseComplete('test-chat', 'ignored', 'sess-A', {
      sourceLabel: '[Alice · fix]',
    });

    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    const body = mockSendQQMessage.mock.calls[1][3] as {
      markdown: { content: string };
      msg_id?: string;
    };
    expect(body.markdown.content.startsWith('\\[Alice · fix\\]\n')).toBe(true);
    // The anchored final segment stayed under the session's own msg_id.
    expect(body.msg_id).toBe('msg-A');
  });

  it('a permanent flush failure while the turn is live keeps the msg_seq counter (Fix 2)', async () => {
    const ch = makeChannel();
    mockSendQQMessage
      .mockResolvedValueOnce(mockResponse(true))
      .mockRejectedValueOnce(
        new DeliveryError('FALLBACK_FAILED', 'permanent failure'),
      )
      .mockResolvedValueOnce(mockResponse(true));

    const chp = ch as unknown as Record<string, unknown>;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;

    // Flush 1 succeeds under msg-A (seq counter 1), then a concurrent message
    // moves the chat-level entry on to msg-B.
    onPromptStart(ch, 'test-chat', 'sess-A', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'part-1 ', 'sess-A');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(seqMap.get('msg-A')).toBe(1);
    setReplyMsgId(ch, 'test-chat', 'msg-B');

    // Flush 2 fails permanently while the turn is still live. The anchor must
    // survive so the counter is not cascaded away.
    onResponseChunk(ch, 'test-chat', 'will-fail', 'sess-A');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(sessionAnchors.has('sess-A')).toBe(true);
    expect(seqMap.get('msg-A')).toBe(1);

    // Flush 3 continues the counter: (msg-A, 2), not a deduped (msg-A, 1).
    onResponseChunk(ch, 'test-chat', 'next', 'sess-A');
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage).toHaveBeenCalledTimes(3);
    const body = mockSendQQMessage.mock.calls[2][3] as Record<string, unknown>;
    expect(body['msg_id']).toBe('msg-A');
    expect(body['msg_seq']).toBe(2);
  });

  it('a parked session taken over by the normal completion path does not duplicate the next turn (Fix 4)', async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;

    // Turn 1: the first flush is in flight when onResponseComplete parks the
    // session for the deferred teardown.
    onPromptStart(ch, 'test-chat', 'sess-A', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'head', 'sess-A');
    vi.advanceTimersByTime(2000);
    await drain();
    await onResponseComplete(ch, 'test-chat', 'head tail', 'sess-A');
    expect(pendingStreamDelete.has('sess-A')).toBe(true);

    // A residual arrives behind the in-flight send, so the settle re-arms the
    // park and reschedules the flush. Invalidating the scheduled retry's
    // reconnect generation makes idleFlush discard it, leaving the park flag
    // and the residual entry behind — the state this fix defends against.
    onResponseChunk(ch, 'test-chat', 'tail', 'sess-A');
    resolveSend!(mockResponse(true));
    await drain();
    chp['_reconnectId'] = (chp['_reconnectId'] as number) + 1;
    vi.advanceTimersByTime(2000);
    await drain();
    expect(pendingStreamDelete.has('sess-A')).toBe(true);
    expect(streamState(ch).get('sess-A')!.buffer).toBe('tail');

    // The normal completion path takes over the parked residual and delivers
    // it itself — and must clear the park flag along with the entry.
    await onResponseComplete(ch, 'test-chat', 'head tail', 'sess-A');
    expect(pendingStreamDelete.has('sess-A')).toBe(false);

    // Turn 2: its idle flush delivers its text once; the completion must not
    // deliver it a second time (a stale park made that flush's settle clear
    // flushedSessions mid-turn, so onResponseComplete re-sent the text).
    onPromptStart(ch, 'test-chat', 'sess-A', 'msg-B');
    onResponseChunk(ch, 'test-chat', 'turn2', 'sess-A');
    vi.advanceTimersByTime(2000);
    await drain();
    await onResponseComplete(ch, 'test-chat', 'turn2', 'sess-A');

    const delivered = mockSendQQMessage.mock.calls
      .map(
        (c) =>
          (c[3] as Record<string, unknown>)['markdown'] as {
            content: string;
          },
      )
      .filter((m) => m.content === 'turn2');
    expect(delivered).toHaveLength(1);
  });

  it('a mid-turn response boundary does not arm the turn-ending teardown (Fix 3)', async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;

    // part1 is in flight when part2 buffers behind it.
    onPromptStart(ch, 'test-chat', 'sess-A', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'part1 ', 'sess-A');
    vi.advanceTimersByTime(2000);
    await drain();
    onResponseChunk(ch, 'test-chat', 'part2', 'sess-A');

    // A mid-turn boundary (tool call / plan update) must not park the session
    // for teardown; it hands the residual to the idle timer instead.
    onResponseBoundary(ch, 'test-chat', 'sess-A');
    expect(pendingStreamDelete.has('sess-A')).toBe(false);

    resolveSend!(mockResponse(true));
    await drain();
    vi.advanceTimersByTime(2000);
    await drain();

    // The post-boundary segment went out exactly once, and completing the
    // turn does not re-send it.
    await onResponseComplete(ch, 'test-chat', 'part2', 'sess-A');

    const delivered = mockSendQQMessage.mock.calls
      .map(
        (c) =>
          (c[3] as Record<string, unknown>)['markdown'] as {
            content: string;
          },
      )
      .filter((m) => m.content === 'part2');
    expect(delivered).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════
// Stash ownership + flush-marker ownership regressions
// ════════════════════════════════════════════════════════════════

function onPromptEnd(ch: QQChannelClass, chatId: string, sessionId: string) {
  (
    ch as unknown as { onPromptEnd: (c: string, s: string) => void }
  ).onPromptEnd(chatId, sessionId);
}

/** Raw `markdown.content` of every send, in call order. */
function sentContents(): string[] {
  return mockSendQQMessage.mock.calls.map((c) => {
    const body = c[3] as Record<string, unknown> | undefined;
    const markdown = body?.['markdown'] as { content?: string } | undefined;
    return markdown?.content ?? '';
  });
}

/** Raw request body of every send, in call order. */
function sentBodies(): Array<Record<string, unknown>> {
  return mockSendQQMessage.mock.calls.map(
    (c) => c[3] as Record<string, unknown>,
  );
}

/**
 * Drive a session to the state where a live turn's reply HEAD sits in the
 * orphan side buffer: turn 1's tail send is suspended, turn 1 is parked for
 * teardown, turn 2 starts and its first chunk is diverted to the side buffer,
 * then turn 1's chain settles and frees the shared streamState entry.
 */
async function reachStashedOrphan(ch: QQChannelClass) {
  const chp = ch as unknown as Record<string, unknown>;
  const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
  const orphanBuffer = chp['streamOrphanBuffer'] as Map<
    string,
    { turn: number; text: string; pre?: string }
  >;

  setReplyMsgId(ch, 'test-chat', 'msg-A');
  onPromptStart(ch, 'test-chat', 's1', 'msg-A');
  onResponseChunk(ch, 'test-chat', 'T1-head ', 's1');
  vi.advanceTimersByTime(2000);
  await drain();
  expect(mockSendQQMessage).toHaveBeenCalledTimes(1);

  // Turn 1's tail send suspends; a residual buffers behind it.
  let resolveSend!: (v: MockResponse) => void;
  const sendPromise = new Promise<MockResponse>((r) => {
    resolveSend = r;
  });
  mockSendQQMessage.mockReturnValue(sendPromise);
  onResponseChunk(ch, 'test-chat', 'T1-tail ', 's1');
  vi.advanceTimersByTime(2000);
  await drain();
  onResponseChunk(ch, 'test-chat', 'T1-resid ', 's1');
  onPromptEnd(ch, 'test-chat', 's1');
  expect(pendingStreamDelete.has('s1')).toBe(true);

  // Turn 2 starts; the parked entry still owns the session, so its first
  // chunk is diverted to the side buffer under turn 2's ownership.
  setReplyMsgId(ch, 'test-chat', 'msg-B');
  onPromptStart(ch, 'test-chat', 's1', 'msg-B');
  onResponseChunk(ch, 'test-chat', 'T2-HEAD ', 's1');
  expect(orphanBuffer.get('s1')).toEqual({
    turn: 2,
    text: 'T2-HEAD ',
  });

  // Turn 1 settles: its residual goes out and the chain frees the entry,
  // leaving only turn 2's stashed head.
  resolveSend(mockResponse(true));
  await vi.advanceTimersByTimeAsync(20_000);
  await drain();
  expect(pendingStreamDelete.has('s1')).toBe(false);
  expect(streamState(ch).has('s1')).toBe(false);

  return { chp, pendingStreamDelete, orphanBuffer };
}

/**
 * Drive a session to the stale-completion state: turn 1's tail send is
 * suspended and turn 1 is parked for teardown, turn 2 starts and its first
 * chunk is diverted to the side buffer, and turn 1's chain is still live so
 * streamState still holds turn 1's entry (the stale branch's precondition).
 */
async function reachStaleStash(ch: QQChannelClass) {
  const chp = ch as unknown as Record<string, unknown>;
  const orphanBuffer = chp['streamOrphanBuffer'] as Map<
    string,
    { turn: number; text: string; pre?: string }
  >;
  let resolveSend!: (v: MockResponse) => void;
  let rejectSend!: (e: unknown) => void;
  const sendPromise = new Promise<MockResponse>((res, rej) => {
    resolveSend = res;
    rejectSend = rej;
  });

  setReplyMsgId(ch, 'test-chat', 'msg-A');
  onPromptStart(ch, 'test-chat', 's1', 'msg-A');
  onResponseChunk(ch, 'test-chat', 'T1-head ', 's1');
  vi.advanceTimersByTime(2000);
  await drain();

  mockSendQQMessage.mockReturnValueOnce(sendPromise);
  onResponseChunk(ch, 'test-chat', 'T1-tail ', 's1');
  vi.advanceTimersByTime(2000);
  await drain();
  onResponseChunk(ch, 'test-chat', 'T1-resid ', 's1');
  onPromptEnd(ch, 'test-chat', 's1');

  setReplyMsgId(ch, 'test-chat', 'msg-B');
  onPromptStart(ch, 'test-chat', 's1', 'msg-B');
  onResponseChunk(ch, 'test-chat', 'T2-HEAD ', 's1');
  expect(orphanBuffer.get('s1')).toEqual({
    turn: 2,
    text: 'T2-HEAD ',
  });

  return { chp, resolveSend, rejectSend, orphanBuffer };
}

describe('stash ownership regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a mid-turn boundary keeps a live turn's stashed head", async () => {
    const ch = makeChannel();
    const { orphanBuffer } = await reachStashedOrphan(ch);
    expect(orphanBuffer.get('s1')).toEqual({
      turn: 2,
      text: 'T2-HEAD ',
    });

    onResponseBoundary(ch, 'test-chat', 's1');
    // Preserved, and now sealed as the pre-boundary portion: the bridge's
    // collection was cleared, so the head can only come from the stash.
    expect(orphanBuffer.get('s1')).toEqual({
      turn: 2,
      text: 'T2-HEAD ',
      pre: 'T2-HEAD ',
    });

    onResponseChunk(ch, 'test-chat', 'T2-TAIL', 's1');
    vi.advanceTimersByTime(2000);
    await drain();

    expect(sentContents()).toContain('T2-HEAD T2-TAIL');
  });

  it('a cancelled turn still delivers its stashed head at onPromptEnd', async () => {
    const ch = makeChannel();
    const { orphanBuffer, pendingStreamDelete } = await reachStashedOrphan(ch);
    expect(orphanBuffer.get('s1')).toEqual({
      turn: 2,
      text: 'T2-HEAD ',
    });
    const before = mockSendQQMessage.mock.calls.length;

    // ChannelBase skips onResponseComplete on cancel, so onPromptEnd is the
    // only teardown — it must deliver the stashed head, not delete it.
    onPromptEnd(ch, 'test-chat', 's1');
    expect(orphanBuffer.has('s1')).toBe(false);
    expect(pendingStreamDelete.has('s1')).toBe(true);
    vi.advanceTimersByTime(2000);
    await drain();

    expect(mockSendQQMessage.mock.calls.length).toBe(before + 1);
    expect(sentContents().at(-1)).toBe('T2-HEAD ');
  });

  it("does not duplicate the live turn's stashed head when fullText already has it", async () => {
    const ch = makeChannel();
    const { resolveSend } = await reachStaleStash(ch);

    // The bridge accumulates every textChunk and only a responseBoundary
    // clears that collection, so a stash taken after the last boundary is
    // already part of fullText. Prepending it here would send the head twice.
    await onResponseComplete(ch, 'test-chat', 'T2-HEAD T2-REST', 's1');

    const contents = sentContents();
    expect(contents.filter((c) => c === 'T2-HEAD T2-REST')).toHaveLength(1);
    expect(contents.some((c) => c.includes('T2-HEAD T2-HEAD'))).toBe(false);

    resolveSend(mockResponse(true));
    await drain();
  });

  it('prepends the stashed head when a response boundary cleared fullText', async () => {
    const ch = makeChannel();
    const { resolveSend, orphanBuffer } = await reachStaleStash(ch);

    onResponseBoundary(ch, 'test-chat', 's1');
    expect(orphanBuffer.get('s1')!.pre).toBe('T2-HEAD ');

    // The boundary cleared the bridge's collection: production's fullText
    // carries only the post-boundary text, so the head must come from the
    // stash.
    await onResponseComplete(ch, 'test-chat', 'T2-REST', 's1');
    expect(sentContents()).toContain('T2-HEAD T2-REST');

    resolveSend(mockResponse(true));
    await drain();
  });

  it('does not duplicate post-boundary text when the stash spans a boundary', async () => {
    const ch = makeChannel();
    const { resolveSend, orphanBuffer } = await reachStaleStash(ch);
    // Turn 1's chain is still parked, so turn 2's first chunk is stashed in
    // the side buffer under turn 2's ownership.
    expect(orphanBuffer.get('s1')).toEqual({ turn: 2, text: 'T2-HEAD ' });

    onResponseBoundary(ch, 'test-chat', 's1');
    // The boundary seals the head as the pre-boundary portion — the only text
    // the bridge's cleared collection will no longer re-deliver.
    onResponseChunk(ch, 'test-chat', 'T2-POST', 's1');
    // The post-boundary chunk lands in the SAME entry (the parked chain still
    // owns the streamState slot), but it is already part of fullText.
    expect(orphanBuffer.get('s1')).toEqual({
      turn: 2,
      text: 'T2-HEAD T2-POST',
      pre: 'T2-HEAD ',
    });

    // Production-shaped completion: fullText carries only the post-boundary
    // text, so the head comes from the sealed portion while the tail is
    // already in fullText and must not be prepended a second time.
    await onResponseComplete(ch, 'test-chat', 'T2-POST', 's1');

    const contents = sentContents();
    expect(contents.filter((c) => c === 'T2-HEAD T2-POST')).toHaveLength(1);
    expect(contents.some((c) => c.includes('T2-POSTT2-POST'))).toBe(false);

    resolveSend(mockResponse(true));
    await drain();
  });

  it('consumes the stash without prepending on the normal completion path', async () => {
    const ch = makeChannel();
    const { rejectSend } = await reachStaleStash(ch);
    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;

    // Turn 1's parked send fails permanently: the entry and its park are
    // dropped while turn 2's head stays in the side buffer, so completion
    // falls through to the normal path with fullText as the turn's text.
    rejectSend(new DeliveryError('FALLBACK_FAILED', 'permanent failure'));
    await drain();
    expect(streamState(ch).has('s1')).toBe(false);
    expect(pendingStreamDelete.has('s1')).toBe(false);

    await onResponseComplete(ch, 'test-chat', 'T2-HEAD T2-REST', 's1');

    const contents = sentContents();
    expect(contents.filter((c) => c === 'T2-HEAD T2-REST')).toHaveLength(1);
    expect(contents.some((c) => c.includes('T2-HEAD T2-HEAD'))).toBe(false);
  });

  it('prepends the stash on the normal completion path when a boundary cleared fullText', async () => {
    const ch = makeChannel();
    const { rejectSend } = await reachStaleStash(ch);

    onResponseBoundary(ch, 'test-chat', 's1');
    rejectSend(new DeliveryError('FALLBACK_FAILED', 'permanent failure'));
    await drain();

    await onResponseComplete(ch, 'test-chat', 'T2-REST', 's1');
    expect(sentContents()).toContain('T2-HEAD T2-REST');
  });

  it('re-stashes the sealed head when the drained stash send fails permanently', async () => {
    const ch = makeChannel();
    const { orphanBuffer } = await reachStashedOrphan(ch);

    // Seal the head at a response boundary: the bridge cleared its collection,
    // so this sealed portion has no other copy.
    onResponseBoundary(ch, 'test-chat', 's1');
    expect(orphanBuffer.get('s1')!.pre).toBe('T2-HEAD ');

    // The next chunk drains the stash into a fresh entry; that drained send
    // fails permanently, so the buffer (and the sealed head in it) is dropped.
    mockSendQQMessage.mockRejectedValueOnce(
      new DeliveryError('FALLBACK_FAILED', 'permanent failure'),
    );
    onResponseChunk(ch, 'test-chat', 'T2-REST', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(streamState(ch).has('s1')).toBe(false);
    // The failed attempt itself already carries the drained text, so only a
    // send issued AFTER it can prove the sealed head was recovered.
    const failedAttempts = mockSendQQMessage.mock.calls.length;

    // Completion must still recover the sealed head from the re-stash.
    await onResponseComplete(ch, 'test-chat', 'T2-REST', 's1');
    expect(sentContents().slice(failedAttempts)).toContain('T2-HEAD T2-REST');
  });

  it('merges the sealed head into a successor stash when the drained send fails permanently (A2-1)', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<
      string,
      { turn: number; text: string; pre?: string }
    >;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const { resolveSend } = await reachStaleStash(ch);

    // Turn 1's chain settles and frees the entry; turn 2's stash remains.
    resolveSend(mockResponse(true));
    await vi.advanceTimersByTimeAsync(20_000);
    await drain();
    expect(streamState(ch).has('s1')).toBe(false);
    expect(orphanBuffer.get('s1')).toEqual({ turn: 2, text: 'T2-HEAD ' });

    // Seal turn 2's head at a boundary, then drain it into a fresh entry.
    onResponseBoundary(ch, 'test-chat', 's1');
    expect(orphanBuffer.get('s1')!.pre).toBe('T2-HEAD ');
    let rejectDrain!: (e: unknown) => void;
    const drainPromise = new Promise<MockResponse>((_r, rej) => {
      rejectDrain = rej;
    });
    mockSendQQMessage.mockReturnValueOnce(drainPromise);
    onResponseChunk(ch, 'test-chat', 'T2-REST', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    const drainedState = (
      chp['streamState'] as Map<string, { sealedPre?: string }>
    ).get('s1')!;
    expect(drainedState.sealedPre).toBe('T2-HEAD ');

    // A residual buffers behind the in-flight drained send; turn 2 parks.
    onResponseChunk(ch, 'test-chat', 'T2-RESID', 's1');
    onPromptEnd(ch, 'test-chat', 's1');
    expect(pendingStreamDelete.has('s1')).toBe(true);

    // Turn 3 starts and stashes its own head, occupying the stash slot.
    setReplyMsgId(ch, 'test-chat', 'msg-C');
    onPromptStart(ch, 'test-chat', 's1', 'msg-C');
    onResponseChunk(ch, 'test-chat', 'T3-HEAD', 's1');
    expect(orphanBuffer.get('s1')).toEqual({ turn: 3, text: 'T3-HEAD' });

    // The drained send carrying turn 2's sealed head fails permanently. The
    // re-stash must merge into turn 3's stash rather than skip it: skipping
    // drops the sealed head with no other copy (the boundary cleared the
    // bridge's collection, so it is absent from fullText).
    const beforeFailure = sentContents().length;
    rejectDrain(new DeliveryError('FALLBACK_FAILED', 'permanent failure'));
    await drain();
    expect(streamState(ch).has('s1')).toBe(false);
    // The re-stash must have merged into turn 3's stash rather than skipped.
    const mergedStash = orphanBuffer.get('s1');

    // Drive turn 3 to completion: the sealed head must be recovered by a send
    // issued after the failed attempt.
    onResponseChunk(ch, 'test-chat', 'T3-REST', 's1');
    await onResponseComplete(ch, 'test-chat', 'T3-HEADT3-REST', 's1');
    onPromptEnd(ch, 'test-chat', 's1');
    await drain();
    await vi.advanceTimersByTimeAsync(20_000);
    await drain();

    // Count-sensitive: exactly one post-failure send carries the sealed head,
    // and with the failed attempt's single copy that is two overall — so a
    // double delivery cannot pass.
    const afterFailure = sentContents().slice(beforeFailure);
    expect(afterFailure.some((c) => c.includes('T2-HEAD '))).toBe(true);
    expect(afterFailure.filter((c) => c.includes('T2-HEAD '))).toHaveLength(1);
    expect(sentContents().filter((c) => c.includes('T2-HEAD '))).toHaveLength(
      2,
    );
    expect(mergedStash).toEqual({
      turn: 3,
      text: 'T2-HEAD T3-HEAD',
      pre: 'T2-HEAD ',
    });
  });

  it('tags a re-stashed sealed head with the live turn so a successor can consume it', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<
      string,
      { turn: number; text: string; pre?: string }
    >;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const { resolveSend } = await reachStaleStash(ch);

    resolveSend(mockResponse(true));
    await vi.advanceTimersByTimeAsync(20_000);
    await drain();
    expect(streamState(ch).has('s1')).toBe(false);
    expect(orphanBuffer.get('s1')).toEqual({ turn: 2, text: 'T2-HEAD ' });

    // Seal turn 2's head at a boundary, then drain it into a fresh entry.
    onResponseBoundary(ch, 'test-chat', 's1');
    let rejectDrain!: (e: unknown) => void;
    const drainPromise = new Promise<MockResponse>((_r, rej) => {
      rejectDrain = rej;
    });
    mockSendQQMessage.mockReturnValueOnce(drainPromise);
    onResponseChunk(ch, 'test-chat', 'T2-REST', 's1');
    vi.advanceTimersByTime(2000);
    await drain();

    // Turn 2 parks; turn 3 starts and bumps the counter WITHOUT emitting a
    // chunk, so it holds no stash of its own.
    onPromptEnd(ch, 'test-chat', 's1');
    expect(pendingStreamDelete.has('s1')).toBe(true);
    setReplyMsgId(ch, 'test-chat', 'msg-C');
    onPromptStart(ch, 'test-chat', 's1', 'msg-C');

    // Turn 2's send fails permanently. The re-stash must be tagged with the
    // turn that owns the counter (3): every consumer gates on the entry turn
    // matching the live turn, so a doomed tag (2) is dropped as superseded by
    // turn 3's first chunk and the head is lost with no other copy.
    rejectDrain(new DeliveryError('FALLBACK_FAILED', 'permanent failure'));
    await drain();
    expect(streamState(ch).has('s1')).toBe(false);
    expect(orphanBuffer.get('s1')).toEqual({
      turn: 3,
      text: 'T2-HEAD ',
      pre: 'T2-HEAD ',
    });

    // Turn 3's first chunk drains the stash, so its completion delivers the
    // recovered head alongside its own text.
    const before = sentContents().length;
    onResponseChunk(ch, 'test-chat', 'T3-HEAD', 's1');
    await onResponseComplete(ch, 'test-chat', 'T3-HEADT3-REST', 's1');
    onPromptEnd(ch, 'test-chat', 's1');
    await drain();
    await vi.advanceTimersByTimeAsync(20_000);
    await drain();
    expect(
      sentContents()
        .slice(before)
        .some((c) => c.includes('T2-HEAD ')),
    ).toBe(true);
  });

  it("keeps the superseded turn's sealed head with its in-flight flush owner", async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<
      string,
      { turn: number; text: string; pre?: string }
    >;
    await reachStashedOrphan(ch);

    // Seal turn 2's head and drain it into a fresh entry whose send is still
    // in flight, so the entry holds the seal with an empty buffer — and the
    // in-flight payload already carries the sealed head.
    onResponseBoundary(ch, 'test-chat', 's1');
    let settleDrain!: (v: MockResponse) => void;
    const drainPromise = new Promise<MockResponse>((r) => {
      settleDrain = r;
    });
    mockSendQQMessage.mockReturnValueOnce(drainPromise);
    onResponseChunk(ch, 'test-chat', 'T2-REST', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    const drained = (
      chp['streamState'] as Map<string, { sealedPre?: string; buffer: string }>
    ).get('s1')!;
    expect(drained.sealedPre).toBe('T2-HEAD ');
    expect(drained.buffer).toBe('');
    expect(sentContents().at(-1)).toContain('T2-HEAD ');

    // Turn 3 starts and its first chunk finds turn 2's entry superseded. That
    // entry is the session's in-flight flush owner, so the branch must NOT
    // hand the head off again: the flush chain's settle arms decide —
    // its success path clears the seal, its permanent-failure arm re-stashes
    // it — and a second copy in the successor would deliver the head twice.
    setReplyMsgId(ch, 'test-chat', 'msg-C');
    onPromptStart(ch, 'test-chat', 's1', 'msg-C');
    onResponseChunk(ch, 'test-chat', 'T3-HEAD', 's1');

    const successor = (
      chp['streamState'] as Map<string, { buffer: string; sealedPre?: string }>
    ).get('s1')!;
    expect(successor.buffer).toBe('T3-HEAD');
    expect(successor.sealedPre).toBeUndefined();
    expect(orphanBuffer.has('s1')).toBe(false);

    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    settleDrain(mockResponse(true));
    await drain();
    await onResponseComplete(ch, 'test-chat', 'T3-HEADT3-REST', 's1');
    onPromptEnd(ch, 'test-chat', 's1');
    await drain();
    await vi.advanceTimersByTimeAsync(20_000);
    await drain();

    // Single delivery end-to-end: the in-flight turn-2 payload was the one
    // send that carried the head, and the successor must not re-carry it.
    expect(sentContents().filter((c) => c.includes('T2-HEAD '))).toHaveLength(
      1,
    );
  });

  it('re-stashes the sealed head when a superseded in-flight send fails permanently', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<
      string,
      { turn: number; text: string; pre?: string }
    >;
    await reachStashedOrphan(ch);

    // Same shape as the duplicate case: the drained send is in flight
    // with the sealed head in its payload.
    onResponseBoundary(ch, 'test-chat', 's1');
    let rejectDrain!: (e: unknown) => void;
    const drainPromise = new Promise<MockResponse>((_r, rej) => {
      rejectDrain = rej;
    });
    mockSendQQMessage.mockReturnValueOnce(drainPromise);
    onResponseChunk(ch, 'test-chat', 'T2-REST', 's1');
    vi.advanceTimersByTime(2000);
    await drain();

    // Turn 3 supersedes turn 2 while its flush is in flight, so the superseded
    // branch leaves the head with that chain and the successor starts
    // without it.
    setReplyMsgId(ch, 'test-chat', 'msg-C');
    onPromptStart(ch, 'test-chat', 's1', 'msg-C');
    onResponseChunk(ch, 'test-chat', 'T3-HEAD', 's1');
    expect(streamState(ch).get('s1')!.buffer).toBe('T3-HEAD');

    // The in-flight send then fails permanently, so the head never went out.
    // The permanent-failure arm must hand it off even though this state is no
    // longer the session's current entry: the guard alone would leave
    // the head to a chain that can no longer deliver it, and it is lost.
    rejectDrain(new DeliveryError('FALLBACK_FAILED', 'permanent failure'));
    await drain();
    expect(orphanBuffer.get('s1')).toEqual({
      turn: 3,
      text: 'T2-HEAD ',
      pre: 'T2-HEAD ',
    });

    // The successor consumes the re-stash and delivers the head exactly once.
    const failedAttempts = mockSendQQMessage.mock.calls.length;
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await onResponseComplete(ch, 'test-chat', 'T3-HEADT3-REST', 's1');
    onPromptEnd(ch, 'test-chat', 's1');
    await drain();
    await vi.advanceTimersByTimeAsync(20_000);
    await drain();

    expect(
      sentContents()
        .slice(failedAttempts)
        .filter((c) => c.includes('T2-HEAD ')),
    ).toHaveLength(1);
  });

  it('re-stashes the sealed head when a superseded in-flight send fails transiently', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<
      string,
      { turn: number; text: string; pre?: string }
    >;
    await reachStashedOrphan(ch);

    // Same shape as the permanent case: the drained send is in flight
    // carrying the sealed head in its payload.
    onResponseBoundary(ch, 'test-chat', 's1');
    let rejectDrain!: (e: unknown) => void;
    const drainPromise = new Promise<MockResponse>((_r, rej) => {
      rejectDrain = rej;
    });
    mockSendQQMessage.mockReturnValueOnce(drainPromise);
    onResponseChunk(ch, 'test-chat', 'T2-REST', 's1');
    vi.advanceTimersByTime(2000);
    await drain();

    // Turn 3 supersedes turn 2 while its flush is in flight, so the superseded
    // branch leaves the head with that chain and the successor starts
    // without it.
    setReplyMsgId(ch, 'test-chat', 'msg-C');
    onPromptStart(ch, 'test-chat', 's1', 'msg-C');
    onResponseChunk(ch, 'test-chat', 'T3-HEAD', 's1');
    expect(streamState(ch).get('s1')!.buffer).toBe('T3-HEAD');

    // The in-flight send then fails TRANSIENTLY, so it takes the retry arm's
    // superseded branch rather than the permanent arm: no retry is scheduled
    // for turn 2's state and nothing will ever settle for it, so that branch
    // must hand the sealed head off or it is silently lost.
    rejectDrain(new Error('transient'));
    await drain();
    expect(orphanBuffer.get('s1')).toEqual({
      turn: 3,
      text: 'T2-HEAD ',
      pre: 'T2-HEAD ',
    });

    // The successor consumes the re-stash and delivers the head exactly once.
    const failedAttempts = mockSendQQMessage.mock.calls.length;
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await onResponseComplete(ch, 'test-chat', 'T3-HEADT3-REST', 's1');
    onPromptEnd(ch, 'test-chat', 's1');
    await drain();
    await vi.advanceTimersByTimeAsync(20_000);
    await drain();

    expect(
      sentContents()
        .slice(failedAttempts)
        .filter((c) => c.includes('T2-HEAD ')),
    ).toHaveLength(1);
  });

  it('re-stashes the sealed head when a superseded in-flight state has no msgId', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<
      string,
      { turn: number; text: string; pre?: string }
    >;
    await reachStashedOrphan(ch);

    // Turn 2's session anchor ages past its 5-minute TTL while the turn is
    // parked, so the fresh entry that drains the sealed head is built without
    // one (createStreamState's TTL fallback); a proactive turn reaches the
    // same shape. The head is still sealed on that entry.
    const ttl = (QQChannel as unknown as { REPLY_MSG_ID_TTL_MS: number })
      .REPLY_MSG_ID_TTL_MS;
    const anchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    anchors.get('s1')!.timestamp = Date.now() - ttl - 1000;

    onResponseBoundary(ch, 'test-chat', 's1');
    let rejectDrain!: (e: unknown) => void;
    const drainPromise = new Promise<MockResponse>((_r, rej) => {
      rejectDrain = rej;
    });
    mockSendQQMessage.mockReturnValueOnce(drainPromise);
    onResponseChunk(ch, 'test-chat', 'T2-REST', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    const drained = (
      chp['streamState'] as Map<
        string,
        { sealedPre?: string; msgId?: string; buffer: string }
      >
    ).get('s1')!;
    expect(drained.sealedPre).toBe('T2-HEAD ');
    expect(drained.msgId).toBeUndefined();
    expect(sentContents().at(-1)).toContain('T2-HEAD ');

    // Turn 3 supersedes turn 2 while that send is in flight, so the superseded
    // branch leaves the head with its in-flight owner.
    setReplyMsgId(ch, 'test-chat', 'msg-C');
    onPromptStart(ch, 'test-chat', 's1', 'msg-C');
    onResponseChunk(ch, 'test-chat', 'T3-HEAD', 's1');
    expect(streamState(ch).get('s1')!.buffer).toBe('T3-HEAD');

    // The send then fails transiently with no retry scheduled for turn 2's
    // state. The head must still be handed off even though that state carries
    // no msgId: gating the handoff on msgId drops it silently.
    rejectDrain(new Error('transient'));
    await drain();
    expect(orphanBuffer.get('s1')).toEqual({
      turn: 3,
      text: 'T2-HEAD ',
      pre: 'T2-HEAD ',
    });

    // The successor consumes the re-stash and delivers the head exactly once.
    const failedAttempts = mockSendQQMessage.mock.calls.length;
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await onResponseComplete(ch, 'test-chat', 'T3-HEADT3-REST', 's1');
    onPromptEnd(ch, 'test-chat', 's1');
    await drain();
    await vi.advanceTimersByTimeAsync(20_000);
    await drain();

    expect(
      sentContents()
        .slice(failedAttempts)
        .filter((c) => c.includes('T2-HEAD ')),
    ).toHaveLength(1);
  });

  it('delivers the sealed head when the superseded successor ended by cancel', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<
      string,
      { turn: number; text: string; pre?: string }
    >;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    await reachStashedOrphan(ch);

    // Turn 2's drained send is in flight carrying the sealed head.
    onResponseBoundary(ch, 'test-chat', 's1');
    let rejectDrain!: (e: unknown) => void;
    const drainPromise = new Promise<MockResponse>((_r, rej) => {
      rejectDrain = rej;
    });
    mockSendQQMessage.mockReturnValueOnce(drainPromise);
    onResponseChunk(ch, 'test-chat', 'T2-REST', 's1');
    vi.advanceTimersByTime(2000);
    await drain();

    // Turn 3 supersedes turn 2 while that send is in flight, so the superseded
    // branch leaves the head with its in-flight owner.
    setReplyMsgId(ch, 'test-chat', 'msg-C');
    onPromptStart(ch, 'test-chat', 's1', 'msg-C');
    onResponseChunk(ch, 'test-chat', 'T3-HEAD', 's1');
    expect(streamState(ch).get('s1')!.buffer).toBe('T3-HEAD');

    // Turn 3 then ends by CANCEL: onPromptEnd parks the session while the marker
    // is live, and no onResponseComplete ever runs for turn 3, so a re-stash
    // tagged with turn 3 has no reader — the next onPromptStart drops it.
    onPromptEnd(ch, 'test-chat', 's1');
    expect(pendingStreamDelete.has('s1')).toBe(true);
    expect(streamState(ch).get('s1')!.turn).toBe(3);

    // The in-flight send now fails TRANSIENTLY. The head must be delivered on
    // turn 2's own anchor instead of being re-stashed under the dead turn.
    const failedAttempts = mockSendQQMessage.mock.calls.length;
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    rejectDrain(new Error('transient'));
    await drain();
    await vi.advanceTimersByTimeAsync(20_000);
    await drain();

    expect(
      sentContents()
        .slice(failedAttempts)
        .filter((c) => c.includes('T2-HEAD ')),
    ).toHaveLength(1);
    expect(orphanBuffer.has('s1')).toBe(false);
  });

  it('does not re-deliver a sealed head a successful flush already carried', async () => {
    const ch = makeChannel();
    const { orphanBuffer } = await reachStashedOrphan(ch);

    // Seal the head at a boundary, then drain it into a fresh entry.
    onResponseBoundary(ch, 'test-chat', 's1');
    expect(orphanBuffer.get('s1')!.pre).toBe('T2-HEAD ');
    let resolveS1!: (v: MockResponse) => void;
    const s1 = new Promise<MockResponse>((r) => {
      resolveS1 = r;
    });
    mockSendQQMessage.mockReturnValueOnce(s1);
    onResponseChunk(ch, 'test-chat', 'T2-REST', 's1');
    vi.advanceTimersByTime(2000);
    await drain();

    // A residual arrives while S1 is in flight; S1 then SUCCEEDS, delivering
    // 'T2-HEAD T2-REST' — the sealed head is now on the user's screen.
    onResponseChunk(ch, 'test-chat', 'T2-TAIL', 's1');
    resolveS1(mockResponse(true));
    await drain();
    expect(sentContents()).toContain('T2-HEAD T2-REST');
    expect(sentContents().filter((c) => c.includes('T2-HEAD'))).toHaveLength(1);

    // The residual flush now fails permanently. The sealed head was already
    // delivered by S1, so the re-stash must not re-seal it.
    mockSendQQMessage.mockRejectedValueOnce(
      new DeliveryError('FALLBACK_FAILED', 'permanent failure'),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    // Completion: with the head already delivered, it must not be prepended
    // again and sent as a second, standalone copy.
    await onResponseComplete(ch, 'test-chat', 'T2-RESTT2-TAIL', 's1');

    expect(sentContents().filter((c) => c.includes('T2-HEAD'))).toEqual([
      'T2-HEAD T2-REST',
    ]);
  });

  it('re-stashes the sealed head when a transient send exhausts its retries (exhaustion)', async () => {
    const ch = makeChannel();
    await reachStashedOrphan(ch);
    onResponseBoundary(ch, 'test-chat', 's1');
    onResponseChunk(ch, 'test-chat', 'T2-REST', 's1');

    // The drained send and both retries (2000 ms, then the 4000 ms backoff)
    // fail transiently, exhausting maxFlushRetries. No park flag is armed, so
    // no successor exists and the head must be re-stashed for completion.
    mockSendQQMessage.mockRejectedValue(new Error('transient'));
    vi.advanceTimersByTime(2000);
    await drain();
    vi.advanceTimersByTime(2000);
    await drain();
    vi.advanceTimersByTime(4000);
    await drain();
    expect(streamState(ch).has('s1')).toBe(false);

    const failedAttempts = mockSendQQMessage.mock.calls.length;
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await onResponseComplete(ch, 'test-chat', 'T2-REST', 's1');
    expect(sentContents().slice(failedAttempts)).toContain('T2-HEAD T2-REST');
  });

  it('re-stashes the sealed head when an over-limit transient send exhausts its retries (exhaustion)', async () => {
    const ch = makeChannel({ bufferFlushLength: 15 });
    await reachStashedOrphan(ch);
    onResponseBoundary(ch, 'test-chat', 's1');
    // The 15-char limit leaves the 8-char stashed head intact but makes the
    // drained 15-char text flush immediately, and each failure re-buffers it
    // at the limit to reach the over-limit branch.
    onResponseChunk(ch, 'test-chat', 'T2-REST', 's1');

    mockSendQQMessage.mockRejectedValue(new Error('transient'));
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(8000);
      await drain();
    }
    expect(streamState(ch).has('s1')).toBe(false);

    const failedAttempts = mockSendQQMessage.mock.calls.length;
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await onResponseComplete(ch, 'test-chat', 'T2-REST', 's1');
    expect(sentContents().slice(failedAttempts)).toContain('T2-HEAD T2-REST');
  });

  it('delivers the sealed head on the parked turn when no successor can consume it (parked terminal)', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    await reachStashedOrphan(ch);
    onResponseBoundary(ch, 'test-chat', 's1');

    // Production shape: the drained send is still in flight when completion
    // arrives, so onResponseComplete parks the session and returns; onPromptEnd
    // then returns on the park flag, handing the teardown to this chain.
    let rejectDrain!: (e: unknown) => void;
    const drainPromise = new Promise<MockResponse>((_r, rej) => {
      rejectDrain = rej;
    });
    mockSendQQMessage.mockReturnValueOnce(drainPromise);
    onResponseChunk(ch, 'test-chat', 'T2-REST', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    await onResponseComplete(ch, 'test-chat', 'T2-REST', 's1');
    onPromptEnd(ch, 'test-chat', 's1');
    expect(pendingStreamDelete.has('s1')).toBe(true);

    // The parked turn still owns the counter and no successor exists, so a
    // re-stash would be discarded as superseded by the same block that clears
    // the park flag and the turn counter. The failure must therefore deliver
    // the sealed head on this turn's own anchor (the direct-delivery arm).
    const before = mockSendQQMessage.mock.calls.length;
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    rejectDrain(new DeliveryError('FALLBACK_FAILED', 'permanent failure'));
    await drain();
    expect(streamState(ch).has('s1')).toBe(false);

    expect(sentContents().slice(before)).toContain('T2-HEAD ');
  });

  it('delivers the sealed head when a parked turn exhausts its transient retries (parked exhaustion)', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const completedTurns = chp['completedTurns'] as Map<string, number>;
    await reachStashedOrphan(ch);
    onResponseBoundary(ch, 'test-chat', 's1');

    // Same production shape as the parked-permanent case: the drained send is
    // still in flight when completion arrives, so the session parks and
    // onPromptEnd hands the teardown to this chain.
    let rejectDrain!: (e: unknown) => void;
    const drainPromise = new Promise<MockResponse>((_r, rej) => {
      rejectDrain = rej;
    });
    mockSendQQMessage.mockReturnValueOnce(drainPromise);
    onResponseChunk(ch, 'test-chat', 'T2-REST', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    await onResponseComplete(ch, 'test-chat', 'T2-REST', 's1');
    onPromptEnd(ch, 'test-chat', 's1');
    expect(pendingStreamDelete.has('s1')).toBe(true);

    // A transient failure retries rather than settling, and this branch clears
    // the park flag before it can exhaust — so the handoff has to be told the
    // turn is over explicitly, or it would re-stash into the turn counter this
    // same block drops and the head would be discarded as superseded. The two
    // retries fail; the direct delivery that follows the exhaustion succeeds.
    let transientFailures = 0;
    mockSendQQMessage.mockImplementation(() => {
      transientFailures++;
      return transientFailures <= 2
        ? Promise.reject(new Error('transient network failure'))
        : Promise.resolve(mockResponse(true));
    });
    const before = mockSendQQMessage.mock.calls.length;
    rejectDrain(new Error('transient network failure'));
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(8000);
      await drain();
    }
    expect(streamState(ch).has('s1')).toBe(false);

    expect(sentContents().slice(before)).toContain('T2-HEAD ');
    // Retry exhaustion abandons the turn, so its completion record must go
    // with the counter; a later turn reusing the number must not alias it.
    expect(completedTurns.has('s1')).toBe(false);
  });

  it("delivers a cancelled turn's stashed head before the park early-return", async () => {
    const ch = makeChannel();
    const { resolveSend, orphanBuffer, chp } = await reachStaleStash(ch);
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;

    expect(orphanBuffer.get('s1')).toEqual({
      turn: 2,
      text: 'T2-HEAD ',
    });
    expect(pendingStreamDelete.has('s1')).toBe(true);

    // ChannelBase skips onResponseComplete on cancel, so onPromptEnd is the
    // only teardown — it must service turn 2's stash before the park
    // early-return hands the session to turn 1's deferred chain.
    onPromptEnd(ch, 'test-chat', 's1');
    expect(orphanBuffer.has('s1')).toBe(false);

    resolveSend(mockResponse(true));
    await vi.advanceTimersByTimeAsync(20_000);
    await drain();

    // Count-sensitive: the cancelled turn's head goes out exactly once as its
    // own message, so a double delivery cannot pass.
    expect(sentContents().filter((c) => c === 'T2-HEAD ')).toHaveLength(1);
  });

  it("deliverCancelledStash's anchored send is protected by the in-flight guard", async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;
    const { resolveSend } = await reachStaleStash(ch);

    // Make the counter observably non-default so a reset is visible.
    seqMap.set('msg-B', 4);

    // Expire the token: the cancelled-stash send suspends in resolveRoute.
    let releaseToken!: () => void;
    const gate = new Promise<void>((r) => {
      releaseToken = r;
    });
    chp['tokenExpiresAt'] = Date.now() - 1;
    mockFetchAccessToken.mockImplementation(async () => {
      await gate;
      return { accessToken: 'test-token', expiresIn: 7200 };
    });

    // Cancel turn 2: the pre-park block fires deliverCancelledStash.
    onPromptEnd(ch, 'test-chat', 's1');
    await drain();
    expect(seqMap.has('msg-B')).toBe(true);

    // Successor turn starts on the same session; chat-level entry moved on.
    setReplyMsgId(ch, 'test-chat', 'msg-C');
    onPromptStart(ch, 'test-chat', 's1', 'msg-C');

    // The in-flight send's counter must still be protected.
    expect(seqMap.has('msg-B')).toBe(true);

    releaseToken();
    await drain();
    const stashBody = sentBodies().find(
      (b) =>
        (b['markdown'] as { content?: string } | undefined)?.content ===
        'T2-HEAD ',
    )!;
    // The suspended send keeps the sequence it would have had (4 + 1), rather
    // than resetting to 1.
    expect(stashBody['msg_seq']).toBe(5);
    // Anchor correctness: the cancelled turn's own anchor (msg-B), not the
    // predecessor's (msg-A).
    expect(stashBody['msg_id']).toBe('msg-B');

    resolveSend(mockResponse(true));
    await vi.advanceTimersByTimeAsync(20_000);
    await drain();
  });

  it("services a successor's park armed against a superseded chain's marker", async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Map<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;

    // Turn 1's first flush is live and owns the session's flush marker.
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    let resolveSend!: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValueOnce(sendPromise);
    onResponseChunk(ch, 'test-chat', 'T1-head ', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(flushingSessions.has('s1')).toBe(true);

    // Turn 2 supersedes turn 1's entry and ends with a buffered residual
    // while turn 1's marker is still live, so onPromptEnd parks it against
    // that foreign marker.
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    onResponseChunk(ch, 'test-chat', 'T2-RESID', 's1');
    onPromptEnd(ch, 'test-chat', 's1');
    expect(pendingStreamDelete.has('s1')).toBe(true);
    expect(streamState(ch).get('s1')!.buffer).toBe('T2-RESID');

    // A reconnect retires the generation turn 2's idle timer was armed under,
    // so only turn 1's settle can deliver the residual.
    chp['_reconnectId'] = (chp['_reconnectId'] as number) + 1;

    resolveSend(mockResponse(true));
    await drain();
    expect(flushingSessions.has('s1')).toBe(false);

    // The foreign chain's .finally() must hand the parked residual to a fresh
    // idle timer, keeping the park armed for the re-flush's own settle.
    expect(pendingStreamDelete.has('s1')).toBe(true);
    vi.advanceTimersByTime(2000);
    await drain();
    expect(sentContents()).toContain('T2-RESID');
  });

  it('reclaims the parked anchor in the empty-buffer hand-off teardown', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Map<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const completedTurns = chp['completedTurns'] as Map<string, number>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const seqMap = chp['msgSeqMap'] as Map<string, number>;

    // Turn 1's tail send is suspended and owns the session's flush marker.
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    let resolveSend!: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValueOnce(sendPromise);
    onResponseChunk(ch, 'test-chat', 'T1-head ', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(flushingSessions.has('s1')).toBe(true);

    // Turn 1's prompt has not ended, so nothing is parked yet. Turn 2
    // supersedes the entry with an empty-buffer one (the only public-API shape
    // that reaches this defensive branch), then parks it by ending while turn
    // 1's marker is still live. No chat-level reply anchor is set for turn 2,
    // so the msg_seq cascade is observable.
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    onResponseChunk(ch, 'test-chat', '', 's1');
    // Turn 2's completion has run and recorded its turn; onPromptStart already
    // cleared the record for the turn bump, so re-seed it to model the
    // completed turn whose empty-buffer teardown the chain must settle.
    completedTurns.set('s1', 2);
    onPromptEnd(ch, 'test-chat', 's1');
    expect(pendingStreamDelete.has('s1')).toBe(true);
    expect(streamState(ch).get('s1')!.buffer).toBe('');
    seqMap.set('msg-B', 3);

    // Turn 1 settles: the hand-off sees a parked entry with no residual and
    // runs the terminal teardown, which owes the parked turn an
    // identity-gated anchor release.
    resolveSend(mockResponse(true));
    await drain();

    expect(streamState(ch).has('s1')).toBe(false);
    expect(pendingStreamDelete.has('s1')).toBe(false);
    expect(sessionAnchors.has('s1')).toBe(false);
    // The release ran after the timer was cleared: had the armed idle timer
    // still been visible, the release guard would have kept the counter.
    expect(seqMap.has('msg-B')).toBe(false);
    // The empty-buffer parked settle drops the completed turn's record too.
    expect(completedTurns.has('s1')).toBe(false);
  });

  it('the parked self-heal does not postpone a live idle timer', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;

    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    let resolveSend!: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValueOnce(sendPromise);
    onResponseChunk(ch, 'test-chat', 'T1-head ', 's1');
    vi.advanceTimersByTime(2000);
    await drain();

    onResponseChunk(ch, 'test-chat', 'T1-resid ', 's1');
    await onResponseComplete(ch, 'test-chat', 'T1-head T1-resid', 's1');
    resolveSend(mockResponse(true));
    await drain();

    // The settle re-armed a live idle timer for the parked residual.
    const parked = streamState(ch).get('s1')!;
    expect(pendingStreamDelete.has('s1')).toBe(true);
    expect(parked.buffer).toBe('T1-resid ');
    expect(parked.timer).not.toBeNull();

    // A successor streams inside that window: the self-heal must leave the
    // live handle alone, or the residual's deadline is pushed out for as long
    // as the successor keeps producing chunks.
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    vi.advanceTimersByTime(1000);
    onResponseChunk(ch, 'test-chat', 'T2-1', 's1');
    vi.advanceTimersByTime(1000);
    await drain();

    expect(sentContents()).toContain('T1-resid ');
  });

  it('a response boundary preserves a parked residual instead of destroying it', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;

    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    let resolveSend!: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValueOnce(sendPromise);
    onResponseChunk(ch, 'test-chat', 'T1-head ', 's1');
    vi.advanceTimersByTime(2000);
    await drain();

    onResponseChunk(ch, 'test-chat', 'T1-resid ', 's1');
    await onResponseComplete(ch, 'test-chat', 'T1-head T1-resid', 's1');
    resolveSend(mockResponse(true));
    await drain();

    // Parked for teardown, residual buffered, live idle timer, marker free.
    expect(pendingStreamDelete.has('s1')).toBe(true);
    expect(streamState(ch).get('s1')!.buffer).toBe('T1-resid ');

    // The successor's head is diverted to the side buffer.
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    onResponseChunk(ch, 'test-chat', 'T2-1', 's1');

    // A mid-turn boundary arrives while the turn is parked: it must keep the
    // entry and its park (and re-arm the idle timer), not delete the residual
    // that no other path can re-deliver.
    onResponseBoundary(ch, 'test-chat', 's1');
    expect(streamState(ch).has('s1')).toBe(true);
    expect(pendingStreamDelete.has('s1')).toBe(true);

    vi.advanceTimersByTime(2000);
    await drain();
    expect(sentContents()).toContain('T1-resid ');
  });

  it('re-arms a parked residual whose idle timer a reconnect retired (Fix D)', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;

    // Park a residual with a live idle timer: the head send is suspended,
    // onResponseComplete parks the turn, and the residual arrives behind it.
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    let resolveSend!: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValueOnce(sendPromise);
    onResponseChunk(ch, 'test-chat', 'T1-head ', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    onResponseChunk(ch, 'test-chat', 'T1-resid ', 's1');
    await onResponseComplete(ch, 'test-chat', 'T1-head T1-resid', 's1');
    resolveSend(mockResponse(true));
    await drain();

    const parked = streamState(ch).get('s1')!;
    expect(pendingStreamDelete.has('s1')).toBe(true);
    expect(parked.buffer).toBe('T1-resid ');
    expect(parked.timer).not.toBeNull();
    expect(
      (parked as unknown as { timerReconnectId?: number }).timerReconnectId,
    ).toBe(chp['_reconnectId']);

    // A state-preserving generation bump (re-entrant connect) retires that
    // timer. No further chunk arrives, so without the re-arm the residual is
    // stranded and the park stays armed forever.
    chp['_reconnectId'] = (chp['_reconnectId'] as number) + 1;

    vi.advanceTimersByTime(2000); // the old-generation timer fires
    await drain();
    // Exactly one live timer — the re-armed one. The retired generation's
    // handle is gone, so a leak or a missing re-arm would change this count.
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(2000); // the re-armed timer fires
    await drain();

    expect(sentContents()).toContain('T1-resid ');
    expect(pendingStreamDelete.has('s1')).toBe(false);
    expect(streamState(ch).has('s1')).toBe(false);
  });

  it('a stale-drop does not release the in-flight flush marker, so no second send starts', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;

    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'T1-head ', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);

    let resolveSend!: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValueOnce(sendPromise);
    onResponseChunk(ch, 'test-chat', 'T1-tail ', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(2); // tail send live
    onPromptEnd(ch, 'test-chat', 's1');
    expect(pendingStreamDelete.has('s1')).toBe(true);

    // Turn 2 starts; its first chunk supersedes turn 1's parked entry.
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    onResponseChunk(ch, 'test-chat', 'T2-head ', 's1');

    // Turn 2's idle window elapses while turn 1's tail is still unresolved:
    // the ownership-keyed marker must block a second concurrent send.
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);

    resolveSend(mockResponse(true));
    await drain();
    vi.advanceTimersByTime(2000);
    await drain();
  });

  it("a superseded turn's permanent failure leaves the successor's park flag intact", async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;

    // Turn 1 head delivers; its tail send is suspended and will fail
    // permanently.
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'T1-head ', 's1');
    vi.advanceTimersByTime(2000);
    await drain();

    let rejectSend!: (e: unknown) => void;
    const sendPromise = new Promise<MockResponse>((_r, rej) => {
      rejectSend = rej;
    });
    mockSendQQMessage.mockReturnValueOnce(sendPromise);
    onResponseChunk(ch, 'test-chat', 'T1-tail ', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    onPromptEnd(ch, 'test-chat', 's1'); // parks turn 1
    expect(pendingStreamDelete.has('s1')).toBe(true);

    // Turn 2 supersedes turn 1's entry, then parks its own residual while
    // turn 1's tail is still in flight.
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    onResponseChunk(ch, 'test-chat', 'T2-text', 's1');
    await onResponseComplete(ch, 'test-chat', 'T2-text', 's1');
    expect(pendingStreamDelete.has('s1')).toBe(true); // turn 2's park

    // Turn 1's tail now fails permanently. Its .catch() must not consume
    // turn 2's park flag.
    rejectSend(new DeliveryError('FALLBACK_FAILED', 'permanent failure'));
    await drain();

    expect(pendingStreamDelete.has('s1')).toBe(true);
  });

  it("a superseded turn's transient failure leaves the successor's park flag and delivery intact", async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;

    // Turn 1 head delivers; its tail send is suspended and will reject with a
    // TRANSIENT DeliveryError (RATE_LIMITED is not one of the permanent
    // codes), so this exercises the non-permanent .catch() settle block.
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'T1-head ', 's1');
    vi.advanceTimersByTime(2000);
    await drain();

    let rejectSend!: (e: unknown) => void;
    const sendPromise = new Promise<MockResponse>((_r, rej) => {
      rejectSend = rej;
    });
    mockSendQQMessage.mockReturnValueOnce(sendPromise);
    onResponseChunk(ch, 'test-chat', 'T1-tail ', 's1');
    vi.advanceTimersByTime(2000);
    await drain();
    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    onPromptEnd(ch, 'test-chat', 's1'); // parks turn 1

    // Turn 2 supersedes turn 1's entry, then ends with a buffered residual
    // while turn 1's tail is still in flight: its park flag is armed and its
    // idle timer stays scheduled, so it can deliver once the marker clears.
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    onResponseChunk(ch, 'test-chat', 'T2-TAIL', 's1');
    onPromptEnd(ch, 'test-chat', 's1');
    expect(pendingStreamDelete.has('s1')).toBe(true); // turn 2's park

    // Turn 1's tail fails transiently. The transient settle must not consume
    // turn 2's park flag before the ownership check.
    rejectSend(new DeliveryError('RATE_LIMITED', 'rate limited'));
    await drain();
    expect(pendingStreamDelete.has('s1')).toBe(true);

    // Turn 2's residual is still delivered once its timers elapse.
    await vi.advanceTimersByTimeAsync(120_000);
    await drain();
    expect(sentContents()).toContain('T2-TAIL');
  });
});

// The boundary must seal the live turn's buffer-resident prefix, not
// only the text diverted through streamOrphanBuffer.
describe('boundary seal for buffer-resident text', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a permanent flush failure after a boundary still delivers the pre-boundary prefix', async () => {
    const ch = makeChannel();
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    // Text enters state.buffer straight from onResponseChunk (NOT via the
    // orphan stash), then a mid-turn boundary clears the bridge's collection.
    onResponseChunk(ch, 'test-chat', 'PRE-', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');

    // The re-armed idle flush fails permanently.
    mockSendQQMessage.mockRejectedValueOnce(
      new DeliveryError('RETRY_EXHAUSTED', 'permanent failure'),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    // The turn continues and completes with only the post-boundary text in
    // fullText, so the prefix has no other copy.
    onResponseChunk(ch, 'test-chat', 'POST', 's1');
    await onResponseComplete(ch, 'test-chat', 'POST', 's1');
    await drain();

    // Delivered final body must still carry the pre-boundary prefix.
    expect(sentContents().at(-1)).toBe('PRE-POST');
  });
});

describe('an in-flight flush must not clear a newer seal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-delivers a boundary seal written while an older flush was in flight', async () => {
    const ch = makeChannel();
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    // HEAD goes out under a send that stays pending.
    let resolveHead!: (v: MockResponse) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((resolve) => {
        resolveHead = resolve;
      }),
    );
    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    vi.advanceTimersByTime(2000);
    await drain();

    // More text arrives while HEAD is in flight, and a mid-turn boundary seals
    // it: this seal describes the RESIDUAL, not the payload already in the air.
    onResponseChunk(ch, 'test-chat', 'B', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');

    // HEAD succeeds. Its success path may only clear the seal it carried.
    resolveHead(mockResponse(true));
    await drain();

    // The residual's own flush now fails permanently. The seal is the only
    // copy (the boundary cleared the bridge's collection), so it must be
    // re-stashed and re-delivered rather than dropped with the entry.
    mockSendQQMessage.mockRejectedValueOnce(
      new DeliveryError('RETRY_EXHAUSTED', 'permanent failure'),
    );
    vi.advanceTimersByTime(2000);
    await drain();
    await onResponseComplete(ch, 'test-chat', 'B', 's1');
    await drain();

    // Three attempts: HEAD, the residual that was rejected, and the re-stash
    // that delivers it. Two would mean the sealed residual was silently lost.
    expect(sentContents()).toEqual(['HEAD', 'B', 'B']);
  });

  it('recovers a head an in-flight send carried when a later boundary re-sealed', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const stateMap = chp['streamState'] as Map<string, { sealedPre?: string }>;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    // HEAD buffers and boundary 1 seals it before the idle flush takes it.
    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    expect(stateMap.get('s1')!.sealedPre).toBe('HEAD');

    // The idle flush sends HEAD with that seal and stays pending.
    let rejectHead!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectHead = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();
    expect(stateMap.get('s1')!.sealedPre).toBe('HEAD');

    // New text buffers while HEAD is in flight and boundary 2 seals it: the
    // state's seal now describes the residual 'B', but the seal HEAD actually
    // carried is still the only copy of the opening.
    onResponseChunk(ch, 'test-chat', 'B', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    expect(stateMap.get('s1')!.sealedPre).toBe('B');

    // The in-flight HEAD send fails permanently and the entry is dropped.
    rejectHead(new DeliveryError('RETRY_EXHAUSTED', 'permanent failure'));
    await drain();
    expect(stateMap.has('s1')).toBe(false);

    // Both seals have no other copy: the next send must carry the opening too.
    await onResponseComplete(ch, 'test-chat', '', 's1');
    expect(sentContents().at(-1)).toBe('HEADB');
  });

  it('widens the carried seal when a transient failure re-buffers the payload', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const stateMap = chp['streamState'] as Map<string, { sealedPre?: string }>;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    // HEAD buffers and boundary 1 seals it before the idle flush takes it.
    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');

    // The idle flush sends HEAD with that seal and stays pending.
    let rejectHead!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectHead = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    // New text buffers while HEAD is in flight and boundary 2 re-seals it.
    onResponseChunk(ch, 'test-chat', 'B', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    expect(stateMap.get('s1')!.sealedPre).toBe('B');

    // A TRANSIENT failure re-buffers 'HEAD' in front of 'B'. Every later
    // give-up site is called without a carried seal, so the seal itself must
    // widen to cover the payload again or the retry exhausts carrying only 'B'.
    mockSendQQMessage.mockRejectedValue(new Error('transient'));
    rejectHead(new Error('transient'));
    await drain();
    expect(stateMap.get('s1')!.sealedPre).toBe('HEADB');

    // Retries exhaust; the re-stash then carries the widened seal.
    await vi.advanceTimersByTimeAsync(60_000);
    await drain();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await onResponseComplete(ch, 'test-chat', '', 's1');
    await drain();
    expect(sentContents().at(-1)).toBe('HEADB');
  });

  it('widens the carried seal when a parked turn re-buffers a transient failure', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    let rejectHead!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectHead = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    onResponseChunk(ch, 'test-chat', 'B', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');

    // The turn ends while HEAD is in flight, so the rejection takes the
    // parked-branch re-buffer.
    onPromptEnd(ch, 'test-chat', 's1');
    expect(pendingStreamDelete.has('s1')).toBe(true);

    // The retries fail transiently; exhaustion hands the seal off with no
    // carried seal, so only the widened value can still deliver the head.
    let failures = 0;
    mockSendQQMessage.mockImplementation(() => {
      failures++;
      return failures <= 2
        ? Promise.reject(new Error('transient'))
        : Promise.resolve(mockResponse(true));
    });
    rejectHead(new Error('transient'));
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(8000);
      await drain();
    }
    expect(sentContents().at(-1)).toBe('HEADB');
  });

  it('re-seals the whole payload a boundary cleared while a transient send was in flight', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const stateMap = chp['streamState'] as Map<string, { sealedPre?: string }>;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    // 'HEAD' buffers and boundary 1 seals it.
    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');

    // 'B' arrives AFTER the boundary, so the idle drain sends the WIDER payload
    // 'HEADB' while carrying only the seal 'HEAD'.
    onResponseChunk(ch, 'test-chat', 'B', 's1');
    let rejectHead!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectHead = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    // 'C' arrives and boundary 2 clears the collection, so 'B' — which rode
    // the in-flight payload — is absent from fullText too, not just 'HEAD'.
    onResponseChunk(ch, 'test-chat', 'C', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    expect(stateMap.get('s1')!.sealedPre).toBe('C');

    mockSendQQMessage.mockRejectedValue(new Error('transient'));
    rejectHead(new Error('transient'));
    await drain();
    expect(stateMap.get('s1')!.sealedPre).toBe('HEADBC');

    // Retries exhaust; the re-stash must carry the whole payload exactly once.
    await vi.advanceTimersByTimeAsync(60_000);
    await drain();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await onResponseComplete(ch, 'test-chat', '', 's1');
    await drain();
    expect(sentContents().at(-1)).toBe('HEADBC');
  });

  it('re-seals a residual whose text repeats the carried seal', async () => {
    const ch = makeChannel({ maxFlushRetries: 2 });
    const chp = ch as unknown as Record<string, unknown>;
    const stateMap = chp['streamState'] as Map<string, { sealedPre?: string }>;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    // 'HEAD' buffers and boundary 1 seals it.
    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');

    // The idle drain sends 'HEAD' carrying the seal 'HEAD' and stays pending.
    let rejectHead!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectHead = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    // A residual that repeats the head text EXACTLY, sealed by boundary 2. The
    // residual is new text, so a string comparison against the carried seal
    // must not be what decides whether it is appended.
    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    expect(stateMap.get('s1')!.sealedPre).toBe('HEAD');

    mockSendQQMessage.mockRejectedValue(new Error('transient'));
    rejectHead(new Error('transient'));
    await drain();
    expect(stateMap.get('s1')!.sealedPre).toBe('HEADHEAD');

    await vi.advanceTimersByTimeAsync(60_000);
    await drain();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await onResponseComplete(ch, 'test-chat', '', 's1');
    await drain();
    // The whole collected text, exactly once — not just the failed payload.
    expect(sentContents().at(-1)).toBe('HEADHEAD');
  });

  it('keeps a residual seal that repeats the carried seal when the head send succeeds', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const stateMap = chp['streamState'] as Map<
      string,
      { sealedPre?: string; boundaryClearedInFlight?: string }
    >;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<
      string,
      { turn: number; text: string; pre?: string }
    >;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    // 'HEAD' buffers, boundary 1 seals it, and the idle drain sends 'HEAD'
    // carrying that seal while the send stays unresolved.
    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    let resolveHead!: (v: MockResponse) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((resolve) => {
        resolveHead = resolve;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    // The same segment repeats across boundary 2, which re-seals the residual
    // and marks this flight's seal as the residual's — with text that
    // coincides with the carried seal byte for byte.
    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    const state = stateMap.get('s1')!;
    expect(state.boundaryClearedInFlight).toBe('residual');
    expect(state.sealedPre).toBe('HEAD');

    // The head send SUCCEEDS. The seal now on the state is the residual's only
    // copy, so the success arm must not clear it by string equality.
    mockSendQQMessage.mockRejectedValue(new Error('transient'));
    resolveHead(mockResponse(true));
    await drain();
    expect(stateMap.get('s1')!.sealedPre).toBe('HEAD');

    // The residual's own flush then exhausts its retries: its text must still
    // be re-stashed rather than dropped with the entry.
    await vi.advanceTimersByTimeAsync(60_000);
    await drain();
    expect(orphanBuffer.get('s1')).toEqual({
      turn: 1,
      text: 'HEAD',
      pre: 'HEAD',
    });

    // And completion delivers it, so the repeated segment reaches the wire.
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await onResponseComplete(ch, 'test-chat', '', 's1');
    await drain();
    expect(sentContents().at(-1)).toBe('HEAD');
  });

  it('re-seals the whole payload a boundary cleared before a permanent failure', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const stateMap = chp['streamState'] as Map<string, { sealedPre?: string }>;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    onResponseChunk(ch, 'test-chat', 'B', 's1');
    let rejectHead!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectHead = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();
    onResponseChunk(ch, 'test-chat', 'C', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    expect(stateMap.get('s1')!.sealedPre).toBe('C');

    // The permanent arm re-stashes the seal directly: it must cover the whole
    // payload, not just the seal the send carried.
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    rejectHead(new DeliveryError('RETRY_EXHAUSTED', 'permanent failure'));
    await drain();
    expect(stateMap.has('s1')).toBe(false);

    await onResponseComplete(ch, 'test-chat', '', 's1');
    await drain();
    expect(sentContents().at(-1)).toBe('HEADBC');
  });

  it('re-seals the payload when a boundary cleared the collection with no residual', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const stateMap = chp['streamState'] as Map<string, { sealedPre?: string }>;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    onResponseChunk(ch, 'test-chat', 'B', 's1');
    let rejectHead!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectHead = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    // Boundary 2 fires with an EMPTY residual: no new seal is written, but the
    // collection clear still strips the whole in-flight payload from fullText.
    onResponseBoundary(ch, 'test-chat', 's1');
    expect(stateMap.get('s1')!.sealedPre).toBe('HEAD');

    mockSendQQMessage.mockRejectedValue(new Error('transient'));
    rejectHead(new Error('transient'));
    await drain();
    expect(stateMap.get('s1')!.sealedPre).toBe('HEADB');

    await vi.advanceTimersByTimeAsync(60_000);
    await drain();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await onResponseComplete(ch, 'test-chat', '', 's1');
    await drain();
    expect(sentContents().at(-1)).toBe('HEADB');
  });

  it('re-seals the whole payload when a parked turn re-buffers it after a boundary', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const stateMap = chp['streamState'] as Map<string, { sealedPre?: string }>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    onResponseChunk(ch, 'test-chat', 'B', 's1');
    let rejectHead!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectHead = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    // The turn ends while 'HEADB' is in flight, so the failure takes the
    // parked-branch re-buffer.
    onPromptEnd(ch, 'test-chat', 's1');
    expect(pendingStreamDelete.has('s1')).toBe(true);

    onResponseChunk(ch, 'test-chat', 'C', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    expect(stateMap.get('s1')!.sealedPre).toBe('C');

    let failures = 0;
    mockSendQQMessage.mockImplementation(() => {
      failures++;
      return failures <= 2
        ? Promise.reject(new Error('transient'))
        : Promise.resolve(mockResponse(true));
    });
    rejectHead(new Error('transient'));
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(8000);
      await drain();
    }
    expect(sentContents().at(-1)).toBe('HEADBC');
  });

  it('does not re-seal a later payload from a stale boundary marker', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const stateMap = chp['streamState'] as Map<
      string,
      { sealedPre?: string; buffer: string }
    >;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    onResponseChunk(ch, 'test-chat', 'B', 's1');
    let resolveHead!: (v: MockResponse) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((resolve) => {
        resolveHead = resolve;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    // A residual 'D' arrives and a boundary seals it while 'HEADB' is in
    // flight; that send SUCCEEDS, so the residual seal must survive.
    onResponseChunk(ch, 'test-chat', 'D', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    expect(stateMap.get('s1')!.sealedPre).toBe('D');
    resolveHead(mockResponse(true));
    await drain();
    expect(stateMap.get('s1')!.sealedPre).toBe('D');

    // 'E' arrives (so it is in fullText) and the residual drain sends the wider
    // 'DE' carrying only 'D', then fails transiently with NO boundary during
    // its flight: the first flight's marker must not re-seal 'E'.
    onResponseChunk(ch, 'test-chat', 'E', 's1');
    let rejectTail!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectTail = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();
    mockSendQQMessage.mockRejectedValue(new Error('transient'));
    rejectTail(new Error('transient'));
    await vi.advanceTimersByTimeAsync(60_000);
    await drain();

    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await onResponseComplete(ch, 'test-chat', 'E', 's1');
    await drain();
    expect(sentContents().at(-1)).toBe('DE');
  });

  it('widens the carried seal when a re-seal marker was missed', async () => {
    const ch = makeChannel({ maxFlushRetries: 2 });
    const chp = ch as unknown as Record<string, unknown>;
    const stateMap = chp['streamState'] as Map<
      string,
      { sealedPre?: string; boundaryClearedInFlight?: string }
    >;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    // 'HEAD' buffers, a boundary seals it, and the drain takes it with the send
    // still unresolved.
    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    let rejectSend!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectSend = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    // Direct state for a boundary re-seal whose marker was missed: every live
    // boundary sets boundaryClearedInFlight, so no public path produces this
    // pair. It pins the carried-seal backstop at the re-buffer arms.
    const state = stateMap.get('s1')!;
    expect(state.boundaryClearedInFlight).toBeUndefined();
    state.sealedPre = 'RESID';
    state.buffer = 'RESID';

    mockSendQQMessage.mockRejectedValue(new Error('transient'));
    rejectSend(new Error('transient'));
    await drain();
    // The carried head is widened onto the seal written during the flight.
    expect(state.sealedPre).toBe('HEADRESID');

    await vi.advanceTimersByTimeAsync(60_000);
    await drain();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await onResponseComplete(ch, 'test-chat', '', 's1');
    await drain();
    // And the head rides that payload exactly once.
    expect(sentContents().at(-1)).toBe('HEADRESID');
  });

  it('recovers the carried seal when a permanent re-seal marker was missed', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const stateMap = chp['streamState'] as Map<
      string,
      { sealedPre?: string; boundaryClearedInFlight?: string }
    >;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<
      string,
      { turn: number; text: string; pre?: string }
    >;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    // 'HEAD' buffers, a boundary seals it, and the drain takes it with the send
    // still unresolved.
    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    let rejectSend!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectSend = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    // Direct state for a boundary re-seal whose marker was missed: every live
    // boundary sets boundaryClearedInFlight, so no public path produces this
    // pair. It pins the carried-seal argument the permanent arm passes to
    // handOffSealedPre.
    const state = stateMap.get('s1')!;
    expect(state.boundaryClearedInFlight).toBeUndefined();
    state.sealedPre = 'RESID';
    state.buffer = 'RESID';

    rejectSend(new DeliveryError('RETRY_EXHAUSTED', 'permanent failure'));
    await drain();
    // The permanent arm hands the carried head and the live seal off together,
    // head first: the merged stash is the only copy left.
    expect(state.sealedPre).toBeUndefined();
    expect(orphanBuffer.get('s1')).toEqual({
      turn: 1,
      text: 'HEADRESID',
      pre: 'HEADRESID',
    });

    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await onResponseComplete(ch, 'test-chat', '', 's1');
    await drain();
    // The recovered head is delivered exactly once, not duplicated.
    expect(sentContents().at(-1)).toBe('HEADRESID');
  });

  it('seals the residual a hook-suppressed boundary stripped from a flush in flight', async () => {
    // ChannelBase suppresses onResponseBoundary while a cancel is pending, but
    // the bridge still clears its chunk collection and emits the boundary, so
    // the ungated observer is the only signal and must seal what it stripped.
    const bridge = new EventEmitter();
    const ch = makeChannel(
      { maxFlushRetries: 2 },
      bridge as unknown as Record<string, unknown>,
    );
    const chp = ch as unknown as Record<string, unknown>;
    const stateMap = chp['streamState'] as Map<
      string,
      { sealedPre?: string; boundaryClearedInFlight?: string }
    >;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    let rejectHead!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectHead = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    onResponseChunk(ch, 'test-chat', 'TAIL', 's1');
    bridge.emit('responseBoundary', 's1');
    expect(stateMap.get('s1')!.boundaryClearedInFlight).toBe('residual');
    expect(stateMap.get('s1')!.sealedPre).toBe('TAIL');

    mockSendQQMessage.mockRejectedValue(new Error('transient'));
    rejectHead(new Error('transient'));
    await drain();
    await vi.advanceTimersByTimeAsync(60_000);
    await drain();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await onResponseComplete(ch, 'test-chat', '', 's1');
    await drain();
    expect(sentContents().at(-1)).toBe('HEADTAIL');
  });

  it('does not capture a successor boundary residual into a predecessor flush', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const stateMap = chp['streamState'] as Map<
      string,
      { sealedPre?: string; boundaryClearedInFlight?: string }
    >;
    const flushing = chp['flushingSessions'] as Map<
      string,
      { sealedPre?: string; boundaryClearedInFlight?: string }
    >;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    onResponseChunk(ch, 'test-chat', 'B', 's1');
    let rejectHead!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectHead = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    // A successor turn replaces the stream entry; its boundary must not be
    // captured as the in-flight predecessor's residual.
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    onResponseChunk(ch, 'test-chat', 'T2', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    expect(stateMap.get('s1')!.sealedPre).toBe('T2');
    expect(flushing.get('s1')!.boundaryClearedInFlight).toBe('payload');
    expect(flushing.get('s1')!.sealedPre).toBe('HEAD');

    // The predecessor's permanent failure hands off its own head only, never
    // its payload merged with the successor's residual.
    rejectHead(new DeliveryError('RETRY_EXHAUSTED', 'permanent failure'));
    await drain();
    const orphan = (
      chp['streamOrphanBuffer'] as Map<string, { text: string; pre?: string }>
    ).get('s1');
    expect(orphan?.text).toBe('HEAD');
    expect(orphan?.text).not.toContain('HBHEAD');
  });
});

// A settling flush chain must not write shared per-session state once it no
// longer owns the session (onSessionDied tore it down) or the turn (a
// successor replaced it): the dead or superseded text would be prepended to
// an unrelated successor reply.
describe('ownership gates for a settling flush chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not re-stash a sealed head for a session onSessionDied tore down', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const stateMap = chp['streamState'] as Map<string, { sealedPre?: string }>;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<string, unknown>;
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    // A chunk streams, a boundary seals it, and the idle flush takes it with
    // the send still unresolved.
    onResponseChunk(ch, 'test-chat', 'DEAD-TURN-HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    let rejectSend!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectSend = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();
    expect(stateMap.get('s1')!.sealedPre).toBe('DEAD-TURN-HEAD');

    // The session dies while that send is in flight: every map the handoff
    // consults is torn down, but the chain still holds the seal.
    ch.onSessionDied('s1');
    expect(orphanBuffer.size).toBe(0);

    mockSendQQMessage.mockRejectedValue(new Error('transient'));
    rejectSend(new Error('transient'));
    await drain();
    await vi.advanceTimersByTimeAsync(60_000);
    await drain();

    // Nothing may be stashed for the dead session: a successor turn would
    // drain it and prepend the dead head to its reply.
    expect(orphanBuffer.size).toBe(0);
    // The drop is observable, like every other loss in this file.
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain(
      'dropping 14 chars of sealed head for unowned session s1',
    );
    stderrSpy.mockRestore();
  });

  it('does not re-seal a superseded payload into a successor stash', async () => {
    const ch = makeChannel({ maxFlushRetries: 2 });
    const chp = ch as unknown as Record<string, unknown>;
    const stateMap = chp['streamState'] as Map<
      string,
      { turn: number; sealedPre?: string }
    >;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<
      string,
      { turn: number; text: string; pre?: string }
    >;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    // Turn 1 streams 'P' and the drain takes it with the send unresolved.
    onResponseChunk(ch, 'test-chat', 'P', 's1');
    let rejectSend!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectSend = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    // 'Q' buffers during the flight, completion parks turn 1, and turn 2
    // starts: its chunks divert into the stash under turn 2.
    onResponseChunk(ch, 'test-chat', 'Q', 's1');
    await onResponseComplete(ch, 'test-chat', 'P', 's1');
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    onResponseChunk(ch, 'test-chat', 'T2', 's1');
    expect(orphanBuffer.get('s1')!.text).toBe('T2');

    // A boundary during turn 1's flight marks that superseded entry 'payload',
    // but must not seal anything: a superseded turn's payload is abandoned.
    onResponseBoundary(ch, 'test-chat', 's1');
    const superseded = stateMap.get('s1')!;
    expect(superseded.turn).toBe(1);

    // Turn 1's send now fails transiently: the re-seal must not touch a
    // superseded entry, and on exhaustion nothing of it may reach turn 2's
    // stash.
    mockSendQQMessage.mockRejectedValue(new Error('transient'));
    rejectSend(new Error('transient'));
    await drain();
    expect(superseded.sealedPre).toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000);
    await drain();

    expect(orphanBuffer.get('s1')).toEqual({
      turn: 2,
      text: 'T2',
      pre: 'T2',
    });

    // Completion then delivers turn 2's text alone: the superseded 'P' payload
    // must never reach the wire.
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await onResponseComplete(ch, 'test-chat', '', 's1');
    await drain();
    expect(sentContents().at(-1)).toBe('T2');
  });

  it('does not re-seal a superseded payload in the non-parked arm either', async () => {
    const ch = makeChannel({ maxFlushRetries: 2 });
    const chp = ch as unknown as Record<string, unknown>;
    const stateMap = chp['streamState'] as Map<
      string,
      { turn: number; sealedPre?: string; boundaryClearedInFlight?: string }
    >;
    const orphanBuffer = chp['streamOrphanBuffer'] as Map<string, unknown>;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    onResponseChunk(ch, 'test-chat', 'P', 's1');
    let rejectSend!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectSend = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    onResponseChunk(ch, 'test-chat', 'Q', 's1');
    // Turn 2 starts without a chunk of its own, so turn 1's entry stays in
    // streamState (no park flag): its settlement takes the non-parked arm.
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    onResponseBoundary(ch, 'test-chat', 's1');
    const superseded = stateMap.get('s1')!;
    expect(superseded.turn).toBe(1);
    expect(superseded.boundaryClearedInFlight).toBe('payload');

    mockSendQQMessage.mockRejectedValue(new Error('transient'));
    rejectSend(new Error('transient'));
    await drain();

    // A superseded entry must not be re-sealed even when its own chain
    // re-buffers it instead of parking.
    expect(superseded.sealedPre).toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000);
    await drain();
    // Exhaustion leaves nothing of the superseded turn behind.
    expect(stateMap.has('s1')).toBe(false);
    expect(orphanBuffer.size).toBe(0);
  });
});

describe('tail hand-off must not stash under an ended turn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers the sealed head instead of re-stashing it under a finished successor', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    await reachStashedOrphan(ch);

    // Turn 2's drained send goes out carrying the sealed head and stays in
    // flight.
    onResponseBoundary(ch, 'test-chat', 's1');
    let rejectDrain!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectDrain = reject;
      }),
    );
    onResponseChunk(ch, 'test-chat', 'T2-REST', 's1');
    vi.advanceTimersByTime(2000);
    await drain();

    // Turn 3 supersedes turn 2, then runs to completion AND ends while turn 2's
    // send is still in flight: completion defers onto the park flag and
    // onPromptEnd early-returns on it. Turn 3 is over.
    setReplyMsgId(ch, 'test-chat', 'msg-C');
    onPromptStart(ch, 'test-chat', 's1', 'msg-C');
    onResponseChunk(ch, 'test-chat', 'T3-HEAD', 's1');
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await onResponseComplete(ch, 'test-chat', 'T3-HEADT3-REST', 's1');
    onPromptEnd(ch, 'test-chat', 's1');
    expect(pendingStreamDelete.has('s1')).toBe(true);
    const sendsBeforeFailure = mockSendQQMessage.mock.calls.length;

    // Only now does turn 2's in-flight send fail transiently. Turn 3 has
    // already run the completion that consumes a stash tagged turn 3, so
    // re-stashing under it would be a write nothing can ever read.
    rejectDrain(new Error('transient'));
    await drain();
    await vi.advanceTimersByTimeAsync(20_000);
    await drain();

    // The sealed opening must reach the user exactly once after the failure.
    const sendsSince = sentContents().slice(sendsBeforeFailure);
    expect(sendsSince.filter((c) => c.includes('T2-HEAD '))).toHaveLength(1);

    // And a next turn must not find it parked as a superseded stash: the text
    // is delivered rather than dropped with a misattributed log line.
    setReplyMsgId(ch, 'test-chat', 'msg-D');
    onPromptStart(ch, 'test-chat', 's1', 'msg-D');
    expect(
      stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes('dropping')),
    ).toHaveLength(0);
    stderrSpy.mockRestore();
  });

  it('drops a finished turn record at turn end so a reused turn number cannot alias it', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const completedTurns = chp['completedTurns'] as Map<string, number>;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    // Turn 1 completes and ends. Nothing can consult the record afterwards —
    // the completion that consumes a stash tagged turn 1 has already run — so
    // the teardown must drop it rather than leave one entry per session seen.
    onResponseChunk(ch, 'test-chat', 'H', 's1');
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await onResponseComplete(ch, 'test-chat', 'H', 's1');
    onPromptEnd(ch, 'test-chat', 's1');
    expect(completedTurns.has('s1')).toBe(false);

    // The turn counter is gone, so the next prompt is turn 1 again. A record
    // left over from the finished turn 1 would alias it and make a later
    // hand-off treat a turn whose completion never ran as already completed.
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    expect(completedTurns.has('s1')).toBe(false);
  });
});

describe('a superseded head must keep its own reply anchor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    responseMessageIdRef.current = undefined;
    vi.useRealTimers();
  });

  it("delivers a superseded turn's head on its own anchor, not the successor's", async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const completedTurns = chp['completedTurns'] as Map<string, number>;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    // Turn 1's HEAD is sealed at a boundary and sent under msg-A; that send
    // stays in flight.
    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    let rejectHead!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectHead = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    // Turn 2 re-anchors the session to msg-B, then completes while turn 1's
    // send is still in flight. Completion defers onto the park flag, so msg-B
    // stays the session anchor and completedTurns records turn 2.
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    onResponseChunk(ch, 'test-chat', 'T2', 's1');
    await onResponseComplete(ch, 'test-chat', 'T2', 's1');
    expect(completedTurns.get('s1')).toBe(2);

    // Turn 1's send fails permanently. Turn 2 already ran the completion that
    // could have consumed a stash tagged turn 2, so turn 1's sealed head is
    // delivered directly — and must go out on msg-A, the anchor it was written
    // under, not the successor's msg-B. Only sends after the failed attempt
    // can prove where the recovered head went.
    const beforeFailure = mockSendQQMessage.mock.calls.length;
    rejectHead(new DeliveryError('RETRY_EXHAUSTED', 'permanent failure'));
    await drain();

    const headBodies = sentBodies()
      .slice(beforeFailure)
      .filter(
        (b) =>
          (b['markdown'] as { content?: string } | undefined)?.content ===
          'HEAD',
      );
    expect(headBodies).toHaveLength(1);
    expect(headBodies[0]!['msg_id']).toBe('msg-A');
  });

  it('delivers a superseded head unanchored when its own turn had no anchor', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { timestamp: number }
    >;
    const ttl = (QQChannel as unknown as { REPLY_MSG_ID_TTL_MS: number })
      .REPLY_MSG_ID_TTL_MS;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    // Turn 1's anchor is already past its TTL, so its stream entry is built
    // without one and its HEAD is sent as an active message.
    sessionAnchors.get('s1')!.timestamp = Date.now() - ttl - 1000;

    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    let rejectHead!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectHead = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    // Turn 2 owns the session anchor when turn 1's send fails permanently.
    // Turn 1's head has no anchor of its own, so it must go out unanchored
    // rather than be re-parented onto the successor's msg-B.
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    onResponseChunk(ch, 'test-chat', 'T2', 's1');
    await onResponseComplete(ch, 'test-chat', 'T2', 's1');

    const beforeFailure = mockSendQQMessage.mock.calls.length;
    rejectHead(new DeliveryError('RETRY_EXHAUSTED', 'permanent failure'));
    await drain();

    const headBodies = sentBodies()
      .slice(beforeFailure)
      .filter(
        (b) =>
          (b['markdown'] as { content?: string } | undefined)?.content ===
          'HEAD',
      );
    expect(headBodies).toHaveLength(1);
    expect(headBodies[0]!['msg_id']).toBeUndefined();
  });

  it('leaves a superseded head unanchored even with a live successor reply context', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { timestamp: number }
    >;
    const ttl = (QQChannel as unknown as { REPLY_MSG_ID_TTL_MS: number })
      .REPLY_MSG_ID_TTL_MS;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    // Turn 1's anchor is already past its TTL, so its stream entry carries no
    // msgId and the cancelled-stash handoff passes the `null` sentinel.
    sessionAnchors.get('s1')!.timestamp = Date.now() - ttl - 1000;

    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    onResponseBoundary(ch, 'test-chat', 's1');
    let rejectHead!: (e: unknown) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((_resolve, reject) => {
        rejectHead = reject;
      }),
    );
    vi.advanceTimersByTime(2000);
    await drain();

    // Turn 2 completes while turn 1's send is in flight, and its reply context
    // stays live: getResponseMessageId still names msg-B, as it does in the
    // window before ChannelBase drops the active prompt.
    setReplyMsgId(ch, 'test-chat', 'msg-B');
    onPromptStart(ch, 'test-chat', 's1', 'msg-B');
    responseMessageIdRef.current = 'msg-B';
    (chp['replyContextByMessageId'] as Map<string, unknown>).set('msg-B', {
      chatId: 'test-chat',
      msgId: 'msg-B',
      timestamp: Date.now(),
    });
    onResponseChunk(ch, 'test-chat', 'T2', 's1');
    await onResponseComplete(ch, 'test-chat', 'T2', 's1');

    const beforeFailure = mockSendQQMessage.mock.calls.length;
    rejectHead(new DeliveryError('RETRY_EXHAUSTED', 'permanent failure'));
    await drain();

    // The `null` sentinel means unanchored: the delivery must not re-derive a
    // msg_id from the live successor reply context.
    const headBodies = sentBodies()
      .slice(beforeFailure)
      .filter(
        (b) =>
          (b['markdown'] as { content?: string } | undefined)?.content ===
          'HEAD',
      );
    expect(headBodies).toHaveLength(1);
    expect(headBodies[0]!['msg_id']).toBeUndefined();
  });
});

describe('completedTurns lifetime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the completion record while an in-flight chain can still read it', () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const completedTurns = chp['completedTurns'] as Map<string, number>;
    const flushingSessions = chp['flushingSessions'] as Map<
      string,
      FlushMarkerState
    >;
    // A chain still owns the session marker with no streamState entry of its
    // own (a settle path deleted the entry a microtask before clearing the
    // marker). Its handOffSealedPre can still run, so the teardown must keep
    // the record for it rather than drop it with the absent entry.
    flushingSessions.set('s1', flushMarkerState());
    completedTurns.set('s1', 1);
    onPromptEnd(ch, 'test-chat', 's1');
    expect(completedTurns.get('s1')).toBe(1);

    // Once the chain releases the marker nothing can read the record, so the
    // next teardown drops it instead of leaking it for the session's lifetime.
    flushingSessions.delete('s1');
    onPromptEnd(ch, 'test-chat', 's1');
    expect(completedTurns.has('s1')).toBe(false);
  });

  it('drops the completion record when a parked chain settles', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const completedTurns = chp['completedTurns'] as Map<string, number>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');

    // Turn 1's send stays in flight, so completion parks onto its chain.
    let resolveSend!: (v: MockResponse) => void;
    mockSendQQMessage.mockReturnValueOnce(
      new Promise<MockResponse>((resolve) => {
        resolveSend = resolve;
      }),
    );
    onResponseChunk(ch, 'test-chat', 'HEAD', 's1');
    vi.advanceTimersByTime(2000);
    await drain();

    // onPromptEnd early-returns on the park flag, so only the chain's own
    // terminal settle can drop the record.
    await onResponseComplete(ch, 'test-chat', 'HEAD', 's1');
    onPromptEnd(ch, 'test-chat', 's1');
    expect(pendingStreamDelete.has('s1')).toBe(true);
    expect(completedTurns.get('s1')).toBe(1);

    resolveSend(mockResponse(true));
    await drain();

    expect(pendingStreamDelete.has('s1')).toBe(false);
    expect(completedTurns.has('s1')).toBe(false);
  });
});

describe('boundary suppressed from the adapter hook still seals the stash', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('seals the stash on the bridge boundary the hook never saw (stale-entry reader)', async () => {
    const bridge = new EventEmitter();
    const ch = makeChannel({}, bridge as unknown as Record<string, unknown>);
    const { resolveSend, orphanBuffer } = await reachStaleStash(ch);
    expect(orphanBuffer.get('s1')).toEqual({ turn: 2, text: 'T2-HEAD ' });

    // ChannelBase's own responseBoundary listener returns early while a cancel
    // is pending, so ch.onResponseBoundary never runs. The bridge's emit — and
    // its own clearChunks — still happen, dropping 'T2-HEAD ' from fullText.
    bridge.emit('responseBoundary', 's1');

    // The cancel loses the race; the turn completes normally with only the
    // post-boundary text in fullText.
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    await onResponseComplete(ch, 'test-chat', 'T2-REST', 's1');
    expect(sentContents().at(-1)).toBe('T2-HEAD T2-REST');
    resolveSend(mockResponse(true));
    await drain();
  });

  it('seals the stash on the bridge boundary the hook never saw (normal reader)', async () => {
    const bridge = new EventEmitter();
    const ch = makeChannel({}, bridge as unknown as Record<string, unknown>);
    const { orphanBuffer } = await reachStashedOrphan(ch);
    expect(orphanBuffer.get('s1')).toEqual({ turn: 2, text: 'T2-HEAD ' });

    bridge.emit('responseBoundary', 's1');

    await onResponseComplete(ch, 'test-chat', 'T2-REST', 's1');
    expect(sentContents().at(-1)).toBe('T2-HEAD T2-REST');
  });

  it('does not prepend when no boundary cleared the collection (stale-entry reader)', async () => {
    const bridge = new EventEmitter();
    const ch = makeChannel({}, bridge as unknown as Record<string, unknown>);
    const { resolveSend, orphanBuffer } = await reachStaleStash(ch);
    expect(orphanBuffer.get('s1')).toEqual({ turn: 2, text: 'T2-HEAD ' });
    expect(orphanBuffer.get('s1')!.pre).toBeUndefined();

    await onResponseComplete(ch, 'test-chat', 'T2-HEAD T2-REST', 's1');
    const contents = sentContents();
    expect(contents.filter((c) => c === 'T2-HEAD T2-REST')).toHaveLength(1);
    expect(contents.some((c) => c.includes('T2-HEAD T2-HEAD'))).toBe(false);
    resolveSend(mockResponse(true));
    await drain();
  });

  it('does not prepend when no boundary cleared the collection (normal reader)', async () => {
    const bridge = new EventEmitter();
    const ch = makeChannel({}, bridge as unknown as Record<string, unknown>);
    const { orphanBuffer } = await reachStashedOrphan(ch);
    expect(orphanBuffer.get('s1')).toEqual({ turn: 2, text: 'T2-HEAD ' });

    await onResponseComplete(ch, 'test-chat', 'T2-HEAD T2-REST', 's1');
    const contents = sentContents();
    expect(contents.filter((c) => c === 'T2-HEAD T2-REST')).toHaveLength(1);
    expect(contents.some((c) => c.includes('T2-HEAD T2-HEAD'))).toBe(false);
  });

  it('recovers only the sealed head when post-boundary chunks joined the stash', async () => {
    const bridge = new EventEmitter();
    const ch = makeChannel({}, bridge as unknown as Record<string, unknown>);
    const { resolveSend, orphanBuffer } = await reachStaleStash(ch);
    expect(orphanBuffer.get('s1')).toEqual({ turn: 2, text: 'T2-HEAD ' });

    // The suppressed hook misses the boundary, but the bridge still cleared
    // its collection at that point.
    bridge.emit('responseBoundary', 's1');
    // A post-boundary chunk arrives while the predecessor is still parked: it
    // joins the stash AND the bridge's fresh collection (so it is in fullText).
    onResponseChunk(ch, 'test-chat', 'T2-POST', 's1');

    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    // fullText carries only the post-boundary text; the sealed head is the
    // only part that must be recovered. Prepending the whole stash (or a
    // fullText-comparison guard) would repeat T2-POST.
    await onResponseComplete(ch, 'test-chat', 'T2-POST', 's1');
    expect(sentContents().at(-1)).toBe('T2-HEAD T2-POST');
    resolveSend(mockResponse(true));
    await drain();
  });
});

// onPromptEnd deletes the cancelled turn's stash from streamOrphanBuffer before
// handing it to deliverCancelledStash (and handOffSealedPre clears sealedPre
// before the same call), so that text has no second copy anywhere. RATE_LIMITED
// is the code the flush path treats as transient, so the cancelled-stash
// delivery must re-attempt it under the existing maxFlushRetries bound instead
// of dropping it; the permanent codes must still drop.
describe('cancelled-stash delivery failure classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    responseMessageIdRef.current = undefined;
    vi.useFakeTimers();
  });

  afterEach(() => {
    responseMessageIdRef.current = undefined;
    vi.useRealTimers();
  });

  const callsCarrying = (text: string) =>
    mockSendQQMessage.mock.calls.filter((c) => {
      const markdown = (c[3] as Record<string, unknown>)['markdown'] as
        | { content?: string }
        | undefined;
      return markdown?.content === text;
    });

  const attemptsCarrying = (text: string) => callsCarrying(text).length;

  const msgIdsCarrying = (text: string) =>
    callsCarrying(text).map((c) => (c[3] as Record<string, unknown>)['msg_id']);

  it('re-sends a cancelled stash that a 429 rejected (RATE_LIMITED is transient)', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<string, unknown>;
    const inFlight = chp['inFlightMsgSeqSends'] as Map<string, number>;
    const { resolveSend } = await reachStaleStash(ch);

    // Only the stash delivery is rate-limited; the re-attempt succeeds.
    mockSendQQMessage.mockReturnValueOnce(mockResponse(false, 429));
    onPromptEnd(ch, 'test-chat', 's1');
    await drain();

    // The 429 is the only attempt so far, and it failed: the anchor is still
    // held, because only the success path releases it.
    expect(attemptsCarrying('T2-HEAD ')).toBe(1);
    expect(sessionAnchors.has('s1')).toBe(true);
    // The in-flight guard now spans the whole delivery, backoff sleeps
    // included, so the pending re-attempt keeps the counter registered exactly
    // once — the release-guard cannot drop it mid-retry.
    expect(inFlight.size).toBe(1);

    // The re-attempt is armed off the idle-flush cadence.
    await vi.advanceTimersByTimeAsync(10_000);
    await drain();

    // Exactly one more attempt, and it was accepted: the anchor is released
    // only on success, so the stash reached the API exactly once.
    expect(attemptsCarrying('T2-HEAD ')).toBe(2);
    expect(sessionAnchors.has('s1')).toBe(false);
    expect(inFlight.size).toBe(0);

    resolveSend(mockResponse(true));
    await vi.advanceTimersByTimeAsync(20_000);
    await drain();
  });

  it.each([
    'RETRY_EXHAUSTED',
    'ACTIVE_MSG_DISABLED',
    'FALLBACK_FAILED',
  ] as const)('does not retry a %s rejection (permanent)', async (code) => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<string, unknown>;
    const { resolveSend } = await reachStaleStash(ch);

    mockSendQQMessage.mockRejectedValueOnce(
      new DeliveryError(code, 'permanent failure'),
    );
    onPromptEnd(ch, 'test-chat', 's1');
    await drain();
    expect(attemptsCarrying('T2-HEAD ')).toBe(1);

    // A permanent code arms no re-attempt.
    await vi.advanceTimersByTimeAsync(60_000);
    await drain();
    expect(attemptsCarrying('T2-HEAD ')).toBe(1);
    expect(sessionAnchors.has('s1')).toBe(true);

    resolveSend(mockResponse(true));
    await vi.advanceTimersByTimeAsync(20_000);
    await drain();
  });

  it('exhausts the re-attempts at the default maxFlushRetries', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<string, unknown>;
    const { resolveSend } = await reachStaleStash(ch);

    // The default bound is 3: the first attempt plus two re-attempts.
    mockSendQQMessage
      .mockReturnValueOnce(mockResponse(false, 429))
      .mockReturnValueOnce(mockResponse(false, 429))
      .mockReturnValueOnce(mockResponse(false, 429));
    onPromptEnd(ch, 'test-chat', 's1');
    await drain();
    expect(attemptsCarrying('T2-HEAD ')).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await drain();
    expect(attemptsCarrying('T2-HEAD ')).toBe(2);

    await vi.advanceTimersByTimeAsync(4_000);
    await drain();
    expect(attemptsCarrying('T2-HEAD ')).toBe(3);

    // Exhausted: the text is dropped, and the anchor stays held because no
    // attempt succeeded.
    await vi.advanceTimersByTimeAsync(60_000);
    await drain();
    expect(attemptsCarrying('T2-HEAD ')).toBe(3);
    expect(sessionAnchors.has('s1')).toBe(true);

    resolveSend(mockResponse(true));
    await vi.advanceTimersByTimeAsync(20_000);
    await drain();
  });

  it('reuses the captured reply context when a re-attempt crosses into a successor turn', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const { resolveSend } = await reachStaleStash(ch);
    // No session anchor within TTL: the delivery takes the entry-less branch,
    // whose reply context is what a successor turn can change underneath it.
    (chp['sessionReplyMsgId'] as Map<string, unknown>).clear();
    responseMessageIdRef.current = 'msg-B';
    (chp['replyContextByMessageId'] as Map<string, unknown>).set('msg-B', {
      chatId: 'test-chat',
      msgId: 'msg-B',
      timestamp: Date.now(),
    });

    mockSendQQMessage.mockReturnValueOnce(mockResponse(false, 429));
    onPromptEnd(ch, 'test-chat', 's1');
    await drain();
    expect(msgIdsCarrying('T2-HEAD ')).toEqual(['msg-B']);

    // A successor turn now owns the slot, so a re-derived reply context would
    // be the successor's (or absent). The re-attempt must stay on msg-B.
    responseMessageIdRef.current = 'msg-successor';
    await vi.advanceTimersByTimeAsync(10_000);
    await drain();
    expect(msgIdsCarrying('T2-HEAD ')).toEqual(['msg-B', 'msg-B']);

    resolveSend(mockResponse(true));
    await vi.advanceTimersByTimeAsync(20_000);
    await drain();
  });

  it('bounds the re-attempts by maxFlushRetries', async () => {
    const ch = makeChannel({ maxFlushRetries: 1 });
    const { resolveSend } = await reachStaleStash(ch);

    mockSendQQMessage.mockReturnValueOnce(mockResponse(false, 429));
    onPromptEnd(ch, 'test-chat', 's1');
    await drain();
    expect(attemptsCarrying('T2-HEAD ')).toBe(1);

    // maxFlushRetries: 1 means the single attempt is already the bound.
    await vi.advanceTimersByTimeAsync(60_000);
    await drain();
    expect(attemptsCarrying('T2-HEAD ')).toBe(1);

    resolveSend(mockResponse(true));
    await vi.advanceTimersByTimeAsync(20_000);
    await drain();
  });
});

// Guards a single-edit mutant run over the flush chain left unpinned: each test
// below fails when its guard is removed and passes on this head. The test names
// state the guard under test.
describe('flush-chain guards pinned by witness tests', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('onPromptStart drops a dead orphan stash left behind a turn-counter reset', async () => {
    const ch = makeChannel();
    // State a settled deferred chain leaves: a stash tagged with the turn the
    // counter is about to restart at, which nothing else clears.
    (
      (ch as unknown as Record<string, unknown>)['streamOrphanBuffer'] as Map<
        string,
        { turn: number; text: string; pre?: string }
      >
    ).set('sess-1', { turn: 1, text: 'STALE-HEAD ', pre: 'STALE-HEAD ' });

    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-B'); // counter restarts at 1
    onResponseChunk(ch, 'test-chat', 'fresh answer', 'sess-1');
    await onResponseComplete(ch, 'test-chat', 'fresh answer', 'sess-1');
    await vi.advanceTimersByTimeAsync(2100);
    await drain();

    const delivered = sentContents().join('|');
    expect(delivered).toContain('fresh answer');
    expect(delivered).not.toContain('STALE-HEAD');
  });

  it('isMsgSeqStillInUse holds a suspended cancelled-stash send on its counter', async () => {
    const ch = makeChannel();
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'part-1 ', 'sess-1');
    await vi.advanceTimersByTimeAsync(2100); // idle flush -> (msg-A, seq 1)
    await drain();
    expect(sentBodies().map((b) => b['msg_seq'])).toEqual([1]);

    // The next send must refresh the token: hold it so the send stays suspended
    // inside the route resolution while a successor turn starts.
    const tok = deferred<{ accessToken: string; expiresIn: number }>();
    mockFetchAccessToken.mockReturnValueOnce(tok.promise);
    (ch as unknown as Record<string, unknown>)['tokenExpiresAt'] = 0;
    const delivery = (
      ch as unknown as {
        deliverCancelledStash: (
          c: string,
          s: string,
          t: string,
          a?: string | null,
        ) => Promise<void>;
      }
    ).deliverCancelledStash('test-chat', 'sess-1', 'STASHED-HEAD', 'msg-A');
    await drain();

    // A successor turn starts on the same session and releases msg-A's anchor.
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-B');
    tok.resolve({ accessToken: 'test-token-2', expiresIn: 7200 });
    await drain();
    await vi.advanceTimersByTimeAsync(10);
    await delivery;

    const stash = sentBodies().find((b) =>
      String(
        (b['markdown'] as { content?: string } | undefined)?.content ?? '',
      ).includes('STASHED-HEAD'),
    )!;
    expect(stash['msg_id']).toBe('msg-A');
    // QQ dedupes on (msg_id, msg_seq): a reclaimed counter resolves 1 again.
    expect(stash['msg_seq']).toBe(2);
  });

  it("the flush chain's .finally releases flushingSessions only for its own state", async () => {
    const ch = makeChannel();
    const sendA = deferred<MockResponse>();
    const sendB = deferred<MockResponse>();
    mockSendQQMessage
      .mockReturnValueOnce(sendA.promise)
      .mockReturnValueOnce(sendB.promise);
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'a-1 ', 'sess-1');
    await vi.advanceTimersByTimeAsync(2100); // chain A in flight, marker = A
    await drain();

    // The session is replaced outright while A's send is still pending.
    ch.onSessionDied('sess-1');
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-B');
    onResponseChunk(ch, 'test-chat', 'b-1 ', 'sess-1');
    await vi.advanceTimersByTimeAsync(2100); // chain B in flight, marker = B
    await drain();
    const flushing = (ch as unknown as Record<string, unknown>)[
      'flushingSessions'
    ] as Map<string, unknown>;
    const markerB = flushing.get('sess-1');
    expect(markerB).toBeDefined();

    sendA.resolve(mockResponse(true)); // the superseded chain settles
    await drain();
    await vi.advanceTimersByTimeAsync(10);

    // B's send is still in flight: its marker must survive A's settle.
    expect(flushing.get('sess-1')).toBe(markerB);

    sendB.resolve(mockResponse(true));
    await drain();
  });

  it('onPromptStart clears completedTurns so a restarted turn cannot alias it', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    // A teardown keeps the completion record while the turn counter restarts;
    // without the clear the record names the restarted turn 1 again.
    (chp['completedTurns'] as Map<string, number>).set('sess-1', 1);

    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-B'); // turn 1 again
    const state = {
      chatId: 'test-chat',
      buffer: '',
      timer: null,
      retryCount: 0,
      msgId: 'msg-B',
      turn: 1,
      sealedPre: 'SEALED-HEAD ',
    };
    streamState(ch).set('sess-1', state as never);
    (
      ch as unknown as {
        handOffSealedPre: (st: unknown, s: string) => void;
      }
    ).handOffSealedPre(state, 'sess-1');
    await drain();

    // This turn's completion has not run: the head must wait in the stash for
    // it, not go out on its own ahead of the reply.
    expect(mockSendQQMessage).not.toHaveBeenCalled();
    expect(
      (chp['streamOrphanBuffer'] as Map<string, { text: string }>).get('sess-1')
        ?.text,
    ).toBe('SEALED-HEAD ');
  });
});

// Round-1 robustness pins.
describe('round-1 robustness pins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function stash(
    ch: QQChannelClass,
    held: {
      turn: number;
      text: string;
      pre?: string;
      sourceLabel?: string;
    },
  ): void {
    (
      (ch as unknown as Record<string, unknown>)['streamOrphanBuffer'] as Map<
        string,
        typeof held
      >
    ).set('s1', held);
  }

  it("keeps a diverted stash's sealed pre when a cancelled turn merges it", () => {
    const ch = makeChannel();
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    // State a cancelled turn leaves: chunks diverted to the side buffer and
    // sealed by a boundary, with no streamState entry of its own.
    stash(ch, { turn: 1, text: 'STALE-HEAD ', pre: 'STALE-HEAD ' });
    onPromptEnd(ch, 'test-chat', 's1');
    const state = streamState(ch).get('s1')!;
    // The flush took the buffer into the send (state.buffer is cleared
    // synchronously), but the seal must stay on the entry: it is the only copy
    // the bridge cleared at the boundary, and a permanent failure of this flush
    // has nothing to hand off without it.
    expect((state as { sealedPre?: string }).sealedPre).toBe('STALE-HEAD ');
  });

  it("keeps the diverted turn's attribution label when a cancelled turn merges its stash", () => {
    const ch = makeChannel();
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    stash(ch, {
      turn: 1,
      text: 'LABELLED-HEAD ',
      sourceLabel: 'SUB-1',
    });
    onPromptEnd(ch, 'test-chat', 's1');
    // The label was captured when the chunks were diverted; the merged flush
    // must not go out unattributed.
    expect(streamState(ch).get('s1')!.sourceLabel).toBe('SUB-1');
  });

  it('does not re-arm a live idle timer on a response boundary', () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const states = chp['streamState'] as Map<string, Record<string, unknown>>;
    const armed = setTimeout(() => {}, 9999);
    const state = {
      chatId: 'test-chat',
      buffer: 'RESID',
      timer: armed,
      timerReconnectId: chp['_reconnectId'],
      retryCount: 0,
      turn: 1,
    };
    states.set('s1', state);
    (chp['turnCounter'] as Map<string, number>).set('s1', 1);

    onResponseBoundary(ch, 'test-chat', 's1');
    // The handle was already going to deliver this residual (a parked retry's
    // backoff): re-arming at the shorter idle cadence would collapse that tier.
    expect(states.get('s1')!['timer']).toBe(armed);
    clearTimeout(armed);
  });

  it('drops stashed orphan text on disconnect', () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    stash(ch, { turn: 1, text: 'STALE-AT-DISCONNECT ' });
    const buffer = chp['streamOrphanBuffer'] as Map<string, unknown>;
    expect(buffer.has('s1')).toBe(true);

    ch.disconnect();

    // resetRoutingState clears the side buffer: without that, every session
    // that had stashed text keeps it for the process lifetime.
    expect(buffer.has('s1')).toBe(false);
  });

  it('logs the sealed head a failed final delivery discards', async () => {
    const ch = makeChannel();
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    setReplyMsgId(ch, 'test-chat', 'msg-A');
    onPromptStart(ch, 'test-chat', 's1', 'msg-A');
    // A boundary-sealed head waiting in the side buffer for this turn.
    stash(ch, { turn: 1, text: 'HEAD-BODY', pre: 'HEAD-BODY' });
    mockSendQQMessage.mockRejectedValue(new Error('429 rate limited'));

    await expect(onResponseComplete(ch, 'test-chat', '', 's1')).rejects.toThrow(
      '429',
    );

    // The head has no other copy, so the failed delivery must say what was
    // dropped and why (delete-before-send stays; there is no redelivery).
    const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain('dropping 9 chars of sealed head');
    expect(logged).toContain('429 rate limited');
    stderrSpy.mockRestore();
  });

  it('logs the head a session death discards from the side buffer', () => {
    const ch = makeChannel();
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    stash(ch, { turn: 1, text: 'DEAD-HEAD ' });
    ch.onSessionDied('s1');
    // Head text the bridge already cleared must not vanish silently.
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain(
      'dropping 10 chars',
    );
    stderrSpy.mockRestore();
  });
});
