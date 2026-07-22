import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GithubChannel } from './GithubAdapter.js';
import { savePollCursor, loadPollCursor } from '@qwen-code/channel-base';
import type {
  ChannelAgentBridge,
  ChannelConfig,
} from '@qwen-code/channel-base';

const baseConfig: ChannelConfig = {
  type: 'github',
  token: 'test-token',
  senderPolicy: 'open',
  allowedUsers: [],
  sessionScope: 'user',
  cwd: '/tmp',
  groupPolicy: 'open',
  dmPolicy: 'open',
  groups: {},
};

function mockBridge(): ChannelAgentBridge {
  return {
    availableCommands: [],
    prompt: vi.fn().mockResolvedValue(''),
    newSession: vi.fn().mockResolvedValue('session-1'),
    loadSession: vi.fn().mockResolvedValue('session-1'),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as ChannelAgentBridge;
}

const {
  mockListNotifications,
  mockCreateComment,
  mockCreateIssue,
  mockGetComment,
  mockGetIssue,
  mockGetPullRequest,
  mockGetReviewComment,
  mockMarkThreadAsRead,
  mockGetAuthenticatedUser,
} = vi.hoisted(() => ({
  mockListNotifications: vi.fn(),
  mockCreateComment: vi.fn(),
  mockCreateIssue: vi.fn(),
  mockGetComment: vi.fn(),
  mockGetIssue: vi.fn(),
  mockGetPullRequest: vi.fn(),
  mockGetReviewComment: vi.fn(),
  mockMarkThreadAsRead: vi.fn(),
  mockGetAuthenticatedUser: vi.fn(),
}));

const mockPaginate = vi.fn();

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    rest: {
      activity: {
        listNotificationsForAuthenticatedUser: mockListNotifications,
        markThreadAsRead: mockMarkThreadAsRead,
      },
      issues: {
        createComment: mockCreateComment,
        create: mockCreateIssue,
        get: mockGetIssue,
        getComment: mockGetComment,
      },
      pulls: {
        get: mockGetPullRequest,
        getReviewComment: mockGetReviewComment,
      },
      users: {
        getAuthenticated: mockGetAuthenticatedUser,
      },
    },
    paginate: mockPaginate,
  })),
}));

describe('GithubChannel', () => {
  let tempDir: string;
  let originalQwenHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'github-adapter-test-'));
    originalQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = tempDir;
    mockListNotifications.mockClear();
    mockCreateComment.mockClear();
    mockCreateIssue.mockClear();
    mockGetComment.mockClear();
    mockGetIssue.mockClear();
    mockGetPullRequest.mockClear();
    mockGetReviewComment.mockClear();
    mockMarkThreadAsRead.mockClear();
    mockPaginate.mockClear();
    mockGetAuthenticatedUser.mockClear();
    mockGetAuthenticatedUser.mockResolvedValue({ data: { login: 'bot' } });
    savePollCursor('test', '2025-01-01T00:00:00Z');
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
  });

  it('polls notifications on connect', async () => {
    mockPaginate.mockResolvedValueOnce([]);

    const channel = new GithubChannel('test', baseConfig, mockBridge());
    await channel.connect();
    channel.disconnect();

    expect(mockPaginate).toHaveBeenCalled();
  });

  it('resolves sender from latest_comment_url', async () => {
    const bridge = mockBridge();
    const promptFn = vi.fn().mockResolvedValue(undefined);
    (bridge as Record<string, unknown>).prompt = promptFn;

    mockPaginate.mockResolvedValueOnce([
      {
        id: '1',
        reason: 'mention',
        unread: true,
        subject: {
          title: 'Bug report',
          url: 'https://api.github.com/repos/owner/repo/issues/42',
          latest_comment_url:
            'https://api.github.com/repos/owner/repo/issues/comments/999',
          type: 'Issue',
        },
        repository: {
          full_name: 'owner/repo',
          html_url: 'https://github.com/owner/repo',
        },
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]);
    mockGetComment.mockResolvedValueOnce({
      data: { user: { login: 'commenter' }, body: 'Please fix this @bot' },
    });
    mockMarkThreadAsRead.mockResolvedValueOnce({});

    const channel = new GithubChannel('test', baseConfig, bridge);
    await channel.connect();
    await vi.waitFor(() => expect(mockMarkThreadAsRead).toHaveBeenCalled(), {
      timeout: 2000,
    });
    channel.disconnect();

    expect(mockGetComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 999,
    });
    expect(mockMarkThreadAsRead).toHaveBeenCalledWith({ thread_id: 1 });
    expect(promptFn).toHaveBeenCalled();
  });

  it('falls back to issue creator when latest_comment_url is null', async () => {
    const bridge = mockBridge();
    const promptFn = vi.fn().mockResolvedValue(undefined);
    (bridge as Record<string, unknown>).prompt = promptFn;

    mockPaginate.mockResolvedValueOnce([
      {
        id: '2',
        reason: 'mention',
        unread: true,
        subject: {
          title: 'Bug report',
          url: 'https://api.github.com/repos/owner/repo/issues/42',
          latest_comment_url: null,
          type: 'Issue',
        },
        repository: {
          full_name: 'owner/repo',
          html_url: 'https://github.com/owner/repo',
        },
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]);
    mockGetIssue.mockResolvedValueOnce({
      data: { user: { login: 'creator' }, body: 'Bug description here' },
    });
    mockMarkThreadAsRead.mockResolvedValueOnce({});

    const channel = new GithubChannel('test', baseConfig, bridge);
    await channel.connect();
    await vi.waitFor(() => expect(promptFn).toHaveBeenCalled(), {
      timeout: 2000,
    });
    channel.disconnect();

    expect(mockGetComment).not.toHaveBeenCalled();
    expect(mockGetIssue).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 42,
    });
    expect(promptFn).toHaveBeenCalled();
  });

  it('falls back to issue creator when getComment fails', async () => {
    const bridge = mockBridge();
    const promptFn = vi.fn().mockResolvedValue(undefined);
    (bridge as Record<string, unknown>).prompt = promptFn;

    mockPaginate.mockResolvedValueOnce([
      {
        id: '3',
        reason: 'mention',
        unread: true,
        subject: {
          title: 'Bug report',
          url: 'https://api.github.com/repos/owner/repo/issues/42',
          latest_comment_url:
            'https://api.github.com/repos/owner/repo/issues/comments/123',
          type: 'Issue',
        },
        repository: {
          full_name: 'owner/repo',
          html_url: 'https://github.com/owner/repo',
        },
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]);
    mockGetComment.mockRejectedValueOnce(new Error('not found'));
    mockGetIssue.mockResolvedValueOnce({
      data: { user: { login: 'creator' }, body: 'Fallback issue body' },
    });
    mockMarkThreadAsRead.mockResolvedValueOnce({});

    const channel = new GithubChannel('test', baseConfig, bridge);
    await channel.connect();
    await vi.waitFor(() => expect(mockGetIssue).toHaveBeenCalled(), {
      timeout: 2000,
    });
    channel.disconnect();

    expect(mockGetComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 123,
    });
    expect(mockGetIssue).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 42,
    });
    expect(promptFn).toHaveBeenCalled();
  });

  it('includes PR link and branch in text for pull request notifications', async () => {
    const bridge = mockBridge();

    mockPaginate.mockResolvedValueOnce([
      {
        id: '10',
        reason: 'review_requested',
        unread: true,
        subject: {
          title: 'Add feature',
          url: 'https://api.github.com/repos/owner/repo/pulls/7',
          latest_comment_url: null,
          type: 'PullRequest',
        },
        repository: {
          full_name: 'owner/repo',
          html_url: 'https://github.com/owner/repo',
        },
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]);
    mockGetPullRequest.mockResolvedValueOnce({
      data: {
        head: { ref: 'feature-branch' },
        body: 'PR description @reviewer',
      },
    });
    mockGetIssue.mockResolvedValueOnce({
      data: { user: { login: 'pr-author' }, body: '' },
    });
    mockMarkThreadAsRead.mockResolvedValueOnce({});

    const channel = new GithubChannel('test', baseConfig, bridge);
    const envelopes: unknown[] = [];
    const origHandleInbound = (
      channel as unknown as {
        handleInbound: (e: unknown) => Promise<void>;
      }
    ).handleInbound.bind(channel);
    (
      channel as unknown as {
        handleInbound: (e: unknown) => Promise<void>;
      }
    ).handleInbound = async (e: unknown) => {
      envelopes.push(e);
      await origHandleInbound(e);
    };

    await channel.connect();
    await vi.waitFor(() => expect(envelopes.length).toBe(1), {
      timeout: 2000,
    });
    channel.disconnect();

    expect(mockGetPullRequest).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 7,
    });
    const env = envelopes[0] as { text: string; metadata?: string };
    expect(env.text).toContain('PR description');
    expect(env.text).toContain('@reviewer');
    expect(env.metadata).toContain('URL: https://github.com/owner/repo/pull/7');
    expect(env.metadata).toContain('Branch: feature-branch');
    expect((envelopes[0] as { senderId: string }).senderId).toBe('pr-author');
  });

  it('includes metadata for slash command comments', async () => {
    const bridge = mockBridge();

    mockPaginate.mockResolvedValueOnce([
      {
        id: '10',
        reason: 'mention',
        unread: true,
        subject: {
          title: 'Add feature',
          url: 'https://api.github.com/repos/owner/repo/issues/7',
          latest_comment_url:
            'https://api.github.com/repos/owner/repo/issues/comments/99',
          type: 'Issue',
        },
        repository: {
          full_name: 'owner/repo',
          html_url: 'https://github.com/owner/repo',
        },
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]);
    mockGetComment.mockResolvedValueOnce({
      data: { user: { login: 'commenter' }, body: '/review please' },
    });
    mockMarkThreadAsRead.mockResolvedValueOnce({});

    const channel = new GithubChannel('test', baseConfig, bridge);
    const envelopes: unknown[] = [];
    const origHandleInbound = (
      channel as unknown as {
        handleInbound: (e: unknown) => Promise<void>;
      }
    ).handleInbound.bind(channel);
    (
      channel as unknown as {
        handleInbound: (e: unknown) => Promise<void>;
      }
    ).handleInbound = async (e: unknown) => {
      envelopes.push(e);
      await origHandleInbound(e);
    };

    await channel.connect();
    await vi.waitFor(() => expect(envelopes.length).toBe(1), {
      timeout: 2000,
    });
    channel.disconnect();

    const env = envelopes[0] as { text: string; metadata?: string };
    expect(env.text).toContain('/review please');
    expect(env.metadata).toContain(
      'URL: https://github.com/owner/repo/issues/7',
    );
    expect(env.metadata).toContain('Title: Add feature');
  });

  it('sendThreadMessage creates comment on issue', async () => {
    mockCreateComment.mockResolvedValueOnce({ data: { id: 1 } });

    const channel = new GithubChannel('test', baseConfig, mockBridge());
    await channel.sendThreadMessage('owner/repo', 'issue:42', 'Hello');

    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 42,
      body: 'Hello',
    });
  });

  it('sendThreadMessage creates comment on PR', async () => {
    mockCreateComment.mockResolvedValueOnce({ data: { id: 1 } });

    const channel = new GithubChannel('test', baseConfig, mockBridge());
    await channel.sendThreadMessage('owner/repo', 'pr:7', 'Review');

    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 7,
      body: 'Review',
    });
  });

  it('sendThreadMessage logs error when threadId is undefined', async () => {
    const channel = new GithubChannel('test', baseConfig, mockBridge());
    await channel.sendThreadMessage(
      'owner/repo',
      undefined,
      'Your pairing code is: abc123',
    );

    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it('resolves sender from PR review comment when issues.getComment fails', async () => {
    mockGetComment.mockRejectedValueOnce(new Error('Not Found'));
    mockGetReviewComment.mockResolvedValueOnce({
      data: { user: { login: 'reviewer' }, body: 'LGTM' },
    });
    mockPaginate.mockResolvedValue([
      {
        id: '1',
        reason: 'review_requested',
        subject: {
          type: 'PullRequest',
          title: 'Fix bug',
          url: 'https://api.github.com/repos/owner/repo/pulls/7',
          latest_comment_url:
            'https://api.github.com/repos/owner/repo/pulls/comments/999',
        },
        repository: {
          full_name: 'owner/repo',
          html_url: 'https://github.com/owner/repo',
        },
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]);

    const envelopes: unknown[] = [];
    const channel = new GithubChannel('test', baseConfig, mockBridge());
    const origHandleInbound = (
      channel as unknown as { handleInbound: (e: unknown) => Promise<void> }
    ).handleInbound.bind(channel);
    (
      channel as unknown as { handleInbound: (e: unknown) => Promise<void> }
    ).handleInbound = async (e: unknown) => {
      envelopes.push(e);
      await origHandleInbound(e);
    };

    await channel.connect();
    await vi.waitFor(() => expect(envelopes.length).toBe(1), {
      timeout: 2000,
    });
    channel.disconnect();

    expect((envelopes[0] as { senderId: string }).senderId).toBe('reviewer');
  });

  it('sets isMentioned true for mention reason', async () => {
    mockGetComment.mockResolvedValueOnce({
      data: { user: { login: 'alice' }, body: '@bot help' },
    });
    mockPaginate.mockResolvedValue([
      {
        id: '1',
        reason: 'mention',
        subject: {
          type: 'Issue',
          title: 'Question',
          url: 'https://api.github.com/repos/owner/repo/issues/1',
          latest_comment_url:
            'https://api.github.com/repos/owner/repo/issues/comments/100',
        },
        repository: {
          full_name: 'owner/repo',
          html_url: 'https://github.com/owner/repo',
        },
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]);

    const envelopes: unknown[] = [];
    const channel = new GithubChannel('test', baseConfig, mockBridge());
    const origHandleInbound = (
      channel as unknown as { handleInbound: (e: unknown) => Promise<void> }
    ).handleInbound.bind(channel);
    (
      channel as unknown as { handleInbound: (e: unknown) => Promise<void> }
    ).handleInbound = async (e: unknown) => {
      envelopes.push(e);
      await origHandleInbound(e);
    };

    await channel.connect();
    await vi.waitFor(() => expect(envelopes.length).toBe(1), {
      timeout: 2000,
    });
    channel.disconnect();

    expect((envelopes[0] as { isMentioned: boolean }).isMentioned).toBe(true);
  });

  it('sets isMentioned true for team_mention reason', async () => {
    mockPaginate.mockResolvedValue([
      {
        id: '2',
        reason: 'team_mention',
        subject: {
          type: 'Issue',
          title: 'Team question',
          url: 'https://api.github.com/repos/owner/repo/issues/2',
          latest_comment_url: null,
        },
        repository: {
          full_name: 'owner/repo',
          html_url: 'https://github.com/owner/repo',
        },
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]);
    mockGetIssue.mockResolvedValueOnce({
      data: { user: { login: 'author' }, body: '' },
    });

    const envelopes: unknown[] = [];
    const channel = new GithubChannel('test', baseConfig, mockBridge());
    const origHandleInbound = (
      channel as unknown as { handleInbound: (e: unknown) => Promise<void> }
    ).handleInbound.bind(channel);
    (
      channel as unknown as { handleInbound: (e: unknown) => Promise<void> }
    ).handleInbound = async (e: unknown) => {
      envelopes.push(e);
      await origHandleInbound(e);
    };

    await channel.connect();
    await vi.waitFor(() => expect(envelopes.length).toBe(1), {
      timeout: 2000,
    });
    channel.disconnect();

    expect((envelopes[0] as { isMentioned: boolean }).isMentioned).toBe(true);
  });

  it('sets isMentioned false for non-mention reason', async () => {
    mockPaginate.mockResolvedValue([
      {
        id: '3',
        reason: 'subscribed',
        subject: {
          type: 'Issue',
          title: 'State change',
          url: 'https://api.github.com/repos/owner/repo/issues/3',
          latest_comment_url: null,
        },
        repository: {
          full_name: 'owner/repo',
          html_url: 'https://github.com/owner/repo',
        },
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]);
    mockGetIssue.mockResolvedValueOnce({
      data: { user: { login: 'author' }, body: '' },
    });

    const envelopes: unknown[] = [];
    const channel = new GithubChannel('test', baseConfig, mockBridge());
    const origHandleInbound = (
      channel as unknown as { handleInbound: (e: unknown) => Promise<void> }
    ).handleInbound.bind(channel);
    (
      channel as unknown as { handleInbound: (e: unknown) => Promise<void> }
    ).handleInbound = async (e: unknown) => {
      envelopes.push(e);
      await origHandleInbound(e);
    };

    await channel.connect();
    await vi.waitFor(() => expect(envelopes.length).toBe(1), {
      timeout: 2000,
    });
    channel.disconnect();

    expect((envelopes[0] as { isMentioned: boolean }).isMentioned).toBe(false);
  });

  it('sendThreadMessage ignores invalid chatId', async () => {
    const channel = new GithubChannel('test', baseConfig, mockBridge());
    await channel.sendThreadMessage('noslash', 'issue:1', 'Hello');
    expect(mockCreateComment).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('sendThreadMessage ignores invalid threadId', async () => {
    const channel = new GithubChannel('test', baseConfig, mockBridge());
    await channel.sendThreadMessage('owner/repo', 'badformat', 'Hello');
    expect(mockCreateComment).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('sendMessage throws', () => {
    const channel = new GithubChannel('test', baseConfig, mockBridge());
    expect(() => channel.sendMessage('owner/repo', 'hi')).toThrow(
      /sendThreadMessage/,
    );
  });

  it('advances cursor and replies error on handleInbound failure', async () => {
    const bridge = mockBridge();

    const notification = {
      id: '1',
      reason: 'mention',
      unread: true,
      subject: {
        title: 'Fix bug',
        type: 'Issue',
        url: 'https://api.github.com/repos/owner/repo/issues/1',
        latest_comment_url: null,
      },
      repository: {
        full_name: 'owner/repo',
        html_url: 'https://github.com/owner/repo',
      },
      updated_at: '2026-01-01T00:00:00Z',
    };

    mockPaginate.mockResolvedValue([notification]);
    mockGetIssue.mockResolvedValue({
      data: { user: { login: 'author' }, body: 'fix this' },
    });
    mockMarkThreadAsRead.mockResolvedValue({});

    const channel = new GithubChannel(
      'test',
      { ...baseConfig, pollInterval: 5000 },
      bridge,
    );
    (
      channel as unknown as {
        handleInbound: (e: unknown) => Promise<void>;
      }
    ).handleInbound = async () => {
      throw new Error('agent error');
    };
    await channel.connect();
    await vi.waitFor(() => expect(mockMarkThreadAsRead).toHaveBeenCalled(), {
      timeout: 2000,
    });
    channel.disconnect();

    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 1,
      body: 'Sorry, something went wrong processing your message.',
    });
    const cursor = loadPollCursor('test', join(tempDir, 'channels'));
    expect(cursor.timestamp).toBe('2026-01-01T00:00:00Z');
  });

  it('does not re-dispatch seen notifications', async () => {
    const bridge = mockBridge();
    const promptFn = vi.fn().mockResolvedValue(undefined);
    (bridge as Record<string, unknown>).prompt = promptFn;

    const notification = {
      id: '1',
      reason: 'mention',
      unread: true,
      subject: {
        title: 'Fix bug',
        type: 'Issue',
        url: 'https://api.github.com/repos/owner/repo/issues/1',
        latest_comment_url: null,
      },
      repository: {
        full_name: 'owner/repo',
        html_url: 'https://github.com/owner/repo',
      },
      updated_at: '2026-01-01T00:00:00Z',
    };

    mockPaginate.mockResolvedValue([notification]);
    mockGetIssue.mockResolvedValue({
      data: { user: { login: 'author' }, body: 'fix this' },
    });
    mockMarkThreadAsRead.mockResolvedValue({});

    const channel = new GithubChannel(
      'test',
      {
        ...baseConfig,
        pollInterval: 5000,
      } as ChannelConfig,
      bridge,
    );

    await channel.connect();
    await vi.waitFor(() => expect(promptFn).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });
    await new Promise((r) => setTimeout(r, 100));
    channel.disconnect();

    expect(promptFn).toHaveBeenCalledTimes(1);
  });

  it('retries after consecutive errors', async () => {
    mockPaginate.mockRejectedValue(new Error('API down'));

    const channel = new GithubChannel(
      'test',
      { ...baseConfig, pollInterval: 5000 },
      mockBridge(),
    );
    await channel.connect();

    await vi.waitFor(
      () => expect(mockPaginate.mock.calls.length).toBeGreaterThanOrEqual(3),
      { timeout: 10_000 },
    );

    channel.disconnect();
  }, 15_000);

  it('restores cursor from disk on construction', async () => {
    const cursorDir = join(tempDir, 'channels');
    savePollCursor('test', '2024-01-01T00:00:00Z', new Set(['1']), cursorDir);

    mockPaginate.mockResolvedValue([
      {
        id: '1',
        reason: 'mention',
        unread: true,
        subject: {
          title: 'Old notification',
          type: 'Issue',
          url: 'https://api.github.com/repos/owner/repo/issues/1',
          latest_comment_url: null,
        },
        repository: {
          full_name: 'owner/repo',
          html_url: 'https://github.com/owner/repo',
        },
        updated_at: '2024-01-01T00:00:00Z',
      },
      {
        id: '2',
        reason: 'mention',
        unread: true,
        subject: {
          title: 'New notification',
          type: 'Issue',
          url: 'https://api.github.com/repos/owner/repo/issues/2',
          latest_comment_url: null,
        },
        repository: {
          full_name: 'owner/repo',
          html_url: 'https://github.com/owner/repo',
        },
        updated_at: '2024-06-01T00:00:00Z',
      },
    ]);
    mockGetIssue.mockResolvedValue({
      data: { user: { login: 'author' }, body: 'text' },
    });
    mockMarkThreadAsRead.mockResolvedValue({});

    const bridge = mockBridge();
    const promptFn = vi.fn().mockResolvedValue(undefined);
    (bridge as Record<string, unknown>).prompt = promptFn;

    const channel = new GithubChannel('test', baseConfig, bridge);
    await channel.connect();
    await vi.waitFor(
      () => expect(mockMarkThreadAsRead).toHaveBeenCalledWith({ thread_id: 2 }),
      { timeout: 2000 },
    );
    channel.disconnect();

    // id=1 should be skipped (already in cursor), only id=2 dispatched
    expect(mockMarkThreadAsRead).toHaveBeenCalledWith({ thread_id: 2 });
    expect(mockMarkThreadAsRead).not.toHaveBeenCalledWith({ thread_id: 1 });

    // Verify cursor was updated
    const cursor = loadPollCursor('test', cursorDir);
    expect(cursor.timestamp).toBe('2024-06-01T00:00:00Z');
  });
});
