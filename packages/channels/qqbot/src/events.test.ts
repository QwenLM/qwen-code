import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSendQQMessage, mockFetchAccessToken, mockHandleInbound } =
  vi.hoisted(() => ({
    mockSendQQMessage: vi.fn(),
    mockFetchAccessToken: vi.fn(),
    mockHandleInbound: vi.fn(),
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
    protected handleInbound(env: unknown): Promise<void> {
      mockHandleInbound(env);
      return Promise.resolve();
    }
  },
  SessionRouter: class {
    restoreSessions(): Promise<void> {
      return Promise.resolve();
    }
  },
  getGlobalQwenDir: () => '/tmp/test-qwen',
  sanitizeLogText: (text: string, maxLen: number): string => {
    // Minimal sanitization for tests: escape control characters
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
    // Minimal sanitization for tests: strip brackets, CR/LF, control chars
    const cleaned = Array.from(name, (c) => {
      const cp = c.codePointAt(0)!;
      if (cp < 0x20 || cp === 0x7f) return ' ';
      if (c === '[' || c === ']') return ' ';
      return c;
    }).join('');
    return cleaned.trim().slice(0, 64) || 'unknown';
  },
  sanitizePromptText: (text: string): string => text,
}));

const { QQChannel } = await import('./QQChannel.js');
import type {
  QQMessageEvent,
  QQGroupMessageEvent,
  GroupAddRobotEvent,
  GroupDelRobotEvent,
  GroupMsgToggleEvent,
} from './types.js';

function makeChannel(
  configOverrides?: Record<string, unknown>,
): InstanceType<typeof QQChannel> {
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
      groupAllPolicy: 'log',
      keywordTriggers: ['help', '问答'],
      ...configOverrides,
    },
    {} as unknown as import('@qwen-code/channel-base').AcpBridge,
  );
  return ch;
}

type QQChannelRaw = Record<string, (...args: unknown[]) => unknown>;

function makeC2CEvent(overrides?: Partial<QQMessageEvent>): QQMessageEvent {
  return {
    id: 'msg-c2c-001',
    author: {
      user_openid: 'user-openid-1',
      id: 'user-legacy-1',
      username: 'Alice',
    },
    content: '你好，帮我查一下天气',
    ...overrides,
  };
}

function makeGroupEvent(
  overrides?: Partial<QQGroupMessageEvent>,
): QQGroupMessageEvent {
  return {
    id: 'msg-group-001',
    author: {
      member_openid: 'member-openid-1',
      user_openid: 'user-openid-1',
      username: 'Bob',
    },
    content: '<@OPENID_BOT> 你好',
    group_openid: 'group-openid-1',
    ...overrides,
  };
}

function makeGroupAllEvent(
  overrides?: Partial<QQGroupMessageEvent>,
): QQGroupMessageEvent {
  return {
    id: 'msg-groupall-001',
    author: {
      member_openid: 'member-openid-3',
      username: 'Charlie',
    },
    content: '大家早上好',
    group_openid: 'group-openid-1',
    mentions: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHandleInbound.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// isDuplicate
// ---------------------------------------------------------------------------
describe('isDuplicate', () => {
  it('首次消息不重复', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    expect(pvt['isDuplicate']('evt-001')).toBe(false);
  });

  it('相同 ID 第二次返回 true（重复）', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['isDuplicate']('evt-001');
    expect(pvt['isDuplicate']('evt-001')).toBe(true);
  });

  it('5 分钟后旧条目被清理，相同 ID 不再重复', () => {
    vi.setSystemTime(0);
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['isDuplicate']('evt-001');
    // advance past the 5-minute TTL (300s) + one 60s cleanup interval
    vi.advanceTimersByTime(360_001);
    expect(pvt['isDuplicate']('evt-001')).toBe(false);
  });

  it('自动启动 seenCleanupTimer', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    // seenCleanupTimer should be null before first call
    expect(
      (ch as unknown as Record<string, unknown>)['seenCleanupTimer'],
    ).toBeNull();
    pvt['isDuplicate']('evt-001');
    expect(
      (ch as unknown as Record<string, unknown>)['seenCleanupTimer'],
    ).not.toBeNull();
  });

  it('不同 ID 不重复', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    expect(pvt['isDuplicate']('evt-001')).toBe(false);
    expect(pvt['isDuplicate']('evt-002')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleC2C
// ---------------------------------------------------------------------------
describe('handleC2C', () => {
  it('设置 chatTypeMap 为 c2c', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleC2C'](makeC2CEvent());
    const chatTypeMap = (ch as unknown as Record<string, unknown>)[
      'chatTypeMap'
    ] as Map<string, string>;
    expect(chatTypeMap.get('user-openid-1')).toBe('c2c');
  });

  it('设置 replyMsgId（含 msgId + timestamp）', () => {
    const before = Date.now();
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleC2C'](makeC2CEvent());
    const replyMsgId = (ch as unknown as Record<string, unknown>)[
      'replyMsgId'
    ] as Map<string, { msgId: string; timestamp: number }>;
    const entry = replyMsgId.get('user-openid-1');
    expect(entry).toBeDefined();
    expect(entry!.msgId).toBe('msg-c2c-001');
    expect(entry!.timestamp).toBeGreaterThanOrEqual(before);
  });

  it('触发 handleInbound 带正确参数', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleC2C'](makeC2CEvent());
    // flush microtasks to let the .catch handler settle
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).toHaveBeenCalledTimes(1);
    const env = mockHandleInbound.mock.calls[0][0] as Record<string, unknown>;
    expect(env['isGroup']).toBe(false);
    expect(env['isMentioned']).toBe(true);
    expect(env['senderId']).toBe('user-openid-1');
    expect(env['chatId']).toBe('user-openid-1');
    expect(env['text']).toBe('[atMention=true] [Alice]: 你好，帮我查一下天气');
  });

  it('斜杠命令不包装 atMention', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleC2C'](makeC2CEvent({ content: '/help' }));
    await vi.advanceTimersByTimeAsync(600);
    const env = mockHandleInbound.mock.calls[0][0] as Record<string, unknown>;
    expect(env['text']).toBe('/help');
  });

  it('空消息（纯图片/贴纸）不触发 handleInbound', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleC2C'](makeC2CEvent({ content: '   ' }));
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).not.toHaveBeenCalled();
  });

  it('重复消息不触发 handleInbound', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    const evt = makeC2CEvent();
    pvt['handleC2C'](evt);
    pvt['handleC2C'](evt);
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).toHaveBeenCalledTimes(1);
  });

  it('作者名含 [ ] 字符时被清理', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleC2C'](
      makeC2CEvent({
        author: { user_openid: 'user-openid-2', username: '[GM] Eve' },
        content: 'hello',
      }),
    );
    await vi.advanceTimersByTimeAsync(600);
    const env = mockHandleInbound.mock.calls[0][0] as Record<string, unknown>;
    expect(env['text']).toBe('[atMention=true] [GM  Eve]: hello');
  });

  it('missing author 时不触发 handleInbound', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleC2C'](
      makeC2CEvent({ author: undefined } as Partial<QQMessageEvent>),
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleGroup
// ---------------------------------------------------------------------------
describe('handleGroup', () => {
  it('设置 chatTypeMap 为 group', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleGroup'](makeGroupEvent());
    const chatTypeMap = (ch as unknown as Record<string, unknown>)[
      'chatTypeMap'
    ] as Map<string, string>;
    expect(chatTypeMap.get('group-openid-1')).toBe('group');
  });

  it('设置 replyMsgId', () => {
    const before = Date.now();
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleGroup'](
      makeGroupEvent({
        mentions: [
          {
            member_openid: 'bot-openid',
            is_you: true,
            scope: 'single' as const,
          },
        ],
      }),
    );
    const replyMsgId = (ch as unknown as Record<string, unknown>)[
      'replyMsgId'
    ] as Map<string, { msgId: string; timestamp: number }>;
    const entry = replyMsgId.get('group-openid-1');
    expect(entry).toBeDefined();
    expect(entry!.msgId).toBe('msg-group-001');
    expect(entry!.timestamp).toBeGreaterThanOrEqual(before);
  });

  it('触发 handleInbound 带正确参数：isGroup=true, isMentioned=true', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleGroup'](
      makeGroupEvent({
        mentions: [
          {
            member_openid: 'bot-openid',
            is_you: true,
            scope: 'single' as const,
          },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).toHaveBeenCalledTimes(1);
    const env = mockHandleInbound.mock.calls[0][0] as Record<string, unknown>;
    expect(env['isGroup']).toBe(true);
    expect(env['isMentioned']).toBe(true);
    expect(env['isReplyToBot']).toBe(true);
    expect(env['chatId']).toBe('group-openid-1');
    // allowMention defaults to true — raw content (with <@OPENID> tags) is preserved
    expect(env['text']).toBe(
      '[atMention=true] [Bob(member-o…)]: <@OPENID_BOT> 你好',
    );
  });

  it('allowMention=false 时清理 <@OPENID> 标签', async () => {
    const ch = makeChannel({ allowMention: false });
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleGroup'](
      makeGroupEvent({
        content: '<@OPENID_BOT> 帮我翻译这段',
        mentions: [
          {
            member_openid: 'bot-openid',
            is_you: true,
            scope: 'single' as const,
          },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(600);
    const env = mockHandleInbound.mock.calls[0][0] as Record<string, unknown>;
    expect(env['text']).toBe('[atMention=true] [Bob(member-o…)]: 帮我翻译这段');
  });

  it('清理 <@OPENID> 标签后的空消息不触发', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleGroup'](makeGroupEvent({ content: '<@OPENID_BOT>   ' }));
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).not.toHaveBeenCalled();
  });

  it('斜杠命令不包装 atMention', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleGroup'](
      makeGroupEvent({
        content: '/status',
        mentions: [
          {
            member_openid: 'bot-openid',
            is_you: true,
            scope: 'single' as const,
          },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(600);
    const env = mockHandleInbound.mock.calls[0][0] as Record<string, unknown>;
    expect(env['text']).toBe('/status');
  });

  it('重复消息不触发', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    const evt = makeGroupEvent({ mentions: [{ is_you: true }] });
    pvt['handleGroup'](evt);
    pvt['handleGroup'](evt);
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).toHaveBeenCalledTimes(1);
  });

  it('缺失 group_openid 时直接 return', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleGroup'](
      makeGroupEvent({
        group_openid: undefined,
      } as Partial<QQGroupMessageEvent>),
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).not.toHaveBeenCalled();
  });

  it('@all (isAtBot=false) 时 handleGroup 直接 return，消息由 handleGroupAll 处理', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    // Pre-populate replyMsgId to verify it is NOT clobbered
    const replyMsgId = (ch as unknown as Record<string, unknown>)[
      'replyMsgId'
    ] as Map<string, { msgId: string; timestamp: number }>;
    replyMsgId.set('group-openid-1', { msgId: 'old-msg', timestamp: 0 });

    // Trigger handleGroup with @all mention (is_you: false)
    pvt['handleGroup'](
      makeGroupEvent({
        content: '<@all> 大家看看',
        mentions: [{ scope: 'all' as const, is_you: false }],
      }),
    );

    await vi.advanceTimersByTimeAsync(600);

    // handleGroup returns early for non-@bot messages — they go through handleGroupAll
    expect(mockHandleInbound).not.toHaveBeenCalled();

    // replyMsgId should NOT have been updated
    expect(replyMsgId.get('group-openid-1')!.msgId).toBe('old-msg');
  });

  it('groupActiveMsgEnabled=false 时不触发 handleInbound', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    const groupActiveMsgEnabled = (ch as unknown as Record<string, unknown>)[
      'groupActiveMsgEnabled'
    ] as Map<string, boolean>;
    groupActiveMsgEnabled.set('group-openid-1', false);

    pvt['handleGroup'](
      makeGroupEvent({
        mentions: [
          {
            member_openid: 'bot-openid',
            is_you: true,
            scope: 'single' as const,
          },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleGroupAll
// ---------------------------------------------------------------------------
describe('handleGroupAll', () => {
  it('默认 policy=log 时不触发 handleInbound', async () => {
    const ch = makeChannel(); // default groupAllPolicy='log'
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleGroupAll'](makeGroupAllEvent());
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).not.toHaveBeenCalled();
  });

  it('policy=log 时设置 chatTypeMap', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleGroupAll'](makeGroupAllEvent());
    const chatTypeMap = (ch as unknown as Record<string, unknown>)[
      'chatTypeMap'
    ] as Map<string, string>;
    expect(chatTypeMap.get('group-openid-1')).toBe('group');
  });

  it('policy=all 时触发 handleInbound', async () => {
    const ch = makeChannel({ groupAllPolicy: 'all' });
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleGroupAll'](makeGroupAllEvent({ content: 'hello world' }));
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).toHaveBeenCalledTimes(1);
    const env = mockHandleInbound.mock.calls[0][0] as Record<string, unknown>;
    expect(env['isGroup']).toBe(true);
    expect(env['text']).toContain('[atMention=false]');
  });

  it('policy=keyword 时只有匹配关键词才触发', async () => {
    const ch = makeChannel({
      groupAllPolicy: 'keyword',
      keywordTriggers: ['help', '问答'],
    });
    const pvt = ch as unknown as QQChannelRaw;

    // non-matching
    pvt['handleGroupAll'](makeGroupAllEvent({ content: 'hello world' }));
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).not.toHaveBeenCalled();

    mockHandleInbound.mockClear();

    // matching keyword 'help' (case-insensitive)
    pvt['handleGroupAll'](
      makeGroupAllEvent({ id: 'msg-002', content: '我需要 HELP' }),
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).toHaveBeenCalledTimes(1);
  });

  it('policy=keyword 时只有匹配中文关键词才触发', async () => {
    const ch = makeChannel({
      groupAllPolicy: 'keyword',
      keywordTriggers: ['问答'],
    });
    const pvt = ch as unknown as QQChannelRaw;

    pvt['handleGroupAll'](makeGroupAllEvent({ content: '有个问答想请教' }));
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).toHaveBeenCalledTimes(1);
  });

  it('isAtBot=false 时不设置 replyMsgId', () => {
    const ch = makeChannel({ groupAllPolicy: 'all' });
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleGroupAll'](
      makeGroupAllEvent({ content: 'hello', mentions: [] }),
    );
    const replyMsgId = (ch as unknown as Record<string, unknown>)[
      'replyMsgId'
    ] as Map<string, unknown>;
    expect(replyMsgId.has('group-openid-1')).toBe(false);
  });

  it('isAtBot=true 时设置 replyMsgId', () => {
    const ch = makeChannel({ groupAllPolicy: 'all' });
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleGroupAll'](
      makeGroupAllEvent({
        content: '<@OPENID_BOT> hello',
        mentions: [
          {
            member_openid: 'bot-openid',
            is_you: true,
            scope: 'single' as const,
          },
        ],
      }),
    );
    const replyMsgId = (ch as unknown as Record<string, unknown>)[
      'replyMsgId'
    ] as Map<string, { msgId: string; timestamp: number }>;
    const entry = replyMsgId.get('group-openid-1');
    expect(entry).toBeDefined();
    expect(entry!.msgId).toBe('msg-groupall-001');
  });

  it('斜杠命令（isAtBot + /prefix）用 cleanText 发送', async () => {
    const ch = makeChannel({ groupAllPolicy: 'all' });
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleGroupAll'](
      makeGroupAllEvent({
        content: '<@OPENID_BOT> /help',
        mentions: [
          {
            member_openid: 'bot-openid',
            is_you: true,
            scope: 'single' as const,
          },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(600);
    const env = mockHandleInbound.mock.calls[0][0] as Record<string, unknown>;
    // slash commands use cleanText (no atMention wrapper)
    expect(env['text']).toBe('/help');
  });

  it('bot 消息带有 [bot] 前缀透传给模型', async () => {
    const ch = makeChannel({ groupAllPolicy: 'all' });
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleGroupAll'](
      makeGroupAllEvent({
        content: 'auto reply',
        author: { member_openid: 'bot-1', bot: true },
      }),
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).toHaveBeenCalledTimes(1);
    const env = mockHandleInbound.mock.calls[0][0] as Record<string, unknown>;
    expect(env['text']).toContain('[bot]');
    expect(env['text']).toContain('auto reply');
  });

  it('groupActiveMsgEnabled=false 时被阻断', async () => {
    const ch = makeChannel({ groupAllPolicy: 'all' });
    const pvt = ch as unknown as QQChannelRaw;
    const groupActiveMsgEnabled = (ch as unknown as Record<string, unknown>)[
      'groupActiveMsgEnabled'
    ] as Map<string, boolean>;
    groupActiveMsgEnabled.set('group-openid-1', false);

    pvt['handleGroupAll'](makeGroupAllEvent({ content: 'hello' }));
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).not.toHaveBeenCalled();
  });

  it('重复消息不触发', async () => {
    const ch = makeChannel({ groupAllPolicy: 'all' });
    const pvt = ch as unknown as QQChannelRaw;
    const evt = makeGroupAllEvent({ content: 'hello' });
    pvt['handleGroupAll'](evt);
    pvt['handleGroupAll'](evt);
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).toHaveBeenCalledTimes(1);
  });

  it('isAtBot=false 时的 text 格式正确', async () => {
    const ch = makeChannel({ groupAllPolicy: 'all' });
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleGroupAll'](
      makeGroupAllEvent({ content: 'hello world', mentions: [] }),
    );
    await vi.advanceTimersByTimeAsync(600);
    const env = mockHandleInbound.mock.calls[0][0] as Record<string, unknown>;
    expect(env['text']).toBe(
      '[atMention=false] [Charlie(member-o…)]: hello world',
    );
  });
});

// ---------------------------------------------------------------------------
// 群管理事件
// ---------------------------------------------------------------------------
describe('群管理事件', () => {
  describe('handleGroupAddRobot', () => {
    it('设置 chatTypeMap', () => {
      const ch = makeChannel();
      const pvt = ch as unknown as QQChannelRaw;
      const evt: GroupAddRobotEvent = {
        group_openid: 'group-new-1',
        op_member_openid: 'admin-1',
        timestamp: Date.now(),
      };
      pvt['handleGroupAddRobot'](evt);
      const chatTypeMap = (ch as unknown as Record<string, unknown>)[
        'chatTypeMap'
      ] as Map<string, string>;
      expect(chatTypeMap.get('group-new-1')).toBe('group');
    });
  });

  describe('handleGroupDelRobot', () => {
    it('清理 chatTypeMap, groupActiveMsgEnabled, replyMsgId, streamState', () => {
      const ch = makeChannel();
      const pvt = ch as unknown as QQChannelRaw;

      // pre-populate state
      const chatTypeMap = (ch as unknown as Record<string, unknown>)[
        'chatTypeMap'
      ] as Map<string, string>;
      const replyMsgId = (ch as unknown as Record<string, unknown>)[
        'replyMsgId'
      ] as Map<string, { msgId: string; timestamp: number }>;
      const streamState = (ch as unknown as Record<string, unknown>)[
        'streamState'
      ] as Map<
        string,
        { chatId: string; timer: ReturnType<typeof setTimeout> | null }
      >;
      const groupActiveMsgEnabled = (ch as unknown as Record<string, unknown>)[
        'groupActiveMsgEnabled'
      ] as Map<string, boolean>;

      chatTypeMap.set('group-del-1', 'group');
      replyMsgId.set('group-del-1', {
        msgId: 'msg-xyz',
        timestamp: Date.now(),
      });
      streamState.set('sid-1', { chatId: 'group-del-1', timer: null });
      groupActiveMsgEnabled.set('group-del-1', true);

      const evt: GroupDelRobotEvent = {
        group_openid: 'group-del-1',
        op_member_openid: 'admin-1',
        timestamp: Date.now(),
      };
      pvt['handleGroupDelRobot'](evt);

      expect(chatTypeMap.has('group-del-1')).toBe(false);
      expect(replyMsgId.has('group-del-1')).toBe(false);
      expect(streamState.has('sid-1')).toBe(false);
      expect(groupActiveMsgEnabled.has('group-del-1')).toBe(false);
    });

    it('清理时取消 streamState 中的 timer', () => {
      const ch = makeChannel();
      const pvt = ch as unknown as QQChannelRaw;

      const streamState = (ch as unknown as Record<string, unknown>)[
        'streamState'
      ] as Map<
        string,
        { chatId: string; timer: ReturnType<typeof setTimeout> | null }
      >;
      const spy = vi.spyOn(globalThis, 'clearTimeout');
      streamState.set('sid-timer', {
        chatId: 'group-del-2',
        timer: setTimeout(() => {}, 9999),
      });

      const evt: GroupDelRobotEvent = {
        group_openid: 'group-del-2',
        op_member_openid: 'admin-1',
        timestamp: Date.now(),
      };
      pvt['handleGroupDelRobot'](evt);

      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('handleGroupMsgReject', () => {
    it('设置 groupActiveMsgEnabled=false', () => {
      const ch = makeChannel();
      const pvt = ch as unknown as QQChannelRaw;

      const groupActiveMsgEnabled = (ch as unknown as Record<string, unknown>)[
        'groupActiveMsgEnabled'
      ] as Map<string, boolean>;
      groupActiveMsgEnabled.set('group-reject-1', true);

      const evt: GroupMsgToggleEvent = {
        group_openid: 'group-reject-1',
        op_member_openid: 'admin-1',
        timestamp: Date.now(),
      };
      pvt['handleGroupMsgReject'](evt);
      expect(groupActiveMsgEnabled.get('group-reject-1')).toBe(false);
    });
  });

  describe('handleGroupMsgReceive', () => {
    it('设置 groupActiveMsgEnabled=true', () => {
      const ch = makeChannel();
      const pvt = ch as unknown as QQChannelRaw;

      const groupActiveMsgEnabled = (ch as unknown as Record<string, unknown>)[
        'groupActiveMsgEnabled'
      ] as Map<string, boolean>;
      groupActiveMsgEnabled.set('group-recv-1', false);

      const evt: GroupMsgToggleEvent = {
        group_openid: 'group-recv-1',
        op_member_openid: 'admin-1',
        timestamp: Date.now(),
      };
      pvt['handleGroupMsgReceive'](evt);
      expect(groupActiveMsgEnabled.get('group-recv-1')).toBe(true);
    });
  });
});
