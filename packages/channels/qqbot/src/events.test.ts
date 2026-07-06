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
    ] as Map<string, string>;
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
    ] as Map<string, string>;
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
    // allowMention=false; senderOpenId still displayed
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

  it('@all (isAtBot=false) with no mentions defaults to isAtBot=true for GROUP_AT_MESSAGE_CREATE', async () => {
    const ch = makeChannel();
    const pvt = ch as unknown as QQChannelRaw;
    const replyMsgId = (ch as unknown as Record<string, unknown>)[
      'replyMsgId'
    ] as Map<string, string>;
    replyMsgId.set('group-openid-1', 'old-msg');

    pvt['handleGroup'](
      makeGroupEvent({
        content: '<@all> 大家看看',
        mentions: undefined,
      }),
    );

    await vi.advanceTimersByTimeAsync(600);
    expect(mockHandleInbound).toHaveBeenCalledTimes(1);
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
    ] as Map<string, string>;
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
    it('清理 chatTypeMap, groupActiveMsgEnabled, replyMsgId', () => {
      const ch = makeChannel();
      const pvt = ch as unknown as QQChannelRaw;

      const chatTypeMap = (ch as unknown as Record<string, unknown>)[
        'chatTypeMap'
      ] as Map<string, string>;
      const replyMsgId = (ch as unknown as Record<string, unknown>)[
        'replyMsgId'
      ] as Map<string, string>;
      const groupActiveMsgEnabled = (ch as unknown as Record<string, unknown>)[
        'groupActiveMsgEnabled'
      ] as Map<string, boolean>;

      chatTypeMap.set('group-del-1', 'group');
      replyMsgId.set('group-del-1', 'msg-xyz');
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

      const cronRetryCount = (ch as unknown as Record<string, unknown>)[
        'cronRetryCount'
      ] as Map<string, number>;
      cronRetryCount.set('cron-sid-1', 2);

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

    it('excludes GROUP_MESSAGE intent when groupAllPolicy=log', () => {
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
      expect(parsed.d.intents & Intent.GROUP_MESSAGE).toBe(0);
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
