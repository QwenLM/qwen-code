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
  });

  describe('poll and process', () => {
    it('processes a mention comment', async () => {
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await initWithoutLoop();
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
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([
          makeComment({
            user: { id: 99999, login: 'test-bot' },
            body: '@test-bot reply',
          }),
        ]);

      await initWithoutLoop();
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('dispatches non-mention comments with isMentioned false', async () => {
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([
          makeComment({ body: 'just a regular comment' }),
        ]);

      await initWithoutLoop();
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.isMentioned).toBe(false);
    });

    it('does not false-positive on trailing newline', async () => {
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment({ body: 'Please fix.\n' })]);

      await initWithoutLoop();
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.isMentioned).toBe(false);
    });

    it('detects mention case-insensitively', async () => {
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment({ body: '@Test-Bot help' })]);

      await initWithoutLoop();
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

    it('calls markNotificationsAsRead with latest updated_at', async () => {
      const notification = makeNotification({
        updated_at: '2026-07-02T10:00:00.000Z',
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([notification])
        .mockResolvedValueOnce([makeComment()]);

      await initWithoutLoop();
      await pollOnce();

      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).toHaveBeenCalledWith({
        last_read_at: '2026-07-02T10:00:00.000Z',
        read: true,
      });
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

    it('uses last_read_at as enumeration window when available', async () => {
      const notification = makeNotification({
        last_read_at: '2026-07-01T12:00:00.000Z',
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([notification])
        .mockResolvedValueOnce([makeComment()]);

      await initWithoutLoop();
      await pollOnce();

      expect(mockOctokit.paginate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ since: '2026-07-01T12:00:00.000Z' }),
      );
    });
  });

  describe('first contact (new issue body)', () => {
    it('feeds issue body when no comments and issue is new', async () => {
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

      await initWithoutLoop();
      channel.cursor = { lastProcessedAt: '2026-07-01T00:00:00.000Z' };
      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      const env = channel.inboundEnvelopes[0]!;
      expect(env.text).toBe(' implement this feature');
      expect(env.senderId).toBe('10002');
    });

    it('dispatches issue body without mention as isMentioned false', async () => {
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

      await initWithoutLoop();
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

      await initWithoutLoop();
      channel.cursor = { lastProcessedAt: '2026-07-01T00:00:00.000Z' };
      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      const env = channel.inboundEnvelopes[0]!;
      expect(env.text).toBe(' review this PR');
      expect(env.senderId).toBe('10003');
      expect(env.threadId).toBe('pr:99');
      expect(env.metadata).toContain('Pull Request');
    });
  });

  describe('error handling', () => {
    it('posts error comment when handleInbound fails', async () => {
      channel.handleInboundError = new Error('agent down');
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await initWithoutLoop();
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
  });
});
