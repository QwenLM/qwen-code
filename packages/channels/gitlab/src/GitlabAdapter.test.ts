import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
  inboundErrorSourceLabel: string | undefined;

  override async handleInbound(envelope: Envelope): Promise<void> {
    if (this.handleInboundError) throw this.handleInboundError;
    this.inboundEnvelopes.push(envelope);
  }

  protected override startPollLoop(): void {
    // no-op: tests call pollOnce() manually
  }

  protected override getInboundErrorSourceLabel(
    _envelope: Envelope,
  ): string | undefined {
    return this.inboundErrorSourceLabel;
  }

  async testSendThreadMessage(
    chatId: string,
    threadId: string,
    text: string,
    sourceLabel?: string,
  ): Promise<void> {
    return this.sendThreadMessage(chatId, threadId, text, sourceLabel);
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
    IssueNoteAwardEmojis: {
      award: vi.fn().mockResolvedValue({ id: 9000 }),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    MergeRequestNoteAwardEmojis: {
      award: vi.fn().mockResolvedValue({ id: 9000 }),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe('GitlabChannel', () => {
  let channel: TestableGitlabChannel;
  let mockApi: ReturnType<typeof createMockApi>;
  let savedQwenHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    savedQwenHome = process.env.QWEN_HOME;
    tempDir = mkdtempSync(join(tmpdir(), 'qwen-gl-test-'));
    process.env.QWEN_HOME = tempDir;
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
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function initWithoutLoop() {
    await channel.connect();
    channel.disconnect();
    channel.cursor = {
      lastProcessedId: 0,
      initialized: true,
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

    it('does not warn about groupPolicy when pairing is configured', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        const config = makeConfig({ groupPolicy: 'pairing' });
        const ch = new TestableGitlabChannel('test-gl', config, makeBridge());
        await ch.connect();
        ch.disconnect();
        expect(
          stderr.mock.calls.some((call) =>
            String(call[0]).includes('groupPolicy is'),
          ),
        ).toBe(false);
      } finally {
        stderr.mockRestore();
      }
    });

    it('warns on connect when groupPolicy cannot dispatch todos', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        const config = makeConfig({ groupPolicy: 'disabled' });
        const ch = new TestableGitlabChannel('test-gl', config, makeBridge());
        await ch.connect();
        ch.disconnect();
        const warnings = stderr.mock.calls
          .map((call) => String(call[0]))
          .filter((text) => text.includes('groupPolicy is "disabled"'));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('"pairing"');
      } finally {
        stderr.mockRestore();
      }
    });
  });

  describe('pollOnce', () => {
    it('skips polling when action_prompt_template is empty', async () => {
      const config = makeConfig({ action_prompt_template: {} });
      const ch = new TestableGitlabChannel('test-gl', config, makeBridge());
      await ch.connect();
      ch.disconnect();
      ch.cursor = { lastProcessedId: 0, initialized: true };

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
      ch.cursor = { lastProcessedId: 0, initialized: true };

      mockApi.TodoLists.all.mockClear();
      await (ch as unknown as { pollOnce: () => Promise<void> }).pollOnce();
      expect(mockApi.TodoLists.all).not.toHaveBeenCalled();
    });

    it('drains pre-existing todos on first poll without dispatching', async () => {
      await channel.connect();
      channel.disconnect();
      // cursor starts as { lastProcessedId: 0, initialized: false }

      const todo1 = makeTodo({ id: 10 });
      const todo2 = makeTodo({ id: 20 });
      mockApi.TodoLists.all.mockResolvedValueOnce([todo1, todo2]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(mockApi.TodoLists.done).toHaveBeenCalledWith({ todoId: 10 });
      expect(mockApi.TodoLists.done).toHaveBeenCalledWith({ todoId: 20 });
      expect(channel.cursor.lastProcessedId).toBe(20);
      expect(channel.cursor.initialized).toBe(true);
    });

    it('drains a very large backlog without dispatching', async () => {
      await channel.connect();
      channel.disconnect();

      const many = Array.from({ length: 150_000 }, (_, i) =>
        makeTodo({ id: i + 1 }),
      );
      mockApi.TodoLists.all.mockResolvedValueOnce(many);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(channel.cursor.lastProcessedId).toBe(150_000);
      expect(channel.cursor.initialized).toBe(true);
    });

    it('leaves the cursor uninitialized when the first-poll drain throws', async () => {
      await channel.connect();
      channel.disconnect();

      mockApi.TodoLists.done.mockImplementationOnce(() => {
        throw new Error('drain boom');
      });
      mockApi.TodoLists.all.mockResolvedValueOnce([makeTodo({ id: 10 })]);

      await expect(pollOnce()).rejects.toThrow('drain boom');
      expect(channel.cursor.initialized).toBe(false);
    });

    it('processes new todos after first poll drain', async () => {
      await channel.connect();
      channel.disconnect();

      // First poll: drain
      const old = makeTodo({ id: 10 });
      mockApi.TodoLists.all.mockResolvedValueOnce([old]);
      await pollOnce();
      expect(channel.inboundEnvelopes).toHaveLength(0);

      // Second poll: new todo arrives
      const fresh = makeTodo({ id: 30 });
      mockApi.TodoLists.all.mockResolvedValueOnce([fresh]);
      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.text).toContain('please fix this');
      expect(channel.cursor.lastProcessedId).toBe(30);
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

    it('skips todo authored by bot', async () => {
      await initWithoutLoop();

      const todo = makeTodo({ author: { id: 99999, username: 'test-bot' } });
      mockApi.TodoLists.all.mockResolvedValueOnce([todo]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(mockApi.TodoLists.done).toHaveBeenCalledWith({ todoId: 100 });
    });

    it('skips todos with unconfigured action_name', async () => {
      await initWithoutLoop();

      const todo = makeTodo({ action_name: 'assigned' });
      mockApi.TodoLists.all.mockResolvedValueOnce([todo]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(mockApi.TodoLists.done).toHaveBeenCalledWith({ todoId: 100 });
      expect(channel.cursor.lastProcessedId).toBe(100);
    });

    it('skips non-issue/MR target types', async () => {
      await initWithoutLoop();

      const todo = makeTodo({ target_type: 'Epic' });
      mockApi.TodoLists.all.mockResolvedValueOnce([todo]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(0);
      expect(mockApi.TodoLists.done).toHaveBeenCalledWith({ todoId: 100 });
      expect(channel.cursor.lastProcessedId).toBe(100);
    });

    it('handles directly_addressed via mentioned template fallback', async () => {
      await initWithoutLoop();

      const todo = makeTodo({ action_name: 'directly_addressed' });
      mockApi.TodoLists.all.mockResolvedValueOnce([todo]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(1);
      expect(channel.inboundEnvelopes[0]!.text).toContain('please fix this');
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

    it('attributes failures while marking the todo done and advancing', async () => {
      await initWithoutLoop();
      channel.handleInboundError = new Error('agent failed');
      channel.inboundErrorSourceLabel = '[review_*]';

      const todo = makeTodo();
      mockApi.TodoLists.all.mockResolvedValueOnce([todo]);

      await pollOnce();

      expect(mockApi.TodoLists.done).toHaveBeenCalledWith({ todoId: 100 });
      expect(channel.cursor.lastProcessedId).toBe(100);
      expect(mockApi.IssueNotes.create).toHaveBeenCalledWith(
        'owner/repo',
        42,
        '\\[review\\_\\*\\]\n⚠️ Failed to process this request. Please re-mention the bot to retry.',
      );
    });

    it('advances cursor to max todo id', async () => {
      await initWithoutLoop();

      const todo1 = makeTodo({ id: 1, updated_at: '2026-07-02T10:00:00.000Z' });
      const todo2 = makeTodo({ id: 2, updated_at: '2026-07-02T12:00:00.000Z' });

      mockApi.TodoLists.all.mockResolvedValueOnce([todo1, todo2]);
      mockApi.IssueNotes.all.mockResolvedValue([]);

      await pollOnce();

      expect(channel.cursor.lastProcessedId).toBe(2);
    });

    it('delivers both todos when updated_at is identical', async () => {
      await initWithoutLoop();

      mockApi.TodoLists.all.mockResolvedValueOnce([
        makeTodo({ id: 1, updated_at: '2026-07-02T10:00:00.000Z' }),
        makeTodo({ id: 2, updated_at: '2026-07-02T10:00:00.000Z' }),
      ]);
      mockApi.IssueNotes.all.mockResolvedValue([]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(2);
      expect(channel.cursor.lastProcessedId).toBe(2);
    });

    it('orders by todo id even when updated_at disagrees', async () => {
      await initWithoutLoop();

      mockApi.TodoLists.all.mockResolvedValueOnce([
        makeTodo({
          id: 1,
          body: 'first',
          updated_at: '2026-07-02T12:00:00.000Z',
        }),
        makeTodo({
          id: 2,
          body: 'second',
          updated_at: '2026-07-02T10:00:00.000Z',
        }),
      ]);
      mockApi.IssueNotes.all.mockResolvedValue([]);

      await pollOnce();

      expect(channel.inboundEnvelopes).toHaveLength(2);
      expect(channel.inboundEnvelopes[0]!.text).toContain('first');
      expect(channel.inboundEnvelopes[1]!.text).toContain('second');
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

    it('escapes the source label before posting a note', async () => {
      await initWithoutLoop();

      await channel.testSendThreadMessage(
        'owner/repo',
        'issue:42',
        'reply',
        '[review_~~*]',
      );

      expect(mockApi.IssueNotes.create).toHaveBeenCalledWith(
        'owner/repo',
        42,
        '\\[review\\_\\~\\~\\*\\]\nreply',
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
    it('accepts valid cursor', () => {
      const result = (
        channel as unknown as {
          validateCursor: (p: unknown) => unknown;
        }
      ).validateCursor({ lastProcessedId: 42, initialized: true });
      expect(result).toEqual({ lastProcessedId: 42, initialized: true });
    });

    it('rejects cursor with invalid lastProcessedId', () => {
      const result = (
        channel as unknown as {
          validateCursor: (p: unknown) => unknown;
        }
      ).validateCursor({ lastProcessedId: 'not-a-number', initialized: true });
      expect(result).toBeNull();
    });

    it('rejects cursor with missing fields', () => {
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
      expect(channel.cursor.lastProcessedId).toBe(2);
    });
  });

  describe('working reaction', () => {
    class ReactingGitlabChannel extends GitlabChannel {
      override async handleInbound(envelope: Envelope): Promise<void> {
        this.onPromptStart(envelope.chatId, 'session-1', envelope.messageId);
        await Promise.resolve();
        this.onPromptEnd(envelope.chatId, 'session-1', envelope.messageId);
      }

      protected override startPollLoop(): void {}
    }

    class LiveGitlabChannel extends GitlabChannel {
      setReactionForTest(
        messageId: string,
        entry: {
          target: { iid: number; title: string; isMr: boolean };
          noteId: number;
        },
      ): void {
        (
          this as unknown as {
            reactions: Map<
              string,
              {
                target: { iid: number; title: string; isMr: boolean };
                noteId: number;
                award?: Promise<{ awardId: number }>;
              }
            >;
          }
        ).reactions.set(messageId, entry);
      }

      startPromptForTest(
        chatId: string,
        sessionId: string,
        messageId: string,
      ): void {
        this.onPromptStart(chatId, sessionId, messageId);
      }

      endPromptForTest(
        chatId: string,
        sessionId: string,
        messageId: string,
      ): void {
        this.onPromptEnd(chatId, sessionId, messageId);
      }
    }

    it('drives award/remove through real pollOnce path for note mention', async () => {
      const channel = new ReactingGitlabChannel(
        'test-gitlab',
        makeConfig(),
        makeBridge(),
      );
      await channel.connect();
      channel.disconnect();
      (
        channel as unknown as {
          cursor: { lastProcessedId: number; initialized: boolean };
        }
      ).cursor = {
        lastProcessedId: 0,
        initialized: true,
      };
      mockApi.TodoLists.all.mockResolvedValueOnce([makeTodo()]);

      await (
        channel as unknown as { pollOnce: () => Promise<void> }
      ).pollOnce();

      expect(mockApi.IssueNoteAwardEmojis.award).toHaveBeenCalledWith(
        'owner/repo',
        42,
        1001,
        'eyes',
      );
      await vi.waitFor(() =>
        expect(mockApi.IssueNoteAwardEmojis.remove).toHaveBeenCalledWith(
          'owner/repo',
          42,
          1001,
          9000,
        ),
      );
    });

    it('does not award emoji for description mention via real path', async () => {
      const channel = new ReactingGitlabChannel(
        'test-gitlab',
        makeConfig(),
        makeBridge(),
      );
      await channel.connect();
      channel.disconnect();
      (
        channel as unknown as {
          cursor: { lastProcessedId: number; initialized: boolean };
        }
      ).cursor = {
        lastProcessedId: 0,
        initialized: true,
      };
      mockApi.TodoLists.all.mockResolvedValueOnce([
        makeTodo({
          target_url: 'https://gitlab.com/owner/repo/-/issues/42',
          body: 'Test Issue',
        }),
      ]);

      await (
        channel as unknown as { pollOnce: () => Promise<void> }
      ).pollOnce();

      expect(mockApi.IssueNoteAwardEmojis.award).not.toHaveBeenCalled();
    });

    it('acknowledges a note mention with an eyes award emoji', async () => {
      const liveChannel = new LiveGitlabChannel(
        'test-gitlab',
        makeConfig(),
        makeBridge(),
      );
      await liveChannel.connect();
      liveChannel.disconnect();
      liveChannel.setReactionForTest('100', {
        target: { iid: 42, title: '', isMr: false },
        noteId: 1001,
      });

      liveChannel.startPromptForTest('owner/repo', 'session-1', '100');

      expect(mockApi.IssueNoteAwardEmojis.award).toHaveBeenCalledWith(
        'owner/repo',
        42,
        1001,
        'eyes',
      );
    });

    it('removes the award emoji when the prompt finishes', async () => {
      const liveChannel = new LiveGitlabChannel(
        'test-gitlab',
        makeConfig(),
        makeBridge(),
      );
      await liveChannel.connect();
      liveChannel.disconnect();
      liveChannel.setReactionForTest('100', {
        target: { iid: 42, title: '', isMr: false },
        noteId: 1001,
      });

      liveChannel.startPromptForTest('owner/repo', 'session-1', '100');
      await Promise.resolve();
      liveChannel.endPromptForTest('owner/repo', 'session-1', '100');

      await vi.waitFor(() =>
        expect(mockApi.IssueNoteAwardEmojis.remove).toHaveBeenCalledWith(
          'owner/repo',
          42,
          1001,
          9000,
        ),
      );
    });

    it('uses MergeRequestNoteAwardEmojis for MR note mentions', async () => {
      const liveChannel = new LiveGitlabChannel(
        'test-gitlab',
        makeConfig(),
        makeBridge(),
      );
      await liveChannel.connect();
      liveChannel.disconnect();
      liveChannel.setReactionForTest('100', {
        target: { iid: 99, title: '', isMr: true },
        noteId: 2001,
      });

      liveChannel.startPromptForTest('owner/repo', 'session-1', '100');

      expect(mockApi.MergeRequestNoteAwardEmojis.award).toHaveBeenCalledWith(
        'owner/repo',
        99,
        2001,
        'eyes',
      );
    });

    it('does not award twice when onPromptStart is called again', async () => {
      const liveChannel = new LiveGitlabChannel(
        'test-gitlab',
        makeConfig(),
        makeBridge(),
      );
      await liveChannel.connect();
      liveChannel.disconnect();
      liveChannel.setReactionForTest('100', {
        target: { iid: 42, title: '', isMr: false },
        noteId: 1001,
      });

      liveChannel.startPromptForTest('owner/repo', 'session-1', '100');
      liveChannel.startPromptForTest('owner/repo', 'session-1', '100');

      expect(mockApi.IssueNoteAwardEmojis.award).toHaveBeenCalledTimes(1);
    });

    it('handles award failure as best-effort', async () => {
      mockApi.IssueNoteAwardEmojis.award.mockRejectedValueOnce(
        new Error('403'),
      );
      const liveChannel = new LiveGitlabChannel(
        'test-gitlab',
        makeConfig(),
        makeBridge(),
      );
      await liveChannel.connect();
      liveChannel.disconnect();
      liveChannel.setReactionForTest('100', {
        target: { iid: 42, title: '', isMr: false },
        noteId: 1001,
      });

      liveChannel.startPromptForTest('owner/repo', 'session-1', '100');

      await vi.waitFor(() =>
        expect(mockApi.IssueNoteAwardEmojis.award).toHaveBeenCalled(),
      );
      liveChannel.endPromptForTest('owner/repo', 'session-1', '100');
      await Promise.resolve();
      expect(mockApi.IssueNoteAwardEmojis.remove).not.toHaveBeenCalled();
    });

    it('handles remove failure as best-effort', async () => {
      mockApi.IssueNoteAwardEmojis.remove.mockRejectedValueOnce(
        new Error('403'),
      );
      const liveChannel = new LiveGitlabChannel(
        'test-gitlab',
        makeConfig(),
        makeBridge(),
      );
      await liveChannel.connect();
      liveChannel.disconnect();
      liveChannel.setReactionForTest('100', {
        target: { iid: 42, title: '', isMr: false },
        noteId: 1001,
      });

      liveChannel.startPromptForTest('owner/repo', 'session-1', '100');
      await Promise.resolve();
      liveChannel.endPromptForTest('owner/repo', 'session-1', '100');

      await vi.waitFor(() =>
        expect(mockApi.IssueNoteAwardEmojis.remove).toHaveBeenCalled(),
      );
    });

    it('waits for pending award before removing', async () => {
      const { promise: awardPending, resolve: resolveAward } =
        Promise.withResolvers<{ id: number }>();
      mockApi.IssueNoteAwardEmojis.award.mockReturnValueOnce(awardPending);
      const liveChannel = new LiveGitlabChannel(
        'test-gitlab',
        makeConfig(),
        makeBridge(),
      );
      await liveChannel.connect();
      liveChannel.disconnect();
      liveChannel.setReactionForTest('100', {
        target: { iid: 42, title: '', isMr: false },
        noteId: 1001,
      });

      liveChannel.startPromptForTest('owner/repo', 'session-1', '100');
      liveChannel.endPromptForTest('owner/repo', 'session-1', '100');
      expect(mockApi.IssueNoteAwardEmojis.remove).not.toHaveBeenCalled();

      resolveAward({ id: 9001 });
      await awardPending;
      await vi.waitFor(() =>
        expect(mockApi.IssueNoteAwardEmojis.remove).toHaveBeenCalledWith(
          'owner/repo',
          42,
          1001,
          9001,
        ),
      );
    });
  });
});
