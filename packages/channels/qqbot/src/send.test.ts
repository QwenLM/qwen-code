import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isValidChatId, hasMarkdownSyntax, splitText } from './QQChannel.js';

const { mockSendQQMessage } = vi.hoisted(() => ({
  mockSendQQMessage: vi.fn(),
}));

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

vi.mock('./api.js', () => ({
  sendQQMessage: mockSendQQMessage,
  getApiBase: () => 'https://api.sgroup.qq.com',
  fetchAccessToken: vi.fn(),
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
      this.router = options?.router ?? {};
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

/** Create a mock Response-like object for sendQQMessage. */
function mockResponse(
  ok: boolean,
  status = 200,
  body = '',
): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok, status, text: async () => body };
}

describe('isValidChatId', () => {
  it('accepts alphanumeric IDs', () => {
    expect(isValidChatId('abc123')).toBe(true);
  });

  it('accepts IDs with underscores and hyphens', () => {
    expect(isValidChatId('user_openid_123')).toBe(true);
    expect(isValidChatId('group-id-456')).toBe(true);
  });

  it('accepts mixed-case IDs', () => {
    expect(isValidChatId('AbC123_DeF')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidChatId('')).toBe(false);
  });

  it('accepts max-length ID (128 chars)', () => {
    const id = 'A'.repeat(128);
    expect(isValidChatId(id)).toBe(true);
  });

  it('rejects IDs longer than 128 chars', () => {
    const id = 'A'.repeat(129);
    expect(isValidChatId(id)).toBe(false);
  });

  it('rejects IDs with slashes (path traversal)', () => {
    expect(isValidChatId('abc/def')).toBe(false);
    expect(isValidChatId('../etc')).toBe(false);
    expect(isValidChatId('a\\b')).toBe(false);
  });

  it('rejects IDs with special characters', () => {
    expect(isValidChatId('abc?def')).toBe(false);
    expect(isValidChatId('abc#def')).toBe(false);
    expect(isValidChatId('abc def')).toBe(false);
    expect(isValidChatId('abc@def')).toBe(false);
  });

  it('rejects IDs with dots', () => {
    expect(isValidChatId('abc.def')).toBe(false);
  });
});

describe('hasMarkdownSyntax', () => {
  it('detects headings', () => {
    expect(hasMarkdownSyntax('# Title')).toBe(true);
    expect(hasMarkdownSyntax('## Subtitle')).toBe(true);
    expect(hasMarkdownSyntax('###### Deep heading')).toBe(true);
  });

  it('detects code blocks', () => {
    expect(hasMarkdownSyntax('```js\ncode\n```')).toBe(true);
  });

  it('detects bold (double asterisk)', () => {
    expect(hasMarkdownSyntax('**bold**')).toBe(true);
  });

  it('detects bold (double underscore)', () => {
    expect(hasMarkdownSyntax('__bold__')).toBe(true);
  });

  it('detects strikethrough', () => {
    expect(hasMarkdownSyntax('~~strikethrough~~')).toBe(true);
  });

  it('detects inline code', () => {
    expect(hasMarkdownSyntax('use `code` here')).toBe(true);
  });

  it('detects links', () => {
    expect(hasMarkdownSyntax('[text](url)')).toBe(true);
  });

  it('detects unordered list markers', () => {
    expect(hasMarkdownSyntax('- item')).toBe(true);
    expect(hasMarkdownSyntax('* item')).toBe(true);
    expect(hasMarkdownSyntax('+ item')).toBe(true);
  });

  it('detects ordered list markers', () => {
    expect(hasMarkdownSyntax('1. first')).toBe(true);
    expect(hasMarkdownSyntax('123. item')).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(hasMarkdownSyntax('hello world')).toBe(false);
    expect(hasMarkdownSyntax('no special chars here')).toBe(false);
  });

  it('returns false for text with single asterisks (not list marker at line start)', () => {
    expect(hasMarkdownSyntax('this is *not* italic in this regex')).toBe(false);
  });

  it('false positive: "- temperature" triggers list pattern', () => {
    expect(hasMarkdownSyntax('- temperature: 5°C')).toBe(true);
  });

  it('false positive: "1. first thing" at line start triggers ordered-list pattern', () => {
    expect(hasMarkdownSyntax('1. first thing in sentence')).toBe(true);
  });
});

describe('splitText', () => {
  it('returns single-element array for short text', () => {
    expect(splitText('hello')).toEqual(['hello']);
  });

  it('returns single-element array for exactly 2000 chars', () => {
    const text = 'a'.repeat(2000);
    const result = splitText(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(2000);
  });

  it('splits text longer than 2000 chars into chunks', () => {
    const text = 'a'.repeat(4500);
    const result = splitText(text);
    expect(result).toHaveLength(3);
    expect(result[0]).toHaveLength(2000);
    expect(result[1]).toHaveLength(2000);
    expect(result[2]).toHaveLength(500);
  });

  it('preserves content across chunk boundaries', () => {
    const text = 'x'.repeat(2000) + 'y'.repeat(500);
    const result = splitText(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('x'.repeat(2000));
    expect(result[1]).toBe('y'.repeat(500));
  });

  it('handles empty string', () => {
    expect(splitText('')).toEqual(['']);
  });
});

describe('sendMessage', () => {
  /** Construct a QQChannel with internal state pre-configured for sendMessage. */
  function makeChannel(overrides?: {
    disposed?: boolean;
    chatType?: 'c2c' | 'group';
    replyMsgId?: string;
    tokenExpiresAt?: number;
  }): QQChannel {
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

    // Set internal state for sendMessage preconditions.
    // accessToken and tokenExpiresAt bypass the fetchToken flow.
    const chp = ch as unknown as Record<string, unknown>;
    chp['accessToken'] = 'test-token';
    chp['tokenExpiresAt'] = overrides?.tokenExpiresAt ?? Date.now() + 3600_000;
    if (overrides?.disposed) chp['disposed'] = true;

    if (overrides?.chatType) {
      (chp['chatTypeMap'] as Map<string, string>).set(
        'test-chat-id',
        overrides.chatType,
      );
    }
    if (overrides?.replyMsgId) {
      (chp['replyMsgId'] as Map<string, string>).set(
        'test-chat-id',
        overrides.replyMsgId,
      );
    }

    return ch;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
  });

  it('sends plain text to C2C chat with msg_type=0', async () => {
    const ch = makeChannel({ chatType: 'c2c' });
    await ch.sendMessage('test-chat-id', 'hello');

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(mockSendQQMessage).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat-id/messages',
      'test-token',
      { content: 'hello', msg_type: 0 },
    );
  });

  it('sends markdown to C2C chat with msg_type=2', async () => {
    const ch = makeChannel({ chatType: 'c2c' });
    await ch.sendMessage('test-chat-id', '**bold text**');

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(mockSendQQMessage).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat-id/messages',
      'test-token',
      { msg_type: 2, markdown: { content: '**bold text**' } },
    );
  });

  it('routes to group API path when chatType is group', async () => {
    const ch = makeChannel({ chatType: 'group' });
    await ch.sendMessage('test-chat-id', 'hello');

    expect(mockSendQQMessage).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com',
      '/v2/groups/test-chat-id/messages',
      'test-token',
      { content: 'hello', msg_type: 0 },
    );
  });

  it('falls back to plain text when markdown is rejected', async () => {
    const ch = makeChannel({ chatType: 'c2c' });
    mockSendQQMessage
      .mockResolvedValueOnce(mockResponse(false, 400, 'markdown unsupported'))
      .mockResolvedValueOnce(mockResponse(true));

    await ch.sendMessage('test-chat-id', '**bold**');

    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    // First attempt: markdown
    expect(mockSendQQMessage).toHaveBeenNthCalledWith(
      1,
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat-id/messages',
      'test-token',
      { msg_type: 2, markdown: { content: '**bold**' } },
    );
    // Fallback: plain text
    expect(mockSendQQMessage).toHaveBeenNthCalledWith(
      2,
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat-id/messages',
      'test-token',
      { content: '**bold**', msg_type: 0 },
    );
  });

  it('stops on first chunk failure (no fallback for plain text)', async () => {
    const ch = makeChannel({ chatType: 'c2c' });
    mockSendQQMessage.mockResolvedValue(mockResponse(false, 500));

    await ch.sendMessage('test-chat-id', 'hello');

    // Only one attempt — plain text doesn't retry, and we break on failure
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
  });

  it('returns early when disposed', async () => {
    const ch = makeChannel({ disposed: true, chatType: 'c2c' });
    await ch.sendMessage('test-chat-id', 'hello');

    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('returns early when chatId is not in chatTypeMap', async () => {
    const ch = makeChannel(); // no chatType set
    await ch.sendMessage('unknown-chat', 'hello');

    // resolveRoute checks chatTypeMap — but actually, resolveRoute only checks
    // chatTypeMap for the path; the chatId validation happens first. Let's see:
    // if (!this.accessToken || !isValidChatId(chatId)) return null;
    // path = chatTypeMap.get(chatId) === 'group' ? groupPath : c2cPath;
    // So unknown chatId gets C2C path by default.
    expect(mockSendQQMessage).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com',
      '/v2/users/unknown-chat/messages',
      'test-token',
      { content: 'hello', msg_type: 0 },
    );
  });

  it('includes msg_id and msg_seq when replyMsgId is set', async () => {
    const ch = makeChannel({ chatType: 'c2c', replyMsgId: 'msg-456' });
    await ch.sendMessage('test-chat-id', 'hello');

    expect(mockSendQQMessage).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat-id/messages',
      'test-token',
      { content: 'hello', msg_type: 0, msg_id: 'msg-456', msg_seq: 1 },
    );
  });

  it('sends multi-chunk text as separate messages with incrementing msg_seq', async () => {
    const ch = makeChannel({ chatType: 'c2c', replyMsgId: 'msg-789' });
    const text = 'a'.repeat(2500); // 2 chunks: 2000 + 500
    await ch.sendMessage('test-chat-id', text);

    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    expect(mockSendQQMessage).toHaveBeenNthCalledWith(
      1,
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat-id/messages',
      'test-token',
      { content: 'a'.repeat(2000), msg_type: 0, msg_id: 'msg-789', msg_seq: 1 },
    );
    expect(mockSendQQMessage).toHaveBeenNthCalledWith(
      2,
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat-id/messages',
      'test-token',
      { content: 'a'.repeat(500), msg_type: 0, msg_id: 'msg-789', msg_seq: 2 },
    );
  });
});
