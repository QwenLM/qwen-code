import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import type {
  ChannelAgentBridge,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';

vi.mock('@gitbeaker/rest', () => ({
  Gitlab: vi.fn(),
}));

import { Gitlab } from '@gitbeaker/rest';
import { GitlabChannel } from './GitlabAdapter.js';

function makeConfig(
  overrides: Record<string, unknown> = {},
): ChannelConfig & Record<string, unknown> {
  return {
    type: 'gitlab',
    token: 'test-token',
    senderPolicy: 'open',
    allowedUsers: [],
    sessionScope: 'chat_thread',
    cwd: '/tmp/test',
    groupPolicy: 'open',
    dmPolicy: 'open',
    groups: { '*': {} },
    action_prompt_template: {
      mentioned:
        'Project: %project% | URL: %project_url% | Author: %author% | Type: %target_type% | IID: %iid% | Title: %title% | TodoID: %todo_id%',
    },
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

function makeTodo(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    action_name: 'mentioned',
    target_type: 'Issue',
    target_url: 'https://gitlab.com/owner/repo/-/issues/42#note_1001',
    body: '@test-bot please fix this',
    state: 'pending',
    created_at: '2026-07-02T09:00:00.000Z',
    updated_at: '2026-07-02T10:00:00.000Z',
    project: {
      id: 1,
      path_with_namespace: 'owner/repo',
    },
    author: { id: 10, username: 'alice', name: 'Alice' },
    target: { id: 200, iid: 42, title: 'Test Issue' },
    ...overrides,
  };
}

function makeNote(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    body: '@test-bot please fix this',
    system: false,
    confidential: false,
    created_at: '2026-07-02T09:30:00.000Z',
    updated_at: '2026-07-02T09:30:00.000Z',
    author: { id: 10, username: 'alice', name: 'Alice' },
    ...overrides,
  };
}

/** Subclass that captures envelopes instead of running the full ChannelBase pipeline. */
class TestableGitlabChannel extends GitlabChannel {
  inboundEnvelopes: Envelope[] = [];
  handleInboundError: Error | null = null;

  override async handleInbound(envelope: Envelope): Promise<void> {
    if (this.handleInboundError) throw this.handleInboundError;
    this.inboundEnvelopes.push(envelope);
  }

  protected override startPollLoop(): void {
    // no-op: tests call pollOnce() manually
  }

  async testSendThreadMessage(
    chatId: string,
    threadId: string,
    text: string,
  ): Promise<void> {
    return this.sendThreadMessage(chatId, threadId, text);
  }
}

function createMockApi() {
  return {
    Users: {
      showCurrentUser: vi.fn().mockResolvedValue({
        id: 99999,
        username: 'test-bot',
        name: 'Test Bot',
      }),
    },
    TodoLists: {
      all: vi.fn().mockResolvedValue([]),
      done: vi.fn().mockResolvedValue(undefined),
    },
    IssueNotes: {
      all: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
    },
    MergeRequestNotes: {
      all: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
    },
    Issues: {
      show: vi.fn().mockResolvedValue({ description: 'Issue description' }),
    },
    MergeRequests: {
      show: vi.fn().mockResolvedValue({ description: 'MR description' }),
    },
  };
}

describe('GitlabChannel', () => {
  let channel: TestableGitlabChannel;
  let mockApi: ReturnType<typeof createMockApi>;
  let savedQwenHome: string | undefined;

  beforeEach(() => {
    savedQwenHome = process.env.QWEN_HOME;
    process.env.QWEN_HOME = mkdtempSync(join(tmpdir(), 'qwen-gl-test-'));
    vi.clearAllMocks();

    mockApi = createMockApi();
    vi.mocked(Gitlab).mockImplementation(() => mockApi as never);

    channel = new TestableGitlabChannel(
      'test-gitlab',
      makeConfig(),
      makeBridge(),
    );
  });

  afterEach(() => {
    if (savedQwenHome === undefined) delete process.env.QWEN_HOME;
    else process.env.QWEN_HOME = savedQwenHome;
  });

  async function initWithoutLoop() {
    await channel.connect();
    channel.disconnect();
    channel.cursor = {
      lastProcessedAt: '2026-07-01T00:00:00.000Z',
      repo: {},
    };
  }

  async function pollOnce() {
    await (channel as unknown as { pollOnce: () => Promise<void> }).pollOnce();
  }

  describe('connect', () => {
    it('resolves bot username via gitbeaker', async () => {
      await channel.connect();
      expect(mockApi.Users.showCurrentUser).toHaveBeenCalledOnce();
      channel.disconnect();
    });

    it('constructs Gitlab client with correct host', async () => {
      const config = makeConfig({ baseUrl: 'https://gitlab.example.com/' });
      const ch = new TestableGitlabChannel('test-gl', config, makeBridge());
      await ch.connect();
      expect(Gitlab).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'https://gitlab.example.com',
          token: 'test-token',
        }),
      );
      ch.disconnect();
    });

    it('throws when bot identity fails', async () => {
      mockApi.Users.showCurrentUser.mockRejectedValue(
        new Error('network error'),
      );
      await expect(channel.connect()).rejects.toThrow('network error');
    });

    it('normalizes allowedUsers to lowercase', async () => {
      const config = makeConfig({
        senderPolicy: 'allowlist',
        allowedUsers: ['Alice'],
      });
      const ch = new TestableGitlabChannel('test-gl', config, makeBridge());
      await ch.connect();
      expect(ch.config.allowedUsers).toEqual(['alice']);
      ch.disconnect();
    });
  });

  describe('pollOnce', () => {
    it('skips polling when action_prompt_template is empty', async () => {
      const config = makeConfig({ action_prompt_template: {} });
      const ch = new TestableGitlabChannel('test-gl', config, makeBridge());
      await ch.connect();
      ch.disconnect();
      ch.cursor = { lastProcessedAt: '2026-07-01T00:00:00.000Z' };

      mockApi.TodoLists.all.mockClear();
      await (ch as unknown as { pollOnce: () => Promise<void> }).pollOnce();
      expect(mockApi.TodoLists.all).not.toHaveBeenCalled();
    });

    it('skips polling when action_prompt_template is missing', async () => {
      const config = makeConfig();
      delete (config as Record<string, unknown>).action_prompt_template;
      const ch = new TestableGitlabChannel('test-gl', config, makeBridge());
      await ch.connect();
      ch.disconnect();
      ch.cursor = { lastProcessedAt: '2026-07-01T00:00:00.000Z' };

      mockApi.TodoLists.all.mockClear();
      await (ch as unknown as { pollOnce: () => Promise<void> }).pollOnce();
      expect(mockApi.TodoLists.all).not.toHaveBeenCalled();
    });

    it('dispatches todo body as envelope', async () => {
      await initWithoutLoop();

      const todo = makeTodo();
      mockApi.TodoLists.all.mockResolvedValueOnce([todo]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      const env = channel.inboundEnvelopes[0]!;
      expect(env.chatId).toBe('owner/repo');
      expect(env.threadId).toBe('issue:42');
      expect(env.senderId).toBe('alice');
      expect(env.isMentioned).toBe(true);
      expect(env.text).toContain('please fix this');
      expect(env.metadata).toContain('Project: owner/repo');
    });

    it('fetches description for non-note mention (no #note_ anchor)', async () => {
      await initWithoutLoop();

      const todo = makeTodo({
        target_url: 'https://gitlab.com/owner/repo/-/issues/42',
        body: 'Test Issue',
      });
      mockApi.TodoLists.all.mockResolvedValueOnce([todo]);
      mockApi.Issues.show.mockResolvedValueOnce({
        description: 'Full issue description with @test-bot',
      });

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.text).toContain(
        'Full issue description',
      );
      expect(mockApi.Issues.show).toHaveBeenCalled();
    });

    it('filters system notes', async () => {
      await initWithoutLoop();

      const todo = makeTodo({ author: { id: 99999, username: 'test-bot' } });
      const systemNote = makeNote({ system: true, body: 'assigned to @alice' });

      mockApi.TodoLists.all.mockResolvedValueOnce([todo]);
      mockApi.IssueNotes.all.mockResolvedValueOnce([systemNote]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('filters bot own notes', async () => {
      await initWithoutLoop();

      const todo = makeTodo({ author: { id: 99999, username: 'test-bot' } });
      const botNote = makeNote({
        author: { id: 99999, username: 'test-bot', name: 'Test Bot' },
      });

      mockApi.TodoLists.all.mockResolvedValueOnce([todo]);
      mockApi.IssueNotes.all.mockResolvedValueOnce([botNote]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('skips todos with unconfigured action_name', async () => {
      await initWithoutLoop();

      const todo = makeTodo({ action_name: 'assigned' });
      mockApi.TodoLists.all.mockResolvedValueOnce([todo]);

      await pollOnce();

      expect(mockApi.IssueNotes.all).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('skips non-issue/MR target types', async () => {
      await initWithoutLoop();

      const todo = makeTodo({ target_type: 'Epic' });
      mockApi.TodoLists.all.mockResolvedValueOnce([todo]);

      await pollOnce();

      expect(mockApi.IssueNotes.all).not.toHaveBeenCalled();
      expect(channel.inboundEnvelopes).toHaveLength(0);
    });

    it('marks todo as done after successful processing', async () => {
      await initWithoutLoop();

      const todo = makeTodo();
      const note = makeNote();

      mockApi.TodoLists.all.mockResolvedValueOnce([todo]);
      mockApi.IssueNotes.all.mockResolvedValueOnce([note]);

      await pollOnce();

      expect(mockApi.TodoLists.done).toHaveBeenCalledWith({ todoId: 100 });
    });

    it('marks todo done and advances cursor even when handleInbound fails', async () => {
      await initWithoutLoop();
      channel.handleInboundError = new Error('agent failed');

      const todo = makeTodo();
      mockApi.TodoLists.all.mockResolvedValueOnce([todo]);

      await pollOnce();

      expect(mockApi.TodoLists.done).toHaveBeenCalledWith({ todoId: 100 });
      expect(channel.cursor.lastProcessedAt).toBe('2026-07-02T10:00:00.000Z');
    });

    it('advances cursor to maxUpdatedAt', async () => {
      await initWithoutLoop();

      const todo1 = makeTodo({ id: 1, updated_at: '2026-07-02T10:00:00.000Z' });
      const todo2 = makeTodo({ id: 2, updated_at: '2026-07-02T12:00:00.000Z' });

      mockApi.TodoLists.all.mockResolvedValueOnce([todo1, todo2]);
      mockApi.IssueNotes.all.mockResolvedValue([]);

      await pollOnce();

      expect(channel.cursor.lastProcessedAt).toBe('2026-07-02T12:00:00.000Z');
    });

    it('handles MR todos with correct threadId', async () => {
      await initWithoutLoop();

      const todo = makeTodo({
        target_type: 'MergeRequest',
        target: { id: 300, iid: 99, title: 'Test MR' },
      });

      mockApi.TodoLists.all.mockResolvedValueOnce([todo]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.threadId).toBe('mr:99');
    });

    it('fetches pending todos', async () => {
      await initWithoutLoop();
      mockApi.TodoLists.all.mockResolvedValueOnce([]);

      await pollOnce();

      expect(mockApi.TodoLists.all).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'pending' }),
      );
    });

    it('skips todo with empty body', async () => {
      await initWithoutLoop();

      const todo = makeTodo({ body: '' });
      mockApi.TodoLists.all.mockResolvedValueOnce([todo]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(mockApi.TodoLists.done).toHaveBeenCalledWith({ todoId: 100 });
    });
  });

  describe('sendThreadMessage', () => {
    it('posts a note to an issue', async () => {
      await initWithoutLoop();

      await channel.testSendThreadMessage('owner/repo', 'issue:42', 'reply');

      expect(mockApi.IssueNotes.create).toHaveBeenCalledWith(
        'owner/repo',
        42,
        'reply',
      );
    });

    it('posts a note to a merge request', async () => {
      await initWithoutLoop();

      await channel.testSendThreadMessage('owner/repo', 'mr:99', 'reply');

      expect(mockApi.MergeRequestNotes.create).toHaveBeenCalledWith(
        'owner/repo',
        99,
        'reply',
      );
    });

    it('throws on invalid threadId format', async () => {
      await initWithoutLoop();
      await expect(
        channel.testSendThreadMessage('owner/repo', 'invalid', 'reply'),
      ).rejects.toThrow('invalid threadId format');
    });

    it('throws on undefined threadId', async () => {
      await initWithoutLoop();
      await expect(
        channel.testSendThreadMessage('owner/repo', undefined as never, 'x'),
      ).rejects.toThrow('requires a threadId');
    });
  });

  describe('cursor validation', () => {
    it('rejects cursor with invalid lastProcessedAt', () => {
      const result = (
        channel as unknown as {
          validateCursor: (p: unknown) => unknown;
        }
      ).validateCursor({ lastProcessedAt: 'not-a-date' });
      expect(result).toBeNull();
    });

    it('rejects cursor with missing lastProcessedAt', () => {
      const result = (
        channel as unknown as {
          validateCursor: (p: unknown) => unknown;
        }
      ).validateCursor({});
      expect(result).toBeNull();
    });
  });

  describe('template rendering', () => {
    it('replaces all known variables', async () => {
      await initWithoutLoop();

      const todo = makeTodo();
      mockApi.TodoLists.all.mockResolvedValueOnce([todo]);

      await pollOnce();

      const env = channel.inboundEnvelopes[0]!;
      expect(env.metadata).toBe(
        'Project: owner/repo | URL: https://gitlab.com/owner/repo | Author: alice | Type: Issue | IID: 42 | Title: Test Issue | TodoID: 100',
      );
    });

    it('preserves unknown variables as-is', async () => {
      await initWithoutLoop();
      (channel.config as Record<string, unknown>).action_prompt_template = {
        mentioned: 'Known: %project% Unknown: %nonexistent%',
      };

      const todo = makeTodo();
      mockApi.TodoLists.all.mockResolvedValueOnce([todo]);

      await pollOnce();

      expect(channel.inboundEnvelopes[0]!.metadata).toBe(
        'Known: owner/repo Unknown: %nonexistent%',
      );
    });
  });

  describe('error handling', () => {
    it('continues processing after failure, advances cursor for all todos', async () => {
      await initWithoutLoop();
      channel.handleInboundError = new Error('agent failed');

      const todo1 = makeTodo({
        id: 1,
        updated_at: '2026-07-02T10:00:00.000Z',
        target: { id: 200, iid: 1, title: 'A' },
      });
      const todo2 = makeTodo({
        id: 2,
        updated_at: '2026-07-02T12:00:00.000Z',
        target: { id: 201, iid: 2, title: 'B' },
      });

      mockApi.TodoLists.all.mockResolvedValueOnce([todo1, todo2]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(mockApi.TodoLists.done).toHaveBeenCalledWith({ todoId: 1 });
      expect(mockApi.TodoLists.done).toHaveBeenCalledWith({ todoId: 2 });
      expect(channel.cursor.lastProcessedAt).toBe('2026-07-02T12:00:00.000Z');
    });
  });
});
