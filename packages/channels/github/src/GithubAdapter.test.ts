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
      },
      activity: {
        listNotificationsForAuthenticatedUser: vi.fn(),
        markNotificationsAsRead: vi.fn(),
      },
      issues: {
        listComments: vi.fn(),
        listEvents: vi.fn(),
        createComment: vi.fn(),
        get: vi.fn(),
      },
      pulls: {
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
    };
    activity: {
      listNotificationsForAuthenticatedUser: ReturnType<typeof vi.fn>;
      markNotificationsAsRead: ReturnType<typeof vi.fn>;
    };
    issues: {
      listComments: ReturnType<typeof vi.fn>;
      listEvents: ReturnType<typeof vi.fn>;
      createComment: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
    };
    pulls: {
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
  const id = (overrides.id as number | undefined) ?? 1001;
  return {
    id,
    node_id: `C_kw${id}`,
    body: '@test-bot please fix this',
    user: { id: 10001, login: 'alice' },
    created_at: '2026-07-02T09:00:00.000Z',
    updated_at: '2026-07-02T09:00:00.000Z',
    ...overrides,
  };
}

function makeIssueEvent(overrides: Record<string, unknown> = {}) {
  const id = (overrides.id as number | undefined) ?? 9;
  return {
    id,
    node_id: `E_${id}`,
    event: 'review_requested',
    created_at: '2026-07-02T09:00:00.000Z',
    review_requester: { login: 'maintainer' },
    requested_reviewer: { login: 'test-bot' },
    ...overrides,
  };
}

/** Subclass that captures envelopes instead of running the full ChannelBase pipeline. */
class TestableGithubChannel extends GithubChannel {
  inboundEnvelopes: Envelope[] = [];
  handleInboundError: Error | null = null;
  usePreflight = false;

  override async handleInbound(envelope: Envelope): Promise<void> {
    if (this.handleInboundError) throw this.handleInboundError;
    if (this.usePreflight && !(await this.preflightInbound(envelope))) return;
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
    mockOctokit.paginate.mockReset();
    channel = new TestableGithubChannel(
      'test-github',
      makeConfig(),
      makeBridge(),
    );
    mockOctokit.rest.users.getAuthenticated.mockResolvedValue({
      data: { id: 99999, login: 'test-bot' },
    });
    mockOctokit.rest.activity.markNotificationsAsRead.mockResolvedValue({});
    mockOctokit.rest.issues.listEvents.mockReset().mockResolvedValue({
      data: [],
      headers: {},
    });
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

    it('normalizes allowedUsers to lowercase for case-insensitive matching', async () => {
      const config = makeConfig({
        senderPolicy: 'allowlist',
        allowedUsers: ['Alice'],
      });
      channel = new TestableGithubChannel('test-github', config, makeBridge());
      mockOctokit.paginate.mockResolvedValue([]);
      await channel.connect();

      const gate = (
        channel as unknown as {
          gate: { isAllowed: (senderId: string) => boolean };
        }
      ).gate;
      expect(gate.isAllowed('alice')).toBe(true);
      expect(gate.isAllowed('bob')).toBe(false);
      // config is normalized too — ChannelBase reads it directly
      expect(config.allowedUsers).toEqual(['alice']);
      channel.disconnect();
    });

    it('connect() is idempotent across reconnects', async () => {
      const config = makeConfig({
        senderPolicy: 'allowlist',
        allowedUsers: ['Alice'],
      });
      channel = new TestableGithubChannel('test-github', config, makeBridge());
      mockOctokit.paginate.mockResolvedValue([]);
      await channel.connect();
      channel.disconnect();
      await expect(channel.connect()).resolves.toBeUndefined();
      channel.disconnect();
      expect(config.allowedUsers).toEqual(['alice']);
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
      expect(env.senderId).toBe('alice');
      expect(env.senderName).toBe('alice');
      expect(env.chatId).toBe('owner/repo');
      expect(env.threadId).toBe('issue:42');
      expect(env.isMentioned).toBe(true);
      expect(env.isGroup).toBe(true);
      expect(env.metadata).toContain('Test Issue');
      // senderId must be comparable to config.allowedUsers — ChannelBase
      // compares them directly in isAuthorizedForSharedSessionTarget.
      const cfg = channel as unknown as {
        config: { allowedUsers: string[] };
      };
      cfg.config.allowedUsers = ['alice'];
      expect(cfg.config.allowedUsers).toContain(env.senderId);
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

    it('dispatches non-mention comments for generic reasons', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'subscribed',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({ body: 'just a regular comment' }),
        ]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.isMentioned).toBe(false);
      expect(channel.inboundEnvelopes[0]!.metadata).toContain(
        'Trigger: subscribed.',
      );
    });

    it('skips non-mention comments for mention notifications', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({ body: 'just a regular comment' }),
        ]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('does not false-positive on trailing newline', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'subscribed',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
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
      ).toHaveBeenCalledWith({
        last_read_at: '2026-07-02T10:00:00.000Z',
        read: true,
      });
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

    it('marks notifications as read after processing', async () => {
      const notification = makeNotification({
        updated_at: '2026-07-02T10:00:00.000Z',
      });
      await initWithoutLoop();
      mockOctokit.rest.activity.markNotificationsAsRead.mockClear();
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
      expect(markOrder).toBeGreaterThan(commentOrder);
    });

    it('does not mark or advance the batch after a failure', async () => {
      const good = makeNotification({
        id: '1',
        updated_at: '2026-07-02T08:00:00.000Z',
      });
      const bad = makeNotification({
        id: '2',
        updated_at: '2026-07-02T10:00:00.000Z',
      });

      await initWithoutLoop();
      mockOctokit.rest.activity.markNotificationsAsRead.mockClear();
      mockOctokit.paginate
        .mockResolvedValueOnce([good, bad])
        .mockResolvedValueOnce([makeComment()])
        .mockRejectedValue(new Error('rate limit'));

      await expect(pollOnce()).rejects.toThrow('rate limit');

      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).not.toHaveBeenCalled();
      expect(channel.cursor.lastProcessedAt).toBe('2026-07-01T00:00:00.000Z');
      expect(channel.inboundEnvelopes).toHaveLength(1);
    });

    it('persists handled comments before a mark-read retry', async () => {
      await initWithoutLoop();
      mockOctokit.rest.activity.markNotificationsAsRead.mockClear();
      const notification = makeNotification({
        last_read_at: null,
        updated_at: '2026-07-02T10:00:00.000Z',
      });
      const comment = makeComment();
      mockOctokit.paginate
        .mockResolvedValueOnce([notification])
        .mockResolvedValueOnce([comment]);
      mockOctokit.rest.activity.markNotificationsAsRead.mockRejectedValue(
        new Error('server error'),
      );

      await expect(pollOnce()).rejects.toThrow('server error');
      expect(channel.cursor.lastProcessedAt).toBe('2026-07-01T00:00:00.000Z');
      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.cursor.dispatchedComments).toContain('C_kw1001');

      mockOctokit.rest.activity.markNotificationsAsRead.mockResolvedValue({});
      mockOctokit.paginate
        .mockResolvedValueOnce([notification])
        .mockResolvedValueOnce([comment]);
      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(mockOctokit.rest.issues.get).not.toHaveBeenCalled();
    });

    it('continues after a failed notification so other threads are not blocked', async () => {
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
      mockOctokit.rest.activity.markNotificationsAsRead.mockClear();
      mockOctokit.paginate
        .mockResolvedValueOnce([good1, bad, good2])
        .mockResolvedValueOnce([makeComment({ id: 2001 })]) // good1
        .mockRejectedValueOnce(new Error('API error')) // bad, attempt 1
        .mockRejectedValueOnce(new Error('API error')) // bad, attempt 2
        .mockRejectedValueOnce(new Error('API error')) // bad, attempt 3 -> throws
        .mockResolvedValueOnce([makeComment({ id: 2002 })]); // good2

      await expect(pollOnce()).rejects.toThrow('API error');

      expect(channel.inboundEnvelopes.map((e) => e.messageId)).toEqual([
        '2001',
        '2002',
      ]);
      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).not.toHaveBeenCalled();
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

  describe('reason routing', () => {
    it('dispatches a late review_requested event from PR metadata', async () => {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({
          senderPolicy: 'allowlist',
          allowedUsers: ['maintainer'],
        }),
        makeBridge(),
      );
      await initWithoutLoop();
      channel.usePreflight = true;
      mockOctokit.paginate.mockResolvedValueOnce([
        makeNotification({
          reason: 'review_requested',
          subject: {
            title: 'feat: add divide',
            url: 'https://api.github.com/repos/owner/repo/pulls/99',
            type: 'PullRequest',
          },
        }),
      ]);
      mockOctokit.rest.issues.listEvents.mockResolvedValue({
        data: [
          makeIssueEvent({
            id: 7,
            node_id: 'E_review',
            created_at: '2026-06-30T09:00:00.000Z',
          }),
        ],
        headers: {},
      });
      mockOctokit.rest.pulls.get.mockResolvedValue({
        data: {
          body: 'implement division',
          state: 'open',
          draft: false,
          user: { login: 'alice' },
          head: { ref: 'feature-divide' },
          base: { ref: 'main' },
        },
      });

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]).toMatchObject({
        threadId: 'pr:99',
        senderId: 'maintainer',
        isMentioned: true,
      });
      expect(channel.inboundEnvelopes[0]!.text).toContain('untrusted data');
      expect(channel.inboundEnvelopes[0]!.text).toContain('implement division');
      expect(channel.inboundEnvelopes[0]!.metadata).toContain(
        'Author: alice | State: open | Draft: false',
      );
      expect(channel.inboundEnvelopes[0]!.metadata).toContain(
        'feature-divide → main',
      );
    });

    it('dispatches assign from issue metadata', async () => {
      await initWithoutLoop();
      channel.usePreflight = true;
      mockOctokit.paginate.mockResolvedValueOnce([
        makeNotification({ reason: 'assign' }),
      ]);
      mockOctokit.rest.issues.listEvents.mockResolvedValue({
        data: [
          makeIssueEvent({
            id: 8,
            node_id: 'E_assign',
            event: 'assigned',
            assigner: { login: 'bob' },
            assignee: { login: 'test-bot' },
          }),
        ],
        headers: {},
      });
      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          body: 'the build is broken',
          state: 'open',
          user: { login: 'bob' },
        },
      });

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]).toMatchObject({
        senderId: 'bob',
        isMentioned: true,
      });
      expect(channel.inboundEnvelopes[0]!.text).toContain(
        'the build is broken',
      );
      expect(channel.inboundEnvelopes[0]!.metadata).toContain(
        'Trigger: assign.',
      );
    });

    it.each([
      {
        name: 'an already-read direct request',
        reason: 'review_requested' as const,
        lastReadAt: '2026-07-02T09:30:00.000Z',
        events: [makeIssueEvent()],
      },
      {
        name: 'a removed direct request',
        reason: 'review_requested' as const,
        lastReadAt: null,
        events: [
          makeIssueEvent(),
          makeIssueEvent({
            id: 10,
            event: 'review_request_removed',
            created_at: '2026-07-02T09:30:00.000Z',
          }),
        ],
      },
      {
        name: 'a team request',
        reason: 'review_requested' as const,
        lastReadAt: null,
        events: [
          makeIssueEvent({
            requested_reviewer: undefined,
            requested_team: { name: 'other-team' },
          }),
        ],
      },
      {
        name: 'an assignment followed by unassign',
        reason: 'assign' as const,
        lastReadAt: null,
        events: [
          makeIssueEvent({
            event: 'assigned',
            assignee: { login: 'test-bot' },
          }),
          makeIssueEvent({
            id: 10,
            event: 'unassigned',
            created_at: '2026-07-02T09:30:00.000Z',
            assignee: { login: 'test-bot' },
          }),
        ],
      },
    ])(
      'ignores sticky $reason after $name',
      async ({ reason, lastReadAt, events }) => {
        await initWithoutLoop();
        mockOctokit.rest.issues.listEvents.mockResolvedValue({
          data: events,
          headers: {},
        });

        const trigger = await (
          channel as unknown as {
            findMetaTrigger: (
              ctx: Record<string, unknown>,
              reason: 'review_requested' | 'assign',
            ) => Promise<unknown>;
          }
        ).findMetaTrigger(
          {
            chatId: 'owner/repo',
            threadId: 'pr:99',
            issueNumber: 99,
            lastReadAt,
            windowSince: '2026-07-01T00:00:00.000Z',
            maxUpdatedAt: '2026-07-02T10:00:00.000Z',
            subjectTitle: 'feat: add divide',
          },
          reason,
        );

        expect(trigger).toBeNull();
      },
    );

    it('aggregates only comments from allowed senders', async () => {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({
          senderPolicy: 'allowlist',
          allowedUsers: ['bob'],
          groups: { '*': { requireMention: false } },
        }),
        makeBridge(),
      );
      await initWithoutLoop();
      channel.usePreflight = true;
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({
            id: 1,
            body: 'not allowed',
            user: { login: 'alice' },
          }),
          makeComment({
            id: 2,
            body: '@test-bot allowed',
            user: { login: 'bob' },
          }),
        ]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]).toMatchObject({
        senderId: 'bob',
        isMentioned: false,
      });
      expect(channel.inboundEnvelopes[0]!.text).not.toContain('@alice');
      expect(channel.inboundEnvelopes[0]!.text).toContain(
        '@bob: @test-bot allowed',
      );
    });

    it('truncates aggregate comment bodies without splitting surrogate pairs', async () => {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ groups: { '*': { requireMention: false } } }),
        makeBridge(),
      );
      await initWithoutLoop();
      channel.usePreflight = true;
      const emoji = '\u{1F600}';
      const body = 'a'.repeat(999) + emoji;
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({ id: 1, body, user: { login: 'alice' } }),
        ]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      const text = channel.inboundEnvelopes[0]!.text;
      expect(text).toContain('a'.repeat(999) + emoji);
    });

    it('keeps unmentioned aggregate comments behind the group gate', async () => {
      await initWithoutLoop();
      channel.usePreflight = true;
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([makeComment({ body: 'ordinary comment' })]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('skips comments already persisted in the cursor', async () => {
      await initWithoutLoop();
      channel.cursor.dispatchedComments = ['C_kw1001'];
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
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
      expect(env.senderId).toBe('bob');
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
      expect(env.senderId).toBe('carol');
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

    it('keeps in-flight dedup keys until the poll succeeds', async () => {
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
        .mockResolvedValueOnce([])
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
      mockOctokit.rest.activity.markNotificationsAsRead.mockRejectedValue(
        new Error('server error'),
      );

      await expect(pollOnce()).rejects.toThrow('server error');

      expect(channel.cursor.dispatchedBodies).toHaveLength(501);
      expect(channel.cursor.dispatchedBodies).toContain('owner/repo|issue:0');

      mockOctokit.rest.activity.markNotificationsAsRead.mockResolvedValue({});

      await pollOnce();

      expect(channel.cursor.dispatchedBodies).toHaveLength(500);
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
      expect(bodyEnvelope!.senderId).toBe('bob');
    });
  });

  describe('error handling', () => {
    it('does not post an error comment while the notification will retry', async () => {
      channel.handleInboundError = new Error('agent down');
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await expect(pollOnce()).rejects.toThrow('agent down');

      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
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
          validateCursor: (p: unknown) => {
            lastProcessedAt: string;
            dispatchedBodies?: string[];
            dispatchedComments?: string[];
            dispatchedEvents?: string[];
          } | null;
        }
      ).validateCursor(parsed);
    }

    it.each([
      'dispatchedBodies',
      'dispatchedComments',
      'dispatchedEvents',
    ] as const)('normalizes invalid %s values', (field) => {
      for (const bad of [false, 0, '', null]) {
        const result = validate({
          lastProcessedAt: '2026-07-01T00:00:00.000Z',
          [field]: bad,
        });
        expect(result).not.toBeNull();
        expect(result![field]).toEqual([]);
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
