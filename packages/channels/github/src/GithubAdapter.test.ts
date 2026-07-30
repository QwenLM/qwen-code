import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
      reactions: {
        createForIssueComment: vi.fn(),
        deleteForIssueComment: vi.fn(),
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
    reactions: {
      createForIssueComment: Mock;
      deleteForIssueComment: Mock;
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
    node_id: `C_${id}`,
    body: '@test-bot please fix this',
    user: { id: 10001, login: 'alice' },
    created_at: '2026-07-02T09:00:00.000Z',
    updated_at: '2026-07-02T09:00:00.000Z',
    ...overrides,
  };
}

function makeIssueEvent(overrides: Record<string, unknown> = {}) {
  const id = (overrides.id as number | undefined) ?? 2001;
  return {
    id,
    node_id: `E_${id}`,
    event: 'review_requested',
    created_at: '2026-07-02T09:00:00.000Z',
    actor: { login: 'maintainer' },
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
  sourceMessageId: string | undefined;
  sourceSenderId: string | undefined;
  sourceMetadata: string | undefined;

  protected getResponseMessageId(_sessionId: string): string | undefined {
    return this.sourceMessageId;
  }

  protected getResponseSenderId(_sessionId: string): string | undefined {
    return this.sourceSenderId;
  }

  protected getResponseMetadata(_sessionId: string): string | undefined {
    return this.sourceMetadata;
  }

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

class LiveGithubChannel extends GithubChannel {
  setCursorForTest(lastProcessedAt: string): void {
    this.cursor = { lastProcessedAt };
  }

  async pollForTest(): Promise<void> {
    await this.pollOnce();
  }

  startPromptForTest(
    chatId: string,
    sessionId: string,
    messageId: string,
  ): void {
    this.onPromptStart(chatId, sessionId, messageId);
  }

  endPromptForTest(chatId: string, sessionId: string, messageId: string): void {
    this.onPromptEnd(chatId, sessionId, messageId);
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
    mockOctokit.rest.reactions.createForIssueComment.mockResolvedValue({
      data: { id: 9000 },
    });
    mockOctokit.rest.reactions.deleteForIssueComment.mockResolvedValue({});
  });

  afterEach(() => {
    rmSync(process.env.QWEN_HOME!, { recursive: true, force: true });
    if (savedQwenHome === undefined) delete process.env.QWEN_HOME;
    else process.env.QWEN_HOME = savedQwenHome;
  });

  async function initWithoutLoop(configOverrides?: Record<string, unknown>) {
    if (configOverrides) {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig(configOverrides),
        makeBridge(),
      );
    }
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

    it('rejects an allowlist containing only the authenticated GitHub account', async () => {
      const config = makeConfig({
        senderPolicy: 'allowlist',
        allowedUsers: ['TEST-BOT', 'test-bot'],
      });
      channel = new TestableGithubChannel('test-github', config, makeBridge());
      mockOctokit.paginate.mockResolvedValue([]);

      try {
        await expect(channel.connect()).rejects.toThrow(
          'allowlist only contains the authenticated GitHub account "test-bot"',
        );
      } finally {
        channel.disconnect();
      }
      expect(config.allowedUsers).toEqual(['test-bot', 'test-bot']);
    });

    it('warns when the authenticated GitHub account is part of a mixed allowlist', async () => {
      const config = makeConfig({
        senderPolicy: 'allowlist',
        allowedUsers: ['TEST-BOT', 'operator'],
      });
      channel = new TestableGithubChannel('test-github', config, makeBridge());
      mockOctokit.paginate.mockResolvedValue([]);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      try {
        await channel.connect();
        expect(stderr).toHaveBeenCalledWith(
          '[Channel:test-github] warning: authenticated GitHub account "test-bot" is allowlisted but cannot trigger this channel; use a separate operator account.\n',
        );
      } finally {
        channel.disconnect();
        stderr.mockRestore();
      }
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

    it('forces final-only delivery and appends the publication policy', () => {
      const config = makeConfig({
        blockStreaming: 'on',
        instructions: 'Respond in Chinese.',
      });
      new TestableGithubChannel('test-github', config, makeBridge());

      expect(config.blockStreaming).toBe('off');
      expect(config.instructions).toContain('GitHub publication policy:');
      expect(config.instructions).toContain('<no-reply/>');
      expect(config.instructions).toContain('Respond in Chinese.');
    });
  });

  describe('poll and process', () => {
    it('processes a mention comment', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([
          makeComment({ id: 1000, node_id: 'C_1000', body: 'background' }),
          makeComment(),
        ]);
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

    it('skips non-mention comments for mention notifications', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification({ last_read_at: null })])
        .mockResolvedValueOnce([
          makeComment({ body: 'just a regular comment' }),
        ]);
      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          body: 'plain issue body',
          created_at: '2026-07-02T08:00:00.000Z',
          user: { id: 10002, login: 'bob' },
        },
      });

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('does not false-positive on trailing newline', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({ last_read_at: '2026-07-01T12:00:00.000Z' }),
        ])
        .mockResolvedValueOnce([makeComment({ body: 'Please fix.\n' })]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);
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

  describe('reason routing', () => {
    it('dispatches review_requested from PR metadata', async () => {
      await initWithoutLoop({
        senderPolicy: 'allowlist',
        allowedUsers: ['maintainer', 'bob'],
      });
      channel.usePreflight = true;
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'review_requested',
            updated_at: '2026-07-04T10:00:00.000Z',
            last_read_at: '2026-07-01T12:00:00.000Z',
            subject: {
              title: 'notification title',
              url: 'https://api.github.com/repos/owner/repo/pulls/99',
              type: 'PullRequest',
            },
          }),
        ])
        .mockResolvedValueOnce([
          makeIssueEvent({ created_at: '2026-07-04T09:00:00.000Z' }),
        ])
        .mockResolvedValueOnce([
          makeComment({
            id: 1002,
            node_id: 'C_1002',
            body: '@test-bot check this review note',
            created_at: '2026-07-04T09:30:00.000Z',
            user: { login: 'bob' },
          }),
        ]);
      mockOctokit.rest.pulls.get.mockResolvedValue({
        data: {
          title: 'feat: divide',
          state: 'open',
          draft: false,
          user: { login: 'alice' },
          head: { ref: 'divide' },
          base: { ref: 'main' },
        },
      });
      channel.cursor.lastProcessedAt = '2026-07-03T00:00:00.000Z';

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(2);
      expect(channel.inboundEnvelopes[0]).toMatchObject({
        senderId: 'maintainer',
        threadId: 'pr:99',
        isMentioned: true,
      });
      expect(channel.inboundEnvelopes[1]).toMatchObject({
        senderId: 'bob',
        threadId: 'pr:99',
        text: ' check this review note',
        isMentioned: true,
      });
      expect(channel.inboundEnvelopes[0]!.metadata).toContain(
        'Branch: divide → main',
      );
      expect(channel.inboundEnvelopes[0]!.metadata).toContain(
        'Title: feat: divide',
      );
      expect(channel.inboundEnvelopes[0]!.metadata).toContain(
        'Author: alice | State: open | Draft: false',
      );
      expect(channel.inboundEnvelopes[0]!.text).toBe(
        'Return a formal review summary with verified actionable findings, or a concise no-blocker result.',
      );
      expect(channel.inboundEnvelopes[0]!.metadata).toContain(
        'For review_requested, return a formal review summary',
      );
    });

    it('dispatches late direct events once without muting newer events', async () => {
      await initWithoutLoop();
      channel.cursor = {
        lastProcessedAt: '2026-07-03T00:00:00.000Z',
        metaFloor: '2026-07-01T00:00:00.000Z',
      };
      const first = makeIssueEvent({
        created_at: '2026-07-02T09:00:00.000Z',
      });
      const second = makeIssueEvent({
        id: 2002,
        created_at: '2026-07-05T09:00:00.000Z',
      });
      const reviewNotification = (updated_at: string) =>
        makeNotification({
          reason: 'review_requested',
          updated_at,
          last_read_at: '2026-07-03T12:00:00.000Z',
          subject: {
            title: 'Review me',
            url: 'https://api.github.com/repos/owner/repo/pulls/99',
            type: 'PullRequest',
          },
        });
      mockOctokit.paginate
        .mockResolvedValueOnce([reviewNotification('2026-07-04T10:00:00.000Z')])
        .mockResolvedValueOnce([first])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([reviewNotification('2026-07-05T10:00:00.000Z')])
        .mockResolvedValueOnce([first])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([reviewNotification('2026-07-06T10:00:00.000Z')])
        .mockResolvedValueOnce([first, second])
        .mockResolvedValueOnce([]);
      mockOctokit.rest.pulls.get.mockResolvedValue({
        data: {
          title: 'Review me',
          state: 'open',
          draft: false,
          user: { login: 'alice' },
          head: { ref: 'feature' },
          base: { ref: 'main' },
        },
      });

      await pollOnce();
      await pollOnce();
      await pollOnce();

      expect(
        channel.inboundEnvelopes.map((envelope) => envelope.messageId),
      ).toEqual(['event-2001', 'event-2002']);
      expect(channel.cursor.dispatchedEvents).toEqual(['E_2001', 'E_2002']);
    });

    it('ignores direct trigger when a later removal arrives unordered', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'review_requested',
            updated_at: '2026-07-04T10:00:00.000Z',
            last_read_at: '2026-07-01T12:00:00.000Z',
            subject: {
              title: 'notification title',
              url: 'https://api.github.com/repos/owner/repo/pulls/99',
              type: 'PullRequest',
            },
          }),
        ])
        .mockResolvedValueOnce([
          makeIssueEvent({
            id: 2002,
            event: 'review_request_removed',
            created_at: '2026-07-02T09:30:00.000Z',
          }),
          makeIssueEvent({
            id: 2001,
            event: 'review_requested',
            created_at: '2026-07-02T09:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(mockOctokit.rest.pulls.get).not.toHaveBeenCalled();
    });

    it('dispatches assign from issue metadata', async () => {
      await initWithoutLoop();
      channel.usePreflight = true;
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'assign',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([
          makeIssueEvent({
            event: 'assigned',
            assigner: { login: 'maintainer' },
            assignee: { login: 'test-bot' },
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({
            id: 1002,
            node_id: 'C_1002',
            body: '@test-bot use the attached repro',
            user: { login: 'bob' },
          }),
        ]);
      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          title: 'broken build',
          state: 'open',
          user: { login: 'alice' },
        },
      });

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(2);
      expect(channel.inboundEnvelopes[0]).toMatchObject({
        senderId: 'maintainer',
        isMentioned: true,
        text: 'Triage this issue and respond with the next action.',
      });
      expect(channel.inboundEnvelopes[1]).toMatchObject({
        senderId: 'bob',
        text: ' use the attached repro',
        isMentioned: true,
      });
      expect(channel.cursor.dispatchedComments).toEqual(['C_1002']);
      expect(channel.inboundEnvelopes[0]!.metadata).toContain(
        'Title: broken build',
      );
      expect(channel.inboundEnvelopes[0]!.metadata).toContain(
        'Author: alice | State: open',
      );
    });

    it.each(['author', 'comment'])(
      'aggregates new comments for %s notifications',
      async (reason) => {
        await initWithoutLoop();
        channel.usePreflight = true;
        mockOctokit.paginate
          .mockResolvedValueOnce([
            makeNotification({
              reason,
              last_read_at: '2026-07-01T12:00:00.000Z',
            }),
          ])
          .mockResolvedValueOnce([
            makeComment({ body: 'first' }),
            makeComment({
              id: 1002,
              node_id: 'C_1002',
              body: 'second',
              user: { login: 'bob' },
            }),
          ]);

        await pollOnce();

        expect(channel.inboundEnvelopes).toHaveLength(1);
        expect(channel.inboundEnvelopes[0]).toMatchObject({
          isMentioned: true,
        });
        expect(channel.inboundEnvelopes[0]!.text).toContain(
          'output exactly <no-reply/> if no public reply is needed',
        );
        expect(channel.inboundEnvelopes[0]!.text).toContain('@alice: first');
        expect(channel.inboundEnvelopes[0]!.text).toContain('@bob: second');
      },
    );

    it('skips notifications whose reason is not in reasonFilter', async () => {
      await initWithoutLoop({
        reasonFilter: ['mention', 'review_requested', 'assign'],
      });
      mockOctokit.paginate.mockClear();
      mockOctokit.paginate.mockResolvedValueOnce([
        makeNotification({
          reason: 'author',
          last_read_at: '2026-07-01T12:00:00.000Z',
        }),
      ]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(mockOctokit.paginate).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.issues.listComments).not.toHaveBeenCalled();
      expect(channel.cursor.lastProcessedAt).toBe('2026-07-02T10:00:00.000Z');
    });

    it('normalizes configured reasonFilter entries before matching', async () => {
      await initWithoutLoop({
        reasonFilter: [' COMMENT ', ''],
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([makeComment({ body: 'allowed comment' })]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.text).toContain('allowed comment');
    });

    it('excludes comments from disallowed senders when aggregating', async () => {
      await initWithoutLoop({
        senderPolicy: 'allowlist',
        allowedUsers: ['alice'],
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({ body: 'allowed' }),
          makeComment({
            id: 1002,
            body: 'not allowed',
            user: { login: 'bob' },
          }),
        ]);

      await pollOnce();

      expect(channel.inboundEnvelopes[0]!.text).toContain('@alice: allowed');
      expect(channel.inboundEnvelopes[0]!.text).not.toContain('not allowed');
    });

    it('dispatches directed follow-ups from approved pairing users without a mention', async () => {
      await initWithoutLoop({
        senderPolicy: 'pairing',
        allowedUsers: ['alice'],
      });
      channel.usePreflight = true;
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({ body: 'please take a look' }),
          makeComment({
            id: 1002,
            body: 'unapproved follow-up',
            user: { login: 'bob' },
          }),
        ]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.text).toBe('please take a look');
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('bounds each aggregated comment without hiding later comments', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({ body: 'a'.repeat(500) }),
          makeComment({ id: 1002, body: 'latest' }),
        ]);

      await pollOnce();

      expect(channel.inboundEnvelopes[0]!.text).not.toContain('a'.repeat(401));
      expect(channel.inboundEnvelopes[0]!.text).toContain('latest');
    });

    it('records aggregated comments that exceed the summary cap', async () => {
      await initWithoutLoop();
      const comments = Array.from({ length: 25 }, (_, index) =>
        makeComment({
          id: 1001 + index,
          node_id: `C_${1001 + index}`,
          body: `comment ${index + 1}`,
        }),
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce(comments);

      await pollOnce();

      expect(channel.cursor.dispatchedComments).toHaveLength(25);
      expect(channel.cursor.dispatchedComments).toContain('C_1001');
      expect(channel.cursor.dispatchedComments).toContain('C_1025');
      expect(channel.inboundEnvelopes[0]!.text).not.toContain(
        '- @alice: comment 1\n',
      );
      expect(channel.inboundEnvelopes[0]!.text).toContain('comment 25');
    });

    it('records aggregated comments before dispatching them', async () => {
      vi.spyOn(channel, 'handleInbound').mockRejectedValueOnce(
        new Error('agent down'),
      );
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({ id: 1001, node_id: 'C_1001', body: 'first' }),
          makeComment({ id: 1002, node_id: 'C_1002', body: 'second' }),
        ]);

      await pollOnce();

      expect(channel.cursor.dispatchedComments).toEqual(['C_1001', 'C_1002']);
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Failed to process'),
        }),
      );
    });

    it('uses the generic fallback for other reasons', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'subscribed',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([makeComment({ body: 'please inspect' })]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]).toMatchObject({
        text: 'please inspect',
        isMentioned: false,
      });
      expect(channel.inboundEnvelopes[0]!.metadata).toContain(
        'Trigger: subscribed.',
      );
      expect(channel.inboundEnvelopes[0]!.metadata).toContain(
        'GitHub publication policy:',
      );
    });

    it('deduplicates replayed comments by node ID', async () => {
      await initWithoutLoop();
      const notification = makeNotification({
        reason: 'subscribed',
        last_read_at: '2026-07-01T12:00:00.000Z',
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([notification])
        .mockResolvedValueOnce([makeComment()])
        .mockResolvedValueOnce([notification])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();
      channel.cursor.lastProcessedAt = '2026-07-01T00:00:00.000Z';
      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.cursor.dispatchedComments).toEqual(['C_1001']);
    });
  });

  describe('reasonFilter', () => {
    function connectWithReasonFilter(reasonFilter: unknown): Promise<void> {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ reasonFilter }),
        makeBridge(),
      );
      return channel.connect();
    }

    it('skips notifications whose reason is not in the allowlist', async () => {
      const stderrWrite = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      await initWithoutLoop({
        reasonFilter: ['mention'],
      });
      try {
        mockOctokit.paginate
          .mockResolvedValueOnce([
            makeNotification({
              reason: 'comment',
              last_read_at: '2026-07-01T12:00:00.000Z',
            }),
            makeNotification({
              reason: 'mention',
              last_read_at: '2026-07-01T12:00:00.000Z',
            }),
          ])
          .mockResolvedValueOnce([makeComment({ body: 'hello @test-bot' })]);

        await pollOnce();

        expect(channel.inboundEnvelopes).toHaveLength(1);
        expect(channel.inboundEnvelopes[0]!.metadata).toContain(
          'Trigger: mention.',
        );
        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).toHaveBeenCalledWith({
          last_read_at: '2026-07-02T10:00:00.000Z',
          read: true,
        });
        expect(stderrWrite).toHaveBeenCalledWith(
          expect.stringContaining(
            'skipping notification (reason=comment not in reasonFilter, subject=https://api.github.com/repos/owner/repo/issues/42)',
          ),
        );
      } finally {
        stderrWrite.mockRestore();
      }
    });

    it('rejects unrecognized reasonFilter values', async () => {
      await expect(connectWithReasonFilter(['mentions'])).rejects.toThrow(
        'Unrecognized reasonFilter values for channel test-github: mentions',
      );
    });

    it('rejects non-array reasonFilter values', async () => {
      await expect(connectWithReasonFilter('mention')).rejects.toThrow(
        'reasonFilter for channel test-github must be an array of GitHub notification reasons.',
      );
    });

    it('rejects non-string reasonFilter entries', async () => {
      await expect(connectWithReasonFilter([42])).rejects.toThrow(
        'reasonFilter entries for channel test-github must be strings.',
      );
    });

    it('accepts documented security notification reasons', async () => {
      await expect(
        connectWithReasonFilter(['security_alert']),
      ).resolves.toBeUndefined();
      channel.disconnect();
    });

    it('processes all reasons when filter is empty or unset', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'subscribed',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([makeComment({ body: 'plain comment' })]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
    });

    it('processes all reasons when filter is an empty array', async () => {
      await initWithoutLoop({ reasonFilter: [] });
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'subscribed',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([makeComment({ body: 'plain comment' })]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
    });
  });

  describe('publication contract', () => {
    async function connectForPublication() {
      mockOctokit.paginate.mockResolvedValue([]);
      await channel.connect();
      channel.disconnect();
    }

    it('suppresses the exact no-reply sentinel and audits the outcome', async () => {
      await connectForPublication();
      const publish = (
        channel as unknown as {
          publishFinalResponse: (
            chatId: string,
            threadId: string,
            text: string,
            sessionId: string,
          ) => Promise<void>;
        }
      ).publishFinalResponse.bind(channel);

      await publish(
        'owner/repo',
        'issue:42',
        ' \n<no-reply/>\t',
        'session-publication',
      );

      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      const audit = readFileSync(
        join(
          process.env.QWEN_HOME!,
          'channels',
          'test-github-github-audit.jsonl',
        ),
        'utf-8',
      );
      expect(audit).toContain('"outcome":"suppressed"');
      expect(audit).not.toContain('<no-reply/>');
    });

    it.each(['<NO-REPLY/>', '<no-reply />', '```text\n<no-reply/>\n```'])(
      'suppresses no-reply sentinel variant %s',
      async (response) => {
        await connectForPublication();
        const publish = (
          channel as unknown as {
            publishFinalResponse: (
              chatId: string,
              threadId: string,
              text: string,
              sessionId: string,
            ) => Promise<void>;
          }
        ).publishFinalResponse.bind(channel);

        await publish(
          'owner/repo',
          'issue:42',
          response,
          'session-publication',
        );

        expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      },
    );

    it('posts one final comment and audits only its digest and metadata', async () => {
      mockOctokit.rest.issues.createComment.mockResolvedValue({
        data: {
          id: 2001,
          html_url: 'https://github.com/owner/repo/issues/42#issuecomment-2001',
        },
      });
      await connectForPublication();
      const response = 'Use <no-reply/> to suppress replies 🙂';
      const publish = (
        channel as unknown as {
          publishFinalResponse: (
            chatId: string,
            threadId: string,
            text: string,
            sessionId: string,
          ) => Promise<void>;
        }
      ).publishFinalResponse.bind(channel);

      await publish('owner/repo', 'issue:42', response, 'session-publication');

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 42,
        body: response,
      });
      const audit = readFileSync(
        join(
          process.env.QWEN_HOME!,
          'channels',
          'test-github-github-audit.jsonl',
        ),
        'utf-8',
      );
      expect(audit).toContain('"outcome":"posted"');
      expect(audit).toContain('issuecomment-2001');
      expect(audit).toContain(
        createHash('sha256').update(response).digest('hex'),
      );
      expect(audit).not.toContain(response);
      expect(JSON.parse(audit)).toMatchObject({
        outcome: 'posted',
        repository: 'owner/repo',
        number: 42,
        bodyChars: Array.from(response).length,
      });
    });

    it('uses the active prompt thread for final delivery', async () => {
      await connectForPublication();
      mockOctokit.rest.issues.createComment.mockResolvedValue({ data: {} });
      const sendResponse = (
        channel as unknown as {
          sendResponseMessage: (
            chatId: string,
            text: string,
            sessionId: string,
          ) => Promise<void>;
        }
      ).sendResponseMessage.bind(channel);
      vi.spyOn(
        channel as unknown as {
          getResponseThreadId: (sessionId: string) => string | undefined;
        },
        'getResponseThreadId',
      ).mockReturnValue('pr:99');

      await sendResponse('owner/repo', 'Final public reply', 'shared-session');

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 99,
        body: 'Final public reply',
      });
    });

    it('does not retry an ambiguous failed final delivery', async () => {
      await connectForPublication();
      const error = new Error('ambiguous transport failure');
      mockOctokit.rest.issues.createComment.mockRejectedValue(error);
      const publish = (
        channel as unknown as {
          publishFinalResponse: (
            chatId: string,
            threadId: string,
            text: string,
            sessionId: string,
          ) => Promise<void>;
        }
      ).publishFinalResponse.bind(channel);

      await expect(
        publish('owner/repo', 'issue:42', 'Final reply', 'session-publication'),
      ).rejects.toMatchObject({
        message: 'ambiguous transport failure',
        cause: error,
      });
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      const audit = readFileSync(
        join(
          process.env.QWEN_HOME!,
          'channels',
          'test-github-github-audit.jsonl',
        ),
        'utf-8',
      );
      expect(JSON.parse(audit)).toMatchObject({
        outcome: 'failed',
        failurePhase: 'delivery',
        failureError: 'ambiguous transport failure',
      });
    });

    it.each([
      Object.assign(new Error('rate limited'), { status: 429 }),
      Object.assign(new Error('rate limited'), {
        status: 403,
        response: { headers: { 'x-ratelimit-remaining': '0' } },
      }),
    ])(
      'retries final delivery when GitHub definitely did not write',
      async (error) => {
        await connectForPublication();
        const sleep = vi.fn().mockResolvedValue(undefined);
        (
          channel as unknown as {
            abortableSleep: (ms: number) => Promise<void>;
          }
        ).abortableSleep = sleep;
        mockOctokit.rest.issues.createComment
          .mockRejectedValueOnce(error)
          .mockResolvedValueOnce({ data: {} });
        const publish = (
          channel as unknown as {
            publishFinalResponse: (
              chatId: string,
              threadId: string,
              text: string,
              sessionId: string,
            ) => Promise<void>;
          }
        ).publishFinalResponse.bind(channel);

        await publish(
          'owner/repo',
          'issue:42',
          'Final reply',
          'session-publication',
        );

        expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalled();
      },
    );

    it('distinguishes pre-delivery validation from ambiguous failures', async () => {
      await connectForPublication();
      mockOctokit.rest.issues.createComment.mockRejectedValue(
        new Error('ambiguous transport failure'),
      );
      const publish = (
        channel as unknown as {
          publishFinalResponse: (
            chatId: string,
            threadId: string | undefined,
            text: string,
            sessionId: string,
          ) => Promise<void>;
        }
      ).publishFinalResponse.bind(channel);
      vi.spyOn(channel, 'handleInbound').mockImplementation(async () => {
        await publish(
          'owner/repo',
          'issue:42',
          'Final reply',
          'session-publication',
        );
      });

      const handled = await (
        channel as unknown as {
          dispatchEnvelope: (
            envelope: Envelope,
            issueNumber: number,
          ) => Promise<boolean>;
        }
      ).dispatchEnvelope(
        {
          channelName: 'test-github',
          senderId: 'alice',
          senderName: 'alice',
          chatId: 'owner/repo',
          threadId: 'issue:42',
          messageId: '1001',
          text: '@test-bot help',
          isGroup: true,
          isMentioned: true,
          isReplyToBot: false,
        },
        42,
      );

      expect(handled).toBe(false);
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      let validationError: unknown;
      try {
        await publish(
          'owner/repo',
          undefined,
          'Final reply',
          'session-publication',
        );
      } catch (error) {
        validationError = error;
      }
      expect(validationError).toBeInstanceOf(Error);
      expect((validationError as Error).constructor).toBe(Error);
    });

    it('records the active source message and response thread', async () => {
      await connectForPublication();
      const publish = (
        channel as unknown as {
          publishFinalResponse: (
            chatId: string,
            threadId: string,
            text: string,
            sessionId: string,
          ) => Promise<void>;
        }
      ).publishFinalResponse.bind(channel);
      channel.sourceMessageId = 'source-message';
      channel.sourceSenderId = 'maintainer';
      channel.sourceMetadata = 'Type: Pull Request\nTrigger: review_requested.';

      await publish('owner/repo', 'pr:99', '<no-reply/>', 'session-correlated');

      const audit = readFileSync(
        join(
          process.env.QWEN_HOME!,
          'channels',
          'test-github-github-audit.jsonl',
        ),
        'utf-8',
      );
      expect(audit).toContain('"sourceMessageId":"source-message"');
      expect(audit).toContain('"threadId":"pr:99"');
      expect(JSON.parse(audit)).toMatchObject({
        triggerKind: 'review_requested',
        actor: 'maintainer',
        repository: 'owner/repo',
        number: 99,
      });
    });

    it('keeps successful publication when its audit write fails', async () => {
      await connectForPublication();
      const publish = (
        channel as unknown as {
          publishFinalResponse: (
            chatId: string,
            threadId: string,
            text: string,
            sessionId: string,
          ) => Promise<void>;
        }
      ).publishFinalResponse.bind(channel);
      mockOctokit.rest.issues.createComment.mockResolvedValue({ data: {} });
      mkdirSync(
        join(
          process.env.QWEN_HOME!,
          'channels',
          'test-github-github-audit.jsonl',
        ),
        { recursive: true },
      );

      await expect(
        publish('owner/repo', 'issue:42', 'Final reply', 'session-publication'),
      ).resolves.toBeUndefined();
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
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
    it.each(['subscribed', 'mention'])(
      'feeds a mentioned issue body for %s notifications',
      async (reason) => {
        await initWithoutLoop();
        mockOctokit.paginate
          .mockResolvedValueOnce([
            makeNotification({ last_read_at: null, reason }),
          ])
          .mockResolvedValueOnce([]);
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
      },
    );

    it('dispatches a generic issue body without a synthetic mention', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({ last_read_at: null, reason: 'subscribed' }),
        ])
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
        reason: 'subscribed',
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
        .mockResolvedValueOnce([
          makeNotification({ last_read_at: null, reason: 'subscribed' }),
        ])
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
        .mockResolvedValueOnce([
          makeNotification({ last_read_at: null, reason: 'subscribed' }),
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          makeNotification({ last_read_at: null, reason: 'subscribed' }),
        ])
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
            reason: 'subscribed',
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
        .mockResolvedValueOnce([
          makeNotification({ last_read_at: null, reason: 'subscribed' }),
        ])
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
        .mockResolvedValueOnce([
          makeNotification({ last_read_at: null, reason: 'subscribed' }),
        ])
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

    it('does not suppress first-contact body after a non-mention comment', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({ last_read_at: null, reason: 'subscribed' }),
        ])
        .mockResolvedValueOnce([makeComment({ body: 'follow up' })]);
      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          body: '@test-bot implement this',
          created_at: '2026-07-02T08:00:00.000Z',
          user: { id: 10002, login: 'bob' },
        },
      });

      await pollOnce();

      expect(channel.inboundEnvelopes.map((env) => env.messageId)).toEqual([
        '1001',
        'issue-body-42',
      ]);
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

    it('posts only one error comment when dispatch fails on a new thread', async () => {
      channel.handleInboundError = new Error('agent down');
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({ last_read_at: null, reason: 'subscribed' }),
        ])
        .mockResolvedValueOnce([makeComment({ body: 'follow up' })]);
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

    it('continues processing comments after one dispatch failure', async () => {
      await initWithoutLoop();
      const originalHandleInbound = channel.handleInbound.bind(channel);
      vi.spyOn(channel, 'handleInbound').mockImplementation(
        async (envelope) => {
          if (envelope.messageId === '1002') throw new Error('agent down');
          await originalHandleInbound(envelope);
        },
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'subscribed',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({ id: 1001, node_id: 'C_1001', body: 'first' }),
          makeComment({ id: 1002, node_id: 'C_1002', body: 'second' }),
          makeComment({ id: 1003, node_id: 'C_1003', body: 'third' }),
        ]);

      await pollOnce();

      expect(channel.inboundEnvelopes.map((env) => env.messageId)).toEqual([
        '1001',
        '1003',
      ]);
      expect(channel.cursor.dispatchedComments).toEqual(['C_1001', 'C_1003']);
    });
  });

  describe('working reaction', () => {
    it('acknowledges an accepted comment with an eyes reaction', async () => {
      const liveChannel = new LiveGithubChannel(
        'test-github',
        makeConfig(),
        makeBridge(),
      );
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await liveChannel.connect();
      liveChannel.disconnect();
      liveChannel.setCursorForTest('2026-07-01T00:00:00.000Z');
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await liveChannel.pollForTest();

      expect(
        mockOctokit.rest.reactions.createForIssueComment,
      ).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        comment_id: 1001,
        content: 'eyes',
      });
    });

    it('does not wait for the acknowledgment before replying', async () => {
      const { promise: reactionPending, resolve: resolveReaction } =
        Promise.withResolvers<{ data: { id: number } }>();
      mockOctokit.rest.reactions.createForIssueComment.mockReturnValue(
        reactionPending,
      );
      const liveChannel = new LiveGithubChannel(
        'test-github',
        makeConfig(),
        makeBridge(),
      );
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await liveChannel.connect();
      liveChannel.disconnect();
      liveChannel.setCursorForTest('2026-07-01T00:00:00.000Z');
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await liveChannel.pollForTest();

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'response' }),
      );
      resolveReaction({ data: { id: 9000 } });
      await reactionPending;
    });

    it('does not create a duplicate reaction while one is pending', async () => {
      const { promise: reactionPending, resolve: resolveReaction } =
        Promise.withResolvers<{ data: { id: number } }>();
      mockOctokit.rest.reactions.createForIssueComment.mockReturnValue(
        reactionPending,
      );
      const liveChannel = new LiveGithubChannel(
        'test-github',
        makeConfig(),
        makeBridge(),
      );
      await liveChannel.connect();
      liveChannel.disconnect();

      liveChannel.startPromptForTest('owner/repo', 'session-1', '1001');
      liveChannel.startPromptForTest('owner/repo', 'session-2', '1001');

      expect(
        mockOctokit.rest.reactions.createForIssueComment,
      ).toHaveBeenCalledTimes(1);
      resolveReaction({ data: { id: 9000 } });
      await reactionPending;
    });

    it('removes the working reaction when the prompt finishes', async () => {
      const { promise: reactionPending, resolve: resolveReaction } =
        Promise.withResolvers<{ data: { id: number } }>();
      mockOctokit.rest.reactions.createForIssueComment.mockReturnValue(
        reactionPending,
      );
      const liveChannel = new LiveGithubChannel(
        'test-github',
        makeConfig(),
        makeBridge(),
      );
      await liveChannel.connect();
      liveChannel.disconnect();

      liveChannel.startPromptForTest('owner/repo', 'session-1', '1001');
      liveChannel.endPromptForTest('owner/repo', 'session-1', '1001');
      expect(
        mockOctokit.rest.reactions.deleteForIssueComment,
      ).not.toHaveBeenCalled();

      resolveReaction({ data: { id: 9001 } });
      await reactionPending;
      await Promise.resolve();

      expect(
        mockOctokit.rest.reactions.deleteForIssueComment,
      ).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        comment_id: 1001,
        reaction_id: 9001,
      });
    });

    it('handles direct working reaction removal failures', async () => {
      mockOctokit.rest.reactions.deleteForIssueComment.mockRejectedValue(
        new Error('403'),
      );
      const liveChannel = new LiveGithubChannel(
        'test-github',
        makeConfig(),
        makeBridge(),
      );
      await liveChannel.connect();
      liveChannel.disconnect();
      liveChannel.startPromptForTest('owner/repo', 'session-1', '1001');
      await Promise.resolve();
      await Promise.resolve();
      liveChannel.endPromptForTest('owner/repo', 'session-1', '1001');

      await vi.waitFor(() =>
        expect(
          mockOctokit.rest.reactions.deleteForIssueComment,
        ).toHaveBeenCalledTimes(3),
      );
      expect(
        mockOctokit.rest.reactions.deleteForIssueComment,
      ).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        comment_id: 1001,
        reaction_id: 9000,
      });
    });

    it('retries acknowledgement after a create failure', async () => {
      const error = new Error('403');
      mockOctokit.rest.reactions.createForIssueComment
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValue({ data: { id: 9002 } });
      const liveChannel = new LiveGithubChannel(
        'test-github',
        makeConfig(),
        makeBridge(),
      );
      await liveChannel.connect();
      liveChannel.disconnect();
      liveChannel.startPromptForTest('owner/repo', 'session-1', '1001');
      await vi.waitFor(() =>
        expect(
          mockOctokit.rest.reactions.createForIssueComment,
        ).toHaveBeenCalledTimes(3),
      );
      await Promise.resolve();
      await Promise.resolve();

      liveChannel.startPromptForTest('owner/repo', 'session-2', '1001');
      await vi.waitFor(() =>
        expect(
          mockOctokit.rest.reactions.createForIssueComment,
        ).toHaveBeenCalledTimes(4),
      );
    });

    it('does not react to a synthetic direct review-request trigger', async () => {
      const liveChannel = new LiveGithubChannel(
        'test-github',
        makeConfig(),
        makeBridge(),
      );
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await liveChannel.connect();
      liveChannel.disconnect();
      liveChannel.setCursorForTest('2026-07-01T00:00:00.000Z');
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'review_requested',
            subject: {
              title: 'Review me',
              url: 'https://api.github.com/repos/owner/repo/pulls/42',
              type: 'PullRequest',
            },
          }),
        ])
        .mockResolvedValueOnce([makeIssueEvent()])
        .mockResolvedValueOnce([]);
      mockOctokit.rest.pulls.get.mockResolvedValue({
        data: { title: 'Review me', user: { login: 'alice' } },
      });

      await liveChannel.pollForTest();

      expect(
        mockOctokit.rest.reactions.createForIssueComment,
      ).not.toHaveBeenCalled();
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
      ).rejects.toThrow('createIssueComment requires a threadId');
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
    ] as const)('normalizes non-array %s values', (field) => {
      for (const bad of [false, 0, '', null]) {
        const result = validate({
          lastProcessedAt: '2026-07-01T00:00:00.000Z',
          [field]: bad,
        });
        expect(result?.[field]).toEqual([]);
      }
    });

    it.each([
      'dispatchedBodies',
      'dispatchedComments',
      'dispatchedEvents',
    ] as const)('accepts a valid %s array', (field) => {
      const result = validate({
        lastProcessedAt: '2026-07-01T00:00:00.000Z',
        [field]: ['key'],
      });
      expect(result?.[field]).toEqual(['key']);
    });

    it('accepts missing dispatched lists', () => {
      const result = validate({
        lastProcessedAt: '2026-07-01T00:00:00.000Z',
      });
      expect(result).not.toBeNull();
      expect(result!.dispatchedBodies).toBeUndefined();
      expect(result!.dispatchedComments).toBeUndefined();
      expect(result!.dispatchedEvents).toBeUndefined();
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
