import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChannelAgentBridge,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';

vi.mock('@octokit/rest', () => {
  const mockOctokit = {
    rest: {
      users: {
        getAuthenticated: vi.fn(),
        getByUsername: vi.fn(),
      },
      activity: {
        listNotificationsForAuthenticatedUser: vi.fn(),
        markNotificationsAsRead: vi.fn(),
      },
      issues: {
        listComments: vi.fn(),
        createComment: vi.fn(),
        get: vi.fn(),
      },
    },
    paginate: vi.fn(),
  };
  return {
    Octokit: vi.fn(() => mockOctokit),
    __mockOctokit: mockOctokit,
  };
});

vi.mock('@qwen-code/channel-base', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/channel-base')>();
  return {
    ...actual,
  };
});

import { GithubChannel } from './GithubAdapter.js';

const mockOctokit = (
  (await import('@octokit/rest')) as unknown as {
    __mockOctokit: Record<string, unknown>;
  }
).__mockOctokit as {
  rest: {
    users: {
      getAuthenticated: ReturnType<typeof vi.fn>;
      getByUsername: ReturnType<typeof vi.fn>;
    };
    activity: {
      listNotificationsForAuthenticatedUser: ReturnType<typeof vi.fn>;
      markNotificationsAsRead: ReturnType<typeof vi.fn>;
    };
    issues: {
      listComments: ReturnType<typeof vi.fn>;
      createComment: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
    };
  };
  paginate: ReturnType<typeof vi.fn>;
};

function makeConfig(
  overrides: Record<string, unknown> = {},
): ChannelConfig & Record<string, unknown> {
  return {
    type: 'github',
    token: 'test-token',
    senderPolicy: 'open',
    allowedUsers: [],
    sessionScope: 'chat_thread',
    cwd: '/tmp/test',
    groupPolicy: 'open',
    dmPolicy: 'open',
    groups: { '*': {} },
    ...overrides,
  };
}

function makeBridge(): ChannelAgentBridge {
  return {
    newSession: vi.fn().mockResolvedValue('session-1'),
    loadSession: vi.fn(),
    prompt: vi.fn().mockResolvedValue('response'),
    cancelSession: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  } as unknown as ChannelAgentBridge;
}

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: '100',
    unread: true,
    reason: 'mention',
    updated_at: '2026-07-02T10:00:00.000Z',
    last_read_at: null,
    subject: {
      title: 'Test Issue',
      url: 'https://api.github.com/repos/owner/repo/issues/42',
      type: 'Issue',
    },
    repository: { full_name: 'owner/repo' },
    ...overrides,
  };
}

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    body: '@test-bot please fix this',
    user: { id: 10001, login: 'alice' },
    created_at: '2026-07-02T09:00:00.000Z',
    updated_at: '2026-07-02T09:00:00.000Z',
    ...overrides,
  };
}

/** Subclass that captures envelopes instead of running the full ChannelBase pipeline. */
class TestableGithubChannel extends GithubChannel {
  inboundEnvelopes: Envelope[] = [];
  handleInboundError: Error | null = null;

  override async handleInbound(envelope: Envelope): Promise<void> {
    if (this.handleInboundError) throw this.handleInboundError;
    this.inboundEnvelopes.push(envelope);
  }

  async testSendThreadMessage(
    chatId: string,
    threadId: string,
    text: string,
  ): Promise<void> {
    return this.sendThreadMessage(chatId, threadId, text);
  }
}

describe('GithubChannel', () => {
  let channel: TestableGithubChannel;
  let savedQwenHome: string | undefined;

  beforeEach(() => {
    savedQwenHome = process.env.QWEN_HOME;
    process.env.QWEN_HOME = mkdtempSync(join(tmpdir(), 'qwen-gh-test-'));
    vi.clearAllMocks();
    channel = new TestableGithubChannel(
      'test-github',
      makeConfig(),
      makeBridge(),
    );
    mockOctokit.rest.users.getAuthenticated.mockResolvedValue({
      data: { id: 99999, login: 'test-bot' },
    });
    mockOctokit.rest.activity.markNotificationsAsRead.mockResolvedValue({});
    mockOctokit.rest.issues.createComment.mockResolvedValue({});
  });

  afterEach(() => {
    if (savedQwenHome === undefined) delete process.env.QWEN_HOME;
    else process.env.QWEN_HOME = savedQwenHome;
  });

  async function initWithoutLoop() {
    mockOctokit.paginate.mockResolvedValueOnce([]);
    await channel.connect();
    channel.disconnect();
    channel.cursor = { lastProcessedAt: '2026-07-01T00:00:00.000Z' };
  }

  async function pollOnce() {
    await (channel as unknown as { pollOnce: () => Promise<void> }).pollOnce();
  }

  describe('connect', () => {
    it('resolves bot username', async () => {
      mockOctokit.paginate.mockResolvedValue([]);
      await channel.connect();
      expect(mockOctokit.rest.users.getAuthenticated).toHaveBeenCalled();
      channel.disconnect();
    });

    it('throws when bot identity fails', async () => {
      mockOctokit.rest.users.getAuthenticated.mockRejectedValue(
        new Error('bad token'),
      );
      await expect(channel.connect()).rejects.toThrow(
        'failed to resolve bot identity',
      );
    });

    it('resolves allowedUsers logins to numeric IDs for the gate without mutating config', async () => {
      const config = makeConfig({
        senderPolicy: 'allowlist',
        allowedUsers: ['alice'],
      });
      channel = new TestableGithubChannel('test-github', config, makeBridge());
      mockOctokit.rest.users.getByUsername.mockResolvedValue({
        data: { id: 10001, login: 'alice' },
      });
      mockOctokit.paginate.mockResolvedValue([]);
      await channel.connect();

      expect(mockOctokit.rest.users.getByUsername).toHaveBeenCalledWith({
        username: 'alice',
      });
      // config keeps the original logins so reconnect can re-resolve them.
      expect(
        (channel as unknown as { config: { allowedUsers: string[] } }).config
          .allowedUsers,
      ).toEqual(['alice']);
      const gate = (
        channel as unknown as {
          gate: { isAllowed: (senderId: string) => boolean };
        }
      ).gate;
      expect(gate.isAllowed('10001')).toBe(true);
      expect(gate.isAllowed('alice')).toBe(false);
      channel.disconnect();
    });

    it('connect() is idempotent across reconnects (does not re-resolve numeric IDs)', async () => {
      const config = makeConfig({
        senderPolicy: 'allowlist',
        allowedUsers: ['alice'],
      });
      channel = new TestableGithubChannel('test-github', config, makeBridge());
      // Resolve the login, but 404 on a numeric ID — as GitHub does for
      // GET /users/{username} when given an ID instead of a login.
      mockOctokit.rest.users.getByUsername.mockImplementation(
        async ({ username }: { username: string }) => {
          if (username === 'alice') {
            return { data: { id: 10001, login: 'alice' } };
          }
          throw new Error(`Not Found: ${username}`);
        },
      );
      mockOctokit.paginate.mockResolvedValue([]);

      await channel.connect();
      channel.disconnect();
      // Daemon bridge-crash restart calls disconnect() + connect() on the same
      // instance; this must not attempt to resolve the already-numeric ID.
      await expect(channel.connect()).resolves.toBeUndefined();
      channel.disconnect();

      expect(config.allowedUsers).toEqual(['alice']);
      expect(mockOctokit.rest.users.getByUsername).toHaveBeenCalledWith({
        username: 'alice',
      });
    });

    it('throws when allowedUser resolution fails', async () => {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ senderPolicy: 'allowlist', allowedUsers: ['alice'] }),
        makeBridge(),
      );
      mockOctokit.rest.users.getByUsername.mockRejectedValue(
        new Error('transient 502'),
      );
      mockOctokit.paginate.mockResolvedValue([]);

      await expect(channel.connect()).rejects.toThrow(
        'could not resolve allowedUser "alice"',
      );
    });
  });

  describe('poll and process', () => {
    it('processes a mention comment', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      const env = channel.inboundEnvelopes[0]!;
      expect(env.text).toBe(' please fix this');
      expect(env.senderId).toBe('10001');
      expect(env.senderName).toBe('alice');
      expect(env.chatId).toBe('owner/repo');
      expect(env.threadId).toBe('issue:42');
      expect(env.isMentioned).toBe(true);
      expect(env.isGroup).toBe(true);
      expect(env.metadata).toContain('Test Issue');
    });

    it('skips bot own comments', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({ last_read_at: '2026-07-01T12:00:00.000Z' }),
        ])
        .mockResolvedValueOnce([
          makeComment({
            user: { id: 99999, login: 'test-bot' },
            body: '@test-bot reply',
          }),
        ]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('dispatches non-mention comments with isMentioned false', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({ last_read_at: '2026-07-01T12:00:00.000Z' }),
        ])
        .mockResolvedValueOnce([
          makeComment({ body: 'just a regular comment' }),
        ]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.isMentioned).toBe(false);
    });

    it('does not false-positive on trailing newline', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({ last_read_at: '2026-07-01T12:00:00.000Z' }),
        ])
        .mockResolvedValueOnce([makeComment({ body: 'Please fix.\n' })]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.isMentioned).toBe(false);
    });

    it('detects mention case-insensitively', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment({ body: '@Test-Bot help' })]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.isMentioned).toBe(true);
    });

    it('skips non-issue/PR notifications', async () => {
      await initWithoutLoop();
      mockOctokit.paginate.mockResolvedValueOnce([
        makeNotification({
          subject: {
            title: 'v1.0.0',
            url: 'https://api.github.com/repos/owner/repo/releases/1',
            type: 'Release',
          },
        }),
      ]);

      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).toHaveBeenCalledWith(expect.objectContaining({ read: true }));
    });

    it('processes valid notification after a null-URL notification', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            id: '1',
            updated_at: '2026-07-02T08:00:00.000Z',
            subject: { title: 'Discussion', url: null, type: 'Discussion' },
          }),
          makeNotification({
            id: '2',
            updated_at: '2026-07-02T10:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.chatId).toBe('owner/repo');
    });

    it('marks notifications as read before processing (best-effort)', async () => {
      const notification = makeNotification({
        updated_at: '2026-07-02T10:00:00.000Z',
      });
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([notification])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).toHaveBeenCalledWith({
        last_read_at: '2026-07-02T10:00:00.000Z',
        read: true,
      });
      const markOrder =
        mockOctokit.rest.activity.markNotificationsAsRead.mock
          .invocationCallOrder[0]!;
      const commentOrder = mockOctokit.paginate.mock.invocationCallOrder[2]!;
      expect(markOrder).toBeLessThan(commentOrder);
    });

    it('marks all fetched notifications read even on failure', async () => {
      const good = makeNotification({
        id: '1',
        updated_at: '2026-07-02T08:00:00.000Z',
      });
      const bad = makeNotification({
        id: '2',
        updated_at: '2026-07-02T10:00:00.000Z',
      });

      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([good, bad])
        .mockResolvedValueOnce([makeComment()])
        .mockRejectedValue(new Error('rate limit'));

      await pollOnce();

      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).toHaveBeenCalledWith({
        last_read_at: '2026-07-02T10:00:00.000Z',
        read: true,
      });
    });

    it('aborts the poll cycle without advancing cursor when markNotificationsAsRead fails', async () => {
      await initWithoutLoop();
      mockOctokit.paginate.mockResolvedValueOnce([
        makeNotification({ updated_at: '2026-07-02T10:00:00.000Z' }),
      ]);
      mockOctokit.rest.activity.markNotificationsAsRead.mockRejectedValue(
        new Error('server error'),
      );

      await expect(pollOnce()).rejects.toThrow('server error');
      expect(channel.cursor.lastProcessedAt).toBe('2026-07-01T00:00:00.000Z');
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('continues processing remaining notifications after a per-thread error', async () => {
      const good1 = makeNotification({
        id: '1',
        updated_at: '2026-07-02T08:00:00.000Z',
        subject: {
          title: 'Issue 1',
          url: 'https://api.github.com/repos/owner/repo/issues/1',
          type: 'Issue',
        },
      });
      const bad = makeNotification({
        id: '2',
        updated_at: '2026-07-02T09:00:00.000Z',
        subject: {
          title: 'Issue 2',
          url: 'https://api.github.com/repos/owner/repo/issues/2',
          type: 'Issue',
        },
      });
      const good2 = makeNotification({
        id: '3',
        updated_at: '2026-07-02T10:00:00.000Z',
        subject: {
          title: 'Issue 3',
          url: 'https://api.github.com/repos/owner/repo/issues/3',
          type: 'Issue',
        },
      });

      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([good1, bad, good2])
        .mockResolvedValueOnce([makeComment({ id: 2001 })]) // good1
        .mockRejectedValueOnce(new Error('API error')) // bad, attempt 1
        .mockRejectedValueOnce(new Error('API error')) // bad, attempt 2
        .mockRejectedValueOnce(new Error('API error')) // bad, attempt 3 -> throws
        .mockResolvedValueOnce([makeComment({ id: 2002 })]); // good2

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(2);
      expect(channel.inboundEnvelopes.map((e) => e.messageId)).toEqual([
        '2001',
        '2002',
      ]);
    });

    it('excludes comments created after the batch maxUpdatedAt', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({ updated_at: '2026-07-02T10:00:00.000Z' }),
        ])
        .mockResolvedValueOnce([
          makeComment({ id: 1, created_at: '2026-07-02T09:00:00.000Z' }),
          makeComment({ id: 2, created_at: '2026-07-02T10:30:00.000Z' }),
        ]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.messageId).toBe('1');
    });

    it('uses cursor as enumeration window lower bound', async () => {
      const notification = makeNotification({
        last_read_at: '2026-07-01T12:00:00.000Z',
      });
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([notification])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      // Call 1: initWithoutLoop's poll; call 2: listNotifications;
      // call 3: listComments — the comment enumeration window.
      expect(mockOctokit.paginate).toHaveBeenNthCalledWith(
        3,
        expect.anything(),
        expect.objectContaining({ since: '2026-07-01T00:00:00.000Z' }),
      );
    });

    it('excludes comments at or below the cursor window lower bound', async () => {
      await initWithoutLoop();
      // cursor is 2026-07-01T00:00:00.000Z → windowSince = same
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({ updated_at: '2026-07-02T10:00:00.000Z' }),
        ])
        .mockResolvedValueOnce([
          makeComment({ id: 1, created_at: '2026-07-01T00:00:00.000Z' }),
          makeComment({ id: 2, created_at: '2026-07-02T09:00:00.000Z' }),
        ]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.messageId).toBe('2');
    });

    it('retries on transient API failure and succeeds', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce([]);
      mockOctokit.paginate.mockClear();

      await pollOnce();

      expect(mockOctokit.paginate).toHaveBeenCalledTimes(2);
    });

    it('propagates error after all retries exhausted', async () => {
      await initWithoutLoop();
      mockOctokit.paginate.mockRejectedValue(new Error('persistent'));
      mockOctokit.paginate.mockClear();

      await expect(pollOnce()).rejects.toThrow('persistent');
      expect(mockOctokit.paginate).toHaveBeenCalledTimes(3);
    });
  });

  describe('sendThreadMessage', () => {
    it('throws on invalid threadId format', async () => {
      await expect(
        channel.testSendThreadMessage('owner/repo', 'discussion:42', 'text'),
      ).rejects.toThrow('invalid threadId format');
    });
  });

  describe('first contact (new issue body)', () => {
    it('feeds issue body when no comments and issue is new', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification({ last_read_at: null })])
        .mockResolvedValueOnce([]); // no comments

      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          body: '@test-bot implement this feature',
          created_at: '2026-07-02T08:00:00.000Z',
          user: { id: 10002, login: 'bob' },
        },
      });

      channel.cursor = { lastProcessedAt: '2026-07-01T00:00:00.000Z' };
      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      const env = channel.inboundEnvelopes[0]!;
      expect(env.text).toBe(' implement this feature');
      expect(env.senderId).toBe('10002');
    });

    it('dispatches issue body without mention as isMentioned false', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification({ last_read_at: null })])
        .mockResolvedValueOnce([]);

      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          body: 'no mention here',
          created_at: '2026-07-02T08:00:00.000Z',
          user: { id: 10002, login: 'bob' },
        },
      });

      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.isMentioned).toBe(false);
    });

    it('feeds PR body when no comments and PR is new', async () => {
      const prNotification = makeNotification({
        last_read_at: null,
        subject: {
          title: 'feat: add divide',
          url: 'https://api.github.com/repos/owner/repo/pulls/99',
          type: 'PullRequest',
        },
      });
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification])
        .mockResolvedValueOnce([]); // no comments

      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          body: '@test-bot review this PR',
          created_at: '2026-07-02T08:00:00.000Z',
          user: { id: 10003, login: 'carol' },
        },
      });

      channel.cursor = { lastProcessedAt: '2026-07-01T00:00:00.000Z' };
      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      const env = channel.inboundEnvelopes[0]!;
      expect(env.text).toBe(' review this PR');
      expect(env.senderId).toBe('10003');
      expect(env.threadId).toBe('pr:99');
      expect(env.metadata).toContain('Pull Request');
    });

    it('feeds issue body whose notification arrived after the cursor passed created_at', async () => {
      await initWithoutLoop();
      // The cursor already advanced past the issue's created_at (another
      // notification was processed first), but this thread was never read
      // (last_read_at: null) — a late-arriving notification. It is still first
      // contact and must be fed, not dropped as "already seen".
      channel.cursor = { lastProcessedAt: '2026-07-02T09:00:00.000Z' };
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification({ last_read_at: null })])
        .mockResolvedValueOnce([]);

      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          body: '@test-bot late notification',
          created_at: '2026-07-02T08:00:00.000Z',
          user: { id: 10002, login: 'bob' },
        },
      });

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.text).toBe(' late notification');
    });

    it('does not feed the same issue body twice when the thread is re-fetched unread', async () => {
      await initWithoutLoop();
      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          body: '@test-bot only once',
          created_at: '2026-07-02T08:00:00.000Z',
          user: { id: 10002, login: 'bob' },
        },
      });
      // Two consecutive polls both see the thread unread with last_read_at
      // null — simulating a mark-read that failed to mark this thread (its
      // updated_at bumped past the cutoff). The body must be fed only once.
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification({ last_read_at: null })])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeNotification({ last_read_at: null })])
        .mockResolvedValueOnce([]);

      await pollOnce();
      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
    });

    it('evicts oldest dispatchedBodies entries beyond the limit', async () => {
      await initWithoutLoop();
      // Pre-fill cursor with 500 entries (the max)
      channel.cursor.dispatchedBodies = Array.from(
        { length: 500 },
        (_, i) => `owner/repo|issue:${i}`,
      );
      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          body: '@test-bot new issue',
          created_at: '2026-07-02T08:00:00.000Z',
          user: { id: 10002, login: 'bob' },
        },
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            last_read_at: null,
            subject: {
              title: 'New Issue',
              url: 'https://api.github.com/repos/owner/repo/issues/999',
              type: 'Issue',
            },
          }),
        ])
        .mockResolvedValueOnce([]);

      await pollOnce();

      expect(channel.cursor.dispatchedBodies).toHaveLength(500);
      // Oldest entry evicted, newest retained
      expect(channel.cursor.dispatchedBodies).not.toContain(
        'owner/repo|issue:0',
      );
      expect(channel.cursor.dispatchedBodies).toContain('owner/repo|issue:999');
    });

    it('skips bot-authored issue body', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification({ last_read_at: null })])
        .mockResolvedValueOnce([]);

      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          body: '@test-bot self-created issue',
          created_at: '2026-07-02T08:00:00.000Z',
          user: { id: 99999, login: 'test-bot' },
        },
      });

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('does not suppress first-contact body when mention is from a disallowed sender', async () => {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ senderPolicy: 'allowlist', allowedUsers: ['bob'] }),
        makeBridge(),
      );
      mockOctokit.rest.users.getByUsername.mockResolvedValue({
        data: { id: 10002, login: 'bob' },
      });
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await channel.connect();
      channel.disconnect();
      channel.cursor = { lastProcessedAt: '2026-07-01T00:00:00.000Z' };

      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification({ last_read_at: null })])
        .mockResolvedValueOnce([
          makeComment({
            body: '@test-bot help',
            user: { id: 10001, login: 'alice' },
          }),
        ]);
      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          body: '@test-bot implement this',
          created_at: '2026-07-02T08:00:00.000Z',
          user: { id: 10002, login: 'bob' },
        },
      });

      await pollOnce();

      const bodyEnvelope = channel.inboundEnvelopes.find((e) =>
        e.messageId.startsWith('issue-body-'),
      );
      expect(bodyEnvelope).toBeDefined();
      expect(bodyEnvelope!.senderId).toBe('10002');
    });
  });

  describe('error handling', () => {
    it('posts error comment when handleInbound fails', async () => {
      channel.handleInboundError = new Error('agent down');
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Failed to process'),
        }),
      );
    });

    it('still marks thread as read after handleInbound failure', async () => {
      channel.handleInboundError = new Error('agent down');
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).toHaveBeenCalledWith(expect.objectContaining({ read: true }));
    });

    it('posts only one error comment when mention dispatch fails on a new thread', async () => {
      channel.handleInboundError = new Error('agent down');
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification({ last_read_at: null })])
        .mockResolvedValueOnce([makeComment()]);
      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          body: '@test-bot help',
          created_at: '2026-07-02T08:00:00.000Z',
          user: { id: 10002, login: 'bob' },
        },
      });

      await pollOnce();

      const errorComments =
        mockOctokit.rest.issues.createComment.mock.calls.filter(
          (call: Array<{ body?: string }>) =>
            call[0]?.body?.includes('Failed to process'),
        );
      expect(errorComments).toHaveLength(1);
    });
  });

  describe('sendThreadMessage', () => {
    it('posts comment on the correct issue', async () => {
      mockOctokit.paginate.mockResolvedValue([]);
      await channel.connect();

      await (
        channel as unknown as {
          sendThreadMessage: (
            c: string,
            t: string | undefined,
            text: string,
          ) => Promise<void>;
        }
      ).sendThreadMessage('owner/repo', 'issue:42', 'Here is my response');

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 42,
        body: 'Here is my response',
      });
      channel.disconnect();
    });

    it('falls through to sendMessage when threadId is undefined', async () => {
      mockOctokit.paginate.mockResolvedValue([]);
      await channel.connect();

      await expect(
        (
          channel as unknown as {
            sendThreadMessage: (
              c: string,
              t: string | undefined,
              text: string,
            ) => Promise<void>;
          }
        ).sendThreadMessage('owner/repo', undefined, 'response'),
      ).rejects.toThrow('requires a threadId');
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      channel.disconnect();
    });
  });

  describe('sendMessage', () => {
    it('throws', async () => {
      await expect(channel.sendMessage('owner/repo', 'text')).rejects.toThrow(
        'requires a threadId',
      );
    });
  });

  describe('pollInterval', () => {
    it('respects configured pollInterval', () => {
      const ch = new TestableGithubChannel(
        'test',
        makeConfig({ pollInterval: 30000 }),
        makeBridge(),
      );
      expect((ch as unknown as { pollInterval: number }).pollInterval).toBe(
        30000,
      );
    });

    it('defaults to 60000 when not configured', () => {
      const ch = new TestableGithubChannel('test', makeConfig(), makeBridge());
      expect((ch as unknown as { pollInterval: number }).pollInterval).toBe(
        60000,
      );
    });

    it.each([0, -1, NaN, Infinity, '60000'])(
      'falls back to 60000 for invalid pollInterval %s',
      (value) => {
        const ch = new TestableGithubChannel(
          'test',
          makeConfig({ pollInterval: value }),
          makeBridge(),
        );
        expect((ch as unknown as { pollInterval: number }).pollInterval).toBe(
          60000,
        );
      },
    );
  });

  describe('plugin', () => {
    it('declares chat_thread as defaultSessionScope', async () => {
      const { plugin } = await import('./index.js');
      expect(plugin.defaultSessionScope).toBe('chat_thread');
    });
  });

  describe('validateCursor', () => {
    function validate(parsed: unknown) {
      return (
        channel as unknown as {
          validateCursor: (
            p: unknown,
          ) => { lastProcessedAt: string; dispatchedBodies?: string[] } | null;
        }
      ).validateCursor(parsed);
    }

    it('normalizes falsy non-array dispatchedBodies to empty array', () => {
      for (const bad of [false, 0, '', null]) {
        const result = validate({
          lastProcessedAt: '2026-07-01T00:00:00.000Z',
          dispatchedBodies: bad,
        });
        expect(result).not.toBeNull();
        expect(result!.dispatchedBodies).toEqual([]);
      }
    });

    it('accepts valid dispatchedBodies array', () => {
      const result = validate({
        lastProcessedAt: '2026-07-01T00:00:00.000Z',
        dispatchedBodies: ['owner/repo|issue:1'],
      });
      expect(result).not.toBeNull();
      expect(result!.dispatchedBodies).toEqual(['owner/repo|issue:1']);
    });

    it('accepts missing dispatchedBodies', () => {
      const result = validate({
        lastProcessedAt: '2026-07-01T00:00:00.000Z',
      });
      expect(result).not.toBeNull();
      expect(result!.dispatchedBodies).toBeUndefined();
    });
  });

  describe('githubApi retry backoff', () => {
    function githubApi(
      fn: () => Promise<unknown>,
      retries = 3,
    ): Promise<unknown> {
      return (
        channel as unknown as {
          githubApi: (
            fn: () => Promise<unknown>,
            label: string,
            retries?: number,
          ) => Promise<unknown>;
        }
      ).githubApi(fn, 'test-op', retries);
    }

    function stubSleep(): ReturnType<typeof vi.fn> {
      const sleep = vi.fn().mockResolvedValue(undefined);
      (
        channel as unknown as {
          abortableSleep: (ms: number) => Promise<void>;
        }
      ).abortableSleep = sleep;
      return sleep;
    }

    function httpError(
      status: number,
      headers: Record<string, string | number> = {},
    ): Error {
      return Object.assign(new Error(`HTTP ${status}`), {
        status,
        response: { headers },
      });
    }

    it('honors the retry-after header (seconds → ms)', async () => {
      const sleep = stubSleep();
      const fn = vi
        .fn()
        .mockRejectedValueOnce(httpError(429, { 'retry-after': '2' }))
        .mockResolvedValueOnce('ok');
      await expect(githubApi(fn)).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(2000);
    });

    it('computes cooldown from x-ratelimit-reset on a 403 rate limit', async () => {
      const now = 1_700_000_000_000;
      const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
      const sleep = stubSleep();
      const resetSeconds = now / 1000 + 5; // rate limit resets in 5s
      const fn = vi
        .fn()
        .mockRejectedValueOnce(
          httpError(403, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(resetSeconds),
          }),
        )
        .mockResolvedValueOnce('ok');
      await expect(githubApi(fn)).resolves.toBe('ok');
      expect(sleep).toHaveBeenCalledWith(6000); // 5000 until reset + 1000 buffer
      dateSpy.mockRestore();
    });

    it('falls back to exponential backoff without rate-limit headers', async () => {
      const sleep = stubSleep();
      const fn = vi
        .fn()
        .mockRejectedValueOnce(httpError(500))
        .mockRejectedValueOnce(httpError(502))
        .mockResolvedValueOnce('ok');
      await expect(githubApi(fn)).resolves.toBe('ok');
      expect(sleep).toHaveBeenNthCalledWith(1, 1000); // 1000 * 2^0
      expect(sleep).toHaveBeenNthCalledWith(2, 2000); // 1000 * 2^1
    });

    it('rethrows once retries are exhausted', async () => {
      const sleep = stubSleep();
      const fn = vi.fn().mockRejectedValue(httpError(500));
      await expect(githubApi(fn, 3)).rejects.toThrow('HTTP 500');
      expect(fn).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2); // no sleep after the final attempt
    });
  });

  describe('webOrigin', () => {
    async function connectAndReadWebOrigin(
      config: ChannelConfig & Record<string, unknown>,
    ): Promise<string> {
      const ch = new TestableGithubChannel('test-ghe', config, makeBridge());
      mockOctokit.paginate.mockResolvedValue([]);
      await ch.connect();
      const origin = (ch as unknown as { webOrigin: string }).webOrigin;
      ch.disconnect();
      return origin;
    }

    it('defaults to https://github.com when no baseUrl is set', async () => {
      await expect(connectAndReadWebOrigin(makeConfig())).resolves.toBe(
        'https://github.com',
      );
    });

    it('rewrites the api.github.com baseUrl to github.com', async () => {
      await expect(
        connectAndReadWebOrigin(
          makeConfig({ baseUrl: 'https://api.github.com' }),
        ),
      ).resolves.toBe('https://github.com');
    });

    it('strips /api/v3 from a GitHub Enterprise baseUrl', async () => {
      await expect(
        connectAndReadWebOrigin(
          makeConfig({ baseUrl: 'https://github.example.com/api/v3' }),
        ),
      ).resolves.toBe('https://github.example.com');
    });

    it('strips a trailing-slash /api/v3/ from a GitHub Enterprise baseUrl', async () => {
      await expect(
        connectAndReadWebOrigin(
          makeConfig({ baseUrl: 'https://github.example.com/api/v3/' }),
        ),
      ).resolves.toBe('https://github.example.com');
    });
  });
});
