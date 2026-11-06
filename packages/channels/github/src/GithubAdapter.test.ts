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

import { GithubChannel, validateBoundSessionConfig } from './GithubAdapter.js';

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

/** Every row of a Channel's event journal; none before the first write. */
function readChannelEvents(
  channelName = 'test-github',
): Array<Record<string, unknown>> {
  const path = inboundTaskPath('/tmp/test', channelName).replace(
    'github-inbound-tasks.json',
    'channel-events.jsonl',
  );
  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
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
    // The bound/watch describe installs a persistent paginate routing
    // implementation; clear it so a shuffled watch test cannot route this
    // describe's paginate calls into its own mocks.
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

    describe('repository ID casing', () => {
      async function connectWithGroups(
        groups: Record<string, unknown>,
      ): Promise<void> {
        channel = new TestableGithubChannel(
          'test-github',
          makeConfig({ groupPolicy: 'allowlist', groups }),
          makeBridge(),
        );
        mockOctokit.paginate.mockResolvedValue([]);
        await channel.connect();
        channel.usePreflight = true;
      }

      function comment(chatId: string, senderId = 'alice'): Envelope {
        return {
          channelName: 'test-github',
          senderId,
          senderName: senderId,
          chatId,
          text: 'review this',
          isGroup: true,
          isMentioned: true,
          isReplyToBot: false,
        };
      }

      it('admits the canonical repository spelling for a lower-case allowlist', async () => {
        // GitHub repository paths are case-insensitive, but notifications
        // report the canonical `owner/repo`. An allowlist typed in lower case
        // must still admit them instead of dropping every notification.
        await connectWithGroups({
          'qwenlm/qwen-code': { requireMention: false },
        });
        try {
          await channel.handleInbound(comment('QwenLM/qwen-code'));
          expect(channel.inboundEnvelopes).toHaveLength(1);
        } finally {
          channel.disconnect();
        }
      });

      it('still rejects a repository that is not allowlisted', async () => {
        await connectWithGroups({
          'qwenlm/qwen-code': { requireMention: false },
        });
        try {
          await channel.handleInbound(comment('SomeoneElse/other-repo'));
          expect(channel.inboundEnvelopes).toHaveLength(0);
        } finally {
          channel.disconnect();
        }
      });

      it('applies the repository sender allowlist across the case difference', async () => {
        // The sender policy is resolved through the same group lookup, so a
        // case-insensitive admission must not fall back to the open default.
        await connectWithGroups({
          'qwenlm/qwen-code': {
            requireMention: false,
            senders: 'allowlist',
            allowedUsers: ['alice'],
          },
        });
        try {
          await channel.handleInbound(comment('QwenLM/qwen-code', 'bob'));
          expect(channel.inboundEnvelopes).toHaveLength(0);
          await channel.handleInbound(comment('QwenLM/qwen-code', 'alice'));
          expect(channel.inboundEnvelopes).toHaveLength(1);
        } finally {
          channel.disconnect();
        }
      });
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

    it('marks all fetched notifications read when a thread fails permanently', async () => {
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
        .mockRejectedValue(
          Object.assign(new Error('Not Found'), { status: 404 }),
        );

      await pollOnce();

      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).toHaveBeenCalledWith({
        last_read_at: '2026-07-02T10:00:00.000Z',
        read: true,
      });
    });

    describe('transient per-thread GitHub errors', () => {
      const transient = () =>
        Object.assign(new Error('Server Error'), { status: 502 });

      const journal = () => readChannelEvents();
      const journalRows = () =>
        journal().filter((event) => event['reason'] === 'github_api_error');

      async function initFailing() {
        await initWithoutLoop();
        // A running channel: the disconnect() in initWithoutLoop would make a
        // rate-limited read give up instead of retrying.
        (
          channel as unknown as {
            pendingFinalDeliveryRetryStopRequested: boolean;
          }
        ).pendingFinalDeliveryRetryStopRequested = false;
        (
          channel as unknown as {
            abortableSleep: (ms: number) => Promise<void>;
          }
        ).abortableSleep = vi.fn().mockResolvedValue(undefined);
        // A thread whose comment listing succeeds with nothing new falls
        // through to first contact; its body does not mention the bot.
        mockOctokit.rest.issues.get.mockResolvedValue({
          data: {
            title: 'Test Issue',
            body: 'Nothing for the bot here',
            user: { login: 'alice' },
          },
        });
      }

      it('keeps the notification unread and answers the comment on the next poll', async () => {
        await initFailing();
        mockOctokit.paginate
          .mockResolvedValueOnce([makeNotification()])
          .mockRejectedValueOnce(transient())
          .mockRejectedValueOnce(transient())
          .mockRejectedValueOnce(transient());

        await pollOnce();

        expect(channel.inboundEnvelopes).toHaveLength(0);
        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).not.toHaveBeenCalled();
        expect(channel.cursor.lastProcessedAt).toBe('2026-07-01T00:00:00.000Z');
        expect(journalRows()).toEqual([
          expect.objectContaining({
            type: 'inbound',
            outcome: 'failed',
            repository: 'owner/repo',
            thread: 'issue:42',
            number: 42,
          }),
        ]);

        mockOctokit.paginate
          .mockResolvedValueOnce([makeNotification()])
          .mockResolvedValueOnce([makeComment()]);
        await pollOnce();

        expect(channel.inboundEnvelopes.map((e) => e.messageId)).toEqual([
          '1001',
        ]);
        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).toHaveBeenCalledWith({
          last_read_at: '2026-07-02T10:00:00.000Z',
          read: true,
        });
      });

      it('retries a first-contact body whose issue fetch failed transiently', async () => {
        await initFailing();
        mockOctokit.paginate
          .mockResolvedValueOnce([makeNotification()])
          .mockResolvedValueOnce([]);
        mockOctokit.rest.issues.get
          .mockRejectedValueOnce(transient())
          .mockRejectedValueOnce(transient())
          .mockRejectedValueOnce(transient());

        await pollOnce();

        expect(channel.inboundEnvelopes).toHaveLength(0);
        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).not.toHaveBeenCalled();

        mockOctokit.rest.issues.get.mockResolvedValueOnce({
          data: {
            title: 'Test Issue',
            body: '@test-bot the build is red',
            user: { login: 'alice' },
          },
        });
        mockOctokit.paginate
          .mockResolvedValueOnce([makeNotification()])
          .mockResolvedValueOnce([]);
        await pollOnce();

        expect(channel.inboundEnvelopes.map((e) => e.messageId)).toEqual([
          'issue-body-42',
        ]);
        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).toHaveBeenCalledTimes(1);
      });

      it.each([
        [
          'a secondary rate limit without retry-after',
          403,
          'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
          false,
        ],
        ['a network failure, reported as 500', 500, 'fetch failed', false],
        [
          'the older abuse-detection wording',
          403,
          'You have triggered an abuse detection mechanism. Please wait a few minutes before you try again.',
          false,
        ],
        [
          'a SAML-protected repository',
          403,
          'Resource protected by organization SAML enforcement.',
          true,
        ],
        ['a deleted issue', 404, 'Not Found', true],
        ['a 403 whose only signal is retry-after', 403, 'Forbidden', false],
      ])(
        'classifies %s (HTTP %i) for the cursor',
        async (label, status, message, marksRead) => {
          await initFailing();
          mockOctokit.paginate
            .mockResolvedValueOnce([makeNotification()])
            .mockRejectedValue(
              Object.assign(new Error(message), {
                status,
                response: {
                  headers: {
                    'x-ratelimit-remaining': '4999',
                    ...(label.includes('retry-after')
                      ? { 'retry-after': '60' }
                      : {}),
                  },
                },
              }),
            );

          await pollOnce();

          expect(
            mockOctokit.rest.activity.markNotificationsAsRead.mock.calls.length,
          ).toBe(marksRead ? 1 : 0);
          expect(journalRows()).toEqual([
            expect.objectContaining({
              outcome: marksRead ? 'skipped' : 'failed',
            }),
          ]);
        },
      );

      it('gives up on a thread GitHub keeps failing so the cursor cannot freeze', async () => {
        await initFailing();
        mockOctokit.paginate.mockImplementation(async (method: unknown) => {
          if (
            method ===
            mockOctokit.rest.activity.listNotificationsForAuthenticatedUser
          ) {
            return [makeNotification()];
          }
          throw transient();
        });

        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          for (let poll = 1; poll < 30; poll++) await pollOnce();
          expect(
            mockOctokit.rest.activity.markNotificationsAsRead,
          ).not.toHaveBeenCalled();

          await pollOnce();

          // The channel's own line is throttled like the timeline rows.
          expect(
            stderr.mock.calls
              .map((call) => String(call[0]))
              .filter((line) => line.includes('API error processing issue:42'))
              .map((line) => line.match(/\((\d+)\/30\)|skipping/)?.[0]),
          ).toEqual(['(1/30)', '(10/30)', '(20/30)', 'skipping']);
        } finally {
          stderr.mockRestore();
        }

        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).toHaveBeenCalledTimes(1);
        expect(channel.cursor.lastProcessedAt).toBe('2026-07-02T10:00:00.000Z');
        // Reported when the streak starts, every tenth retry and at give-up.
        expect(
          journalRows().map((row) => [
            row['outcome'],
            (row['detail'] as { failures: number }).failures,
          ]),
        ).toEqual([
          ['failed', 1],
          ['failed', 10],
          ['failed', 20],
          ['skipped', 30],
        ]);
      });

      it('begins the hold budget again after a restart', async () => {
        await initFailing();
        const failingThread = async (method: unknown) => {
          if (
            method ===
            mockOctokit.rest.activity.listNotificationsForAuthenticatedUser
          ) {
            return [makeNotification()];
          }
          throw transient();
        };
        mockOctokit.paginate.mockImplementation(failingThread);
        const failures = () =>
          journalRows().map((row) => [
            row['outcome'],
            (row['detail'] as { failures: number }).failures,
          ]);

        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          for (let poll = 1; poll < 30; poll++) await pollOnce();
          expect(failures()).toEqual([
            ['failed', 1],
            ['failed', 10],
            ['failed', 20],
          ]);

          // A restart: the poll loop saves the cursor after every poll, and a
          // fresh instance loads it from disk with the rest of the state.
          (channel as unknown as { saveCursor: () => void }).saveCursor();
          channel = new TestableGithubChannel(
            'test-github',
            makeConfig(),
            makeBridge(),
          );
          expect(channel.cursor.lastProcessedAt).toBe(
            '2026-07-01T00:00:00.000Z',
          );
          mockOctokit.paginate.mockResolvedValueOnce([]);
          await channel.connect();
          channel.disconnect();
          (
            channel as unknown as {
              abortableSleep: (ms: number) => Promise<void>;
            }
          ).abortableSleep = vi.fn().mockResolvedValue(undefined);
          for (let poll = 1; poll < 30; poll++) await pollOnce();
        } finally {
          stderr.mockRestore();
        }

        // The budget is in memory: 29 more polls still hold the window.
        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).not.toHaveBeenCalled();
        expect(channel.cursor.lastProcessedAt).toBe('2026-07-01T00:00:00.000Z');
        expect(failures()).toEqual([
          ['failed', 1],
          ['failed', 10],
          ['failed', 20],
          ['failed', 1],
          ['failed', 10],
          ['failed', 20],
        ]);
      });

      const issueNotification = (n: number, updatedAt?: string) =>
        makeNotification({
          id: String(n),
          updated_at: updatedAt ?? `2026-07-02T0${n}:00:00.000Z`,
          subject: {
            title: `Issue ${n}`,
            url: `https://api.github.com/repos/owner/repo/issues/${n}`,
            type: 'Issue',
          },
        });
      const isListNotifications = (method: unknown) =>
        method ===
        mockOctokit.rest.activity.listNotificationsForAuthenticatedUser;

      it.each([
        [
          'a secondary rate limit 403',
          403,
          'You have exceeded a secondary rate limit',
          {},
        ],
        [
          'an exhausted-budget 403',
          403,
          'API rate limit exceeded',
          { 'x-ratelimit-remaining': '0' },
        ],
        ['a 429', 429, 'Too Many Requests', {}],
        ['a 401', 401, 'Bad credentials', {}],
      ])(
        'stops reading further threads and holds the window on %s',
        async (_label, status, message, headers) => {
          await initFailing();
          const read: number[] = [];
          let poll = 0;
          mockOctokit.paginate.mockImplementation(
            async (method: unknown, params: { issue_number?: number }) => {
              if (isListNotifications(method)) {
                poll += 1;
                return [issueNotification(1), issueNotification(2)];
              }
              read.push(params.issue_number!);
              if (poll === 1) {
                throw Object.assign(new Error(message), {
                  status,
                  response: { headers },
                });
              }
              return [];
            },
          );

          await pollOnce();

          // The limit answered thread 1 (three in-call attempts); thread 2
          // was not read at all, and nothing was marked read.
          expect(read).toEqual([1, 1, 1]);
          expect(
            mockOctokit.rest.activity.markNotificationsAsRead,
          ).not.toHaveBeenCalled();
          expect(journalRows()).toEqual([
            expect.objectContaining({ outcome: 'failed', number: 1 }),
          ]);

          await pollOnce();

          expect(read.slice(3)).toEqual([1, 2]);
          expect(
            mockOctokit.rest.activity.markNotificationsAsRead,
          ).toHaveBeenCalledTimes(1);
        },
      );

      it('skips at once when the failure is a local exception without a status', async () => {
        await initFailing();
        mockOctokit.paginate
          .mockResolvedValueOnce([makeNotification()])
          .mockRejectedValue(new TypeError('unexpected comment shape'));

        await pollOnce();

        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).toHaveBeenCalledTimes(1);
        expect(journalRows()).toEqual([
          expect.objectContaining({ outcome: 'skipped' }),
        ]);
      });

      it('shares one budget between threads that fail one after another', async () => {
        await initFailing();
        let poll = 0;
        mockOctokit.paginate.mockImplementation(
          async (method: unknown, params: { issue_number?: number }) => {
            if (isListNotifications(method)) {
              poll += 1;
              return poll < 15
                ? [issueNotification(1)]
                : [issueNotification(1), issueNotification(2)];
            }
            // Thread 1 fails through poll 15; thread 2 arrives on poll 15
            // and keeps failing.
            if (params.issue_number === 1 ? poll <= 15 : true) {
              throw transient();
            }
            return [];
          },
        );

        for (let i = 0; i < 29; i++) await pollOnce();
        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).not.toHaveBeenCalled();

        await pollOnce();

        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).toHaveBeenCalledTimes(1);
        // Each thread reports its own first and tenth failure, at the
        // window's poll count; the window's 30th failing poll is thread 2's
        // 16th failure.
        expect(
          journalRows().map((row) => {
            const detail = row['detail'] as {
              failures: number;
              heldPolls?: number;
            };
            return [
              row['number'],
              row['outcome'],
              detail.failures,
              detail.heldPolls,
            ];
          }),
        ).toEqual([
          [1, 'failed', 1, 1],
          [1, 'failed', 10, 10],
          [2, 'failed', 1, 15],
          [2, 'failed', 10, 24],
          [2, 'skipped', 16, undefined],
        ]);
      });

      it('reads a cleanly read thread again on every held poll', async () => {
        await initFailing();
        let poll = 0;
        mockOctokit.paginate.mockImplementation(
          async (method: unknown, params: { issue_number?: number }) => {
            if (isListNotifications(method)) {
              poll += 1;
              // Thread 1's notification keeps its timestamp: the comment that
              // arrives on poll 2 lands in the same second.
              return [issueNotification(1), issueNotification(2)];
            }
            if (params.issue_number === 2) throw transient();
            if (poll === 1) return [];
            const at = '2026-07-02T01:00:00.000Z';
            return [makeComment({ id: 7001, created_at: at, updated_at: at })];
          },
        );

        await pollOnce();
        await pollOnce();

        expect(channel.inboundEnvelopes.map((e) => e.messageId)).toEqual([
          '7001',
        ]);
      });

      it('feeds a first-contact body on the poll after a failed comment turn', async () => {
        await initFailing();
        mockOctokit.rest.issues.get.mockResolvedValue({
          data: {
            title: 'Test Issue',
            body: 'please triage this issue',
            user: { login: 'carol' },
          },
        });
        mockOctokit.paginate.mockImplementation(async (method: unknown) =>
          isListNotifications(method)
            ? [makeNotification({ reason: 'subscribed' })]
            : [makeComment({ id: 5000, body: 'a plain comment' })],
        );
        let failed = false;
        channel.handleInboundHook = (envelope) => {
          if (envelope.messageId === '5000' && !failed) {
            failed = true;
            throw new Error('turn failed');
          }
        };

        for (let i = 0; i < 4; i++) await pollOnce();

        expect(channel.inboundEnvelopes.map((e) => e.messageId)).toEqual([
          '5000',
          'issue-body-42',
        ]);
      });

      it('reads a thread again after a poll that could not read the publication audit', async () => {
        await initFailing();
        const audit = inboundTaskPath().replace(
          'github-inbound-tasks.json',
          'github-audit.jsonl',
        );
        // A directory where the audit file belongs cannot be read.
        mkdirSync(audit, { recursive: true });
        mockOctokit.paginate.mockImplementation(async (method: unknown) =>
          isListNotifications(method) ? [makeNotification()] : [makeComment()],
        );

        await pollOnce();
        expect(channel.inboundEnvelopes).toHaveLength(0);
        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).not.toHaveBeenCalled();

        rmSync(audit, { recursive: true });
        await pollOnce();
        expect(channel.inboundEnvelopes.map((e) => e.messageId)).toEqual([
          '1001',
        ]);
      });

      it('keeps the budget when the commit itself fails', async () => {
        await initFailing();
        mockOctokit.paginate.mockImplementation(async (method: unknown) => {
          if (isListNotifications(method)) return [makeNotification()];
          throw transient();
        });
        const markReadError = () =>
          Object.assign(new Error('Server Error'), { status: 500 });
        mockOctokit.rest.activity.markNotificationsAsRead
          .mockRejectedValueOnce(markReadError())
          .mockRejectedValueOnce(markReadError())
          .mockRejectedValueOnce(markReadError());

        for (let i = 0; i < 29; i++) await pollOnce();
        // The 30th poll gives up but cannot mark the window read (three
        // in-call attempts).
        await expect(pollOnce()).rejects.toThrow('Server Error');

        // Still out of budget: the next poll commits instead of holding.
        await pollOnce();
        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).toHaveBeenCalledTimes(4);
        expect(channel.cursor.lastProcessedAt).toBe('2026-07-02T10:00:00.000Z');
      });

      it('keeps threads of two repositories with the same number apart', async () => {
        await initFailing();
        const other = makeNotification({
          id: '200',
          subject: {
            title: 'Other Issue',
            url: 'https://api.github.com/repos/owner/other/issues/42',
            type: 'Issue',
          },
          repository: { full_name: 'owner/other' },
        });
        const read: string[] = [];
        let poll = 0;
        mockOctokit.paginate.mockImplementation(
          async (method: unknown, params: { repo?: string }) => {
            if (isListNotifications(method)) {
              poll += 1;
              return [makeNotification(), other];
            }
            read.push(`${params.repo}:${poll}`);
            // Both fail on poll 1; on poll 2 only the second one still does.
            if (poll === 1 || params.repo === 'other') throw transient();
            return [];
          },
        );

        await pollOnce();
        await pollOnce();

        expect(
          journalRows().map((row) => [
            row['repository'],
            (row['detail'] as { failures: number }).failures,
          ]),
        ).toEqual([
          ['owner/repo', 1],
          ['owner/other', 1],
        ]);
        // Reading owner/repo#42 on poll 2 does not count as reading
        // owner/other#42, which is read again on poll 3.
        await pollOnce();
        expect(read.filter((entry) => entry.startsWith('other:'))).toEqual([
          'other:1',
          'other:1',
          'other:1',
          'other:2',
          'other:2',
          'other:2',
          'other:3',
          'other:3',
          'other:3',
        ]);
      });

      it('restarts the count of a thread that comes back after the window committed', async () => {
        await initFailing();
        let poll = 0;
        mockOctokit.paginate.mockImplementation(
          async (method: unknown, params: { issue_number?: number }) => {
            if (isListNotifications(method)) {
              poll += 1;
              // Thread 1 is read elsewhere after poll 12 and comes back with
              // new activity on poll 14; thread 2 lets poll 13 commit.
              if (poll <= 12) return [issueNotification(1)];
              if (poll === 13) return [issueNotification(2)];
              return [issueNotification(1, '2026-07-02T03:00:00.000Z')];
            }
            if (params.issue_number === 2) return [];
            throw transient();
          },
        );

        for (let i = 0; i < 14; i++) await pollOnce();

        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).toHaveBeenCalledTimes(1);
        const thread1 = journalRows()
          .filter((row) => row['number'] === 1)
          .map((row) => {
            const detail = row['detail'] as {
              failures: number;
              heldPolls: number;
            };
            return [detail.failures, detail.heldPolls];
          });
        // The commit on poll 13 gives the next window a fresh budget.
        expect(thread1).toEqual([
          [1, 1],
          [10, 10],
          [1, 1],
        ]);
      });

      it("skips every thread still failing on the window's 30th failing poll", async () => {
        await initFailing();
        let poll = 0;
        mockOctokit.paginate.mockImplementation(async (method: unknown) => {
          if (isListNotifications(method)) {
            poll += 1;
            // Thread 2 starts failing one poll after thread 1.
            return poll === 1
              ? [issueNotification(1)]
              : [issueNotification(1), issueNotification(2)];
          }
          throw transient();
        });

        for (let i = 0; i < 29; i++) await pollOnce();
        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).not.toHaveBeenCalled();

        await pollOnce();

        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).toHaveBeenCalledTimes(1);
        expect(channel.cursor.lastProcessedAt).toBe('2026-07-02T02:00:00.000Z');
        expect(
          journalRows()
            .filter((row) => row['outcome'] === 'skipped')
            .map((row) => [
              row['number'],
              (row['detail'] as { failures: number }).failures,
            ]),
        ).toEqual([
          [1, 30],
          [2, 29],
        ]);
      });

      it('journals a permanent failure once per window while a 5xx holds it', async () => {
        await initFailing();
        let poll = 0;
        mockOctokit.paginate.mockImplementation(
          async (method: unknown, params: { issue_number?: number }) => {
            if (isListNotifications(method)) {
              poll += 1;
              return [issueNotification(1), issueNotification(2)];
            }
            if (params.issue_number === 1) {
              throw Object.assign(new Error('Not Found'), { status: 404 });
            }
            // Thread 2 holds the window for three polls, then recovers.
            if (poll <= 3) throw transient();
            return [];
          },
        );

        for (let i = 0; i < 4; i++) await pollOnce();

        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).toHaveBeenCalledTimes(1);
        expect(
          journalRows()
            .filter((row) => row['number'] === 1)
            .map((row) => row['outcome']),
        ).toEqual(['skipped']);

        // A new window journals it again.
        await pollOnce();
        expect(
          journalRows()
            .filter((row) => row['number'] === 1)
            .map((row) => row['outcome']),
        ).toEqual(['skipped', 'skipped']);
      });

      it('journals a shared failure on its first and every tenth stopped poll', async () => {
        await initFailing();
        let poll = 0;
        mockOctokit.paginate.mockImplementation(async (method: unknown) => {
          if (isListNotifications(method)) {
            poll += 1;
            return [issueNotification(1)];
          }
          // Rate-limited for twelve polls, then a poll that commits, then
          // the limit again in the next window.
          if (poll <= 12 || poll === 14) {
            throw Object.assign(
              new Error('You have exceeded a secondary rate limit'),
              { status: 403, response: { headers: {} } },
            );
          }
          return [];
        });

        for (let i = 0; i < 14; i++) await pollOnce();

        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).toHaveBeenCalledTimes(1);
        expect(
          journalRows().map(
            (row) => (row['detail'] as { heldPolls: number }).heldPolls,
          ),
        ).toEqual([1, 10, 1]);
      });

      it('journals a skip of a comment re-read by a held window once', async () => {
        await initFailing();
        let poll = 0;
        mockOctokit.paginate.mockImplementation(
          async (method: unknown, params: { issue_number?: number }) => {
            if (isListNotifications(method)) {
              poll += 1;
              // New activity moves thread 1's notification on every poll,
              // so the held window reads its comments again each time.
              return [
                issueNotification(1, `2026-07-02T01:0${poll}:00.000Z`),
                issueNotification(2),
              ];
            }
            if (params.issue_number === 2) throw transient();
            const at = '2026-07-02T00:30:00.000Z';
            return [
              makeComment({ id: 1001, created_at: at, updated_at: at }),
              makeComment({
                id: 1002,
                body: 'no mention',
                created_at: at,
                updated_at: at,
              }),
            ];
          },
        );

        for (let i = 0; i < 3; i++) await pollOnce();

        expect(channel.inboundEnvelopes.map((e) => e.messageId)).toEqual([
          '1001',
        ]);
        expect(
          journal()
            .filter(
              (row) =>
                row['reason'] === 'duplicate' ||
                row['reason'] === 'mention_required',
            )
            .map((row) => [row['reason'], row['messageId']]),
        ).toEqual([
          ['mention_required', 'C_1002'],
          ['duplicate', 'C_1001'],
        ]);
      });

      it('does not spend the 5xx budget on polls a rate limit stopped', async () => {
        await initFailing();
        let poll = 0;
        mockOctokit.paginate.mockImplementation(async (method: unknown) => {
          if (isListNotifications(method)) {
            poll += 1;
            return [issueNotification(1)];
          }
          // Twenty rate-limited polls, then a 5xx on every poll.
          if (poll <= 20) {
            throw Object.assign(new Error('Too Many Requests'), {
              status: 429,
              response: { headers: {} },
            });
          }
          throw transient();
        });

        for (let i = 0; i < 49; i++) await pollOnce();
        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).not.toHaveBeenCalled();

        await pollOnce();

        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).toHaveBeenCalledTimes(1);
      });

      it('journals a give-up once while a rate limit keeps the window held', async () => {
        await initFailing();
        mockOctokit.paginate.mockImplementation(
          async (method: unknown, params: { issue_number?: number }) => {
            if (isListNotifications(method)) {
              return [issueNotification(1), issueNotification(2)];
            }
            if (params.issue_number === 1) throw transient();
            throw Object.assign(new Error('Too Many Requests'), {
              status: 429,
              response: { headers: {} },
            });
          },
        );

        for (let i = 0; i < 45; i++) await pollOnce();

        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).not.toHaveBeenCalled();
        expect(
          journalRows()
            .filter((row) => row['number'] === 1)
            .map((row) => [
              row['outcome'],
              (row['detail'] as { failures: number }).failures,
            ]),
        ).toEqual([
          ['failed', 1],
          ['failed', 10],
          ['failed', 20],
          ['skipped', 30],
        ]);
        expect(
          journalRows()
            .filter((row) => row['number'] === 2)
            .map((row) => (row['detail'] as { heldPolls: number }).heldPolls),
        ).toEqual([1, 10, 20, 30, 40]);
      });

      it('spends no budget while nothing newer waits to be marked read', async () => {
        await initFailing();
        let poll = 0;
        mockOctokit.paginate.mockImplementation(
          async (method: unknown, params: { issue_number?: number }) => {
            if (isListNotifications(method)) {
              poll += 1;
              // Thread 1 stays unread at the cursor (its mark-as-read never
              // applied) and nothing newer arrives until poll 31.
              const stale = issueNotification(1, '2026-07-01T00:00:00.000Z');
              return poll <= 30 ? [stale] : [stale, issueNotification(2)];
            }
            if (params.issue_number === 1 || poll === 31) throw transient();
            const at = '2026-07-02T01:30:00.000Z';
            return [makeComment({ id: 2001, created_at: at, updated_at: at })];
          },
        );

        for (let i = 0; i < 32; i++) await pollOnce();

        // Thread 2's first failure holds the new window; its comment is
        // answered on the next poll, and the stale thread's failures do not
        // keep that window from being marked read.
        expect(
          journalRows()
            .filter((row) => row['number'] === 2)
            .map((row) => row['outcome']),
        ).toEqual(['failed']);
        expect(channel.inboundEnvelopes.map((e) => e.messageId)).toEqual([
          '2001',
        ]);
        expect(
          journalRows()
            .filter((row) => row['number'] === 1)
            .map((row) => row['outcome']),
        ).toEqual(['skipped']);
        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).toHaveBeenCalledTimes(1);
      });

      it('reports a thread as retried while a failing task store holds the window', async () => {
        await initFailing();
        mockOctokit.paginate
          .mockResolvedValueOnce([makeNotification()])
          .mockResolvedValueOnce([makeComment()]);
        const originalRename = nodeFs.renameSync;
        const spy = vi.spyOn(nodeFs, 'renameSync').mockImplementation(((
          from: string,
          to: string,
        ) => {
          if (
            typeof to === 'string' &&
            to.endsWith('-github-inbound-tasks.json')
          ) {
            throw Object.assign(new Error('ENOSPC: no space left on device'), {
              code: 'ENOSPC',
            });
          }
          return (originalRename as (a: string, b: string) => void)(from, to);
        }) as unknown as typeof nodeFs.renameSync);
        try {
          await pollOnce();
        } finally {
          spy.mockRestore();
        }

        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).not.toHaveBeenCalled();
        expect(journalRows()).toEqual([
          expect.objectContaining({ outcome: 'failed', number: 42 }),
        ]);

        mockOctokit.paginate
          .mockResolvedValueOnce([makeNotification()])
          .mockResolvedValueOnce([makeComment()]);
        await pollOnce();
        expect(channel.inboundEnvelopes.map((e) => e.messageId)).toEqual([
          '1001',
        ]);
      });

      it('journals a skip after a retried store failure of the same thread', async () => {
        await initFailing();
        let poll = 0;
        mockOctokit.paginate.mockImplementation(async (method: unknown) => {
          if (isListNotifications(method)) {
            poll += 1;
            return [makeNotification()];
          }
          if (poll === 1) return [makeComment()];
          throw Object.assign(new Error('Not Found'), { status: 404 });
        });
        const originalRename = nodeFs.renameSync;
        const spy = vi.spyOn(nodeFs, 'renameSync').mockImplementation(((
          from: string,
          to: string,
        ) => {
          if (poll === 1 && to.endsWith('-github-inbound-tasks.json')) {
            throw Object.assign(new Error('ENOSPC: no space left on device'), {
              code: 'ENOSPC',
            });
          }
          return (originalRename as (a: string, b: string) => void)(from, to);
        }) as unknown as typeof nodeFs.renameSync);
        try {
          await pollOnce();
          await pollOnce();
        } finally {
          spy.mockRestore();
        }

        expect(journalRows().map((row) => row['outcome'])).toEqual([
          'failed',
          'skipped',
        ]);
      });

      it('skips an HTTP error on another thread while the task store is failing', async () => {
        await initFailing();
        mockOctokit.paginate.mockImplementation(
          async (method: unknown, params: { issue_number?: number }) => {
            if (isListNotifications(method)) {
              return [issueNotification(1), issueNotification(2)];
            }
            if (params.issue_number === 2) {
              throw Object.assign(new Error('Not Found'), { status: 404 });
            }
            const at = '2026-07-02T00:30:00.000Z';
            return [makeComment({ id: 2001, created_at: at, updated_at: at })];
          },
        );
        const originalRename = nodeFs.renameSync;
        const spy = vi.spyOn(nodeFs, 'renameSync').mockImplementation(((
          from: string,
          to: string,
        ) => {
          if (to.endsWith('-github-inbound-tasks.json')) {
            throw Object.assign(new Error('ENOSPC: no space left on device'), {
              code: 'ENOSPC',
            });
          }
          return (originalRename as (a: string, b: string) => void)(from, to);
        }) as unknown as typeof nodeFs.renameSync);
        try {
          await pollOnce();
        } finally {
          spy.mockRestore();
        }

        expect(
          journalRows().map((row) => [row['number'], row['outcome']]),
        ).toEqual([
          [1, 'failed'],
          [2, 'skipped'],
        ]);
      });

      it('journals the give-up of a thread first seen stale', async () => {
        await initFailing();
        let poll = 0;
        mockOctokit.paginate.mockImplementation(async (method: unknown) => {
          if (isListNotifications(method)) {
            poll += 1;
            // Stale on poll 1, then new activity moves it past the cursor.
            return [
              issueNotification(
                1,
                poll === 1
                  ? '2026-07-01T00:00:00.000Z'
                  : '2026-07-02T01:00:00.000Z',
              ),
            ];
          }
          throw transient();
        });

        for (let i = 0; i < 31; i++) await pollOnce();

        expect(
          journalRows().map((row) => [
            row['outcome'],
            (row['detail'] as { failures?: number } | undefined)?.failures,
          ]),
        ).toEqual([
          ['skipped', undefined],
          ['failed', 1],
          ['failed', 10],
          ['failed', 20],
          ['skipped', 30],
        ]);
      });

      it('holds the window when a stale notification hits a rate limit', async () => {
        await initFailing();
        let poll = 0;
        mockOctokit.paginate.mockImplementation(
          async (method: unknown, params: { issue_number?: number }) => {
            if (isListNotifications(method)) {
              poll += 1;
              return [
                issueNotification(1, '2026-07-01T00:00:00.000Z'),
                issueNotification(2),
              ];
            }
            if (params.issue_number === 1) {
              if (poll === 1) {
                throw Object.assign(new Error('Too Many Requests'), {
                  status: 429,
                  response: { headers: {} },
                });
              }
              return [];
            }
            const at = '2026-07-02T01:30:00.000Z';
            return [makeComment({ id: 5001, created_at: at, updated_at: at })];
          },
        );

        await pollOnce();
        // The limit stopped the poll before the newer thread was read.
        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).not.toHaveBeenCalled();
        await pollOnce();

        expect(channel.inboundEnvelopes.map((e) => e.messageId)).toEqual([
          '5001',
        ]);
      });

      it('still reads a thread it gave up on while a rate limit holds the window', async () => {
        await initFailing();
        let poll = 0;
        mockOctokit.paginate.mockImplementation(
          async (method: unknown, params: { issue_number?: number }) => {
            if (isListNotifications(method)) {
              poll += 1;
              return [issueNotification(1), issueNotification(2)];
            }
            if (params.issue_number === 1) {
              // Fails past the budget, then recovers on poll 31.
              if (poll <= 30) throw transient();
              const at = '2026-07-02T00:30:00.000Z';
              return [
                makeComment({ id: 6001, created_at: at, updated_at: at }),
              ];
            }
            // Thread 2 is rate-limited until poll 31 and holds the window.
            if (poll <= 30) {
              throw Object.assign(new Error('Too Many Requests'), {
                status: 429,
                response: { headers: {} },
              });
            }
            return [];
          },
        );

        for (let i = 0; i < 31; i++) await pollOnce();

        expect(channel.inboundEnvelopes.map((e) => e.messageId)).toEqual([
          '6001',
        ]);
      });

      it('reads a thread that failed with a 404 again on the next held poll', async () => {
        await initFailing();
        let poll = 0;
        mockOctokit.paginate.mockImplementation(
          async (method: unknown, params: { issue_number?: number }) => {
            if (isListNotifications(method)) {
              poll += 1;
              return [issueNotification(1), issueNotification(2)];
            }
            if (params.issue_number === 2) throw transient();
            // A just-created issue can read as missing for a moment.
            if (poll === 1) {
              throw Object.assign(new Error('Not Found'), { status: 404 });
            }
            const at = '2026-07-02T00:30:00.000Z';
            return [makeComment({ id: 8001, created_at: at, updated_at: at })];
          },
        );

        await pollOnce();
        await pollOnce();

        expect(channel.inboundEnvelopes.map((e) => e.messageId)).toEqual([
          '8001',
        ]);
      });

      it('reads a stale notification again after its read failed', async () => {
        await initFailing();
        let poll = 0;
        // A late notification at the committed cursor's second: its
        // first-contact body is not bounded by the cursor window.
        const stale = issueNotification(1, '2026-07-01T00:00:00.000Z');
        mockOctokit.paginate.mockImplementation(async (method: unknown) => {
          if (isListNotifications(method)) {
            poll += 1;
            return poll === 1 ? [stale] : [stale, issueNotification(2)];
          }
          return [];
        });
        mockOctokit.rest.issues.get
          .mockRejectedValueOnce(transient())
          .mockRejectedValueOnce(transient())
          .mockRejectedValueOnce(transient())
          .mockResolvedValue({
            data: {
              title: 'Issue 1',
              body: '@test-bot please look at this',
              user: { login: 'alice' },
            },
          });

        await pollOnce();
        await pollOnce();

        expect(channel.inboundEnvelopes.map((e) => e.messageId)).toContain(
          'issue-body-1',
        );
      });

      describe('a local error part-way through a thread', () => {
        // An unreadable pending-deliveries file throws after a comment was
        // claimed: no persistence flag is set, the task stays running and
        // holds the window, and the rest of the thread must be read again.
        const corruptPending = () => {
          const path = inboundTaskPath().replace(
            'github-inbound-tasks.json',
            'github-pending-deliveries.json',
          );
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, '{not json', 'utf-8');
          return path;
        };

        it('still answers the later comments of the thread', async () => {
          await initFailing();
          const pending = corruptPending();
          let poll = 0;
          mockOctokit.paginate.mockImplementation(async (method: unknown) => {
            if (isListNotifications(method)) {
              poll += 1;
              return poll <= 3 ? [makeNotification()] : [];
            }
            return [
              makeComment({ id: 1001 }),
              makeComment({
                id: 1002,
                body: '@test-bot and this too',
                created_at: '2026-07-02T09:30:00.000Z',
                updated_at: '2026-07-02T09:30:00.000Z',
              }),
            ];
          });
          const stderr = vi
            .spyOn(process.stderr, 'write')
            .mockReturnValue(true);
          try {
            await pollOnce();
            await pollOnce();
            rmSync(pending, { force: true });
            await pollOnce();
            await pollOnce();
          } finally {
            stderr.mockRestore();
          }

          expect(channel.inboundEnvelopes.map((e) => e.messageId)).toContain(
            '1002',
          );
          // The claimed task held the window, so the thread was read again.
          expect(journalRows()).toEqual([
            expect.objectContaining({ outcome: 'failed', thread: 'issue:42' }),
          ]);
        });

        it('still reads the comment lane after a failed direct dispatch', async () => {
          await initFailing();
          const pending = corruptPending();
          mockOctokit.rest.pulls.get.mockResolvedValue({
            data: { title: 'PR', user: { login: 'alice' }, state: 'open' },
          });
          let poll = 0;
          mockOctokit.paginate.mockImplementation(async (method: unknown) => {
            if (isListNotifications(method)) {
              poll += 1;
              return poll <= 3
                ? [
                    makeNotification({
                      reason: 'review_requested',
                      subject: {
                        title: 'PR',
                        url: 'https://api.github.com/repos/owner/repo/pulls/42',
                        type: 'PullRequest',
                      },
                    }),
                  ]
                : [];
            }
            if (method === mockOctokit.rest.issues.listEvents) {
              return [makeIssueEvent()];
            }
            return [
              makeComment({
                id: 1001,
                created_at: '2026-07-02T09:30:00.000Z',
                updated_at: '2026-07-02T09:30:00.000Z',
              }),
            ];
          });
          const stderr = vi
            .spyOn(process.stderr, 'write')
            .mockReturnValue(true);
          try {
            await pollOnce();
            await pollOnce();
            rmSync(pending, { force: true });
            await pollOnce();
            await pollOnce();
          } finally {
            stderr.mockRestore();
          }

          expect(channel.inboundEnvelopes.map((e) => e.messageId)).toContain(
            '1001',
          );
          expect(journalRows()).toEqual([
            expect.objectContaining({ outcome: 'failed', thread: 'pr:42' }),
          ]);
        });

        it('reports the skip once the thread no longer holds the window', async () => {
          await initFailing();
          const pending = corruptPending();
          let poll = 0;
          mockOctokit.paginate.mockImplementation(async (method: unknown) => {
            if (isListNotifications(method)) {
              poll += 1;
              return [makeNotification()];
            }
            if (poll === 1) return [makeComment({ id: 1001 })];
            throw Object.assign(new Error('Not Found'), { status: 404 });
          });
          const stderr = vi
            .spyOn(process.stderr, 'write')
            .mockReturnValue(true);
          try {
            await pollOnce();
            expect(
              mockOctokit.rest.activity.markNotificationsAsRead,
            ).not.toHaveBeenCalled();
            // The claimed task settles at the start of the next poll; the
            // thread then fails on its own and the window is marked read.
            rmSync(pending, { force: true });
            await pollOnce();
          } finally {
            stderr.mockRestore();
          }

          expect(
            journalRows().map((row) => [row['outcome'], row['thread']]),
          ).toEqual([
            ['failed', 'issue:42'],
            ['skipped', 'issue:42'],
          ]);
          expect(
            mockOctokit.rest.activity.markNotificationsAsRead,
          ).toHaveBeenCalledTimes(1);
        });

        it("reports another thread skipped while one thread's task holds the window", async () => {
          await initFailing();
          corruptPending();
          mockOctokit.paginate.mockImplementation(
            async (method: unknown, params: { issue_number?: number }) => {
              if (isListNotifications(method)) {
                return [issueNotification(1), issueNotification(2)];
              }
              if (params.issue_number === 1) {
                return [
                  makeComment({
                    created_at: '2026-07-02T00:30:00.000Z',
                    updated_at: '2026-07-02T00:30:00.000Z',
                  }),
                ];
              }
              throw Object.assign(new Error('Not Found'), { status: 404 });
            },
          );
          const stderr = vi
            .spyOn(process.stderr, 'write')
            .mockReturnValue(true);
          try {
            await pollOnce();
          } finally {
            stderr.mockRestore();
          }

          // Thread 1's task holds the window; thread 2 is given up on.
          expect(
            journalRows()
              .map((row) => [row['thread'], row['outcome']])
              .sort(),
          ).toEqual([
            ['issue:1', 'failed'],
            ['issue:2', 'skipped'],
          ]);
          expect(
            mockOctokit.rest.activity.markNotificationsAsRead,
          ).not.toHaveBeenCalled();
        });

        it('reports the thread skipped when its only task no longer holds the window', async () => {
          // A task that used up its attempts no longer holds the cursor.
          writeInboundTasks([
            makeInboundTaskRecord({ state: 'failed', attempts: 3 }),
          ]);
          await initFailing();
          mockOctokit.paginate.mockImplementation(async (method: unknown) => {
            if (isListNotifications(method)) return [makeNotification()];
            throw Object.assign(new Error('Not Found'), { status: 404 });
          });
          const stderr = vi
            .spyOn(process.stderr, 'write')
            .mockReturnValue(true);
          try {
            await pollOnce();
          } finally {
            stderr.mockRestore();
          }

          expect(journalRows()).toEqual([
            expect.objectContaining({ outcome: 'skipped', thread: 'issue:42' }),
          ]);
          expect(
            mockOctokit.rest.activity.markNotificationsAsRead,
          ).toHaveBeenCalledTimes(1);
        });

        it('reports the thread skipped when its task settled before the error', async () => {
          await initFailing();
          mockOctokit.rest.pulls.get.mockResolvedValue({
            data: { title: 'PR', user: { login: 'alice' }, state: 'open' },
          });
          mockOctokit.paginate.mockImplementation(async (method: unknown) => {
            if (isListNotifications(method)) {
              return [
                makeNotification({
                  reason: 'review_requested',
                  subject: {
                    title: 'PR',
                    url: 'https://api.github.com/repos/owner/repo/pulls/42',
                    type: 'PullRequest',
                  },
                }),
              ];
            }
            if (method === mockOctokit.rest.issues.listEvents) {
              return [makeIssueEvent()];
            }
            // The review request was answered; the comment lane then fails
            // locally, with no task of the thread left to hold the window.
            throw new TypeError('cannot read the comment lane');
          });
          const stderr = vi
            .spyOn(process.stderr, 'write')
            .mockReturnValue(true);
          try {
            await pollOnce();
          } finally {
            stderr.mockRestore();
          }

          expect(channel.inboundEnvelopes).toHaveLength(1);
          expect(journalRows()).toEqual([
            expect.objectContaining({ outcome: 'skipped', thread: 'pr:42' }),
          ]);
          expect(
            mockOctokit.rest.activity.markNotificationsAsRead,
          ).toHaveBeenCalledTimes(1);
        });
      });

      it('bounds the per-thread failure counts', async () => {
        await initFailing();
        const failures = (
          channel as unknown as {
            transientNotificationFailures: Map<string, number>;
          }
        ).transientNotificationFailures;
        for (let i = 0; i < 8192; i++) failures.set(`x|issue:${i}`, 1);
        mockOctokit.paginate.mockImplementation(async (method: unknown) => {
          if (isListNotifications(method)) return [issueNotification(1)];
          throw transient();
        });

        await pollOnce();
        await pollOnce();

        expect(failures.size).toBe(8192);
        expect(failures.has('owner/repo|issue:1')).toBe(false);
        // A thread whose count is not kept is still reported once, not on
        // every poll.
        expect(journalRows()).toEqual([
          expect.objectContaining({ outcome: 'failed', thread: 'issue:1' }),
        ]);
      });

      it('bounds the once-per-window journal keys', async () => {
        await initFailing();
        const journalOnce = (
          channel as unknown as {
            journalOncePerWindow: (key: string) => boolean;
          }
        ).journalOncePerWindow.bind(channel);
        const keys = (channel as unknown as { windowJournalKeys: Set<string> })
          .windowJournalKeys;

        for (let i = 0; i < 8192; i++) journalOnce(`k${i}`);
        expect(keys.size).toBe(8192);
        expect(journalOnce('k0')).toBe(false);

        // Past the bound a key is journaled every time, the rest stay quiet.
        expect(journalOnce('one more')).toBe(true);
        expect(journalOnce('one more')).toBe(true);
        expect(journalOnce('k1')).toBe(false);
        expect(keys.size).toBe(8192);
      });
    });

    it('aborts the poll cycle without advancing cursor when markNotificationsAsRead fails', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            updated_at: '2026-07-02T10:00:00.000Z',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([]);
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

    it('does not re-dispatch a replied comment when a frozen cursor slides the ring (R11-A1)', async () => {
      await initWithoutLoop();
      const priv = channel as unknown as {
        abortableSleep: (ms: number) => Promise<void>;
      };
      priv.abortableSleep = vi.fn().mockResolvedValue(undefined);
      // A frozen cursor: mark-read keeps failing, so lastProcessedAt never
      // advances and every unread thread re-lists each poll.
      mockOctokit.rest.activity.markNotificationsAsRead.mockRejectedValue(
        new Error('server error'),
      );
      // Seed a FULL ring with an already-replied comment C_first at the front
      // and 499 expired dummies. C_first is re-listable (created_at newer than
      // the frozen cursor); the dummies are expired.
      const dummies = Array.from({ length: 499 }, (_, i) => `dummy${i}`);
      channel.cursor.dispatchedComments = ['C_first', ...dummies];
      const times: Record<string, string> = {
        C_first: '2026-07-02T09:00:00.000Z',
      };
      for (const d of dummies) times[d] = '2026-06-30T00:00:00.000Z';
      channel.cursor.dispatchedCommentTimes = times;

      // Poll 1: a different thread dispatches one comment, sliding the ring.
      // The old count-based eviction drops C_first (front); window-aware
      // eviction must KEEP it (still re-listable) and drop the expired dummies.
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            subject: {
              title: 'Issue 99',
              url: 'https://api.github.com/repos/owner/repo/issues/99',
              type: 'Issue',
            },
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({
            id: 2001,
            node_id: 'C_2001',
            body: 'other thread remark',
            created_at: '2026-07-02T09:30:00.000Z',
          }),
        ]);
      await pollOnce().catch(() => {});
      expect(channel.cursor.dispatchedComments).toContain('C_first');

      // Poll 2: thread 42 re-lists a SUPERSET batch — the replied C_first plus
      // a brand-new C_new. C_first must stay filtered out so the batch covers
      // only the new comment; otherwise the fresh batch hash misses the audit
      // backstop and C_first is published a SECOND time (no crash involved).
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification({ reason: 'comment' })])
        .mockResolvedValueOnce([
          makeComment({
            id: 1001,
            node_id: 'C_first',
            body: 'first remark already replied',
            created_at: '2026-07-02T09:00:00.000Z',
          }),
          makeComment({
            id: 1002,
            node_id: 'C_new',
            body: 'brand new remark',
            created_at: '2026-07-02T10:00:00.000Z',
          }),
        ]);
      await pollOnce().catch(() => {});

      const last =
        channel.inboundEnvelopes[channel.inboundEnvelopes.length - 1]!;
      expect(last.text).toContain('brand new remark');
      expect(last.text).not.toContain('first remark already replied');
      expect(channel.cursor.lastProcessedAt).toBe('2026-07-01T00:00:00.000Z');
    });

    it('dispatches new comments past a full protected ring without loss (R12-F1)', async () => {
      await initWithoutLoop();
      const priv = channel as unknown as {
        abortableSleep: (ms: number) => Promise<void>;
      };
      priv.abortableSleep = vi.fn().mockResolvedValue(undefined);
      // mark-read HEALTHY: the cursor can advance. A full ring of protected
      // keys must NOT cause new comments to be refused-then-marked-read (the
      // round-11 hard-cap regression silently consumed them). There is no
      // refusal: the comment dispatches and is never lost.
      const keys = Array.from({ length: 4096 }, (_, i) => `prot${i}`);
      channel.cursor.dispatchedComments = [...keys];
      const times: Record<string, string> = {};
      for (const k of keys) times[k] = '2026-07-02T09:00:00.000Z';
      channel.cursor.dispatchedCommentTimes = times;

      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification({ reason: 'comment' })])
        .mockResolvedValueOnce([
          makeComment({
            id: 3001,
            node_id: 'C_new',
            body: 'must not be lost',
            created_at: '2026-07-02T10:00:00.000Z',
          }),
        ]);
      await pollOnce();

      // Dispatched (visible batch), key recorded, cursor advanced — no loss.
      expect(
        channel.inboundEnvelopes.some((e) =>
          e.text.includes('must not be lost'),
        ),
      ).toBe(true);
      expect(channel.cursor.dispatchedComments).toContain('C_new');
      expect(channel.cursor.lastProcessedAt).toBe('2026-07-02T10:00:00.000Z');
    });

    it('protects time-less legacy keys from eviction (R12)', async () => {
      await initWithoutLoop();
      const priv = channel as unknown as {
        evictDispatchedComments: (list: string[]) => string[];
        recordDispatched: (field: string, key: string) => void;
      };
      channel.cursor.lastProcessedAt = '2026-07-01T00:00:00.000Z';
      // 501 keys: one time-less legacy key plus 500 expired keys.
      const expired = Array.from({ length: 500 }, (_, i) => `old${i}`);
      const times: Record<string, string> = {};
      for (const k of expired) times[k] = '2026-06-30T00:00:00.000Z';
      channel.cursor.dispatchedComments = ['legacy', ...expired];
      channel.cursor.dispatchedCommentTimes = times;
      // Eviction over the soft cap drops the expired keys but KEEPS the
      // time-less legacy key (protected; deleting that branch would evict it
      // and reopen the duplicate-superset hole for upgraded deployments).
      const kept = priv.evictDispatchedComments(['legacy', ...expired]);
      expect(kept).toContain('legacy');
      expect(kept).not.toContain('old0');
      // A recovery re-record restores the dedupe key (it must NOT be skipped —
      // the comment may still be re-listable); with no captured time it is
      // protected, the conservative direction.
      channel.cursor.dispatchedComments = [];
      channel.cursor.dispatchedCommentTimes = {};
      priv.recordDispatched('dispatchedComments', 'reRecorded');
      expect(channel.cursor.dispatchedComments).toContain('reRecorded');
      expect(
        priv.evictDispatchedComments([
          'reRecorded',
          ...Array.from({ length: 500 }, (_, i) => `x${i}`),
        ]),
      ).toContain('reRecorded');
    });

    it('prunes fetched comment times on cursor advance even without dispatch (R12-P2)', async () => {
      await initWithoutLoop();
      const priv = channel as unknown as {
        abortableSleep: (ms: number) => Promise<void>;
      };
      priv.abortableSleep = vi.fn().mockResolvedValue(undefined);
      channel.cursor.lastProcessedAt = '2026-07-01T00:00:00.000Z';
      // A mention-lane notification whose comments never mention the bot:
      // fetched (times recorded before filtering) but never dispatched, so
      // recordDispatched never runs. mark-read is healthy.
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'mention',
            updated_at: '2026-07-02T10:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({
            id: 1,
            node_id: 'C_1',
            body: 'no mention here',
            created_at: '2026-07-02T09:00:00.000Z',
          }),
          makeComment({
            id: 2,
            node_id: 'C_2',
            body: 'also no mention',
            created_at: '2026-07-02T09:30:00.000Z',
          }),
        ]);
      await pollOnce();
      // No dispatch (no mention), cursor advanced...
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(channel.cursor.lastProcessedAt).toBe('2026-07-02T10:00:00.000Z');
      // ...and the fetched times were pruned (<= advanced cursor, non-ring)
      // by the per-poll cleanup, not left to accumulate across polls.
      expect(
        Object.keys(channel.cursor.dispatchedCommentTimes ?? {}),
      ).toHaveLength(0);
    });

    it('records fetched comment times from a real poll, not just hand-seeded tests (R2-5)', async () => {
      await initWithoutLoop();
      const priv = channel as unknown as {
        abortableSleep: (ms: number) => Promise<void>;
      };
      priv.abortableSleep = vi.fn().mockResolvedValue(undefined);
      // Freeze the cursor before the comment (mark-read rejects) so the
      // captured time survives the poll's prune; a healthy mark-read would
      // advance past it and drop it (see R12-P2).
      channel.cursor.lastProcessedAt = '2026-07-01T00:00:00.000Z';
      mockOctokit.rest.activity.markNotificationsAsRead.mockRejectedValue(
        new Error('read-only PAT'),
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'mention',
            updated_at: '2026-07-02T10:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({
            id: 1,
            node_id: 'C_1',
            body: 'no mention here',
            created_at: '2026-07-02T09:00:00.000Z',
          }),
        ]);
      await pollOnce().catch(() => {});
      // The real fetch path captured the comment's created_at under its node
      // id; deleting the capture loop in fetchNewComments leaves this empty
      // (every other time-map test seeds the map by hand).
      expect(channel.cursor.dispatchedCommentTimes?.['C_1']).toBe(
        '2026-07-02T09:00:00.000Z',
      );
    });

    it('bounds the comment-time map under a frozen cursor even when mark-read rejects (R13-M1)', async () => {
      await initWithoutLoop();
      const priv = channel as unknown as {
        abortableSleep: (ms: number) => Promise<void>;
      };
      priv.abortableSleep = vi.fn().mockResolvedValue(undefined);
      // mark-read fails (read-only PAT / rate limit): the cursor freezes and
      // pollOnce rejects at the commit. The per-poll prune runs in a finally
      // around the commit, so it still runs against the frozen cursor WHEN
      // that throw rejects the poll — otherwise the map grows without bound
      // under the very outage it is bounded for.
      mockOctokit.rest.activity.markNotificationsAsRead.mockRejectedValue(
        new Error('read-only PAT'),
      );
      channel.cursor.lastProcessedAt = '2026-07-01T00:00:00.000Z';
      // 9000 re-listable non-ring times plus 5 ring keys whose times must
      // survive the cap; all newer than the frozen cursor.
      const times: Record<string, string> = {};
      for (let i = 0; i < 9000; i++) {
        times[`ambient${i}`] = '2026-07-02T09:00:00.000Z';
      }
      const ringKeys = ['ring0', 'ring1', 'ring2', 'ring3', 'ring4'];
      for (const k of ringKeys) times[k] = '2026-07-02T09:00:00.000Z';
      channel.cursor.dispatchedCommentTimes = times;
      channel.cursor.dispatchedComments = [...ringKeys];
      // A notification advances pendingCursorUpdatedAt so the commit gate
      // runs mark-read (and throws); its comment is not a mention, so nothing
      // dispatches and the mid-poll prune never runs either.
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'mention',
            updated_at: '2026-07-02T10:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({
            body: 'no mention here',
            created_at: '2026-07-02T09:00:00.000Z',
          }),
        ]);
      await pollOnce().catch(() => {});

      const after = channel.cursor.dispatchedCommentTimes ?? {};
      expect(Object.keys(after).length).toBeLessThanOrEqual(8192);
      for (const k of ringKeys) expect(after[k]).toBeDefined();
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

    it('marks the per-comment display cut in the aggregate prompt (R1-1)', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            last_read_at: '2026-07-01T12:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([
          // 5 + 490 + 17 = 512 code points: the 400-char display cap cuts
          // 112, and the cut must be visible (the comment is already in
          // dispatchedComments, so a silent cut loses the tail everywhere).
          makeComment({ body: `HEAD ${'b'.repeat(490)} TAIL-INSTRUCTION` }),
        ]);

      await pollOnce();

      const text = channel.inboundEnvelopes[0]!.text;
      expect(text).toContain('HEAD');
      expect(text).toContain('[comment truncated: 112 more characters]');
      expect(text).not.toContain('TAIL-INSTRUCTION');
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
      // Stop the poll loop but not the publication retries: disconnect()
      // would also make a rate-limit retry give up, and these cases exercise
      // the retries. Stopping the loop aborts the controller that a retry wait
      // without a signal sleeps on, so such a wait ends at once; a case that
      // checks a wait stubs sleepForRetry and asserts its calls.
      (channel as unknown as { stopPollLoop: () => void }).stopPollLoop();
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
        outcome: 'failed_ambiguous',
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

    it('keeps every pending final and stops the pass on a secondary rate limit', async () => {
      writePending([
        pendingRecord({ id: 'first', sourceMessageId: '1001' }),
        pendingRecord({ id: 'second', sourceMessageId: '1002' }),
      ]);
      mockOctokit.rest.issues.createComment.mockRejectedValue(
        Object.assign(
          new Error(
            'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
          ),
          {
            status: 403,
            response: { headers: { 'x-ratelimit-remaining': '4999' } },
          },
        ),
      );

      await retryPendingForTest();

      // One record's attempts only: the limit answers the rest the same way.
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(3);
      expect(
        JSON.parse(readFileSync(pendingPath(), 'utf-8')).map(
          (record: { id: string }) => record.id,
        ),
      ).toEqual(['first', 'second']);
      expect(existsSync(auditPath())).toBe(false);
    });

    it('stops the pass on an exhausted hourly budget as well', async () => {
      writePending([
        pendingRecord({ id: 'first', sourceMessageId: '1001' }),
        pendingRecord({ id: 'second', sourceMessageId: '1002' }),
      ]);
      mockOctokit.rest.issues.createComment.mockRejectedValue(
        Object.assign(new Error('API rate limit exceeded'), {
          status: 403,
          response: { headers: { 'x-ratelimit-remaining': '0' } },
        }),
      );

      await retryPendingForTest();

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(3);
      expect(
        JSON.parse(readFileSync(pendingPath(), 'utf-8')).map(
          (record: { id: string }) => record.id,
        ),
      ).toEqual(['first', 'second']);
    });

    it('audits and drops an ambiguous answer that arrives after the stop', async () => {
      writePending([
        pendingRecord({ id: 'first', sourceMessageId: '1001' }),
        pendingRecord({
          id: 'second',
          threadId: 'issue:43',
          sourceMessageId: '1002',
        }),
      ]);
      const abort = new AbortController();
      // The stop lands while the write is in flight; its abort fires once the
      // write ends, which here ends with an answer that may have posted it.
      mockOctokit.rest.issues.createComment.mockImplementationOnce(async () => {
        abort.abort();
        throw Object.assign(new Error('Bad Gateway'), { status: 502 });
      });
      const privateChannel = channel as unknown as {
        octokit: typeof mockOctokit;
        retryPendingFinalDeliveries: (signal?: AbortSignal) => Promise<void>;
      };
      privateChannel.octokit = mockOctokit as never;

      await privateChannel.retryPendingFinalDeliveries(abort.signal);

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(readFileSync(pendingPath(), 'utf-8')).map(
          (record: { id: string }) => record.id,
        ),
      ).toEqual(['second']);
      expect(readFileSync(auditPath(), 'utf-8')).toContain(
        '"outcome":"failed_ambiguous"',
      );
    });

    it('keeps the records when a stop deferred by another write lets the wait run out', async () => {
      writePending([
        pendingRecord({ id: 'first', sourceMessageId: '1001' }),
        pendingRecord({
          id: 'second',
          threadId: 'issue:43',
          sourceMessageId: '1002',
        }),
      ]);
      mockOctokit.rest.issues.createComment.mockRejectedValue(
        Object.assign(new Error('You have exceeded a secondary rate limit'), {
          status: 403,
          response: { headers: { 'x-ratelimit-remaining': '4999' } },
        }),
      );
      const privateChannel = channel as unknown as {
        octokit: typeof mockOctokit;
        sleepForRetry: (ms: number) => Promise<void>;
        pendingFinalDeliveryRequestsActive: number;
        retryPendingFinalDeliveries: (signal?: AbortSignal) => Promise<void>;
      };
      privateChannel.octokit = mockOctokit as never;
      // Another write is in flight when the channel stops, so the pass's
      // abort waits for it and the retry wait simply ends.
      privateChannel.sleepForRetry = vi.fn().mockImplementation(async () => {
        privateChannel.pendingFinalDeliveryRequestsActive += 1;
        channel.disconnect();
        privateChannel.pendingFinalDeliveryRequestsActive -= 1;
      });

      await privateChannel.retryPendingFinalDeliveries(
        new AbortController().signal,
      );

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(readFileSync(pendingPath(), 'utf-8')).map(
          (record: { id: string }) => record.id,
        ),
      ).toEqual(['first', 'second']);
      expect(existsSync(auditPath())).toBe(false);
    });

    it('keeps a record whose retry an abort stopped before it was sent', async () => {
      writePending([pendingRecord({ id: 'first', sourceMessageId: '1001' })]);
      const abort = new AbortController();
      mockOctokit.rest.issues.createComment.mockRejectedValue(
        Object.assign(new Error('You have exceeded a secondary rate limit'), {
          status: 403,
          response: { headers: { 'x-ratelimit-remaining': '4999' } },
        }),
      );
      const privateChannel = channel as unknown as {
        octokit: typeof mockOctokit;
        sleepForRetry: (ms: number) => Promise<void>;
        retryPendingFinalDeliveries: (signal?: AbortSignal) => Promise<void>;
      };
      privateChannel.octokit = mockOctokit as never;
      // The abort ends the wait without a stop request (a reconnect).
      privateChannel.sleepForRetry = vi.fn().mockImplementation(async () => {
        abort.abort();
      });

      await privateChannel.retryPendingFinalDeliveries(abort.signal);

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(readFileSync(pendingPath(), 'utf-8')).map(
          (record: { id: string }) => record.id,
        ),
      ).toEqual(['first']);
      expect(existsSync(auditPath())).toBe(false);
    });

    it("stops the pass after a rate limit that GitHub's header does not vouch for", async () => {
      writePending([
        pendingRecord({ id: 'first', sourceMessageId: '1001' }),
        pendingRecord({
          id: 'second',
          threadId: 'issue:43',
          sourceMessageId: '1002',
        }),
        pendingRecord({
          id: 'third',
          threadId: 'issue:44',
          sourceMessageId: '1003',
        }),
      ]);
      mockOctokit.rest.issues.createComment.mockRejectedValue(
        Object.assign(new Error('Too Many Requests'), {
          status: 429,
          response: { headers: { 'retry-after': '30' } },
        }),
      );

      await retryPendingForTest();

      // The first may have been written, so it is dropped; the others wait.
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(readFileSync(pendingPath(), 'utf-8')).map(
          (record: { id: string }) => record.id,
        ),
      ).toEqual(['second', 'third']);
      expect(readFileSync(auditPath(), 'utf-8')).toContain(
        '"outcome":"failed_ambiguous"',
      );
    });

    it('starts no further record once the channel stops during the pass', async () => {
      writePending([
        pendingRecord({ id: 'first', sourceMessageId: '1001' }),
        pendingRecord({
          id: 'second',
          threadId: 'issue:43',
          sourceMessageId: '1002',
        }),
      ]);
      // The stop lands while the first record's write is in flight; the
      // pass's own signal stays live, as when another write defers the abort.
      mockOctokit.rest.issues.createComment.mockImplementationOnce(async () => {
        channel.disconnect();
        return {
          data: {
            id: 2011,
            html_url:
              'https://github.com/owner/repo/issues/42#issuecomment-2011',
          },
        };
      });
      const privateChannel = channel as unknown as {
        octokit: typeof mockOctokit;
        retryPendingFinalDeliveries: (signal?: AbortSignal) => Promise<void>;
      };
      privateChannel.octokit = mockOctokit as never;

      await privateChannel.retryPendingFinalDeliveries(
        new AbortController().signal,
      );

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(readFileSync(pendingPath(), 'utf-8')).map(
          (record: { id: string }) => record.id,
        ),
      ).toEqual(['second']);
    });

    it('still drops a later record already posted once the pass stops on a rate limit', async () => {
      writePending([
        pendingRecord({ id: 'first', sourceMessageId: '1001' }),
        pendingRecord({
          id: 'kept',
          threadId: 'issue:44',
          sourceMessageId: '1003',
        }),
        pendingRecord({
          id: 'second',
          threadId: 'issue:43',
          sourceMessageId: '1002',
        }),
      ]);
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'reply_pending',
          envelope: undefined,
          source: {
            chatId: 'owner/repo',
            threadId: 'issue:43',
            messageId: '1002',
          },
        }),
      ]);
      mkdirSync(join(auditPath(), '..'), { recursive: true });
      writeFileSync(
        auditPath(),
        `${JSON.stringify({
          at: '2026-07-30T00:01:00.000Z',
          type: 'github_publication',
          outcome: 'posted',
          channel: 'test-github',
          repository: 'owner/repo',
          number: 43,
          sessionId: 'session-publication',
          threadId: 'issue:43',
          pendingId: 'second',
        })}\n`,
      );
      mockOctokit.rest.issues.createComment.mockRejectedValue(
        Object.assign(new Error('You have exceeded a secondary rate limit'), {
          status: 403,
          response: { headers: { 'x-ratelimit-remaining': '4999' } },
        }),
      );

      await retryPendingForTest();

      // No request for the posted record: only its stale entry goes.
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(3);
      expect(
        mockOctokit.rest.issues.createComment.mock.calls.every(
          ([request]) => request.issue_number === 42,
        ),
      ).toBe(true);
      expect(
        JSON.parse(readFileSync(pendingPath(), 'utf-8')).map(
          (record: { id: string }) => record.id,
        ),
      ).toEqual(['first', 'kept']);
      expect(existsSync(inboundTaskPath())).toBe(false);
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
        outcome: 'failed_ambiguous',
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
          outcome: 'failed_ambiguous',
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

    it.each([
      ['without headers', undefined],
      ['with only retry-after', { 'retry-after': '30' }],
    ])(
      'keeps bare 429 publication failures single-shot (%s)',
      async (_label, headers) => {
        await connectForPublication();
        const error = Object.assign(new Error('secondary rate limit'), {
          status: 429,
          ...(headers ? { response: { headers } } : {}),
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
          publish(
            'owner/repo',
            'issue:42',
            'Final reply',
            'session-publication',
          ),
        ).rejects.toMatchObject({ cause: error });
        expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
        expect(existsSync(pendingPath())).toBe(false);
        // It may have been posted: the key stays consumed.
        expect(readFileSync(auditPath(), 'utf-8')).toContain(
          '"outcome":"failed_ambiguous"',
        );
      },
    );

    it('audits an ambiguous publication failure as failed_ambiguous, keeping the key consumed (R6-A3)', async () => {
      await connectForPublication();
      const error = Object.assign(new Error('bad gateway'), { status: 502 });
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
      const audit = readFileSync(auditPath(), 'utf-8');
      // A 502 may have landed the comment: the verdict must NOT unlock the
      // key for retry (a second public reply would be irreversible).
      expect(audit).toContain('"outcome":"failed_ambiguous"');
      expect(audit).not.toContain('"outcome":"failed"');
      expect(existsSync(pendingPath())).toBe(false);
    });

    it('audits a definite no-write publication failure as retryable failed (R6-A3)', async () => {
      await connectForPublication();
      const error = Object.assign(new Error('secondary rate limit'), {
        status: 429,
        response: { headers: { 'x-ratelimit-remaining': 0 } },
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
      const audit = readFileSync(auditPath(), 'utf-8');
      // remaining=0 proves the write never landed: retryable, and the
      // pending final delivery is enqueued for the retry lane.
      expect(audit).toContain('"outcome":"failed"');
      expect(audit).not.toContain('"outcome":"failed_ambiguous"');
      expect(existsSync(pendingPath())).toBe(true);
    });

    const SECONDARY_LIMIT =
      'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.';
    it.each([
      [
        'a 403 with retry-after',
        403,
        SECONDARY_LIMIT,
        { 'retry-after': '60' },
        [60_000, 60_000],
      ],
      ['a bare 403', 403, SECONDARY_LIMIT, {}, [60_000, 120_000]],
      [
        'a 403 with retry-after and other wording',
        403,
        'Forbidden',
        { 'retry-after': '30' },
        [30_000, 30_000],
      ],
      ['a 429', 429, SECONDARY_LIMIT, {}, [60_000, 120_000]],
      [
        'the older abuse-detection wording',
        403,
        'You have triggered an abuse detection mechanism. Please wait a few minutes before you try again.',
        {},
        [60_000, 120_000],
      ],
    ])(
      'retries the final reply, then keeps it pending, on a secondary rate limit sent as %s',
      async (_label, status, message, extraHeaders, waits) => {
        await connectForPublication();
        // The retry cooldown alone: the poll loop's own interval sleep shares
        // abortableSleep and would interleave with these values.
        const sleep = vi.fn().mockResolvedValue(undefined);
        (
          channel as unknown as {
            sleepForRetry: (ms: number) => Promise<void>;
          }
        ).sleepForRetry = sleep;
        const error = Object.assign(
          new Error(`${message} - https://docs.github.com/rest`),
          {
            status,
            response: {
              headers: { 'x-ratelimit-remaining': '4999', ...extraHeaders },
            },
          },
        );
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
          publish(
            'owner/repo',
            'issue:42',
            'Final reply',
            'session-publication',
          ),
        ).rejects.toMatchObject({ cause: error });
        expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(3);
        expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(waits);
        const audit = readFileSync(auditPath(), 'utf-8');
        expect(audit).toContain('"outcome":"failed"');
        expect(audit).not.toContain('"outcome":"failed_ambiguous"');
        expect(JSON.parse(readFileSync(pendingPath(), 'utf-8'))).toEqual([
          expect.objectContaining({
            threadId: 'issue:42',
            fullText: 'Final reply',
          }),
        ]);
      },
    );

    it('posts the final reply once when GitHub accepts the retry after a secondary limit', async () => {
      await connectForPublication();
      const sleep = vi.fn().mockResolvedValue(undefined);
      (
        channel as unknown as {
          sleepForRetry: (ms: number) => Promise<void>;
        }
      ).sleepForRetry = sleep;
      mockOctokit.rest.issues.createComment
        .mockRejectedValueOnce(
          Object.assign(
            new Error(`${SECONDARY_LIMIT} - https://docs.github.com/rest`),
            {
              status: 403,
              response: { headers: { 'x-ratelimit-remaining': '4999' } },
            },
          ),
        )
        .mockResolvedValueOnce({
          data: {
            id: 2010,
            html_url:
              'https://github.com/owner/repo/issues/42#issuecomment-2010',
          },
        });
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
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([60_000]);
      const audit = readFileSync(auditPath(), 'utf-8');
      expect(audit).toContain('"outcome":"posted"');
      expect(audit).not.toContain('"outcome":"failed');
      expect(existsSync(pendingPath())).toBe(false);
    });

    it.each([
      [
        'retry-after',
        SECONDARY_LIMIT,
        { 'x-ratelimit-remaining': '4999', 'retry-after': '30' },
      ],
      [
        'an exhausted budget and its reset',
        'API rate limit exceeded',
        {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 3600),
        },
      ],
      [
        'an exhausted budget without a reset',
        'API rate limit exceeded',
        { 'x-ratelimit-remaining': '0' },
      ],
      [
        'the secondary-limit wording',
        SECONDARY_LIMIT,
        { 'x-ratelimit-remaining': '4999' },
      ],
    ])(
      'keeps the final reply pending, without an immediate retry, when a stop ends a wait set by %s',
      async (_label, message, headers) => {
        await connectForPublication();
        // The channel stops while the reply waits out the limit.
        const sleep = vi.fn().mockImplementation(async () => {
          channel.disconnect();
        });
        (
          channel as unknown as {
            sleepForRetry: (ms: number) => Promise<void>;
          }
        ).sleepForRetry = sleep;
        const error = Object.assign(
          new Error(`${message} - https://docs.github.com/rest`),
          { status: 403, response: { headers } },
        );
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
          publish(
            'owner/repo',
            'issue:42',
            'Final reply',
            'session-publication',
          ),
        ).rejects.toMatchObject({ cause: error });
        expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledTimes(1);
        const audit = readFileSync(auditPath(), 'utf-8');
        expect(audit).toContain('"outcome":"failed"');
        expect(audit).not.toContain('"outcome":"failed_ambiguous"');
        expect(JSON.parse(readFileSync(pendingPath(), 'utf-8'))).toEqual([
          expect.objectContaining({ fullText: 'Final reply' }),
        ]);
      },
    );

    it('keeps a reply single-shot when the budget header is a negative number', async () => {
      await connectForPublication();
      const error = Object.assign(new Error('Forbidden'), {
        status: 403,
        response: {
          headers: { 'x-ratelimit-remaining': -1, 'retry-after': '30' },
        },
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

    it('neither waits nor retries a reply that starts after the stop', async () => {
      await connectForPublication();
      channel.disconnect();
      const sleep = vi.fn().mockResolvedValue(undefined);
      (
        channel as unknown as {
          sleepForRetry: (ms: number) => Promise<void>;
        }
      ).sleepForRetry = sleep;
      const error = Object.assign(new Error(SECONDARY_LIMIT), {
        status: 403,
        response: { headers: { 'x-ratelimit-remaining': '4999' } },
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

      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await expect(
          publish(
            'owner/repo',
            'issue:42',
            'Final reply',
            'session-publication',
          ),
        ).rejects.toMatchObject({ cause: error });
        expect(
          stderr.mock.calls.some((call) =>
            String(call[0]).includes('retrying in'),
          ),
        ).toBe(false);
      } finally {
        stderr.mockRestore();
      }
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(pendingPath(), 'utf-8'))).toHaveLength(1);
    });

    it('waits and retries again after the channel reconnects', async () => {
      await connectForPublication();
      channel.disconnect();
      await connectForPublication();
      const sleep = vi.fn().mockResolvedValue(undefined);
      (
        channel as unknown as {
          sleepForRetry: (ms: number) => Promise<void>;
        }
      ).sleepForRetry = sleep;
      mockOctokit.rest.issues.createComment.mockRejectedValue(
        Object.assign(new Error(SECONDARY_LIMIT), {
          status: 403,
          response: { headers: { 'x-ratelimit-remaining': '4999' } },
        }),
      );
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
      ).rejects.toBeDefined();
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([60_000, 120_000]);
    });

    it.each([
      [
        'a permission 403',
        403,
        'Resource not accessible by personal access token',
        '4999',
      ],
      [
        'a permission 403 with an empty budget header',
        403,
        'Resource not accessible by personal access token',
        '',
      ],
      [
        'a permission 403 with a leading space in the budget header',
        403,
        'Resource not accessible by personal access token',
        ' 0',
      ],
      [
        'a permission 403 with a trailing space in the budget header',
        403,
        'Resource not accessible by personal access token',
        '0 ',
      ],
      ['a 502 carrying an exhausted budget header', 502, 'Server Error', '0'],
    ])(
      'keeps %s on the final reply single-shot',
      async (_label, status, message, remaining) => {
        await connectForPublication();
        const error = Object.assign(new Error(message), {
          status,
          response: { headers: { 'x-ratelimit-remaining': remaining } },
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
          publish(
            'owner/repo',
            'issue:42',
            'Final reply',
            'session-publication',
          ),
        ).rejects.toMatchObject({ cause: error });
        expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
        expect(readFileSync(auditPath(), 'utf-8')).toContain(
          '"outcome":"failed_ambiguous"',
        );
        expect(existsSync(pendingPath())).toBe(false);
      },
    );

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

    it('sanitizes the failure diagnostic against upstream log-line forgery (R11-B1)', async () => {
      // octokit passes text/plain upstream error bodies through verbatim;
      // a GHE/proxy error can carry raw separators and ANSI escapes. The
      // diagnostic must stay ONE physical log line, like the persisted
      // task error already does.
      const crafted =
        'upstream transient error\u2028[Channel:test-github] preflight rejected reason=sender_denied\u001b[31mFAKE-ALERT\u001b[0m\u0085tail';
      channel.handleInboundError = new Error(crafted);
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment()]);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      let dump = '';
      try {
        await pollOnce();
        dump =
          stderr.mock.calls
            .map((call) => String(call[0]))
            .find((line) => line.includes('handleInbound failed')) ?? '';
      } finally {
        stderr.mockRestore();
      }
      expect(dump).toContain('upstream transient error');
      // eslint-disable-next-line no-control-regex
      expect(dump).not.toMatch(/[\u2028\u2029\u0085\u001b]/);
      expect(dump.endsWith('\n')).toBe(true);
      expect(dump.slice(0, -1)).not.toContain('\n');
      // The task stays recoverable with the sanitized error persisted.
      const tasks = readInboundTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!['state']).toBe('failed');
      const taskError = String(tasks[0]!['error']);
      expect(taskError).not.toMatch(/[\u2028\u2029\u0085]/);
      expect(taskError).not.toContain('\u001b');
    });

    it('sanitizes the API retry diagnostic (R11-B1)', async () => {
      await initWithoutLoop();
      const priv = channel as unknown as {
        abortableSleep: (ms: number) => Promise<void>;
      };
      priv.abortableSleep = vi.fn().mockResolvedValue(undefined);
      const crafted =
        'rate limited\u2028[Channel:test-github] forged retry line\u001b[31mX';
      mockOctokit.paginate
        .mockRejectedValueOnce(
          Object.assign(new Error(crafted), { status: 500 }),
        )
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment()]);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      let dump = '';
      try {
        await pollOnce();
        dump =
          stderr.mock.calls
            .map((call) => String(call[0]))
            .find((line) => line.includes('retrying in')) ?? '';
      } finally {
        stderr.mockRestore();
      }
      expect(dump).toContain('rate limited');
      // eslint-disable-next-line no-control-regex
      expect(dump).not.toMatch(/[\u2028\u2029\u0085\u001b]/);
      expect(dump.endsWith('\n')).toBe(true);
      expect(dump.slice(0, -1)).not.toContain('\n');
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

    it('recovers a persisted task after the store is repaired (issue #16393)', async () => {
      // The store is unreadable at connect and at the first poll's recovery,
      // so the in-memory recoverable count latches at 0. Repairing the file
      // must still be picked up by a later poll: the failed recovery stays
      // armed, and the repaired task runs instead of freezing the cursor.
      class NoPollLoopChannel extends TestableGithubChannel {
        protected override startPollLoop(): void {}
      }
      channel = new NoPollLoopChannel(
        'test-github',
        makeConfig(),
        makeBridge(),
      );
      mkdirSync(join(inboundTaskPath(), '..'), { recursive: true });
      writeFileSync(inboundTaskPath(), '{corrupt', 'utf-8');
      mockOctokit.paginate.mockResolvedValue([]);
      await channel.connect();
      channel.cursor = { lastProcessedAt: '2026-07-01T00:00:00.000Z' };

      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);

      // The operator repairs the store while the daemon keeps running.
      writeInboundTasks([makeInboundTaskRecord()]);
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({ last_read_at: '2026-07-02T09:00:00.000Z' }),
        ])
        .mockResolvedValueOnce([]);

      await pollOnce();

      expect(channel.inboundEnvelopes.map((env) => env.messageId)).toEqual([
        '1001',
      ]);
      expect(existsSync(inboundTaskPath())).toBe(false);
      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).toHaveBeenCalledWith({
        last_read_at: '2026-07-02T10:00:00.000Z',
        read: true,
      });
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
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            last_read_at: '2026-07-02T09:00:00.000Z',
            updated_at: '2026-07-02T10:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([]);

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

    it('acknowledges an aggregate batch on its first comment and removes it on end (R2-2)', async () => {
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
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            subject: {
              title: 'Test PR',
              url: 'https://api.github.com/repos/owner/repo/pulls/42',
              type: 'PullRequest',
            },
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({ id: 1001, body: 'first remark' }),
          makeComment({ id: 1002, body: 'second remark' }),
        ]);

      await liveChannel.pollForTest();

      // The batch messageId is a non-numeric content hash (the dedupe
      // identity); the eyes reaction must still target the batch's FIRST
      // comment instead of silently no-op'ing (R2-2).
      expect(
        mockOctokit.rest.reactions.createForIssueComment,
      ).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        comment_id: 1001,
        content: 'eyes',
      });

      // Prompt end removes the reaction from the same anchor comment.
      const batchId = `agg:${createHash('sha256')
        .update(['C_1001', 'C_1002'].sort().join('\n'))
        .digest('hex')
        .slice(0, 40)}`;
      resolveReaction({ data: { id: 9000 } });
      liveChannel.endPromptForTest('owner/repo', 'session-1', batchId);
      await vi.waitFor(() => {
        expect(
          mockOctokit.rest.reactions.deleteForIssueComment,
        ).toHaveBeenCalledWith({
          owner: 'owner',
          repo: 'repo',
          comment_id: 1001,
          reaction_id: 9000,
        });
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

    it('respects the one-day ceiling', () => {
      const ch = new TestableGithubChannel(
        'test',
        makeConfig({ pollInterval: 86_400_000 }),
        makeBridge(),
      );
      expect((ch as unknown as { pollInterval: number }).pollInterval).toBe(
        86_400_000,
      );
    });

    it.each([86_400_001, 172_800_000, 2_592_000_000])(
      'clamps pollInterval %s to the ceiling instead of falling back',
      (value) => {
        // These were honoured before the ceiling existed and are nowhere near
        // Node's 32-bit timer limit, so replacing them with 60s would multiply
        // the poll rate by orders of magnitude. Clamp, do not fall back.
        const ch = new TestableGithubChannel(
          'test',
          makeConfig({ pollInterval: value }),
          makeBridge(),
        );
        expect((ch as unknown as { pollInterval: number }).pollInterval).toBe(
          86_400_000,
        );
      },
    );

    it.each([0.5, 0.001, 0.999])(
      'raises a sub-millisecond pollInterval %s to the documented floor',
      (value) => {
        // The descriptor's lower bound is exclusive, so a fraction passes both
        // the editor and the store; setTimeout then rounds it to ~1ms, which is
        // the hot loop the ceiling exists to prevent, reached from below. The
        // field documents 1 as the minimum, so the runtime has to enforce it.
        const ch = new TestableGithubChannel(
          'test',
          makeConfig({ pollInterval: value }),
          makeBridge(),
        );
        expect((ch as unknown as { pollInterval: number }).pollInterval).toBe(
          1,
        );
      },
    );

    it('keeps a whole millisecond at the floor and just above it', () => {
      for (const value of [1, 2, 60_000]) {
        const ch = new TestableGithubChannel(
          'test',
          makeConfig({ pollInterval: value }),
          makeBridge(),
        );
        expect((ch as unknown as { pollInterval: number }).pollInterval).toBe(
          value,
        );
      }
    });
  });

  describe('plugin', () => {
    it('declares chat_thread as defaultSessionScope', async () => {
      const { plugin } = await import('./index.js');
      expect(plugin.defaultSessionScope).toBe('chat_thread');
    });

    it('declares a bounded poll interval so the form cannot persist a hot loop', async () => {
      const { plugin } = await import('./index.js');
      const field = plugin.management?.fields.find(
        (item) => item.key === 'pollInterval',
      );
      // The ceiling matches the one the Email channel enforces at runtime.
      expect(field).toMatchObject({
        kind: 'number',
        exclusiveMinimum: 0,
        maximum: 86_400_000,
        default: '60000',
      });
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
            dispatchedCommentTimes?: Record<string, string>;
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

    it('filters non-string members from dispatched arrays (R12-F2)', () => {
      // A malformed cursor with null/number/object members must not seed
      // time-less (permanently protected) ring keys that bloat without bound.
      const result = validate({
        lastProcessedAt: '2026-07-01T00:00:00.000Z',
        dispatchedComments: [null, 'C_1', 42, {}, 'C_2', false],
      });
      expect(result?.dispatchedComments).toEqual(['C_1', 'C_2']);
    });

    it('migrates a legacy cursor to an empty time map, keeping keys (R12)', () => {
      // Legacy cursors predate dispatchedCommentTimes: the keys survive and
      // the time map seeds empty, so eviction treats them as protected
      // (time-less) until the cursor passes them — never silently dropped.
      const result = validate({
        lastProcessedAt: '2026-07-01T00:00:00.000Z',
        dispatchedComments: ['C_1', 'C_2'],
      });
      expect(result?.dispatchedComments).toEqual(['C_1', 'C_2']);
      expect(result?.dispatchedCommentTimes).toEqual({});
    });

    it('drops non-parseable comment times to the protected fallback (R12-F4)', () => {
      // A non-parseable persisted time (corruption) must not make a key
      // evictable via a bogus string comparison. Dropping it falls back to
      // time-less = protected, the safe direction (mirrors the lastProcessedAt
      // / metaFloor Date validation).
      const result = validate({
        lastProcessedAt: '2026-07-01T00:00:00.000Z',
        dispatchedComments: ['C_good', 'C_bad'],
        dispatchedCommentTimes: {
          C_good: '2026-07-02T09:00:00.000Z',
          C_bad: 'not-a-date',
          C_num: 123,
        },
      });
      expect(result?.dispatchedCommentTimes).toEqual({
        C_good: '2026-07-02T09:00:00.000Z',
      });
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

    it('waits at least a minute, then longer, on a secondary limit without retry-after', async () => {
      const sleep = stubSleep();
      // GitHub sends the hourly reset with every answer; quota is left, so
      // it does not set this wait.
      const secondary = (status: number) =>
        Object.assign(
          new Error(
            'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
          ),
          {
            status,
            response: {
              headers: {
                'x-ratelimit-remaining': '4999',
                'x-ratelimit-reset': String(
                  Math.ceil(Date.now() / 1000) + 3000,
                ),
              },
            },
          },
        );
      const fn = vi
        .fn()
        .mockRejectedValueOnce(secondary(403))
        .mockRejectedValueOnce(secondary(429))
        .mockResolvedValueOnce('ok');
      await expect(githubApi(fn)).resolves.toBe('ok');
      expect(sleep).toHaveBeenNthCalledWith(1, 60_000);
      expect(sleep).toHaveBeenNthCalledWith(2, 120_000);
    });

    it('lets retry-after override the secondary-limit minimum', async () => {
      const sleep = stubSleep();
      const fn = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('You have exceeded a secondary rate limit'), {
            status: 403,
            response: {
              headers: { 'x-ratelimit-remaining': '4999', 'retry-after': '5' },
            },
          }),
        )
        .mockResolvedValueOnce('ok');
      await expect(githubApi(fn)).resolves.toBe('ok');
      expect(sleep).toHaveBeenCalledWith(5000);
    });

    it('waits for the reset, not the secondary minimum, when the budget is exhausted', async () => {
      const now = 1_700_000_000_000;
      const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
      const sleep = stubSleep();
      const fn = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('You have exceeded a secondary rate limit'), {
            status: 403,
            response: {
              headers: {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(now / 1000 + 5),
              },
            },
          }),
        )
        .mockResolvedValueOnce('ok');
      await expect(githubApi(fn)).resolves.toBe('ok');
      expect(sleep).toHaveBeenCalledWith(6000);
      dateSpy.mockRestore();
    });

    it.each([
      ['an HTTP date', 'Wed, 21 Oct 2026 07:28:00 GMT'],
      ['zero seconds', '0'],
      ['infinite', 'Infinity'],
    ])(
      'keeps the secondary-limit minimum when retry-after is %s',
      async (_label, retryAfter) => {
        const sleep = stubSleep();
        const fn = vi
          .fn()
          .mockRejectedValueOnce(
            Object.assign(
              new Error('You have exceeded a secondary rate limit'),
              {
                status: 403,
                response: {
                  headers: {
                    'x-ratelimit-remaining': '4999',
                    'retry-after': retryAfter,
                  },
                },
              },
            ),
          )
          .mockResolvedValueOnce('ok');
        await expect(githubApi(fn)).resolves.toBe('ok');
        expect(sleep).toHaveBeenCalledWith(60_000);
      },
    );

    it('waits the rate-limit minimum when retry-after is unusable and the wording differs', async () => {
      const sleep = stubSleep();
      const fn = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('Forbidden'), {
            status: 403,
            response: {
              headers: {
                'x-ratelimit-remaining': '4999',
                'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT',
              },
            },
          }),
        )
        .mockResolvedValueOnce('ok');
      await expect(githubApi(fn)).resolves.toBe('ok');
      expect(sleep).toHaveBeenCalledWith(60_000);
    });

    it('matches the secondary-limit wording in any letter case', async () => {
      const sleep = stubSleep();
      const fn = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('Secondary Rate Limit exceeded'), {
            status: 429,
            response: { headers: {} },
          }),
        )
        .mockResolvedValueOnce('ok');
      await expect(githubApi(fn)).resolves.toBe('ok');
      expect(sleep).toHaveBeenCalledWith(60_000);
    });

    it('keeps the short backoff for a server error that quotes the secondary-limit wording', async () => {
      const sleep = stubSleep();
      const fn = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('You have exceeded a secondary rate limit'), {
            status: 500,
            response: { headers: {} },
          }),
        )
        .mockResolvedValueOnce('ok');
      await expect(githubApi(fn)).resolves.toBe('ok');
      expect(sleep).toHaveBeenCalledWith(1000);
    });

    it('keeps the short backoff for a server error carrying an exhausted budget', async () => {
      const now = 1_700_000_000_000;
      const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
      const sleep = stubSleep();
      const fn = vi
        .fn()
        .mockRejectedValueOnce(
          httpError(502, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(now / 1000 + 600),
          }),
        )
        .mockResolvedValueOnce('ok');
      await expect(githubApi(fn)).resolves.toBe('ok');
      expect(sleep).toHaveBeenCalledWith(1000);
      dateSpy.mockRestore();
    });

    it('waits the rate-limit minimum when the budget reset looks past', async () => {
      const now = 1_700_000_000_000;
      const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
      const sleep = stubSleep();
      const fn = vi
        .fn()
        .mockRejectedValueOnce(
          httpError(403, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(now / 1000 - 10),
          }),
        )
        .mockResolvedValueOnce('ok');
      await expect(githubApi(fn)).resolves.toBe('ok');
      // GitHub still counts the budget as spent: the local clock is ahead.
      expect(sleep).toHaveBeenCalledWith(60_000);
      dateSpy.mockRestore();
    });

    it('caps a very long retry-after at the timer limit', async () => {
      const sleep = stubSleep();
      const fn = vi
        .fn()
        .mockRejectedValueOnce(httpError(429, { 'retry-after': '1e10' }))
        .mockResolvedValueOnce('ok');
      await expect(githubApi(fn)).resolves.toBe('ok');
      expect(sleep).toHaveBeenCalledWith(2_147_483_647);
    });

    it('gives up after a retry-after wait that a stop ended', async () => {
      const sleep = vi.fn().mockImplementation(async () => {
        channel.disconnect();
      });
      (
        channel as unknown as {
          abortableSleep: (ms: number) => Promise<void>;
        }
      ).abortableSleep = sleep;
      const fn = vi
        .fn()
        .mockRejectedValue(httpError(503, { 'retry-after': '7' }));
      await expect(githubApi(fn)).rejects.toThrow('HTTP 503');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(7000);
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

    it('strips a bare trailing slash from the baseUrl', async () => {
      await expect(
        connectAndReadWebOrigin(
          makeConfig({ baseUrl: 'https://github.example.com/' }),
        ),
      ).resolves.toBe('https://github.example.com');
      await expect(
        connectAndReadWebOrigin(
          makeConfig({ baseUrl: 'https://api.github.com/' }),
        ),
      ).resolves.toBe('https://github.com');
    });
  });

  describe('event journal', () => {
    const readJournal = (channelName = 'test-github') =>
      readChannelEvents(channelName).filter(
        (event) => event['type'] !== 'poll',
      );

    it('records a notification dropped by reasonFilter before any session exists', async () => {
      await initWithoutLoop({ reasonFilter: ['mention'] });
      mockOctokit.paginate.mockResolvedValueOnce([
        makeNotification({ reason: 'comment' }),
      ]);

      await pollOnce();

      expect(readJournal()).toEqual([
        expect.objectContaining({
          channel: 'test-github',
          type: 'inbound',
          outcome: 'skipped',
          reason: 'reason_filter',
          triggerKind: 'comment',
          repository: 'owner/repo',
          thread: 'issue:42',
          number: 42,
        }),
      ]);
    });

    function filteredFlood(count: number) {
      return Array.from({ length: count }, (_, index) =>
        makeNotification({
          id: `flood-${index}`,
          reason: 'comment',
          subject: {
            title: `Issue ${index}`,
            url: `https://api.github.com/repos/owner/repo/issues/${100 + index}`,
            type: 'Issue',
          },
        }),
      );
    }

    it('collapses a flood of filtered notifications into one counted row', async () => {
      // A task that failed and is still retryable keeps the poll cursor put, so
      // the same filtered notifications come back on every poll. Only the first
      // few are journaled individually; the rest become one row carrying the
      // count, so a busy repository cannot rotate the useful rows out of the
      // page's window.
      await initWithoutLoop({ reasonFilter: ['mention'] });
      mockOctokit.paginate.mockResolvedValueOnce(filteredFlood(25));

      await pollOnce();

      const events = readJournal();
      expect(events).toHaveLength(21);
      const individual = events.filter(
        (event) => event['detail'] === undefined,
      );
      expect(individual).toHaveLength(20);
      expect(individual[0]).toMatchObject({
        reason: 'reason_filter',
        thread: 'issue:100',
        number: 100,
      });
      expect(individual.at(-1)).toMatchObject({
        thread: 'issue:119',
        number: 119,
      });
      expect(events.at(-1)).toEqual(
        expect.objectContaining({
          type: 'inbound',
          outcome: 'skipped',
          reason: 'reason_filter',
          detail: { filtered: 5 },
        }),
      );
      expect(events.at(-1)).not.toHaveProperty('repository');
      expect(events.at(-1)).not.toHaveProperty('thread');
    });

    it('resets the collapse budget on the next poll', async () => {
      await initWithoutLoop({ reasonFilter: ['mention'] });
      const flood = filteredFlood(25);
      mockOctokit.paginate
        .mockResolvedValueOnce(flood)
        .mockResolvedValueOnce(flood);

      await pollOnce();
      await pollOnce();

      const events = readJournal();
      expect(events).toHaveLength(42);
      const counted = events.filter(
        (event) =>
          (event['detail'] as { filtered?: number } | undefined)?.filtered !==
          undefined,
      );
      expect(counted).toHaveLength(2);
      expect(
        counted.every((event) => event['detail']?.['filtered'] === 5),
      ).toBe(true);
    });

    it('records a comment skipped because it does not mention the bot', async () => {
      await initWithoutLoop();
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification({ reason: 'mention' })])
        .mockResolvedValueOnce([makeComment({ body: 'no mention here' })]);
      mockOctokit.rest.issues.get.mockResolvedValue({
        data: { title: 'Test Issue', body: '', user: { login: 'alice' } },
      });

      await pollOnce();

      expect(readJournal()).toEqual([
        expect.objectContaining({
          type: 'inbound',
          outcome: 'skipped',
          reason: 'mention_required',
          messageId: 'C_1001',
          actor: 'alice',
        }),
      ]);
    });

    it('records a deduplicated comment', async () => {
      await initWithoutLoop();
      channel.cursor = {
        lastProcessedAt: '2026-07-01T00:00:00.000Z',
        dispatchedComments: ['C_1001'],
      };
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification({ reason: 'mention' })])
        .mockResolvedValueOnce([makeComment()]);
      mockOctokit.rest.issues.get.mockResolvedValue({
        data: { title: 'Test Issue', body: '', user: { login: 'alice' } },
      });

      await pollOnce();

      expect(readJournal()).toEqual([
        expect.objectContaining({
          type: 'inbound',
          outcome: 'skipped',
          reason: 'duplicate',
          messageId: 'C_1001',
        }),
      ]);
    });

    it('records the inbound acceptance, task transitions, and publication', async () => {
      mockOctokit.rest.issues.createComment.mockResolvedValue({
        data: { id: 500, html_url: 'https://github.com/owner/repo/500' },
      });
      const liveChannel = new LiveGithubChannel(
        'test-journal',
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

      expect(readJournal('test-journal')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'inbound',
            outcome: 'accepted',
            repository: 'owner/repo',
            thread: 'issue:42',
            messageId: '1001',
            actor: 'alice',
          }),
          expect.objectContaining({
            type: 'task',
            outcome: 'accepted',
            triggerKind: 'mention',
            number: 42,
          }),
          expect.objectContaining({
            type: 'task',
            outcome: 'running',
            messageId: '1001',
          }),
          expect.objectContaining({
            type: 'outbound',
            outcome: 'posting',
            repository: 'owner/repo',
          }),
          expect.objectContaining({
            type: 'outbound',
            outcome: 'posted',
            sessionId: expect.any(String),
          }),
        ]),
      );
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
    // clearAllMocks keeps implementations, so a persistent issues.get (and
    // the watch describe's persistent paginate routing) would leak in from an
    // earlier test under shuffling: the leftover issue body feeds the
    // first-contact path and the routing shadows a test's own queues.
    mockOctokit.rest.issues.get.mockReset();
    mockOctokit.paginate.mockReset();
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

  function prNotification(
    reason = 'mention',
    overrides: Record<string, unknown> = {},
  ) {
    return makeNotification({
      reason,
      subject: {
        title: 'Test PR',
        url: 'https://api.github.com/repos/owner/repo/pulls/42',
        type: 'PullRequest',
      },
      ...overrides,
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

    it('journals the bound target session and its workspace on task rows', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // A workspace different from the channel's own proves the journal
      // carries the BINDING's owner, not the channel cwd.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [makeBinding({ workspaceCwd: '/work/bound' })],
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      const journalPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'channel-events.jsonl',
      );
      const events = readFileSync(journalPath, 'utf-8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const taskEvents = events.filter((event) => event['type'] === 'task');
      expect(taskEvents.length).toBeGreaterThan(0);
      for (const event of taskEvents) {
        expect(event).toMatchObject({
          sessionId: 'bound-session',
          sessionWorkspaceCwd: '/work/bound',
        });
      }
      // The acceptance and the delivered mark both name the target.
      expect(taskEvents.map((event) => event['outcome'])).toEqual(
        expect.arrayContaining(['accepted', 'running']),
      );
    });

    it('keeps public-path task rows free of a session identity', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // No binding matches this PR, and the complete snapshot proves
      // absence, so the event takes the public channel path.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      const journalPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'channel-events.jsonl',
      );
      const events = readFileSync(journalPath, 'utf-8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const taskEvents = events.filter((event) => event['type'] === 'task');
      expect(taskEvents.length).toBeGreaterThan(0);
      for (const event of taskEvents) {
        expect(event).not.toHaveProperty('sessionId');
        expect(event).not.toHaveProperty('sessionWorkspaceCwd');
      }
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

    it.each(['.diff', '.patch'])(
      'accepts binding URLs with a %s suffix (R16-B1)',
      async (suffix) => {
        await initChannel({ deliverToBoundSessions: true }, { boundSessions });
        // GitHub serves /pull/N.diff and /pull/N.patch and users copy those
        // links; the refresh sweep's pullRequestKey tolerates them, so the
        // delivery/watch parser must too — otherwise the binding silently
        // degrades to public channel replies and the PR is never watched.
        boundSessions.listPrBindings.mockResolvedValue({
          bindings: [
            makeBinding({
              prs: [
                {
                  number: 42,
                  url: `https://github.com/owner/repo/pull/42${suffix}`,
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
      },
    );

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

    it('defers an empty partial cold snapshot, bounded, without public misrouting (N11, G4, R1-7, W1)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // A draining/unreadable workspace answers {bindings: [], partial:
      // true} while its bound session still exists. Success of an
      // incomplete scan does not establish absence: the lane must stay
      // closed (cursor frozen, nothing consumed) instead of publicly
      // routing every event on the first answer.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: true,
      });
      const cursor = (
        channel as unknown as { cursor: { lastProcessedAt: string } }
      ).cursor;
      for (let i = 0; i < 29; i++) {
        await pollOnce();
      }
      expect(mockOctokit.paginate).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(cursor.lastProcessedAt).toBe('2026-07-01T00:00:00.000Z');

      // Bounded escape (G4): a PERMANENTLY empty partial must not freeze
      // the lane forever. At the cap the lane opens — but the unmatched
      // event still defers as backpressure (absence never established),
      // it does NOT take the irreversible public path.
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      const tasks = readInboundTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!['backpressure']).toBe(true);
      expect(tasks[0]!['delivery']).toBeUndefined();
      // Pure backpressure does not hold the shared cursor (key decision 9).
      expect(cursor.lastProcessedAt).toBe('2026-07-02T10:00:00.000Z');

      // The real snapshot lands: recovery re-resolves the deferred event
      // and delivers it privately — the public path was never taken.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [makeBinding()],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('advances the bounded empty-partial escape on persistent refresh failures (R1-7)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // One successful empty partial sets boundSnapshotSeen and streak=1.
      boundSessions.listPrBindings.mockResolvedValueOnce({
        bindings: [],
        partial: true,
      });
      mockOctokit.paginate.mockResolvedValue([]);
      await pollOnce();
      expect(mockOctokit.paginate).not.toHaveBeenCalled();

      // Every later refresh fails (an old daemon lacking the route, rotated
      // credentials). The bounded escape must advance on the failure path
      // too: before the fix the streak froze at 1 once boundSnapshotSeen was
      // true, so the cold-empty gate held the lane forever and the escape
      // that exists to prevent exactly this was unreachable.
      boundSessions.listPrBindings.mockRejectedValue(new Error('daemon cold'));
      for (let i = 0; i < 29; i++) {
        await pollOnce();
      }

      // 1 successful empty partial + 29 failures = streak 30 → the lane
      // opens at the cap (paginate is reached only once the gate opens).
      expect(mockOctokit.paginate).toHaveBeenCalled();
    });

    it('names the binding lookup, not workspace storage, when failing refreshes reach the cold-empty cap (R1-8)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockRejectedValue(new Error('daemon cold'));
      mockOctokit.paginate.mockResolvedValue([]);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        for (let i = 0; i < 30; i++) {
          await pollOnce();
        }
        const capLine = stderr.mock.calls
          .map((call) => String(call[0]))
          .find((line) => line.includes('has been an empty partial for 30'));
        expect(capLine).toBeDefined();
        expect(capLine).toContain('binding lookup itself has been failing');
        expect(capLine).not.toContain('chats directory');
        // No snapshot has ever succeeded, so the gate keeps the lane closed:
        // the cap line must not claim it opened.
        expect(capLine).not.toContain('opening the comment lane');
        expect(capLine).toContain('remains stalled');
      } finally {
        stderr.mockRestore();
      }
    });

    it('hints at unreadable storage after ten partial snapshots and counts the listed rows (R1-8)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // One tombstone row: no routable binding, but a listed session.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [{ sessionId: 'tomb', workspaceCwd: '/ws', prs: [] }],
        partial: true,
      });
      mockOctokit.paginate.mockResolvedValue([]);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        for (let i = 0; i < 10; i++) {
          await pollOnce();
        }
        const hint = stderr.mock.calls
          .map((call) => String(call[0]))
          .find((line) => line.includes('has been partial for 10'));
        expect(hint).toBeDefined();
        expect(hint).toContain('(1 sessions listed)');
        expect(hint).toContain('PR bindings scan');
        expect(hint).toContain('no runtime');
        // The lane is still deferred on the tenth cold poll: no claim that
        // issue events flow.
        expect(hint).toContain('PR and issue events are both stalled');
        expect(hint).not.toContain('issue events are unaffected');
      } finally {
        stderr.mockRestore();
      }
    });

    it('keeps hinting while retention holds bindings the partial answers no longer list (R1-8)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      mockOctokit.paginate.mockResolvedValue([]);
      // One complete snapshot lands a binding; then the chats dir becomes
      // unlistable and every poll answers an empty partial. Retention keeps
      // the binding in the map, so the hint must still fire.
      boundSessions.listPrBindings.mockResolvedValueOnce({
        bindings: [makeBinding()],
        partial: false,
      });
      await pollOnce();
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: true,
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        for (let i = 0; i < 10; i++) {
          await pollOnce();
        }
        const hint = stderr.mock.calls
          .map((call) => String(call[0]))
          .find((line) => line.includes('has been partial for 10'));
        expect(hint).toBeDefined();
        expect(hint).toContain('(0 sessions listed)');
        // The lane opened on the complete snapshot: issue events do flow.
        expect(hint).toContain('issue events are unaffected');
      } finally {
        stderr.mockRestore();
      }
    });

    it('does not blame the binding lookup when the cold-empty cap was reached by successful empty partials (R3-2)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      mockOctokit.paginate.mockResolvedValue([]);
      // 29 successful empty partials, then one transient failure lands the
      // cap on the failure path; the wording must name the storage causes.
      for (let i = 0; i < 29; i++) {
        boundSessions.listPrBindings.mockResolvedValueOnce({
          bindings: [],
          partial: true,
        });
        await pollOnce();
      }
      boundSessions.listPrBindings.mockRejectedValue(new Error('502'));
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await pollOnce();
        const capLine = stderr.mock.calls
          .map((call) => String(call[0]))
          .find((line) => line.includes('has been an empty partial for 30'));
        expect(capLine).toBeDefined();
        expect(capLine).not.toContain('binding lookup itself has been failing');
        expect(capLine).toContain("'PR bindings scan' line");
      } finally {
        stderr.mockRestore();
      }
    });

    it('names the binding lookup when failed lookups seeded the cold-empty cap and one empty partial lands it (R4-5)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      mockOctokit.paginate.mockResolvedValue([]);
      boundSessions.listPrBindings.mockRejectedValue(new Error('daemon cold'));
      for (let i = 0; i < 29; i++) {
        await pollOnce();
      }
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: true,
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await pollOnce();
        const capLine = stderr.mock.calls
          .map((call) => String(call[0]))
          .find((line) => line.includes('has been an empty partial for 30'));
        expect(capLine).toBeDefined();
        expect(capLine).toContain('binding lookup itself has been failing');
      } finally {
        stderr.mockRestore();
      }
    });

    it('attributes the cold-empty cap to the failed lookups when one empty partial interrupted them (R6)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      mockOctokit.paginate.mockResolvedValue([]);
      boundSessions.listPrBindings.mockRejectedValue(new Error('daemon cold'));
      for (let i = 0; i < 15; i++) {
        await pollOnce();
      }
      // One empty partial resets boundSnapshotFailureStreak; the streak that
      // reaches the cap is still 29 failed lookups out of 30 polls.
      boundSessions.listPrBindings.mockResolvedValueOnce({
        bindings: [],
        partial: true,
      });
      await pollOnce();
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        for (let i = 0; i < 14; i++) {
          await pollOnce();
        }
        const capLine = stderr.mock.calls
          .map((call) => String(call[0]))
          .find((line) => line.includes('has been an empty partial for 30'));
        expect(capLine).toBeDefined();
        expect(capLine).toContain(
          'binding lookup itself has been failing for 29 of those polls',
        );
        expect(capLine).toContain("'PR bindings scan' line");
      } finally {
        stderr.mockRestore();
      }
    });

    it('keeps the storage cause in front when only a few polls of the cold-empty streak failed the lookup (R6)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      mockOctokit.paginate.mockResolvedValue([]);
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: true,
      });
      for (let i = 0; i < 28; i++) {
        await pollOnce();
      }
      boundSessions.listPrBindings.mockRejectedValue(new Error('502'));
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await pollOnce();
        await pollOnce();
        const capLine = stderr.mock.calls
          .map((call) => String(call[0]))
          .find((line) => line.includes('has been an empty partial for 30'));
        expect(capLine).toBeDefined();
        expect(capLine).not.toContain('binding lookup itself has been failing');
        expect(capLine).toContain("'PR bindings scan' line");
        expect(capLine).toContain('2 of those polls also failed the lookup');
      } finally {
        stderr.mockRestore();
      }
    });

    it('resets the failed-lookup count together with the cold-empty streak (R6)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      mockOctokit.paginate.mockResolvedValue([]);
      boundSessions.listPrBindings.mockRejectedValue(new Error('daemon cold'));
      for (let i = 0; i < 5; i++) {
        await pollOnce();
      }
      // A non-empty partial ends the cold-empty streak; the five failures
      // before it must not be charged to the next streak, which starts when
      // that session's tombstone empties the map again.
      boundSessions.listPrBindings.mockResolvedValueOnce({
        bindings: [makeBinding()],
        partial: true,
      });
      await pollOnce();
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [{ ...makeBinding(), prs: [] }],
        partial: true,
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        for (let i = 0; i < 30; i++) {
          await pollOnce();
        }
        const capLine = stderr.mock.calls
          .map((call) => String(call[0]))
          .find((line) => line.includes('has been an empty partial for 30'));
        expect(capLine).toBeDefined();
        expect(capLine).toContain("'PR bindings scan' line");
        expect(capLine).not.toContain('failed the lookup');
        expect(capLine).not.toContain('binding lookup itself has been failing');
      } finally {
        stderr.mockRestore();
      }
    });

    it('opens the lane on a non-empty partial snapshot and delivers known targets (R1-7)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // A partial answer that LISTS the binding is enough for the known
      // target: only absence from an incomplete scan is non-authoritative.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [makeBinding()],
        partial: true,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('dead-letters an unmatched event at the deferral horizon while the snapshot stays incomplete (W1)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [makeBinding()],
        partial: true,
      });
      // An event for a PR the partial answer never listed: absence is not
      // established, so it defers instead of routing publicly — bounded by
      // the same horizon as every other backpressure.
      const task = makeInboundTaskRecord({
        state: 'failed',
        attempts: 0,
        deferCount: 239,
        backpressure: true,
        issueNumber: 43,
        source: {
          chatId: 'owner/repo',
          threadId: 'pr:43',
          messageId: 'comment-43',
        },
        envelope: {
          ...makeInboundTaskRecord().envelope,
          threadId: 'pr:43',
          messageId: 'comment-43',
        },
        dedupe: {},
      });
      writeInboundTasks([task]);
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(existsSync(inboundTaskPath())).toBe(false);
      const lines = readFileSync(boundDeadLetterPath(), 'utf-8')
        .trim()
        .split('\n');
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]!) as { reason: string };
      expect(record.reason).toContain('binding snapshot never completed');
    });

    it('routes an issue event publicly under a permanent partial snapshot (R14-B1)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // A PERMANENT partial (a sidecar the daemon persistently cannot read)
      // never lands a complete snapshot, so boundSnapshotTrusted
      // stays false forever. Bindings are PR-only and GitHub's issue/PR
      // number space is exclusive, so an issue event can never have a bound
      // target: its absence is provable without any snapshot and it must
      // not defer (and dead-letter at the horizon) behind the degraded
      // scan. The partial answer LISTS a PR binder so the lane opens at
      // once (a non-empty partial is not the cold-empty case).
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            prs: [
              {
                number: 1,
                url: 'https://github.com/owner/repo/pull/1',
                state: 'open',
              },
            ],
          }),
        ],
        partial: true,
      });
      // makeNotification() defaults to an ISSUE subject (issues/42).
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(existsSync(inboundTaskPath())).toBe(false);
      expect(existsSync(boundDeadLetterPath())).toBe(false);
    });

    it('routes a recovered issue task publicly while the binding refresh keeps failing (R14-B1)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // The refresh has NEVER succeeded (an old daemon without the route,
      // rotated credentials): the comment lane stays closed, but persisted
      // tasks still recover. A targetless ISSUE deferral needs no snapshot
      // to establish absence — bindings are PR-only — so it routes publicly
      // instead of deferring again to the horizon.
      boundSessions.listPrBindings.mockRejectedValue(new Error('daemon cold'));
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'failed',
          attempts: 0,
          deferCount: 5,
          backpressure: true,
        }),
      ]);
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(existsSync(inboundTaskPath())).toBe(false);
      expect(existsSync(boundDeadLetterPath())).toBe(false);
    });

    it('attributes the sender on the mention-lane bound prompt (R1-6)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      const prompt = boundSessions.deliverPrompt.mock.calls[0]![1] as string;
      // The mention lane supplies no Author metadata line; without the
      // fallback the session cannot tell who spoke.
      expect(prompt).toContain('Author: alice');
    });

    it('surfaces both the batch cap and the code-point cut in an aggregate bound prompt (R1-1)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // 25 comments x 400 chars: the batch cap keeps the newest 20, and
      // their composed text exceeds the 6,000 code-point prompt cap. Both
      // omissions must be visible — every comment is already recorded in
      // dispatchedComments, so a silent cut loses them from every surface.
      const comments = Array.from({ length: 25 }, (_, i) =>
        makeComment({
          id: 2000 + i,
          body: `REQ${i} ${'x'.repeat(390)}`,
          created_at: `2026-07-02T09:${String(i).padStart(2, '0')}:00.000Z`,
          updated_at: `2026-07-02T09:${String(i).padStart(2, '0')}:00.000Z`,
        }),
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce(comments);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      const prompt = boundSessions.deliverPrompt.mock.calls[0]![1] as string;
      expect(prompt).toContain(
        '[5 earlier comment(s) omitted from this batch; list the PR comments to see them]',
      );
      expect(prompt).toMatch(
        /\[prompt truncated: \d+ more characters omitted\]/,
      );
      // The batch cap drops the OLDEST five (REQ0-REQ4); the code-point
      // cut drops the tail — both losses are accounted for by a notice
      // instead of silently consuming the comments.
      expect(prompt).toContain('REQ5 ');
      expect(prompt).not.toContain('REQ4 ');
      expect(prompt).not.toContain('REQ0 ');
    });

    it('re-injects with the SAME idempotency key after a failed acceptance mark (W4)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // Fail exactly the deliveredAt write once: the prompt was already
      // accepted, the durable mark is lost, and recovery must retry with
      // the same admission identity so the daemon can deduplicate.
      const proto = Object.getPrototypeOf(channel) as {
        transitionInboundTask: (
          id: string,
          state: string,
          patch: Record<string, unknown>,
        ) => void;
      };
      const original = proto.transitionInboundTask;
      let failedOnce = false;
      proto.transitionInboundTask = function (
        id: string,
        state: string,
        patch: Record<string, unknown>,
      ): void {
        if (!failedOnce && patch && 'deliveredAt' in patch) {
          failedOnce = true;
          throw Object.assign(new Error('EIO: acceptance mark lost'), {
            code: 'EIO',
          });
        }
        return original.call(this, id, state, patch);
      };
      try {
        mockOctokit.paginate
          .mockResolvedValueOnce([prNotification()])
          .mockResolvedValueOnce([makeComment()]);
        await pollOnce();
        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
        // The task survives without the mark.
        const tasks = readInboundTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0]!['deliveredAt']).toBeUndefined();

        mockOctokit.paginate.mockResolvedValueOnce([]);
        await pollOnce();
        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
        const firstKey = boundSessions.deliverPrompt.mock.calls[0]![2];
        const secondKey = boundSessions.deliverPrompt.mock.calls[1]![2];
        // The key is the EVENT identity (chat + source message), not the
        // task id: it must survive task re-creation after a crash.
        expect(firstKey).toBe('github:owner/repo:1001');
        expect(secondKey).toBe(firstKey);
        expect(existsSync(inboundTaskPath())).toBe(false);
      } finally {
        proto.transitionInboundTask = original;
      }
    });

    it('keeps the idempotency key stable across task re-creation after the cursor-save crash window (A-F2)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // First attempt defers (queue full) so the task survives poll 1 and
      // its id is observable.
      boundSessions.deliverPrompt.mockRejectedValueOnce(
        new BoundSessionQueueFullError('bound-session'),
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      const firstTaskId = readInboundTasks()[0]!['id'] as string;
      expect(firstTaskId).toBeDefined();

      // Simulate the crash window: the task was accepted and removed, but
      // the process died before the end-of-poll cursor save. On restart the
      // persisted cursor has neither the advanced lastProcessedAt nor the
      // dispatchedComments key, so the same comment is re-listed and a NEW
      // task is created.
      writeInboundTasks([]);
      const ch = channel as unknown as {
        cursor: { dispatchedComments?: string[]; lastProcessedAt: string };
      };
      ch.cursor.dispatchedComments = [];
      ch.cursor.lastProcessedAt = '2026-07-01T00:00:00.000Z';
      // Observe the re-created task WHILE it is being delivered: after
      // success the task file is gone, and a sentinel id would make the
      // different-id assertion trivially true.
      let secondTaskIdDuringDelivery: string | undefined;
      boundSessions.deliverPrompt.mockImplementationOnce(async () => {
        secondTaskIdDuringDelivery = readInboundTasks()[0]?.['id'] as string;
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      const firstKey = boundSessions.deliverPrompt.mock.calls[0]![2];
      const secondKey = boundSessions.deliverPrompt.mock.calls[1]![2];
      // A new task (different id) must carry the SAME event key so the
      // daemon dedupes the re-injection into the original admission.
      expect(secondKey).toBe(firstKey);
      expect(firstKey).toBe('github:owner/repo:1001');
      expect(secondTaskIdDuringDelivery).toBeDefined();
      expect(secondTaskIdDuringDelivery).not.toBe(firstTaskId);
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('re-delivers a grown aggregate batch under a new content key after the cursor-save crash window (R3-B1)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      const c1 = makeComment({ id: 1001, body: 'first remark' });
      const c2 = makeComment({ id: 1002, body: 'second remark' });
      const c3 = makeComment({ id: 1003, body: 'NEW-COMMENT-AFTER-CRASH' });
      const hashOf = (ids: string[]) =>
        `github:owner/repo:agg:${createHash('sha256')
          .update([...ids].sort().join('\n'))
          .digest('hex')
          .slice(0, 40)}`;
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([c1, c2]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      const firstKey = boundSessions.deliverPrompt.mock.calls[0]![2] as string;
      expect(firstKey).toBe(hashOf(['C_1001', 'C_1002']));

      // Crash window: acceptance landed but the cursor save did not. The
      // re-listed thread now carries a THIRD comment — a superset batch
      // with the same first comment. A first-comment key would dedupe it
      // into the original admission and silently drop the new member.
      writeInboundTasks([]);
      const ch = channel as unknown as {
        cursor: { dispatchedComments?: string[]; lastProcessedAt: string };
      };
      ch.cursor.dispatchedComments = [];
      ch.cursor.lastProcessedAt = '2026-07-01T00:00:00.000Z';
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([c1, c2, c3]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      const secondKey = boundSessions.deliverPrompt.mock.calls[1]![2] as string;
      expect(secondKey).toBe(hashOf(['C_1001', 'C_1002', 'C_1003']));
      expect(secondKey).not.toBe(firstKey);
      expect(boundSessions.deliverPrompt.mock.calls[1]![1]).toContain(
        'NEW-COMMENT-AFTER-CRASH',
      );

      // An IDENTICAL re-listed batch keeps the same key: the acceptance
      // crash-window dedupe still holds for unchanged content.
      writeInboundTasks([]);
      ch.cursor.dispatchedComments = [];
      ch.cursor.lastProcessedAt = '2026-07-01T00:00:00.000Z';
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([c1, c2, c3]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(3);
      expect(boundSessions.deliverPrompt.mock.calls[2]![2]).toBe(secondKey);
    });

    it('keys an aggregate batch by sorted members regardless of fetch order (R16-C1)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      const c1 = makeComment({ id: 1001, body: 'first remark' });
      const c2 = makeComment({ id: 1002, body: 'second remark' });
      const sortedKey = `github:owner/repo:agg:${createHash('sha256')
        .update(['C_1001', 'C_1002'].sort().join('\n'))
        .digest('hex')
        .slice(0, 40)}`;
      // GitHub usually returns comments ascending, but the content key must
      // be order-independent: the same batch re-listed in a different order
      // is the SAME batch and must dedupe to the same admission key. Pins
      // the implementation's .sort() (R3-B1 only ever fed ascending input).
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([c2, c1]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![2]).toBe(sortedKey);
    });

    it('defers unmatched events under a partial snapshot even after a complete one (R3-A1)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // Establish trusted absence authority with a complete snapshot.
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();

      // Partial phase: PR 43 was never bound. Absence is NOT authoritative
      // during a partial answer (an unlisted workspace or a retention-cap
      // eviction may hide the follower): the event must defer, not take
      // the irreversible public path.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: true,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            subject: {
              title: 'Test PR',
              url: 'https://api.github.com/repos/owner/repo/pulls/43',
              type: 'PullRequest',
            },
          }),
        ])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      const tasks = readInboundTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!['backpressure']).toBe(true);

      // A complete snapshot re-establishes absence: recovery re-drives the
      // deferred event onto the public path exactly once.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();
      // A complete snapshot re-establishes absence: recovery re-drives the
      // deferred event onto the public channel path exactly once.
      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('selects a retained alternate when the previous winner unbinds (R3-C1)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      const newer = makeBinding({
        sessionId: 'A',
        updatedAt: '2026-07-03T00:00:00.000Z',
      });
      const older = makeBinding({
        sessionId: 'B',
        updatedAt: '2026-07-01T00:00:00.000Z',
      });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [newer, older],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();
      const priv = channel as unknown as {
        boundSessionByPr: Map<string, { sessionId: string }>;
      };
      expect(priv.boundSessionByPr.get('owner/repo#42')?.sessionId).toBe('A');

      // Partial lists only A, tombstoned (prs: []): A is authoritatively
      // unbound, B is retained — the routing map must fall back to B, not
      // empty out while lastBindings still knows B.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            sessionId: 'A',
            updatedAt: '2026-07-03T00:00:00.000Z',
            prs: [],
          }),
        ],
        partial: true,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();
      expect(priv.boundSessionByPr.get('owner/repo#42')?.sessionId).toBe('B');

      // A comment on PR 42 delivers privately to the retained alternate.
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![0]).toBe('B');
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('keeps issue events public under a partial snapshot (bindings are PR-only)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();

      // Bindings are PR-only: an issue can never have a hidden follower,
      // so a degraded binding scan must not stall its public delivery.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: true,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            subject: {
              title: 'Issue',
              url: 'https://api.github.com/repos/owner/repo/issues/7',
              type: 'Issue',
            },
          }),
        ])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
    });

    it('treats a published audit record as durable consumption at claim time (R4-B1)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      // A previous incarnation published the reply (audit `posted`),
      // removed the task, and lost the cursor save (mark-read failure or
      // crash). The re-listed batch must not be claimed and published a
      // second time. The AGGREGATE lane does not self-record dispatched
      // comments (the claim path does), so the cursor assertion below
      // independently witnesses the audit branch's dedupe recording.
      const batchId = `agg:${createHash('sha256')
        .update('C_1001')
        .digest('hex')
        .slice(0, 40)}`;
      const auditPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-audit.jsonl',
      );
      mkdirSync(dirname(auditPath), { recursive: true });
      writeFileSync(
        auditPath,
        `${JSON.stringify({
          outcome: 'posted',
          repository: 'owner/repo',
          threadId: 'pr:42',
          sourceMessageId: batchId,
        })}\n`,
        'utf-8',
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(existsSync(inboundTaskPath())).toBe(false);
      const ch = channel as unknown as {
        cursor: { dispatchedComments?: string[] };
      };
      expect(ch.cursor.dispatchedComments).toContain('C_1001');
    });

    it.each([true, false])(
      'freezes the cursor when the publication audit is unreadable, deliverToBoundSessions=%s (R5-A1)',
      async (deliverToBoundSessions) => {
        await initChannel({ deliverToBoundSessions }, { boundSessions });
        boundSessions.listPrBindings.mockResolvedValue({
          bindings: [],
          partial: false,
        });
        // An unreadable audit (here: a directory at the audit path) must
        // fail CLOSED on the whole poll: skipping the notification while
        // the cursor commits would mark it read and never re-list it —
        // permanent silent consumption instead of the promised retry.
        const auditPath = inboundTaskPath().replace(
          'github-inbound-tasks.json',
          'github-audit.jsonl',
        );
        mkdirSync(auditPath, { recursive: true });
        mockOctokit.paginate
          .mockResolvedValueOnce([prNotification()])
          .mockResolvedValueOnce([makeComment()]);
        await pollOnce();
        expect(channel.inboundEnvelopes).toHaveLength(0);
        expect(existsSync(inboundTaskPath())).toBe(false);
        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).not.toHaveBeenCalled();
        const ch = channel as unknown as {
          cursor: { lastProcessedAt: string };
        };
        expect(ch.cursor.lastProcessedAt).toBe('2026-07-01T00:00:00.000Z');

        // Once the audit is readable again, the SAME event delivers: the
        // frozen cursor re-listed it.
        rmSync(auditPath, { recursive: true, force: true });
        mockOctokit.paginate
          .mockResolvedValueOnce([prNotification()])
          .mockResolvedValueOnce([makeComment()]);
        await pollOnce();
        expect(channel.inboundEnvelopes).toHaveLength(1);
      },
    );

    it('does not record the direct-lane key when the audit freeze refuses dispatch (R6-A1)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // The direct lane fetches PR meta BEFORE dispatch: without this mock
      // the fetch throws, the per-notification catch skips the event, and
      // the test never reaches the freeze guard (order-dependent vacuity).
      mockOctokit.rest.pulls.get.mockResolvedValue({ data: makePrMeta() });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      const auditPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-audit.jsonl',
      );
      mkdirSync(auditPath, { recursive: true });
      const notification = makeNotification({
        reason: 'review_requested',
        // A previously-read thread keeps the first-contact body feed off,
        // so only the direct lane can dispatch here.
        last_read_at: '2026-07-02T09:30:00.000Z',
        subject: {
          title: 'Test PR',
          url: 'https://api.github.com/repos/owner/repo/pulls/42',
          type: 'PullRequest',
        },
      });
      // review_requested runs the comment lane after the direct lane; prime
      // its empty comment list so it returns cleanly instead of throwing on
      // an unmocked fetch (swallowed per-notification stderr noise).
      mockOctokit.paginate
        .mockResolvedValueOnce([notification])
        .mockResolvedValueOnce([makeIssueEvent()])
        .mockResolvedValueOnce([]);
      await pollOnce();
      // The freeze refused the dispatch with NO task claimed: the direct
      // lane must not record the trigger key, or the unconditional
      // end-of-loop cursor save persists it and the re-listed event is
      // permanently filtered.
      const ch = channel as unknown as {
        cursor: { dispatchedEvents?: string[] };
      };
      expect(ch.cursor.dispatchedEvents ?? []).toHaveLength(0);
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).not.toHaveBeenCalled();

      rmSync(auditPath, { recursive: true, force: true });
      mockOctokit.paginate
        .mockResolvedValueOnce([notification])
        .mockResolvedValueOnce([makeIssueEvent()])
        .mockResolvedValueOnce([]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(1);
    });

    it('does not record the first-contact body key when the audit freeze refuses dispatch (R6-A1)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          title: 'Issue',
          body: '@test-bot first contact body',
          user: { login: 'alice' },
        },
      });
      const auditPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-audit.jsonl',
      );
      mkdirSync(auditPath, { recursive: true });
      // mention reason + no new comments + never-read → first-contact feed
      // (the mention lane requires the body to mention the bot).
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([]);
      await pollOnce();
      const ch = channel as unknown as {
        cursor: { dispatchedBodies?: string[] };
      };
      expect(ch.cursor.dispatchedBodies ?? []).toHaveLength(0);
      expect(channel.inboundEnvelopes).toHaveLength(0);

      rmSync(auditPath, { recursive: true, force: true });
      mockOctokit.paginate
        .mockResolvedValueOnce([makeNotification()])
        .mockResolvedValueOnce([]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(1);
    });

    it('keeps a posting-then-failed audit event retryable but consumes a bare posting (R5-A2)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      const auditPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-audit.jsonl',
      );
      mkdirSync(dirname(auditPath), { recursive: true });
      const row = (sourceMessageId: string, outcome: string) =>
        JSON.stringify({
          outcome,
          repository: 'owner/repo',
          threadId: 'pr:42',
          sourceMessageId,
        });
      // posting -> failed: the reply never landed; the event must retry.
      // posting alone (crash mid-post): ambiguous, consumed at-most-once.
      writeFileSync(
        auditPath,
        `${row('1001', 'posting')}\n${row('1001', 'failed')}\n${row('1002', 'posting')}\n`,
        'utf-8',
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(1);

      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
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
            updated_at: '2026-07-02T10:30:00.000Z',
          }),
        ]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(1);
      const ch = channel as unknown as {
        cursor: { dispatchedComments?: string[] };
      };
      expect(ch.cursor.dispatchedComments).toContain('C_1002');
    });

    it('consumes a failed_ambiguous audit verdict at dispatch, unlike a definite failed (R7-C2)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      const auditPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-audit.jsonl',
      );
      mkdirSync(dirname(auditPath), { recursive: true });
      const row = (sourceMessageId: string, outcome: string) =>
        JSON.stringify({
          outcome,
          repository: 'owner/repo',
          threadId: 'pr:42',
          sourceMessageId,
        });
      // 1001: posting -> definite failed -> failed_ambiguous (the retry's
      // write MAY have landed) must stay consumed — the reader, not just
      // the writer, has to honor the ambiguous verdict as the LAST outcome,
      // or the stale definite-failed verdict reopens the double-publish
      // window. 1002: posting -> definite failed stays retryable (contrast).
      writeFileSync(
        auditPath,
        `${row('1001', 'posting')}\n${row('1001', 'failed')}\n${row('1001', 'failed_ambiguous')}\n${row('1002', 'posting')}\n${row('1002', 'failed')}\n`,
        'utf-8',
      );
      const prSubject = {
        title: 'Test PR',
        url: 'https://api.github.com/repos/owner/repo/pulls/42',
        type: 'PullRequest',
      };
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({ reason: 'mention', subject: prSubject }),
        ])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(existsSync(inboundTaskPath())).toBe(false);
      const ch = channel as unknown as {
        cursor: { dispatchedComments?: string[] };
      };
      expect(ch.cursor.dispatchedComments).toContain('C_1001');

      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'mention',
            updated_at: '2026-07-02T11:00:00.000Z',
            subject: prSubject,
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({
            id: 1002,
            node_id: 'C_1002',
            created_at: '2026-07-02T10:30:00.000Z',
            updated_at: '2026-07-02T10:30:00.000Z',
          }),
        ]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(1);
    });

    it('defers the gone-session public fallback under a partial snapshot (R5-A3)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings
        .mockResolvedValueOnce({ bindings: [makeBinding()], partial: false })
        .mockResolvedValue({ bindings: [], partial: true });
      boundSessions.deliverPrompt.mockRejectedValue(
        new BoundSessionGoneError('bound-session'),
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      // Gone is authoritative for THAT session, but under a partial scan
      // an invisible workspace may still follow the PR: the public
      // fallback would be irreversible, so defer instead.
      expect(channel.inboundEnvelopes).toHaveLength(0);
      const tasks = readInboundTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!['backpressure']).toBe(true);
      expect(tasks[0]!['delivery']).toBeUndefined();

      // Complete snapshot: absence established, public reply exactly once.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(1);
    });

    describe('mention requirement on the private path', () => {
      const listed = {
        groups: { '*': { senders: 'allowlist', allowedUsers: ['alice'] } },
      };
      const plainReview = (login = 'alice') =>
        makeComment({
          body: 'nit: please rename fetchAll to fetchEvery',
          user: { login },
        });
      beforeEach(() => {
        // A realistic PR body without a mention, so the first-contact feed
        // runs for real instead of failing on an unmocked fetch.
        mockOctokit.rest.issues.get.mockResolvedValue({
          data: {
            title: 'Test PR',
            body: 'Implements the retry.',
            user: { login: 'alice' },
          },
        });
      });

      it.each(['mention', 'subscribed'])(
        'delivers a listed sender plain comment on a bound PR listed as %s, without the PR body',
        async (reason) => {
          await initChannel(
            { deliverToBoundSessions: true, ...listed },
            { boundSessions },
          );
          mockOctokit.paginate
            .mockResolvedValueOnce([prNotification(reason)])
            .mockResolvedValueOnce([plainReview()]);

          await pollOnce();

          expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
          expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
            'please rename fetchAll',
          );
          expect(boundSessions.deliverPrompt.mock.calls[0]![2]).toBe(
            'github:owner/repo:1001',
          );
          expect(channel.inboundEnvelopes).toHaveLength(0);
        },
      );

      it.each(['mention', 'subscribed'])(
        'keeps requiring the mention on a bound PR whose repository admits any sender (%s)',
        async (reason) => {
          await initChannel(
            { deliverToBoundSessions: true },
            { boundSessions },
          );
          mockOctokit.paginate
            .mockResolvedValueOnce([prNotification(reason)])
            .mockResolvedValueOnce([plainReview()]);

          await pollOnce();

          expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
        },
      );

      it('drops a plain comment from an unlisted sender at the lane, without a task', async () => {
        await initChannel(
          { deliverToBoundSessions: true, ...listed },
          { boundSessions },
        );
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          mockOctokit.paginate
            .mockResolvedValueOnce([prNotification()])
            .mockResolvedValueOnce([plainReview('mallory')]);

          await pollOnce();

          expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
          expect(existsSync(inboundTaskPath())).toBe(false);
          expect(
            stderr.mock.calls.some((call) =>
              String(call[0]).includes('rejected by the channel preflight'),
            ),
          ).toBe(false);
        } finally {
          stderr.mockRestore();
        }
      });

      // A mention thread drops the comment at the lane itself; any other
      // reason reaches the public path, whose preflight drops it.
      it.each([
        ['mention', false],
        ['subscribed', true],
      ])(
        'keeps requiring the mention on an unbound PR listed as %s',
        async (reason, publicPreflight) => {
          await initChannel(
            { deliverToBoundSessions: true, ...listed },
            { boundSessions },
          );
          channel.usePreflight = publicPreflight;
          boundSessions.listPrBindings.mockResolvedValue({
            bindings: [],
            partial: false,
          });
          mockOctokit.paginate
            .mockResolvedValueOnce([prNotification(reason)])
            .mockResolvedValueOnce([plainReview()]);

          await pollOnce();

          expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
          expect(channel.inboundEnvelopes).toHaveLength(0);
          expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
        },
      );

      it('publishes nothing when the session is gone and the fallback needs a mention', async () => {
        // On a subscribed thread the comment lane does not filter, so the
        // channel path's own mention gate is what keeps it private.
        await initChannel(
          { deliverToBoundSessions: true, ...listed },
          { boundSessions },
        );
        channel.usePreflight = true;
        boundSessions.deliverPrompt.mockRejectedValue(
          new BoundSessionGoneError('bound-session'),
        );
        boundSessions.listPrBindings
          .mockResolvedValueOnce({ bindings: [makeBinding()], partial: false })
          .mockResolvedValue({ bindings: [], partial: false });
        mockOctokit.paginate
          .mockResolvedValueOnce([prNotification('subscribed')])
          .mockResolvedValueOnce([plainReview()]);

        await pollOnce();

        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
        expect(channel.inboundEnvelopes).toHaveLength(0);
        expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      });

      it('keeps the public path closed to a waived comment without a mention requirement', async () => {
        // With requireMention off, a public fallback would answer a plain
        // comment the mention lane drops on an unbound thread.
        await initChannel(
          {
            deliverToBoundSessions: true,
            groups: {
              '*': {
                senders: 'allowlist',
                allowedUsers: ['alice'],
                requireMention: false,
              },
            },
          },
          { boundSessions },
        );
        channel.usePreflight = true;
        boundSessions.deliverPrompt.mockRejectedValue(
          new BoundSessionGoneError('bound-session'),
        );
        boundSessions.listPrBindings
          .mockResolvedValueOnce({ bindings: [makeBinding()], partial: false })
          .mockResolvedValue({ bindings: [], partial: false });
        mockOctokit.paginate
          .mockResolvedValueOnce([prNotification()])
          .mockResolvedValueOnce([plainReview()]);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          await pollOnce();

          expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
          expect(channel.inboundEnvelopes).toHaveLength(0);
          expect(
            stderr.mock.calls.some((call) =>
              String(call[0]).includes(
                'bound event 1001 has no bound session left',
              ),
            ),
          ).toBe(true);
        } finally {
          stderr.mockRestore();
        }
        expect(existsSync(inboundTaskPath())).toBe(false);
      });

      it('retires a stored private-only comment instead of answering it publicly', async () => {
        // A task the waiver admitted, left without a target (after a restart,
        // say), must not reach the public path.
        writeInboundTasks([makeInboundTaskRecord({ privateOnly: true })]);
        await initChannel(
          { deliverToBoundSessions: true, ...listed },
          { boundSessions },
        );
        channel.usePreflight = true;
        mockOctokit.paginate.mockResolvedValue([]);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          await pollOnce();

          expect(
            stderr.mock.calls.some((call) =>
              String(call[0]).includes(
                'bound event 1001 has no bound session left',
              ),
            ),
          ).toBe(true);
        } finally {
          stderr.mockRestore();
        }
        expect(channel.inboundEnvelopes).toHaveLength(0);
        expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      });

      it('drops a plain comment at the lane when a partial scan has not seen the PR', async () => {
        await initChannel(
          { deliverToBoundSessions: true, ...listed },
          { boundSessions },
        );
        // The scan saw another PR, so the lane runs, but not this one.
        boundSessions.listPrBindings.mockResolvedValue({
          bindings: [
            makeBinding({
              prs: [
                {
                  number: 43,
                  url: 'https://github.com/owner/repo/pull/43',
                  state: 'open',
                },
              ],
            }),
          ],
          partial: true,
        });
        mockOctokit.paginate
          .mockResolvedValueOnce([prNotification()])
          .mockResolvedValueOnce([plainReview()]);

        await pollOnce();

        expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
        expect(existsSync(inboundTaskPath())).toBe(false);
      });

      it('retires a stored private-only bound task when bound delivery is unavailable', async () => {
        writeInboundTasks([
          makeInboundTaskRecord({
            privateOnly: true,
            delivery: { kind: 'bound-session', sessionId: 'bound-session' },
          }),
        ]);
        // A restart without the daemon's bound-session client.
        await initChannel({ deliverToBoundSessions: true, ...listed });
        channel.usePreflight = true;
        mockOctokit.paginate.mockResolvedValue([]);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          await pollOnce();
        } finally {
          stderr.mockRestore();
        }

        expect(channel.inboundEnvelopes).toHaveLength(0);
        expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      });

      it.each(['assign', 'review_requested'])(
        'delivers a listed sender plain comment on a bound PR listed as %s',
        async (reason) => {
          await initChannel(
            { deliverToBoundSessions: true, ...listed },
            { boundSessions },
          );
          mockOctokit.rest.pulls.get.mockResolvedValue({
            data: { title: 'Test PR', user: { login: 'alice' }, state: 'open' },
          });
          mockOctokit.paginate.mockImplementation(async (method: unknown) => {
            if (
              method ===
              mockOctokit.rest.activity.listNotificationsForAuthenticatedUser
            ) {
              return [prNotification(reason)];
            }
            if (method === mockOctokit.rest.issues.listComments) {
              return [plainReview()];
            }
            return [];
          });

          await pollOnce();

          expect(
            boundSessions.deliverPrompt.mock.calls.map((call) => call[2]),
          ).toContain('github:owner/repo:1001');
          expect(channel.inboundEnvelopes).toHaveLength(0);
        },
      );

      it('posts no public error comment when retiring a deferral at its cap fails', async () => {
        await initChannel(
          { deliverToBoundSessions: true, ...listed },
          { boundSessions },
        );
        writeInboundTasks([
          makeInboundTaskRecord({
            state: 'failed',
            deferCount: 239,
            backpressure: true,
            source: {
              chatId: 'owner/repo',
              threadId: 'pr:42',
              messageId: '1001',
            },
            envelope: {
              channelName: 'test-github',
              senderId: 'alice',
              senderName: 'alice',
              chatId: 'owner/repo',
              threadId: 'pr:42',
              messageId: '1001',
              text: 'please fix this',
              isGroup: true,
              isMentioned: true,
              isReplyToBot: false,
              metadata: 'Trigger: mention.',
            },
            delivery: { kind: 'bound-session', sessionId: 'bound-session' },
          }),
        ]);
        boundSessions.deliverPrompt.mockRejectedValue(
          new BoundSessionGoneError('bound-session'),
        );
        boundSessions.listPrBindings
          .mockResolvedValueOnce({ bindings: [makeBinding()], partial: false })
          .mockResolvedValue({ bindings: [], partial: true });
        // The dead letter is written, then removing the task fails.
        vi.spyOn(
          channel as unknown as { removeInboundTask: (id: string) => void },
          'removeInboundTask',
        ).mockImplementation(() => {
          throw new Error('EIO: task store');
        });
        mockOctokit.paginate.mockResolvedValue([]);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          await pollOnce();
        } finally {
          stderr.mockRestore();
        }

        expect(existsSync(boundDeadLetterPath())).toBe(true);
        expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      });

      it('posts no public error comment when retiring a private-only comment fails', async () => {
        writeInboundTasks([makeInboundTaskRecord({ privateOnly: true })]);
        await initChannel(
          { deliverToBoundSessions: true, ...listed },
          { boundSessions },
        );
        vi.spyOn(
          channel as unknown as {
            markPrivatelyRetired: (task: unknown) => void;
          },
          'markPrivatelyRetired',
        ).mockImplementation(() => {
          throw new Error('EIO: task store');
        });
        mockOctokit.paginate.mockResolvedValue([]);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          await pollOnce();
        } finally {
          stderr.mockRestore();
        }

        expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      });

      it('keeps requiring the mention from an operator on a subscribed thread', async () => {
        await initChannel(
          { deliverToBoundSessions: true, operators: ['alice'], ...listed },
          { boundSessions },
        );
        mockOctokit.paginate
          .mockResolvedValueOnce([prNotification('subscribed')])
          .mockResolvedValueOnce([plainReview()]);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          await pollOnce();
        } finally {
          stderr.mockRestore();
        }

        expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      });

      it('leaves the first-contact feed as before for a deferred comment the waiver did not admit', async () => {
        // No allowlist, so no waiver: the deferred comment suppresses the
        // body feed this poll exactly as it always has.
        await initChannel(
          {
            deliverToBoundSessions: true,
            groups: { '*': { requireMention: false } },
          },
          { boundSessions },
        );
        mockOctokit.rest.issues.get.mockResolvedValue({
          data: {
            title: 'Test PR',
            body: '@test-bot please review the retry',
            user: { login: 'alice' },
          },
        });
        boundSessions.deliverPrompt.mockRejectedValue(
          new BoundSessionQueueFullError('bound-session'),
        );
        mockOctokit.paginate
          .mockResolvedValueOnce([
            prNotification('subscribed', { last_read_at: null }),
          ])
          .mockResolvedValueOnce([plainReview()]);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          await pollOnce();
        } finally {
          stderr.mockRestore();
        }

        expect(mockOctokit.rest.issues.get).not.toHaveBeenCalled();
      });

      it('handles the rest of the lane before a waived comment whose session is gone', async () => {
        await initChannel(
          { deliverToBoundSessions: true, ...listed },
          { boundSessions },
        );
        mockOctokit.rest.issues.get.mockResolvedValue({
          data: {
            title: 'Test PR',
            body: '@test-bot please review the retry',
            user: { login: 'alice' },
          },
        });
        boundSessions.deliverPrompt.mockRejectedValue(
          new BoundSessionGoneError('bound-session'),
        );
        // The refresh after the gone answer fails, so the evicted PR looks
        // unbound to whatever the lane handles next.
        boundSessions.listPrBindings
          .mockResolvedValueOnce({ bindings: [makeBinding()], partial: false })
          .mockRejectedValue(new Error('bindings unavailable'));
        mockOctokit.paginate
          .mockResolvedValueOnce([
            prNotification('mention', { last_read_at: null }),
          ])
          .mockResolvedValueOnce([
            plainReview(),
            makeComment({
              id: 1002,
              node_id: 'C_1002',
              body: '@test-bot what about this',
              user: { login: 'mallory' },
              created_at: '2026-07-02T09:30:00.000Z',
              updated_at: '2026-07-02T09:30:00.000Z',
            }),
          ]);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          await pollOnce();
        } finally {
          stderr.mockRestore();
        }

        expect(mockOctokit.rest.issues.get).toHaveBeenCalled();
        expect(
          [
            ...boundSessions.deliverPrompt.mock.calls.map((call) => call[2]),
            ...readInboundTasks().map(
              (task) =>
                `github:owner/repo:${(task['source'] as { messageId: string }).messageId}`,
            ),
          ].some((key) => key === 'github:owner/repo:issue-body-42'),
        ).toBe(true);
      });

      it('feeds the first-contact body on the re-read when a failed waived delivery holds the window', async () => {
        // A deferred mention suppresses the first-contact body only for the
        // poll it was deferred in, so whenever the window is held (a failed
        // task, a failed mark-read) the re-read feeds the body. A waived
        // comment's failed private delivery is one more such hold; before
        // the waiver the plain comment was dropped and the window committed.
        await initChannel(
          { deliverToBoundSessions: true, ...listed },
          { boundSessions },
        );
        mockOctokit.rest.issues.get.mockResolvedValue({
          data: {
            title: 'Test PR',
            body: '@test-bot please review the retry',
            user: { login: 'alice' },
          },
        });
        const comments = [
          makeComment({
            body: '@test-bot please look at the retry',
            user: { login: 'alice' },
          }),
          makeComment({
            id: 1002,
            node_id: 'C_1002',
            body: 'nit: please rename fetchAll to fetchEvery',
            user: { login: 'alice' },
            created_at: '2026-07-02T09:30:00.000Z',
            updated_at: '2026-07-02T09:30:00.000Z',
          }),
        ];
        boundSessions.deliverPrompt.mockImplementation(
          async (_sessionId: string, _prompt: string, key: string) => {
            if (key.endsWith(':1001')) {
              throw new BoundSessionQueueFullError('bound-session');
            }
            throw new Error('daemon unavailable');
          },
        );
        mockOctokit.paginate
          .mockResolvedValueOnce([
            prNotification('mention', { last_read_at: null }),
          ])
          .mockResolvedValueOnce(comments);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          await pollOnce();

          // The deferred mention suppressed the body this poll, and the
          // failed private delivery kept the thread unread.
          expect(mockOctokit.rest.issues.get).not.toHaveBeenCalled();
          expect(
            mockOctokit.rest.activity.markNotificationsAsRead,
          ).not.toHaveBeenCalled();

          // The session is gone by the next poll and the PR is unbound.
          boundSessions.deliverPrompt.mockRejectedValue(
            new BoundSessionGoneError('bound-session'),
          );
          boundSessions.listPrBindings.mockResolvedValue({
            bindings: [],
            partial: false,
          });
          mockOctokit.paginate
            .mockResolvedValueOnce([
              prNotification('mention', { last_read_at: null }),
            ])
            .mockResolvedValueOnce(comments);
          await pollOnce();
        } finally {
          stderr.mockRestore();
        }

        // The private-only comment retires without a public answer, and the
        // settled window is marked read.
        expect(
          channel.inboundEnvelopes.map((envelope) => envelope.messageId).sort(),
        ).toEqual(['1001', 'issue-body-42']);
        expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).toHaveBeenCalledTimes(1);
      });

      it("does not record a waived comment's key when the audit freeze refuses its dispatch", async () => {
        await initChannel(
          { deliverToBoundSessions: true, ...listed },
          { boundSessions },
        );
        // A refused dispatch claims no task, so recording the key would
        // skip the re-listed comment for good.
        const auditPath = inboundTaskPath().replace(
          'github-inbound-tasks.json',
          'github-audit.jsonl',
        );
        mkdirSync(auditPath, { recursive: true });
        mockOctokit.paginate
          .mockResolvedValueOnce([prNotification()])
          .mockResolvedValueOnce([plainReview()]);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          await pollOnce();
        } finally {
          stderr.mockRestore();
        }

        expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
        expect(existsSync(inboundTaskPath())).toBe(false);
        const ch = channel as unknown as {
          cursor: { dispatchedComments?: string[] };
        };
        expect(ch.cursor.dispatchedComments ?? []).not.toContain('C_1001');

        // Once the audit is readable again, the same comment delivers.
        rmSync(auditPath, { recursive: true, force: true });
        mockOctokit.paginate
          .mockResolvedValueOnce([prNotification()])
          .mockResolvedValueOnce([plainReview()]);
        await pollOnce();
        expect(
          boundSessions.deliverPrompt.mock.calls.map((call) => call[2]),
        ).toEqual(['github:owner/repo:1001']);
      });

      it('delivers a waived comment even when the first-contact body cannot be read', async () => {
        await initChannel(
          { deliverToBoundSessions: true, ...listed },
          { boundSessions },
        );
        mockOctokit.rest.issues.get.mockRejectedValue(
          Object.assign(new Error('Not Found'), { status: 404 }),
        );
        mockOctokit.paginate
          .mockResolvedValueOnce([
            prNotification('mention', { last_read_at: null }),
          ])
          .mockResolvedValueOnce([plainReview()]);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          await pollOnce();
        } finally {
          stderr.mockRestore();
        }

        expect(
          boundSessions.deliverPrompt.mock.calls.map((call) => call[2]),
        ).toContain('github:owner/repo:1001');
      });

      it('keeps requiring the mention from an operator, whose account a bound session may post as', async () => {
        await initChannel(
          { deliverToBoundSessions: true, operators: ['Alice'], ...listed },
          { boundSessions },
        );
        mockOctokit.paginate
          .mockResolvedValueOnce([prNotification()])
          .mockResolvedValueOnce([
            plainReview(),
            makeComment({
              id: 1002,
              node_id: 'C_1002',
              body: '@test-bot please look at the retry',
              user: { login: 'alice' },
            }),
          ]);

        await pollOnce();

        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
        expect(boundSessions.deliverPrompt.mock.calls[0]![2]).toBe(
          'github:owner/repo:1002',
        );
      });

      it('drops an unrouted plain comment at the lane when no default route is set', async () => {
        await initChannel(
          {
            deliverToBoundSessions: true,
            ...listed,
            messageRoutes: { '/review': 'Review the change.' },
          },
          { boundSessions },
        );
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          mockOctokit.paginate
            .mockResolvedValueOnce([prNotification()])
            .mockResolvedValueOnce([plainReview()]);

          await pollOnce();

          expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
          expect(existsSync(inboundTaskPath())).toBe(false);
          expect(
            stderr.mock.calls.some((call) =>
              String(call[0]).includes('rejected by the channel preflight'),
            ),
          ).toBe(false);
        } finally {
          stderr.mockRestore();
        }
      });

      it('strips the route prefix from a plain comment the waiver delivers', async () => {
        await initChannel(
          {
            deliverToBoundSessions: true,
            ...listed,
            messageRoutes: { '/review': 'Review the change.' },
          },
          { boundSessions },
        );
        mockOctokit.paginate
          .mockResolvedValueOnce([prNotification()])
          .mockResolvedValueOnce([
            makeComment({
              body: '/review please check the nit',
              user: { login: 'alice' },
            }),
          ]);

        await pollOnce();

        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
        const prompt = boundSessions.deliverPrompt.mock.calls[0]![1] as string;
        expect(prompt).toContain('please check the nit');
        expect(prompt).not.toContain('/review');
      });

      it('admits an unprefixed plain comment through the default message route', async () => {
        await initChannel(
          {
            deliverToBoundSessions: true,
            ...listed,
            messageRoutes: { '/review': 'Review the change.' },
            defaultMessageRoute: '/review',
          },
          { boundSessions },
        );
        mockOctokit.paginate
          .mockResolvedValueOnce([prNotification()])
          .mockResolvedValueOnce([plainReview()]);

        await pollOnce();

        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
        expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
          'please rename fetchAll',
        );
        expect(boundSessions.deliverPrompt.mock.calls[0]![2]).toBe(
          'github:owner/repo:1001',
        );
        expect(channel.inboundEnvelopes).toHaveLength(0);
      });

      it.each(['mention', 'subscribed'])(
        'still delivers a mentioning first-contact body when a plain comment is deferred (%s)',
        async (reason) => {
          await initChannel(
            { deliverToBoundSessions: true, ...listed },
            { boundSessions },
          );
          mockOctokit.rest.issues.get.mockResolvedValue({
            data: {
              title: 'Test PR',
              body: '@test-bot please review the retry',
              user: { login: 'alice' },
            },
          });
          boundSessions.deliverPrompt.mockImplementation(
            async (_sessionId: string, _prompt: string, key: string) => {
              if (key.endsWith(':1001')) {
                throw new BoundSessionQueueFullError('bound-session');
              }
              return { accepted: true };
            },
          );
          mockOctokit.paginate
            .mockResolvedValueOnce([
              prNotification(reason, { last_read_at: null }),
            ])
            .mockResolvedValueOnce([plainReview()]);
          const stderr = vi
            .spyOn(process.stderr, 'write')
            .mockReturnValue(true);
          try {
            await pollOnce();
          } finally {
            stderr.mockRestore();
          }

          expect(
            boundSessions.deliverPrompt.mock.calls.map((call) => call[2]),
          ).toContain('github:owner/repo:issue-body-42');
        },
      );

      it.each(['mention', 'subscribed'])(
        'posts no public error comment for a plain comment whose deferral cannot be saved (%s)',
        async (reason) => {
          await initChannel(
            { deliverToBoundSessions: true, ...listed },
            { boundSessions },
          );
          boundSessions.deliverPrompt.mockRejectedValue(
            new BoundSessionGoneError('bound-session'),
          );
          // The session is gone and the next scan is partial, so the task is
          // deferred; that write fails.
          boundSessions.listPrBindings
            .mockResolvedValueOnce({
              bindings: [makeBinding()],
              partial: false,
            })
            .mockResolvedValue({ bindings: [], partial: true });
          const priv = channel as unknown as {
            transitionInboundTask: (
              id: string,
              state: string,
              updates?: Record<string, unknown>,
            ) => unknown;
          };
          const transition = priv.transitionInboundTask.bind(channel);
          vi.spyOn(priv, 'transitionInboundTask').mockImplementation(
            (id, state, updates) => {
              if (state === 'failed' && updates?.['backpressure'] === true) {
                throw new Error('EIO: task store');
              }
              return transition(id, state, updates);
            },
          );
          mockOctokit.paginate
            .mockResolvedValueOnce([prNotification(reason)])
            .mockResolvedValueOnce([plainReview()]);
          const stderr = vi
            .spyOn(process.stderr, 'write')
            .mockReturnValue(true);
          try {
            await pollOnce();
          } finally {
            stderr.mockRestore();
          }

          expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
          expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
        },
      );

      it.each(['mention', 'subscribed'])(
        'still reads a mentioning first-contact body when the session of a plain comment is gone (%s)',
        async (reason) => {
          await initChannel(
            { deliverToBoundSessions: true, ...listed },
            { boundSessions },
          );
          mockOctokit.rest.issues.get.mockResolvedValue({
            data: {
              title: 'Test PR',
              body: '@test-bot please review the retry',
              user: { login: 'alice' },
            },
          });
          boundSessions.deliverPrompt.mockRejectedValue(
            new BoundSessionGoneError('bound-session'),
          );
          // The gone session is evicted, and the scan that follows is
          // partial, so the plain comment is deferred.
          boundSessions.listPrBindings
            .mockResolvedValueOnce({
              bindings: [makeBinding()],
              partial: false,
            })
            .mockResolvedValue({ bindings: [], partial: true });
          mockOctokit.paginate
            .mockResolvedValueOnce([
              prNotification(reason, { last_read_at: null }),
            ])
            .mockResolvedValueOnce([plainReview()]);
          const stderr = vi
            .spyOn(process.stderr, 'write')
            .mockReturnValue(true);
          try {
            await pollOnce();
          } finally {
            stderr.mockRestore();
          }

          expect(mockOctokit.rest.issues.get).toHaveBeenCalled();
          expect(
            readInboundTasks().map(
              (task) => (task['source'] as { messageId: string }).messageId,
            ),
          ).toContain('issue-body-42');
        },
      );

      it('strips a message-route prefix from the delivered prompt', async () => {
        await initChannel(
          {
            deliverToBoundSessions: true,
            messageRoutes: { '/review': 'Review the change.' },
          },
          { boundSessions },
        );
        mockOctokit.paginate
          .mockResolvedValueOnce([prNotification()])
          .mockResolvedValueOnce([
            makeComment({ body: '@test-bot /review please check the nit' }),
          ]);

        await pollOnce();

        const prompt = boundSessions.deliverPrompt.mock.calls[0]![1] as string;
        expect(prompt).toContain('please check the nit');
        expect(prompt).not.toContain('/review');
      });

      it('neither delivers nor opens a pairing request for an unapproved paired repository', async () => {
        await initChannel(
          { deliverToBoundSessions: true, groupPolicy: 'pairing', ...listed },
          { boundSessions },
        );
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          mockOctokit.paginate
            .mockResolvedValueOnce([prNotification()])
            .mockResolvedValueOnce([plainReview()]);

          await pollOnce();

          expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
          expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
          expect(
            new PairingStore('test-github', '/tmp/test').listPending(),
          ).toEqual([]);
          // Dropped at the lane: the repository is not admitted yet, so no
          // task is claimed and rejected for it.
          expect(
            stderr.mock.calls.some((call) =>
              String(call[0]).includes('rejected by the channel preflight'),
            ),
          ).toBe(false);
        } finally {
          stderr.mockRestore();
        }
      });

      it('delivers a listed sender plain comment in an approved paired repository', async () => {
        await initChannel(
          { deliverToBoundSessions: true, groupPolicy: 'pairing', ...listed },
          { boundSessions },
        );
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
          .mockResolvedValueOnce([prNotification()])
          .mockResolvedValueOnce([plainReview()]);

        await pollOnce();

        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      });
    });

    it('surfaces a bound preflight rejection instead of consuming silently', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          // Group-shaped envelopes are gated by the GROUP sender policy.
          groups: { '*': { senders: 'allowlist', allowedUsers: [] } },
        },
        { boundSessions },
      );
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        mockOctokit.paginate
          .mockResolvedValueOnce([prNotification()])
          .mockResolvedValueOnce([makeComment()]);
        await pollOnce();
        expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
        expect(
          stderr.mock.calls.some((call) =>
            String(call[0]).includes('rejected by the channel preflight'),
          ),
        ).toBe(true);
      } finally {
        stderr.mockRestore();
      }
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('never delivers privately to a channel-owned session and defers its PR under partial', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // Channel-owned sessions keep the public channel path: they never
      // enter the private routing map, even on a complete snapshot.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [makeBinding({ sourceType: 'channel' })],
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(1);

      // Under a partial answer the PR defers like any unmatched PR: the
      // channel binding cannot prove an invisible workspace has no
      // follower. Crucially it is never delivered privately to the
      // channel session.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: true,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
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
            updated_at: '2026-07-02T10:30:00.000Z',
          }),
        ]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(readInboundTasks()[0]!['backpressure']).toBe(true);

      // Complete snapshot: absence established, public reply exactly once.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(2);
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
    });

    it('does not record aggregate dedupe keys when the task claim fails (A-F1)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // An unwritable/corrupt task store: the claim throws, the per-
      // notification catch swallows it, and the poll completes "normally".
      writeInboundTasks([]);
      writeFileSync(inboundTaskPath(), '{corrupt', 'utf-8');
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([
          makeComment({ body: 'LOSS-CHECK-1 ambient remark' }),
        ]);
      await pollOnce();
      const ch = channel as unknown as {
        cursor: { dispatchedComments?: string[] };
      };
      // No key may be recorded: the end-of-poll cursor save would persist
      // it while no task exists, and the comment would be filtered forever.
      expect(ch.cursor.dispatchedComments ?? []).toHaveLength(0);
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();

      // Heal the store: the SAME comment must still be deliverable.
      writeInboundTasks([]);
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([
          makeComment({ body: 'LOSS-CHECK-1 ambient remark' }),
        ]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'LOSS-CHECK-1',
      );
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
      // PR 43's only OBSERVED binder unbound, but a partial answer cannot
      // prove an invisible workspace has no follower: defer — no public
      // reply yet, and no private revival of S.
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(readInboundTasks()[0]!['backpressure']).toBe(true);

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
        expect.any(String),
      );

      // A complete snapshot establishes absence: recovery re-drives the
      // deferred PR 43 event onto the channel path exactly once.
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
      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
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

    it('iterates past two Gone followers to a live third instead of going public (R13-M2)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // Three followers of PR 42, newest first; s1 and s2 are Gone, s3 live.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            sessionId: 's1',
            updatedAt: '2026-07-02T03:00:00.000Z',
          }),
          makeBinding({
            sessionId: 's2',
            updatedAt: '2026-07-02T02:00:00.000Z',
          }),
          makeBinding({
            sessionId: 's3',
            updatedAt: '2026-07-02T01:00:00.000Z',
          }),
        ],
        partial: false,
      });
      boundSessions.deliverPrompt.mockImplementation(
        async (sessionId: string) => {
          if (sessionId === 's1' || sessionId === 's2') {
            throw new BoundSessionGoneError(sessionId);
          }
        },
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      // s1 → s2 → s3 all tried; the live third follower takes the event and
      // nothing falls back to the public channel path.
      expect(boundSessions.deliverPrompt.mock.calls.map((c) => c[0])).toEqual([
        's1',
        's2',
        's3',
      ]);
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('excludes a Gone winner a stale refresh re-lists and tries the next follower (R13-M2)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // A STALE snapshot keeps re-listing the Gone s1 as the newest winner;
      // s2 is a live follower. The Gone set must exclude s1 regardless.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            sessionId: 's1',
            updatedAt: '2026-07-02T03:00:00.000Z',
          }),
          makeBinding({
            sessionId: 's2',
            updatedAt: '2026-07-02T02:00:00.000Z',
          }),
        ],
        partial: false,
      });
      boundSessions.deliverPrompt.mockImplementation(
        async (sessionId: string) => {
          if (sessionId === 's1') throw new BoundSessionGoneError(sessionId);
        },
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      // s1 (Gone) then s2 (live) — not s1 again, and not the public path.
      expect(boundSessions.deliverPrompt.mock.calls.map((c) => c[0])).toEqual([
        's1',
        's2',
      ]);
      expect(channel.inboundEnvelopes).toHaveLength(0);
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

    it('processes the comment lane under a permanently partial snapshot (G4)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [makeBinding()],
        partial: true,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      // A partial snapshot still populates the map: the lane must not stall
      // waiting for a complete enumeration that never arrives.
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt).toHaveBeenCalledWith(
        'bound-session',
        expect.any(String),
        expect.any(String),
      );
      expect(channel.inboundEnvelopes).toHaveLength(0);
      const cursor = (
        channel as unknown as { cursor: { lastProcessedAt: string } }
      ).cursor;
      expect(cursor.lastProcessedAt).toBe('2026-07-02T10:00:00.000Z');
    });

    it('does not revive a cancelled comment task when the cursor re-lists it (H5)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'cancelled',
          issueNumber: 42,
          delivery: { kind: 'bound-session', sessionId: 'bound-session' },
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: '1001',
          },
          envelope: {
            ...makeInboundTaskRecord().envelope,
            threadId: 'pr:42',
          },
          dedupe: {},
        }),
      ]);
      // Stale cursor: the same comment is re-listed on this poll.
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      const tasks = readInboundTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!['state']).toBe('cancelled');
    });

    it('retires a bound comment to the dead-letter after three generic failures (G10)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.deliverPrompt.mockRejectedValue(
        new Error('delivery exploded'),
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      for (let i = 0; i < 2; i++) {
        mockOctokit.paginate.mockResolvedValueOnce([]);
        await pollOnce();
      }

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(3);
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(existsSync(inboundTaskPath())).toBe(false);
      const lines = readFileSync(boundDeadLetterPath(), 'utf-8')
        .trim()
        .split('\n');
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]!) as { reason: string };
      expect(record.reason).toContain('delivery failed after 3 attempts');
    });

    it('logs the payload without claiming retirement when the dead-letter write fails (G8)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.deliverPrompt.mockRejectedValue(
        new Error('delivery exploded'),
      );
      const originalAppend = nodeFs.appendFileSync;
      const spy = vi.spyOn(nodeFs, 'appendFileSync').mockImplementation(((
        path: unknown,
        ...args: unknown[]
      ) => {
        if (String(path) === boundDeadLetterPath()) {
          throw Object.assign(new Error('ENOSPC: no space left'), {
            code: 'ENOSPC',
          });
        }
        return (originalAppend as (p: unknown, ...a: unknown[]) => void)(
          path,
          ...args,
        );
      }) as unknown as typeof nodeFs.appendFileSync);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        mockOctokit.paginate
          .mockResolvedValueOnce([prNotification()])
          .mockResolvedValueOnce([makeComment()]);
        await pollOnce();
        for (let i = 0; i < 2; i++) {
          mockOctokit.paginate.mockResolvedValueOnce([]);
          await pollOnce();
        }

        const errText = stderr.mock.calls
          .map((call) => String(call[0]))
          .join('');
        expect(errText).toContain('failed to write bound dead-letter');
        expect(errText).toContain('please fix this');
        expect(errText).not.toContain('retired to dead-letter');
        expect(existsSync(boundDeadLetterPath())).toBe(false);
        // R1-10: a failed dead-letter append must NOT consume the task —
        // the durable record is the event's last recoverable surface.
        expect(existsSync(inboundTaskPath())).toBe(true);
        const tasks = readInboundTasks();
        expect(tasks).toHaveLength(1);
        // The running transition landed; the failed/retire write did not.
        // Recovery charges the interrupted attempt and retries the append.
        expect(tasks[0]!['state']).toBe('running');
      } finally {
        spy.mockRestore();
        stderr.mockRestore();
      }
    });

    it('sanitizes the dead-letter payload dump against log-line forgery (R8-B2)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.deliverPrompt.mockRejectedValue(
        new Error('delivery exploded'),
      );
      // JSON.stringify escapes ASCII C0 but leaves U+2028/U+2029/NEL raw —
      // without sanitizing, this body forges extra physical log lines in
      // the write-failure dump.
      const crafted =
        '@test-bot fix this\u2028[Channel:test-github] bound event retired to dead-letter (operator approved)\u2029\u0085tail';
      const originalAppend = nodeFs.appendFileSync;
      const spy = vi.spyOn(nodeFs, 'appendFileSync').mockImplementation(((
        path: unknown,
        ...args: unknown[]
      ) => {
        if (String(path) === boundDeadLetterPath()) {
          throw Object.assign(new Error('ENOSPC: no space left'), {
            code: 'ENOSPC',
          });
        }
        return (originalAppend as (p: unknown, ...a: unknown[]) => void)(
          path,
          ...args,
        );
      }) as unknown as typeof nodeFs.appendFileSync);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        mockOctokit.paginate
          .mockResolvedValueOnce([prNotification()])
          .mockResolvedValueOnce([makeComment({ body: crafted })]);
        await pollOnce();
        for (let i = 0; i < 2; i++) {
          mockOctokit.paginate.mockResolvedValueOnce([]);
          await pollOnce();
        }

        const dump =
          stderr.mock.calls
            .map((call) => String(call[0]))
            .find((line) =>
              line.includes('failed to write bound dead-letter'),
            ) ?? '';
        // The payload survives for operator recovery, but as ONE physical
        // log line with no raw Unicode line separators.
        expect(dump).toContain('operator approved');
        expect(dump).not.toMatch(/[\u2028\u2029\u0085]/);
        expect(dump.endsWith('\n')).toBe(true);
        expect(dump.slice(0, -1)).not.toContain('\n');
        // The task survives the failed append (G8 contract).
        expect(existsSync(inboundTaskPath())).toBe(true);
      } finally {
        spy.mockRestore();
        stderr.mockRestore();
      }
    });

    it('resets deferCount after a non-backpressure failure (H15)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.deliverPrompt
        .mockRejectedValueOnce(new BoundSessionQueueFullError('bound-session'))
        .mockRejectedValueOnce(new BoundSessionQueueFullError('bound-session'))
        .mockRejectedValue(new Error('delivery exploded'));
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();
      let tasks = readInboundTasks();
      expect(tasks[0]!['deferCount']).toBe(2);

      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();

      tasks = readInboundTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!['deferCount']).toBe(0);
      expect(tasks[0]!['backpressure']).toBe(false);
      expect(tasks[0]!['attempts']).toBe(1);
    });

    it('evicts a gone session so a partial snapshot cannot retain it (C2)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      const newer = makeBinding({
        sessionId: 'S1',
        updatedAt: '2026-07-03T00:00:00.000Z',
      });
      const older = makeBinding({
        sessionId: 'S2',
        updatedAt: '2026-07-01T00:00:00.000Z',
      });
      // First snapshot is complete and lists both followers. Every later
      // scan is partial and lists only S2: without the eviction the partial
      // retention keeps S1 by recency and the comment degrades to public.
      boundSessions.listPrBindings
        .mockResolvedValueOnce({ bindings: [newer, older], partial: false })
        .mockResolvedValue({ bindings: [older], partial: true });
      boundSessions.deliverPrompt.mockImplementation((sessionId: string) =>
        sessionId === 'S1'
          ? Promise.reject(new BoundSessionGoneError('S1'))
          : Promise.resolve(undefined),
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(
        boundSessions.deliverPrompt.mock.calls.map((call) => call[0]),
      ).toEqual(['S1', 'S2']);
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(existsSync(boundDeadLetterPath())).toBe(false);
    });

    it('persists the acceptance mark before any pending-delivery read (C5)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      // A corrupt pending-deliveries sidecar makes the strict reader throw.
      // The bound acceptance mark must land before that read so the task is
      // retired instead of left running for recovery to replay.
      const pendingPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-pending-deliveries.json',
      );
      mkdirSync(dirname(pendingPath), { recursive: true });
      writeFileSync(pendingPath, '{corrupt json', 'utf-8');
      const removable = channel as unknown as {
        removeInboundTask: (id: string) => void;
      };
      const originalRemove = removable.removeInboundTask.bind(removable);
      let deliveredAtAtRemoval: unknown;
      const spy = vi
        .spyOn(removable, 'removeInboundTask')
        .mockImplementationOnce((id: string) => {
          deliveredAtAtRemoval = readInboundTasks()[0]?.['deliveredAt'];
          originalRemove(id);
        });
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        mockOctokit.paginate
          .mockResolvedValueOnce([prNotification()])
          .mockResolvedValueOnce([makeComment()]);
        await pollOnce();

        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
        expect(deliveredAtAtRemoval).toEqual(expect.any(Number));
        expect(existsSync(inboundTaskPath())).toBe(false);
        expect(
          stderr.mock.calls.some((call) =>
            String(call[0]).includes(
              'failed to read pending GitHub deliveries',
            ),
          ),
        ).toBe(false);

        // Recovery must not replay the accepted injection.
        const recoverable = channel as unknown as {
          inboundRecoveryPending: boolean;
        };
        recoverable.inboundRecoveryPending = true;
        mockOctokit.paginate.mockResolvedValueOnce([]);
        await pollOnce();
        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
        stderr.mockRestore();
      }
    });

    it('falls back publicly when the re-delivery hop is also gone (N11)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      const first = makeBinding({
        sessionId: 'S1',
        updatedAt: '2026-07-03T00:00:00.000Z',
      });
      const second = makeBinding({
        sessionId: 'S2',
        updatedAt: '2026-07-01T00:00:00.000Z',
      });
      boundSessions.listPrBindings
        .mockResolvedValueOnce({ bindings: [first], partial: false })
        .mockResolvedValue({ bindings: [second], partial: true });
      boundSessions.deliverPrompt.mockImplementation((sessionId: string) =>
        Promise.reject(new BoundSessionGoneError(sessionId)),
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      // Both candidates were tried and are authoritatively gone, but the
      // last scan was PARTIAL: an invisible workspace may still follow the
      // PR, so the fallback defers instead of publishing irreversibly —
      // and the Gone must not burn the failure budget into a dead-letter.
      expect(
        boundSessions.deliverPrompt.mock.calls.map((call) => call[0]),
      ).toEqual(['S1', 'S2']);
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(existsSync(boundDeadLetterPath())).toBe(false);
      const tasks = readInboundTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!['backpressure']).toBe(true);

      // A complete snapshot establishes absence: public fallback once.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('matches bindings on a GHE Cloud data-residency tenant host (S1)', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          baseUrl: 'https://api.acme.ghe.com/api/v3',
        },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            prs: [
              {
                number: 42,
                url: 'https://acme.ghe.com/acme/widgets/pull/42',
                state: 'open',
              },
            ],
          }),
        ],
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'mention',
            subject: {
              title: 'Test PR',
              url: 'https://api.acme.ghe.com/repos/acme/widgets/pulls/42',
              type: 'PullRequest',
            },
          }),
        ])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      // The injected identity must name the web host, not the API host.
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'https://acme.ghe.com/acme/widgets/pull/42',
      );
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('caps the bound prompt body at 6000 code points (S2)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      const body = `@test-bot ${'x'.repeat(5_990)}${'🎉'.repeat(20)}`;
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification()])
        .mockResolvedValueOnce([makeComment({ body })]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      const prompt = boundSessions.deliverPrompt.mock.calls[0]![1] as string;
      expect(prompt).toContain('[GitHub event for a PR this session follows]');
      const bodyPart = prompt.slice(prompt.lastIndexOf('\n\n') + 2);
      // The cut must be VISIBLE (R1-1): the content slice keeps the 6,000
      // code-point cap, and an explicit omission notice rides outside it.
      const noticeStart = bodyPart.lastIndexOf('\n[prompt truncated:');
      expect(noticeStart).toBeGreaterThan(0);
      const content = bodyPart.slice(0, noticeStart);
      const codePoints = Array.from(content);
      expect(codePoints).toHaveLength(6_000);
      // The cap counts code points, so it never splits a surrogate pair.
      expect(
        codePoints.some((ch) => {
          const cp = ch.codePointAt(0)!;
          return cp >= 0xd800 && cp <= 0xdfff;
        }),
      ).toBe(false);
      expect(content.endsWith('🎉')).toBe(true);
      // The mention lane strips '@test-bot' (9 chars): 5,990 + 20 + 1
      // = 6,011 code points composed; 11 omitted.
      expect(bodyPart.slice(noticeStart + 1)).toBe(
        '[prompt truncated: 11 more characters omitted]',
      );
    });

    it('reports a never-succeeded binding snapshot instead of keeping a map (N1)', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockRejectedValue(
        new Error('route not found'),
      );
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await pollOnce();
        await pollOnce();

        const errText = stderr.mock.calls
          .map((call) => String(call[0]))
          .join('');
        expect(errText).toContain('binding snapshot has never succeeded');
        expect(errText).toContain('ALL notifications are stalled');
        expect(errText).not.toContain('keeping previous map');
        // Throttled: only the first failure in the streak is logged.
        expect(
          stderr.mock.calls.filter((call) =>
            String(call[0]).includes('has never succeeded'),
          ),
        ).toHaveLength(1);
      } finally {
        stderr.mockRestore();
      }
    });
  });

  describe('role-aware bound delivery (boundSessionActions)', () => {
    const roleBindings = () => [
      makeBinding({
        sessionId: 'review-session',
        updatedAt: '2026-07-02T00:00:00.000Z',
        prs: [
          {
            number: 42,
            url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
            role: 'review',
          },
        ],
      }),
      makeBinding({
        sessionId: 'verify-session',
        updatedAt: '2026-07-02T00:00:00.000Z',
        prs: [
          {
            number: 42,
            url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
            role: 'verify',
          },
        ],
      }),
      makeBinding({
        sessionId: 'fix-session',
        updatedAt: '2026-07-02T00:00:00.000Z',
        prs: [
          {
            number: 42,
            url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
            role: 'fix',
          },
        ],
      }),
    ];

    describe('configuration validation', () => {
      it('rejects unknown keys by name, empty values, and oversized templates', () => {
        expect(
          validateBoundSessionConfig(
            {
              deliverToBoundSessions: true,
              boundSessionActions: { 'review:bogus': 'do it' },
            },
            'test-github',
          ),
        ).toContain('review:bogus');
        expect(
          validateBoundSessionConfig(
            {
              deliverToBoundSessions: true,
              boundSessionActions: { default: '   ' },
            },
            'test-github',
          ),
        ).toContain('non-empty');
        expect(
          validateBoundSessionConfig(
            {
              deliverToBoundSessions: true,
              boundSessionActions: {
                default: 'x'.repeat(2_001),
              },
            },
            'test-github',
          ),
        ).toContain('2000');
      });

      it('requires deliverToBoundSessions and accepts the closed vocabulary', () => {
        expect(
          validateBoundSessionConfig(
            { boundSessionActions: { default: 'do it' } },
            'test-github',
          ),
        ).toContain('deliverToBoundSessions');
        expect(
          validateBoundSessionConfig(
            {
              deliverToBoundSessions: true,
              boundSessionActions: {
                default: 'triage',
                'watch:head_change': 're-review',
                'review:watch:head_change': 're-review',
                'verify:default': 'verify',
                comment: 'address comments',
                state_change: 'notification reason',
                'watch:state_change': 'watch transition',
              },
            },
            'test-github',
          ),
        ).toBeUndefined();
        expect(
          validateBoundSessionConfig(
            {
              deliverToBoundSessions: true,
              boundSessionActions: { 'triage:comment': 'unknown role' },
            },
            'test-github',
          ),
        ).toContain('triage:comment');
      });
    });

    it('fans a comment out to the matched roles only, with rendered templates', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          boundSessionActions: {
            'review:comment': 'Review the new comments on %repo%#%pr%.',
            'fix:comment': 'Address the comments (role %role%, event %event%).',
          },
        },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: roleBindings(),
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      const calls = boundSessions.deliverPrompt.mock.calls as Array<
        [string, string]
      >;
      const bySession = new Map(calls.map(([id, prompt]) => [id, prompt]));
      expect(bySession.get('review-session')).toContain(
        'Review the new comments on owner/repo#42.',
      );
      expect(bySession.get('review-session')).toContain('Role: review');
      expect(bySession.get('review-session')).toContain(
        '[Operator instruction — trusted',
      );
      expect(bySession.get('fix-session')).toContain(
        'Address the comments (role fix, event comment).',
      );
      // verify has no comment key: the map is a per-role subscription.
      expect(bySession.has('verify-session')).toBe(false);
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('delivers a listed sender plain comment to the subscribed role only', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          groups: { '*': { senders: 'allowlist', allowedUsers: ['alice'] } },
          boundSessionActions: { 'fix:comment': 'Address %sender%.' },
        },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: roleBindings(),
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('mention')])
        .mockResolvedValueOnce([
          makeComment({ body: 'please rename fetchAll' }),
          makeComment({
            id: 1002,
            body: 'drive-by remark',
            user: { login: 'mallory' },
          }),
        ]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      const [sessionId, prompt] = boundSessions.deliverPrompt.mock.calls[0] as [
        string,
        string,
      ];
      expect(sessionId).toBe('fix-session');
      expect(prompt).toContain('Address alice.');
      expect(prompt).toContain('please rename fetchAll');
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('resolves a plain comment as a comment event, not the thread reason', async () => {
      // A mention template is for mentions: a plain comment on a mention
      // thread matches no role here, so the lane drops it quietly.
      await initChannel(
        {
          deliverToBoundSessions: true,
          groups: { '*': { senders: 'allowlist', allowedUsers: ['alice'] } },
          boundSessionActions: { 'fix:mention': 'Address %sender%.' },
        },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: roleBindings(),
        partial: false,
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        mockOctokit.paginate
          .mockResolvedValueOnce([prNotification('mention')])
          .mockResolvedValueOnce([
            makeComment({ body: 'LGTM, thanks!' }),
            makeComment({
              id: 1002,
              body: '@test-bot please rename fetchAll',
            }),
          ]);

        await pollOnce();

        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
        expect(boundSessions.deliverPrompt.mock.calls[0]![2]).toBe(
          'github:owner/repo:1002',
        );
        expect(
          stderr.mock.calls.some((call) =>
            String(call[0]).includes('event 1001'),
          ),
        ).toBe(false);
      } finally {
        stderr.mockRestore();
      }
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('applies the comment template, not the thread reason template, to a plain comment', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          groups: { '*': { senders: 'allowlist', allowedUsers: ['alice'] } },
          boundSessionActions: {
            'fix:mention': 'Address %sender%.',
            'review:comment': 'Look at %sender%.',
          },
        },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: roleBindings(),
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('mention')])
        .mockResolvedValueOnce([makeComment({ body: 'LGTM, thanks!' })]);

      await pollOnce();

      expect(
        boundSessions.deliverPrompt.mock.calls.map((call) => call[0]),
      ).toEqual(['review-session']);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'Look at alice.',
      );
    });

    it('leaves the first-contact feed as before for a plain comment no role takes', async () => {
      // Followed, but no template covers a subscribed comment: the waiver
      // admits nothing, so the comment runs in order and, deferred under a
      // partial scan, suppresses the body this poll as it always has.
      await initChannel(
        {
          deliverToBoundSessions: true,
          groups: { '*': { senders: 'allowlist', allowedUsers: ['alice'] } },
          boundSessionActions: { 'review:review_requested': 'review it' },
        },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: roleBindings(),
        partial: true,
      });
      mockOctokit.rest.issues.get.mockResolvedValue({
        data: {
          title: 'Test PR',
          body: '@test-bot please review the retry',
          user: { login: 'alice' },
        },
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([
          prNotification('subscribed', { last_read_at: null }),
        ])
        .mockResolvedValueOnce([makeComment({ body: 'LGTM, thanks!' })]);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await pollOnce();
      } finally {
        stderr.mockRestore();
      }

      expect(mockOctokit.rest.issues.get).not.toHaveBeenCalled();
    });

    it('retires privately when followers exist but no role matched', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          boundSessionActions: {
            'fix:watch:ci_failure': 'fix it',
          },
        },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: roleBindings(),
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('resolves role:default then bare keys, and keeps untyped bindings on the bare chain', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          boundSessionActions: {
            'review:default': 'review fallback',
            comment: 'bare comment instruction',
          },
        },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          ...roleBindings(),
          makeBinding({ sessionId: 'untyped-session' }),
        ],
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      const calls = boundSessions.deliverPrompt.mock.calls as Array<
        [string, string]
      >;
      const bySession = new Map(calls.map(([id, prompt]) => [id, prompt]));
      // review:comment absent → review:default wins over the bare key.
      expect(bySession.get('review-session')).toContain('review fallback');
      // verify/fix have no role chain match → bare comment key.
      expect(bySession.get('verify-session')).toContain(
        'bare comment instruction',
      );
      expect(bySession.get('fix-session')).toContain(
        'bare comment instruction',
      );
      // The untyped binding resolves only the bare chain, no Role line.
      expect(bySession.get('untyped-session')).toContain(
        'bare comment instruction',
      );
      expect(bySession.get('untyped-session')).not.toContain('Role:');
    });

    it('renders %% escapes, leaves unknown variables literal, and caps hostile titles', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          boundSessionActions: {
            default: '100%% done %unknown% %title%',
          },
        },
        { boundSessions },
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            subject: {
              title: 'T'.repeat(300),
              url: 'https://api.github.com/repos/owner/repo/pulls/42',
              type: 'PullRequest',
            },
          }),
        ])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      const prompt = boundSessions.deliverPrompt.mock.calls[0]![1] as string;
      expect(prompt).toContain('100% done %unknown%');
      // The cap applies to the SUBSTITUTED value in the operator block; the
      // identity line keeps the full title per the existing prompt contract.
      const lines = prompt.split('\n');
      const operatorLine =
        lines[
          lines.indexOf(
            "[Operator instruction — trusted, from this channel's configuration]",
          ) + 1
        ] ?? '';
      expect(operatorLine).toContain('[truncated]');
      expect(operatorLine).not.toContain('T'.repeat(201));
    });

    it('defers one queue-full role without blocking the other roles', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          boundSessionActions: {
            'review:comment': 'review',
            'verify:comment': 'verify',
          },
        },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: roleBindings(),
        partial: false,
      });
      boundSessions.deliverPrompt.mockImplementation(
        async (sessionId: string) => {
          if (sessionId === 'review-session') {
            throw new BoundSessionQueueFullError(sessionId);
          }
        },
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      const delivered = (
        boundSessions.deliverPrompt.mock.calls as Array<[string]>
      ).map(([id]) => id);
      expect(delivered).toContain('verify-session');
      expect(delivered).toContain('review-session');
      // The review target persists as a backpressure task; verify settled.
      const tasks = JSON.parse(
        readFileSync(inboundTaskPath(), 'utf-8'),
      ) as Array<{
        delivery?: { sessionId?: string };
        backpressure?: boolean;
      }>;
      const review = tasks.find(
        (task) => task.delivery?.sessionId === 'review-session',
      );
      expect(review?.backpressure).toBe(true);
      expect(
        tasks.some((task) => task.delivery?.sessionId === 'verify-session'),
      ).toBe(false);
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('keeps the legacy prompt byte-compatible when no actions are configured', async () => {
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      const prompt = boundSessions.deliverPrompt.mock.calls[0]![1] as string;
      expect(prompt).toContain('Handle the event with your normal workflow');
      expect(prompt).not.toContain('[Operator instruction');
      expect(prompt).not.toContain('Role:');
    });

    it('legacy gone-fallback stays generic even when bindings carry roles', async () => {
      // A /review backfill stamps roles with no map configured; the legacy
      // gone-fallback must not leak the role into the generic prompt.
      await initChannel({ deliverToBoundSessions: true }, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            sessionId: 'gone-session',
            updatedAt: '2026-07-03T00:00:00.000Z',
            prs: [
              {
                number: 42,
                url: 'https://github.com/owner/repo/pull/42',
                state: 'open',
                role: 'review',
              },
            ],
          }),
          makeBinding({ sessionId: 'live-session' }),
        ],
        partial: false,
      });
      boundSessions.deliverPrompt.mockImplementation(
        async (sessionId: string) => {
          if (sessionId === 'gone-session') {
            throw new BoundSessionGoneError(sessionId);
          }
        },
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      const calls = boundSessions.deliverPrompt.mock.calls as Array<
        [string, string]
      >;
      const fallback = calls.find(([id]) => id === 'live-session');
      expect(fallback).toBeDefined();
      expect(fallback![1]).toContain(
        'Handle the event with your normal workflow',
      );
      expect(fallback![1]).not.toContain('Role:');
      expect(fallback![1]).not.toContain('[Operator instruction');
    });
  });

  describe('review-round regressions (durable fan-out, delivery ring, role loss, partial guard, lane class)', () => {
    const reviewBinding = () =>
      makeBinding({
        sessionId: 'review-session',
        prs: [
          {
            number: 42,
            url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
            role: 'review',
          },
        ],
      });
    const verifyBinding = () =>
      makeBinding({
        sessionId: 'verify-session',
        prs: [
          {
            number: 42,
            url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
            role: 'verify',
          },
        ],
      });
    const fixBinding = () =>
      makeBinding({
        sessionId: 'fix-session',
        prs: [
          {
            number: 42,
            url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
            role: 'fix',
          },
        ],
      });

    function tasksPath(): string {
      return inboundTaskPath();
    }
    function deliveredRingPath(): string {
      const nameHash = createHash('sha256')
        .update('test-github')
        .digest('hex')
        .slice(0, 16);
      return join(
        process.env.QWEN_HOME!,
        'channels',
        getWorkspaceScopeDirName('/tmp/test'),
        `test-github-${nameHash}-github-bound-delivered.json`,
      );
    }
    function writeTasks(records: unknown[]): void {
      const path = tasksPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(records)}\n`, 'utf-8');
    }
    function readTasks(): Array<Record<string, unknown>> {
      if (!existsSync(tasksPath())) return [];
      return JSON.parse(readFileSync(tasksPath(), 'utf-8')) as Array<
        Record<string, unknown>
      >;
    }
    const commentEnvelope = {
      channelName: 'test-github',
      senderId: 'alice',
      senderName: 'alice',
      chatId: 'owner/repo',
      threadId: 'pr:42',
      messageId: '1001',
      text: '@test-bot please fix this',
      isGroup: true,
      isMentioned: true,
      isReplyToBot: false,
      metadata:
        'Type: Pull Request | Title: Test PR | URL: https://github.com/owner/repo/pull/42\nTrigger: comment.',
    };

    it('reconstructs missing fan-out siblings after a crash between claims (C1)', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          boundSessionActions: {
            'review:comment': 'review it',
            'verify:comment': 'verify it',
          },
        },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [reviewBinding(), verifyBinding()],
        partial: false,
      });
      // The crash state: only the FIRST target's task survived, carrying
      // the full fan-out intent and the event-wide dedupe key. Without
      // reconstruction, recovery applies the survivor's dedupe and the
      // re-listed comment is skipped — verify loses the event permanently.
      writeTasks([
        {
          version: 1,
          id: 'survivor',
          createdAt: '2026-07-02T09:00:00.000Z',
          updatedAt: '2026-07-02T09:00:00.000Z',
          state: 'accepted',
          issueNumber: 42,
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: '1001',
          },
          envelope: commentEnvelope,
          dedupe: { dispatchedComments: ['C_1001'] },
          attempts: 0,
          delivery: {
            kind: 'bound-session',
            sessionId: 'review-session',
            role: 'review',
          },
          fanout: [
            { sessionId: 'review-session', role: 'review' },
            { sessionId: 'verify-session', role: 'verify' },
          ],
        },
      ]);
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);

      await pollOnce();

      const delivered = (
        boundSessions.deliverPrompt.mock.calls as Array<[string]>
      ).map(([id]) => id);
      expect(delivered).toContain('review-session');
      expect(delivered).toContain('verify-session');
      expect(delivered).toHaveLength(2);
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('keeps the private-only mark on a reconstructed fan-out sibling', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          boundSessionActions: {
            'review:comment': 'review it',
            'verify:comment': 'verify it',
          },
        },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [reviewBinding(), verifyBinding()],
        partial: false,
      });
      // The verify sibling stays in the store, so its record can be read.
      boundSessions.deliverPrompt.mockImplementation(async (sessionId) => {
        if (sessionId === 'verify-session') {
          throw new BoundSessionQueueFullError('bound-session');
        }
        return { accepted: true };
      });
      writeTasks([
        {
          version: 1,
          id: 'survivor',
          createdAt: '2026-07-02T09:00:00.000Z',
          updatedAt: '2026-07-02T09:00:00.000Z',
          state: 'accepted',
          issueNumber: 42,
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: '1001',
          },
          envelope: commentEnvelope,
          dedupe: { dispatchedComments: ['C_1001'] },
          attempts: 0,
          delivery: {
            kind: 'bound-session',
            sessionId: 'review-session',
            role: 'review',
          },
          fanout: [
            { sessionId: 'review-session', role: 'review' },
            { sessionId: 'verify-session', role: 'verify' },
          ],
          privateOnly: true,
        },
      ]);
      mockOctokit.paginate.mockResolvedValue([]);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await pollOnce();
      } finally {
        stderr.mockRestore();
      }

      expect(readInboundTasks()).toEqual([
        expect.objectContaining({
          delivery: expect.objectContaining({ sessionId: 'verify-session' }),
          privateOnly: true,
        }),
      ]);
    });

    it('keeps the private-only mark on siblings claimed when recovery finds targets', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          boundSessionActions: {
            'review:comment': 'review it',
            'verify:comment': 'verify it',
          },
        },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [reviewBinding(), verifyBinding()],
        partial: false,
      });
      // Both stay queued, so their records can be read.
      boundSessions.deliverPrompt.mockRejectedValue(
        new BoundSessionQueueFullError('bound-session'),
      );
      writeTasks([
        {
          version: 1,
          id: 'targetless',
          createdAt: '2026-07-02T09:00:00.000Z',
          updatedAt: '2026-07-02T09:00:00.000Z',
          state: 'failed',
          issueNumber: 42,
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: '1001',
          },
          envelope: commentEnvelope,
          dedupe: { dispatchedComments: ['C_1001'] },
          attempts: 0,
          deferCount: 1,
          backpressure: true,
          privateOnly: true,
        },
      ]);
      mockOctokit.paginate.mockResolvedValue([]);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await pollOnce();
      } finally {
        stderr.mockRestore();
      }

      const tasks = readInboundTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks.every((task) => task['privateOnly'] === true)).toBe(true);
    });

    it('never goes public after a sibling accepted, even across a restart with zero followers (C2)', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          boundSessionActions: {
            'review:comment': 'review it',
            'verify:comment': 'verify it',
          },
        },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [reviewBinding(), verifyBinding()],
        partial: false,
      });
      boundSessions.deliverPrompt.mockImplementation(
        async (sessionId: string) => {
          if (sessionId === 'verify-session') {
            throw new BoundSessionQueueFullError(sessionId);
          }
        },
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      // review accepted privately; the durable ring recorded the event.
      expect(existsSync(deliveredRingPath())).toBe(true);
      const ringKeys = (
        JSON.parse(readFileSync(deliveredRingPath(), 'utf-8')) as {
          keys: string[];
        }
      ).keys;
      // The comment may ride the direct or the aggregate lane; the ring
      // records the event identity AND a per-target completion key.
      expect(ringKeys).toHaveLength(2);
      expect(ringKeys.every((k) => k.startsWith('github:owner/repo:'))).toBe(
        true,
      );
      expect(ringKeys.some((k) => k.includes(':t:review-session'))).toBe(true);

      // Simulate the gone-fallback defer that cleared verify's target, then
      // every follower disappears. Recovery re-resolves to nothing on a
      // COMPLETE snapshot: without the ring the absence gate would route
      // the already-delivered event publicly.
      const deferred = readTasks().map((task) => ({
        ...task,
        delivery: undefined,
        backpressure: true,
      }));
      writeTasks(deferred);
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await pollOnce();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(0);

      // Restart leg: a fresh adapter loads the ring from disk and still
      // suppresses the public fallback for the same event.
      writeTasks(deferred);
      await initChannel(
        {
          deliverToBoundSessions: true,
          boundSessionActions: {
            'review:comment': 'review it',
            'verify:comment': 'verify it',
          },
        },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await pollOnce();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('retires a queued comment whose role lost its match instead of injecting the obsolete instruction (C3)', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          boundSessionActions: { 'review:comment': 'review it' },
        },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [reviewBinding()],
        partial: false,
      });
      boundSessions.deliverPrompt.mockRejectedValue(
        new BoundSessionQueueFullError('review-session'),
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      expect(readTasks().length).toBe(1);

      // The operator changes the binding's role to fix, which has no
      // comment subscription. The queued review comment must retire, not
      // inject the obsolete review instruction into the frozen session.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            sessionId: 'review-session',
            prs: [
              {
                number: 42,
                url: 'https://github.com/owner/repo/pull/42',
                state: 'open',
                role: 'fix',
              },
            ],
          }),
        ],
        partial: false,
      });
      boundSessions.deliverPrompt.mockResolvedValue(undefined);
      mockOctokit.paginate.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await pollOnce();

      // Only the original queue-full attempt; no obsolete injection.
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(readTasks()).toHaveLength(0);
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('defers instead of retiring when no visible role matches under a partial snapshot (D1)', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          boundSessionActions: { 'fix:comment': 'fix it' },
        },
        { boundSessions },
      );
      // Only the review role is visible, and the snapshot is partial: the
      // unscanned fix role might still match. Retiring here would consume
      // the event on incomplete evidence.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [reviewBinding()],
        partial: true,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      const tasks = readTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!['backpressure']).toBe(true);
      expect(tasks[0]!['delivery']).toBeUndefined();

      // The complete snapshot reveals the fix role: the deferred event
      // delivers privately instead of having been consumed.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [fixBinding()],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await pollOnce();
      const delivered = boundSessions.deliverPrompt.mock.calls as Array<
        [string, string]
      >;
      expect(delivered.map(([id]) => id)).toEqual(['fix-session']);
      expect(delivered[0]![1]).toContain('fix it');
    });

    it('matches fix:comment for a comment delivered under another thread reason, reason-specific keys still winning (D2)', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          boundSessionActions: {
            'fix:comment': 'lane instruction',
            'fix:mention': 'mention instruction',
          },
        },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [fixBinding()],
        partial: false,
      });
      // A comment arriving under the subscribed reason matches the lane
      // class `comment`...
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('subscribed')])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      let calls = boundSessions.deliverPrompt.mock.calls as Array<
        [string, string]
      >;
      expect(calls[0]![0]).toBe('fix-session');
      expect(calls[0]![1]).toContain('lane instruction');

      // ...while a reason-specific key still wins for its own reason.
      boundSessions.deliverPrompt.mockClear();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          prNotification('mention', {
            updated_at: '2026-07-02T11:00:00.000Z',
          }),
        ])
        .mockResolvedValueOnce([
          makeComment({ id: 1002, created_at: '2026-07-02T10:30:00.000Z' }),
        ]);
      await pollOnce();
      calls = boundSessions.deliverPrompt.mock.calls as Array<[string, string]>;
      expect(calls[0]![1]).toContain('mention instruction');
    });

    it('keeps the fanout intent durable when a later claim fails to persist (C1 residual)', async () => {
      const config = {
        deliverToBoundSessions: true,
        boundSessionActions: {
          'review:comment': 'review it',
          'verify:comment': 'verify it',
        },
      };
      await initChannel(config, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [reviewBinding(), verifyBinding()],
        partial: false,
      });
      // EIO on the write that would persist BOTH claims: the verify claim
      // fails after the review claim landed. Content-based injection, not a
      // write counter: an interleaved claim-run implementation writes the
      // running transition (and the removal via unlink) before the second
      // claim, so a counter hits the wrong write and masks the regression.
      // Two-phase dispatch must not have run (and removed) the review task
      // yet, so its fanout record survives for recovery.
      const originalRename = nodeFs.renameSync;
      const spy = vi.spyOn(nodeFs, 'renameSync').mockImplementation(((
        from: string,
        to: string,
      ) => {
        if (
          typeof to === 'string' &&
          to.endsWith('-github-inbound-tasks.json')
        ) {
          const staged = JSON.parse(
            nodeFs.readFileSync(from, 'utf-8'),
          ) as unknown[];
          if (Array.isArray(staged) && staged.length === 2) {
            throw Object.assign(new Error('EIO: i/o error'), {
              code: 'EIO',
            });
          }
        }
        return (originalRename as (a: string, b: string) => void)(from, to);
      }) as unknown as typeof nodeFs.renameSync);
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce().catch(() => undefined);
      spy.mockRestore();

      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      const surviving = readTasks();
      expect(surviving).toHaveLength(1);
      expect(surviving[0]!['fanout']).toBeDefined();

      // Restart and re-list: recovery reconstructs verify from the durable
      // fanout and BOTH roles receive the comment.
      await initChannel(config, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [reviewBinding(), verifyBinding()],
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      const delivered = (
        boundSessions.deliverPrompt.mock.calls as Array<[string]>
      ).map(([id]) => id);
      expect(delivered).toContain('review-session');
      expect(delivered).toContain('verify-session');
    });

    it('preserves the comment lane when reconstructing siblings under a mention reason (R2-1)', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          boundSessionActions: {
            'review:comment': 'review it',
            'verify:comment': 'verify it',
          },
        },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [reviewBinding(), verifyBinding()],
        partial: false,
      });
      // Crash state with a MENTION-reason comment: the reconstructed verify
      // sibling must keep the dispatchedComments lane identity, or the
      // lane-class fallback is lost and revalidation retires it.
      writeTasks([
        {
          version: 1,
          id: 'survivor',
          createdAt: '2026-07-02T09:00:00.000Z',
          updatedAt: '2026-07-02T09:00:00.000Z',
          state: 'accepted',
          issueNumber: 42,
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: '1001',
          },
          envelope: {
            ...commentEnvelope,
            metadata:
              'Type: Pull Request | Title: Test PR | URL: https://github.com/owner/repo/pull/42\nTrigger: mention.',
          },
          dedupe: { dispatchedComments: ['C_1001'] },
          attempts: 0,
          delivery: {
            kind: 'bound-session',
            sessionId: 'review-session',
            role: 'review',
          },
          fanout: [
            { sessionId: 'review-session', role: 'review' },
            { sessionId: 'verify-session', role: 'verify' },
          ],
        },
      ]);
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('mention')])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      const delivered = boundSessions.deliverPrompt.mock.calls as Array<
        [string, string]
      >;
      expect(delivered.map(([id]) => id)).toContain('verify-session');
      const verifyPrompt = delivered.find(
        ([id]) => id === 'verify-session',
      )![1];
      expect(verifyPrompt).toContain('verify it');
    });

    it('does not reconstruct a completed target after the role rebinds (R2-2)', async () => {
      await initChannel(
        {
          deliverToBoundSessions: true,
          boundSessionActions: {
            'review:comment': 'review it',
            'verify:comment': 'verify it',
          },
        },
        { boundSessions },
      );
      const verifyOld = makeBinding({
        sessionId: 'verify-old',
        prs: [
          {
            number: 42,
            url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
            role: 'verify',
          },
        ],
      });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [reviewBinding(), verifyOld],
        partial: false,
      });
      boundSessions.deliverPrompt.mockImplementation(
        async (sessionId: string) => {
          if (sessionId === 'review-session') {
            throw new BoundSessionQueueFullError(sessionId);
          }
        },
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      // verify-old accepted and its task was removed; review stays queued
      // holding the full fanout list.
      expect(
        (boundSessions.deliverPrompt.mock.calls as Array<[string]>).map(
          ([id]) => id,
        ),
      ).toContain('verify-old');

      // The verify binding moves to a NEW session while review is still
      // backpressured. Recovery must not recreate verify-old's completed
      // task and retarget it to verify-new — that would execute the event
      // for the verify role a second time.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          reviewBinding(),
          makeBinding({
            sessionId: 'verify-new',
            updatedAt: '2026-07-03T00:00:00.000Z',
            prs: [
              {
                number: 42,
                url: 'https://github.com/owner/repo/pull/42',
                state: 'open',
                role: 'verify',
              },
            ],
          }),
        ],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await pollOnce();
      const all = (
        boundSessions.deliverPrompt.mock.calls as Array<[string]>
      ).map(([id]) => id);
      expect(all).not.toContain('verify-new');
      expect(all.filter((id) => id === 'verify-old')).toHaveLength(1);
    });

    it('keeps ordinary issue comments deliverable when the delivery ring is damaged (R2-3)', async () => {
      const config = {
        deliverToBoundSessions: true,
        boundSessionActions: { 'fix:comment': 'fix it' },
      };
      await initChannel(config, { boundSessions });
      mkdirSync(dirname(deliveredRingPath()), { recursive: true });
      writeFileSync(deliveredRingPath(), '{corrupt', 'utf-8');
      // Fresh adapter loads the damaged ring (fail-closed for PR events).
      await initChannel(config, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      // An ordinary ISSUE comment can never have a PR-bound private
      // delivery: the damaged ring must not retire it.
      mockOctokit.paginate
        .mockResolvedValueOnce([
          makeNotification({
            reason: 'comment',
            subject: {
              title: 'Test Issue',
              url: 'https://api.github.com/repos/owner/repo/issues/42',
              type: 'Issue',
            },
          }),
        ])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      expect(channel.inboundEnvelopes.length).toBeGreaterThan(0);
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
    });

    it('keeps a privately retired comment out of the public path when task removal fails (R2-4)', async () => {
      const config = {
        deliverToBoundSessions: true,
        boundSessionActions: { 'review:comment': 'review it' },
      };
      await initChannel(config, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [reviewBinding()],
        partial: false,
      });
      // A normal network failure (backpressure: false), then the role
      // changes: the retry reaches the private-retirement cleanup.
      boundSessions.deliverPrompt.mockRejectedValue(new Error('network down'));
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      expect(readTasks()).toHaveLength(1);

      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            sessionId: 'review-session',
            prs: [
              {
                number: 42,
                url: 'https://github.com/owner/repo/pull/42',
                state: 'open',
                role: 'fix',
              },
            ],
          }),
        ],
        partial: false,
      });
      const removeSpy = vi
        .spyOn(
          channel as unknown as { removeInboundTask: (id: string) => void },
          'removeInboundTask',
        )
        .mockImplementation(() => {
          throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        });
      mockOctokit.paginate.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await pollOnce().catch(() => undefined);
      removeSpy.mockRestore();

      // The retirement is durable even though the removal failed.
      const tasks = readTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!['state']).toBe('cancelled');

      // Restart: the cancelled task is not recoverable and must never reach
      // the public reply path.
      await initChannel(config, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('completes the original fanout slot when a deferred target accepts after retargeting (R2-2 retarget)', async () => {
      const config = {
        deliverToBoundSessions: true,
        boundSessionActions: {
          'review:comment': 'review it',
          'verify:comment': 'verify it',
        },
      };
      await initChannel(config, { boundSessions });
      const verifyBindingFor = (sessionId: string, updatedAt?: string) =>
        makeBinding({
          sessionId,
          ...(updatedAt ? { updatedAt } : {}),
          prs: [
            {
              number: 42,
              url: 'https://github.com/owner/repo/pull/42',
              state: 'open',
              role: 'verify',
            },
          ],
        });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [reviewBinding(), verifyBindingFor('verify-old')],
        partial: false,
      });
      // Both roles queue-full: the review carrier keeps the full fanout.
      boundSessions.deliverPrompt.mockImplementation(
        async (sessionId: string) => {
          if (sessionId === 'review-session' || sessionId === 'verify-old') {
            throw new BoundSessionQueueFullError(sessionId);
          }
        },
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      // verify rebinds to verify-mid while review stays blocked: the
      // deferred verify task retargets and accepts under the NEW session.
      // The completion must land on the ORIGINAL fanout slot (the role),
      // not only on verify-mid's per-target ring key.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          reviewBinding(),
          verifyBindingFor('verify-mid', '2026-07-03T00:00:00.000Z'),
        ],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await pollOnce();
      // Count BEFORE the restart: initChannel clears the mock history.
      const midCalls = (
        boundSessions.deliverPrompt.mock.calls as Array<[string]>
      ).filter(([id]) => id === 'verify-mid');
      expect(midCalls).toHaveLength(1);

      // A second rebind must not replay the event for the verify role.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          reviewBinding(),
          verifyBindingFor('verify-new', '2026-07-04T00:00:00.000Z'),
        ],
        partial: false,
      });
      await initChannel(config, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          reviewBinding(),
          verifyBindingFor('verify-new', '2026-07-04T00:00:00.000Z'),
        ],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await pollOnce();
      const afterRestart = (
        boundSessions.deliverPrompt.mock.calls as Array<[string]>
      ).map(([id]) => id);
      expect(afterRestart).not.toContain('verify-new');
      expect(afterRestart).not.toContain('verify-mid');
    });

    it('keeps fanout completion durable when background traffic evicts the delivery ring (R2-2 eviction)', async () => {
      const config = {
        deliverToBoundSessions: true,
        boundSessionActions: {
          'review:comment': 'review it',
          'verify:comment': 'verify it',
        },
      };
      await initChannel(config, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          reviewBinding(),
          makeBinding({
            sessionId: 'verify-old',
            prs: [
              {
                number: 42,
                url: 'https://github.com/owner/repo/pull/42',
                state: 'open',
                role: 'verify',
              },
            ],
          }),
        ],
        partial: false,
      });
      boundSessions.deliverPrompt.mockImplementation(
        async (sessionId: string) => {
          if (sessionId === 'review-session') {
            throw new BoundSessionQueueFullError(sessionId);
          }
        },
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      // Count BEFORE the restart: initChannel clears the mock history.
      const oldCalls = (
        boundSessions.deliverPrompt.mock.calls as Array<[string]>
      ).filter(([id]) => id === 'verify-old');
      expect(oldCalls).toHaveLength(1);

      // 512 unrelated single-target acceptances (1024 keys) evict the
      // original completion from the bounded ring while the review
      // sibling is still at deferCount 1, well inside its retry horizon.
      // The on-task slot mark must survive the eviction.
      mkdirSync(dirname(deliveredRingPath()), { recursive: true });
      writeFileSync(
        deliveredRingPath(),
        JSON.stringify({
          keys: Array.from(
            { length: 1024 },
            (_, i) => `github:other/repo:bg-${i}`,
          ),
        }),
        'utf-8',
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          reviewBinding(),
          makeBinding({
            sessionId: 'verify-new',
            updatedAt: '2026-07-03T00:00:00.000Z',
            prs: [
              {
                number: 42,
                url: 'https://github.com/owner/repo/pull/42',
                state: 'open',
                role: 'verify',
              },
            ],
          }),
        ],
        partial: false,
      });
      await initChannel(config, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          reviewBinding(),
          makeBinding({
            sessionId: 'verify-new',
            updatedAt: '2026-07-03T00:00:00.000Z',
            prs: [
              {
                number: 42,
                url: 'https://github.com/owner/repo/pull/42',
                state: 'open',
                role: 'verify',
              },
            ],
          }),
        ],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await pollOnce();
      const afterRestart = (
        boundSessions.deliverPrompt.mock.calls as Array<[string]>
      ).map(([id]) => id);
      expect(afterRestart).not.toContain('verify-new');
      expect(afterRestart).not.toContain('verify-old');
    });

    it('keeps the slot unreconstructable when the completion mark write fails (R2-2 mark write failure)', async () => {
      const config = {
        deliverToBoundSessions: true,
        boundSessionActions: {
          'review:comment': 'review it',
          'verify:comment': 'verify it',
        },
      };
      await initChannel(config, { boundSessions });
      const verifyBindingFor = (sessionId: string, updatedAt?: string) =>
        makeBinding({
          sessionId,
          ...(updatedAt ? { updatedAt } : {}),
          prs: [
            {
              number: 42,
              url: 'https://github.com/owner/repo/pull/42',
              state: 'open',
              role: 'verify',
            },
          ],
        });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [reviewBinding(), verifyBindingFor('verify-old')],
        partial: false,
      });
      boundSessions.deliverPrompt.mockImplementation(
        async (sessionId: string) => {
          if (sessionId === 'review-session' || sessionId === 'verify-old') {
            throw new BoundSessionQueueFullError(sessionId);
          }
        },
      );
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();

      // verify-mid accepts, but the ONE write that would persist the
      // carrier's completed:true slot mark fails with a real rename EIO
      // (content-selected, fired once; the completion helper is not mocked).
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          reviewBinding(),
          verifyBindingFor('verify-mid', '2026-07-03T00:00:00.000Z'),
        ],
        partial: false,
      });
      const originalRename = nodeFs.renameSync;
      let fired = false;
      const spy = vi.spyOn(nodeFs, 'renameSync').mockImplementation(((
        from: string,
        to: string,
      ) => {
        if (
          !fired &&
          typeof to === 'string' &&
          to.endsWith('-github-inbound-tasks.json')
        ) {
          const staged = JSON.parse(
            nodeFs.readFileSync(from, 'utf-8'),
          ) as Array<{ fanout?: Array<{ completed?: boolean }> }>;
          if (
            Array.isArray(staged) &&
            staged.some((record) =>
              (record.fanout ?? []).some((t) => t.completed === true),
            )
          ) {
            fired = true;
            throw Object.assign(new Error('EIO: i/o error'), {
              code: 'EIO',
            });
          }
        }
        return (originalRename as (a: string, b: string) => void)(from, to);
      }) as unknown as typeof nodeFs.renameSync);
      mockOctokit.paginate.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await pollOnce().catch(() => undefined);
      spy.mockRestore();
      expect(fired).toBe(true);

      // The acceptance evidence survives on disk: the accepted task is NOT
      // removed, and the carrier's original slot is still unmarked.
      const afterFailure = readTasks();
      const acceptedTask = afterFailure.find(
        (t) =>
          (t['delivery'] as { sessionId?: string } | undefined)?.sessionId ===
          'verify-mid',
      );
      expect(acceptedTask).toBeDefined();
      expect(acceptedTask!['deliveredAt']).toBeDefined();
      const carrier = afterFailure.find((t) => t['fanout'] !== undefined);
      expect(carrier).toBeDefined();
      expect(
        (
          carrier!['fanout'] as Array<{
            sessionId: string;
            completed?: boolean;
          }>
        ).find((t) => t.sessionId === 'verify-old')!['completed'],
      ).toBeUndefined();

      // Rebind again WITHOUT a restart: recovery must honor the acceptance
      // evidence (no reconstruction into verify-new), then complete the
      // mark from the deliveredAt record and retire the accepted task.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          reviewBinding(),
          verifyBindingFor('verify-new', '2026-07-04T00:00:00.000Z'),
        ],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await pollOnce();
      mockOctokit.paginate.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await pollOnce();
      const all = (
        boundSessions.deliverPrompt.mock.calls as Array<[string]>
      ).map(([id]) => id);
      expect(all).not.toContain('verify-new');
      expect(all.filter((id) => id === 'verify-mid')).toHaveLength(1);
      const healed = readTasks().find((t) => t['fanout'] !== undefined);
      expect(healed).toBeDefined();
      expect(
        (
          healed!['fanout'] as Array<{
            sessionId: string;
            completed?: boolean;
          }>
        ).find((t) => t.sessionId === 'verify-old')!['completed'],
      ).toBe(true);
    });

    it('keeps a ring-retired comment terminal when task removal fails (R2-4 ring branch)', async () => {
      const config = {
        deliverToBoundSessions: true,
        boundSessionActions: { 'review:comment': 'review it' },
      };
      await initChannel(config, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [reviewBinding()],
        partial: false,
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledWith(
        'review-session',
        expect.any(String),
        expect.any(String),
      );

      // Restart with every follower gone AND the cursor lost: the same
      // event re-lists, is claimed untargeted, and the ring guard retires
      // it privately. The removal then fails inside the delivery
      // try/catch — the terminal outcome must survive the cleanup error.
      await initChannel(config, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      const nameHash = createHash('sha256')
        .update('test-github')
        .digest('hex')
        .slice(0, 16);
      nodeFs.rmSync(
        join(
          process.env.QWEN_HOME!,
          'channels',
          getWorkspaceScopeDirName('/tmp/test'),
          `test-github-${nameHash}-poll-cursor.json`,
        ),
        { force: true },
      );
      const removeSpy = vi
        .spyOn(
          channel as unknown as { removeInboundTask: (id: string) => void },
          'removeInboundTask',
        )
        .mockImplementation(() => {
          throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        });
      mockOctokit.paginate
        .mockResolvedValueOnce([prNotification('comment')])
        .mockResolvedValueOnce([makeComment()]);
      await pollOnce().catch(() => undefined);
      removeSpy.mockRestore();

      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(0);
      const tasks = readTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!['state']).toBe('cancelled');

      // Restart: the terminal record stays non-recoverable and private.
      await initChannel(config, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      mockOctokit.paginate.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);
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

    describe('role-aware watch fan-out', () => {
      const headChangeKey = 'watch:head_change:42:1:1751446800000';

      const roleWatchConfig = {
        deliverToBoundSessions: true,
        prWatchEvents: ['head_change'],
        boundSessionActions: {
          'review:watch:head_change': 'Re-review %repo%#%pr% (role %role%).',
          'verify:watch:head_change': 'Re-verify %repo%#%pr%.',
        },
      };

      function roleBindings() {
        return (['review', 'verify', 'fix'] as const).map((role) =>
          makeBinding({
            sessionId: `${role}-session`,
            prs: [
              {
                number: 42,
                url: 'https://github.com/owner/repo/pull/42',
                state: 'open',
                role,
              },
            ],
          }),
        );
      }

      function headChangePending(sessionId = 'review-session') {
        return {
          key: headChangeKey,
          issueNumber: 42,
          envelope: {
            channelName: 'test-github',
            senderId: 'github',
            senderName: 'GitHub',
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: headChangeKey,
            text: 'PR head advanced to sha-1.',
            isGroup: true,
            isMentioned: true,
            isReplyToBot: false,
            metadata:
              'Type: Pull Request | Title: Test PR | URL: https://github.com/owner/repo/pull/42\nEvent: head_change.',
          },
          delivery: { kind: 'bound-session', sessionId },
        };
      }

      function seedHeadChangeBaseline(pending: unknown[]) {
        seedWatchState({
          'owner/repo#42': {
            headSha: 'sha-1',
            ci: 'success',
            mergeableState: 'clean',
            prState: 'open',
            prUpdatedAt: '2026-07-02T09:00:00.000Z',
            seq: 1,
            fired: [],
            pending,
          },
        });
      }

      function writeTasks(records: unknown[]): void {
        const path = inboundTaskPath();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(records)}\n`, 'utf-8');
      }

      function readTasks(): Array<Record<string, unknown>> {
        if (!existsSync(inboundTaskPath())) return [];
        return JSON.parse(readFileSync(inboundTaskPath(), 'utf-8')) as Array<
          Record<string, unknown>
        >;
      }

      it('delivers one watch transition to each matched role and fires only after all claims', async () => {
        await initChannel(roleWatchConfig, { boundSessions });
        boundSessions.listPrBindings.mockResolvedValue({
          bindings: roleBindings(),
          partial: false,
        });
        seedHeadChangeBaseline([headChangePending()]);
        mockPull({});
        mockNotificationsOnce([]);

        await pollOnce();

        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
        const calls = boundSessions.deliverPrompt.mock.calls as Array<
          [string, string]
        >;
        const bySession = new Map(calls.map(([id, prompt]) => [id, prompt]));
        expect(bySession.get('review-session')).toContain(
          'Re-review owner/repo#42 (role review).',
        );
        expect(bySession.get('verify-session')).toContain(
          'Re-verify owner/repo#42.',
        );
        // fix has no head_change key: not disturbed.
        expect(bySession.has('fix-session')).toBe(false);
        const state = readWatchState();
        const entry = state.entries['owner/repo#42']!;
        expect(entry['pending']).toEqual([]);
        expect(entry['fired']).toEqual([headChangeKey]);
        expect(readTasks()).toHaveLength(0);
      });

      it('re-claims only the missing target after a crash mid-fan-out', async () => {
        await initChannel(roleWatchConfig, { boundSessions });
        boundSessions.listPrBindings.mockResolvedValue({
          bindings: roleBindings(),
          partial: false,
        });
        const pending = headChangePending();
        seedHeadChangeBaseline([pending]);
        // The review target was claimed before the crash; its task survived
        // but the pending→fired save did not. The drain must REUSE it and
        // claim only verify — never a second review task.
        writeTasks([
          {
            version: 1,
            id: 'pre-crash-review-task',
            createdAt: '2026-07-02T09:00:00.000Z',
            updatedAt: '2026-07-02T09:00:00.000Z',
            state: 'accepted',
            issueNumber: 42,
            source: {
              chatId: 'owner/repo',
              threadId: 'pr:42',
              messageId: headChangeKey,
            },
            envelope: pending.envelope,
            dedupe: {},
            attempts: 0,
            delivery: {
              kind: 'bound-session',
              sessionId: 'review-session',
              role: 'review',
            },
          },
        ]);
        mockPull({});
        mockNotificationsOnce([]);

        await pollOnce();

        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
        const state = readWatchState();
        expect(state.entries['owner/repo#42']!['fired']).toEqual([
          headChangeKey,
        ]);
        expect(readTasks()).toHaveLength(0);
      });

      it('keeps per-(PR, target) ordering: a stuck role does not block the others', async () => {
        await initChannel(roleWatchConfig, { boundSessions });
        boundSessions.listPrBindings.mockResolvedValue({
          bindings: roleBindings(),
          partial: false,
        });
        seedHeadChangeBaseline([headChangePending()]);
        // An unsettled EARLIER watch task for the review target blocks only
        // review; verify drains now and the event stays pending for review.
        writeTasks([
          {
            version: 1,
            id: 'review-predecessor',
            createdAt: '2026-07-02T08:00:00.000Z',
            updatedAt: '2026-07-02T08:00:00.000Z',
            state: 'failed',
            issueNumber: 42,
            source: {
              chatId: 'owner/repo',
              threadId: 'pr:42',
              messageId: 'watch:head_change:42:0:1751443200000',
            },
            envelope: {
              ...headChangePending().envelope,
              messageId: 'watch:head_change:42:0:1751443200000',
            },
            dedupe: {},
            attempts: 1,
            error: 'transient',
            delivery: {
              kind: 'bound-session',
              sessionId: 'review-session',
              role: 'review',
            },
          },
        ]);
        mockPull({});
        mockNotificationsOnce([]);

        await pollOnce();

        const calls = boundSessions.deliverPrompt.mock.calls as Array<[string]>;
        // verify delivered; the predecessor retried via recovery; the NEW
        // event's review target waits (no second review delivery).
        expect(calls.map(([id]) => id)).toContain('verify-session');
        expect(calls.filter(([id]) => id === 'review-session')).toHaveLength(1);
        const state = readWatchState();
        const entry = state.entries['owner/repo#42']!;
        expect(entry['pending']).toHaveLength(1);
        expect(entry['fired']).toEqual([]);
      });
    });

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
      ).toContainEqual(
        expect.stringMatching(/^watch:ci_failure:42:sha-1:\d+$/),
      );
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
        expect.stringMatching(/^watch:merge_conflict:42:1:\d+$/),
        expect.stringMatching(/^watch:merge_conflict:42:2:\d+$/),
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
      expect(fired).toEqual([
        expect.stringMatching(/^watch:state_change:42:1:\d+$/),
        expect.stringMatching(/^watch:state_change:42:2:\d+$/),
      ]);
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
        expect.stringMatching(/^watch:head_change:42:1:\d+$/),
        expect.stringMatching(/^watch:head_change:42:2:\d+$/),
        expect.stringMatching(/^watch:head_change:42:3:\d+$/),
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

    it('replaces a terminal failed task when its pending event drains (F6)', async () => {
      await initChannel(watchConfig, { boundSessions });
      // Claim-level replacement keys off the PERSISTED pending key (stable
      // across restarts). A fresh detection always carries a new detection
      // timestamp and legitimately owns a new task, so the tombstone path
      // is driven through the surviving pending queue.
      const key = 'watch:state_change:42:1:1751446800000';
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          mergeableState: 'clean',
          prState: 'closed',
          fired: [],
          pending: [
            makePendingWatch({
              key,
              text: 'The PR was closed without merging.',
            }),
          ],
        },
      });
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'failed',
          attempts: 3,
          issueNumber: 42,
          delivery: { kind: 'bound-session', sessionId: 'bound-session' },
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: key,
          },
          envelope: {
            ...makePendingWatch({
              key,
              text: 'The PR was closed without merging.',
            }).envelope,
          },
          dedupe: {},
        }),
      ]);
      mockPull({ state: 'closed', merged: false });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('reuses a reply_pending task instead of double-delivering (F6)', async () => {
      await initChannel(watchConfig, { boundSessions });
      const key = 'watch:state_change:42:1:1751446800000';
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          mergeableState: 'clean',
          prState: 'closed',
          fired: [],
          pending: [
            makePendingWatch({
              key,
              text: 'The PR was closed without merging.',
            }),
          ],
        },
      });
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'reply_pending',
          issueNumber: 42,
          delivery: { kind: 'bound-session', sessionId: 'bound-session' },
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: key,
          },
          envelope: undefined,
          dedupe: {},
        }),
      ]);
      mockPull({ state: 'closed', merged: false });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
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
      // A NON-EMPTY array with a valid-shape entry: an empty array would
      // make "remove the array-container guard" an equivalent mutation
      // (Object.entries([]) is still {}), leaving the guard unpinned.
      writeFileSync(
        path,
        `${JSON.stringify({
          version: 1,
          entries: [
            {
              headSha: 'sha-1',
              mergeableState: 'clean',
              prState: 'open',
              fired: [],
              pending: [],
            },
          ],
        })}\n`,
        'utf-8',
      );
      mockPull({});
      mockNotificationsOnce([]);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await pollOnce();
        // The unusable container must be SURFACED, not silently wiped.
        expect(
          stderr.mock.calls.some((call) =>
            String(call[0]).includes('container unusable'),
          ),
        ).toBe(true);
      } finally {
        stderr.mockRestore();
      }

      mockPull({ mergeable: false, mergeable_state: 'dirty' });
      mockNotificationsOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      const state = JSON.parse(readFileSync(watchStatePath(), 'utf-8')) as {
        entries: Record<string, unknown>;
      };
      expect(Array.isArray(state.entries)).toBe(false);
      expect(typeof state.entries).toBe('object');
      // Fresh start under the PR key — without the array guard the entry
      // would survive under the numeric index "0" instead.
      expect(state.entries['owner/repo#42']).toBeDefined();
      expect(state.entries['0']).toBeUndefined();
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
        expect.any(String),
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
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-02T09:00:00.000Z'));
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'queued', conclusion: null }]);
      await pollOnce();

      // Same head, same updated_at: the pending aggregate must re-check
      // once the pending re-check interval elapses (R1-3 bounds the
      // fan-out; it must not stop observing pending CI altogether).
      vi.setSystemTime(new Date('2026-07-02T09:06:00.000Z'));
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

      // Flap sha-2 success -> failure: re-delivery is suppressed (the
      // ciFiredSha pin and the fired ring's per-head prefix), and the ring
      // must still retain the per-head key (a reversed slice would drop it).
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
      expect(ring).toContainEqual(
        expect.stringMatching(/^watch:ci_failure:42:sha-2:\d+$/),
      );
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

    it('retires a running watch task privately when its delivery was cleared (G5)', async () => {
      await initChannel(watchConfig, { boundSessions });
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'running',
          attempts: 0,
          issueNumber: 42,
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: 'watch:ci_failure:sha-1',
          },
          envelope: { ...makePendingWatch().envelope },
          dedupe: {},
        }),
      ]);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        mockPull({});
        mockNotificationsOnce([]);
        mockChecks([{ status: 'completed', conclusion: 'success' }]);
        await pollOnce();

        // Private-only: no public reply and no channel-path delivery.
        expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
        expect(channel.inboundEnvelopes).toHaveLength(0);
        expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
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

    it('retires a drained watch event even when the public reply store is corrupt (R8-B1)', async () => {
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
      // The PUBLIC reply lane's store is corrupt. A watch event is never
      // published, so its private retire must not depend on that file —
      // otherwise the retired task wedges against it and (once reconcile
      // succeeds with no pending left) freezes the shared cursor.
      const pendingPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-pending-deliveries.json',
      );
      mkdirSync(dirname(pendingPath), { recursive: true });
      writeFileSync(pendingPath, '{corrupt', 'utf-8');
      // Listed at poll start, gone by delivery time; the re-resolution
      // finds no candidate on a complete snapshot.
      boundSessions.deliverPrompt.mockRejectedValueOnce(
        new BoundSessionGoneError('bound-session'),
      );
      boundSessions.listPrBindings
        .mockResolvedValueOnce({ bindings: [makeBinding()], partial: false })
        .mockResolvedValueOnce({ bindings: [], partial: false });
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        mockPull({});
        mockNotificationsOnce([]);
        mockChecks([{ status: 'completed', conclusion: 'success' }]);
        await pollOnce();

        // The retire completed despite the corrupt store: no task is left
        // wedged against it, and nothing was published.
        expect(existsSync(inboundTaskPath())).toBe(false);
        expect(channel.inboundEnvelopes).toHaveLength(0);
        expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
        expect(
          stderr.mock.calls.some((call) =>
            String(call[0]).includes('retiring without public fallback'),
          ),
        ).toBe(true);
      } finally {
        stderr.mockRestore();
      }

      // The shared cursor keeps flowing for unrelated comments: no
      // unsettled watch task holds it once the retire completed.
      mockPull({});
      mockNotificationsOnce([prNotification()]);
      mockOctokit.rest.issues.listComments.mockResolvedValueOnce([
        makeComment(),
      ]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      expect(boundSessions.deliverPrompt.mock.calls[1]![1]).toContain(
        'please fix this',
      );
      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).toHaveBeenCalledTimes(1);
      const ch = channel as unknown as {
        cursor: { lastProcessedAt: string };
      };
      expect(ch.cursor.lastProcessedAt).toBe('2026-07-02T10:00:00.000Z');
    });

    it('recovers a crash-window watch retire without reading the public reply store (R9-C1)', async () => {
      await initChannel(watchConfig, { boundSessions });
      // Crash between the retire's delivery-clear transition and the task
      // removal: a running watch task with no delivery and no pending left
      // (the event already fired). Recovery must retire it without reading
      // the PUBLIC reply lane's store, which is corrupt here.
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'running',
          attempts: 0,
          issueNumber: 42,
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: 'watch:ci_failure:sha-1',
          },
          envelope: { ...makePendingWatch().envelope },
          dedupe: {},
        }),
      ]);
      const pendingPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-pending-deliveries.json',
      );
      mkdirSync(dirname(pendingPath), { recursive: true });
      writeFileSync(pendingPath, '{corrupt', 'utf-8');
      mockPull({});
      mockNotificationsOnce([prNotification()]);
      mockOctokit.rest.issues.listComments.mockResolvedValueOnce([
        makeComment(),
      ]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      // The watch task retired through recovery despite the corrupt store,
      // and the unrelated comment delivered with the cursor flowing.
      expect(existsSync(inboundTaskPath())).toBe(false);
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'please fix this',
      );
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).toHaveBeenCalledTimes(1);
      const ch = channel as unknown as {
        cursor: { lastProcessedAt: string };
      };
      expect(ch.cursor.lastProcessedAt).toBe('2026-07-02T10:00:00.000Z');
    });

    it('recovers a crash-window watch retire past an unreadable audit without consuming the comment (R9-A1)', async () => {
      await initChannel(watchConfig, { boundSessions });
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'running',
          attempts: 0,
          issueNumber: 42,
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: 'watch:ci_failure:sha-1',
          },
          envelope: { ...makePendingWatch().envelope },
          dedupe: {},
        }),
      ]);
      // An unreadable audit (a directory at its path) must not wedge the
      // private watch retire in recovery — but it MUST still refuse the
      // public comment dispatch and freeze the cursor (R5 contract).
      const auditPath = inboundTaskPath().replace(
        'github-inbound-tasks.json',
        'github-audit.jsonl',
      );
      mkdirSync(auditPath, { recursive: true });
      mockPull({});
      mockNotificationsOnce([prNotification()]);
      mockOctokit.rest.issues.listComments.mockResolvedValueOnce([
        makeComment(),
      ]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      // The watch task retired despite the unreadable audit...
      expect(existsSync(inboundTaskPath())).toBe(false);
      // ...while the comment was refused with no claim and no delivery,
      // and the cursor stayed frozen.
      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).not.toHaveBeenCalled();

      // Audit readable again: the SAME comment delivers on the next poll.
      rmSync(auditPath, { recursive: true, force: true });
      mockPull({});
      mockNotificationsOnce([prNotification()]);
      mockOctokit.rest.issues.listComments.mockResolvedValueOnce([
        makeComment(),
      ]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'please fix this',
      );
      expect(
        mockOctokit.rest.activity.markNotificationsAsRead,
      ).toHaveBeenCalledTimes(1);
    });

    it('replaces a cancelled watch task when its pending event drains (H5)', async () => {
      await initChannel(watchConfig, { boundSessions });
      const key = 'watch:state_change:42:1:1751446800000';
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          mergeableState: 'clean',
          prState: 'closed',
          fired: [],
          pending: [
            makePendingWatch({
              key,
              text: 'The PR was closed without merging.',
            }),
          ],
        },
      });
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'cancelled',
          issueNumber: 42,
          delivery: { kind: 'bound-session', sessionId: 'bound-session' },
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: key,
          },
          envelope: {
            ...makePendingWatch({
              key,
              text: 'The PR was closed without merging.',
            }).envelope,
          },
          dedupe: {},
        }),
      ]);
      mockPull({ state: 'closed', merged: false });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'closed without merging',
      );
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('rolls back the claim when the post-claim watch save fails (H7)', async () => {
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
      // Watch file unwritable, task file writable: only the watch save's
      // rename fails.
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
        await pollOnce();

        expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
        expect(
          (readWatchState().entries['owner/repo#42']!['pending'] as unknown[])
            .length,
        ).toBe(1);
        expect(existsSync(inboundTaskPath())).toBe(false);
        expect(
          stderr.mock.calls.some((call) =>
            String(call[0]).includes('rolled back claim'),
          ),
        ).toBe(true);
      } finally {
        spy.mockRestore();
        stderr.mockRestore();
      }
    });

    it('retires a running watch task when a complete snapshot unbinds the PR (H9)', async () => {
      await initChannel(watchConfig, { boundSessions });
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'running',
          attempts: 0,
          issueNumber: 42,
          delivery: { kind: 'bound-session', sessionId: 'bound-session' },
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: 'watch:ci_failure:sha-1',
          },
          envelope: { ...makePendingWatch().envelope },
          dedupe: {},
        }),
      ]);
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        mockNotificationsOnce([]);
        await pollOnce();

        expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
        expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
        expect(channel.inboundEnvelopes).toHaveLength(0);
        expect(existsSync(inboundTaskPath())).toBe(false);
        expect(
          stderr.mock.calls.some((call) =>
            String(call[0]).includes('no bound candidate left'),
          ),
        ).toBe(true);
      } finally {
        stderr.mockRestore();
      }
    });

    it('suppresses a ci_failure re-fire after the fired ring evicted the key (H10)', async () => {
      await initChannel(
        { deliverToBoundSessions: true, prWatchEvents: ['ci_failure'] },
        { boundSessions },
      );
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          ci: 'success',
          ciFiredSha: 'sha-1',
          mergeableState: 'clean',
          prState: 'open',
          prUpdatedAt: '2026-07-02T09:00:00.000Z',
          seq: 64,
          fired: Array.from(
            { length: 64 },
            (_, i) => `watch:merge_conflict:${i + 1}`,
          ),
        },
      });
      // Same head, aggregate flaps back to failure: the evicted per-head
      // key must not re-fire while the ciFiredSha pin matches.
      mockPull({ updated_at: '2026-07-02T10:00:00.000Z' });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'failure' }]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(readWatchState().entries['owner/repo#42']!['ciFiredSha']).toBe(
        'sha-1',
      );
    });

    it('re-fires ci_failure on a new head after the fired ring eviction (H10)', async () => {
      await initChannel(
        { deliverToBoundSessions: true, prWatchEvents: ['ci_failure'] },
        { boundSessions },
      );
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          ci: 'success',
          ciFiredSha: 'sha-1',
          mergeableState: 'clean',
          prState: 'open',
          prUpdatedAt: '2026-07-02T09:00:00.000Z',
          seq: 64,
          fired: Array.from(
            { length: 64 },
            (_, i) => `watch:merge_conflict:${i + 1}`,
          ),
        },
      });
      // A new head resets the pin: the failure fires again.
      mockPull({
        head: { sha: 'sha-2' },
        updated_at: '2026-07-02T10:00:00.000Z',
      });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'failure' }]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'CI failed on head sha-2',
      );
      expect(readWatchState().entries['owner/repo#42']!['ciFiredSha']).toBe(
        'sha-2',
      );
    });

    it('drains pending watch events even when the binding refresh fails (H14)', async () => {
      await initChannel(watchConfig, { boundSessions });
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          ci: 'failure',
          prState: 'open',
          fired: [],
          pending: [makePendingWatch()],
        },
      });
      boundSessions.listPrBindings.mockRejectedValue(new Error('daemon down'));
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        mockNotificationsOnce([]);
        await pollOnce();

        // The drain needs no GitHub calls: a failed refresh must not starve
        // it (the live watch pass is still skipped).
        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
        expect(boundSessions.deliverPrompt).toHaveBeenCalledWith(
          'bound-session',
          expect.stringContaining('CI failed on head sha-1'),
          expect.any(String),
        );
        expect(mockOctokit.rest.pulls.get).not.toHaveBeenCalled();
        expect(existsSync(inboundTaskPath())).toBe(false);
      } finally {
        stderr.mockRestore();
      }
    });

    it('isolates a failing PR watch from the healthy PR in the same pass (H16)', async () => {
      await initChannel(
        { deliverToBoundSessions: true, prWatchEvents: ['merge_conflict'] },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding(),
          makeBinding({
            sessionId: 'bound-session-2',
            updatedAt: '2026-07-01T00:00:00.000Z',
            prs: [
              {
                number: 43,
                url: 'https://github.com/owner/repo/pull/43',
                state: 'open',
              },
            ],
          }),
        ],
        partial: false,
      });
      seedWatchState({
        'owner/repo#43': {
          headSha: 'sha-43',
          mergeableState: 'clean',
          prState: 'open',
          prUpdatedAt: '2026-07-02T09:00:00.000Z',
          fired: [],
        },
      });
      // The NEWER binding (#42) fails first in pass order; without per-PR
      // isolation the healthy #43 would never be observed.
      mockOctokit.rest.pulls.get.mockImplementation(
        (params: { pull_number: number }) =>
          params.pull_number === 42
            ? Promise.reject(new Error('pull fetch exploded'))
            : Promise.resolve({
                data: makePrMeta({
                  head: { sha: 'sha-43' },
                  mergeable: false,
                  mergeable_state: 'dirty',
                }),
              }),
      );
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        mockNotificationsOnce([]);
        await pollOnce();

        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
        expect(boundSessions.deliverPrompt).toHaveBeenCalledWith(
          'bound-session-2',
          expect.stringContaining('Merge conflicts detected'),
          expect.any(String),
        );
        expect(
          readWatchState().entries['owner/repo#43']!['mergeableState'],
        ).toBe('dirty');
        expect(
          stderr.mock.calls.some((call) =>
            String(call[0]).includes('PR watch failed for owner/repo#42'),
          ),
        ).toBe(true);
      } finally {
        stderr.mockRestore();
      }
    });

    it('logs the excluded PRs when the watch cap is exceeded (H17)', async () => {
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
      mockPull({});
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        mockNotificationsOnce([]);
        await pollOnce();

        const errText = stderr.mock.calls
          .map((call) => String(call[0]))
          .join('');
        expect(errText).toContain('PR watch cap exceeded');
        expect(errText).toContain('30/31');
        expect(errText).toContain('owner/repo#999');
      } finally {
        stderr.mockRestore();
      }
    });

    it('starts fresh when the watch state file is corrupt JSON (G13)', async () => {
      await initChannel(watchConfig, { boundSessions });
      const path = watchStatePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{corrupt json', 'utf-8');
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        mockPull({});
        mockNotificationsOnce([]);
        mockChecks([{ status: 'completed', conclusion: 'success' }]);
        await pollOnce();

        expect(
          stderr.mock.calls.some((call) =>
            String(call[0]).includes('starting fresh'),
          ),
        ).toBe(true);
        expect(readWatchState().entries['owner/repo#42']!['headSha']).toBe(
          'sha-1',
        );
        expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      } finally {
        stderr.mockRestore();
      }
    });

    it('persists the episode counter across a restart (G9)', async () => {
      const config = {
        deliverToBoundSessions: true,
        prWatchEvents: ['merge_conflict'],
      };
      await initChannel(config, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      await pollOnce();

      mockPull({ mergeable: false, mergeable_state: 'dirty' });
      mockNotificationsOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      let entry = readWatchState().entries['owner/repo#42']!;
      expect(entry['seq']).toBe(1);
      expect(entry['fired']).toEqual([
        expect.stringMatching(/^watch:merge_conflict:42:1:\d+$/),
      ]);

      // Fresh channel over the same state directory: the counter carries,
      // so the recurrence gets the NEXT episode key, not a reset one.
      await initChannel(config, { boundSessions });
      mockPull({ mergeable: true, mergeable_state: 'clean' });
      mockNotificationsOnce([]);
      await pollOnce();
      mockPull({ mergeable: false, mergeable_state: 'dirty' });
      mockNotificationsOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      entry = readWatchState().entries['owner/repo#42']!;
      expect(entry['seq']).toBe(2);
      expect(entry['fired']).toEqual([
        expect.stringMatching(/^watch:merge_conflict:42:1:\d+$/),
        expect.stringMatching(/^watch:merge_conflict:42:2:\d+$/),
      ]);
    });

    it('fails fast on a secondary rate limit despite remaining quota (H1)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-02T09:00:00.000Z'));
      await initChannel(watchConfig, { boundSessions });
      const sleep = vi.fn().mockResolvedValue(undefined);
      (
        channel as unknown as {
          abortableSleep: (ms: number) => Promise<void>;
        }
      ).abortableSleep = sleep;
      const secondaryLimit = Object.assign(new Error('Secondary rate limit'), {
        status: 403,
        response: {
          headers: {
            'retry-after': '120',
            'x-ratelimit-remaining': '4999',
          },
        },
      });
      mockOctokit.rest.pulls.get.mockRejectedValue(secondaryLimit);
      mockNotificationsOnce([]);
      await pollOnce();

      // No retry sleep on the watch call, and the notification lane still
      // runs in the same poll.
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(
        mockOctokit.rest.activity.listNotificationsForAuthenticatedUser,
      ).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
    });

    it('fails fast on a 403 without retry-after or exhausted quota (N6)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-02T09:00:00.000Z'));
      await initChannel(watchConfig, { boundSessions });
      const sleep = vi.fn().mockResolvedValue(undefined);
      (
        channel as unknown as {
          abortableSleep: (ms: number) => Promise<void>;
        }
      ).abortableSleep = sleep;
      // GitHub does not always send retry-after on an abuse limit, and a
      // plain 403 does not mean the primary quota is exhausted.
      mockOctokit.rest.pulls.get.mockRejectedValue(
        Object.assign(new Error('You have exceeded a secondary rate limit'), {
          status: 403,
          response: { headers: { 'x-ratelimit-remaining': '4999' } },
        }),
      );
      mockNotificationsOnce([]);
      await pollOnce();

      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(
        mockOctokit.rest.activity.listNotificationsForAuthenticatedUser,
      ).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
    });

    it('fails fast on a permanent 404 watch status (N6)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-02T09:00:00.000Z'));
      await initChannel(watchConfig, { boundSessions });
      const sleep = vi.fn().mockResolvedValue(undefined);
      (
        channel as unknown as {
          abortableSleep: (ms: number) => Promise<void>;
        }
      ).abortableSleep = sleep;
      mockOctokit.rest.pulls.get.mockRejectedValue(
        Object.assign(new Error('Not Found'), { status: 404 }),
      );
      mockNotificationsOnce([]);
      await pollOnce();

      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(
        mockOctokit.rest.activity.listNotificationsForAuthenticatedUser,
      ).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
    });

    it('drops malformed watch entries but drains the healthy ones (N7)', async () => {
      await initChannel(watchConfig, { boundSessions });
      seedWatchState({
        'owner/repo#1': null,
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
      // The live watch pass fails, so the pending drain is the only source
      // of a delivery in this poll.
      mockOctokit.rest.pulls.get.mockRejectedValue(
        Object.assign(new Error('Not Found'), { status: 404 }),
      );
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        mockNotificationsOnce([]);
        await pollOnce();

        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
        expect(boundSessions.deliverPrompt).toHaveBeenCalledWith(
          'bound-session',
          expect.stringContaining('CI failed on head sha-1'),
          expect.any(String),
        );
        const errText = stderr.mock.calls
          .map((call) => String(call[0]))
          .join('');
        expect(errText).toContain('dropped 1 malformed');
      } finally {
        stderr.mockRestore();
      }
    });

    it('does not re-fire ci_failure when a force-push revisits a red head (N3)', async () => {
      await initChannel(
        { deliverToBoundSessions: true, prWatchEvents: ['ci_failure'] },
        { boundSessions },
      );
      mockPull({ head: { sha: 'sha-A' } });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      mockPull({
        head: { sha: 'sha-A' },
        updated_at: '2026-07-02T10:00:00.000Z',
      });
      mockNotificationsOnce([]);
      mockChecks([
        { status: 'completed', conclusion: 'failure', name: 'build' },
      ]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);

      mockPull({
        head: { sha: 'sha-B' },
        updated_at: '2026-07-02T10:01:00.000Z',
      });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      // Back to sha-A and red again: ci_failure is once per head SHA, so
      // the fired ring's per-head record must still suppress it.
      mockPull({
        head: { sha: 'sha-A' },
        updated_at: '2026-07-02T10:02:00.000Z',
      });
      mockNotificationsOnce([]);
      mockChecks([
        { status: 'completed', conclusion: 'failure', name: 'build' },
      ]);
      await pollOnce();

      // Every head change re-fetched CI: the suppression is the fired
      // ring's per-head prefix, not a missed observation.
      expect(mockOctokit.rest.checks.listForRef).toHaveBeenCalledTimes(4);
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(
        readWatchState().entries['owner/repo#42']!['fired'],
      ).toContainEqual(
        expect.stringMatching(/^watch:ci_failure:42:sha-A:\d+$/),
      );
    });

    it('re-fires head_change when a force-push revisits a head SHA (N3)', async () => {
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

      // head_change keys the transition instance, not the state value, so a
      // revisit is a new episode.
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      const prompts = boundSessions.deliverPrompt.mock.calls.map(
        (call) => call[1] as string,
      );
      expect(prompts[1]).toContain('head moved from sha-B to sha-A');
      expect(readWatchState().entries['owner/repo#42']!['fired']).toEqual([
        expect.stringMatching(/^watch:head_change:42:1:\d+$/),
        expect.stringMatching(/^watch:head_change:42:2:\d+$/),
      ]);
    });

    it('drops pending events with invalid envelope/delivery without starving healthy entries (R1-2)', async () => {
      await initChannel(watchConfig, { boundSessions });
      const base = {
        headSha: 'sha-1',
        ci: 'success',
        mergeableState: 'clean',
        prState: 'open',
        prUpdatedAt: '2026-07-02T09:00:00.000Z',
        fired: [],
      };
      seedWatchState({
        // Shape 1: an envelope without chatId would throw in prBindingKey
        // and abort the whole reconcile loop.
        'owner/repo#40': {
          ...base,
          pending: [{ ...makePendingWatch(), envelope: {} }],
        },
        // Shape 2: a partial envelope would be claimed verbatim and wedge
        // the task file; an invalid delivery must fail the same guard.
        'owner/repo#41': {
          ...base,
          pending: [
            {
              ...makePendingWatch(),
              delivery: { kind: 'webhook', sessionId: 'x' },
            },
          ],
        },
        // The healthy entry queued behind them must still drain.
        'owner/repo#99': { ...base, pending: [makePendingWatch()] },
      });
      mockOctokit.rest.pulls.get.mockRejectedValue(
        Object.assign(new Error('Not Found'), { status: 404 }),
      );
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        mockNotificationsOnce([]);
        await pollOnce();

        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
        expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
          'CI failed on head sha-1',
        );
        const errText = stderr.mock.calls
          .map((call) => String(call[0]))
          .join('');
        expect(errText).toContain('dropped 2 malformed');
        // The task store was never poisoned: the healthy delivery removed
        // its task and the file is gone (a wedged file would still exist).
        expect(existsSync(inboundTaskPath())).toBe(false);
        const state = readWatchState();
        expect(state.entries['owner/repo#40']).toBeUndefined();
        expect(state.entries['owner/repo#41']).toBeUndefined();
      } finally {
        stderr.mockRestore();
      }
    });

    it.each([
      [
        'a shared 403',
        Object.assign(new Error('API rate limit exceeded'), {
          status: 403,
          response: { headers: { 'x-ratelimit-remaining': '0' } },
        }),
      ],
      [
        'a bare 429',
        Object.assign(new Error('Too Many Requests'), {
          status: 429,
          response: { headers: {} },
        }),
      ],
    ])(
      'aborts the whole watch pass on %s instead of one doomed call per PR (R1-11)',
      async (_label, rejection) => {
        await initChannel(watchConfig, { boundSessions });
        boundSessions.listPrBindings.mockResolvedValue({
          bindings: [
            makeBinding(),
            makeBinding({
              sessionId: 'other-session',
              updatedAt: '2026-07-03T00:00:00.000Z',
              prs: [
                {
                  number: 43,
                  url: 'https://github.com/owner/repo/pull/43',
                  state: 'open',
                },
              ],
            }),
          ],
          partial: false,
        });
        mockOctokit.rest.pulls.get.mockRejectedValue(rejection);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
          mockNotificationsOnce([]);
          await pollOnce();

          // Two watched PRs, ONE rejected call: the pass aborts instead of
          // walking the rest of the set against an unreset budget.
          expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(1);
          const errText = stderr.mock.calls
            .map((call) => String(call[0]))
            .join('');
          expect(errText).toContain('PR watch pass aborted');
          // The notification lane still runs in the same poll.
          expect(
            mockOctokit.rest.activity.listNotificationsForAuthenticatedUser,
          ).toHaveBeenCalledTimes(1);
        } finally {
          stderr.mockRestore();
        }
      },
    );

    it('aborts the watch pass on a secondary limit named only by its message', async () => {
      await initChannel(watchConfig, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding(),
          makeBinding({
            sessionId: 'other-session',
            updatedAt: '2026-07-03T00:00:00.000Z',
            prs: [
              {
                number: 43,
                url: 'https://github.com/owner/repo/pull/43',
                state: 'open',
              },
            ],
          }),
        ],
        partial: false,
      });
      // Quota left and no retry-after: only GitHub's wording marks the limit.
      mockOctokit.rest.pulls.get.mockRejectedValue(
        Object.assign(
          new Error(
            'You have exceeded a secondary rate limit. Please wait a few minutes before you try again. - https://docs.github.com/rest',
          ),
          {
            status: 403,
            response: { headers: { 'x-ratelimit-remaining': '4999' } },
          },
        ),
      );
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        mockNotificationsOnce([]);
        await pollOnce();

        expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(1);
        expect(
          stderr.mock.calls.map((call) => String(call[0])).join(''),
        ).toContain('PR watch pass aborted');
      } finally {
        stderr.mockRestore();
      }
    });

    it('aborts the watch pass on a 401 credential failure without retries (R1-11)', async () => {
      await initChannel(watchConfig, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding(),
          makeBinding({
            sessionId: 'other-session',
            updatedAt: '2026-07-03T00:00:00.000Z',
            prs: [
              {
                number: 43,
                url: 'https://github.com/owner/repo/pull/43',
                state: 'open',
              },
            ],
          }),
        ],
        partial: false,
      });
      mockOctokit.rest.pulls.get.mockRejectedValue(
        Object.assign(new Error('Bad credentials'), { status: 401 }),
      );
      mockNotificationsOnce([]);
      await pollOnce();

      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(1);
    });

    it('keeps watching the other PRs when one PR is permanently gone (R1-11)', async () => {
      await initChannel(watchConfig, { boundSessions });
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding(),
          makeBinding({
            sessionId: 'other-session',
            updatedAt: '2026-07-03T00:00:00.000Z',
            prs: [
              {
                number: 43,
                url: 'https://github.com/owner/repo/pull/43',
                state: 'open',
              },
            ],
          }),
        ],
        partial: false,
      });
      // A per-PR 404 is isolated: the pass must continue to the next PR.
      mockOctokit.rest.pulls.get
        .mockRejectedValueOnce(
          Object.assign(new Error('Not Found'), { status: 404 }),
        )
        .mockResolvedValue({ data: makePrMeta() });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['with quota left', '4999'],
      ['with an empty budget header', ''],
    ])(
      'keeps watching the other PRs on a per-repo permission 403 %s (R1-11)',
      async (_label, remaining) => {
        await initChannel(watchConfig, { boundSessions });
        boundSessions.listPrBindings.mockResolvedValue({
          bindings: [
            makeBinding(),
            makeBinding({
              sessionId: 'other-session',
              updatedAt: '2026-07-03T00:00:00.000Z',
              prs: [
                {
                  number: 43,
                  url: 'https://github.com/owner/repo/pull/43',
                  state: 'open',
                },
              ],
            }),
          ],
          partial: false,
        });
        // A fine-grained token lacking access to ONE repo answers a permission
        // 403 with x-ratelimit-remaining > 0 and no retry-after. Bindings come
        // from sessions, not the token's grants, so this is per-PR: the pass
        // must continue to the next PR, not abort and starve every other
        // watched PR of detection.
        mockOctokit.rest.pulls.get
          .mockRejectedValueOnce(
            Object.assign(new Error('Resource not accessible by integration'), {
              status: 403,
              response: { headers: { 'x-ratelimit-remaining': remaining } },
            }),
          )
          .mockResolvedValue({ data: makePrMeta() });
        mockNotificationsOnce([]);
        mockChecks([{ status: 'completed', conclusion: 'success' }]);
        await pollOnce();

        expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(2);
      },
    );

    it('re-checks a pending CI aggregate on the pending interval, not every poll (R1-3)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-02T09:00:00.000Z'));
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'queued', conclusion: null }]);
      await pollOnce();
      expect(mockOctokit.rest.checks.listForRef).toHaveBeenCalledTimes(1);
      expect(readWatchState().entries['owner/repo#42']!['ci']).toBe('pending');

      // One poll later (60s): still pending, but inside the re-check
      // interval — no second fetch.
      vi.setSystemTime(new Date('2026-07-02T09:01:00.000Z'));
      mockPull({});
      mockNotificationsOnce([]);
      await pollOnce();
      expect(mockOctokit.rest.checks.listForRef).toHaveBeenCalledTimes(1);

      // Past the pending interval: re-observed until it settles.
      vi.setSystemTime(new Date('2026-07-02T09:06:00.000Z'));
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'queued', conclusion: null }]);
      await pollOnce();
      expect(mockOctokit.rest.checks.listForRef).toHaveBeenCalledTimes(2);
      expect(readWatchState().entries['owner/repo#42']!['ci']).toBe('pending');
    });

    it('keeps merge_conflict and state_change firing when the CI endpoint persistently fails (R1-13)', async () => {
      await initChannel(watchConfig, { boundSessions });
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      // Dirty + closed in the same poll, while Checks answers 403 (a
      // classic PAT without Checks permission): the pulls.get baseline
      // already arrived, so the other detections must not be suppressed.
      mockPull({
        mergeable: false,
        mergeable_state: 'dirty',
        state: 'closed',
        merged: false,
        updated_at: '2026-07-02T10:00:00.000Z',
      });
      mockNotificationsOnce([]);
      mockOctokit.rest.checks.listForRef.mockRejectedValueOnce(
        Object.assign(new Error('Resource not accessible by integration'), {
          status: 403,
        }),
      );
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      let errText = '';
      try {
        await pollOnce();
        // Capture before mockRestore clears the call log.
        errText = stderr.mock.calls.map((call) => String(call[0])).join('');
      } finally {
        stderr.mockRestore();
      }

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      const prompts = boundSessions.deliverPrompt.mock.calls.map(
        (call) => call[1] as string,
      );
      expect(prompts.some((p) => p.includes('Merge conflicts detected'))).toBe(
        true,
      );
      expect(prompts.some((p) => p.includes('closed without merging'))).toBe(
        true,
      );
      expect(errText).toContain('CI fetch failed');
      // A failed fetch is not a CI observation: the last known aggregate
      // stands (writing 'none' would re-fire ci_failure when it heals).
      expect(readWatchState().entries['owner/repo#42']!['ci']).toBe('success');
    });

    it('keeps watch tasks pending when reconciliation itself fails (W3)', async () => {
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
      // A crash between the claim and the pending->fired write leaves both
      // an accepted watch task and its pending record on disk; an unrelated
      // comment task proves recovery keeps running for non-watch work.
      const watchTask = makeInboundTaskRecord({
        id: 'watch-task-1',
        state: 'accepted',
        issueNumber: 42,
        source: {
          chatId: 'owner/repo',
          threadId: 'pr:42',
          messageId: 'watch:ci_failure:sha-1',
        },
        envelope: {
          ...makeInboundTaskRecord().envelope,
          threadId: 'pr:42',
          messageId: 'watch:ci_failure:sha-1',
          text: 'CI failed on head sha-1.',
        },
        dedupe: {},
        delivery: { kind: 'bound-session', sessionId: 'bound-session' },
      });
      const commentTask = makeInboundTaskRecord({
        id: 'comment-task-1',
        state: 'accepted',
        delivery: { kind: 'bound-session', sessionId: 'bound-session' },
      });
      writeInboundTasks([watchTask, commentTask]);
      const originalRead = nodeFs.readFileSync;
      const spy = vi.spyOn(nodeFs, 'readFileSync').mockImplementation(((
        path: unknown,
        ...args: unknown[]
      ) => {
        if (String(path) === watchStatePath()) {
          throw Object.assign(new Error('EACCES: permission denied'), {
            code: 'EACCES',
          });
        }
        return (originalRead as (p: unknown, ...a: unknown[]) => unknown)(
          path,
          ...args,
        );
      }) as unknown as typeof nodeFs.readFileSync);
      try {
        mockPull({});
        mockNotificationsOnce([]);
        await pollOnce();

        // The comment recovers; the watch task must stay queued — delivering
        // and removing it now would let a later drain deliver it twice.
        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
        expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
          'please fix this',
        );
        const tasks = readInboundTasks();
        expect(tasks.some((t) => t['id'] === 'watch-task-1')).toBe(true);
      } finally {
        spy.mockRestore();
      }

      // Readable again: reconciliation drains the pending event exactly
      // once (the accepted task is reused, not duplicated).
      mockPull({});
      mockNotificationsOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      expect(boundSessions.deliverPrompt.mock.calls[1]![1]).toContain(
        'CI failed on head sha-1',
      );
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('keeps the notification cursor flowing while watch reconciliation is blocked (R7-B1)', async () => {
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
      // Crash window: an accepted watch task and its pending record are
      // both on disk. The sidecar then becomes unreadable, so reconcile
      // fails and recovery must keep skipping the task.
      const watchTask = makeInboundTaskRecord({
        id: 'watch-task-1',
        state: 'accepted',
        issueNumber: 42,
        source: {
          chatId: 'owner/repo',
          threadId: 'pr:42',
          messageId: 'watch:ci_failure:sha-1',
        },
        envelope: {
          ...makeInboundTaskRecord().envelope,
          threadId: 'pr:42',
          messageId: 'watch:ci_failure:sha-1',
          text: 'CI failed on head sha-1.',
        },
        dedupe: {},
        delivery: { kind: 'bound-session', sessionId: 'bound-session' },
      });
      writeInboundTasks([watchTask]);
      const originalRead = nodeFs.readFileSync;
      const spy = vi.spyOn(nodeFs, 'readFileSync').mockImplementation(((
        path: unknown,
        ...args: unknown[]
      ) => {
        if (String(path) === watchStatePath()) {
          throw Object.assign(new Error('EACCES: permission denied'), {
            code: 'EACCES',
          });
        }
        return (originalRead as (p: unknown, ...a: unknown[]) => unknown)(
          path,
          ...args,
        );
      }) as unknown as typeof nodeFs.readFileSync);
      try {
        // An unrelated mention comment arrives while reconcile is blocked.
        mockPull({});
        mockNotificationsOnce([prNotification()]);
        mockOctokit.rest.issues.listComments.mockResolvedValueOnce([
          makeComment(),
        ]);
        await pollOnce();

        // The comment delivers privately...
        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
        expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
          'please fix this',
        );
        // ...and the shared cursor must commit: the blocked watch task
        // cannot make progress this poll, and watch events do not ride the
        // notification cursor, so freezing mark-as-read for it would stall
        // every unrelated PR until the sidecar recovers.
        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).toHaveBeenCalledTimes(1);
        const ch = channel as unknown as {
          cursor: { lastProcessedAt: string };
        };
        expect(ch.cursor.lastProcessedAt).toBe('2026-07-02T10:00:00.000Z');
        // The watch task itself stays queued and undelivered.
        const tasks = readInboundTasks();
        expect(tasks.some((t) => t['id'] === 'watch-task-1')).toBe(true);

        // A second blocked poll with no new notifications keeps the
        // committed cursor and still does not deliver the watch task.
        mockPull({});
        mockNotificationsOnce([]);
        await pollOnce();
        expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
        expect(
          mockOctokit.rest.activity.markNotificationsAsRead,
        ).toHaveBeenCalledTimes(1);
        expect(ch.cursor.lastProcessedAt).toBe('2026-07-02T10:00:00.000Z');
      } finally {
        spy.mockRestore();
      }

      // Readable again: reconciliation drains the pending event exactly
      // once — the cursor commits during the block consumed no watch event.
      mockPull({});
      mockNotificationsOnce([]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      expect(boundSessions.deliverPrompt.mock.calls[1]![1]).toContain(
        'CI failed on head sha-1',
      );
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('bounds CI re-fetches by the interval even when the endpoint persistently fails (A-F3)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-02T09:00:00.000Z'));
      await initChannel(watchConfig, { boundSessions });
      // Classic PAT without Checks permission: every fetch 403s.
      mockOctokit.rest.checks.listForRef.mockRejectedValue(
        Object.assign(new Error('Resource not accessible by integration'), {
          status: 403,
        }),
      );
      mockPull({});
      mockNotificationsOnce([]);
      await pollOnce();
      expect(mockOctokit.rest.checks.listForRef).toHaveBeenCalledTimes(1);

      // One poll later: the failed attempt must still advance the interval
      // clock — otherwise the undefined-ci condition re-fires every poll
      // and burns one doomed request per PR per poll.
      vi.setSystemTime(new Date('2026-07-02T09:01:00.000Z'));
      mockPull({});
      mockNotificationsOnce([]);
      await pollOnce();
      expect(mockOctokit.rest.checks.listForRef).toHaveBeenCalledTimes(1);

      // Past the pending interval: retried (and still isolated from the
      // other detections).
      vi.setSystemTime(new Date('2026-07-02T09:06:00.000Z'));
      mockPull({});
      mockNotificationsOnce([]);
      await pollOnce();
      expect(mockOctokit.rest.checks.listForRef).toHaveBeenCalledTimes(2);
    });

    it('does not prune a watch entry whose earlier transition still has a surviving task (A-F4)', async () => {
      await initChannel(watchConfig, { boundSessions });
      // A deferred watch task whose pending event already moved to fired:
      // the entry has no pending, and the PR is unbound in a complete
      // snapshot — the old prune would delete it, discarding the baseline
      // and ciFiredSha pin while the old task is still in flight.
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          ci: 'success',
          mergeableState: 'clean',
          prState: 'open',
          prUpdatedAt: '2026-07-02T09:00:00.000Z',
          seq: 1,
          fired: ['watch:merge_conflict:1'],
          pending: [],
        },
      });
      writeInboundTasks([
        makeInboundTaskRecord({
          id: 'old-watch-task',
          state: 'failed',
          attempts: 0,
          deferCount: 1,
          backpressure: true,
          issueNumber: 42,
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:42',
            messageId: 'watch:merge_conflict:1',
          },
          envelope: {
            ...makeInboundTaskRecord().envelope,
            threadId: 'pr:42',
            messageId: 'watch:merge_conflict:1',
            text: 'OLD conflict episode',
          },
          dedupe: {},
          delivery: { kind: 'bound-session', sessionId: 'bound-session' },
        }),
      ]);
      // Drive the watch pass directly (as the F22 prune test does) so
      // generic recovery cannot retire the old task mid-scenario. Refresh
      // the binding snapshot explicitly first (pollOnce normally does it).
      const watch = channel as unknown as {
        runPrStateWatch: () => Promise<void>;
        refreshBoundSessions: () => Promise<void>;
      };
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      await watch.refreshBoundSessions();
      mockPull({});
      await watch.runPrStateWatch();
      // The entry must survive while the old task is recoverable.
      expect(readWatchState().entries['owner/repo#42']).toBeDefined();

      // Rebind and fire a NEW conflict episode: it must get seq 2 and a
      // fresh detection-scoped key while the old task keeps its own.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [makeBinding()],
        partial: false,
      });
      await watch.refreshBoundSessions();
      boundSessions.deliverPrompt.mockRejectedValue(
        new BoundSessionQueueFullError('bound-session'),
      );
      mockPull({ mergeable: false, mergeable_state: 'dirty' });
      await watch.runPrStateWatch();
      const entry = readWatchState().entries['owner/repo#42']!;
      expect(entry['seq']).toBe(2);
      // Per-PR ordering: the old episode is still unsettled, so the new
      // one waits in pending — it must NOT drain ahead of its predecessor.
      const queued = entry['pending'] as Array<{ key: string }>;
      expect(
        queued.some((p) => /^watch:merge_conflict:42:2:\d+$/.test(p.key)),
      ).toBe(true);
      expect(entry['fired']).not.toContainEqual(
        expect.stringMatching(/^watch:merge_conflict:42:2:\d+$/),
      );
      const tasks = readInboundTasks();
      expect(tasks.some((t) => t['id'] === 'old-watch-task')).toBe(true);
      expect(tasks).toHaveLength(1);

      // Once recovery settles the old episode, the new one drains with its
      // own distinct task (never a silent reuse of the old record).
      boundSessions.deliverPrompt.mockResolvedValue(undefined);
      const recovery = channel as unknown as {
        recoverInboundTasks: () => Promise<void>;
      };
      await recovery.recoverInboundTasks();
      await watch.runPrStateWatch();
      const settled = readWatchState().entries['owner/repo#42']!;
      expect(settled['fired']).toContainEqual(
        expect.stringMatching(/^watch:merge_conflict:42:2:\d+$/),
      );
      // Both episodes delivered and retired: the task file is gone.
      expect(existsSync(inboundTaskPath())).toBe(false);
    });

    it('scopes watch keys by PR so two PRs bound to one session never collide (R2-B1)', async () => {
      await initChannel(
        { deliverToBoundSessions: true, prWatchEvents: ['merge_conflict'] },
        { boundSessions },
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
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
        ],
        partial: false,
      });
      mockPull({});
      mockNotificationsOnce([]);
      await pollOnce();

      // Both PRs turn dirty in the SAME poll: parallel episode counters
      // issue seq 1 for both and one detection timestamp serves the pass,
      // so only the PR number keeps the daemon idempotency keys apart.
      mockPull({ mergeable: false, mergeable_state: 'dirty' });
      mockNotificationsOnce([]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      const keys = boundSessions.deliverPrompt.mock.calls.map(
        (call) => call[2] as string,
      );
      expect(
        keys.some((k) =>
          /^github:owner\/repo:watch:merge_conflict:42:1:\d+$/.test(k),
        ),
      ).toBe(true);
      expect(
        keys.some((k) =>
          /^github:owner\/repo:watch:merge_conflict:43:1:\d+$/.test(k),
        ),
      ).toBe(true);
      expect(new Set(keys).size).toBe(2);
    });

    it('issues a fresh watch key after prune resets the episode counter (R2-A1)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-02T09:00:00.000Z'));
      await initChannel(
        { deliverToBoundSessions: true, prWatchEvents: ['merge_conflict'] },
        { boundSessions },
      );
      const watch = channel as unknown as {
        runPrStateWatch: () => Promise<void>;
        refreshBoundSessions: () => Promise<void>;
      };
      await watch.refreshBoundSessions();
      mockPull({});
      await watch.runPrStateWatch();
      mockPull({ mergeable: false, mergeable_state: 'dirty' });
      await watch.runPrStateWatch();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      const firstKey = boundSessions.deliverPrompt.mock.calls[0]![2] as string;
      expect(firstKey).toMatch(
        /^github:owner\/repo:watch:merge_conflict:42:1:\d+$/,
      );

      // Successful delivery removed the task; a complete empty snapshot
      // prunes the entry and resets the episode counter.
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: false,
      });
      await watch.refreshBoundSessions();
      await watch.runPrStateWatch();
      expect(readWatchState().entries['owner/repo#42']).toBeUndefined();

      // Rebind at a LATER time and recur: seq restarts at 1, but the
      // detection timestamp must keep the key distinct from the delivered
      // episode, or the daemon's long-lived ring would dedupe it away.
      vi.setSystemTime(new Date('2026-07-02T10:00:00.000Z'));
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [makeBinding()],
        partial: false,
      });
      await watch.refreshBoundSessions();
      mockPull({});
      await watch.runPrStateWatch();
      mockPull({ mergeable: false, mergeable_state: 'dirty' });
      await watch.runPrStateWatch();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      const entry = readWatchState().entries['owner/repo#42']!;
      expect(entry['seq']).toBe(1);
      const secondKey = boundSessions.deliverPrompt.mock.calls[1]![2] as string;
      expect(secondKey).toMatch(
        /^github:owner\/repo:watch:merge_conflict:42:1:\d+$/,
      );
      expect(secondKey).not.toBe(firstKey);
    });

    it('hashes an over-length event key instead of earning a route 400 (R2-A3)', async () => {
      vi.useFakeTimers();
      const start = new Date('2026-07-02T09:00:00.000Z').getTime();
      vi.setSystemTime(start);
      await initChannel(
        { deliverToBoundSessions: true, prWatchEvents: ['ci_failure'] },
        { boundSessions },
      );
      const longChatId = `${'o'.repeat(39)}/${'r'.repeat(100)}`;
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [
          makeBinding({
            prs: [
              {
                number: 42,
                url: `https://github.com/${longChatId}/pull/42`,
                state: 'open',
              },
            ],
          }),
        ],
        partial: false,
      });
      const headSha = 'a'.repeat(64);
      mockPull({ head: { sha: headSha } });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();

      vi.setSystemTime(start + 60_000);
      mockPull({
        head: { sha: headSha },
        updated_at: '2026-07-02T09:01:00.000Z',
      });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'failure' }]);
      await pollOnce();

      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      const key = boundSessions.deliverPrompt.mock.calls[0]![2] as string;
      // A 140-char repo slug plus the SHA-256 watch key overflow the
      // route's 200-char cap; the deterministic hash keeps retries
      // dedupable instead of burning the failure budget on 400s.
      const rawKey = `github:${longChatId}:watch:ci_failure:42:${headSha}:${start + 60_000}`;
      expect(rawKey.length).toBeGreaterThan(200);
      expect(key).toBe(
        `github:h:${createHash('sha256').update(rawKey).digest('hex').slice(0, 40)}`,
      );
      expect(key.length).toBeLessThanOrEqual(200);
    });

    it('caps retained bindings and watch entries under a permanent partial (R2-B2)', async () => {
      await initChannel(watchConfig, { boundSessions });
      const channelPrivate = channel as unknown as {
        lastBindings: Array<Record<string, unknown>>;
        boundSessionByPr: Map<string, Record<string, unknown>>;
        refreshBoundSessions: () => Promise<void>;
        runPrStateWatch: () => Promise<void>;
      };
      const ts = (i: number) =>
        new Date(Date.UTC(2026, 6, 2, 0, i)).toISOString();
      const sessions = Array.from({ length: 1100 }, (_, i) => ({
        sessionId: `s-${i}`,
        workspaceCwd: '/tmp/test',
        updatedAt: ts(i),
        prs: [
          {
            number: i + 1,
            url: `https://github.com/owner/repo/pull/${i + 1}`,
            state: 'open',
          },
        ],
      }));
      channelPrivate.lastBindings = sessions;
      channelPrivate.boundSessionByPr = new Map(
        sessions.map((s, i) => [`owner/repo#${i + 1}`, s]),
      );
      boundSessions.listPrBindings.mockResolvedValue({
        bindings: [],
        partial: true,
      });
      const retentionStderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        await channelPrivate.refreshBoundSessions();
        expect(
          retentionStderr.mock.calls.some((call) =>
            String(call[0]).includes('binding retention cap exceeded'),
          ),
        ).toBe(true);
      } finally {
        retentionStderr.mockRestore();
      }
      expect(channelPrivate.lastBindings).toHaveLength(1024);
      expect(
        channelPrivate.lastBindings.some((b) => b['sessionId'] === 's-1099'),
      ).toBe(true);
      expect(
        channelPrivate.lastBindings.some((b) => b['sessionId'] === 's-0'),
      ).toBe(false);
      expect(channelPrivate.boundSessionByPr.has('owner/repo#1100')).toBe(true);
      expect(channelPrivate.boundSessionByPr.has('owner/repo#1')).toBe(false);

      // The entry map takes the same cap: seed 1030 idle entries, one
      // entry OLDER than all of them that still holds a pending event,
      // one even older entry a RETAINED binding still claims (PR #1100
      // belongs to s-1099), and one older still whose earlier transition
      // has a surviving inbound task (PR #1101 — OUTSIDE the retained
      // candidate range, so the task filter is its sole protection). Only
      // the unprotected idle entries may be evicted.
      const entries: Record<string, unknown> = {};
      for (let i = 0; i < 1030; i++) {
        entries[`owner/repo#${i + 1}`] = {
          headSha: 'sha-1',
          mergeableState: 'clean',
          prState: 'open',
          headObservedAt: i,
          fired: [],
          pending: [],
        };
      }
      entries['owner/repo#0'] = {
        headSha: 'sha-1',
        mergeableState: 'clean',
        prState: 'open',
        headObservedAt: -1,
        fired: [],
        pending: [makePendingWatch({ issueNumber: 0 })],
      };
      entries['owner/repo#1100'] = {
        headSha: 'sha-1',
        mergeableState: 'clean',
        prState: 'open',
        headObservedAt: -2,
        fired: [],
        pending: [],
      };
      entries['owner/repo#1101'] = {
        headSha: 'sha-1',
        mergeableState: 'clean',
        prState: 'open',
        headObservedAt: -3,
        fired: [],
        pending: [],
      };
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'failed',
          attempts: 0,
          deferCount: 1,
          backpressure: true,
          issueNumber: 1101,
          source: {
            chatId: 'owner/repo',
            threadId: 'pr:1101',
            messageId: 'watch:merge_conflict:1101:1:1751446800000',
          },
          envelope: {
            ...makeInboundTaskRecord().envelope,
            threadId: 'pr:1101',
            messageId: 'watch:merge_conflict:1101:1:1751446800000',
          },
          dedupe: {},
          delivery: { kind: 'bound-session', sessionId: 'bound-session' },
        }),
      ]);
      seedWatchState(entries);
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        await channelPrivate.runPrStateWatch();
        expect(
          stderr.mock.calls.some((call) =>
            String(call[0]).includes('PR watch entry cap exceeded'),
          ),
        ).toBe(true);
      } finally {
        stderr.mockRestore();
      }
      const state = readWatchState();
      // 1033 entries against the 1024 cap: the 9 oldest UNPROTECTED idle
      // entries go (#1..#9). The pending holder (#0), the retained-binding
      // entry (#1100), and the surviving-task entry (#1101) are all older
      // than the evicted ones but must survive.
      expect(Object.keys(state.entries)).toHaveLength(1024);
      expect(state.entries['owner/repo#0']).toBeDefined();
      expect(state.entries['owner/repo#1100']).toBeDefined();
      expect(state.entries['owner/repo#1101']).toBeDefined();
      expect(state.entries['owner/repo#1']).toBeUndefined();
      expect(state.entries['owner/repo#9']).toBeUndefined();
      expect(state.entries['owner/repo#10']).toBeDefined();
      expect(state.entries['owner/repo#1030']).toBeDefined();
    });

    it('keeps watch recovery blocked while subscriptions are disabled with unreconciled pendings (R3-B2)', async () => {
      // The crash window between claim and pending->fired save: both the
      // pending event and its accepted task are on disk.
      const key = 'watch:state_change:42:1:1751446800000';
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          mergeableState: 'clean',
          prState: 'closed',
          fired: [],
          pending: [
            makePendingWatch({
              key,
              text: 'The PR was closed without merging.',
            }),
          ],
        },
      });
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'accepted',
          attempts: 0,
          issueNumber: 42,
          delivery: { kind: 'bound-session', sessionId: 'bound-session' },
          source: { chatId: 'owner/repo', threadId: 'pr:42', messageId: key },
          envelope: {
            ...makePendingWatch({
              key,
              text: 'The PR was closed without merging.',
            }).envelope,
          },
          dedupe: {},
        }),
      ]);
      // Subscriptions OFF: reconcile is skipped, but the accepted task's
      // pending record is unreconciled — recovery must not deliver and
      // remove it ahead of a later re-enabled drain.
      await initChannel(
        { deliverToBoundSessions: true, prWatchEvents: [] },
        { boundSessions },
      );
      mockOctokit.paginate.mockResolvedValueOnce([]);
      const disabledStderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        await pollOnce();
        expect(
          disabledStderr.mock.calls.some((call) =>
            String(call[0]).includes(
              'until subscriptions are re-enabled and the pending events reconcile',
            ),
          ),
        ).toBe(true);
      } finally {
        disabledStderr.mockRestore();
      }
      expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
      expect(readInboundTasks()).toHaveLength(1);
      // The legacy task is parked as backpressure so it stops blocking the
      // shared notification cursor while watch delivery is off.
      expect(readInboundTasks()[0]!['backpressure']).toBe(true);
      expect(
        readWatchState().entries['owner/repo#42']!['pending'],
      ).toHaveLength(1);

      // Re-enabled (fresh instance over the same state): reconcile drains
      // the pending, claims the EXISTING task, and delivers exactly once.
      await initChannel(watchConfig, { boundSessions });
      mockPull({ state: 'closed', merged: false });
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(existsSync(inboundTaskPath())).toBe(false);
      expect(
        readWatchState().entries['owner/repo#42']!['pending'],
      ).toHaveLength(0);
    });

    it('caps the pending queue and dead-letters the oldest overflow when claims keep failing (R3-B3)', async () => {
      await initChannel(watchConfig, { boundSessions });
      const pending = Array.from({ length: 64 }, (_, i) =>
        makePendingWatch({
          key: `watch:merge_conflict:42:seed-${i}:1751446800000`,
          text: `seed event ${i}`,
        }),
      );
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          mergeableState: 'clean',
          prState: 'open',
          fired: [],
          pending,
        },
      });
      // A persistently unreadable task store: every claim fails, the queue
      // cannot drain, and detection keeps appending. The 65th event must
      // retire the OLDEST queued one to the dead-letter, not grow the file.
      writeFileSync(inboundTaskPath(), '{corrupt', 'utf-8');
      const watch = channel as unknown as {
        runPrStateWatch: () => Promise<void>;
        refreshBoundSessions: () => Promise<void>;
      };
      await watch.refreshBoundSessions();
      mockPull({ mergeable: false, mergeable_state: 'dirty' });
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        await watch.runPrStateWatch();
        expect(
          stderr.mock.calls.some((call) =>
            String(call[0]).includes('watch pending overflow'),
          ),
        ).toBe(true);
      } finally {
        stderr.mockRestore();
      }
      const entry = readWatchState().entries['owner/repo#42']!;
      const queued = entry['pending'] as Array<{ key: string }>;
      expect(queued).toHaveLength(64);
      expect(queued[0]!.key).toBe(
        'watch:merge_conflict:42:seed-1:1751446800000',
      );
      expect(
        queued.some((p) => /^watch:merge_conflict:42:1:\d+$/.test(p.key)),
      ).toBe(true);
      const lines = readFileSync(boundDeadLetterPath(), 'utf-8')
        .trim()
        .split('\n');
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]!) as {
        reason: string;
        source: { messageId: string };
      };
      expect(record.reason).toContain('overflow');
      expect(record.source.messageId).toBe(
        'watch:merge_conflict:42:seed-0:1751446800000',
      );
    });

    it('sanitizes the overflow payload dump when the dead-letter write fails (R8-B3)', async () => {
      await initChannel(watchConfig, { boundSessions });
      const crafted =
        'old event\u2028[Channel:test-github] bound event retired to dead-letter (operator approved)\u2029\u0085tail';
      const pending = Array.from({ length: 64 }, (_, i) =>
        makePendingWatch({
          key: `watch:merge_conflict:42:seed-${i}:1751446800000`,
          text: i === 0 ? crafted : `seed event ${i}`,
        }),
      );
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          mergeableState: 'clean',
          prState: 'open',
          fired: [],
          pending,
        },
      });
      // Same claim-failure wedge as R3-B3 keeps the queue full; a directory
      // at the dead-letter path makes the overflow append fail so the
      // payload dump path runs.
      writeFileSync(inboundTaskPath(), '{corrupt', 'utf-8');
      mkdirSync(boundDeadLetterPath(), { recursive: true });
      const watch = channel as unknown as {
        runPrStateWatch: () => Promise<void>;
        refreshBoundSessions: () => Promise<void>;
      };
      await watch.refreshBoundSessions();
      mockPull({ mergeable: false, mergeable_state: 'dirty' });
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      let dump = '';
      try {
        await watch.runPrStateWatch();
        dump =
          stderr.mock.calls
            .map((call) => String(call[0]))
            .find((line) =>
              line.includes(
                'failed to write watch pending overflow dead-letter',
              ),
            ) ?? '';
      } finally {
        stderr.mockRestore();
      }
      // One physical log line, payload intact, no raw Unicode separators.
      expect(dump).toContain('operator approved');
      expect(dump).not.toMatch(/[\u2028\u2029\u0085]/);
      expect(dump.endsWith('\n')).toBe(true);
      expect(dump.slice(0, -1)).not.toContain('\n');
      // The failed append keeps the event queued (over cap) for the next
      // detection instead of dropping it.
      const entry = readWatchState().entries['owner/repo#42']!;
      expect((entry['pending'] as unknown[]).length).toBe(65);
    });

    it('stops the watch drain at the first failed delivery to preserve per-PR order (R5-B3)', async () => {
      await initChannel(watchConfig, { boundSessions });
      const key1 = 'watch:head_change:42:1:1751446800000';
      const key2 = 'watch:ci_failure:42:sha-1:1751446801000';
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          ci: 'success',
          mergeableState: 'clean',
          prState: 'open',
          fired: [],
          pending: [
            makePendingWatch({ key: key1, text: 'earlier event' }),
            makePendingWatch({ key: key2, text: 'later event' }),
          ],
        },
      });
      boundSessions.deliverPrompt.mockRejectedValueOnce(
        new BoundSessionQueueFullError('bound-session'),
      );
      const watch = channel as unknown as {
        runPrStateWatch: () => Promise<void>;
        refreshBoundSessions: () => Promise<void>;
      };
      await watch.refreshBoundSessions();
      mockPull({});
      await watch.runPrStateWatch();
      // The FIRST event failed (queue full): the later one must NOT jump
      // ahead of it. It stays queued for the next drain; the failed one
      // retries via recovery.
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(boundSessions.deliverPrompt.mock.calls[0]![1]).toContain(
        'earlier event',
      );
      const entry = readWatchState().entries['owner/repo#42']!;
      const queued = entry['pending'] as Array<{ key: string }>;
      expect(queued.map((p) => p.key)).toEqual([key2]);
      expect(entry['fired']).toContain(key1);
    });

    it('never delivers a later watch event before its unsettled predecessor across passes (R6-A2)', async () => {
      await initChannel(watchConfig, { boundSessions });
      const key1 = 'watch:head_change:42:1:1751446800000';
      const key2 = 'watch:ci_failure:42:sha-1:1751446801000';
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          ci: 'success',
          mergeableState: 'clean',
          prState: 'open',
          fired: [],
          pending: [
            makePendingWatch({ key: key1, text: 'earlier event' }),
            makePendingWatch({ key: key2, text: 'later event' }),
          ],
        },
      });
      boundSessions.deliverPrompt
        .mockRejectedValueOnce(new BoundSessionQueueFullError('bound-session'))
        .mockResolvedValue(undefined);
      mockPull({});
      mockNotificationsOnce([]);
      mockChecks([{ status: 'completed', conclusion: 'success' }]);
      await pollOnce();
      // A failed in the reconcile drain; the watch-pass re-drain must SKIP
      // B (its predecessor is unsettled); recovery retried A successfully.
      // B stays queued — it must never arrive before A settles.
      expect(boundSessions.deliverPrompt).toHaveBeenCalledTimes(2);
      const texts1 = boundSessions.deliverPrompt.mock.calls.map(
        (call) => call[1] as string,
      );
      expect(texts1.every((t) => t.includes('earlier event'))).toBe(true);
      expect(
        (
          readWatchState().entries['owner/repo#42']!['pending'] as Array<{
            key: string;
          }>
        ).map((p) => p.key),
      ).toEqual([key2]);

      mockNotificationsOnce([]);
      await pollOnce();
      const texts2 = boundSessions.deliverPrompt.mock.calls.map(
        (call) => call[1] as string,
      );
      expect(texts2).toHaveLength(3);
      expect(texts2[2]).toContain('later event');
      expect(
        readWatchState().entries['owner/repo#42']!['pending'],
      ).toHaveLength(0);
    });

    it('blocks watch recovery when a drain claim fails to persist (R6-B2)', async () => {
      await initChannel(watchConfig, { boundSessions });
      const key = 'watch:state_change:42:1:1751446800000';
      seedWatchState({
        'owner/repo#42': {
          headSha: 'sha-1',
          mergeableState: 'clean',
          prState: 'open',
          fired: [],
          pending: [makePendingWatch({ key })],
        },
      });
      writeInboundTasks([
        makeInboundTaskRecord({
          state: 'accepted',
          attempts: 0,
          issueNumber: 42,
          delivery: { kind: 'bound-session', sessionId: 'bound-session' },
          source: { chatId: 'owner/repo', threadId: 'pr:42', messageId: key },
          envelope: { ...makePendingWatch({ key }).envelope },
          dedupe: {},
        }),
      ]);
      const claimable = channel as unknown as {
        claimInboundTask: (...args: unknown[]) => unknown;
      };
      const spy = vi
        .spyOn(claimable, 'claimInboundTask')
        .mockImplementation(() => {
          throw new Error('disk full');
        });
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        mockPull({});
        mockNotificationsOnce([]);
        await pollOnce();
        // The claim failure must propagate out of the drain so reconcile
        // fails and the guard holds: recovery must not deliver the
        // accepted task while its pending record is unreconciled.
        const priv = channel as unknown as {
          watchReconcileBlocked: boolean;
        };
        expect(priv.watchReconcileBlocked).toBe(true);
        expect(boundSessions.deliverPrompt).not.toHaveBeenCalled();
        expect(readInboundTasks()).toHaveLength(1);
      } finally {
        spy.mockRestore();
        stderr.mockRestore();
      }
    });

    it('surfaces an unusable watch state container instead of wiping silently', async () => {
      await initChannel(watchConfig, { boundSessions });
      const path = watchStatePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{"version":2,"entries":{}}\n', 'utf-8');
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        mockPull({});
        mockNotificationsOnce([]);
        await pollOnce();
        expect(
          stderr.mock.calls.some((call) =>
            String(call[0]).includes('container unusable'),
          ),
        ).toBe(true);
      } finally {
        stderr.mockRestore();
      }
    });
  });
});
