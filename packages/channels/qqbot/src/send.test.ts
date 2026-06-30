import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isValidChatId } from './QQChannel.js';
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

describe('sendMessage', () => {
  /** Construct a QQChannel with internal state pre-configured for sendMessage. */
  function makeChannel(overrides?: {
    disposed?: boolean;
    chatType?: 'c2c' | 'group';
    replyMsgId?: string;
    tokenExpiresAt?: number;
    accessToken?: string;
    groupActiveMsgEnabled?: boolean;
  }): QQChannelClass {
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
    chp['accessToken'] = overrides?.accessToken ?? 'test-token';
    chp['tokenExpiresAt'] = overrides?.tokenExpiresAt ?? Date.now() + 3600_000;
    if (overrides?.disposed) chp['disposed'] = true;

    if (overrides?.groupActiveMsgEnabled !== undefined) {
      (chp['groupActiveMsgEnabled'] as Map<string, boolean>).set(
        'test-chat-id',
        overrides.groupActiveMsgEnabled,
      );
    }

    if (overrides?.chatType) {
      (chp['chatTypeMap'] as Map<string, string>).set(
        'test-chat-id',
        overrides.chatType,
      );
    }
    if (overrides?.replyMsgId) {
      (
        chp['replyMsgId'] as Map<string, { msgId: string; timestamp: number }>
      ).set('test-chat-id', {
        msgId: overrides.replyMsgId,
        timestamp: Date.now(),
      });
    }

    return ch;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQQMessage.mockResolvedValue(mockResponse(true));
    mockFetchAccessToken.mockResolvedValue({
      accessToken: 'refreshed-token',
      expiresIn: 7200,
    });
  });

  it('sends plain text to C2C chat with msg_type=2', async () => {
    const ch = makeChannel({ chatType: 'c2c' });
    await ch.sendMessage('test-chat-id', 'hello');

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(mockSendQQMessage).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat-id/messages',
      'test-token',
      { markdown: { content: 'hello' }, msg_type: 2 },
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
      { markdown: { content: 'hello' }, msg_type: 2 },
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

  it('does not retry on plain-text send failure', async () => {
    const ch = makeChannel({ chatType: 'c2c' });
    mockSendQQMessage.mockResolvedValue(mockResponse(false, 500));

    await ch.sendMessage('test-chat-id', 'hello');

    // Two attempts — first markdown fails, then retried as plain text
    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
  });

  it('returns early when disposed', async () => {
    const ch = makeChannel({ disposed: true, chatType: 'c2c' });
    await ch.sendMessage('test-chat-id', 'hello');

    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('defaults to C2C path for unknown chatId', async () => {
    const ch = makeChannel(); // no chatType set → not group → C2C path
    await ch.sendMessage('unknown-chat', 'hello');

    expect(mockSendQQMessage).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com',
      '/v2/users/unknown-chat/messages',
      'test-token',
      { markdown: { content: 'hello' }, msg_type: 2 },
    );
  });

  it('returns early when chatId fails SSRF validation', async () => {
    const ch = makeChannel({ chatType: 'c2c' });
    await ch.sendMessage('../traversal', 'hello');

    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('returns early when token expired and refresh fails', async () => {
    const ch = makeChannel({
      chatType: 'c2c',
      tokenExpiresAt: Date.now() - 1000,
    });
    mockFetchAccessToken.mockRejectedValue(new Error('auth failed'));

    await ch.sendMessage('test-chat-id', 'hello');

    expect(mockSendQQMessage).not.toHaveBeenCalled();
    expect(mockFetchAccessToken).toHaveBeenCalled();
  });

  it('catches thrown sendQQMessage errors and stops sending', async () => {
    const ch = makeChannel({ chatType: 'c2c' });
    mockSendQQMessage.mockRejectedValue(new Error('network down'));

    await ch.sendMessage('test-chat-id', 'hello');

    // No crash, and the catch+break prevents further attempts
    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
  });

  it('includes msg_id and msg_seq when replyMsgId is set', async () => {
    const ch = makeChannel({ chatType: 'c2c', replyMsgId: 'msg-456' });
    await ch.sendMessage('test-chat-id', 'hello');

    expect(mockSendQQMessage).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat-id/messages',
      'test-token',
      {
        markdown: { content: 'hello' },
        msg_id: 'msg-456',
        msg_seq: 1,
        msg_type: 2,
      },
    );
  });

  it('sends single request even for long text (no splitting)', async () => {
    const ch = makeChannel({ chatType: 'c2c', replyMsgId: 'msg-789' });
    const text = 'a'.repeat(4500);
    await ch.sendMessage('test-chat-id', text);

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
    expect(mockSendQQMessage).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat-id/messages',
      'test-token',
      {
        markdown: { content: text },
        msg_id: 'msg-789',
        msg_seq: 1,
        msg_type: 2,
      },
    );
  });

  // --- Boundary: resolveRoute token refresh success ---

  it('refreshes token and sends when tokenExpiresAt is expired and refresh succeeds', async () => {
    const ch = makeChannel({
      chatType: 'c2c',
      tokenExpiresAt: Date.now() - 1000,
    });
    mockFetchAccessToken.mockResolvedValue({
      accessToken: 'refreshed-token',
      expiresIn: 7200,
    });

    await ch.sendMessage('test-chat-id', 'hello');

    expect(mockFetchAccessToken).toHaveBeenCalled();
    expect(mockSendQQMessage).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat-id/messages',
      'refreshed-token',
      { markdown: { content: 'hello' }, msg_type: 2 },
    );
  });

  // --- Boundary: groupActiveMsgEnabled blocks ---

  it('returns early without sending when groupActiveMsgEnabled is false', async () => {
    const ch = makeChannel({
      chatType: 'group',
      groupActiveMsgEnabled: false,
    });

    await ch.sendMessage('test-chat-id', 'hello');

    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  it('sends normally when groupActiveMsgEnabled is true', async () => {
    const ch = makeChannel({
      chatType: 'group',
      groupActiveMsgEnabled: true,
    });

    await ch.sendMessage('test-chat-id', 'hello');

    expect(mockSendQQMessage).toHaveBeenCalledTimes(1);
  });

  // --- Boundary: msgSeq increments across consecutive sends ---

  it('increments msg_seq on consecutive sendMessage calls with same replyMsgId', async () => {
    const ch = makeChannel({ chatType: 'c2c', replyMsgId: 'msg-999' });

    await ch.sendMessage('test-chat-id', 'first');
    await ch.sendMessage('test-chat-id', 'second');

    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
    expect(mockSendQQMessage).toHaveBeenNthCalledWith(
      1,
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat-id/messages',
      'test-token',
      {
        markdown: { content: 'first' },
        msg_id: 'msg-999',
        msg_seq: 1,
        msg_type: 2,
      },
    );
    expect(mockSendQQMessage).toHaveBeenNthCalledWith(
      2,
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat-id/messages',
      'test-token',
      {
        markdown: { content: 'second' },
        msg_id: 'msg-999',
        msg_seq: 2,
        msg_type: 2,
      },
    );
  });

  // --- Boundary: replyMsgId older than 5 minutes ---

  it('sends without msg_id when replyMsgId is older than 5 minutes', async () => {
    const ch = makeChannel({ chatType: 'c2c' });
    const chp = ch as unknown as Record<string, unknown>;
    // Set replyMsgId with a timestamp older than 5 minutes
    (
      chp['replyMsgId'] as Map<string, { msgId: string; timestamp: number }>
    ).set('test-chat-id', {
      msgId: 'msg-old',
      timestamp: Date.now() - 300_001,
    });

    await ch.sendMessage('test-chat-id', 'hello');

    expect(mockSendQQMessage).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com',
      '/v2/users/test-chat-id/messages',
      'test-token',
      { markdown: { content: 'hello' }, msg_type: 2 },
    );
    // No msg_id / msg_seq should be present
    const callArgs = mockSendQQMessage.mock.calls[0];
    const body = callArgs[3] as Record<string, unknown>;
    expect(body['msg_id']).toBeUndefined();
    expect(body['msg_seq']).toBeUndefined();
  });

  // --- Boundary: <noreply> text ---

  it('returns early without sending when text is <noreply>', async () => {
    const ch = makeChannel({ chatType: 'c2c' });

    await ch.sendMessage('test-chat-id', '<noreply>');

    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  // --- Boundary: SSRF failure + no accessToken ---

  it('returns null from resolveRoute when chatId fails SSRF and accessToken is empty', async () => {
    const ch = makeChannel({ accessToken: '' });

    await ch.sendMessage('../traversal', 'hello');

    expect(mockSendQQMessage).not.toHaveBeenCalled();
  });

  // --- Boundary: both markdown and plain text fail ---

  it('does not crash when both markdown and plain text fallback fail', async () => {
    const ch = makeChannel({ chatType: 'c2c' });
    mockSendQQMessage.mockResolvedValue(
      mockResponse(false, 400, 'bad request'),
    );

    await ch.sendMessage('test-chat-id', '**bold**');

    // Two attempts: markdown, then plain text. No crash.
    expect(mockSendQQMessage).toHaveBeenCalledTimes(2);
  });
});

// Security: verify real sanitizers from channel-base strip dangerous characters.
// These use vi.importActual to bypass the module-level mock and exercise
// the real implementations — guarding against regression if the mock ever
// drifts from the real sanitizers.

describe('sanitizeSenderName (real)', () => {
  it('strips ANSI escape sequences', async () => {
    const actual = await vi.importActual<
      typeof import('@qwen-code/channel-base')
    >('@qwen-code/channel-base');
    const result = actual.sanitizeSenderName('\x1B[31mred\x1B[0m');
    expect(result).not.toContain('\x1B');
  });

  it('strips bidi override characters (LRE/RLE)', async () => {
    const actual = await vi.importActual<
      typeof import('@qwen-code/channel-base')
    >('@qwen-code/channel-base');
    const result = actual.sanitizeSenderName('\u202Aevil\u202C');
    expect(result).not.toContain('\u202A');
    expect(result).not.toContain('\u202E');
  });

  it('strips NEL control character (U+0085)', async () => {
    const actual = await vi.importActual<
      typeof import('@qwen-code/channel-base')
    >('@qwen-code/channel-base');
    // NEL = Next Line (Unicode line break), should not pass through
    const result = actual.sanitizeSenderName('before\u0085after');
    expect(result).not.toContain('\u0085');
  });

  it('strips embedded newlines (\\n and \\r)', async () => {
    const actual = await vi.importActual<
      typeof import('@qwen-code/channel-base')
    >('@qwen-code/channel-base');
    const result = actual.sanitizeSenderName('line1\nline2\rline3');
    expect(result).not.toContain('\n');
    expect(result).not.toContain('\r');
  });

  it('passes through safe ASCII names unchanged', async () => {
    const actual = await vi.importActual<
      typeof import('@qwen-code/channel-base')
    >('@qwen-code/channel-base');
    const result = actual.sanitizeSenderName('NormalUser-123');
    expect(result).toBe('NormalUser-123');
  });
});

describe('sanitizeLogText (real)', () => {
  it('strips ANSI escape sequences', async () => {
    const actual = await vi.importActual<
      typeof import('@qwen-code/channel-base')
    >('@qwen-code/channel-base');
    const result = actual.sanitizeLogText('\x1B[31merror\x1B[0m', 64);
    expect(result).not.toContain('\x1B');
  });

  it('strips bidi override characters', async () => {
    const actual = await vi.importActual<
      typeof import('@qwen-code/channel-base')
    >('@qwen-code/channel-base');
    const result = actual.sanitizeLogText('\u202Eflipped\u202C', 64);
    expect(result).not.toContain('\u202E');
    expect(result).not.toContain('\u202A');
  });

  it('strips NEL control character (U+0085)', async () => {
    const actual = await vi.importActual<
      typeof import('@qwen-code/channel-base')
    >('@qwen-code/channel-base');
    const result = actual.sanitizeLogText('log\u0085injection', 64);
    expect(result).not.toContain('\u0085');
  });

  it('escapes embedded newlines instead of passing them raw', async () => {
    const actual = await vi.importActual<
      typeof import('@qwen-code/channel-base')
    >('@qwen-code/channel-base');
    const result = actual.sanitizeLogText('line1\nline2', 64);
    // Real newlines in log text should be escaped, not passed through raw
    expect(result).not.toContain('\n');
    // The escape character \\n may appear as the literal string "\n"
    expect(result).toContain('\\n');
  });

  it('passes through safe text unchanged', async () => {
    const actual = await vi.importActual<
      typeof import('@qwen-code/channel-base')
    >('@qwen-code/channel-base');
    const result = actual.sanitizeLogText('Normal log message', 64);
    expect(result).toBe('Normal log message');
  });
});
