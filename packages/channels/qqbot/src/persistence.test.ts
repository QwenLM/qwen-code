import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, renameSync } from 'node:fs';

const { mockSendQQMessage, mockFetchAccessToken } = vi.hoisted(() => ({
  mockSendQQMessage: vi.fn(),
  mockFetchAccessToken: vi.fn(),
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

type QQChannelClass = InstanceType<typeof QQChannel>;

function makeChannel(): QQChannelClass {
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
  return ch;
}

const statePath = '/tmp/test-qwen/channels/test-bot-state.json';
// In standalone mode (no external router), globalSessionsPath uses the
// per-channel path (see constructor fix for issue #81).
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

// ─── saveQQState ─────────────────────────────────────────────────

describe('saveQQState', () => {
  it('debounces writes — does not write immediately', () => {
    const ch = makeChannel();
    // trigger save via a private call
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
    // inject some state
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
    // no timer advancement needed — should write immediately
    expect(writeFileSync).toHaveBeenCalledWith(
      statePath + '.tmp',
      expect.any(String),
      {
        mode: 0o600,
      },
    );
  });

  it('cancels pending debounce when flushing', () => {
    const ch = makeChannel();
    (ch as unknown as { saveQQState: () => void }).saveQQState();
    (ch as unknown as { flushQQState: () => void }).flushQQState();
    // advancing past the debounce window should not trigger another write
    vi.advanceTimersByTime(500);
    expect(writeFileSync).toHaveBeenCalledTimes(1); // only the flush write
  });

  it('called during disconnect()', () => {
    const ch = makeChannel();
    ch.disconnect();
    expect(writeFileSync).toHaveBeenCalledWith(
      statePath + '.tmp',
      expect.any(String),
      {
        mode: 0o600,
      },
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
      replyMsgId: [['u1', { msgId: 'msg_abc', timestamp: 1000 }]],
    });
    const ch = makeChannel();
    (ch as unknown as { restoreQQState: () => boolean }).restoreQQState();

    const replyMsgId = (
      ch as unknown as {
        replyMsgId: Map<string, { msgId: string; timestamp: number }>;
      }
    ).replyMsgId;
    expect(replyMsgId.get('u1')).toEqual({ msgId: 'msg_abc', timestamp: 1000 });
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

  it('filters expired replyMsgId entries (timestamp < 5 min ago)', () => {
    const oldTs = Date.now() - 400_000; // older than 5 min
    fsStore[statePath] = JSON.stringify({
      replyMsgId: [
        ['u1', { msgId: 'msg_old', timestamp: oldTs }],
        ['u2', { msgId: 'msg_new', timestamp: Date.now() - 60_000 }],
      ],
    });
    const ch = makeChannel();
    // the restore does NOT filter by timestamp on restore — that's what cleanup does.
    // restoreQQState just validates the shape, not the age.
    (ch as unknown as { restoreQQState: () => boolean }).restoreQQState();

    const replyMsgId = (
      ch as unknown as {
        replyMsgId: Map<string, { msgId: string; timestamp: number }>;
      }
    ).replyMsgId;
    // Both should be restored (age filtering is done by cleanup, not restore)
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
    expect(chatTypeMap.has('u2')).toBe(false); // filtered
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
    expect(msgSeqMap.has('b')).toBe(false); // negative filtered
    expect(msgSeqMap.has('c')).toBe(false); // non-number filtered
  });

  it('normalizes old-format replyMsgId (string only) to new format', () => {
    fsStore[statePath] = JSON.stringify({
      replyMsgId: [['u1', 'msg_old_fmt']],
    });
    const ch = makeChannel();
    (ch as unknown as { restoreQQState: () => boolean }).restoreQQState();

    const replyMsgId = (
      ch as unknown as {
        replyMsgId: Map<string, { msgId: string; timestamp: number }>;
      }
    ).replyMsgId;
    const entry = replyMsgId.get('u1');
    expect(entry?.msgId).toBe('msg_old_fmt');
    expect(typeof entry?.timestamp).toBe('number');
  });
});

// ─── startReplyMsgIdCleanup ──────────────────────────────────────

describe('startReplyMsgIdCleanup', () => {
  function accessCleanup(ch: QQChannelClass) {
    return ch as unknown as {
      startReplyMsgIdCleanup: () => void;
      stopReplyMsgIdCleanup: () => void;
      replyMsgId: Map<string, { msgId: string; timestamp: number }>;
      msgSeqMap: Map<string, number>;
      chatTypeMap: Map<string, 'c2c' | 'group'>;
      groupActiveMsgEnabled: Map<string, boolean>;
    };
  }

  it('evicts replyMsgId entries older than 5 minutes', () => {
    const ch = makeChannel();
    const api = accessCleanup(ch);

    const oldTs = Date.now() - 400_000;
    api.replyMsgId.set('u1', { msgId: 'msg_old', timestamp: oldTs });
    api.replyMsgId.set('u2', { msgId: 'msg_new', timestamp: Date.now() });

    api.startReplyMsgIdCleanup();
    vi.advanceTimersByTime(60_000);

    expect(api.replyMsgId.has('u1')).toBe(false);
    expect(api.replyMsgId.has('u2')).toBe(true);
  });

  it('cascading cleanup removes msgSeqMap entries for expired replyMsgId', () => {
    const ch = makeChannel();
    const api = accessCleanup(ch);

    api.msgSeqMap.set('msg_old', 3);
    api.msgSeqMap.set('msg_new', 1);
    api.replyMsgId.set('u1', {
      msgId: 'msg_old',
      timestamp: Date.now() - 400_000,
    });
    api.replyMsgId.set('u2', { msgId: 'msg_new', timestamp: Date.now() });

    api.startReplyMsgIdCleanup();
    vi.advanceTimersByTime(60_000);

    expect(api.msgSeqMap.has('msg_old')).toBe(false);
    expect(api.msgSeqMap.has('msg_new')).toBe(true);
  });

  it('cascading cleanup does NOT evict chatTypeMap/groupActiveMsgEnabled with no replyMsgId', () => {
    const ch = makeChannel();
    const api = accessCleanup(ch);

    api.chatTypeMap.set('u1', 'c2c');
    api.chatTypeMap.set('u2', 'c2c');
    api.groupActiveMsgEnabled.set('u1', false);
    api.groupActiveMsgEnabled.set('u2', false);
    api.replyMsgId.set('u1', { msgId: 'msg_alive', timestamp: Date.now() });
    // u2 has NO replyMsgId entry

    api.startReplyMsgIdCleanup();
    vi.advanceTimersByTime(60_000);

    // chatTypeMap and groupActiveMsgEnabled are NOT evicted when
    // replyMsgId expires — their lifecycle is independent of reply TTL.
    // groupActiveMsgEnabled is only cleared on GROUP_DEL_ROBOT.
    expect(api.chatTypeMap.has('u1')).toBe(true);
    expect(api.chatTypeMap.has('u2')).toBe(true); // kept — not evicted
    expect(api.groupActiveMsgEnabled.has('u1')).toBe(true);
    expect(api.groupActiveMsgEnabled.has('u2')).toBe(true); // kept — not evicted
  });

  it('runs every 60 seconds', () => {
    const ch = makeChannel();
    const api = accessCleanup(ch);

    api.replyMsgId.set('u1', {
      msgId: 'msg1',
      timestamp: Date.now() - 400_000,
    });
    api.chatTypeMap.set('u1', 'c2c');

    api.startReplyMsgIdCleanup();
    vi.advanceTimersByTime(60_000);
    expect(api.replyMsgId.has('u1')).toBe(false);

    // add another expired entry after first cleanup
    api.replyMsgId.set('u2', {
      msgId: 'msg2',
      timestamp: Date.now() - 400_000,
    });
    api.chatTypeMap.set('u2', 'c2c');
    vi.advanceTimersByTime(60_000);
    expect(api.replyMsgId.has('u2')).toBe(false);
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
    // should not throw, and no backup written
    expect(fsStore[sessionsBackupPath]).toBeUndefined();
  });

  it('backupGlobalSessions does nothing for empty sessions.json', () => {
    fsStore[sessionsPath] = '';
    const ch = makeChannel();
    ch.disconnect();
    // empty file — no backup written (data.trim() is falsy)
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
    // no crash, no write
    expect(fsStore[sessionsPath]).toBeUndefined();
  });

  it('backup/restore failures do not crash (caught by try/catch)', () => {
    // simulate a write failure by making writeFileSync throw
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    fsStore[sessionsPath] = JSON.stringify({ key: 'data' });
    const ch = makeChannel();
    // should not throw
    expect(() => ch.disconnect()).not.toThrow();
  });
});

// ─── fixRestoredSessions ─────────────────────────────────────────

describe('fixRestoredSessions', () => {
  it('fixes undefined sessionIds in SessionRouter maps', () => {
    const toSession = new Map<string, string>();
    const toTarget = new Map<string, unknown>();
    const toCwd = new Map<string, string>();

    // simulate a corrupted entry with undefined sessionId
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
    // no crash, no modifications
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

    expect(toSession.get('k1')).toBe('already-valid'); // unchanged
  });
});
