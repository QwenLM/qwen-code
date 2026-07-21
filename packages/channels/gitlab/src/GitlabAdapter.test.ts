import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitlabChannel } from './GitlabAdapter.js';
import { savePollCursor, loadPollCursor } from '@qwen-code/channel-base';
import type {
  ChannelAgentBridge,
  ChannelConfig,
} from '@qwen-code/channel-base';

const baseConfig: ChannelConfig = {
  type: 'gitlab',
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
  mockTodosAll,
  mockTodoDone,
  mockIssueNotesCreate,
  mockMRNotesCreate,
  mockIssuesCreate,
} = vi.hoisted(() => ({
  mockTodosAll: vi.fn(),
  mockTodoDone: vi.fn(),
  mockIssueNotesCreate: vi.fn(),
  mockMRNotesCreate: vi.fn(),
  mockIssuesCreate: vi.fn(),
}));

vi.mock('@gitbeaker/rest', () => ({
  Gitlab: vi.fn().mockImplementation(() => ({
    TodoLists: { all: mockTodosAll, done: mockTodoDone },
    IssueNotes: { create: mockIssueNotesCreate },
    MergeRequestNotes: { create: mockMRNotesCreate },
    Issues: { create: mockIssuesCreate },
  })),
}));

describe('GitlabChannel', () => {
  let tempDir: string;
  let originalQwenHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gitlab-adapter-test-'));
    originalQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = tempDir;
    mockTodosAll.mockClear();
    mockTodoDone.mockClear();
    mockIssueNotesCreate.mockClear();
    mockMRNotesCreate.mockClear();
    mockIssuesCreate.mockClear();
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

  it('polls todos on connect', async () => {
    mockTodosAll.mockResolvedValueOnce([]);

    const channel = new GitlabChannel('test', baseConfig, mockBridge());
    await channel.connect();
    channel.disconnect();

    expect(mockTodosAll).toHaveBeenCalled();
  });

  it('dispatches todos with real sender and isGroup', async () => {
    const bridge = mockBridge();
    const promptFn = vi.fn().mockResolvedValue(undefined);
    (bridge as Record<string, unknown>).prompt = promptFn;

    mockTodosAll.mockResolvedValueOnce([
      {
        id: 1,
        action_name: 'mentioned',
        target_type: 'Issue',
        target: { title: 'Fix login bug', iid: 5 },
        target_url: 'https://gitlab.com/owner/repo/-/issues/5',
        body: 'Please fix this',
        state: 'pending',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        project: {
          name: 'repo',
          path_with_namespace: 'owner/repo',
        },
        author: { name: 'Alice', username: 'alice' },
      },
    ]);
    mockTodoDone.mockResolvedValueOnce({});

    const channel = new GitlabChannel('test', baseConfig, bridge);
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
    await vi.waitFor(
      () => expect(mockTodoDone).toHaveBeenCalledWith({ todoId: 1 }),
      {
        timeout: 2000,
      },
    );
    channel.disconnect();

    expect(mockTodoDone).toHaveBeenCalledWith({ todoId: 1 });
    expect(promptFn).toHaveBeenCalled();
    const env = envelopes[0] as {
      senderId: string;
      senderName: string;
      isGroup: boolean;
      chatId: string;
      threadId: string;
    };
    expect(env.senderId).toBe('alice');
    expect(env.senderName).toBe('Alice');
    expect(env.isGroup).toBe(true);
    expect(env.chatId).toBe('owner/repo');
    expect(env.threadId).toBe('issue:5');
  });

  it('does not re-dispatch seen todos', async () => {
    const bridge = mockBridge();
    const promptFn = vi.fn().mockResolvedValue(undefined);
    (bridge as Record<string, unknown>).prompt = promptFn;

    mockTodosAll.mockResolvedValue([
      {
        id: 1,
        action_name: 'mentioned',
        target_type: 'MergeRequest',
        target: { title: 'Add feature', iid: 3 },
        target_url: 'https://gitlab.com/owner/repo/-/merge_requests/3',
        body: '',
        state: 'pending',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        project: {
          name: 'repo',
          path_with_namespace: 'owner/repo',
        },
        author: { name: 'Bob', username: 'bob' },
      },
    ]);
    mockTodoDone.mockResolvedValue({});

    const channel = new GitlabChannel(
      'test',
      { ...baseConfig, pollInterval: 50 },
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

  it('includes source branch in text for merge request todos', async () => {
    const bridge = mockBridge();

    mockTodosAll.mockResolvedValueOnce([
      {
        id: 5,
        action_name: 'mentioned',
        target_type: 'MergeRequest',
        target: {
          title: 'Add feature',
          iid: 3,
          source_branch: 'feature-branch',
        },
        target_url: 'https://gitlab.com/owner/repo/-/merge_requests/3',
        body: 'Please review @bob',
        state: 'pending',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        project: {
          name: 'repo',
          path_with_namespace: 'owner/repo',
        },
        author: { name: 'Bob', username: 'bob' },
      },
    ]);
    mockTodoDone.mockResolvedValueOnce({});

    const channel = new GitlabChannel('test', baseConfig, bridge);
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

    const text = (envelopes[0] as { text: string }).text;
    expect(text).toContain('Please review');
    expect(text).not.toContain('@bob');
    expect(text).toContain(
      'URL: https://gitlab.com/owner/repo/-/merge_requests/3',
    );
    expect(text).toContain('Branch: feature-branch');
  });

  it('sendThreadMessage creates note on issue', async () => {
    mockIssueNotesCreate.mockResolvedValueOnce({});

    const channel = new GitlabChannel('test', baseConfig, mockBridge());
    await channel.sendThreadMessage('owner/repo', 'issue:5', 'Hello');

    expect(mockIssueNotesCreate).toHaveBeenCalledWith('owner/repo', 5, 'Hello');
  });

  it('sendThreadMessage creates note on MR', async () => {
    mockMRNotesCreate.mockResolvedValueOnce({});

    const channel = new GitlabChannel('test', baseConfig, mockBridge());
    await channel.sendThreadMessage('owner/repo', 'mr:3', 'Review');

    expect(mockMRNotesCreate).toHaveBeenCalledWith('owner/repo', 3, 'Review');
  });

  it('sendThreadMessage creates new issue when threadId is undefined', async () => {
    mockIssuesCreate.mockResolvedValueOnce({
      iid: 42,
      web_url: 'https://gitlab.com/owner/repo/-/issues/42',
    });

    const channel = new GitlabChannel('test', baseConfig, mockBridge());
    await channel.sendThreadMessage(
      'owner/repo',
      undefined,
      'Your pairing code is: abc123',
    );

    expect(mockIssuesCreate).toHaveBeenCalledWith(
      'owner/repo',
      'Your pairing code is: abc123',
      { description: 'Your pairing code is: abc123' },
    );
  });

  it('dismisses todos with unsupported target_type', async () => {
    mockTodosAll.mockResolvedValue([
      {
        id: 99,
        action_name: 'mentioned',
        target_type: 'Commit',
        target: { title: 'abc' },
        target_url: null,
        body: '',
        state: 'pending',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        project: {
          name: 'repo',
          path_with_namespace: 'owner/repo',
        },
        author: { name: 'Alice', username: 'alice' },
      },
    ]);
    mockTodoDone.mockResolvedValue({});

    const envelopes: unknown[] = [];
    const channel = new GitlabChannel('test', baseConfig, mockBridge());
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
    await vi.waitFor(() => expect(mockTodoDone).toHaveBeenCalled(), {
      timeout: 2000,
    });
    channel.disconnect();

    expect(envelopes.length).toBe(0);
    expect(mockTodoDone).toHaveBeenCalledWith({ todoId: 99 });
  });

  it('sendThreadMessage ignores invalid chatId', async () => {
    const channel = new GitlabChannel('test', baseConfig, mockBridge());
    await channel.sendThreadMessage('noslash', 'issue:1', 'Hello');
    expect(mockIssueNotesCreate).not.toHaveBeenCalled();
    expect(mockMRNotesCreate).not.toHaveBeenCalled();
    expect(mockIssuesCreate).not.toHaveBeenCalled();
  });

  it('sendThreadMessage ignores unrecognized threadId', async () => {
    const channel = new GitlabChannel('test', baseConfig, mockBridge());
    await channel.sendThreadMessage('owner/repo', 'garbage', 'Hello');
    expect(mockIssueNotesCreate).not.toHaveBeenCalled();
    expect(mockMRNotesCreate).not.toHaveBeenCalled();
    expect(mockIssuesCreate).not.toHaveBeenCalled();
  });

  it('retries handleInbound failure without advancing cursor', async () => {
    const bridge = mockBridge();
    (bridge as Record<string, unknown>).prompt = vi
      .fn()
      .mockRejectedValue(new Error('agent error'));

    mockTodosAll.mockResolvedValue([
      {
        id: 50,
        action_name: 'mentioned',
        target_type: 'Issue',
        target: { title: 'Bug', iid: 1 },
        target_url: 'https://gitlab.com/owner/repo/-/issues/1',
        body: 'fix this',
        state: 'pending',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        project: {
          name: 'repo',
          path_with_namespace: 'owner/repo',
        },
        author: { name: 'Alice', username: 'alice' },
      },
    ]);
    mockTodoDone.mockResolvedValue({});

    const channel = new GitlabChannel(
      'test',
      { ...baseConfig, pollInterval: 50 },
      bridge,
    );
    await channel.connect();
    await vi.waitFor(() => expect(mockTodosAll).toHaveBeenCalled(), {
      timeout: 2000,
    });
    channel.disconnect();

    expect(mockTodoDone).not.toHaveBeenCalled();
    const cursor = loadPollCursor('test', join(tempDir, 'channels'));
    expect(cursor.timestamp).toBe('');
  });

  it('force advances cursor after 3 consecutive handleInbound failures', async () => {
    const bridge = mockBridge();
    (bridge as Record<string, unknown>).prompt = vi
      .fn()
      .mockRejectedValue(new Error('agent error'));

    mockTodosAll.mockResolvedValue([
      {
        id: 50,
        action_name: 'mentioned',
        target_type: 'Issue',
        target: { title: 'Bug', iid: 1 },
        target_url: 'https://gitlab.com/owner/repo/-/issues/1',
        body: 'fix this',
        state: 'pending',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        project: {
          name: 'repo',
          path_with_namespace: 'owner/repo',
        },
        author: { name: 'Alice', username: 'alice' },
      },
    ]);
    mockTodoDone.mockResolvedValue({});

    const channel = new GitlabChannel(
      'test',
      { ...baseConfig, pollInterval: 50 },
      bridge,
    );
    await channel.connect();
    await vi.waitFor(() => expect(mockTodoDone).toHaveBeenCalled(), {
      timeout: 5000,
    });
    channel.disconnect();

    const cursor = loadPollCursor('test', join(tempDir, 'channels'));
    expect(cursor.timestamp).toBe('2026-01-01T00:00:00Z');
  });

  it('fetches all pages of todos', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      action_name: 'mentioned',
      target_type: 'Issue',
      target: { title: `Issue ${i}`, iid: i },
      target_url: `https://gitlab.com/owner/repo/-/issues/${i}`,
      body: '',
      state: 'pending',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      project: {
        name: 'repo',
        path_with_namespace: 'owner/repo',
      },
      author: { name: 'Alice', username: 'alice' },
    }));
    const page2 = [
      {
        id: 101,
        action_name: 'mentioned',
        target_type: 'Issue',
        target: { title: 'Last issue', iid: 100 },
        target_url: 'https://gitlab.com/owner/repo/-/issues/100',
        body: '',
        state: 'pending',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        project: {
          name: 'repo',
          path_with_namespace: 'owner/repo',
        },
        author: { name: 'Alice', username: 'alice' },
      },
    ];
    mockTodosAll.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    mockTodoDone.mockResolvedValue({});

    const bridge = mockBridge();
    const channel = new GitlabChannel('test', baseConfig, bridge);
    await channel.connect();
    await vi.waitFor(
      () => expect(mockTodoDone).toHaveBeenCalledWith({ todoId: 101 }),
      { timeout: 2000 },
    );
    channel.disconnect();

    expect(mockTodosAll).toHaveBeenCalledTimes(2);
    expect(mockTodosAll).toHaveBeenLastCalledWith({
      perPage: 100,
      page: 2,
    });
    expect(mockTodoDone).toHaveBeenCalledWith({ todoId: 101 });
  });

  it('sendMessage throws', () => {
    const channel = new GitlabChannel('test', baseConfig, mockBridge());
    expect(() => channel.sendMessage('owner/repo', 'hi')).toThrow(
      /sendThreadMessage/,
    );
  });

  it('asserts isMentioned for mentioned action', async () => {
    mockTodosAll.mockResolvedValueOnce([
      {
        id: 10,
        action_name: 'mentioned',
        target_type: 'Issue',
        target: { title: 'Fix bug', iid: 5 },
        target_url: 'https://gitlab.com/owner/repo/-/issues/5',
        body: 'Please fix',
        state: 'pending',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        project: {
          name: 'repo',
          path_with_namespace: 'owner/repo',
        },
        author: { name: 'Alice', username: 'alice' },
      },
    ]);
    mockTodoDone.mockResolvedValueOnce({});

    const channel = new GitlabChannel('test', baseConfig, mockBridge());
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

  it('asserts isMentioned for directly_addressed action', async () => {
    mockTodosAll.mockResolvedValueOnce([
      {
        id: 11,
        action_name: 'directly_addressed',
        target_type: 'Issue',
        target: { title: 'Fix bug', iid: 5 },
        target_url: 'https://gitlab.com/owner/repo/-/issues/5',
        body: 'Please fix',
        state: 'pending',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        project: {
          name: 'repo',
          path_with_namespace: 'owner/repo',
        },
        author: { name: 'Alice', username: 'alice' },
      },
    ]);
    mockTodoDone.mockResolvedValueOnce({});

    const channel = new GitlabChannel('test', baseConfig, mockBridge());
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

  it('continues polling after consecutive errors', async () => {
    mockTodosAll.mockRejectedValue(new Error('API down'));

    const channel = new GitlabChannel(
      'test',
      { ...baseConfig, pollInterval: 50 },
      mockBridge(),
    );
    await channel.connect();

    await vi.waitFor(
      () => expect(mockTodosAll.mock.calls.length).toBeGreaterThanOrEqual(3),
      { timeout: 10_000 },
    );

    channel.disconnect();
  }, 15_000);

  it('restores cursor from disk on construction', async () => {
    const cursorDir = join(tempDir, 'channels');
    savePollCursor('test', '2024-01-01T00:00:00Z', new Set(['1']), cursorDir);

    mockTodosAll.mockResolvedValue([
      {
        id: 1,
        action_name: 'mentioned',
        target_type: 'Issue',
        target: { title: 'Old todo', iid: 1 },
        target_url: 'https://gitlab.com/owner/repo/-/issues/1',
        body: '',
        state: 'pending',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        project: {
          name: 'repo',
          path_with_namespace: 'owner/repo',
        },
        author: { name: 'Alice', username: 'alice' },
      },
      {
        id: 2,
        action_name: 'mentioned',
        target_type: 'Issue',
        target: { title: 'New todo', iid: 2 },
        target_url: 'https://gitlab.com/owner/repo/-/issues/2',
        body: '',
        state: 'pending',
        created_at: '2024-06-01T00:00:00Z',
        updated_at: '2024-06-01T00:00:00Z',
        project: {
          name: 'repo',
          path_with_namespace: 'owner/repo',
        },
        author: { name: 'Alice', username: 'alice' },
      },
    ]);
    mockTodoDone.mockResolvedValue({});

    const bridge = mockBridge();
    const promptFn = vi.fn().mockResolvedValue(undefined);
    (bridge as Record<string, unknown>).prompt = promptFn;

    const channel = new GitlabChannel('test', baseConfig, bridge);
    await channel.connect();
    await vi.waitFor(
      () => expect(mockTodoDone).toHaveBeenCalledWith({ todoId: 2 }),
      { timeout: 2000 },
    );
    channel.disconnect();

    // id=1 should be skipped (already in cursor), only id=2 dispatched
    expect(mockTodoDone).toHaveBeenCalledWith({ todoId: 2 });
    expect(mockTodoDone).not.toHaveBeenCalledWith({ todoId: 1 });

    const cursor = loadPollCursor('test', cursorDir);
    expect(cursor.timestamp).toBe('2024-06-01T00:00:00Z');
  });
});
