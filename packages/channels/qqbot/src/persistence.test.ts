import { writeFileSync, renameSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSendQQMessage, mockFetchAccessToken, mockGetCredsFilePath } =
  vi.hoisted(() => ({
    mockSendQQMessage: vi.fn(),
    mockFetchAccessToken: vi.fn(),
    mockGetCredsFilePath: vi.fn(() => '/tmp/test-creds.json'),
  }));

let fsStore: Record<string, string> = {};
let fsExists: Record<string, boolean> = {};

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readFileSync: vi.fn((path: string) => {
    const content = fsStore[path];
    if (content === undefined) throw new Error('ENOENT');
    return content;
  }),
  writeFileSync: vi.fn((path: string, data: string) => {
    fsStore[path] = data;
  }),
  existsSync: vi.fn((path: string) => !!fsExists[path] || path in fsStore),
  renameSync: vi.fn((src: string, dst: string) => {
    fsStore[dst] = fsStore[src];
    delete fsStore[src];
  }),
}));

vi.mock('./api.js', () => ({
  sendQQMessage: mockSendQQMessage,
  getApiBase: () => 'https://api.sgroup.qq.com',
  fetchAccessToken: mockFetchAccessToken,
  fetchGatewayUrl: vi.fn(),
}));

vi.mock('./accounts.js', () => ({
  getCredsFilePath: mockGetCredsFilePath,
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
  sanitizeLogText: (text: string, maxLen: number): string => {
    const sanitized = Array.from(text, (c) => {
      const cp = c.codePointAt(0)!;
      if (cp === 0x1b) return ' '; // ESC
      if (cp === 0x9b) return ' '; // C1
      if (cp === 0x85 || cp === 0x2028 || cp === 0x2029) return ' '; // line/paragraph sep
      if (cp === 0x202e) return ' '; // RLO
      if (cp === 0x0a || cp === 0x0d) return '\n';
      if (cp < 0x20) return '';
      return c;
    }).join('');
    return sanitized.length > maxLen
      ? sanitized.slice(0, maxLen) + '...'
      : sanitized;
  },
}));

const { QQChannel } = await import('./QQChannel.js');

type QQChannelClass = InstanceType<typeof QQChannel>;

function makeChannel(
  options?: import('@qwen-code/channel-base').ChannelBaseOptions,
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
      groups: {},
      appID: 'test-app-id',
      appSecret: 'test-secret',
    },
    {} as unknown as import('@qwen-code/channel-base').AcpBridge,
    options,
  );
  return ch;
}

const statePath = '/tmp/test-qwen/channels/test-bot-state.json';
const sessionsPath = '/tmp/test-qwen/channels/test-bot-sessions.json';
const globalSessionsPath = '/tmp/test-qwen/channels/sessions.json';
const sessionsBackupPath =
  '/tmp/test-qwen/channels/test-bot-sessions-backup.json';

beforeEach(() => {
  vi.useFakeTimers();
  fsStore = {};
  fsExists = {};
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('credential storage scope', () => {
  it('uses daemon stateDir without falling back to standalone credentials', () => {
    makeChannel({ stateDir: '/tmp/daemon/qq/test-bot' });

    expect(mockGetCredsFilePath).toHaveBeenCalledWith(
      'test-bot',
      '/tmp/daemon/qq/test-bot',
    );
  });
});

// ─── saveQQState ─────────────────────────────────────────────────

describe('saveQQState', () => {
  it('debounces writes — does not write immediately', () => {
    const ch = makeChannel();
    (ch as unknown as { saveQQState: () => void }).saveQQState();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('writes to tmp file then renames after 500ms debounce', () => {
    const ch = makeChannel();
    (ch as unknown as { saveQQState: () => void }).saveQQState();
    vi.advanceTimersByTime(500);

    const tmpPath = statePath + '.tmp';
    expect(writeFileSync).toHaveBeenCalledWith(tmpPath, expect.any(String), {
      mode: 0o600,
    });
    expect(renameSync).toHaveBeenCalledWith(tmpPath, statePath);
  });

  it('persists chatTypeMap, replyMsgId, msgSeqMap, groupActiveMsgEnabled', () => {
    const ch = makeChannel();
    const chatTypeMap = (
      ch as unknown as { chatTypeMap: Map<string, 'c2c' | 'group'> }
    ).chatTypeMap;
    const replyMsgId = (
      ch as unknown as {
        replyMsgId: Map<string, { msgId: string; timestamp: number }>;
      }
    ).replyMsgId;
    const msgSeqMap = (ch as unknown as { msgSeqMap: Map<string, number> })
      .msgSeqMap;
    const groupActiveMsgEnabled = (
      ch as unknown as { groupActiveMsgEnabled: Map<string, boolean> }
    ).groupActiveMsgEnabled;

    chatTypeMap.set('u1', 'c2c');
    chatTypeMap.set('g1', 'group');
    replyMsgId.set('u1', { msgId: 'msg_abc', timestamp: 1000 });
    msgSeqMap.set('msg_abc', 3);
    groupActiveMsgEnabled.set('g1', true);
    const botOpenIdByGroup = (
      ch as unknown as { botOpenIdByGroup: Map<string, string> }
    ).botOpenIdByGroup;
    botOpenIdByGroup.set('g1', 'abc123def456abc123def456abc123de');

    (ch as unknown as { saveQQState: () => void }).saveQQState();
    vi.advanceTimersByTime(500);

    const written = fsStore[statePath];
    const parsed = JSON.parse(written);
    expect(parsed.chatTypeMap).toEqual([
      ['u1', 'c2c'],
      ['g1', 'group'],
    ]);
    expect(parsed.replyMsgId).toEqual([
      ['u1', { msgId: 'msg_abc', timestamp: 1000 }],
    ]);
    expect(parsed.msgSeqMap).toEqual([['msg_abc', 3]]);
    expect(parsed.groupActiveMsgEnabled).toEqual([['g1', true]]);
    expect(parsed.botOpenIdByGroup).toEqual([
      ['g1', 'abc123def456abc123def456abc123de'],
    ]);
  });

  it('debounces multiple calls within 500ms into a single write', () => {
    const ch = makeChannel();
    (ch as unknown as { saveQQState: () => void }).saveQQState();
    (ch as unknown as { saveQQState: () => void }).saveQQState();
    (ch as unknown as { saveQQState: () => void }).saveQQState();
    vi.advanceTimersByTime(500);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
  });
});

// ─── flushQQState ────────────────────────────────────────────────

describe('flushQQState', () => {
  it('writes immediately (skips debounce)', () => {
    const ch = makeChannel();
    (ch as unknown as { flushQQState: () => void }).flushQQState();
    expect(writeFileSync).toHaveBeenCalledWith(
      statePath + '.tmp',
      expect.any(String),
      { mode: 0o600 },
    );
  });

  it('cancels pending debounce when flushing', () => {
    const ch = makeChannel();
    (ch as unknown as { saveQQState: () => void }).saveQQState();
    (ch as unknown as { flushQQState: () => void }).flushQQState();
    vi.advanceTimersByTime(500);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('called during disconnect()', () => {
    const ch = makeChannel();
    ch.disconnect();
    expect(writeFileSync).toHaveBeenCalledWith(
      statePath + '.tmp',
      expect.any(String),
      { mode: 0o600 },
    );
  });
});

// ─── restoreQQState ──────────────────────────────────────────────

describe('restoreQQState', () => {
  it('returns false when state file does not exist', () => {
    const ch = makeChannel();
    const result = (
      ch as unknown as { restoreQQState: () => boolean }
    ).restoreQQState();
    expect(result).toBe(false);
  });

  it('restores chatTypeMap from disk', () => {
    fsStore[statePath] = JSON.stringify({
      chatTypeMap: [
        ['u1', 'c2c'],
        ['g1', 'group'],
      ],
    });
    const ch = makeChannel();
    const result = (
      ch as unknown as { restoreQQState: () => boolean }
    ).restoreQQState();
    expect(result).toBe(true);

    const chatTypeMap = (
      ch as unknown as { chatTypeMap: Map<string, 'c2c' | 'group'> }
    ).chatTypeMap;
    expect(chatTypeMap.get('u1')).toBe('c2c');
    expect(chatTypeMap.get('g1')).toBe('group');
  });

  it('restores replyMsgId from disk', () => {
    fsStore[statePath] = JSON.stringify({
      replyMsgId: [['u1', 'msg_abc']],
    });
    const ch = makeChannel();
    (ch as unknown as { restoreQQState: () => boolean }).restoreQQState();

    const replyMsgId = (ch as unknown as { replyMsgId: Map<string, string> })
      .replyMsgId;
    expect(replyMsgId.get('u1')?.msgId).toBe('msg_abc');
  });

  it('restores msgSeqMap from disk', () => {
    fsStore[statePath] = JSON.stringify({
      msgSeqMap: [['msg_abc', 5]],
    });
    const ch = makeChannel();
    (ch as unknown as { restoreQQState: () => boolean }).restoreQQState();

    const msgSeqMap = (ch as unknown as { msgSeqMap: Map<string, number> })
      .msgSeqMap;
    expect(msgSeqMap.get('msg_abc')).toBe(5);
  });

  it('restores groupActiveMsgEnabled from disk', () => {
    fsStore[statePath] = JSON.stringify({
      groupActiveMsgEnabled: [
        ['g1', true],
        ['g2', false],
      ],
    });
    const ch = makeChannel();
    (ch as unknown as { restoreQQState: () => boolean }).restoreQQState();

    const groupActiveMsgEnabled = (
      ch as unknown as { groupActiveMsgEnabled: Map<string, boolean> }
    ).groupActiveMsgEnabled;
    expect(groupActiveMsgEnabled.get('g1')).toBe(true);
    expect(groupActiveMsgEnabled.get('g2')).toBe(false);
  });

  it('normalizes string-format replyMsgId entries to object format', () => {
    fsStore[statePath] = JSON.stringify({
      replyMsgId: [
        ['u1', 'msg_old'],
        ['u2', 'msg_new'],
      ],
    });
    const ch = makeChannel();
    (ch as unknown as { restoreQQState: () => boolean }).restoreQQState();

    const replyMsgId = (ch as unknown as { replyMsgId: Map<string, string> })
      .replyMsgId;
    expect(replyMsgId.get('u1')?.msgId).toBe('msg_old');
    expect(replyMsgId.get('u2')?.msgId).toBe('msg_new');
  });

  it('does not crash on invalid JSON', () => {
    fsStore[statePath] = 'not json {{{';
    const ch = makeChannel();
    const result = (
      ch as unknown as { restoreQQState: () => boolean }
    ).restoreQQState();
    expect(result).toBe(false);
  });

  it('filters invalid chatTypeMap values (only c2c/group accepted)', () => {
    fsStore[statePath] = JSON.stringify({
      chatTypeMap: [
        ['u1', 'c2c'],
        ['u2', 'invalid'],
        ['u3', 'group'],
      ],
    });
    const ch = makeChannel();
    (ch as unknown as { restoreQQState: () => boolean }).restoreQQState();

    const chatTypeMap = (
      ch as unknown as { chatTypeMap: Map<string, 'c2c' | 'group'> }
    ).chatTypeMap;
    expect(chatTypeMap.get('u1')).toBe('c2c');
    expect(chatTypeMap.has('u2')).toBe(false);
    expect(chatTypeMap.get('u3')).toBe('group');
  });

  it('filters invalid msgSeqMap values (negative or non-number)', () => {
    fsStore[statePath] = JSON.stringify({
      msgSeqMap: [
        ['a', 3],
        ['b', -1],
        ['c', 'notanum'],
      ],
    });
    const ch = makeChannel();
    (ch as unknown as { restoreQQState: () => boolean }).restoreQQState();

    const msgSeqMap = (ch as unknown as { msgSeqMap: Map<string, number> })
      .msgSeqMap;
    expect(msgSeqMap.get('a')).toBe(3);
    expect(msgSeqMap.has('b')).toBe(false);
    expect(msgSeqMap.has('c')).toBe(false);
  });

  it('normalizes old-format replyMsgId (string only) to new format', () => {
    fsStore[statePath] = JSON.stringify({
      replyMsgId: [['u1', 'msg_old_fmt']],
    });
    const ch = makeChannel();
    (ch as unknown as { restoreQQState: () => boolean }).restoreQQState();

    const replyMsgId = (ch as unknown as { replyMsgId: Map<string, string> })
      .replyMsgId;
    const entry = replyMsgId.get('u1');
    expect(entry?.msgId).toBe('msg_old_fmt');
  });
});

// ─── backupGlobalSessions / restoreGlobalSessions ────────────────

describe('backupGlobalSessions / restoreGlobalSessions', () => {
  it('backupGlobalSessions copies sessions.json to backup path on disconnect', () => {
    fsStore[sessionsPath] = JSON.stringify({ key: 'session-data' });
    const ch = makeChannel();
    ch.disconnect();

    expect(fsStore[sessionsBackupPath]).toBe(
      JSON.stringify({ key: 'session-data' }),
    );
  });

  it('backupGlobalSessions does nothing when sessions.json does not exist', () => {
    const ch = makeChannel();
    ch.disconnect();
    expect(fsStore[sessionsBackupPath]).toBeUndefined();
  });

  it('backupGlobalSessions does nothing for empty sessions.json', () => {
    fsStore[sessionsPath] = '';
    const ch = makeChannel();
    ch.disconnect();
    expect(fsStore[sessionsBackupPath]).toBeUndefined();
  });

  it('restoreGlobalSessions restores from backup when sessions.json missing', () => {
    fsStore[sessionsBackupPath] = JSON.stringify({ restored: true });
    const ch = makeChannel();
    (
      ch as unknown as { restoreGlobalSessions: () => void }
    ).restoreGlobalSessions();

    expect(fsStore[sessionsPath]).toBe(JSON.stringify({ restored: true }));
  });

  it('restoreGlobalSessions does not overwrite existing sessions.json', () => {
    fsStore[sessionsPath] = JSON.stringify({ existing: true });
    fsStore[sessionsBackupPath] = JSON.stringify({ restored: true });
    const ch = makeChannel();
    (
      ch as unknown as { restoreGlobalSessions: () => void }
    ).restoreGlobalSessions();

    expect(fsStore[sessionsPath]).toBe(JSON.stringify({ existing: true }));
  });

  it('restoreGlobalSessions does nothing when backup is also missing', () => {
    const ch = makeChannel();
    (
      ch as unknown as { restoreGlobalSessions: () => void }
    ).restoreGlobalSessions();
    expect(fsStore[sessionsPath]).toBeUndefined();
  });

  it('backup/restore failures do not crash (caught by try/catch)', () => {
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    fsStore[sessionsPath] = JSON.stringify({ key: 'data' });
    const ch = makeChannel();
    expect(() => ch.disconnect()).not.toThrow();
  });
});

// ─── fixRestoredSessions ─────────────────────────────────────────

describe('fixRestoredSessions', () => {
  it('fixes undefined sessionIds in SessionRouter maps', () => {
    const toSession = new Map<string, string>();
    const toTarget = new Map<string, unknown>();
    const toCwd = new Map<string, string>();

    const entryKey = 'some_key';
    toSession.set(entryKey, undefined as unknown as string);

    const sessionsData: Record<
      string,
      { sessionId: string; target: unknown; cwd: string }
    > = {};
    sessionsData[entryKey] = {
      sessionId: 'correct-sid',
      target: { chatId: 'u1' },
      cwd: '/tmp/u1',
    };
    fsStore[globalSessionsPath] = JSON.stringify(sessionsData);

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
      {
        router: {
          restoreSessions: () => Promise.resolve(),
          toSession,
          toTarget,
          toCwd,
        } as unknown as import('@qwen-code/channel-base').SessionRouter,
      },
    );

    (
      ch as unknown as { fixRestoredSessions: () => void }
    ).fixRestoredSessions();

    expect(toSession.get(entryKey)).toBe('correct-sid');
    expect(toTarget.get('correct-sid')).toEqual({ chatId: 'u1' });
    expect(toCwd.get('correct-sid')).toBe('/tmp/u1');
    expect(toTarget.has(undefined as unknown as string)).toBe(false);
  });

  it('does nothing when sessions.json does not exist', () => {
    const toSession = new Map<string, string>();
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
      {
        router: {
          restoreSessions: () => Promise.resolve(),
          toSession,
          toTarget: new Map(),
        } as unknown as import('@qwen-code/channel-base').SessionRouter,
      },
    );

    (
      ch as unknown as { fixRestoredSessions: () => void }
    ).fixRestoredSessions();
    expect(toSession.size).toBe(0);
  });

  it('skips entries that already have valid sessionIds', () => {
    const toSession = new Map<string, string>();
    const toTarget = new Map<string, unknown>();

    toSession.set('k1', 'already-valid');
    toTarget.set('already-valid', { chatId: 'existing' });

    fsStore[globalSessionsPath] = JSON.stringify({
      k1: {
        sessionId: 'already-valid',
        target: { chatId: 'existing' },
        cwd: '/tmp',
      },
    });

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
      {
        router: {
          restoreSessions: () => Promise.resolve(),
          toSession,
          toTarget,
        } as unknown as import('@qwen-code/channel-base').SessionRouter,
      },
    );

    (
      ch as unknown as { fixRestoredSessions: () => void }
    ).fixRestoredSessions();

    expect(toSession.get('k1')).toBe('already-valid');
  });
});
