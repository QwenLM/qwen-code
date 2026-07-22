import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GiteaChannel } from './GiteaAdapter.js';
import { savePollCursor, loadPollCursor } from '@qwen-code/channel-base';
import type {
  ChannelAgentBridge,
  ChannelConfig,
} from '@qwen-code/channel-base';

const baseConfig: ChannelConfig = {
  type: 'gitea',
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
  mockNotifyGetList,
  mockNotifyReadThread,
  mockCreateComment,
  mockCreateIssue,
  mockGetComment,
  mockGetIssue,
  mockRepoGetPullRequest,
  mockUserGetCurrent,
} = vi.hoisted(() => ({
  mockNotifyGetList: vi.fn(),
  mockNotifyReadThread: vi.fn(),
  mockCreateComment: vi.fn(),
  mockCreateIssue: vi.fn(),
  mockGetComment: vi.fn(),
  mockGetIssue: vi.fn(),
  mockRepoGetPullRequest: vi.fn(),
  mockUserGetCurrent: vi.fn(),
}));

vi.mock('gitea-js', () => ({
  giteaApi: vi.fn().mockImplementation(() => ({
    notifications: {
      notifyGetList: mockNotifyGetList,
      notifyReadThread: mockNotifyReadThread,
    },
    repos: {
      issueCreateComment: mockCreateComment,
      issueCreateIssue: mockCreateIssue,
      issueGetIssue: mockGetIssue,
      issueGetComment: mockGetComment,
      repoGetPullRequest: mockRepoGetPullRequest,
    },
    user: {
      userGetCurrent: mockUserGetCurrent,
    },
  })),
}));

describe('GiteaChannel', () => {
  let tempDir: string;
  let originalQwenHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gitea-adapter-test-'));
    originalQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = tempDir;
    mockNotifyGetList.mockClear();
    mockNotifyGetList.mockResolvedValue({ data: [] });
    mockNotifyReadThread.mockClear();
    mockCreateComment.mockClear();
    mockCreateIssue.mockClear();
    mockGetComment.mockClear();
    mockGetIssue.mockClear();
    mockRepoGetPullRequest.mockClear();
    mockUserGetCurrent.mockClear();
    mockUserGetCurrent.mockResolvedValue({ data: { login: 'bot' } });
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
    mockNotifyGetList.mockResolvedValueOnce({ data: [] });

    const channel = new GiteaChannel('test', baseConfig, mockBridge());
    await channel.connect();
    channel.disconnect();

    expect(mockNotifyGetList).toHaveBeenCalled();
  });

  it('resolves sender from latest_comment_url', async () => {
    const bridge = mockBridge();
    const promptFn = vi.fn().mockResolvedValue(undefined);
    (bridge as Record<string, unknown>).prompt = promptFn;

    mockNotifyGetList.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          reason: 'mention',
          unread: true,
          subject: {
            title: 'Fix bug',
            type: 'issue',
            url: 'https://gitea.com/api/v1/repos/owner/repo/issues/1',
            latest_comment_url:
              'https://gitea.com/api/v1/repos/owner/repo/issues/comments/42',
            html_url: 'https://gitea.com/owner/repo/issues/1',
          },
          repository: {
            full_name: 'owner/repo',
            html_url: 'https://gitea.com/owner/repo',
          },
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockGetComment.mockResolvedValueOnce({
      data: { user: { login: 'commenter' }, body: 'Please fix @bot' },
    });
    mockNotifyReadThread.mockResolvedValueOnce({});

    const channel = new GiteaChannel('test', baseConfig, bridge);
    await channel.connect();
    await vi.waitFor(() => expect(mockNotifyReadThread).toHaveBeenCalled(), {
      timeout: 2000,
    });
    channel.disconnect();

    expect(mockGetComment).toHaveBeenCalledWith('owner', 'repo', 42);
    expect(mockNotifyReadThread).toHaveBeenCalledWith('1');
    expect(promptFn).toHaveBeenCalled();
  });

  it('falls back to issue creator when latest_comment_url is null', async () => {
    const bridge = mockBridge();
    const promptFn = vi.fn().mockResolvedValue(undefined);
    (bridge as Record<string, unknown>).prompt = promptFn;

    mockNotifyGetList.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          reason: 'mention',
          unread: true,
          subject: {
            title: 'Fix bug',
            type: 'issue',
            url: 'https://gitea.com/api/v1/repos/owner/repo/issues/1',
            latest_comment_url: null,
            html_url: 'https://gitea.com/owner/repo/issues/1',
          },
          repository: {
            full_name: 'owner/repo',
            html_url: 'https://gitea.com/owner/repo',
          },
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockGetIssue.mockResolvedValueOnce({
      data: { user: { login: 'creator' }, body: 'Please fix this @bot' },
    });
    mockNotifyReadThread.mockResolvedValueOnce({});

    const channel = new GiteaChannel('test', baseConfig, bridge);
    await channel.connect();
    await vi.waitFor(() => expect(promptFn).toHaveBeenCalled(), {
      timeout: 2000,
    });
    channel.disconnect();

    expect(mockGetComment).not.toHaveBeenCalled();
    expect(mockGetIssue).toHaveBeenCalledWith('owner', 'repo', 1);
    expect(promptFn).toHaveBeenCalled();
  });

  it('includes branch in text for pull request notifications', async () => {
    const bridge = mockBridge();

    mockNotifyGetList.mockResolvedValueOnce({
      data: [
        {
          id: 2,
          reason: 'mention',
          unread: true,
          subject: {
            title: 'Add feature',
            type: 'Pull',
            url: 'https://gitea.com/api/v1/repos/owner/repo/pulls/5',
            latest_comment_url: null,
            html_url: 'https://gitea.com/owner/repo/pulls/5',
          },
          repository: {
            full_name: 'owner/repo',
            html_url: 'https://gitea.com/owner/repo',
          },
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockRepoGetPullRequest.mockResolvedValueOnce({
      data: {
        head: { ref: 'feature-branch' },
        body: 'PR body @reviewer',
        user: { login: 'pr-author' },
      },
    });
    mockNotifyReadThread.mockResolvedValueOnce({});

    const channel = new GiteaChannel('test', baseConfig, bridge);
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

    expect(mockRepoGetPullRequest).toHaveBeenCalledWith('owner', 'repo', 5);
    const env = envelopes[0] as {
      text: string;
      metadata?: string;
      senderId: string;
      senderName: string;
    };
    expect(env.text).toContain('PR body');
    expect(env.text).toContain('@reviewer');
    expect(env.metadata).toContain('URL: https://gitea.com/owner/repo/pulls/5');
    expect(env.metadata).toContain('Branch: feature-branch');
    expect(env.senderId).toBe('pr-author');
    expect(env.senderName).toBe('pr-author');
  });

  it('includes metadata for slash command comments', async () => {
    mockNotifyGetList.mockResolvedValueOnce({
      data: [
        {
          id: 2,
          reason: 'mention',
          unread: true,
          subject: {
            title: 'Bug report',
            type: 'Issue',
            url: 'https://gitea.com/api/v1/repos/owner/repo/issues/1',
            latest_comment_url:
              'https://gitea.com/api/v1/repos/owner/repo/issues/comments/99',
            html_url: 'https://gitea.com/owner/repo/issues/1',
          },
          repository: {
            full_name: 'owner/repo',
            html_url: 'https://gitea.com/owner/repo',
          },
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockGetComment.mockResolvedValueOnce({
      data: { user: { login: 'commenter' }, body: '/review please' },
    });
    mockNotifyReadThread.mockResolvedValueOnce({});

    const bridge = mockBridge();
    const channel = new GiteaChannel('test', baseConfig, bridge);
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
      'URL: https://gitea.com/owner/repo/issues/1',
    );
    expect(env.metadata).toContain('Title: Bug report');
  });

  it('sendThreadMessage creates comment on issue', async () => {
    mockCreateComment.mockResolvedValueOnce({ data: { id: 1 } });

    const channel = new GiteaChannel('test', baseConfig, mockBridge());
    await channel.sendThreadMessage('owner/repo', 'issue:1', 'Hello');

    expect(mockCreateComment).toHaveBeenCalledWith('owner', 'repo', 1, {
      body: 'Hello',
    });
  });

  it('sendThreadMessage creates comment on PR', async () => {
    mockCreateComment.mockResolvedValueOnce({ data: { id: 1 } });

    const channel = new GiteaChannel('test', baseConfig, mockBridge());
    await channel.sendThreadMessage('owner/repo', 'pr:5', 'Review');

    expect(mockCreateComment).toHaveBeenCalledWith('owner', 'repo', 5, {
      body: 'Review',
    });
  });

  it('sendThreadMessage logs error when threadId is undefined', async () => {
    const channel = new GiteaChannel('test', baseConfig, mockBridge());
    await channel.sendThreadMessage(
      'owner/repo',
      undefined,
      'Your pairing code is: abc123',
    );

    expect(mockCreateComment).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('sendThreadMessage ignores invalid chatId', async () => {
    const channel = new GiteaChannel('test', baseConfig, mockBridge());
    await channel.sendThreadMessage('noslash', 'issue:1', 'Hello');
    expect(mockCreateComment).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('sendThreadMessage ignores invalid threadId', async () => {
    const channel = new GiteaChannel('test', baseConfig, mockBridge());
    await channel.sendThreadMessage('owner/repo', 'badformat', 'Hello');
    expect(mockCreateComment).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('sendMessage throws', () => {
    const channel = new GiteaChannel('test', baseConfig, mockBridge());
    expect(() => channel.sendMessage('owner/repo', 'hi')).toThrow(
      /sendThreadMessage/,
    );
  });

  it('asserts envelope fields for issue notification', async () => {
    const bridge = mockBridge();

    mockNotifyGetList.mockResolvedValueOnce({
      data: [
        {
          id: 10,
          reason: 'mention',
          unread: true,
          subject: {
            title: 'Fix bug',
            type: 'issue',
            url: 'https://gitea.com/api/v1/repos/owner/repo/issues/1',
            latest_comment_url:
              'https://gitea.com/api/v1/repos/owner/repo/issues/comments/42',
            html_url: 'https://gitea.com/owner/repo/issues/1',
          },
          repository: {
            full_name: 'owner/repo',
            html_url: 'https://gitea.com/owner/repo',
          },
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockGetComment.mockResolvedValueOnce({
      data: { user: { login: 'commenter' }, body: '@bot please fix' },
    });
    mockNotifyReadThread.mockResolvedValueOnce({});

    const channel = new GiteaChannel('test', baseConfig, bridge);
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

    const env = envelopes[0] as {
      chatId: string;
      threadId: string;
      senderId: string;
      senderName: string;
      isMentioned: boolean;
    };
    expect(env.chatId).toBe('owner/repo');
    expect(env.threadId).toBe('issue:1');
    expect(env.senderId).toBe('commenter');
    expect(env.senderName).toBe('commenter');
    expect(env.isMentioned).toBe(true);
  });

  it('connects successfully when bot identity is unavailable', async () => {
    mockUserGetCurrent.mockRejectedValueOnce(new Error('forbidden'));
    mockNotifyGetList.mockResolvedValueOnce({ data: [] });
    const bridge = mockBridge();

    const channel = new GiteaChannel('test', baseConfig, bridge);
    await channel.connect();
    channel.disconnect();

    expect(mockNotifyGetList).toHaveBeenCalled();
  });

  it('sets isMentioned true when bot username is mentioned in body', async () => {
    mockUserGetCurrent.mockResolvedValueOnce({ data: { login: 'mybot' } });
    const bridge = mockBridge();

    mockNotifyGetList.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          reason: 'mention',
          unread: true,
          subject: {
            title: 'Fix bug',
            type: 'issue',
            url: 'https://gitea.com/api/v1/repos/owner/repo/issues/1',
            latest_comment_url:
              'https://gitea.com/api/v1/repos/owner/repo/issues/comments/42',
            html_url: 'https://gitea.com/owner/repo/issues/1',
          },
          repository: {
            full_name: 'owner/repo',
            html_url: 'https://gitea.com/owner/repo',
          },
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockGetComment.mockResolvedValueOnce({
      data: { user: { login: 'commenter' }, body: '@mybot please review' },
    });
    mockNotifyReadThread.mockResolvedValueOnce({});

    const channel = new GiteaChannel('test', baseConfig, bridge);
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

    expect((envelopes[0] as { isMentioned: boolean }).isMentioned).toBe(true);
  });

  it('advances cursor and replies error on handleInbound failure', async () => {
    const bridge = mockBridge();

    const notification = {
      id: 1,
      reason: 'mention',
      unread: true,
      subject: {
        title: 'Fix bug',
        type: 'Issue',
        url: 'https://gitea.com/api/v1/repos/owner/repo/issues/1',
        latest_comment_url: null,
        html_url: 'https://gitea.com/owner/repo/issues/1',
      },
      repository: {
        full_name: 'owner/repo',
        html_url: 'https://gitea.com/owner/repo',
      },
      updated_at: '2026-01-01T00:00:00Z',
    };

    mockNotifyGetList.mockResolvedValueOnce({ data: [notification] });

    const channel = new GiteaChannel(
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
    await vi.waitFor(() => expect(mockNotifyReadThread).toHaveBeenCalled(), {
      timeout: 2000,
    });
    channel.disconnect();

    expect(mockCreateComment).toHaveBeenCalledWith('owner', 'repo', 1, {
      body: 'Sorry, something went wrong processing your message.',
    });
    const cursor = loadPollCursor('test', join(tempDir, 'channels'));
    expect(cursor.timestamp).toBe('2026-01-01T00:00:00Z');
  });

  it('fetches all pages of notifications', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      reason: 'mention',
      unread: true,
      subject: {
        title: `Issue ${i}`,
        type: 'issue',
        url: `https://gitea.com/api/v1/repos/owner/repo/issues/${i}`,
        latest_comment_url: null,
        html_url: `https://gitea.com/owner/repo/issues/${i}`,
      },
      repository: {
        full_name: 'owner/repo',
        html_url: 'https://gitea.com/owner/repo',
      },
      updated_at: '2026-01-01T00:00:00Z',
    }));
    const page2 = [
      {
        id: 101,
        reason: 'mention',
        unread: true,
        subject: {
          title: 'Last issue',
          type: 'issue',
          url: 'https://gitea.com/api/v1/repos/owner/repo/issues/100',
          latest_comment_url: null,
          html_url: 'https://gitea.com/owner/repo/issues/100',
        },
        repository: {
          full_name: 'owner/repo',
          html_url: 'https://gitea.com/owner/repo',
        },
        updated_at: '2026-01-01T00:00:00Z',
      },
    ];
    mockNotifyGetList
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 });
    mockGetIssue.mockResolvedValue({
      data: { user: { login: 'author' }, body: 'text' },
    });
    mockNotifyReadThread.mockResolvedValue({});

    const bridge = mockBridge();
    const channel = new GiteaChannel('test', baseConfig, bridge);
    await channel.connect();
    await vi.waitFor(
      () => expect(mockNotifyReadThread).toHaveBeenCalledTimes(101),
      { timeout: 5000 },
    );
    channel.disconnect();
    // Let the in-flight pollNotifications finish before the next test starts
    await new Promise((r) => setTimeout(r, 300));

    expect(mockNotifyGetList).toHaveBeenCalledTimes(3);
    expect(mockNotifyReadThread).toHaveBeenCalledTimes(101);
  });

  it('does not re-dispatch seen notifications', async () => {
    const bridge = mockBridge();

    const notification = {
      id: 1,
      reason: 'mention',
      unread: true,
      subject: {
        title: 'Fix bug',
        type: 'issue',
        url: 'https://gitea.com/api/v1/repos/owner/repo/issues/1',
        latest_comment_url:
          'https://gitea.com/api/v1/repos/owner/repo/issues/comments/42',
        html_url: 'https://gitea.com/owner/repo/issues/1',
      },
      repository: {
        full_name: 'owner/repo',
        html_url: 'https://gitea.com/owner/repo',
      },
      updated_at: '2026-01-01T00:00:00Z',
    };

    mockNotifyGetList.mockResolvedValueOnce({ data: [notification] });
    mockGetComment.mockResolvedValue({
      data: { user: { login: 'commenter' }, body: '@bot fix this' },
    });
    mockNotifyReadThread.mockResolvedValue({});

    const channel = new GiteaChannel(
      'test',
      {
        ...baseConfig,
        pollInterval: 5000,
      } as ChannelConfig,
      bridge,
    );

    await channel.connect();
    await vi.waitFor(
      () => expect(mockNotifyReadThread).toHaveBeenCalledTimes(1),
      {
        timeout: 2000,
      },
    );
    await new Promise((r) => setTimeout(r, 150));
    channel.disconnect();

    expect(mockNotifyReadThread).toHaveBeenCalledTimes(1);
  });

  it('uses longer backoff after consecutive errors', async () => {
    mockNotifyGetList.mockRejectedValue(new Error('API down'));

    const callTimestamps: number[] = [];
    mockNotifyGetList.mockImplementation(async () => {
      callTimestamps.push(Date.now());
      throw new Error('API down');
    });

    const channel = new GiteaChannel(
      'test',
      { ...baseConfig, pollInterval: 5000 },
      mockBridge(),
    );
    await channel.connect();

    await vi.waitFor(
      () => expect(callTimestamps.length).toBeGreaterThanOrEqual(4),
      { timeout: 40_000 },
    );

    channel.disconnect();

    const shortGap = callTimestamps[1]! - callTimestamps[0]!;
    const longGap = callTimestamps[3]! - callTimestamps[2]!;
    expect(shortGap).toBeLessThan(4000);
    expect(longGap).toBeGreaterThan(25_000);
  }, 50_000);

  it('restores cursor from disk on construction', async () => {
    const cursorDir = join(tempDir, 'channels');
    savePollCursor('test', '2024-01-01T00:00:00Z', new Set(['1']), cursorDir);

    mockNotifyGetList.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          reason: 'mention',
          unread: true,
          subject: {
            title: 'Old notification',
            type: 'issue',
            url: 'https://gitea.com/api/v1/repos/owner/repo/issues/1',
            latest_comment_url: null,
            html_url: 'https://gitea.com/owner/repo/issues/1',
          },
          repository: {
            full_name: 'owner/repo',
            html_url: 'https://gitea.com/owner/repo',
          },
          updated_at: '2024-01-01T00:00:00Z',
        },
        {
          id: 2,
          reason: 'mention',
          unread: true,
          subject: {
            title: 'New notification',
            type: 'issue',
            url: 'https://gitea.com/api/v1/repos/owner/repo/issues/2',
            latest_comment_url: null,
            html_url: 'https://gitea.com/owner/repo/issues/2',
          },
          repository: {
            full_name: 'owner/repo',
            html_url: 'https://gitea.com/owner/repo',
          },
          updated_at: '2024-06-01T00:00:00Z',
        },
      ],
    });
    mockGetIssue.mockResolvedValue({
      data: { user: { login: 'author' }, body: 'text' },
    });
    mockNotifyReadThread.mockResolvedValue({});

    const bridge = mockBridge();
    const promptFn = vi.fn().mockResolvedValue('done');
    (bridge as Record<string, unknown>).prompt = promptFn;

    const channel = new GiteaChannel('test', baseConfig, bridge);
    await channel.connect();
    await vi.waitFor(
      () => expect(mockNotifyReadThread).toHaveBeenCalledWith('2'),
      { timeout: 2000 },
    );
    channel.disconnect();

    // id=1 should be skipped (already in cursor), only id=2 dispatched
    expect(mockNotifyReadThread).toHaveBeenCalledWith('2');
    expect(mockNotifyReadThread).not.toHaveBeenCalledWith('1');

    const cursor = loadPollCursor('test', cursorDir);
    expect(cursor.timestamp).toBe('2024-06-01T00:00:00Z');
  });
});
