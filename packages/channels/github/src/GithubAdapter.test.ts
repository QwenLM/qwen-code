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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BoundSessionGoneError,
  BoundSessionQueueFullError,
  BoundSessionUnavailableError,
  getWorkspaceScopeDirName,
  PairingStore,
  type ChannelAgentBridge,
  type ChannelBoundSessions,
  type ChannelConfig,
  type Envelope,
  type PrBindingSummary,
} from '@qwen-code/channel-base';

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

// Delegate to the real fs by default; the mock namespace (unlike the raw
// ESM builtin) is configurable, so individual tests can spyOn readFileSync /
// renameSync to inject transient I/O faults and restore them afterwards.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual };
});

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
      checks: {
        listForRef: vi.fn(),
      },
      repos: {
        getCombinedStatusForRef: vi.fn(),
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

const octokitModule = (await import('@octokit/rest')) as unknown as {
  Octokit: Mock;
  __mockOctokit: Record<string, unknown>;
};
const mockOctokitConstructor = octokitModule.Octokit;
const mockOctokit = octokitModule.__mockOctokit as {
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
    checks: {
      listForRef: ReturnType<typeof vi.fn>;
    };
    repos: {
      getCombinedStatusForRef: ReturnType<typeof vi.fn>;
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

function inboundTaskPath(
  cwd = '/tmp/test',
  channelName = 'test-github',
): string {
  const nameHash = createHash('sha256')
    .update(channelName)
    .digest('hex')
    .slice(0, 16);
  return join(
    process.env.QWEN_HOME!,
    'channels',
    getWorkspaceScopeDirName(cwd),
    `${channelName}-${nameHash}-github-inbound-tasks.json`,
  );
}

/** Mirrors channelFilePath('github-bound-deadletter.jsonl') for assertions. */
function boundDeadLetterPath(
  cwd = '/tmp/test',
  channelName = 'test-github',
): string {
  const nameHash = createHash('sha256')
    .update(channelName)
    .digest('hex')
    .slice(0, 16);
  return join(
    process.env.QWEN_HOME!,
    'channels',
    getWorkspaceScopeDirName(cwd),
    `${channelName}-${nameHash}-github-bound-deadletter.jsonl`,
  );
}

function makeInboundTaskRecord(overrides: Record<string, unknown> = {}) {
  const envelope = {
    channelName: 'test-github',
    senderId: 'alice',
    senderName: 'alice',
    chatId: 'owner/repo',
    threadId: 'issue:42',
    messageId: '1001',
    text: 'please fix this',
    isGroup: true,
    isMentioned: true,
    isReplyToBot: false,
    metadata: 'Trigger: mention.',
  };
  return {
    version: 1,
    id: 'inbound-task-1',
    createdAt: '2026-07-02T10:00:00.000Z',
    updatedAt: '2026-07-02T10:00:00.000Z',
    state: 'accepted',
    issueNumber: 42,
    source: {
      chatId: envelope.chatId,
      threadId: envelope.threadId,
      messageId: envelope.messageId,
    },
    envelope,
    dedupe: { dispatchedComments: ['C_1001'] },
    ...overrides,
  };
}

function writeInboundTasks(records: unknown[]): void {
  const path = inboundTaskPath();
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(records)}\n`, 'utf-8');
}

function readInboundTasks(): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(inboundTaskPath(), 'utf-8')) as Array<
    Record<string, unknown>
  >;
}

/** Subclass that captures envelopes instead of running the full ChannelBase pipeline. */
class TestableGithubChannel extends GithubChannel {
  inboundEnvelopes: Envelope[] = [];
  handleInboundError: Error | null = null;
  usePreflight = false;
  sourceMessageId: string | undefined;
  sourceSenderId: string | undefined;
  sourceMetadata: string | undefined;
  inboundErrorSourceLabel: string | undefined;
  handleInboundHook: ((envelope: Envelope) => void | Promise<void>) | undefined;

  protected getResponseMessageId(_sessionId: string): string | undefined {
    return this.sourceMessageId;
  }

  protected getResponseSenderId(_sessionId: string): string | undefined {
    return this.sourceSenderId;
  }

  protected getResponseMetadata(_sessionId: string): string | undefined {
    return this.sourceMetadata;
  }

  protected getInboundErrorSourceLabel(
    _envelope: Envelope,
  ): string | undefined {
    return this.inboundErrorSourceLabel;
  }

  override async handleInbound(envelope: Envelope): Promise<void> {
    await this.handleInboundHook?.(envelope);
    if (this.handleInboundError) throw this.handleInboundError;
    if (this.usePreflight && !(await this.preflightInbound(envelope))) return;
    this.inboundEnvelopes.push(envelope);
  }

  triggerTaskLifecycleForTest(event: unknown): void {
    this.onTaskLifecycle(event as never);
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
    vi.unstubAllEnvs();
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
    vi.clearAllMocks();
  }

  async function pollOnce() {
    await (channel as unknown as { pollOnce: () => Promise<void> }).pollOnce();
  }

  describe('connect', () => {
    it('resolves bot username', async () => {
      mockOctokit.paginate.mockResolvedValue([]);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await channel.connect();
        expect(mockOctokit.rest.users.getAuthenticated).toHaveBeenCalled();
        expect(stderr).toHaveBeenCalledWith(
          '[Channel:test-github] using configured token\n',
        );
        expect(stderr).toHaveBeenCalledWith(
          '[Channel:test-github] authenticated as "test-bot"\n',
        );
      } finally {
        channel.disconnect();
        stderr.mockRestore();
      }
    });

    it('sanitizes the authenticated login in the stderr audit line', async () => {
      mockOctokit.rest.users.getAuthenticated.mockResolvedValue({
        data: { id: 99999, login: 'bot\nforged-line' },
      });
      mockOctokit.paginate.mockResolvedValue([]);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await channel.connect();
        expect(stderr).toHaveBeenCalledWith(
          '[Channel:test-github] authenticated as "bot\\nforged-line"\n',
        );
      } finally {
        channel.disconnect();
        stderr.mockRestore();
      }
    });

    it('requires explicit opt-in before using local gh authentication', async () => {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: '' }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow(
        'configure a GitHub token or enable local GitHub CLI authentication',
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only token', async () => {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: ' ' }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow(
        'configure a GitHub token or enable local GitHub CLI authentication',
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('rejects a quoted useLocalGh value from hand-edited settings', async () => {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: '', useLocalGh: 'true' }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow(
        '[Channel:test-github] useLocalGh must be a boolean.',
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('rejects a non-boolean useLocalGh even when a token is configured', async () => {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: 'test-token', useLocalGh: 'true' }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow(
        'useLocalGh must be a boolean',
      );
      expect(mockOctokitConstructor).not.toHaveBeenCalled();
    });

    it('falls back to local gh for a whitespace-only token', async () => {
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string) => void,
        ) => callback(null, 'local-gh-token\n'),
      );
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: ' ', useLocalGh: true }),
        makeBridge(),
      );
      mockOctokit.paginate.mockResolvedValue([]);

      await channel.connect();

      expect(mockExecFile).toHaveBeenCalled();
      expect(mockOctokitConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ auth: 'local-gh-token' }),
      );
      channel.disconnect();
    });

    it('uses local gh authentication when explicitly enabled', async () => {
      vi.stubEnv('GH_TOKEN', 'environment-token');
      vi.stubEnv('GITHUB_TOKEN', 'environment-token');
      vi.stubEnv('GH_ENTERPRISE_TOKEN', 'environment-token');
      vi.stubEnv('GITHUB_ENTERPRISE_TOKEN', 'environment-token');
      vi.stubEnv('GH_CONFIG_DIR', '/tmp/test-gh-config');
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string) => void,
        ) => callback(null, 'local-gh-token\n'),
      );
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: '', useLocalGh: true }),
        makeBridge(),
      );
      mockOctokit.paginate.mockResolvedValue([]);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      try {
        await channel.connect();

        expect(mockExecFile).toHaveBeenCalledWith(
          'gh',
          ['auth', 'token', '--hostname', 'github.com'],
          expect.objectContaining({
            encoding: 'utf8',
            maxBuffer: 64 * 1024,
            timeout: 10_000,
            windowsHide: true,
            env: expect.objectContaining({
              GH_CONFIG_DIR: '/tmp/test-gh-config',
            }),
          }),
          expect.any(Function),
        );
        const options = mockExecFile.mock.calls[0]?.[2] as {
          env: NodeJS.ProcessEnv;
        };
        expect(options.env).not.toHaveProperty('GH_TOKEN');
        expect(options.env).not.toHaveProperty('GITHUB_TOKEN');
        expect(options.env).not.toHaveProperty('GH_ENTERPRISE_TOKEN');
        expect(options.env).not.toHaveProperty('GITHUB_ENTERPRISE_TOKEN');
        expect(options.env['PATH']).toBe(process.env['PATH']);
        expect(mockOctokitConstructor).toHaveBeenCalledWith(
          expect.objectContaining({ auth: 'local-gh-token' }),
        );
        expect(stderr).not.toHaveBeenCalledWith(
          expect.stringContaining('local-gh-token'),
        );
      } finally {
        channel.disconnect();
        stderr.mockRestore();
      }
    });

    it('uses the enterprise host for local gh authentication', async () => {
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string) => void,
        ) => callback(null, 'enterprise-token\n'),
      );
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({
          token: '',
          useLocalGh: true,
          baseUrl: 'https://ghe.example.com:8443/api/v3',
        }),
        makeBridge(),
      );
      mockOctokit.paginate.mockResolvedValue([]);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      try {
        await channel.connect();

        expect(mockExecFile).toHaveBeenCalledWith(
          'gh',
          ['auth', 'token', '--hostname', 'ghe.example.com'],
          expect.any(Object),
          expect.any(Function),
        );
        expect(stderr).toHaveBeenCalledWith(
          '[Channel:test-github] using local gh credential for ghe.example.com\n',
        );
        expect(stderr).not.toHaveBeenCalledWith(
          expect.stringContaining('enterprise-token'),
        );
      } finally {
        channel.disconnect();
        stderr.mockRestore();
      }
    });

    it('rejects an insecure API URL before resolving local gh credentials', async () => {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({
          token: '',
          useLocalGh: true,
          baseUrl: 'http://api.github.com',
        }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow(
        'local GitHub CLI authentication requires an HTTPS baseUrl',
      );
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockOctokitConstructor).not.toHaveBeenCalled();
    });

    it('reports a malformed baseUrl before resolving local gh credentials', async () => {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({
          token: '',
          useLocalGh: true,
          baseUrl: 'ghe.example.com/api/v3',
        }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow(
        '[Channel:test-github] baseUrl is not a valid URL: ghe.example.com/api/v3',
      );
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockOctokitConstructor).not.toHaveBeenCalled();
    });

    it('reports a scheme-less baseUrl with a port as malformed', async () => {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({
          token: '',
          useLocalGh: true,
          baseUrl: 'ghe.example.com:8443/api/v3',
        }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow(
        '[Channel:test-github] baseUrl is not a valid URL: ghe.example.com:8443/api/v3',
      );
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockOctokitConstructor).not.toHaveBeenCalled();
    });

    it('rejects a baseUrl hostname that begins with a dash before spawning gh', async () => {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({
          token: '',
          useLocalGh: true,
          baseUrl: 'https://--evil/api/v3',
        }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow(
        '[Channel:test-github] baseUrl hostname is invalid: --evil',
      );
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockOctokitConstructor).not.toHaveBeenCalled();
    });

    it('rejects a baseUrl hostname outside the gh hostname allowlist', async () => {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({
          token: '',
          useLocalGh: true,
          baseUrl: 'https://ghe.example_company.com/api/v3',
        }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow(
        '[Channel:test-github] baseUrl hostname is invalid: ghe.example_company.com',
      );
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockOctokitConstructor).not.toHaveBeenCalled();
    });

    it('preserves explicit token support for an HTTP base URL', async () => {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({
          token: 'test-token',
          useLocalGh: true,
          baseUrl: 'http://ghe.example.com/api/v3',
        }),
        makeBridge(),
      );
      mockOctokit.paginate.mockResolvedValue([]);

      await channel.connect();

      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockOctokitConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: 'test-token',
          baseUrl: 'http://ghe.example.com/api/v3',
        }),
      );
      channel.disconnect();
    });

    it('reports an empty token returned by GitHub CLI', async () => {
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string) => void,
        ) => callback(null, ' \n'),
      );
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: '', useLocalGh: true }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow(
        'GitHub CLI returned an empty token for github.com',
      );
    });

    it('prefers an explicit token over enabled local gh authentication', async () => {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: 'test-token', useLocalGh: true }),
        makeBridge(),
      );
      mockOctokit.paginate.mockResolvedValue([]);

      await channel.connect();

      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockOctokitConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ auth: 'test-token' }),
      );
      channel.disconnect();
    });

    it('reports when GitHub CLI is unavailable', async () => {
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: NodeJS.ErrnoException, stdout: string) => void,
        ) =>
          callback(
            Object.assign(new Error('secret missing-cli failure'), {
              code: 'ENOENT',
            }),
            '',
          ),
      );
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: '', useLocalGh: true }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow(
        'GitHub CLI (gh) is not installed on the daemon host',
      );
      await expect(channel.connect()).rejects.not.toThrow(
        'secret missing-cli failure',
      );
    });

    it('reports when the selected gh host is not authenticated', async () => {
      vi.stubEnv('GH_CONFIG_DIR', '');
      vi.stubEnv('XDG_CONFIG_HOME', '');
      vi.stubEnv('APPDATA', '');
      vi.stubEnv('HOME', '/home/test-user');
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error & { code: number }, stdout: string) => void,
        ) =>
          callback(Object.assign(new Error('secret stderr'), { code: 1 }), ''),
      );
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: '', useLocalGh: true }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow(
        'gh auth login --hostname github.com',
      );
      await expect(channel.connect()).rejects.toThrow(
        'gh config dir: /home/test-user/.config/gh',
      );
      await expect(channel.connect()).rejects.not.toThrow('secret stderr');
    });

    it('names the gh config dir when the host is not authenticated', async () => {
      vi.stubEnv('GH_CONFIG_DIR', '/tmp/test-gh-config');
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error & { code: number }, stdout: string) => void,
        ) => callback(Object.assign(new Error('exit 1'), { code: 1 }), ''),
      );
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: '', useLocalGh: true }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow(
        'gh config dir: /tmp/test-gh-config',
      );
    });

    it('prefers XDG_CONFIG_HOME over HOME in the gh config dir hint', async () => {
      vi.stubEnv('GH_CONFIG_DIR', '');
      vi.stubEnv('XDG_CONFIG_HOME', '/tmp/test-xdg-config');
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error & { code: number }, stdout: string) => void,
        ) => callback(Object.assign(new Error('exit 1'), { code: 1 }), ''),
      );
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: '', useLocalGh: true }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow(
        'gh config dir: /tmp/test-xdg-config/gh',
      );
    });

    it('reports an unknown gh config dir when no config source is available', async () => {
      vi.stubEnv('GH_CONFIG_DIR', '');
      vi.stubEnv('XDG_CONFIG_HOME', '');
      vi.stubEnv('APPDATA', '');
      vi.stubEnv('HOME', '');
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error & { code: number }, stdout: string) => void,
        ) => callback(Object.assign(new Error('exit 1'), { code: 1 }), ''),
      );
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: '', useLocalGh: true }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow('gh config dir: unknown');
    });

    it('prefers the Windows AppData gh config dir on win32', async () => {
      vi.stubEnv('GH_CONFIG_DIR', '');
      vi.stubEnv('XDG_CONFIG_HOME', '');
      vi.stubEnv('APPDATA', 'C:\\Users\\test\\AppData\\Roaming');
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error & { code: number }, stdout: string) => void,
        ) => callback(Object.assign(new Error('exit 1'), { code: 1 }), ''),
      );
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: '', useLocalGh: true }),
        makeBridge(),
      );
      const platform = vi
        .spyOn(process, 'platform', 'get')
        .mockReturnValue('win32');

      try {
        await expect(channel.connect()).rejects.toThrow(
          'gh config dir: C:\\Users\\test\\AppData\\Roaming\\GitHub CLI',
        );
      } finally {
        platform.mockRestore();
      }
    });

    it('falls back to HOME when APPDATA is unset on win32', async () => {
      vi.stubEnv('GH_CONFIG_DIR', '');
      vi.stubEnv('XDG_CONFIG_HOME', '');
      vi.stubEnv('APPDATA', '');
      vi.stubEnv('HOME', '/home/test-user');
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error & { code: number }, stdout: string) => void,
        ) => callback(Object.assign(new Error('exit 1'), { code: 1 }), ''),
      );
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: '', useLocalGh: true }),
        makeBridge(),
      );
      const platform = vi
        .spyOn(process, 'platform', 'get')
        .mockReturnValue('win32');

      try {
        await expect(channel.connect()).rejects.toThrow(
          'gh config dir: /home/test-user/.config/gh',
        );
      } finally {
        platform.mockRestore();
      }
    });

    it('surfaces bounded gh stderr in the authentication failure', async () => {
      const rawStderr = `\u001b[2Jsecret${'x'.repeat(600)}`;
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (
            error: Error & { code: number },
            stdout: string,
            stderr: string,
          ) => void,
        ) =>
          callback(
            Object.assign(new Error('exit 1'), { code: 1 }),
            '',
            rawStderr,
          ),
      );
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: '', useLocalGh: true }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow(
        'gh auth login --hostname github.com',
      );
      const error = (await channel
        .connect()
        .catch((err: unknown) => err)) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain('\u001b');
      const hint = error.message.split(' gh stderr: ')[1] ?? '';
      expect(hint).toContain('[2Jsecret');
      expect(Array.from(hint).length).toBeLessThanOrEqual(256);
    });

    it('reports when the GitHub CLI authentication lookup times out', async () => {
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (
            error: Error & { killed: boolean },
            stdout: string,
          ) => void,
        ) =>
          callback(
            Object.assign(new Error('secret timeout failure'), {
              killed: true,
            }),
            '',
          ),
      );
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: '', useLocalGh: true }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow(
        'authentication lookup for github.com timed out after 10 seconds',
      );
      await expect(channel.connect()).rejects.not.toThrow(
        'secret timeout failure',
      );
    });

    it('treats a killed lookup that also exited as a timeout', async () => {
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (
            error: Error & { code: number; killed: boolean },
            stdout: string,
          ) => void,
        ) =>
          callback(
            Object.assign(new Error('exit 1'), { code: 1, killed: true }),
            '',
          ),
      );
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: '', useLocalGh: true }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow(
        'authentication lookup for github.com timed out after 10 seconds',
      );
    });

    it('reports when GitHub CLI authentication cannot execute', async () => {
      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: NodeJS.ErrnoException, stdout: string) => void,
        ) =>
          callback(
            Object.assign(new Error('secret failure'), { code: 'EACCES' }),
            '',
          ),
      );
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ token: '', useLocalGh: true }),
        makeBridge(),
      );

      await expect(channel.connect()).rejects.toThrow(
        'authentication lookup for github.com failed to execute',
      );
      await expect(channel.connect()).rejects.not.toThrow('secret failure');
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

    it('normalizes per-group allowedUsers to lowercase for the group sender gate', async () => {
      const config = makeConfig({
        groups: { '*': { senders: 'allowlist', allowedUsers: ['Alice'] } },
      });
      channel = new TestableGithubChannel('test-github', config, makeBridge());
      mockOctokit.paginate.mockResolvedValue([]);
      await channel.connect();

      const groupGate = (
        channel as unknown as {
          senderGateFor(target: { isGroup: boolean; chatId: string }): {
            isAllowed: (senderId: string) => boolean;
          };
        }
      ).senderGateFor({ isGroup: true, chatId: 'owner/repo' });
      expect(groupGate.isAllowed('alice')).toBe(true);
      expect(groupGate.isAllowed('bob')).toBe(false);
      expect(config.groups['*']?.allowedUsers).toEqual(['alice']);
      channel.disconnect();
    });

    it('normalizes operators to lowercase for shared-session commands', async () => {
      const config = makeConfig({ operators: ['Alice'] });
      channel = new TestableGithubChannel('test-github', config, makeBridge());
      mockOctokit.paginate.mockResolvedValue([]);
      await channel.connect();

      expect(config.operators).toEqual(['alice']);
      channel.disconnect();
    });

    it('ignores a bot-only private allowlist for repository access', async () => {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({
          privatePolicy: 'allowlist',
          senderPolicy: 'allowlist',
          allowedUsers: ['TEST-BOT'],
        }),
        makeBridge(),
      );
      mockOctokit.paginate.mockResolvedValue([]);
      await expect(channel.connect()).resolves.toBeUndefined();
      channel.disconnect();
    });

    it.each(['*', 'owner/restricted'])(
      'warns about bot-only group %s without blocking another repository',
      async (restrictedGroup) => {
        const config = makeConfig({
          groupPolicy: 'allowlist',
          groups: {
            [restrictedGroup]: {
              senders: 'allowlist',
              allowedUsers: ['TEST-BOT', 'test-bot'],
            },
            'owner/repo': { senders: 'open' },
          },
        });
        channel = new TestableGithubChannel(
          'test-github',
          config,
          makeBridge(),
        );
        mockOctokit.paginate.mockResolvedValue([]);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          await expect(channel.connect()).resolves.toBeUndefined();
          expect(stderr).toHaveBeenCalledWith(
            expect.stringContaining(
              `warning: GitHub group "${restrictedGroup}" allowlist only contains the authenticated GitHub account "test-bot"`,
            ),
          );
          channel.usePreflight = true;
          await channel.handleInbound({
            channelName: 'test-github',
            senderId: 'alice',
            senderName: 'Alice',
            chatId: 'owner/repo',
            text: 'review this',
            isGroup: true,
            isMentioned: true,
            isReplyToBot: false,
          });
          expect(channel.inboundEnvelopes).toHaveLength(1);
        } finally {
          channel.disconnect();
          stderr.mockRestore();
        }
        expect(config.groups[restrictedGroup]?.allowedUsers).toEqual([
          'test-bot',
          'test-bot',
        ]);
      },
    );

    it('warns when the authenticated GitHub account is part of a mixed allowlist', async () => {
      const config = makeConfig({
        groups: {
          '*': { senders: 'allowlist', allowedUsers: ['TEST-BOT', 'operator'] },
        },
      });
      channel = new TestableGithubChannel('test-github', config, makeBridge());
      mockOctokit.paginate.mockResolvedValue([]);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      try {
        await channel.connect();
        expect(stderr).toHaveBeenCalledWith(
          '[Channel:test-github] warning: authenticated GitHub account "test-bot" is allowlisted in group "*" but cannot trigger this channel; use a separate operator account.\n',
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

    it('appends the publication policy', () => {
      const config = makeConfig({
        instructions: 'Respond in Chinese.',
      });
      new TestableGithubChannel('test-github', config, makeBridge());

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

    it('marks notifications as read after accepted work completes', async () => {
      const notification = makeNotification({
        updated_at: '2026-07-02T10:00:00.000Z',
      });
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([notification])
        .mockResolvedValueOnce([makeComment()]);
      let releaseInbound!: () => void;
      channel.handleInboundHook = () =>
        new Promise<void>((resolve) => {
          releaseInbound = resolve;
        });
      const poll = pollOnce();
      await vi.waitFor(() =>
        expect(mockOctokit.paginate).toHaveBeenCalledTimes(2),
      );
      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).not.toHaveBeenCalled();
      releaseInbound();
      await poll;

      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).toHaveBeenCalledWith({
        last_read_at: '2026-07-02T10:00:00.000Z',
        read: true,
      });
      const markOrder =
        mockOctokit.rest.activity.markNotificationsAsRead.mock.invocationCallOrder.at(
          -1,
        )!;
      const commentOrder =
        mockOctokit.paginate.mock.invocationCallOrder.at(-1)!;
      expect(markOrder).toBeGreaterThan(commentOrder);
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

      // initWithoutLoop clears call history; call 1 lists notifications and call 2
      // enumerates comments using the durable cursor lower bound.
      expect(mockOctokit.paginate).toHaveBeenNthCalledWith(
        2,
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
            body: '@test-bot /review check this review note',
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
        text: ' /review check this review note',
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

    it('aggregates ordinary comments and preserves literal slash-prefixed text', async () => {
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
          makeComment({ body: 'ignore this' }),
          makeComment({
            id: 1002,
            node_id: 'C_1002',
            body: '/review inspect this',
            user: { login: 'bob' },
          }),
        ]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.text).toContain(
        '- @bob: /review inspect this',
      );
      expect(channel.cursor.dispatchedComments).toEqual(['C_1001', 'C_1002']);
    });

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

    it('excludes comments outside the group member allowlist when aggregating', async () => {
      await initWithoutLoop({
        privatePolicy: 'disabled',
        groups: { '*': { senders: 'allowlist', allowedUsers: ['alice'] } },
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

    it('aggregates all group members independently of private pairing', async () => {
      await initWithoutLoop({
        privatePolicy: 'pairing',
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
      expect(channel.inboundEnvelopes[0]!.text).toContain(
        '@alice: please take a look',
      );
      expect(channel.inboundEnvelopes[0]!.text).toContain(
        '@bob: unapproved follow-up',
      );
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('dispatches directed follow-ups from an approved paired repo on the aggregate lane', async () => {
      await initWithoutLoop({
        groupPolicy: 'pairing',
        senderPolicy: 'allowlist',
        allowedUsers: [],
      });
      channel.usePreflight = true;
      const store = new PairingStore('test-github', '/tmp/test');
      const created = store.createGroupRequest(
        'owner/repo',
        'owner/repo',
        'alice',
        'Alice',
      );
      if (!('code' in created)) {
        throw new Error(`expected a pairing code, got ${created.rejected}`);
      }
      store.approve(created.code);
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
            body: 'second opinion',
            user: { login: 'bob' },
          }),
        ]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(2);
      expect(channel.inboundEnvelopes[0]).toMatchObject({
        senderId: 'alice',
        text: 'please take a look',
        isMentioned: true,
      });
      expect(channel.inboundEnvelopes[1]).toMatchObject({
        senderId: 'bob',
        text: 'second opinion',
        isMentioned: true,
      });
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('does not feed the issue body after a mentioning comment from an approved paired repo', async () => {
      await initWithoutLoop({
        groupPolicy: 'pairing',
        senderPolicy: 'allowlist',
        allowedUsers: [],
      });
      channel.usePreflight = true;
      const store = new PairingStore('test-github', '/tmp/test');
      const created = store.createGroupRequest(
        'owner/repo',
        'owner/repo',
        'alice',
        'Alice',
      );
      if (!('code' in created)) {
        throw new Error(`expected a pairing code, got ${created.rejected}`);
      }
      store.approve(created.code);
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({ reason: 'mention', last_read_at: null }),
        ])
        .mockResolvedValueOnce([makeComment()]);
      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          title: 'Test Issue',
          body: '@test-bot the issue body mentions the bot too',
          user: { login: 'alice' },
        },
      });

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]).toMatchObject({
        messageId: '1001',
        senderId: 'alice',
      });
      expect(mockOctokit.rest.issues.get).not.toHaveBeenCalled();
    });

    it('posts one pairing comment when a mentioning comment and body arrive together', async () => {
      await initWithoutLoop({
        groupPolicy: 'pairing',
        senderPolicy: 'allowlist',
        allowedUsers: [],
      });
      channel.usePreflight = true;
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({ reason: 'mention', last_read_at: null }),
        ])
        .mockResolvedValueOnce([makeComment()]);
      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          title: 'Test Issue',
          body: '@test-bot the issue body mentions the bot too',
          user: { login: 'alice' },
        },
      });

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('pairing code'),
        }),
      );
    });

    it('does not turn ambient comments into pairing requests under senderPolicy open', async () => {
      await initWithoutLoop({ groupPolicy: 'pairing' });
      channel.usePreflight = true;
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({ body: 'ambient chatter without a mention' }),
        ]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(
        new PairingStore('test-github', '/tmp/test').listPending(),
      ).toEqual([]);
    });

    it('posts one pairing comment when assign and body mention both trigger pairing', async () => {
      await initWithoutLoop({ groupPolicy: 'pairing' });
      channel.usePreflight = true;
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({ reason: 'assign', last_read_at: null }),
        ])
        .mockResolvedValueOnce([
          makeIssueEvent({
            event: 'assigned',
            assigner: { login: 'maintainer' },
            assignee: { login: 'test-bot' },
          }),
        ])
        .mockResolvedValueOnce([]);
      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          title: 'broken build',
          state: 'open',
          user: { login: 'alice' },
          body: '@test-bot please look at this issue',
        },
      });

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('pairing code'),
        }),
      );
      expect(
        new PairingStore('test-github', '/tmp/test').listPending(),
      ).toHaveLength(1);
    });

    it('does not re-feed the body when a re-listed thread already had a pairing effect', async () => {
      await initWithoutLoop({
        groupPolicy: 'pairing',
        senderPolicy: 'allowlist',
        allowedUsers: [],
      });
      channel.usePreflight = true;
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({ reason: 'mention', last_read_at: null }),
        ])
        .mockResolvedValueOnce([makeComment()]);
      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          title: 'Test Issue',
          body: '@test-bot the issue body mentions the bot too',
          user: { login: 'alice' },
        },
      });

      await pollOnce();

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(channel.cursor.dispatchedBodies).toContain('owner/repo|issue:42');

      // Poll 2: marking the thread read failed, so it is listed as unread
      // again. The mentioning comment is now outside the comment window; the
      // body feed must stay suppressed or it would post a second identical
      // pairing-code comment.
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'mention',
            last_read_at: null,
            updated_at: '2026-07-02T11:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.issues.get).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(0);
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

    it('sanitizes crafted comment bodies in the aggregate prompt', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({
            body: 'line one\u202e hidden\u200b\u0007\r\nline two [BUG] kept',
          }),
        ]);

      await pollOnce();

      const text = channel.inboundEnvelopes[0]!.text;
      // eslint-disable-next-line no-control-regex
      const craftedChars = /[\u202a-\u202e\u2066-\u2069\u200b\u0007\r]/;
      expect(text).not.toMatch(craftedChars);
      // Newlines and brackets are display content and must survive.
      expect(text).toContain('line one');
      expect(text).toContain('\nline two [BUG] kept');
    });

    it('truncates aggregated comments on code-point boundaries', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([
          // 399 ASCII + one 2-unit emoji + tail: a UTF-16 slice(0, 400) would
          // land mid-surrogate-pair and leave a lone surrogate behind.
          makeComment({ body: 'a'.repeat(399) + '\ud83c\udf89' + 'tail' }),
        ]);

      await pollOnce();

      const text = channel.inboundEnvelopes[0]!.text;
      expect(text).toContain('a'.repeat(399) + '\ud83c\udf89');
      expect(text).not.toContain('tail');
      expect(text).not.toMatch(
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
      );
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
    const nameHash = createHash('sha256')
      .update('test-github')
      .digest('hex')
      .slice(0, 16);

    function pendingPath(cwd = '/tmp/test'): string {
      return join(
        process.env.QWEN_HOME!,
        'channels',
        getWorkspaceScopeDirName(cwd),
        `test-github-${nameHash}-github-pending-deliveries.json`,
      );
    }

    function auditPath(): string {
      return join(
        process.env.QWEN_HOME!,
        'channels',
        getWorkspaceScopeDirName('/tmp/test'),
        `test-github-${nameHash}-github-audit.jsonl`,
      );
    }

    function stateDir(): string {
      return join(
        process.env.QWEN_HOME!,
        'channels',
        getWorkspaceScopeDirName('/tmp/test'),
      );
    }

    function pendingRecord(overrides: Record<string, unknown> = {}) {
      return {
        id: 'pending',
        createdAt: '2026-07-30T00:00:00.000Z',
        chatId: 'owner/repo',
        threadId: 'issue:42',
        fullText: 'Final reply',
        sessionId: 'session-publication',
        ...overrides,
      };
    }

    function writePending(records: Array<Record<string, unknown>>): void {
      mkdirSync(join(pendingPath(), '..'), { recursive: true });
      writeFileSync(pendingPath(), JSON.stringify(records));
    }

    async function retryPendingForTest(): Promise<void> {
      const privateChannel = channel as unknown as {
        octokit: typeof mockOctokit;
        abortableSleep: (ms: number) => Promise<void>;
        retryPendingFinalDeliveries: () => Promise<void>;
      };
      privateChannel.octokit = mockOctokit as never;
      privateChannel.abortableSleep = vi.fn().mockResolvedValue(undefined);
      await privateChannel.retryPendingFinalDeliveries();
    }

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
      const audit = readFileSync(auditPath(), 'utf-8');
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
      const audit = readFileSync(auditPath(), 'utf-8');
      expect(audit).toContain('"outcome":"posted"');
      expect(audit).toContain('issuecomment-2001');
      expect(audit).toContain(
        createHash('sha256').update(response).digest('hex'),
      );
      expect(audit).not.toContain(response);
      const auditLines = audit.trim().split('\n');
      expect(JSON.parse(auditLines[0]!)).toMatchObject({ outcome: 'posting' });
      const lastAuditLine = auditLines.pop()!;
      expect(JSON.parse(lastAuditLine)).toMatchObject({
        outcome: 'posted',
        repository: 'owner/repo',
        number: 42,
        bodyChars: Array.from(response).length,
      });
    });

    it('attributes the published comment without changing raw audit metadata', async () => {
      mockOctokit.rest.issues.createComment.mockResolvedValue({
        data: { id: 2002, html_url: 'https://example.test/comment/2002' },
      });
      await connectForPublication();
      const response = 'Reviewed the implementation.';
      const publish = (
        channel as unknown as {
          publishFinalResponse: (
            chatId: string,
            threadId: string,
            text: string,
            sessionId: string,
            sourceLabel?: string,
          ) => Promise<void>;
        }
      ).publishFinalResponse.bind(channel);

      await publish(
        'owner/repo',
        'issue:42',
        response,
        'session-publication',
        '[review_*]',
      );

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 42,
        body: '\\[review\\_\\*\\]\nReviewed the implementation.',
      });
      const audits = readFileSync(auditPath(), 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(audits.at(-1)).toMatchObject({
        bodyChars: Array.from(response).length,
        bodySha256: createHash('sha256').update(response).digest('hex'),
      });
      expect(JSON.stringify(audits)).not.toContain('review_');
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
      expect(existsSync(pendingPath())).toBe(false);
      const audit = readFileSync(auditPath(), 'utf-8');
      const lastAuditLine = audit.trim().split('\n').pop()!;
      expect(JSON.parse(lastAuditLine)).toMatchObject({
        outcome: 'failed',
        failurePhase: 'delivery',
        failureError: 'ambiguous transport failure',
      });
    });

    it.each([
      Object.assign(new Error('rate limited'), {
        status: 429,
        response: { headers: { 'x-ratelimit-remaining': '0' } },
      }),
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

    it('deduplicates repeated pending final deliveries', async () => {
      await connectForPublication();
      const error = Object.assign(new Error('rate limited'), {
        status: 429,
        response: { headers: { 'x-ratelimit-remaining': '0' } },
      });
      mockOctokit.rest.issues.createComment.mockRejectedValue(error);
      (
        channel as unknown as {
          abortableSleep: (ms: number) => Promise<void>;
        }
      ).abortableSleep = vi.fn().mockResolvedValue(undefined);
      channel.sourceMessageId = 'source-message';
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
      ).rejects.toThrow('rate limited');
      await expect(
        publish('owner/repo', 'issue:42', 'Final reply', 'session-publication'),
      ).rejects.toThrow('rate limited');

      expect(JSON.parse(readFileSync(pendingPath(), 'utf-8'))).toHaveLength(1);
      // Windows has no POSIX mode bits; stat reports 0o666.
      if (process.platform !== 'win32') {
        expect(statSync(pendingPath()).mode & 0o777).toBe(0o600);
      }
    });

    it('does not collapse same-body pending finals without a source message id', async () => {
      await connectForPublication();
      const error = Object.assign(new Error('rate limited'), {
        status: 429,
        response: { headers: { 'x-ratelimit-remaining': '0' } },
      });
      mockOctokit.rest.issues.createComment.mockRejectedValue(error);
      (
        channel as unknown as {
          abortableSleep: (ms: number) => Promise<void>;
        }
      ).abortableSleep = vi.fn().mockResolvedValue(undefined);
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
      ).rejects.toThrow('rate limited');
      await expect(
        publish('owner/repo', 'issue:42', 'Final reply', 'session-publication'),
      ).rejects.toThrow('rate limited');

      const records = JSON.parse(
        readFileSync(pendingPath(), 'utf-8'),
      ) as Array<{
        id: string;
      }>;
      expect(records).toHaveLength(2);
      expect(new Set(records.map((record) => record.id)).size).toBe(2);
    });

    it('preserves concurrent delivery while recovering a pending final', async () => {
      await connectForPublication();
      const sleep = vi.fn().mockResolvedValue(undefined);
      (
        channel as unknown as {
          abortableSleep: (ms: number) => Promise<void>;
        }
      ).abortableSleep = sleep;
      const error = Object.assign(new Error('rate limited'), {
        status: 429,
        response: { headers: { 'x-ratelimit-remaining': '0' } },
      });
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
      ).rejects.toMatchObject({ message: 'rate limited', cause: error });

      expect(JSON.parse(readFileSync(pendingPath(), 'utf-8'))).toMatchObject([
        {
          chatId: 'owner/repo',
          threadId: 'issue:42',
          fullText: 'Final reply',
          sessionId: 'session-publication',
        },
      ]);

      mockOctokit.rest.issues.createComment.mockReset();
      let resolveRetry!: (value: {
        data: { id: number; html_url: string };
      }) => void;
      mockOctokit.rest.issues.createComment.mockReturnValue(
        new Promise((resolve) => {
          resolveRetry = resolve;
        }),
      );
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig(),
        makeBridge(),
      );
      mockOctokit.paginate.mockResolvedValue([]);
      await channel.connect();

      const current = JSON.parse(readFileSync(pendingPath(), 'utf-8'));
      writeFileSync(
        pendingPath(),
        JSON.stringify([
          ...current,
          {
            id: 'concurrent',
            createdAt: new Date().toISOString(),
            chatId: 'owner/repo',
            threadId: 'issue:43',
            fullText: 'Concurrent reply',
            sessionId: 'session-concurrent',
          },
        ]),
      );
      resolveRetry({
        data: {
          id: 2002,
          html_url: 'https://github.com/owner/repo/issues/42#issuecomment-2002',
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'owner',
          repo: 'repo',
          issue_number: 42,
          body: 'Final reply',
        }),
      );
      expect(JSON.parse(readFileSync(pendingPath(), 'utf-8'))).toMatchObject([
        {
          id: 'concurrent',
          threadId: 'issue:43',
          fullText: 'Concurrent reply',
        },
      ]);

      channel.disconnect();
      mockOctokit.rest.issues.createComment.mockReset();
      let resolveUnreadableRetry!: (value: {
        data: { id: number; html_url: string };
      }) => void;
      mockOctokit.rest.issues.createComment.mockReturnValue(
        new Promise((resolve) => {
          resolveUnreadableRetry = resolve;
        }),
      );
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig(),
        makeBridge(),
      );
      mockOctokit.paginate.mockResolvedValue([]);
      await channel.connect();
      writeFileSync(pendingPath(), '{');
      resolveUnreadableRetry({
        data: {
          id: 2003,
          html_url: 'https://github.com/owner/repo/issues/43#issuecomment-2003',
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(readFileSync(pendingPath(), 'utf-8')).toBe('{');
      channel.disconnect();
    });

    it('keeps a pending final when retry still definitely did not write', async () => {
      writePending([pendingRecord()]);
      mockOctokit.rest.issues.createComment.mockRejectedValue(
        Object.assign(new Error('rate limited'), {
          status: 429,
          response: { headers: { 'x-ratelimit-remaining': '0' } },
        }),
      );

      await retryPendingForTest();

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(3);
      expect(JSON.parse(readFileSync(pendingPath(), 'utf-8'))).toMatchObject([
        { id: 'pending' },
      ]);
    });

    it('drops and audits an ambiguous pending final retry failure', async () => {
      writePending([
        pendingRecord({ triggerKind: 'mention', sourceMessageId: '1001' }),
      ]);
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'reply_pending',
          envelope: undefined,
          source: {
            chatId: 'owner/repo',
            threadId: 'issue:42',
            messageId: '1001',
          },
        }),
      ]);
      mockOctokit.rest.issues.createComment.mockRejectedValue(
        new Error('ambiguous'),
      );

      await retryPendingForTest();

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(existsSync(pendingPath())).toBe(false);
      expect(existsSync(inboundTaskPath())).toBe(false);
      expect(JSON.parse(readFileSync(auditPath(), 'utf-8'))).toMatchObject({
        outcome: 'failed',
        triggerKind: 'mention',
        failurePhase: 'delivery',
        failureError: 'ambiguous',
      });
    });

    it('preserves attribution while ignoring invalid pending retry records', async () => {
      writePending([
        pendingRecord({ sourceLabel: '[review_*]' }),
        { id: 123, bad: true },
      ]);
      mockOctokit.rest.issues.createComment.mockResolvedValue({
        data: {
          id: 2004,
          html_url: 'https://github.com/owner/repo/issues/42#issuecomment-2004',
        },
      });

      await retryPendingForTest();

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 42,
        body: '\\[review\\_\\*\\]\nFinal reply',
      });
    });

    it('continues retrying pending finals when a per-record update fails', async () => {
      writePending([
        pendingRecord({ id: 'first' }),
        pendingRecord({
          id: 'second',
          threadId: 'issue:43',
          fullText: 'Second reply',
        }),
      ]);
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      mockOctokit.rest.issues.createComment
        .mockImplementationOnce(async () => {
          writeFileSync(pendingPath(), '{');
          throw new Error('ambiguous');
        })
        .mockResolvedValueOnce({
          data: {
            id: 2004,
            html_url:
              'https://github.com/owner/repo/issues/43#issuecomment-2004',
          },
        });

      try {
        await retryPendingForTest();
        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining('failed to update pending GitHub deliveries'),
        );
      } finally {
        stderr.mockRestore();
      }

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(2);
      expect(mockOctokit.rest.issues.createComment).toHaveBeenNthCalledWith(2, {
        owner: 'owner',
        repo: 'repo',
        issue_number: 43,
        body: 'Second reply',
      });
      const audit = readFileSync(auditPath(), 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(audit).toEqual([
        expect.objectContaining({
          outcome: 'failed',
          failureError: 'ambiguous',
        }),
        expect.objectContaining({
          outcome: 'posted',
          commentId: 2004,
        }),
      ]);
    });

    it('does not replay an in-flight pending final on reconnect', async () => {
      writePending([pendingRecord()]);
      const retry = Promise.withResolvers<{
        data: { id: number; html_url: string };
      }>();
      mockOctokit.rest.issues.createComment.mockReturnValueOnce(retry.promise);
      mockOctokit.paginate.mockResolvedValue([]);

      await channel.connect();
      channel.disconnect();
      await channel.connect();
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);

      retry.resolve({
        data: {
          id: 2002,
          html_url: 'https://github.com/owner/repo/issues/42#issuecomment-2002',
        },
      });
      const pendingRetry = (
        channel as unknown as {
          pendingFinalDeliveryRetry: Promise<void> | undefined;
        }
      ).pendingFinalDeliveryRetry;
      await pendingRetry;

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(existsSync(pendingPath())).toBe(false);
      channel.disconnect();
    });
    it('stops after an in-flight pending retry finishes during disconnect', async () => {
      writePending([
        pendingRecord(),
        pendingRecord({ id: 'second', threadId: 'issue:43' }),
      ]);
      const retry = Promise.withResolvers<{
        data: { id: number; html_url: string };
      }>();
      mockOctokit.rest.issues.createComment.mockReturnValueOnce(retry.promise);
      mockOctokit.paginate.mockResolvedValue([]);

      await channel.connect();
      channel.disconnect();
      retry.resolve({
        data: {
          id: 2006,
          html_url: 'https://github.com/owner/repo/issues/42#issuecomment-2006',
        },
      });
      const pendingRetry = (
        channel as unknown as {
          pendingFinalDeliveryRetry: Promise<void> | undefined;
        }
      ).pendingFinalDeliveryRetry;
      await pendingRetry;

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(JSON.parse(readFileSync(pendingPath(), 'utf-8'))).toMatchObject([
        { id: 'second', threadId: 'issue:43' },
      ]);
    });

    it('does not burn retry budget when reconnect aborts cooldown', async () => {
      writePending([pendingRecord()]);
      mockOctokit.rest.issues.createComment.mockRejectedValue(
        Object.assign(new Error('rate limited'), {
          status: 429,
          response: {
            headers: {
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': `${Math.ceil(Date.now() / 1000) + 3600}`,
            },
          },
        }),
      );
      mockOctokit.paginate.mockResolvedValue([]);

      await channel.connect();
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      const previousRetry = (
        channel as unknown as {
          pendingFinalDeliveryRetry: Promise<void> | undefined;
        }
      ).pendingFinalDeliveryRetry;
      channel.disconnect();
      await previousRetry;
      await channel.connect();

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(2);
      channel.disconnect();
    });

    it('keeps bare 429 publication failures single-shot', async () => {
      await connectForPublication();
      const error = Object.assign(new Error('secondary rate limit'), {
        status: 429,
      });
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
      ).rejects.toMatchObject({ cause: error });
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(existsSync(pendingPath())).toBe(false);
    });

    it('migrates legacy pending finals before retrying', async () => {
      const legacyPath = join(
        process.env.QWEN_HOME!,
        'channels',
        'test-github-github-pending-deliveries.json',
      );
      const legacyAuditPath = join(
        process.env.QWEN_HOME!,
        'channels',
        'test-github-github-audit.jsonl',
      );
      mkdirSync(join(legacyPath, '..'), { recursive: true });
      writeFileSync(legacyPath, JSON.stringify([pendingRecord()]));
      writeFileSync(legacyAuditPath, '{"outcome":"posted"}\n');
      mockOctokit.rest.issues.createComment.mockResolvedValue({
        data: {
          id: 2007,
          html_url: 'https://github.com/owner/repo/issues/42#issuecomment-2007',
        },
      });
      mockOctokit.paginate.mockResolvedValue([]);

      await channel.connect();
      const pendingRetry = (
        channel as unknown as {
          pendingFinalDeliveryRetry: Promise<void> | undefined;
        }
      ).pendingFinalDeliveryRetry;
      await pendingRetry;

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(existsSync(pendingPath())).toBe(false);
      expect(existsSync(legacyPath)).toBe(false);
      expect(readFileSync(auditPath(), 'utf-8')).toContain(
        '{"outcome":"posted"}\n',
      );
      expect(existsSync(legacyAuditPath)).toBe(false);
      channel.disconnect();
    });

    it('keeps connecting when legacy state migration cannot write', async () => {
      mkdirSync(join(stateDir(), '..'), { recursive: true });
      writeFileSync(stateDir(), '');
      mockOctokit.paginate.mockResolvedValue([]);

      await expect(channel.connect()).resolves.toBeUndefined();
      channel.disconnect();
    });

    it('isolates pending finals by workspace', () => {
      const other = new TestableGithubChannel(
        'test-github',
        makeConfig({ cwd: '/tmp/other-workspace' }),
        makeBridge(),
      );
      const otherPath = (
        other as unknown as { pendingFinalDeliveriesPath: () => string }
      ).pendingFinalDeliveriesPath();

      expect(otherPath).toBe(pendingPath('/tmp/other-workspace'));
      expect(otherPath).not.toBe(pendingPath());
    });

    it('does not treat a same-body posted audit as a different pending retry', async () => {
      writePending([pendingRecord({ id: 'second-pending' })]);
      mkdirSync(join(auditPath(), '..'), { recursive: true });
      writeFileSync(
        auditPath(),
        `${JSON.stringify({
          at: '2026-07-30T00:01:00.000Z',
          type: 'github_publication',
          outcome: 'posted',
          channel: 'test-github',
          repository: 'owner/repo',
          number: 42,
          sessionId: 'session-publication',
          threadId: 'issue:42',
          bodySha256: createHash('sha256').update('Final reply').digest('hex'),
          bodyChars: 'Final reply'.length,
        })}\n`,
      );
      mockOctokit.rest.issues.createComment.mockResolvedValue({
        data: {
          id: 2005,
          html_url: 'https://github.com/owner/repo/issues/42#issuecomment-2005',
        },
      });

      await retryPendingForTest();

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(existsSync(pendingPath())).toBe(false);
    });

    it('skips a pending final already recorded as posted', async () => {
      writePending([pendingRecord()]);
      mkdirSync(join(auditPath(), '..'), { recursive: true });
      writeFileSync(
        auditPath(),
        `{"partial"\n${JSON.stringify({
          at: '2026-07-30T00:01:00.000Z',
          type: 'github_publication',
          outcome: 'posted',
          channel: 'test-github',
          repository: 'owner/repo',
          number: 42,
          sessionId: 'session-publication',
          threadId: 'issue:42',
          pendingId: 'pending',
          bodySha256: createHash('sha256').update('Final reply').digest('hex'),
          bodyChars: 'Final reply'.length,
        })}\n`,
      );

      await retryPendingForTest();

      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(existsSync(pendingPath())).toBe(false);
    });

    it('distinguishes pre-delivery validation from ambiguous failures', async () => {
      await connectForPublication();
      mockOctokit.rest.issues.createComment.mockRejectedValue(
        new Error('ambiguous transport failure'),
      );
      (
        channel as unknown as {
          abortableSleep: (ms: number) => Promise<void>;
        }
      ).abortableSleep = vi.fn().mockResolvedValue(undefined);
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

      const audit = readFileSync(auditPath(), 'utf-8');
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
      mkdirSync(auditPath(), { recursive: true });

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
        makeConfig({
          groups: { '*': { senders: 'allowlist', allowedUsers: ['bob'] } },
        }),
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
    it('attributes the error comment when a named inbound turn fails', async () => {
      channel.handleInboundError = new Error('agent down');
      channel.inboundErrorSourceLabel = '[review_*]';
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: '\\[review\\_\\*\\]\n⚠️ Failed to process this request. Please re-mention the bot to retry.',
        }),
      );
    });

    it('keeps a failed inbound task recoverable and leaves the notification unread', async () => {
      channel.handleInboundError = new Error('agent down');
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).not.toHaveBeenCalled();
      expect(channel.cursor.lastProcessedAt).toBe('2026-07-01T00:00:00.000Z');
      expect(channel.cursor.dispatchedComments).toEqual(['C_1001']);
      expect(readInboundTasks()).toEqual([
        expect.objectContaining({
          state: 'failed',
          issueNumber: 42,
          envelope: expect.objectContaining({ messageId: '1001' }),
          dedupe: { dispatchedComments: ['C_1001'] },
          error: 'agent down',
        }),
      ]);
    });

    it('bounds failed task recovery and avoids duplicate error comments', async () => {
      channel.handleInboundError = new Error('agent down');
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();
      mockOctokit.paginate.mockResolvedValue([]);
      await pollOnce();
      await pollOnce();

      expect(readInboundTasks()).toEqual([
        expect.objectContaining({
          state: 'failed',
          attempts: 3,
          errorCommentPosted: true,
        }),
      ]);
      expect(
        mockOctokit.rest.issues.createComment.mock.calls.filter((call) =>
          String(call[0]?.body).includes('Failed to process'),
        ),
      ).toHaveLength(1);
      expect(channel.cursor.lastProcessedAt).toBe('2026-07-02T10:00:00.000Z');
      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).toHaveBeenCalledWith({
        last_read_at: '2026-07-02T10:00:00.000Z',
        read: true,
      });
    });

    it('retries the error comment when the first post fails', async () => {
      channel.handleInboundError = new Error('agent down');
      await initWithoutLoop();
      (
        channel as unknown as {
          abortableSleep: (ms: number) => Promise<void>;
        }
      ).abortableSleep = vi.fn().mockResolvedValue(undefined);
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment()]);
      mockOctokit.rest.issues.createComment.mockRejectedValue(
        new Error('comment creation outage'),
      );

      await pollOnce();

      expect(readInboundTasks()).toEqual([
        expect.objectContaining({
          state: 'failed',
          attempts: 1,
          errorCommentPosted: false,
        }),
      ]);

      mockOctokit.rest.issues.createComment.mockResolvedValue({ data: {} });
      mockOctokit.paginate.mockResolvedValue([]);
      await pollOnce();

      expect(readInboundTasks()).toEqual([
        expect.objectContaining({
          state: 'failed',
          attempts: 2,
          errorCommentPosted: true,
        }),
      ]);
      expect(
        mockOctokit.rest.issues.createComment.mock.calls.filter((call) =>
          String(call[0]?.body).includes('Failed to process'),
        ),
      ).toHaveLength(4);
    });

    it('reuses an existing inbound task record instead of creating a duplicate', async () => {
      await initWithoutLoop();
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'failed',
          attempts: 2,
          errorCommentPosted: true,
        }),
      ]);
      channel.handleInboundError = new Error('agent down');
      const privateChannel = channel as unknown as {
        dispatchEnvelope: (
          envelope: Record<string, unknown>,
          issueNumber: number,
          dedupe: Record<string, unknown>,
        ) => Promise<boolean>;
      };

      await privateChannel.dispatchEnvelope(
        {
          channelName: 'test-github',
          senderId: 'alice',
          senderName: 'alice',
          chatId: 'owner/repo',
          threadId: 'issue:42',
          messageId: '1001',
          text: 'please fix this',
          isGroup: true,
          isMentioned: true,
          isReplyToBot: false,
          metadata: 'Trigger: mention.',
        },
        42,
        { dispatchedComments: ['C_1001'] },
      );

      const tasks = readInboundTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        id: 'inbound-task-1',
        state: 'failed',
        attempts: 3,
        errorCommentPosted: true,
      });
      expect(
        mockOctokit.rest.issues.createComment.mock.calls.filter((call) =>
          String(call[0]?.body).includes('Failed to process'),
        ),
      ).toHaveLength(0);
    });

    it('blocks cursor commit when inbound task state is invalid', async () => {
      await initWithoutLoop();
      writeInboundTasks([
        makeInboundTaskRecord({
          dedupe: { dispatchedComments: 'C_1001' },
        }),
      ]);
      const privateChannel = channel as unknown as {
        inboundRecoveryPending: boolean;
      };
      privateChannel.inboundRecoveryPending = true;
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            updated_at: '2026-07-02T10:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([]);

      await pollOnce();

      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).not.toHaveBeenCalled();
      expect(channel.cursor.lastProcessedAt).toBe('2026-07-01T00:00:00.000Z');
    });

    it('blocks cursor commit when a persisted envelope has a non-array mentionedMemberIds', async () => {
      await initWithoutLoop();
      const task = makeInboundTaskRecord();
      writeInboundTasks([
        {
          ...task,
          envelope: { ...task.envelope, mentionedMemberIds: 'not-an-array' },
        },
      ]);
      const privateChannel = channel as unknown as {
        inboundRecoveryPending: boolean;
      };
      privateChannel.inboundRecoveryPending = true;
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            updated_at: '2026-07-02T10:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([]);

      await pollOnce();

      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).not.toHaveBeenCalled();
      expect(channel.cursor.lastProcessedAt).toBe('2026-07-01T00:00:00.000Z');
    });

    it('recovers an envelope carrying a valid mentionedMemberIds array', async () => {
      await initWithoutLoop();
      const task = makeInboundTaskRecord();
      writeInboundTasks([
        {
          ...task,
          envelope: { ...task.envelope, mentionedMemberIds: ['member-x'] },
        },
      ]);
      const privateChannel = channel as unknown as {
        inboundRecoveryPending: boolean;
      };
      privateChannel.inboundRecoveryPending = true;
      mockOctokit.paginate.mockResolvedValue([]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.mentionedMemberIds).toEqual([
        'member-x',
      ]);
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('persists cancellation as a terminal task state', async () => {
      await initWithoutLoop();
      writeInboundTasks([makeInboundTaskRecord({ state: 'running' })]);
      const privateChannel = channel as unknown as {
        activeInboundTaskIdsByMessage: Map<string, string>;
      };
      privateChannel.activeInboundTaskIdsByMessage.set(
        'owner/repo|1001',
        'inbound-task-1',
      );

      channel.triggerTaskLifecycleForTest({
        type: 'cancelled',
        chatId: 'owner/repo',
        messageId: '1001',
      });

      expect(readInboundTasks()).toEqual([
        expect.objectContaining({ state: 'cancelled' }),
      ]);
    });

    it('does not turn cancellation into a retryable failure', async () => {
      await initWithoutLoop();
      const task = makeInboundTaskRecord();
      writeInboundTasks([task]);
      channel.handleInboundHook = async () => {
        channel.triggerTaskLifecycleForTest({
          type: 'cancelled',
          chatId: 'owner/repo',
          messageId: '1001',
        });
        throw new Error('cancelled');
      };
      const privateChannel = channel as unknown as {
        runInboundTask: (task: typeof task) => Promise<boolean>;
      };

      await privateChannel.runInboundTask(task);

      expect(readInboundTasks()).toEqual([
        expect.objectContaining({ state: 'cancelled' }),
      ]);
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining('Failed') }),
      );
    });

    it('does not transition a cancelled task to reply_pending on FinalPublicationError', async () => {
      await initWithoutLoop();
      const task = makeInboundTaskRecord();
      writeInboundTasks([task]);
      const rateLimitError = Object.assign(new Error('rate limited'), {
        status: 429,
        response: { headers: { 'x-ratelimit-remaining': '0' } },
      });
      mockOctokit.rest.issues.createComment.mockRejectedValue(rateLimitError);
      channel.handleInboundHook = async (envelope) => {
        channel.triggerTaskLifecycleForTest({
          type: 'cancelled',
          chatId: 'owner/repo',
          messageId: '1001',
        });
        await (
          channel as unknown as {
            publishFinalResponse: (
              chatId: string,
              threadId: string,
              text: string,
              sessionId: string,
            ) => Promise<void>;
          }
        ).publishFinalResponse(
          envelope.chatId,
          envelope.threadId!,
          'cancelled response',
          'session-1',
        );
      };
      channel.sourceMessageId = '1001';
      channel.sourceSenderId = 'alice';
      channel.sourceMetadata = 'Trigger: mention.';
      const privateChannel = channel as unknown as {
        octokit: typeof mockOctokit;
        abortableSleep: (ms: number) => Promise<void>;
        runInboundTask: (task: Record<string, unknown>) => Promise<boolean>;
      };
      privateChannel.octokit = mockOctokit as never;
      privateChannel.abortableSleep = vi.fn().mockResolvedValue(undefined);

      await privateChannel.runInboundTask(task);

      expect(readInboundTasks()).toEqual([
        expect.objectContaining({ state: 'cancelled' }),
      ]);
    });

    it('continues polling after inbound recovery failure', async () => {
      await initWithoutLoop();
      writeInboundTasks([makeInboundTaskRecord({ state: 'running' })]);
      const pendingPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-pending-deliveries.json',
      );
      mkdirSync(pendingPath, { recursive: true });
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(channel.inboundEnvelopes.map((env) => env.messageId)).toEqual([
        '1001',
      ]);
    });

    it('keeps the cancelled record when cancellation resolves normally', async () => {
      await initWithoutLoop();
      const task = makeInboundTaskRecord();
      writeInboundTasks([task]);
      channel.handleInboundHook = async () => {
        channel.triggerTaskLifecycleForTest({
          type: 'cancelled',
          chatId: 'owner/repo',
          messageId: '1001',
        });
      };
      const privateChannel = channel as unknown as {
        runInboundTask: (task: typeof task) => Promise<boolean>;
      };

      await privateChannel.runInboundTask(task);

      expect(readInboundTasks()).toEqual([
        expect.objectContaining({ state: 'cancelled' }),
      ]);
    });

    it('fails closed when post-success bookkeeping cannot read state', async () => {
      await initWithoutLoop();
      const task = makeInboundTaskRecord();
      writeInboundTasks([task]);
      const pendingPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-pending-deliveries.json',
      );
      writeFileSync(pendingPath, '{not valid json', 'utf-8');
      const privateChannel = channel as unknown as {
        runInboundTask: (task: typeof task) => Promise<boolean>;
      };

      await expect(privateChannel.runInboundTask(task)).rejects.toThrow();

      expect(readInboundTasks()).toEqual([
        expect.objectContaining({ state: 'running' }),
      ]);
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining('Failed') }),
      );
    });

    it('recovers an accepted task before polling and removes it after success', async () => {
      writeInboundTasks([makeInboundTaskRecord()]);
      channel.handleInboundHook = async () => {
        expect(readInboundTasks()).toEqual([
          expect.objectContaining({ state: 'running' }),
        ]);
      };
      mockOctokit.paginate.mockResolvedValue([]);

      await channel.connect();
      await vi.waitFor(() => {
        expect(channel.inboundEnvelopes.map((item) => item.messageId)).toEqual([
          '1001',
        ]);
      });
      channel.disconnect();

      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('commits the recovered notification window after restart', async () => {
      writeInboundTasks([makeInboundTaskRecord()]);
      channel.cursor = { lastProcessedAt: '2026-07-01T00:00:00.000Z' };
      mockOctokit.paginate.mockResolvedValueOnce([
        makeNotification({
          last_read_at: '2026-07-02T09:00:00.000Z',
          updated_at: '2026-07-02T10:00:00.000Z',
        }),
      ]);

      const privateChannel = channel as unknown as {
        octokit: typeof mockOctokit;
        pollOnce: () => Promise<void>;
      };
      privateChannel.octokit = mockOctokit as never;
      await privateChannel.pollOnce();

      expect(existsSync(inboundTaskPath())).toBe(false);
      expect(channel.cursor.lastProcessedAt).toBe('2026-07-02T10:00:00.000Z');
      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).toHaveBeenCalledWith({
        last_read_at: '2026-07-02T10:00:00.000Z',
        read: true,
      });
    });

    it('does not re-run a task whose reply was posted before a crash', async () => {
      writeInboundTasks([makeInboundTaskRecord({ state: 'running' })]);
      const auditFilePath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-audit.jsonl',
      );
      mkdirSync(join(auditFilePath, '..'), { recursive: true });
      writeFileSync(
        auditFilePath,
        `${JSON.stringify({
          at: '2026-07-02T10:00:00.000Z',
          type: 'github_publication',
          outcome: 'posting',
          channel: 'test-github',
          repository: 'owner/repo',
          number: 42,
          sessionId: 'session-1',
          threadId: 'issue:42',
          sourceMessageId: '1001',
          bodySha256: 'abc',
          bodyChars: 5,
        })}\n`,
      );
      channel.cursor = { lastProcessedAt: '2026-07-01T00:00:00.000Z' };
      mockOctokit.paginate.mockResolvedValueOnce([]);

      const privateChannel = channel as unknown as {
        octokit: typeof mockOctokit;
        pollOnce: () => Promise<void>;
      };
      privateChannel.octokit = mockOctokit as never;
      await privateChannel.pollOnce();

      expect(existsSync(inboundTaskPath())).toBe(false);
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('restores persisted dedupe before polling after recovery', async () => {
      writeInboundTasks([makeInboundTaskRecord()]);
      channel.cursor = { lastProcessedAt: '2026-07-01T00:00:00.000Z' };
      (channel as unknown as { botUsername: string }).botUsername = 'test-bot';
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            last_read_at: '2026-07-02T09:00:00.000Z',
            updated_at: '2026-07-02T10:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([makeComment()]);

      const privateChannel = channel as unknown as {
        octokit: typeof mockOctokit;
        pollOnce: () => Promise<void>;
      };
      privateChannel.octokit = mockOctokit as never;
      await privateChannel.pollOnce();

      expect(channel.inboundEnvelopes.map((item) => item.messageId)).toEqual([
        '1001',
      ]);
    });

    it('keeps the inbound envelope recoverable when pending delivery persistence fails', async () => {
      writeInboundTasks([makeInboundTaskRecord({ state: 'running' })]);
      const pendingPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-pending-deliveries.json',
      );
      mkdirSync(pendingPath, { recursive: true });
      const error = Object.assign(new Error('rate limited'), {
        status: 429,
        response: { headers: { 'x-ratelimit-remaining': '0' } },
      });
      mockOctokit.rest.issues.createComment.mockRejectedValue(error);
      const privateChannel = channel as unknown as {
        octokit: typeof mockOctokit;
        abortableSleep: (ms: number) => Promise<void>;
        runInboundTask: (task: Record<string, unknown>) => Promise<boolean>;
      };
      privateChannel.octokit = mockOctokit as never;
      channel.sourceMessageId = '1001';
      channel.sourceSenderId = 'alice';
      channel.sourceMetadata = 'Trigger: mention.';

      vi.spyOn(
        channel as unknown as {
          postErrorComment: (
            chatId: string,
            issueNumber: number,
          ) => Promise<boolean>;
        },
        'postErrorComment',
      ).mockResolvedValue(true);
      privateChannel.abortableSleep = vi.fn().mockResolvedValue(undefined);
      channel.handleInboundHook = async (envelope) => {
        await (
          channel as unknown as {
            publishFinalResponse: (
              chatId: string,
              threadId: string,
              text: string,
              sessionId: string,
            ) => Promise<void>;
          }
        ).publishFinalResponse(
          envelope.chatId,
          envelope.threadId!,
          'completed response',
          'session-1',
        );
      };

      await privateChannel.runInboundTask(
        makeInboundTaskRecord({ state: 'running' }),
      );

      const [persistedTask] = readInboundTasks();
      expect(persistedTask).toMatchObject({
        state: 'failed',
        envelope: { messageId: '1001' },
      });
      expect(String(persistedTask?.error)).toContain(
        'failed to persist pending GitHub delivery',
      );
    });

    it('does not rerun recovered work when delivery evidence is unreadable', async () => {
      writeInboundTasks([makeInboundTaskRecord({ state: 'running' })]);
      const pendingPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-pending-deliveries.json',
      );
      mkdirSync(pendingPath, { recursive: true });
      const privateChannel = channel as unknown as {
        octokit: typeof mockOctokit;
        pollOnce: () => Promise<void>;
      };
      privateChannel.octokit = mockOctokit as never;

      mockOctokit.paginate.mockResolvedValueOnce([]);
      await privateChannel.pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(readInboundTasks()).toEqual([
        expect.objectContaining({ state: 'running' }),
      ]);
    });

    it('does not rerun recovered work when publication audit is unreadable', async () => {
      writeInboundTasks([makeInboundTaskRecord({ state: 'running' })]);
      const auditPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-audit.jsonl',
      );
      mkdirSync(auditPath, { recursive: true });
      const privateChannel = channel as unknown as {
        octokit: typeof mockOctokit;
        pollOnce: () => Promise<void>;
      };
      privateChannel.octokit = mockOctokit as never;

      mockOctokit.paginate.mockResolvedValueOnce([]);
      await privateChannel.pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(readInboundTasks()).toEqual([
        expect.objectContaining({ state: 'running' }),
      ]);
    });

    it('removes a recovered task whose reply already has a posted audit record', async () => {
      writeInboundTasks([makeInboundTaskRecord({ state: 'running' })]);
      const auditPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-audit.jsonl',
      );
      mkdirSync(join(auditPath, '..'), { recursive: true });
      writeFileSync(
        auditPath,
        `${JSON.stringify({
          outcome: 'posted',
          repository: 'owner/repo',
          threadId: 'issue:42',
          sourceMessageId: '1001',
        })}\n`,
        'utf-8',
      );
      const privateChannel = channel as unknown as {
        octokit: typeof mockOctokit;
        pollOnce: () => Promise<void>;
      };
      privateChannel.octokit = mockOctokit as never;
      mockOctokit.paginate.mockResolvedValueOnce([]);

      await privateChannel.pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('removes a recovered task whose reply has a suppressed audit record', async () => {
      writeInboundTasks([makeInboundTaskRecord({ state: 'running' })]);
      const auditPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-audit.jsonl',
      );
      mkdirSync(join(auditPath, '..'), { recursive: true });
      writeFileSync(
        auditPath,
        `${JSON.stringify({
          outcome: 'suppressed',
          repository: 'owner/repo',
          threadId: 'issue:42',
          sourceMessageId: '1001',
        })}\n`,
        'utf-8',
      );
      const privateChannel = channel as unknown as {
        octokit: typeof mockOctokit;
        pollOnce: () => Promise<void>;
      };
      privateChannel.octokit = mockOctokit as never;
      mockOctokit.paginate.mockResolvedValueOnce([]);

      await privateChannel.pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('re-runs a task whose audit record is failed, not delivered', async () => {
      writeInboundTasks([makeInboundTaskRecord({ state: 'running' })]);
      const auditPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-audit.jsonl',
      );
      mkdirSync(join(auditPath, '..'), { recursive: true });
      writeFileSync(
        auditPath,
        `${JSON.stringify({
          outcome: 'failed',
          repository: 'owner/repo',
          threadId: 'issue:42',
          sourceMessageId: '1001',
        })}\n`,
        'utf-8',
      );
      const privateChannel = channel as unknown as {
        octokit: typeof mockOctokit;
        pollOnce: () => Promise<void>;
      };
      privateChannel.octokit = mockOctokit as never;
      mockOctokit.paginate.mockResolvedValueOnce([]);

      await privateChannel.pollOnce();

      expect(channel.inboundEnvelopes.map((env) => env.messageId)).toEqual([
        '1001',
      ]);
    });

    it('re-runs a task when the audit sourceMessageId does not match', async () => {
      writeInboundTasks([makeInboundTaskRecord({ state: 'running' })]);
      const auditPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-audit.jsonl',
      );
      mkdirSync(join(auditPath, '..'), { recursive: true });
      writeFileSync(
        auditPath,
        `${JSON.stringify({
          outcome: 'posted',
          repository: 'owner/repo',
          threadId: 'issue:42',
          sourceMessageId: '9999',
        })}\n`,
        'utf-8',
      );
      const privateChannel = channel as unknown as {
        octokit: typeof mockOctokit;
        pollOnce: () => Promise<void>;
      };
      privateChannel.octokit = mockOctokit as never;
      mockOctokit.paginate.mockResolvedValueOnce([]);

      await privateChannel.pollOnce();

      expect(channel.inboundEnvelopes.map((env) => env.messageId)).toEqual([
        '1001',
      ]);
    });

    it('removes a reply-pending task when a posted pending delivery is reconciled', async () => {
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'reply_pending',
          envelope: undefined,
        }),
      ]);
      const pendingPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-pending-deliveries.json',
      );
      const auditPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-audit.jsonl',
      );
      const pending = {
        id: 'pending-1',
        createdAt: '2026-07-02T10:01:00.000Z',
        chatId: 'owner/repo',
        threadId: 'issue:42',
        fullText: 'completed response',
        sessionId: 'session-1',
        sourceMessageId: '1001',
      };
      writeFileSync(pendingPath, `${JSON.stringify([pending])}\n`, 'utf-8');
      writeFileSync(
        auditPath,
        `${JSON.stringify({ outcome: 'posted', pendingId: pending.id })}\n`,
        'utf-8',
      );
      const privateChannel = channel as unknown as {
        octokit: typeof mockOctokit;
        retryPendingFinalDeliveries: () => Promise<void>;
      };
      privateChannel.octokit = mockOctokit as never;

      await privateChannel.retryPendingFinalDeliveries();

      expect(existsSync(pendingPath)).toBe(false);
      expect(existsSync(inboundTaskPath())).toBe(false);
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('does not rerun a task whose final reply is already pending delivery', async () => {
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'running',
          sessionId: 'session-1',
          runId: 'run-1',
        }),
      ]);
      const pendingPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-pending-deliveries.json',
      );
      writeFileSync(
        pendingPath,
        `${JSON.stringify([
          {
            id: 'pending-1',
            createdAt: '2026-07-02T10:01:00.000Z',
            chatId: 'owner/repo',
            threadId: 'issue:42',
            fullText: 'completed response',
            sessionId: 'session-1',
            sourceMessageId: '1001',
            actor: 'alice',
            triggerKind: 'mention',
          },
        ])}\n`,
        'utf-8',
      );
      const privateChannel = channel as unknown as {
        octokit: typeof mockOctokit;
        retryPendingFinalDeliveries: () => Promise<void>;
        pollOnce: () => Promise<void>;
      };
      privateChannel.octokit = mockOctokit as never;
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await privateChannel.pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(readInboundTasks()).toEqual([
        expect.objectContaining({ state: 'reply_pending' }),
      ]);

      await privateChannel.retryPendingFinalDeliveries();

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'completed response' }),
      );

      expect(existsSync(inboundTaskPath())).toBe(false);
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
      expect(channel.cursor.dispatchedComments).toEqual([
        'C_1001',
        'C_1002',
        'C_1003',
      ]);
      expect(readInboundTasks()).toEqual([
        expect.objectContaining({
          state: 'failed',
          envelope: expect.objectContaining({ messageId: '1002' }),
        }),
      ]);
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

    it('allows explicit local gh authentication without a configured token', async () => {
      const { plugin } = await import('./index.js');
      const tokenField = plugin.management?.fields.find(
        (field) => field.key === 'token',
      );
      const localGhField = plugin.management?.fields.find(
        (field) => field.key === 'useLocalGh',
      );
      expect(plugin.requiredConfigFields).toBeUndefined();
      expect(tokenField).toMatchObject({ kind: 'secret' });
      expect(tokenField).not.toHaveProperty('required');
      expect(localGhField).toMatchObject({ kind: 'boolean' });
    });

    it.each([
      { label: 'no credential fields', config: {} },
      { label: 'explicit opt-out', config: { useLocalGh: false } },
      { label: 'blank token', config: { token: '   ' } },
      {
        label: 'cleared token with opt-out',
        config: { token: '', useLocalGh: false },
      },
    ])('rejects a managed config with $label', async ({ config }) => {
      const { plugin } = await import('./index.js');
      expect(plugin.management?.validateConfig?.(config)).toBe(
        'Channel requires a token or local GitHub CLI authentication (useLocalGh).',
      );
    });

    it.each([
      { label: 'literal token', config: { token: 'ghp_token' } },
      {
        label: 'environment reference token',
        config: { token: '$GITHUB_TOKEN' },
      },
      { label: 'local gh opt-in', config: { useLocalGh: true } },
      {
        label: 'token and local gh opt-in',
        config: { token: 'ghp_token', useLocalGh: true },
      },
    ])('accepts a managed config with $label', async ({ config }) => {
      const { plugin } = await import('./index.js');
      expect(plugin.management?.validateConfig?.(config)).toBeUndefined();
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

describe('GithubChannel bound-session delivery and PR state watch', () => {
  // Tests drive pollOnce explicitly; connect()'s immediate background poll
  // would race the per-test mock queues, so the loop is disabled here.
  class BoundTestChannel extends TestableGithubChannel {
    protected override startPollLoop(): void {}
  }

  let channel: TestableGithubChannel;
  let boundSessions: {
    listPrBindings: Mock;
    deliverPrompt: Mock;
  };
  let savedQwenHome: string | undefined;

  function makeBinding(
    overrides: Partial<PrBindingSummary> = {},
  ): PrBindingSummary {
    return {
      sessionId: 'bound-session',
      workspaceCwd: '/tmp/test',
      updatedAt: '2026-07-02T00:00:00.000Z',
      prs: [
        {
          number: 42,
          url: 'https://github.com/owner/repo/pull/42',
          state: 'open',
        },
      ],
      ...overrides,
    };
  }

  function makePrMeta(overrides: Record<string, unknown> = {}) {
    return {
      title: 'Test PR',
      state: 'open',
      merged: false,
      mergeable: true,
      mergeable_state: 'clean',
      head: { sha: 'sha-1' },
      updated_at: '2026-07-02T09:00:00.000Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    savedQwenHome = process.env.QWEN_HOME;
    process.env.QWEN_HOME = mkdtempSync(join(tmpdir(), 'qwen-gh-bound-'));
    vi.clearAllMocks();
    boundSessions = {
      listPrBindings: vi.fn().mockResolvedValue({
        bindings: [makeBinding()],
        partial: false,
      }),
      deliverPrompt: vi.fn().mockResolvedValue(undefined),
    };
    mockOctokit.rest.users.getAuthenticated.mockResolvedValue({
      data: { id: 99999, login: 'test-bot' },
    });
    mockOctokit.rest.activity.markNotificationsAsRead.mockResolvedValue({});
    mockOctokit.rest.issues.createComment.mockResolvedValue({});
    mockOctokit.rest.repos.getCombinedStatusForRef.mockResolvedValue({
      data: { state: 'success', total_count: 0 },
    });
  });

  afterEach(() => {
    channel?.disconnect();
    rmSync(process.env.QWEN_HOME!, { recursive: true, force: true });
    if (savedQwenHome === undefined) delete process.env.QWEN_HOME;
    else process.env.QWEN_HOME = savedQwenHome;
  });

  async function initChannel(
    configOverrides: Record<string, unknown>,
    options?: { boundSessions?: ChannelBoundSessions },
  ): Promise<void> {
    channel = new BoundTestChannel(
      'test-github',
      makeConfig(configOverrides),
      makeBridge(),
      options,
    );
    // No paginate priming here: BoundTestChannel disables the poll loop, so
    // connect() never polls and a leftover once-value would leak into the
    // test's first explicit poll.
    await channel.connect();
    channel.disconnect();
    (channel as unknown as { cursor: { lastProcessedAt: string } }).cursor = {
      lastProcessedAt: '2026-07-01T00:00:00.000Z',
    };
    vi.clearAllMocks();
    boundSessions.listPrBindings.mockResolvedValue({
      bindings: [makeBinding()],
      partial: false,
    });
    mockOctokit.rest.activity.markNotificationsAsRead.mockResolvedValue({});
    mockOctokit.rest.issues.createComment.mockResolvedValue({});
    mockOctokit.rest.repos.getCombinedStatusForRef.mockResolvedValue({
      data: { state: 'success', total_count: 0 },
    });
  }

  async function pollOnce(): Promise<void> {
    await (channel as unknown as { pollOnce: () => Promise<void> }).pollOnce();
  }

  function prNotification(reason = 'mention') {
    return makeNotification({
      reason,
      subject: {
        title: 'Test PR',
        url: 'https://api.github.com/repos/owner/repo/pulls/42',
        type: 'PullRequest',
      },
    });
  }

  describe('bound-session delivery', () => {
    it('delivers a comment event into the bound session, not the channel path', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      const [sessionId, prompt] = boundSessions.deliverPrompt.mock.calls[0] as [
        string,
        string,
      ];
      expect(sessionId).toBe('bound-session');
      expect(prompt).toContain('please fix this');
      expect(prompt).toContain('untrusted event data');
      expect(prompt).toContain('https://github.com/owner/repo/pull/42');
      expect(prompt).not.toContain('published verbatim');
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('strips the aggregate no-reply instruction for bound delivery', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([
          makeComment({ body: 'ambient remark without mention' }),
        ]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      const prompt = boundSessions.deliverPrompt.mock.calls[0]![1] as string;
      expect(prompt).toContain('ambient remark without mention');
      expect(prompt).toContain('New comments on the PR');
      expect(prompt).toContain('Trigger: comment');
      expect(prompt).not.toContain('<no-reply/>');
      expect(prompt).not.toContain('published verbatim');
    });

    it('applies the sender gate before bound delivery', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          groups: { '*': { senders: 'allowlist', allowedUsers: ['alice'] } },
        },
        { boundSessions },
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment({ user: { login: 'mallory' } })]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('applies the group policy before bound delivery', async () => {
      await initChannel(
        { deliverToBoundSessions: true, groupPolicy: 'disabled' },
        { boundSessions },
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('matches binding URLs case-insensitively', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            prs: [
              {
                number: 42,
                url: 'https://github.com/OWNER/Repo/pull/42',
                state: 'open',
              },
            ],
          }),
        ],
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('accepts binding URLs with trailing tab segments', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            prs: [
              {
                number: 42,
                url: 'https://github.com/owner/repo/pull/42/files',
                state: 'open',
              },
            ],
          }),
        ],
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
    });

    it('rebinds to a different following session when the first is gone', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.deliverPrompt.mockRejectedValueOnce(
        new BoundSessionGoneError('bound-session'),
      );
      boundSessions.listPrBindings
        .mockResolvedValueOnce({ bindings: [makeBinding()], partial: false })
        .mockResolvedValueOnce({
          bindings: [makeBinding({ sessionId: 'session-b' })],
          partial: false,
        });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      expect(boundSessions.deliverPrompt).toHaveBeenLastCalledWith(
        'session-b',
        expect.any(String),
      );
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('does not consume the retry budget on a full queue', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.deliverPrompt.mockRejectedValue(
        new BoundSessionQueueFullError('bound-session'),
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      // Three more polls recover and retry the same task; backpressure must
      // not exhaust MAX_INBOUND_TASK_ATTEMPTS and silently drop the event.
      for (let i = 0; i < 3; i++) {
        mockOctokit.paginate.mockResolvedValueOnce([]);
        await pollOnce();
      }

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(4);
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      const tasks = readInboundTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!['state']).toBe('failed');
      expect(tasks[0]!['attempts']).toBe(0);
    });

    it('keeps the previous binding map when a refresh fails', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);

      boundSessions.listPrBindings.mockRejectedValueOnce(
        new Error('daemon busy'),
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'mention',
            updated_at: '2026-07-02T11:00:00.000Z',
            subject: {
              title: 'Test PR',
              url: 'https://api.github.com/repos/owner/repo/pulls/42',
              type: 'PullRequest',
            },
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({
            id: 1002,
            node_id: 'C_1002',
            created_at: '2026-07-02T10:30:00.000Z',
          }),
        ]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('keeps the channel path when no binding matches the PR', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(1);
    });

    it('excludes channel-owned sessions from delivery candidates', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({ sourceType: 'channel', sourceId: 'test-github' }),
        ],
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(1);
    });

    it('ignores bindings whose URL is on another host', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            prs: [
              {
                number: 42,
                url: 'https://ghe.other.com/owner/repo/pull/42',
                state: 'open',
              },
            ],
          }),
        ],
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(1);
    });

    it('picks the most recently updated session for the same PR', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            sessionId: 'older-session',
            updatedAt: '2026-07-01T00:00:00.000Z',
          }),
          makeBinding({
            sessionId: 'newer-session',
            updatedAt: '2026-07-03T00:00:00.000Z',
          }),
        ],
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledWith(
        'newer-session',
        expect.any(String),
      );
    });

    it('falls back to the channel path when the bound session is gone', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.deliverPrompt.mockRejectedValueOnce(
        new BoundSessionGoneError('bound-session'),
      );
      boundSessions.listPrBindings
        .mockResolvedValueOnce({ bindings: [makeBinding()], partial: false })
        .mockResolvedValueOnce({ bindings: [], partial: false });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('restores channel error semantics after a gone-session fallback fails', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.deliverPrompt.mockRejectedValueOnce(
        new BoundSessionGoneError('bound-session'),
      );
      boundSessions.listPrBindings
        .mockResolvedValueOnce({ bindings: [makeBinding()], partial: false })
        .mockResolvedValueOnce({ bindings: [], partial: false });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      // The fallback re-enters the channel path; a failure there is a
      // CHANNEL failure: public error comment and channel retry semantics,
      // not the bound path's private dead-letter.
      const inbound = vi
        .spyOn(channel, 'handleInbound')
        .mockRejectedValueOnce(new Error('channel down'));

      await pollOnce();

      expect(inbound).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      const tasks = readInboundTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!['state']).toBe('failed');
      expect(tasks[0]!['delivery']).toBeUndefined();
      expect(tasks[0]!['attempts']).toBe(1);
      expect(existsSync(boundDeadLetterPath())).toBe(false);
      inbound.mockRestore();
    });

    it('retries a full queue without posting a public error comment', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.deliverPrompt.mockRejectedValueOnce(
        new BoundSessionQueueFullError('bound-session'),
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(existsSync(inboundTaskPath())).toBe(true);
      const tasks = readInboundTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!['state']).toBe('failed');
      expect(tasks[0]!['delivery']).toEqual({
        kind: 'bound-session',
        sessionId: 'bound-session',
      });

      // Next poll recovers the persisted task and delivers it.
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('ignores deliverToBoundSessions in standalone mode', async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await initChannel({ deliverToBoundSessions: true });
      } finally {
        stderr.mockRestore();
      }
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
    });

    it('rejects prWatchEvents without deliverToBoundSessions', async () => {
      channel = new TestableGithubChannel(
        'test-github',
        makeConfig({ prWatchEvents: ['ci_failure'] }),
        makeBridge(),
        { boundSessions },
      );
      await expect(channel.connect()).rejects.toThrow(
        'prWatchEvents for channel test-github requires deliverToBoundSessions',
      );
    });

    it('decouples the notification cursor from bound backpressure (F2)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.deliverPrompt.mockRejectedValue(
        new BoundSessionQueueFullError('bound-session'),
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      // Pure bound backpressure must not freeze mark-as-read / the cursor.
      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).toHaveBeenCalledTimes(1);
      const cursor = (
        channel as unknown as { cursor: { lastProcessedAt: string } }
      ).cursor;
      expect(cursor.lastProcessedAt).toBe('2026-07-02T10:00:00.000Z');

      for (let i = 0; i < 2; i++) {
        mockOctokit.paginate.mockResolvedValueOnce([]);
        await pollOnce();
      }
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(3);
      const tasks = readInboundTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!['attempts']).toBe(0);
      expect(tasks[0]!['deferCount']).toBe(3);
      expect(tasks[0]!['backpressure']).toBe(true);
    });

    it('retires a bound event to the dead-letter at the deferral horizon (F2)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.deliverPrompt.mockRejectedValue(
        new BoundSessionQueueFullError('bound-session'),
      );
      const envelope = {
        ...makeInboundTaskRecord().envelope,
        threadId: 'pr:42',
        messageId: 'watch:ci_failure:sha-1',
      };
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'failed',
          attempts: 0,
          deferCount: 239,
          backpressure: true,
          issueNumber: 42,
          delivery: { kind: 'bound-session', sessionId: 'bound-session' },
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: 'watch:ci_failure:sha-1',
          },
          envelope,
          dedupe: {},
        }),
      ]);
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(existsSync(inboundTaskPath())).toBe(false);
      const lines = readFileSync(boundDeadLetterPath(), 'utf-8')
        .trim()
        .split('\n');
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]!) as {
        source: { messageId?: string };
        reason: string;
      };
      expect(record.source.messageId).toBe('watch:ci_failure:sha-1');
      expect(record.reason).toContain('backpressure horizon');
    });

    it('defers the comment lane until a complete binding snapshot (N11)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockRejectedValueOnce(
        new Error('daemon cold'),
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      // Cold start: no channel delivery and the cursor stays frozen. The
      // notification once-values are NOT consumed (the gate returns first).
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).not.toHaveBeenCalled();
      const cursor = (
        channel as unknown as { cursor: { lastProcessedAt: string } }
      ).cursor;
      expect(cursor.lastProcessedAt).toBe('2026-07-01T00:00:00.000Z');

      // Snapshot recovers: the same notification now delivers privately.
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('defers the comment lane on a partial empty cold snapshot (N11)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValueOnce({
        bindings: [],
        partial: true,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      const cursor = (
        channel as unknown as { cursor: { lastProcessedAt: string } }
      ).cursor;
      expect(cursor.lastProcessedAt).toBe('2026-07-01T00:00:00.000Z');

      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('delivers privately for a www.github.com binding URL (F9)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            prs: [
              {
                number: 42,
                url: 'https://www.github.com/owner/repo/pull/42',
                state: 'open',
              },
            ],
          }),
        ],
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('matches bindings on a GitHub Enterprise baseUrl host (F19)', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          baseUrl: 'https://ghe.example.com/api/v3',
        },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            prs: [
              {
                number: 42,
                url: 'https://ghe.example.com/owner/repo/pull/42',
                state: 'open',
              },
            ],
          }),
        ],
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('does not replay a bound prompt accepted before a crash (F21)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      const removable = channel as unknown as {
        removeInboundTask: (id: string) => void;
      };
      const spy = vi
        .spyOn(removable, 'removeInboundTask')
        .mockImplementationOnce(() => {
          throw new Error('crash before removal');
        });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      // The acceptance mark was persisted before the simulated crash.
      const tasks = readInboundTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!['state']).toBe('running');
      expect(tasks[0]!['deliveredAt']).toEqual(expect.any(Number));
      spy.mockRestore();

      // Restart: recovery retires the accepted task without re-injecting.
      // initChannel clears mock history, so a replay would show as a call.
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('does not revive PRs a listed session authoritatively unbound (P1)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValueOnce({
        bindings: [
          makeBinding({
            sessionId: 'S',
            prs: [
              {
                number: 42,
                url: 'https://github.com/owner/repo/pull/42',
                state: 'open',
              },
              {
                number: 43,
                url: 'https://github.com/owner/repo/pull/43',
                state: 'open',
              },
            ],
          }),
          makeBinding({
            sessionId: 'T',
            prs: [
              {
                number: 44,
                url: 'https://github.com/owner/repo/pull/44',
                state: 'open',
              },
            ],
          }),
        ],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();

      // Partial scan lists S with only PR 42; T is unlisted (retained).
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            sessionId: 'S',
            prs: [
              {
                number: 42,
                url: 'https://github.com/owner/repo/pull/42',
                state: 'open',
              },
            ],
          }),
        ],
        partial: true,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            subject: {
              title: 'PR',
              url: 'https://api.github.com/repos/owner/repo/pulls/43',
              type: 'PullRequest',
            },
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({ created_at: '2026-07-02T09:30:00.000Z' }),
        ]);
      await pollOnce();
      // PR 43 was unbound by listed S: channel path, no revival.
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(1);

      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            updated_at: '2026-07-02T11:00:00.000Z',
            subject: {
              title: 'PR',
              url: 'https://api.github.com/repos/owner/repo/pulls/44',
              type: 'PullRequest',
            },
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({
            id: 1002,
            node_id: 'C_1002',
            created_at: '2026-07-02T10:30:00.000Z',
          }),
        ]);
      await pollOnce();
      // PR 44 belongs to unlisted T: retained, delivers privately.
      expect(boundSessions.deliverPrompt).toHaveBeenCalledWith(
        'T',
        expect.any(String),
      );
    });

    it('keeps the newer session when a partial scan lists an older one (P1)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValueOnce({
        bindings: [
          makeBinding({
            sessionId: 'older-B',
            updatedAt: '2026-07-01T00:00:00.000Z',
          }),
          makeBinding({
            sessionId: 'newer-A',
            updatedAt: '2026-07-03T00:00:00.000Z',
          }),
        ],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();

      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            sessionId: 'older-B',
            updatedAt: '2026-07-01T00:00:00.000Z',
          }),
        ],
        partial: true,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledWith(
        'newer-A',
        expect.any(String),
      );
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('retargets a backpressured comment to the live rebound session (P2)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.deliverPrompt
        .mockRejectedValueOnce(new BoundSessionQueueFullError('session-a'))
        .mockResolvedValue(undefined);
      boundSessions.listPrBindings.mockResolvedValueOnce({
        bindings: [makeBinding({ sessionId: 'session-a' })],
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenLastCalledWith(
        'session-a',
        expect.any(String),
      );
      const tasks = readInboundTasks();
      expect(tasks[0]!['delivery']).toEqual({
        kind: 'bound-session',
        sessionId: 'session-a',
      });

      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [makeBinding({ sessionId: 'session-b' })],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenLastCalledWith(
        'session-b',
        expect.any(String),
      );
      expect(existsSync(inboundTaskPath())).toBe(false);
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('keeps the channel path when deliverToBoundSessions is off (Q3)', async () => {
      await initChannel({}, { boundSessions });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(1);
    });

    it('does not re-deliver to the same session after a Gone fallback (R2)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.deliverPrompt.mockRejectedValueOnce(
        new BoundSessionGoneError('bound-session'),
      );
      // Both the refresh and the Gone re-resolution list the SAME session.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [makeBinding()],
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(channel.inboundEnvelopes).toHaveLength(1);
    });

    it('keeps the public fallback for a gone comment under an allowlist (F7)', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          groups: { '*': { senders: 'allowlist', allowedUsers: ['alice'] } },
        },
        { boundSessions },
      );
      boundSessions.deliverPrompt.mockRejectedValueOnce(
        new BoundSessionGoneError('bound-session'),
      );
      boundSessions.listPrBindings
        .mockResolvedValueOnce({ bindings: [makeBinding()], partial: false })
        .mockResolvedValueOnce({ bindings: [], partial: false });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(channel.inboundEnvelopes).toHaveLength(1);
    });

    it('charges one attempt recovering an interrupted bound delivery (R4)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      const envelope = {
        ...makeInboundTaskRecord().envelope,
        threadId: 'pr:42',
      };
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'running',
          attempts: 0,
          issueNumber: 42,
          delivery: { kind: 'bound-session', sessionId: 'bound-session' },
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: '1001',
          },
          envelope,
          dedupe: {},
        }),
      ]);
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('retires a bound crash loop after exhausting attempts (R4)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      const envelope = {
        ...makeInboundTaskRecord().envelope,
        threadId: 'pr:42',
      };
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'running',
          attempts: 2,
          issueNumber: 42,
          delivery: { kind: 'bound-session', sessionId: 'bound-session' },
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: '1001',
          },
          envelope,
          dedupe: {},
        }),
      ]);
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(existsSync(inboundTaskPath())).toBe(false);
      const lines = readFileSync(boundDeadLetterPath(), 'utf-8')
        .trim()
        .split('\n');
      expect(lines).toHaveLength(1);
      expect((JSON.parse(lines[0]!) as { reason: string }).reason).toContain(
        'crash loop',
      );
    });

    it('treats an unavailable session as backpressure, not failure (F2)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.deliverPrompt.mockRejectedValueOnce(
        new BoundSessionUnavailableError('bound-session', 'workspace draining'),
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      const tasks = readInboundTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!['attempts']).toBe(0);
      expect(tasks[0]!['backpressure']).toBe(true);
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });
  });

  describe('PR state watch', () => {
    // Routing queues (listForRef / notifications / comments) are consumed
    // per API call, and some tests intentionally leave a value unconsumed
    // to prove no re-fetch happens; reset them so queues never leak across
    // tests. vi.clearAllMocks alone keeps once-queues alive.
    beforeEach(() => {
      mockOctokit.rest.checks.listForRef.mockReset();
      mockOctokit.rest.activity.listNotificationsForAuthenticatedUser.mockReset();
      mockOctokit.rest.issues.listComments.mockReset();
      mockOctokit.rest.pulls.get.mockReset();
      mockOctokit.rest.repos.getCombinedStatusForRef.mockReset();
      mockOctokit.rest.repos.getCombinedStatusForRef.mockResolvedValue({
        data: { state: 'success', total_count: 0 },
      });
    });

    // Clock-dependent tests install fake timers; always restore the real
    // clock so a leaked fake never skews a sibling test's Date.now().
    afterEach(() => {
      vi.useRealTimers();
    });

    const watchConfig = {
      deliverToBoundSessions: true,
      prWatchEvents: [
        'ci_failure',
        'merge_conflict',
        'head_change',
        'state_change',
      ],
    };

    /** A durable pending watch event as watchOnePr would queue it. */
    function makePendingWatch(
      overrides: {
        key?: string;
        issueNumber?: number;
        text?: string;
        sessionId?: string;
      } = {},
    ) {
      const key = overrides.key ?? 'watch:ci_failure:sha-1';
      const issueNumber = overrides.issueNumber ?? 42;
      return {
        key,
        issueNumber,
        envelope: {
          channelName: 'test-github',
          senderId: 'github',
          senderName: 'GitHub',
          chatId: 'owner/repo',
          threadId: `pr:${issueNumber}`,
          messageId: key,
          text: overrides.text ?? 'CI failed on head sha-1.',
          isGroup: true,
          isMentioned: true,
          isReplyToBot: false,
          metadata: 'Event: ci_failure.',
        },
        delivery: {
          kind: 'bound-session',
          sessionId: overrides.sessionId ?? 'bound-session',
        },
      };
    }

    /** Seed the on-disk watch sidecar before the first poll loads it. */
    function seedWatchState(entries: Record<string, unknown>): void {
      const path = watchStatePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        `${JSON.stringify({ version: 1, entries })}\n`,
        'utf-8',
      );
    }

    function readWatchState(): {
      entries: Record<string, Record<string, unknown>>;
    } {
      return JSON.parse(readFileSync(watchStatePath(), 'utf-8')) as {
        entries: Record<string, Record<string, unknown>>;
      };
    }

    function mockPull(meta: Record<string, unknown>): void {
      mockOctokit.rest.pulls.get.mockResolvedValue({ data: makePrMeta(meta) });
    }

    // The watch pass runs before the notification loop, so paginate is
    // routed by API params instead of a shared once-queue: checks fetches
    // must not consume the notifications slot.
    function installWatchPaginateRouting(): void {
      mockOctokit.paginate.mockImplementation(
        async (_fn: unknown, params: Record<string, unknown> = {}) => {
          if ('ref' in params) return mockOctokit.rest.checks.listForRef();
          if ('issue_number' in params)
            return mockOctokit.rest.issues.listComments();
          return mockOctokit.rest.activity.listNotificationsForAuthenticatedUser();
        },
      );
    }

    function mockNotificationsOnce(items: unknown[]): void {
      installWatchPaginateRouting();
      mockOctokit.rest.activity.listNotificationsForAuthenticatedUser.mockResolvedValueOnce(
        items,
      );
    }

    function mockChecks(
      runs: Array<{
        status: string;
        conclusion: string | null;
        name?: string;
      }>,
    ): void {
      installWatchPaginateRouting();
      mockOctokit.rest.checks.listForRef.mockResolvedValueOnce(runs);
    }

    it('initializes silently on first observation', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
    });

    it('fires ci_failure once per head and not again for the same head', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      // A check re-run on the same head bumps updated_at and turns red.
      mockPull({ updated_at: '2026-07-02T10:00:00.000Z' });
      mockNotificationsOnce([]);
      mockChecks([
        { status: 'completed', conclusion: 'failure', name: 'build' },
      ]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'CI failed on head sha-1',
      );
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'Failed checks: build',
      );

      mockPull({ updated_at: '2026-07-02T10:00:00.000Z' });
      mockNotificationsOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
    });

    it('fires head_change and re-checks CI on a new head', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      mockPull({ head: { sha: 'sha-2' } });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'failure' }]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      const prompts = boundSessions.deliverPrompt.mock.calls.map(
        (call) => call[1] as string,
      );
      expect(
        prompts.some((p) => p.includes('head moved from sha-1 to sha-2')),
      ).toBe(true);
      expect(prompts.some((p) => p.includes('CI failed on head sha-2'))).toBe(
        true,
      );
    });

    it('fires merge_conflict on the dirty edge and guards null mergeable', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      mockPull({ mergeable: false, mergeable_state: 'dirty' });
      mockNotificationsOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'Merge conflicts detected',
      );

      // GitHub still computing: must not clear the dirty observation.
      mockPull({ mergeable: null, mergeable_state: 'unknown' });
      mockNotificationsOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);

      // Still dirty: edge-triggered, no repeat.
      mockPull({ mergeable: false, mergeable_state: 'dirty' });
      mockNotificationsOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
    });

    it('fires state_change on merge and leaves the watch set once recorded', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      mockPull({ state: 'closed', merged: true });
      mockNotificationsOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'The PR was merged',
      );

      // Binding state caught up (refresh timer): no more pulls.get calls.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            prs: [
              {
                number: 42,
                url: 'https://github.com/owner/repo/pull/42',
                state: 'merged',
              },
            ],
          }),
        ],
        partial: false,
      });
      mockOctokit.rest.pulls.get.mockClear();
      mockNotificationsOnce([]);
      await pollOnce();
      expect(mockOctokit.rest.pulls.get).not.toHaveBeenCalled();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
    });

    it('does not re-fire a transition after a restart', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      mockPull({ updated_at: '2026-07-02T10:00:00.000Z' });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'failure' }]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);

      // A fresh channel instance over the same state directory. initChannel
      // clears mock history, so any new delivery would show up as a call.
      await initChannel(watchConfig, { boundSessions });
      mockPull({ updated_at: '2026-07-02T10:00:00.000Z' });
      mockNotificationsOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();

      // A NEW transition after the restart must still fire: this is what
      // proves the baseline was loaded from disk rather than re-initialized
      // (a lost baseline would silently swallow it as a first observation).
      mockPull({
        head: { sha: 'sha-2' },
        updated_at: '2026-07-02T11:00:00.000Z',
      });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'failure' }]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      const prompts = boundSessions.deliverPrompt.mock.calls.map(
        (call) => call[1] as string,
      );
      expect(
        prompts.some((p) => p.includes('head moved from sha-1 to sha-2')),
      ).toBe(true);
      expect(prompts.some((p) => p.includes('CI failed on head sha-2'))).toBe(
        true,
      );
    });

    it('makes zero watch calls when no PR is bound', async () => {
      await initChannel(watchConfig, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      mockNotificationsOnce([]);

      await pollOnce();

      expect(mockOctokit.rest.pulls.get).not.toHaveBeenCalled();
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
    });

    it('stays silent on a first observation that is already failing', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({ mergeable: false, mergeable_state: 'dirty' });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'failure' }]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
    });

    it('re-checks a none aggregate within the grace window after a head change', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      // New head, checks not registered yet: aggregate 'none', head_change
      // fires but CI is not settled.
      mockPull({ head: { sha: 'sha-2' } });
      mockNotificationsOnce([]);
      mockChecks([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'head moved from sha-1 to sha-2',
      );

      // Same head, same updated_at: the grace window must still re-check
      // and catch the failure that registered late.
      mockPull({ head: { sha: 'sha-2' } });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'failure' }]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      expect(boundSessions.deliverPrompt.mock.calls[1]![1]).toContain(
        'CI failed on head sha-2',
      );
    });

    it('fires ci_failure on a combined commit status of error', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      mockPull({ updated_at: '2026-07-02T10:00:00.000Z' });
      mockNotificationsOnce([]);
      mockChecks([]);
      mockOctokit.rest.repos.getCombinedStatusForRef.mockResolvedValue({
        data: { state: 'error', total_count: 1 },
      });
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'CI failed on head sha-1',
      );
    });

    it('treats timed_out and action_required checks as failures', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      mockPull({ updated_at: '2026-07-02T10:00:00.000Z' });
      mockNotificationsOnce([]);
      mockChecks([
        { status: 'completed', conclusion: 'timed_out', name: 'slow-job' },
        {
          status: 'completed',
          conclusion: 'action_required',
          name: 'manual-gate',
        },
      ]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'Failed checks: slow-job, manual-gate',
      );
    });

    it('keeps watching known PRs and the baseline when the snapshot is partial', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      // Partial answer (a workspace failed to list): known bindings are
      // retained, so the watch keeps observing them and never prunes.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: true,
      });
      mockPull({ updated_at: '2026-07-02T09:30:00.000Z' });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'failure' }]);
      await pollOnce();
      // The retained binding kept the PR watched: the transition fires
      // instead of being silently re-initialized later.
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'CI failed on head sha-1',
      );

      // Complete snapshot restored: no duplicate for the same transition.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [makeBinding()],
        partial: false,
      });
      mockPull({ updated_at: '2026-07-02T09:30:00.000Z' });
      mockNotificationsOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
    });

    it('skips the watch pass when the binding refresh fails', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      boundSessions.listPrBindings.mockRejectedValueOnce(
        new Error('daemon starting'),
      );
      mockOctokit.rest.pulls.get.mockClear();
      mockNotificationsOnce([]);
      await pollOnce();

      expect(mockOctokit.rest.pulls.get).not.toHaveBeenCalled();
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
    });

    function watchStatePath(): string {
      const nameHash = createHash('sha256')
        .update('test-github')
        .digest('hex')
        .slice(0, 16);
      return join(
        process.env.QWEN_HOME!,
        'channels',
        getWorkspaceScopeDirName('/tmp/test'),
        `test-github-${nameHash}-github-pr-watch.json`,
      );
    }

    it('delivers a comment privately during a partial binding scan', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // Establish the routing map from a complete snapshot.
      mockNotificationsOnce([]);
      await pollOnce();

      // The next scan is incomplete: the known binding must survive it.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: true,
      });
      mockNotificationsOnce([prNotification()]);
      mockOctokit.rest.issues.listComments.mockResolvedValueOnce([
        makeComment(),
      ]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('observes a merged binding recorded before the watch poll', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      // The independent refresh recorded merged before this poll.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            prs: [
              {
                number: 42,
                url: 'https://github.com/owner/repo/pull/42',
                state: 'merged',
              },
            ],
          }),
        ],
        partial: false,
      });
      mockPull({
        state: 'closed',
        merged: true,
      });
      mockNotificationsOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'The PR was merged',
      );

      // Terminal transition observed: the PR leaves the watch set.
      mockOctokit.rest.pulls.get.mockClear();
      mockNotificationsOnce([]);
      await pollOnce();
      expect(mockOctokit.rest.pulls.get).not.toHaveBeenCalled();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
    });

    it('observes a closed binding recorded before the watch poll', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            prs: [
              {
                number: 42,
                url: 'https://github.com/owner/repo/pull/42',
                state: 'closed',
              },
            ],
          }),
        ],
        partial: false,
      });
      mockPull({
        state: 'closed',
        merged: false,
      });
      mockNotificationsOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'closed without merging',
      );
    });

    it('ignores an empty combined status (GitHub actual shape)', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockOctokit.rest.repos.getCombinedStatusForRef.mockResolvedValue({
        data: { state: 'pending', total_count: 0, statuses: [] },
      });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      // Actions-only head settles to success despite the empty combined
      // status reporting 'pending'.
      const state = JSON.parse(readFileSync(watchStatePath(), 'utf-8')) as {
        entries: Record<string, { ci?: string }>;
      };
      expect(state.entries['owner/repo#42']!.ci).toBe('success');

      // Settled means no re-fetch: a queued failure must NOT be consumed.
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'failure' }]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
    });

    it('settles a no-CI head to none instead of pending', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockOctokit.rest.repos.getCombinedStatusForRef.mockResolvedValue({
        data: { state: 'pending', total_count: 0, statuses: [] },
      });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([]);
      await pollOnce();

      const state = JSON.parse(readFileSync(watchStatePath(), 'utf-8')) as {
        entries: Record<string, { ci?: string }>;
      };
      expect(state.entries['owner/repo#42']!.ci).toBe('none');
    });

    it('fires ci_failure once per head across flapping and restart', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      // failure -> success -> failure on the SAME head, timestamps advancing.
      mockPull({ updated_at: '2026-07-02T10:00:00.000Z' });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'failure' }]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);

      mockPull({ updated_at: '2026-07-02T10:01:00.000Z' });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      mockPull({ updated_at: '2026-07-02T10:02:00.000Z' });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'failure' }]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);

      // The fired marker survives a restart.
      await initChannel(watchConfig, { boundSessions });
      mockPull({ updated_at: '2026-07-02T10:03:00.000Z' });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'failure' }]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
    });

    it('retries a watch event whose claim failed, exactly once after restart', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      // Fault injection: the claim write fails once the transition is
      // detected; the event must stay queued, not be consumed.
      const claimable = channel as unknown as {
        claimInboundTask: (...args: unknown[]) => unknown;
      };
      const spy = vi
        .spyOn(claimable, 'claimInboundTask')
        .mockImplementationOnce(() => {
          throw new Error('disk full');
        });
      mockPull({ updated_at: '2026-07-02T10:00:00.000Z' });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'failure' }]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      const queued = JSON.parse(readFileSync(watchStatePath(), 'utf-8')) as {
        entries: Record<string, { pending?: Array<{ key: string }> }>;
      };
      expect(
        queued.entries['owner/repo#42']!.pending?.map((p) => p.key),
      ).toContain('watch:ci_failure:sha-1');
      spy.mockRestore();

      // Restart: the pending event drains and delivers exactly once.
      await initChannel(watchConfig, { boundSessions });
      mockPull({ updated_at: '2026-07-02T10:00:00.000Z' });
      mockNotificationsOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'CI failed on head sha-1',
      );

      // And never again.
      mockPull({ updated_at: '2026-07-02T10:00:00.000Z' });
      mockNotificationsOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
    });

    it('re-fires merge_conflict on dirty -> clean -> dirty, same head (F1)', async () => {
      await initChannel(
        { deliverToBoundSessions: true, prWatchEvents: ['merge_conflict'] },
        { boundSessions },
      );
      mockPull({});
      mockNotificationsOnce([]);
      await pollOnce();

      mockPull({ mergeable: false, mergeable_state: 'dirty' });
      mockNotificationsOnce([]);
      await pollOnce();
      mockPull({ mergeable: true, mergeable_state: 'clean' });
      mockNotificationsOnce([]);
      await pollOnce();
      mockPull({ mergeable: false, mergeable_state: 'dirty' });
      mockNotificationsOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      const fired = readWatchState().entries['owner/repo#42']![
        'fired'
      ] as string[];
      expect(fired).toEqual([
        'watch:merge_conflict:1',
        'watch:merge_conflict:2',
      ]);
    });

    it('re-fires merge_conflict across a head change (F1)', async () => {
      await initChannel(
        { deliverToBoundSessions: true, prWatchEvents: ['merge_conflict'] },
        { boundSessions },
      );
      mockPull({});
      mockNotificationsOnce([]);
      await pollOnce();

      mockPull({ mergeable: false, mergeable_state: 'dirty' });
      mockNotificationsOnce([]);
      await pollOnce();
      mockPull({
        head: { sha: 'sha-2' },
        mergeable: true,
        mergeable_state: 'clean',
      });
      mockNotificationsOnce([]);
      await pollOnce();
      mockPull({
        head: { sha: 'sha-2' },
        mergeable: false,
        mergeable_state: 'dirty',
      });
      mockNotificationsOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      const prompts = boundSessions.deliverPrompt.mock.calls.map(
        (call) => call[1] as string,
      );
      expect(
        prompts.filter((p) => p.includes('Merge conflicts detected')),
      ).toHaveLength(2);
    });

    it('re-fires state_change on close -> reopen -> close (F1)', async () => {
      await initChannel(
        { deliverToBoundSessions: true, prWatchEvents: ['state_change'] },
        { boundSessions },
      );
      mockPull({});
      mockNotificationsOnce([]);
      await pollOnce();

      mockPull({ state: 'closed', merged: false });
      mockNotificationsOnce([]);
      await pollOnce();
      mockPull({ state: 'open', merged: false });
      mockNotificationsOnce([]);
      await pollOnce();
      mockPull({ state: 'closed', merged: false });
      mockNotificationsOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      const fired = readWatchState().entries['owner/repo#42']![
        'fired'
      ] as string[];
      expect(fired).toEqual(['watch:state_change:1', 'watch:state_change:2']);
    });

    it('re-fires head_change on a SHA revisit A -> B -> A -> B (F1)', async () => {
      await initChannel(
        { deliverToBoundSessions: true, prWatchEvents: ['head_change'] },
        { boundSessions },
      );
      mockPull({ head: { sha: 'sha-A' } });
      mockNotificationsOnce([]);
      await pollOnce();

      mockPull({ head: { sha: 'sha-B' } });
      mockNotificationsOnce([]);
      await pollOnce();
      mockPull({ head: { sha: 'sha-A' } });
      mockNotificationsOnce([]);
      await pollOnce();
      mockPull({ head: { sha: 'sha-B' } });
      mockNotificationsOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(3);
      const fired = readWatchState().entries['owner/repo#42']![
        'fired'
      ] as string[];
      expect(fired).toEqual([
        'watch:head_change:1',
        'watch:head_change:2',
        'watch:head_change:3',
      ]);
    });

    it('re-checks a settled success head on the periodic interval (F4)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-02T09:00:00.000Z'));
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      // Same head AND same updated_at: only the periodic re-check trigger
      // can re-fetch a settled head that turns red on a re-run.
      vi.setSystemTime(new Date('2026-07-02T09:11:00.000Z'));
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([
        { status: 'completed', conclusion: 'failure', name: 'build' },
      ]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'CI failed on head sha-1',
      );
    });

    it('catches late CI on a none head past the grace window (N13)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-02T09:00:00.000Z'));
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([]);
      await pollOnce();

      // Past BOTH the none-grace and the re-check interval, updated_at
      // unchanged: the periodic re-check must still catch the late failure.
      vi.setSystemTime(new Date('2026-07-02T09:11:00.000Z'));
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'failure' }]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'CI failed on head sha-1',
      );
    });

    it('fails closed on a watch-state read error and recovers next poll (F5)', async () => {
      await initChannel(watchConfig, { boundSessions });
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          ci: 'success',
          mergeableState: 'clean',
          prState: 'open',
          prUpdatedAt: '2026-07-02T09:00:00.000Z',
          fired: [],
          pending: [makePendingWatch()],
        },
      });
      const baseline = readFileSync(watchStatePath(), 'utf-8');
      const originalRead = nodeFs.readFileSync;
      let failWatchRead = true;
      const spy = vi.spyOn(nodeFs, 'readFileSync').mockImplementation(((
        path: string,
        ...args: unknown[]
      ) => {
        if (failWatchRead && path === watchStatePath()) {
          throw Object.assign(new Error('EACCES: permission denied'), {
            code: 'EACCES',
          });
        }
        return (originalRead as (p: string, ...a: unknown[]) => unknown)(
          path,
          ...args,
        );
      }) as unknown as typeof nodeFs.readFileSync);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        mockPull({});
        mockNotificationsOnce([]);
        await pollOnce();
        // Watch pass skipped: no pulls.get, no delivery, file byte-unchanged.
        expect(mockOctokit.rest.pulls.get).not.toHaveBeenCalled();
        expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
        failWatchRead = false;
        expect(readFileSync(watchStatePath(), 'utf-8')).toBe(baseline);

        // Next poll loads the intact state and drains the pending event.
        mockPull({});
        mockNotificationsOnce([]);
        await pollOnce();
        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
        expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
          'CI failed on head sha-1',
        );
      } finally {
        spy.mockRestore();
        stderr.mockRestore();
      }
    });

    it('replaces a terminal failed task when a watch key re-fires (F6)', async () => {
      await initChannel(watchConfig, { boundSessions });
      const envelope = {
        ...makePendingWatch({ key: 'watch:state_change:1' }).envelope,
      };
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'failed',
          attempts: 3,
          issueNumber: 42,
          delivery: { kind: 'bound-session', sessionId: 'bound-session' },
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: 'watch:state_change:1',
          },
          envelope,
          dedupe: {},
        }),
      ]);
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      mockPull({ state: 'closed', merged: false });
      mockNotificationsOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('reuses a reply_pending task instead of double-delivering (F6)', async () => {
      await initChannel(watchConfig, { boundSessions });
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'reply_pending',
          issueNumber: 42,
          delivery: { kind: 'bound-session', sessionId: 'bound-session' },
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: 'watch:state_change:1',
          },
          envelope: undefined,
          dedupe: {},
        }),
      ]);
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      mockPull({ state: 'closed', merged: false });
      mockNotificationsOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
    });

    it('retires a watch event privately when its bound session is gone (F7)', async () => {
      await initChannel(
        {
          ...watchConfig,
          groups: { '*': { senders: 'allowlist', allowedUsers: ['alice'] } },
        },
        { boundSessions },
      );
      boundSessions.deliverPrompt.mockRejectedValueOnce(
        new BoundSessionGoneError('bound-session'),
      );
      // poll-1 refresh, poll-2 refresh (watch must still see the binding to
      // detect the conflict), then the Gone re-resolution finds no candidate.
      boundSessions.listPrBindings
        .mockResolvedValueOnce({ bindings: [makeBinding()], partial: false })
        .mockResolvedValueOnce({ bindings: [makeBinding()], partial: false })
        .mockResolvedValueOnce({ bindings: [], partial: false });
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        mockPull({});
        mockNotificationsOnce([]);
        mockChecks([{ status: 'completed', conclusion: 'success' }]);
        await pollOnce();

        mockPull({ mergeable: false, mergeable_state: 'dirty' });
        mockNotificationsOnce([]);
        await pollOnce();

        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
        expect(channel.inboundEnvelopes).toHaveLength(0);
        expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
        expect(existsSync(inboundTaskPath())).toBe(false);
        expect(
          stderr.mock.calls.some((call) =>
            String(call[0]).includes('retiring without public fallback'),
          ),
        ).toBe(true);
      } finally {
        stderr.mockRestore();
      }
    });

    it('recovers from an array-shaped entries sidecar (F10)', async () => {
      await initChannel(
        { deliverToBoundSessions: true, prWatchEvents: ['merge_conflict'] },
        { boundSessions },
      );
      const path = watchStatePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        `${JSON.stringify({ version: 1, entries: [] })}\n`,
        'utf-8',
      );
      mockPull({});
      mockNotificationsOnce([]);
      await pollOnce();

      mockPull({ mergeable: false, mergeable_state: 'dirty' });
      mockNotificationsOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      const state = JSON.parse(readFileSync(watchStatePath(), 'utf-8')) as {
        entries: unknown;
      };
      expect(Array.isArray(state.entries)).toBe(false);
      expect(typeof state.entries).toBe('object');
    });

    it('drains pending events for PRs outside the watch cap (F11)', async () => {
      await initChannel(
        { deliverToBoundSessions: true, prWatchEvents: ['merge_conflict'] },
        { boundSessions },
      );
      const bindings = [];
      for (let i = 1; i <= 30; i++) {
        bindings.push(
          makeBinding({
            sessionId: `s-${i}`,
            updatedAt: `2026-07-02T00:00:${String(i).padStart(2, '0')}.000Z`,
            prs: [
              {
                number: i,
                url: `https://github.com/owner/repo/pull/${i}`,
                state: 'open',
              },
            ],
          }),
        );
      }
      bindings.push(
        makeBinding({
          sessionId: 's-oldest',
          updatedAt: '2026-07-01T00:00:00.000Z',
          prs: [
            {
              number: 999,
              url: 'https://github.com/owner/repo/pull/999',
              state: 'open',
            },
          ],
        }),
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings,
        partial: false,
      });
      seedWatchState({
        'owner/repo#999': {
          headSha: 'sha-999',
          mergeableState: 'clean',
          prState: 'open',
          fired: [],
          pending: [
            makePendingWatch({
              key: 'watch:merge_conflict:1',
              issueNumber: 999,
              text: 'Merge conflicts detected (mergeable_state: dirty).',
              sessionId: 's-oldest',
            }),
          ],
        },
      });
      mockPull({});
      mockNotificationsOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt).toHaveBeenCalledWith(
        's-oldest',
        expect.stringContaining('Merge conflicts detected'),
      );
    });

    it('does not fetch CI when ci_failure is not subscribed (F12)', async () => {
      await initChannel(
        { deliverToBoundSessions: true, prWatchEvents: ['merge_conflict'] },
        { boundSessions },
      );
      mockPull({});
      mockNotificationsOnce([]);
      await pollOnce();

      mockPull({
        mergeable: false,
        mergeable_state: 'dirty',
        updated_at: '2026-07-02T10:00:00.000Z',
      });
      mockNotificationsOnce([]);
      await pollOnce();

      expect(mockOctokit.rest.checks.listForRef).not.toHaveBeenCalled();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'Merge conflicts detected',
      );
    });

    it('delivers watch events under a sender allowlist without github (F15)', async () => {
      await initChannel(
        {
          ...watchConfig,
          groups: { '*': { senders: 'allowlist', allowedUsers: ['alice'] } },
        },
        { boundSessions },
      );
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      mockPull({ updated_at: '2026-07-02T10:00:00.000Z' });
      mockNotificationsOnce([]);
      mockChecks([
        { status: 'completed', conclusion: 'failure', name: 'build' },
      ]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'CI failed on head sha-1',
      );
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('keeps baselines for PRs rotating outside the watch cap (F16)', async () => {
      await initChannel(
        { deliverToBoundSessions: true, prWatchEvents: ['merge_conflict'] },
        { boundSessions },
      );
      const bindings = [];
      for (let i = 1; i <= 30; i++) {
        bindings.push(
          makeBinding({
            sessionId: `s-${i}`,
            updatedAt: `2026-07-02T00:00:${String(i).padStart(2, '0')}.000Z`,
            prs: [
              {
                number: i,
                url: `https://github.com/owner/repo/pull/${i}`,
                state: 'open',
              },
            ],
          }),
        );
      }
      bindings.push(
        makeBinding({
          sessionId: 's-oldest',
          updatedAt: '2026-07-01T00:00:00.000Z',
          prs: [
            {
              number: 999,
              url: 'https://github.com/owner/repo/pull/999',
              state: 'open',
            },
          ],
        }),
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings,
        partial: false,
      });
      seedWatchState({
        'owner/repo#999': {
          headSha: 'sha-999',
          mergeableState: 'clean',
          prState: 'open',
          fired: [],
        },
      });
      mockOctokit.rest.pulls.get.mockImplementation(
        (params: { pull_number: number }) =>
          Promise.resolve({
            data: makePrMeta({ head: { sha: `sha-${params.pull_number}` } }),
          }),
      );
      mockNotificationsOnce([]);
      await pollOnce();
      // Out of the cap but still bound: the baseline survives pruning.
      expect(readWatchState().entries['owner/repo#999']).toBeDefined();
      expect(readWatchState().entries['owner/repo#999']!['headSha']).toBe(
        'sha-999',
      );

      // Rotate the oldest PR into the cap and drive a conflict: fires once.
      bindings[30] = makeBinding({
        sessionId: 's-oldest',
        updatedAt: '2026-07-03T00:00:00.000Z',
        prs: [
          {
            number: 999,
            url: 'https://github.com/owner/repo/pull/999',
            state: 'open',
          },
        ],
      });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings,
        partial: false,
      });
      mockOctokit.rest.pulls.get.mockImplementation(
        (params: { pull_number: number }) =>
          Promise.resolve({
            data: makePrMeta({
              head: { sha: `sha-${params.pull_number}` },
              mergeable: params.pull_number !== 999,
              mergeable_state: params.pull_number === 999 ? 'dirty' : 'clean',
            }),
          }),
      );
      mockNotificationsOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'Merge conflicts detected',
      );

      mockNotificationsOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
    });

    it('keeps re-checking a pending aggregate until it settles (F20)', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'queued', conclusion: null }]);
      await pollOnce();

      // Same head, same updated_at: the pending aggregate must re-check.
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([
        { status: 'completed', conclusion: 'failure', name: 'build' },
      ]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'CI failed on head sha-1',
      );
    });

    it('never prunes an entry that still holds pending events (F22)', async () => {
      await initChannel(watchConfig, { boundSessions });
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          prState: 'open',
          fired: [],
          pending: [makePendingWatch()],
        },
      });
      // Complete snapshot with NO bindings: the PR is not a candidate, but
      // the pending queue must protect its entry from pruning. Drive the
      // watch pass directly so reconciliation does not drain it first.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      const watch = channel as unknown as {
        runPrStateWatch: () => Promise<void>;
      };
      await watch.runPrStateWatch();
      const entry = readWatchState().entries['owner/repo#42'];
      expect(entry).toBeDefined();
      expect((entry!['pending'] as unknown[]).length).toBe(1);
    });

    it('keeps a claim-failed pending event queued and delivers it later (F22)', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      const claimable = channel as unknown as {
        claimInboundTask: (...args: unknown[]) => unknown;
      };
      const spy = vi
        .spyOn(claimable, 'claimInboundTask')
        .mockImplementation(() => {
          throw new Error('disk full');
        });
      mockPull({ updated_at: '2026-07-02T10:00:00.000Z' });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'failure' }]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(
        (readWatchState().entries['owner/repo#42']!['pending'] as unknown[])
          .length,
      ).toBe(1);

      mockPull({ updated_at: '2026-07-02T10:00:00.000Z' });
      mockNotificationsOnce([]);
      await pollOnce();
      expect(
        (readWatchState().entries['owner/repo#42']!['pending'] as unknown[])
          .length,
      ).toBe(1);
      spy.mockRestore();

      mockPull({ updated_at: '2026-07-02T10:00:00.000Z' });
      mockNotificationsOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'CI failed on head sha-1',
      );
    });

    it('drains a pending state_change even when the binding is terminal (F22)', async () => {
      await initChannel(watchConfig, { boundSessions });
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          mergeableState: 'clean',
          prState: 'closed',
          fired: [],
          pending: [
            makePendingWatch({
              key: 'watch:state_change:1',
              text: 'The PR was closed without merging.',
            }),
          ],
        },
      });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            prs: [
              {
                number: 42,
                url: 'https://github.com/owner/repo/pull/42',
                state: 'merged',
              },
            ],
          }),
        ],
        partial: false,
      });
      mockNotificationsOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'closed without merging',
      );
      // Terminal marker retained: no polling oscillation.
      expect(mockOctokit.rest.pulls.get).not.toHaveBeenCalled();
      expect(readWatchState().entries['owner/repo#42']).toBeDefined();
    });

    it('does not oscillate a closed PR back into the watch set (F22)', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      mockPull({ state: 'closed', merged: false });
      mockNotificationsOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);

      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            prs: [
              {
                number: 42,
                url: 'https://github.com/owner/repo/pull/42',
                state: 'closed',
              },
            ],
          }),
        ],
        partial: false,
      });
      mockOctokit.rest.pulls.get.mockClear();
      for (let i = 0; i < 3; i++) {
        mockNotificationsOnce([]);
        await pollOnce();
      }
      expect(mockOctokit.rest.pulls.get).not.toHaveBeenCalled();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(readWatchState().entries['owner/repo#42']!['prState']).toBe(
        'closed',
      );
    });

    it('reconciles pending before recovery even when the watch API fails (N4)', async () => {
      await initChannel(watchConfig, { boundSessions });
      const pending = makePendingWatch();
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          ci: 'failure',
          prState: 'open',
          fired: [],
          pending: [pending],
        },
      });
      // A claimed task on disk too: crash between claim and the fired save.
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'accepted',
          issueNumber: 42,
          delivery: { kind: 'bound-session', sessionId: 'bound-session' },
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: 'watch:ci_failure:sha-1',
          },
          envelope: pending.envelope,
          dedupe: {},
        }),
      ]);
      (
        channel as unknown as {
          abortableSleep: (ms: number) => Promise<void>;
        }
      ).abortableSleep = vi.fn().mockResolvedValue(undefined);
      mockOctokit.rest.pulls.get.mockRejectedValue(new Error('404 not found'));
      mockNotificationsOnce([]);
      await pollOnce();

      // Reconciliation delivered exactly once BEFORE recovery; the failing
      // watch pass neither starves the pending nor double-delivers.
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('evicts the oldest fired keys, keeping the newest 64 (N10)', async () => {
      await initChannel(watchConfig, { boundSessions });
      const fired = Array.from(
        { length: 64 },
        (_, i) => `watch:ci_failure:old-${i}`,
      );
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          ci: 'success',
          mergeableState: 'clean',
          prState: 'open',
          prUpdatedAt: '2026-07-02T09:00:00.000Z',
          fired,
        },
      });
      // Head change to a failing sha-2 appends head_change + ci_failure keys.
      mockPull({
        head: { sha: 'sha-2' },
        updated_at: '2026-07-02T10:00:00.000Z',
      });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'failure' }]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);

      // Flap sha-2 success -> failure: the per-head key must survive eviction
      // and suppress a re-delivery (a reversed slice would drop it).
      mockPull({
        head: { sha: 'sha-2' },
        updated_at: '2026-07-02T10:01:00.000Z',
      });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();
      mockPull({
        head: { sha: 'sha-2' },
        updated_at: '2026-07-02T10:02:00.000Z',
      });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'failure' }]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      const ring = readWatchState().entries['owner/repo#42']![
        'fired'
      ] as string[];
      expect(ring).toHaveLength(64);
      expect(ring).toContain('watch:ci_failure:sha-2');
    });

    it('retargets a lingering pending watch event to the rebound session (P2)', async () => {
      await initChannel(watchConfig, { boundSessions });
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          ci: 'success',
          mergeableState: 'clean',
          prState: 'open',
          prUpdatedAt: '2026-07-02T09:00:00.000Z',
          fired: [],
          pending: [makePendingWatch({ sessionId: 'session-a' })],
        },
      });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [makeBinding({ sessionId: 'session-b' })],
        partial: false,
      });
      mockPull({});
      mockNotificationsOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt).toHaveBeenCalledWith(
        'session-b',
        expect.any(String),
      );
    });

    it('fails fast on a rate-limited watch call, not blocking notifications (P3)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-02T09:00:00.000Z'));
      await initChannel(watchConfig, { boundSessions });
      const sleep = vi.fn().mockResolvedValue(undefined);
      (
        channel as unknown as {
          abortableSleep: (ms: number) => Promise<void>;
        }
      ).abortableSleep = sleep;
      const rateLimited = Object.assign(new Error('API rate limit exceeded'), {
        status: 403,
        response: {
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
          },
        },
      });
      mockOctokit.rest.pulls.get.mockRejectedValue(rateLimited);
      mockNotificationsOnce([]);
      await pollOnce();

      // Watch skipped without sleeping out the reset window...
      expect(sleep).not.toHaveBeenCalled();
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      // ...and notifications still processed in the same poll.
      expect(
        mockOctokit.rest.activity.listNotificationsForAuthenticatedUser,
      ).toHaveBeenCalledTimes(1);
    });

    it('emits only subscribed watch events (Q2)', async () => {
      await initChannel(
        { deliverToBoundSessions: true, prWatchEvents: ['ci_failure'] },
        { boundSessions },
      );
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      mockPull({
        head: { sha: 'sha-2' },
        mergeable: false,
        mergeable_state: 'dirty',
        state: 'closed',
        merged: true,
        updated_at: '2026-07-02T10:00:00.000Z',
      });
      mockNotificationsOnce([]);
      mockChecks([
        { status: 'completed', conclusion: 'failure', name: 'build' },
      ]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      const prompt = boundSessions.deliverPrompt.mock.calls[0]![1] as string;
      expect(prompt).toContain('CI failed on head sha-2');
      expect(prompt).not.toContain('head moved');
      expect(prompt).not.toContain('Merge conflicts');
      expect(prompt).not.toContain('was merged');
    });

    it('fires ci_failure for a startup_failure conclusion (Q4)', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      mockPull({ updated_at: '2026-07-02T10:00:00.000Z' });
      mockNotificationsOnce([]);
      mockChecks([
        {
          status: 'completed',
          conclusion: 'startup_failure',
          name: 'workflow',
        },
      ]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'CI failed on head',
      );
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'Failed checks: workflow',
      );
    });

    it('resumes the watch pass after a transient refresh failure (R1)', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      boundSessions.listPrBindings.mockRejectedValueOnce(
        new Error('daemon busy'),
      );
      mockOctokit.rest.pulls.get.mockClear();
      mockNotificationsOnce([]);
      await pollOnce();
      expect(mockOctokit.rest.pulls.get).not.toHaveBeenCalled();

      // Refresh recovers: the watch pass resumes and delivers a transition.
      mockPull({ mergeable: false, mergeable_state: 'dirty' });
      mockNotificationsOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'Merge conflicts detected',
      );
    });

    it('hardens the watch state file and directory permissions (R3)', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();
      mockPull({ mergeable: false, mergeable_state: 'dirty' });
      mockNotificationsOnce([]);
      await pollOnce();

      // Windows has no POSIX mode bits; stat reports 0o666.
      if (process.platform !== 'win32') {
        expect(statSync(watchStatePath()).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(watchStatePath())).mode & 0o777).toBe(0o700);
      }
    });

    it('cleans up the tmp file when a watch-state save fails (R5)', async () => {
      await initChannel(watchConfig, { boundSessions });
      const originalRename = nodeFs.renameSync;
      const spy = vi.spyOn(nodeFs, 'renameSync').mockImplementation(((
        from: unknown,
        to: unknown,
      ) => {
        if (
          String(from).includes('github-pr-watch.json') &&
          String(from).endsWith('.tmp')
        ) {
          throw Object.assign(new Error('ENOSPC: no space left'), {
            code: 'ENOSPC',
          });
        }
        return (originalRename as (f: unknown, t: unknown) => void)(from, to);
      }) as unknown as typeof nodeFs.renameSync);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        mockPull({});
        mockNotificationsOnce([]);
        mockChecks([{ status: 'completed', conclusion: 'success' }]);
        await pollOnce();
        const orphans = readdirSync(dirname(watchStatePath())).filter((f) =>
          f.endsWith('.tmp'),
        );
        expect(orphans).toHaveLength(0);
      } finally {
        spy.mockRestore();
        stderr.mockRestore();
      }
    });
  });
});
