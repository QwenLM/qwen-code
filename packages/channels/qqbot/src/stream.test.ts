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
    protected getResponseMessageId(_sessionId: string): string | undefined {
      return undefined;
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
      outputMode: 'process_and_result',
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

function onResponseChunk(
  ch: QQChannelClass,
  chatId: string,
  text: string,
  sessionId: string,
): void {
  (
    ch as unknown as { onResponseChunk(c: string, t: string, s: string): void }
  ).onResponseChunk(chatId, text, sessionId);
}
function onResponseComplete(
  ch: QQChannelClass,
  chatId: string,
  text: string,
  sessionId: string,
  sourceLabel?: string,
): Promise<void> {
  return (
    ch as unknown as {
      onResponseComplete(
        c: string,
        t: string,
        s: string,
        segment?: { sourceLabel: string },
      ): Promise<void>;
    }
  ).onResponseComplete(
    chatId,
    text,
    sessionId,
    sourceLabel ? { sourceLabel } : undefined,
  );
}

describe('complete request responses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
  });
  afterEach(() => vi.useRealTimers());
  it.each([false, true])(
    'does not send partial chunks in detailed=%s mode',
    async (detailed) => {
      const channel = makeChannel({
        outputMode: detailed ? 'process_and_result' : 'final_only',
      });
      onResponseChunk(channel, 'test-chat', 'Partial output', 's-1');
      onResponseChunk(channel, 'test-chat', 'x'.repeat(5000), 's-1');
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockSendQQMessage).not.toHaveBeenCalled();
      await onResponseComplete(
        channel,
        'test-chat',
        'Complete answer with all evidence',
        's-1',
      );
      expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
      expect(mockSendQQMessage.mock.calls[0][3].markdown.content).toBe(
        'Complete answer with all evidence',
      );
    },
  );
  it('sends each complete detailed response once without replaying chunks', async () => {
    const channel = makeChannel({ outputMode: 'process_and_result' });
    onResponseChunk(channel, 'test-chat', 'first draft', 's-1');
    await onResponseComplete(
      channel,
      'test-chat',
      'First complete answer',
      's-1',
    );
    onResponseChunk(channel, 'test-chat', 'second draft', 's-1');
    await onResponseComplete(
      channel,
      'test-chat',
      'Second complete answer',
      's-1',
    );
    expect(
      mockSendQQMessage.mock.calls.map((call) => call[3].markdown.content),
    ).toEqual(['First complete answer', 'Second complete answer']);
  });
  it('does not add an empty final response', async () => {
    const channel = makeChannel();
    await onResponseComplete(channel, 'test-chat', '   ', 's-1');
    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });
  it('preserves escaped source labels on full responses', async () => {
    const channel = makeChannel();
    await onResponseComplete(
      channel,
      'test-chat',
      'Answer',
      's-1',
      '[review_*]',
    );
    expect(mockSendQQMessage.mock.calls[0][3].markdown.content).toContain(
      'Answer',
    );
    expect(mockSendQQMessage.mock.calls[0][3].markdown.content).toContain(
      'review',
    );
  });
});
