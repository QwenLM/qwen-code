import { describe, it, expect, vi, beforeEach } from 'vitest';
import process from 'node:process';
import type {
  ChannelAgentBridge,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';

vi.mock('octokit', () => {
  const mockOctokit = {
    rest: {
      users: { getAuthenticated: vi.fn() },
      activity: {
        listNotificationsForAuthenticatedUser: vi.fn(),
        markThreadAsRead: vi.fn(),
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
    loadPollCursor: vi.fn(() => '2026-07-01T00:00:00.000Z'),
    savePollCursor: vi.fn(),
  };
});

import { GithubChannel } from './GithubAdapter.js';

const mockOctokit = (
  (await import('octokit')) as unknown as {
    __mockOctokit: Record<string, unknown>;
  }
).__mockOctokit as {
  rest: {
    users: { getAuthenticated: ReturnType<typeof vi.fn> };
    activity: {
      listNotificationsForAuthenticatedUser: ReturnType<typeof vi.fn>;
      markThreadAsRead: ReturnType<typeof vi.fn>;
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
    user: { login: 'alice' },
    created_at: '2026-07-02T09:00:00.000Z',
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

  beforeEach(() => {
    vi.clearAllMocks();
    channel = new TestableGithubChannel(
      'test-github',
      makeConfig(),
      makeBridge(),
    );
    mockOctokit.rest.users.getAuthenticated.mockResolvedValue({
      data: { login: 'test-bot' },
    });
    mockOctokit.rest.activity.markThreadAsRead.mockResolvedValue({});
    mockOctokit.rest.issues.createComment.mockResolvedValue({});
  });

  async function initWithoutLoop() {
    // Initialize octokit (sets botUsername) without letting the poll loop race
    mockOctokit.paginate.mockResolvedValueOnce([]);
    await channel.connect();
    channel.disconnect();
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

    it('continues when bot identity fails', async () => {
      mockOctokit.rest.users.getAuthenticated.mockRejectedValue(
        new Error('bad token'),
      );
      mockOctokit.paginate.mockResolvedValue([]);
      await channel.connect();
      await (
        channel as unknown as { pollOnce: () => Promise<void> }
      ).pollOnce();
      channel.disconnect();
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
      expect(env.text).toBe('please fix this');
      expect(env.senderId).toBe('alice');
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
          makeComment({ user: { login: 'test-bot' }, body: '@test-bot reply' }),
        ]);

      await initWithoutLoop();
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('skips non-mention comments when requireMention is true', async () => {
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([
          makeComment({ body: 'just a regular comment' }),
        ]);

      await initWithoutLoop();
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('does not false-positive on trailing newline', async () => {
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment({ body: 'Please fix.\n' })]);

      await initWithoutLoop();
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);
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
      mockOctokit.paginate.mockResolvedValueOnce([
        makeNotification({
          subject: {
            title: 'v1.0.0',
            url: 'https://api.github.com/repos/owner/repo/releases/1',
            type: 'Release',
          },
        }),
      ]);

      await initWithoutLoop();
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(mockOctokit.rest.activity.markThreadAsRead).toHaveBeenCalledWith({
        thread_id: 100,
      });
    });

    it('deduplicates via recentlyProcessed', async () => {
      const notification = makeNotification();
      const comment = makeComment();

      mockOctokit.paginate
        .mockResolvedValueOnce([notification])
        .mockResolvedValueOnce([comment]);

      await initWithoutLoop();
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(1);

      // Second poll with same comment (mark-read failed scenario)
      mockOctokit.paginate
        .mockResolvedValueOnce([notification])
        .mockResolvedValueOnce([comment]);

      await (
        channel as unknown as { pollOnce: () => Promise<void> }
      ).pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(1); // not 2
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
          user: { login: 'bob' },
        },
      });

      await initWithoutLoop();
      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      const env = channel.inboundEnvelopes[0]!;
      expect(env.text).toBe('implement this feature');
      expect(env.senderId).toBe('bob');
    });

    it('skips old issue body (created before cursor)', async () => {
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification({ last_read_at: null })])
        .mockResolvedValueOnce([]);

      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          body: '@test-bot old issue',
          created_at: '2026-06-01T00:00:00.000Z',
          user: { login: 'bob' },
        },
      });

      await initWithoutLoop();
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('skips issue body without mention', async () => {
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification({ last_read_at: null })])
        .mockResolvedValueOnce([]);

      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          body: 'no mention here',
          created_at: '2026-07-02T08:00:00.000Z',
          user: { login: 'bob' },
        },
      });

      await initWithoutLoop();
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);
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
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await initWithoutLoop();
      await pollOnce();

      expect(mockOctokit.rest.activity.markThreadAsRead).toHaveBeenCalledWith({
        thread_id: 100,
      });
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

    it('logs and returns when threadId is undefined', async () => {
      mockOctokit.paginate.mockResolvedValue([]);
      await channel.connect();
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      await (
        channel as unknown as {
          sendThreadMessage: (
            c: string,
            t: string | undefined,
            text: string,
          ) => Promise<void>;
        }
      ).sendThreadMessage('owner/repo', undefined, 'response');

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('no threadId'),
      );
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      stderrSpy.mockRestore();
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
    it('enforces minimum 60s', () => {
      const ch = new TestableGithubChannel(
        'test',
        makeConfig({ pollInterval: 5000 }),
        makeBridge(),
      );
      expect((ch as unknown as { pollInterval: number }).pollInterval).toBe(
        60000,
      );
    });

    it('respects configured interval above minimum', () => {
      const ch = new TestableGithubChannel(
        'test',
        makeConfig({ pollInterval: 120000 }),
        makeBridge(),
      );
      expect((ch as unknown as { pollInterval: number }).pollInterval).toBe(
        120000,
      );
    });
  });
});
