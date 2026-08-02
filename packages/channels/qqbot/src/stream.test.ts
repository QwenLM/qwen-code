import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  type QQChannel as QQChannelClass,
  DeliveryError,
} from './QQChannel.js';
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
      turn: number;
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

  it('drops stale state from a previous turn and clears its flush flags', async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);
    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Set<string>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;

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
    // Flush in flight: buffer captured, flushingSessions armed.
    expect(streamState(ch).get('sess-1')!.buffer).toBe('');
    expect(flushingSessions.has('sess-1')).toBe(true);
    pendingStreamDelete.add('sess-1');

    // Turn 2 starts: bumps the turn counter and overwrites the anchor.
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-2');

    // The first chunk of turn 2 hits the stale-state branch: the old entry
    // (turn=1) is dropped along with its flags, and a fresh entry is created
    // under turn 2's anchor.
    onResponseChunk(ch, 'test-chat', 'turn-2-chunk', 'sess-1');

    const st = streamState(ch).get('sess-1')!;
    expect(st.buffer).toBe('turn-2-chunk');
    expect(st.msgId).toBe('msg-2');
    expect(st.turn).toBe(2);
    // The old turn's flags are cleared so turn 2's onResponseComplete /
    // onPromptEnd are not short-circuited into a silent reply loss.
    expect(flushingSessions.has('sess-1')).toBe(false);
    expect(pendingStreamDelete.has('sess-1')).toBe(false);

    // Clean up the still-pending turn-1 send.
    resolveSend!(mockResponse(true));
    await drain();
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
    const flushingSessions = chp['flushingSessions'] as Set<string>;
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
    const flushingSessions = chp['flushingSessions'] as Set<string>;
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
    // The anchor is released after the final segment goes out.
    expect(sessionAnchors.has('sess-A')).toBe(false);
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
    const chp = ch as unknown as Record<string, unknown>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'intermediate ', 'sess-1');

    onResponseBoundary(ch, 'test-chat', 'sess-1');

    // A window gap between response windows must keep the reply anchor alive
    // so the next window's fresh streamState entry reuses the same msgId.
    expect(sessionAnchors.has('sess-1')).toBe(true);

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

  it("a fast turn whose chunks were dropped by the stale guard delivers its own text (not the previous turn's residual)", async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const turnCounter = chp['turnCounter'] as Map<string, number>;

    // Turn 1 streams and its deferred flush chain still owns the entry
    // (pendingStreamDelete parked, buffered residual, live idle timer).
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-A');
    onResponseChunk(ch, 'test-chat', 'turn-1-residual', 'sess-1');
    pendingStreamDelete.add('sess-1');

    // Turn 2 starts: bumps the turn counter. Its chunks are ALL dropped by
    // the stale guard (state.buffer + pendingStreamDelete early-return), so
    // no fresh entry is created — onResponseComplete still sees turn 1's.
    onPromptStart(ch, 'test-chat', 'sess-1', 'msg-B');
    expect(turnCounter.get('sess-1')).toBe(2);

    // The response completes: turn 2's full text must go out through the
    // base path (active send), NOT the stale entry's residual under the old
    // turn's anchor — and turn 1's entry must survive for its own chain.
    await onResponseComplete(ch, 'test-chat', 'TURN-2-FULL', 'sess-1');

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    const body = mockSendQQMessage.mock.calls[0][3] as Record<string, unknown>;
    expect((body.markdown as Record<string, string>).content).toBe(
      'TURN-2-FULL',
    );
    // The base path has no anchor — it must not borrow msg-B (or msg-A).
    expect(body['msg_id']).toBeUndefined();
    // Turn 1's entry is left untouched for its deferred flush chain.
    expect(streamState(ch).get('sess-1')!.buffer).toBe('turn-1-residual');
    expect(streamState(ch).get('sess-1')!.turn).toBe(1);
    expect(pendingStreamDelete.has('sess-1')).toBe(true);
    // Turn 2's anchor is released (its reply already went out).
    expect(sessionAnchors.has('sess-1')).toBe(false);
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
    const flushingSessions = chp['flushingSessions'] as Set<string>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
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

    // Let the idle-flush send promise resolve
    resolveSend!(mockResponse(true));
    await drain();

    // Cleaned up
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
    expect(streamState(ch).has('sess-1')).toBe(false);
    expect(flushingSessions.has('sess-1')).toBe(false);
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

    // After retries exhausted, streamState is cleaned up
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(2000);
      await drain();
    }
    expect(streamState(ch).has('sess-1')).toBe(false);
    // Exhaustion releases the pending flag, the flushed record, and the
    // session's reply anchor.
    expect(pendingStreamDelete.has('sess-1')).toBe(false);
    expect(flushedSessions.has('sess-1')).toBe(false);
    expect(sessionAnchors.has('sess-1')).toBe(false);
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

  it("a superseded turn's permanent failure still cascades its msg_seq", async () => {
    const ch = makeChannel();
    let rejectSend: (err: Error) => void;
    const sendPromise = new Promise<MockResponse>((_r, rej) => {
      rejectSend = rej as (err: Error) => void;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

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
    // pendingStreamDelete): turn 1's state and flags are dropped, and a
    // fresh entry is created — but turn 1's send is still in flight with
    // its captured state object.
    onResponseChunk(ch, 'test-chat', 'turn-2', 'sess-1');
    expect(streamState(ch).get('sess-1')!.turn).toBe(2);
    expect(streamState(ch).get('sess-1')!.msgId).toBe('msg-B');

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
    // ...but the superseded turn's counter is no longer orphaned.
    expect(seqMap.has('msg-A')).toBe(false);
  });

  it('disconnect() clears all streaming state', () => {
    const ch = makeChannel();
    onResponseChunk(ch, 'test-chat', 'buffered', 'sess-1');

    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Set<string>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const flushedSessions = chp['flushedSessions'] as Set<string>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const turnCounter = chp['turnCounter'] as Map<string, number>;

    flushingSessions.add('sess-1');
    pendingStreamDelete.add('sess-1');
    flushedSessions.add('sess-1');
    sessionAnchors.set('sess-1', { msgId: 'msg-A', timestamp: Date.now() });
    turnCounter.set('sess-1', 3);

    (chp['disconnect'] as () => void)();

    expect(streamState(ch).size).toBe(0);
    expect(flushingSessions.size).toBe(0);
    expect(pendingStreamDelete.size).toBe(0);
    expect(flushedSessions.size).toBe(0);
    expect(sessionAnchors.size).toBe(0);
    expect(turnCounter.size).toBe(0);
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
    // The dead session's turn counter is dropped too.
    expect((chp['turnCounter'] as Map<string, number>).has('sess-1')).toBe(
      false,
    );
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

  it('re-buffers and re-arms the timer when the size cap is hit while a send is in flight', async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Set<string>;

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
    const flushingSessions = chp['flushingSessions'] as Set<string>;

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

    // Anchor the session so the re-flush chain's release is observable
    // (the anchor and its msg_seq must survive until the tail's send has
    // resolved its msg_seq from msgSeqMap, then be cascaded away).
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

describe('wenshao round-9: cancel/flush coordination (threads 29-36)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancel with a buffered residual while a send is in flight eventually delivers the tail (thread 31)', async () => {
    const ch = makeChannel();
    let resolveSend: (v: MockResponse) => void;
    const sendPromise = new Promise<MockResponse>((r) => {
      resolveSend = r;
    });
    mockSendQQMessage.mockReturnValue(sendPromise);

    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Set<string>;
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

  it('onPromptEnd defers a cancelled turn whose send is in flight so the tail keeps its anchor (thread 30)', async () => {
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

  it("keeps a cancelled turn's deferred residual when a new turn's chunk arrives (thread 33)", async () => {
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

    // Turn 2's next chunk starts fresh under its own anchor.
    onResponseChunk(ch, 'test-chat', ' turn-2-more', 'sess-1');
    const st = streamState(ch).get('sess-1')!;
    expect(st.buffer).toBe(' turn-2-more');
    expect(st.msgId).toBe('msg-B');
    expect(st.turn).toBe(2);

    // Clean up turn 2's idle flush.
    vi.advanceTimersByTime(2000);
    await drain();
  });

  it("a deferred proactive turn's flush does not erase the successor's anchor (thread 32)", async () => {
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

    // Proactive turn (cron/loop/webhook): no triggering message → no anchor.
    onPromptStart(ch, 'test-chat', 'sess-1');
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

  it('a transient failure during a cancelled turn preserves the residual accumulated during the in-flight send (thread 34)', async () => {
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

  it('onPromptEnd fallthrough releases the anchor and clears every structure when no stream is active (thread 36b)', () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const flushingSessions = chp['flushingSessions'] as Set<string>;
    const pendingStreamDelete = chp['pendingStreamDelete'] as Set<string>;
    const flushedSessions = chp['flushedSessions'] as Set<string>;
    const sessionAnchors = chp['sessionReplyMsgId'] as Map<
      string,
      { msgId: string; timestamp: number }
    >;
    const turnCounter = chp['turnCounter'] as Map<string, number>;
    const promptEnd = (ch: QQChannelClass, chatId: string, sessionId: string) =>
      (
        ch as unknown as { onPromptEnd: (c: string, s: string) => void }
      ).onPromptEnd(chatId, sessionId);

    // A prompt that never streamed (e.g. cancelled before the first chunk)
    // still leaves a stale anchor + turn counter; the fallthrough teardown
    // must release all four structures.
    sessionAnchors.set('sess-1', { msgId: 'msg-A', timestamp: Date.now() });
    turnCounter.set('sess-1', 1);

    promptEnd(ch, 'test-chat', 'sess-1');

    expect(streamState(ch).size).toBe(0);
    expect(flushingSessions.size).toBe(0);
    expect(pendingStreamDelete.size).toBe(0);
    expect(flushedSessions.size).toBe(0);
    expect(sessionAnchors.size).toBe(0);
    expect(turnCounter.size).toBe(0);
  });

  it('release with a mismatched expectedMsgId keeps the successor anchor but cascades the old seq (thread 36d)', () => {
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
});
