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
    protected onSessionDied(_sessionId: string): void {
      // no-op in mock
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
import { Intent } from './types.js';

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
      member_openid: 'ABCDEF012345',
      user_openid: 'ABCDEF012345',
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
      member_openid: 'FEDCBA987654',
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
    vi.advanceTimersByTime(360_001);
    expect(pvt['isDuplicate']('evt-001')).toBe(false);
  });

  it('自动启动 seenCleanupTimer', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
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

  it('设置 replyMsgId', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleC2C'](makeC2CEvent());
    const replyMsgId = (ch as unknown as Record<string, unknown>)[
      'replyMsgId'
    ] as Map<string, { msgId: string; timestamp: number }>;
    const entry = replyMsgId.get('user-openid-1');
    expect(entry?.msgId).toBe('msg-c2c-001');
  });

  it('触发 handleInbound 带正确参数', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleC2C'](makeC2CEvent());
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

  it('drops bot C2C messages', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleC2C'](
      makeC2CEvent({ author: { bot: true, user_openid: 'bot-1' } }),
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
    expect(entry?.msgId).toBe('msg-group-001');
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
    // allowMention defaults to true
    expect(env['text']).toBe(
      '[atMention=true] [Bob(ABCDEF01…)]: <@OPENID_BOT> 你好',
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
    // allowMention=false; senderOpenId still displayed
    expect(env['text']).toBe('[atMention=true] [Bob(ABCDEF01…)]: 帮我翻译这段');
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

  it('@all (isAtBot=false) with no mentions defaults to isAtBot=true for GROUP_AT_MESSAGE_CREATE', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    const replyMsgId = (ch as unknown as Record<string, unknown>)[
      'replyMsgId'
    ] as Map<string, { msgId: string; timestamp: number }>;
    replyMsgId.set('group-openid-1', { msgId: 'old-msg', timestamp: 0 });

    pvt['handleGroup'](
      makeGroupEvent({
        content: '<@all> 大家看看',
        mentions: undefined,
      }),
    );

    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).toHaveBeenCalledTimes(1);
    const env = mockHandleInbound.mock.calls[0][0] as Record<string, unknown>;
    expect(env['isMentioned']).toBe(true);
    expect(env['text']).toContain('[atMention=true]');
    expect(replyMsgId.get('group-openid-1')?.msgId).toBe('msg-group-001');
  });

  it('groupActiveMsgEnabled=false 时 @bot 消息仍能通过（被动回复）', async () => {
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
    expect(mockHandleInbound).toHaveBeenCalledTimes(1);
  });

  it('bot 消息被 handleGroup 跳过（event.author.bot 守卫）', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleGroup'](
      makeGroupEvent({
        content: '<@OPENID_BOT> auto reply',
        author: {
          member_openid: 'bot-1',
          bot: true,
        },
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
    const ch = makeChannel();
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

    pvt['handleGroupAll'](makeGroupAllEvent({ content: 'hello world' }));
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).not.toHaveBeenCalled();

    mockHandleInbound.mockClear();

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

  it('policy=keyword word-boundary: 不含关键词子串不触发 (e.g. "helpful" ≠ "help")', async () => {
    const ch = makeChannel({
      groupAllPolicy: 'keyword',
      keywordTriggers: ['help'],
    });
    const pvt = ch as unknown as QQChannelRaw;

    pvt['handleGroupAll'](
      makeGroupAllEvent({ content: 'this is helpful info' }),
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).not.toHaveBeenCalled();
  });

  it('sets replyMsgId for all messages passing the policy gate (including non-@)', () => {
    const ch = makeChannel({ groupAllPolicy: 'all' });
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleGroupAll'](
      makeGroupAllEvent({ content: 'hello', mentions: [] }),
    );
    const replyMsgId = (ch as unknown as Record<string, unknown>)[
      'replyMsgId'
    ] as Map<string, { msgId: string; timestamp: number }>;
    const entry = replyMsgId.get('group-openid-1');
    expect(entry?.msgId).toBe('msg-groupall-001');
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
    expect(entry?.msgId).toBe('msg-groupall-001');
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
    expect(env['text']).toBe('/help');
  });

  it('bot 消息被 handleGroupAll 跳过（防 bot 循环）', async () => {
    const ch = makeChannel({ groupAllPolicy: 'all' });
    const pvt = ch as unknown as QQChannelRaw;
    pvt['handleGroupAll'](
      makeGroupAllEvent({
        content: 'auto reply',
        author: { member_openid: 'bot-1', bot: true },
      }),
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).not.toHaveBeenCalled();
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

  it('groupActiveMsgEnabled=false 但 @-bot 消息允许通过（被动回复）', async () => {
    const ch = makeChannel({ groupAllPolicy: 'all' });
    const pvt = ch as unknown as QQChannelRaw;
    const groupActiveMsgEnabled = (ch as unknown as Record<string, unknown>)[
      'groupActiveMsgEnabled'
    ] as Map<string, boolean>;
    groupActiveMsgEnabled.set('group-openid-1', false);

    // @-bot mention passes through even when active messages disabled
    pvt['handleGroupAll'](
      makeGroupAllEvent({
        content: '<@OPENID_BOT> 你好',
        mentions: [
          {
            member_openid: 'ABCDEF012345',
            is_you: true,
            scope: 'single' as const,
          },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).toHaveBeenCalledTimes(1);
    const env = mockHandleInbound.mock.calls[0][0] as Record<string, unknown>;
    expect(env['isMentioned']).toBe(true);
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
    // isAtBot=false → no botOpenId, no suffix, but senderOpenId displayed
    expect(env['text']).toBe(
      '[atMention=false] [Charlie(FEDCBA98…)]: hello world',
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
    it('清理 chatTypeMap, groupActiveMsgEnabled, replyMsgId', () => {
      const ch = makeChannel();
      const pvt = ch as unknown as QQChannelRaw;

      const chatTypeMap = (ch as unknown as Record<string, unknown>)[
        'chatTypeMap'
      ] as Map<string, string>;
      const replyMsgId = (ch as unknown as Record<string, unknown>)[
        'replyMsgId'
      ] as Map<string, { msgId: string; timestamp: number }>;
      const groupActiveMsgEnabled = (ch as unknown as Record<string, unknown>)[
        'groupActiveMsgEnabled'
      ] as Map<string, boolean>;

      chatTypeMap.set('group-del-1', 'group');
      replyMsgId.set('group-del-1', {
        msgId: 'msg-xyz',
        timestamp: Date.now(),
      });
      groupActiveMsgEnabled.set('group-del-1', true);

      const evt: GroupDelRobotEvent = {
        group_openid: 'group-del-1',
        op_member_openid: 'admin-1',
        timestamp: Date.now(),
      };
      pvt['handleGroupDelRobot'](evt);

      expect(chatTypeMap.has('group-del-1')).toBe(false);
      expect(replyMsgId.has('group-del-1')).toBe(false);
      expect(groupActiveMsgEnabled.has('group-del-1')).toBe(false);
    });

    it('清理 cron buffer/timer（cron-msg-experimental 启用）', () => {
      const ch = makeChannel({ 'cron-msg-experimental': true });
      const pvt = ch as unknown as QQChannelRaw;

      const router = (ch as unknown as Record<string, unknown>)['router'] as {
        getTarget: ReturnType<typeof vi.fn>;
      };
      router.getTarget = vi.fn().mockReturnValue({
        chatId: 'group-cron',
      });

      const cronBuffer = (ch as unknown as Record<string, unknown>)[
        'cronBuffer'
      ] as Map<
        string,
        { buffer: string; timer: ReturnType<typeof setTimeout> | null }
      >;
      cronBuffer.set('cron-sid-1', {
        buffer: 'pending cron text',
        timer: setTimeout(() => {}, 9999),
      });
      cronBuffer.set('cron-sid-2', {
        buffer: 'other cron text',
        timer: setTimeout(() => {}, 8888),
      });

      const spy = vi.spyOn(globalThis, 'clearTimeout');

      const evt: GroupDelRobotEvent = {
        group_openid: 'group-cron',
        op_member_openid: 'admin-1',
        timestamp: Date.now(),
      };
      pvt['handleGroupDelRobot'](evt);

      expect(cronBuffer.has('cron-sid-1')).toBe(false);
      expect(cronBuffer.has('cron-sid-2')).toBe(false);
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    });

    // B1: streamState cleanup
    it('clears streamState entries and cancels timers for removed group', () => {
      const ch = makeChannel();
      const pvt = ch as unknown as QQChannelRaw;
      const chp = ch as unknown as Record<string, unknown>;

      // Pre-populate streamState with entries for the group
      const streamState = chp['streamState'] as Map<
        string,
        {
          chatId: string;
          buffer: string;
          timer: ReturnType<typeof setTimeout> | null;
          retryCount: number;
        }
      >;
      streamState.set('sid-1', {
        chatId: 'group-del-stream',
        buffer: 'pending text',
        timer: setTimeout(() => {}, 9999),
        retryCount: 0,
      });
      streamState.set('sid-2', {
        chatId: 'other-group',
        buffer: 'other text',
        timer: null,
        retryCount: 0,
      });

      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      const evt: GroupDelRobotEvent = {
        group_openid: 'group-del-stream',
        op_member_openid: 'admin-1',
        timestamp: Date.now(),
      };
      pvt['handleGroupDelRobot'](evt);

      // Entry for removed group is deleted
      expect(streamState.has('sid-1')).toBe(false);
      // Entry for other group is preserved
      expect(streamState.has('sid-2')).toBe(true);
      expect(streamState.get('sid-2')!.chatId).toBe('other-group');
      // Timer was cancelled
      expect(clearTimeoutSpy).toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
    });

    // B2: detect type check — streamState entry has the right shape
    it('detect type check: streamState entry has chatId and buffer fields for group-del cleanup', () => {
      const ch = makeChannel();
      const pvt = ch as unknown as QQChannelRaw;
      const chp = ch as unknown as Record<string, unknown>;

      const streamState = chp['streamState'] as Map<
        string,
        { chatId: string; buffer: string; timer: unknown; retryCount: number }
      >;
      streamState.set('sid-detect', {
        chatId: 'group-detect',
        buffer: 'test buffer',
        timer: null,
        retryCount: 0,
      });

      // Verify entry has correct shape before cleanup
      const entry = streamState.get('sid-detect')!;
      expect(entry.chatId).toBe('group-detect');
      expect(entry.buffer).toBe('test buffer');
      expect(entry.retryCount).toBe(0);

      // handleGroupDelRobot iterates streamState checking state.chatId === groupId
      // Verify the cleanup targets the right group
      const evt: GroupDelRobotEvent = {
        group_openid: 'group-detect',
        op_member_openid: 'admin-1',
        timestamp: Date.now(),
      };
      pvt['handleGroupDelRobot'](evt);

      expect(streamState.has('sid-detect')).toBe(false);
    });
  });

  describe('handleGroupMsgToggle', () => {
    it('设置 groupActiveMsgEnabled=false (reject)', () => {
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
      pvt['handleGroupMsgToggle'](evt, false);
      expect(groupActiveMsgEnabled.get('group-reject-1')).toBe(false);
    });

    it('设置 groupActiveMsgEnabled=true (receive)', () => {
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
      pvt['handleGroupMsgToggle'](evt, true);
      expect(groupActiveMsgEnabled.get('group-recv-1')).toBe(true);
    });
  });

  describe('isCrossEventDuplicate', () => {
    it('returns false on first call for a new chatId+eventId', () => {
      const ch = makeChannel();
      const pvt = ch as unknown as QQChannelRaw;
      const evt = makeGroupEvent({ id: 'dedup-1' });
      expect(pvt['isCrossEventDuplicate']('group-openid-1', evt)).toBe(false);
    });

    it('returns true on second call with same chatId+eventId', () => {
      const ch = makeChannel();
      const pvt = ch as unknown as QQChannelRaw;
      const evt = makeGroupEvent({ id: 'dedup-2' });
      pvt['isCrossEventDuplicate']('group-openid-1', evt);
      expect(pvt['isCrossEventDuplicate']('group-openid-1', evt)).toBe(true);
    });

    it('returns false for same eventId but different chatId', () => {
      const ch = makeChannel();
      const pvt = ch as unknown as QQChannelRaw;
      const evt = makeGroupEvent({ id: 'dedup-3' });
      pvt['isCrossEventDuplicate']('group-a', evt);
      expect(pvt['isCrossEventDuplicate']('group-b', evt)).toBe(false);
    });

    it('returns false for same chatId but different eventId', () => {
      const ch = makeChannel();
      const pvt = ch as unknown as QQChannelRaw;
      const evt1 = makeGroupEvent({ id: 'dedup-4a' });
      const evt2 = makeGroupEvent({ id: 'dedup-4b' });
      pvt['isCrossEventDuplicate']('group-openid-1', evt1);
      expect(pvt['isCrossEventDuplicate']('group-openid-1', evt2)).toBe(false);
    });
  });

  describe('sendIdentify intent subscription', () => {
    it('includes GROUP_MESSAGE intent when groupAllPolicy=keyword', () => {
      const ch = makeChannel({ groupAllPolicy: 'keyword' });
      const pvt = ch as unknown as QQChannelRaw;
      let sentPayload: string | null = null;
      (ch as unknown as Record<string, unknown>)['ws'] = {
        send: (data: string) => {
          sentPayload = data;
        },
      };
      (ch as unknown as Record<string, unknown>)['_ready'] = true;
      (ch as unknown as Record<string, unknown>)['accessToken'] = 'test-token';
      pvt['sendIdentify']();
      const parsed = JSON.parse(sentPayload!);
      expect(parsed.op).toBe(2); // IDENTIFY
      expect(parsed.d.intents & Intent.GROUP_MESSAGE).toBe(
        Intent.GROUP_MESSAGE,
      );
    });

    it('includes GROUP_MESSAGE intent when groupAllPolicy=all', () => {
      const ch = makeChannel({ groupAllPolicy: 'all' });
      const pvt = ch as unknown as QQChannelRaw;
      let sentPayload: string | null = null;
      (ch as unknown as Record<string, unknown>)['ws'] = {
        send: (data: string) => {
          sentPayload = data;
        },
      };
      (ch as unknown as Record<string, unknown>)['accessToken'] = 'test-token';
      pvt['sendIdentify']();
      const parsed = JSON.parse(sentPayload!);
      expect(parsed.d.intents & Intent.GROUP_MESSAGE).toBe(
        Intent.GROUP_MESSAGE,
      );
    });

    it('includes GROUP_MESSAGE intent when groupAllPolicy=log', () => {
      const ch = makeChannel({ groupAllPolicy: 'log' });
      const pvt = ch as unknown as QQChannelRaw;
      let sentPayload: string | null = null;
      (ch as unknown as Record<string, unknown>)['ws'] = {
        send: (data: string) => {
          sentPayload = data;
        },
      };
      (ch as unknown as Record<string, unknown>)['accessToken'] = 'test-token';
      pvt['sendIdentify']();
      const parsed = JSON.parse(sentPayload!);
      expect(parsed.d.intents & Intent.GROUP_MESSAGE).toBe(
        Intent.GROUP_MESSAGE,
      );
    });

    it('excludes GROUP_MESSAGE intent when groupAllPolicy is undefined', () => {
      const ch = makeChannel({ groupAllPolicy: undefined });
      const pvt = ch as unknown as QQChannelRaw;
      let sentPayload: string | null = null;
      (ch as unknown as Record<string, unknown>)['ws'] = {
        send: (data: string) => {
          sentPayload = data;
        },
      };
      (ch as unknown as Record<string, unknown>)['accessToken'] = 'test-token';
      pvt['sendIdentify']();
      const parsed = JSON.parse(sentPayload!);
      expect(parsed.d.intents & Intent.GROUP_MESSAGE).toBe(0);
    });
  });

  describe('INVALID_SESSION recovery', () => {
    it('sets readyTimeout on re-IDENTIFY and triggers ws.close(4002) + connectReject if READY never arrives', () => {
      vi.useFakeTimers();
      const ch = makeChannel();
      const pvt = ch as unknown as QQChannelRaw;
      const chp = ch as unknown as Record<string, unknown>;

      const wsClose = vi.fn();
      const wsSend = vi.fn();
      chp['ws'] = {
        close: wsClose,
        send: wsSend,
        readyState: 1, // WebSocket.OPEN
      };
      const connectReject = vi.fn();
      chp['connectReject'] = connectReject;

      // Simulate INVALID_SESSION (op=9)
      pvt['handleGatewayMessage']({ op: 9 }, () => {});

      // Verify re-IDENTIFY was sent
      expect(wsSend).toHaveBeenCalled();

      // Verify readyTimeout was set (30s)
      expect(chp['readyTimeout']).not.toBeNull();

      // Advance time past the 30s timeout
      vi.advanceTimersByTime(30_000);

      // Verify WS closed with code 4002
      expect(wsClose).toHaveBeenCalledWith(4002);

      // Verify connectReject was invoked with timeout error
      expect(connectReject).toHaveBeenCalledWith(
        new Error('Timed out waiting for READY'),
      );
      expect(chp['connectReject']).toBeNull();

      ch.disconnect();
    });

    it('readyTimeout does not fire if READY arrives before 30s', () => {
      vi.useFakeTimers();
      const ch = makeChannel();
      const pvt = ch as unknown as QQChannelRaw;
      const chp = ch as unknown as Record<string, unknown>;

      const wsClose = vi.fn();
      const wsSend = vi.fn();
      chp['ws'] = {
        close: wsClose,
        send: wsSend,
        readyState: 1,
      };
      chp['connectReject'] = vi.fn();

      // Simulate INVALID_SESSION (op=9)
      pvt['handleGatewayMessage']({ op: 9 }, () => {});

      const timeoutBefore = chp['readyTimeout'];
      expect(timeoutBefore).not.toBeNull();

      // Simulate READY arriving before timeout
      pvt['handleGatewayMessage'](
        { op: 0, t: 'READY', s: 1, d: { session_id: 'sess-new' } },
        () => {},
      );

      // Verify the old timeout was cleared
      const timeoutAfter = chp['readyTimeout'];
      expect(timeoutAfter).toBeNull();

      // Advance past 30s — should NOT fire
      vi.advanceTimersByTime(30_000);
      expect(wsClose).not.toHaveBeenCalled();

      ch.disconnect();
    });
  });
});

// ---------------------------------------------------------------------------
// Gateway message handling (RESUMED, INVALID_SESSION coldStart)
// ---------------------------------------------------------------------------
describe('Gateway message handling', () => {
  it('RESUMED sets _ready to true and resets reconnect state', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    const chp = ch as unknown as Record<string, unknown>;

    chp['ws'] = { send: vi.fn() };
    chp['accessToken'] = 'test-token';
    chp['_ready'] = false;
    chp['reconnectAttempts'] = 3;
    chp['isReconnecting'] = true;

    // Simulate RESUME event (op=0, t=RESUMED)
    pvt['handleGatewayMessage']({ op: 0, t: 'RESUMED', s: 1, d: {} }, () => {});

    expect(chp['_ready']).toBe(true);
    expect(chp['reconnectAttempts']).toBe(0);
    expect(chp['isReconnecting']).toBe(false);
  });

  it('RESUMED clears pending readyTimeout', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    const chp = ch as unknown as Record<string, unknown>;

    chp['ws'] = { send: vi.fn(), close: vi.fn() };
    chp['accessToken'] = 'test-token';
    chp['readyTimeout'] = setTimeout(() => {}, 30000);

    pvt['handleGatewayMessage']({ op: 0, t: 'RESUMED', s: 1, d: {} }, () => {});

    expect(chp['readyTimeout']).toBeNull();

    ch.disconnect();
  });

  it('RESUMED clears connectReject and starts heartbeat', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    const chp = ch as unknown as Record<string, unknown>;

    chp['ws'] = { send: vi.fn(), close: vi.fn() };
    chp['accessToken'] = 'test-token';
    chp['connectReject'] = vi.fn();
    chp['heartbeatTimer'] = null;

    pvt['handleGatewayMessage']({ op: 0, t: 'RESUMED', s: 1, d: {} }, () => {});

    expect(chp['connectReject']).toBeNull();
    // heartbeatTimer was set (startHeartbeat was called)
    expect(chp['heartbeatTimer']).not.toBeNull();

    ch.disconnect();
  });

  it('INVALID_SESSION sets coldStart=true and _ready=false', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    const chp = ch as unknown as Record<string, unknown>;

    chp['ws'] = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    chp['accessToken'] = 'test-token';
    chp['_ready'] = true;
    chp['coldStart'] = false;
    chp['tryResume'] = true;

    // Simulate INVALID_SESSION (op=9)
    pvt['handleGatewayMessage']({ op: 9 }, () => {});

    expect(chp['coldStart']).toBe(true);
    expect(chp['_ready']).toBe(false);
    expect(chp['tryResume']).toBe(false);

    ch.disconnect();
  });

  it('INVALID_SESSION flushes state and sends re-IDENTIFY', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    const chp = ch as unknown as Record<string, unknown>;

    const wsSend = vi.fn();
    chp['ws'] = { send: wsSend, close: vi.fn(), readyState: 1 };
    chp['accessToken'] = 'test-token';
    chp['_ready'] = true;

    // Simulate INVALID_SESSION (op=9)
    pvt['handleGatewayMessage']({ op: 9 }, () => {});

    // Should have sent IDENTIFY (not RESUME, since tryResume is set to false)
    expect(wsSend).toHaveBeenCalled();
    const sent = wsSend.mock.calls[0][0] as string;
    const parsed = JSON.parse(sent);
    // After INVALID_SESSION, tryResume=false, so it sends IDENTIFY (op=2)
    expect(parsed.op).toBe(2);

    ch.disconnect();
  });

  it('READY cold start: calls restoreQQState and restoreSessions', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    const chp = ch as unknown as Record<string, unknown>;

    chp['ws'] = { send: vi.fn(), close: vi.fn() };
    chp['accessToken'] = 'test-token';
    chp['tokenExpiresAt'] = Date.now() + 3600_000;

    expect(chp['coldStart']).toBe(true);

    const restoreQQSpy = vi
      .spyOn(
        ch as unknown as { restoreQQState: () => boolean },
        'restoreQQState',
      )
      .mockReturnValue(true);
    const restoreSessionsSpy = vi
      .spyOn(
        chp['router'] as unknown as { restoreSessions: () => Promise<void> },
        'restoreSessions',
      )
      .mockResolvedValue(undefined);

    await (
      pvt['handleGatewayMessage'] as (
        msg: Record<string, unknown>,
        onReady: () => void,
      ) => Promise<void>
    )({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess-cold' } }, () => {});

    expect(restoreQQSpy).toHaveBeenCalled();
    expect(restoreSessionsSpy).toHaveBeenCalled();
    expect(chp['_ready']).toBe(true);
    expect(chp['reconnectAttempts']).toBe(0);
    expect(chp['isReconnecting']).toBe(false);
    expect(chp['coldStart']).toBe(false);

    restoreQQSpy.mockRestore();
    restoreSessionsSpy.mockRestore();
    ch.disconnect();
  });

  it('READY warm reconnect: skips restore but calls finalizeReady', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    const chp = ch as unknown as Record<string, unknown>;

    chp['ws'] = { send: vi.fn(), close: vi.fn() };
    chp['accessToken'] = 'test-token';
    chp['tokenExpiresAt'] = Date.now() + 3600_000;
    chp['coldStart'] = false;

    const restoreQQSpy = vi
      .spyOn(
        ch as unknown as { restoreQQState: () => boolean },
        'restoreQQState',
      )
      .mockReturnValue(true);
    const restoreSessionsSpy = vi
      .spyOn(
        chp['router'] as unknown as { restoreSessions: () => Promise<void> },
        'restoreSessions',
      )
      .mockResolvedValue(undefined);

    await (
      pvt['handleGatewayMessage'] as (
        msg: Record<string, unknown>,
        onReady: () => void,
      ) => Promise<void>
    )({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess-warm' } }, () => {});

    expect(restoreQQSpy).not.toHaveBeenCalled();
    expect(restoreSessionsSpy).not.toHaveBeenCalled();
    expect(chp['_ready']).toBe(true);
    expect(chp['reconnectAttempts']).toBe(0);
    expect(chp['isReconnecting']).toBe(false);
    expect(chp['coldStart']).toBe(false);

    restoreQQSpy.mockRestore();
    restoreSessionsSpy.mockRestore();
    ch.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Token refresh exhaustion (10 failures → reconnect)
// ---------------------------------------------------------------------------
describe('Token refresh exhaustion', () => {
  it('calls disconnect after 10 consecutive token refresh failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;

    // Set up token expiry near future so scheduleTokenRefresh fires soon
    chp['tokenExpiresAt'] = Date.now() + 20_000;
    chp['accessToken'] = 'test-token';
    chp['_reconnectId'] = 1;

    mockFetchAccessToken.mockRejectedValue(new Error('token endpoint down'));

    // Spy on disconnect to verify it's called
    const disconnectSpy = vi.spyOn(
      ch as unknown as { disconnect: () => void },
      'disconnect',
    );

    // Spy on reconnectWithRetry
    const reconnectSpy = vi
      .spyOn(
        ch as unknown as { reconnectWithRetry: () => Promise<void> },
        'reconnectWithRetry',
      )
      .mockResolvedValue(undefined);

    // Call scheduleTokenRefresh (private, accessed via type cast)
    (chp['scheduleTokenRefresh'] as () => void).call(ch);

    // Advance past the initial delay
    // tokenExpiresAt = now + 20s
    // ttl = 20s
    // delay = min(20*0.8=16s, max(20-30=-10s, 10s)) = min(16s, 10s) = 10s
    await vi.advanceTimersByTimeAsync(10_000);

    // First fetchToken call was made and rejected
    expect(mockFetchAccessToken).toHaveBeenCalledTimes(1);

    // Now advance through the 10 retries (each 60s apart)
    // After each rejection, a new setTimeout(60000) fires
    for (let i = 1; i <= 10; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }

    // After 10 failures (retryCount > 10), disconnect should have been called
    expect(disconnectSpy).toHaveBeenCalled();

    disconnectSpy.mockRestore();
    reconnectSpy.mockRestore();
    vi.useRealTimers();
  });

  it('stale _reconnectId discards token refresh retry callbacks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;

    chp['tokenExpiresAt'] = Date.now() + 20_000;
    chp['accessToken'] = 'test-token';
    const originalReconnectId = chp['_reconnectId'] as number;

    mockFetchAccessToken.mockRejectedValue(new Error('token endpoint down'));

    // Spy on disconnect
    const disconnectSpy = vi.spyOn(
      ch as unknown as { disconnect: () => void },
      'disconnect',
    );

    (chp['scheduleTokenRefresh'] as () => void).call(ch);

    // Advance to trigger first fetchToken -> reject
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockFetchAccessToken).toHaveBeenCalledTimes(1);

    // Change _reconnectId before the retry fires (simulate disconnect/reconnect)
    chp['_reconnectId'] = originalReconnectId + 1;

    // Advance 60s for the retry
    await vi.advanceTimersByTimeAsync(60_000);

    // Stale _reconnectId check fires in the .catch() handler, not in
    // fetchToken itself. fetchToken calls fetchAccessToken anyway,
    // but the .catch() returns early due to _reconnectId mismatch.
    expect(mockFetchAccessToken).toHaveBeenCalledTimes(2);
    // disconnect was not called (guard returned early)
    expect(disconnectSpy).not.toHaveBeenCalled();

    disconnectSpy.mockRestore();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// resolveRoute with chatTypes config fallback
// ---------------------------------------------------------------------------
describe('resolveRoute chatTypes fallback', () => {
  it('uses chatTypes config when chatTypeMap has no entry', async () => {
    const ch = makeChannel({
      chatTypes: { 'config-chat-id': 'group' },
    });
    const chp = ch as unknown as Record<string, unknown>;
    chp['accessToken'] = 'test-token';
    chp['tokenExpiresAt'] = Date.now() + 3600_000;

    const pvt = ch as unknown as QQChannelRaw;
    const result = await (
      pvt['resolveRoute'] as (
        chatId: string,
      ) => Promise<{ base: string; path: string } | null>
    )('config-chat-id');

    expect(result).not.toBeNull();
    expect(result!.path).toBe('/v2/groups/config-chat-id/messages');
  });

  it('prefers chatTypeMap over chatTypes config', async () => {
    const ch = makeChannel({
      chatTypes: { 'dual-chat-id': 'c2c' },
    });
    const chp = ch as unknown as Record<string, unknown>;
    chp['accessToken'] = 'test-token';
    chp['tokenExpiresAt'] = Date.now() + 3600_000;
    (chp['chatTypeMap'] as Map<string, string>).set('dual-chat-id', 'group');

    const pvt = ch as unknown as QQChannelRaw;
    const result = await (
      pvt['resolveRoute'] as (
        chatId: string,
      ) => Promise<{ base: string; path: string } | null>
    )('dual-chat-id');

    expect(result).not.toBeNull();
    expect(result!.path).toBe('/v2/groups/dual-chat-id/messages');
  });

  it('returns null when neither chatTypeMap nor chatTypes has entry', async () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    chp['accessToken'] = 'test-token';
    chp['tokenExpiresAt'] = Date.now() + 3600_000;

    const pvt = ch as unknown as QQChannelRaw;
    const result = await (
      pvt['resolveRoute'] as (
        chatId: string,
      ) => Promise<{ base: string; path: string } | null>
    )('unknown-chat');

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractBotOpenId
// ---------------------------------------------------------------------------
describe('extractBotOpenId', () => {
  it('returns empty string when no self-mention found', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    const result = (
      pvt['extractBotOpenId'] as (
        mentions: QQGroupMessageEvent['mentions'],
        chatId?: string,
      ) => string
    )([], 'group-1');
    expect(result).toBe('');
  });

  it('returns empty string for invalid botOpenId format', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    const result = (
      pvt['extractBotOpenId'] as (
        mentions: QQGroupMessageEvent['mentions'],
        chatId?: string,
      ) => string
    )([
      {
        member_openid: 'not-hex!!',
        is_you: true,
        scope: 'single' as const,
      },
    ]);
    expect(result).toBe('');
  });

  it('returns botOpenId and saves to botOpenIdByGroup when valid', () => {
    const ch = makeChannel();
    const chp = ch as unknown as Record<string, unknown>;
    const pvt = ch as unknown as QQChannelRaw;
    const botOpenIdByGroup = chp['botOpenIdByGroup'] as Map<string, string>;

    const result = (
      pvt['extractBotOpenId'] as (
        mentions: QQGroupMessageEvent['mentions'],
        chatId?: string,
      ) => string
    )(
      [
        {
          member_openid: 'ABCDEF0123456789ABCDEF0123456789',
          is_you: true,
          scope: 'single' as const,
        },
      ],
      'group-openid-1',
    );

    expect(result).toBe('ABCDEF0123456789ABCDEF0123456789');
    expect(botOpenIdByGroup.get('group-openid-1')).toBe(
      'ABCDEF0123456789ABCDEF0123456789',
    );
  });

  it('prefers member_openid over id', () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    const result = (
      pvt['extractBotOpenId'] as (
        mentions: QQGroupMessageEvent['mentions'],
        chatId?: string,
      ) => string
    )([
      {
        member_openid: '11111111222222223333333344444444',
        id: '99999999888888887777777766666666',
        is_you: true,
        scope: 'single' as const,
      },
    ]);
    expect(result).toBe('11111111222222223333333344444444');
  });
});
