// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionAgentsApi } from './session-agents-api';

const createThreadsHttpApi = vi.hoisted(() => vi.fn());
vi.mock('./threads-api', () => ({ createThreadsHttpApi }));

const {
  isPendingMentionRecorded,
  mentionTokens,
  recordedAgentMentionTexts,
  resolveMentionedAgents,
  resolveMentionedSquads,
  SQUAD_PICKER_ICON,
  useAgentChatEntry,
} = await import('./useAgentChatEntry');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let latestEntry: ReturnType<typeof useAgentChatEntry>;
const mounted: Array<{
  root: ReturnType<typeof createRoot>;
  node: HTMLElement;
}> = [];

const agent = (name: string, over: Record<string, unknown> = {}) =>
  ({
    id: `id-${name}`,
    name,
    enabled: true,
    retiredAt: null,
    status: 'idle',
    ...over,
  }) as never;

function sessionApi(): SessionAgentsApi & {
  mention: ReturnType<typeof vi.fn>;
} {
  return {
    listRuns: vi.fn(),
    mention: vi.fn().mockResolvedValue({ recordId: 'r1', runs: [] }),
    cancelRun: vi.fn(),
    retryRun: vi.fn(),
    stopAll: vi.fn(),
    respondToPermission: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  };
}

function Probe({
  enabled = true,
  onSubmit,
  onError,
  ensureSession,
  api,
  sessionApiFor,
  sessionId,
  recordedMentionTexts,
}: {
  enabled?: boolean;
  onSubmit: (...args: unknown[]) => boolean | void;
  onError: (message: string) => void;
  ensureSession: () => Promise<
    { sessionId: string; workspaceCwd?: string } | string | undefined
  >;
  api?: SessionAgentsApi;
  sessionApiFor?: (workspaceCwd: string) => SessionAgentsApi;
  sessionId?: string;
  recordedMentionTexts?: readonly string[];
}) {
  latestEntry = useAgentChatEntry({
    enabled,
    cwd: '/repo',
    baseUrl: 'http://daemon',
    sessionApi: api,
    sessionApiFor,
    ensureSession,
    onSubmit: onSubmit as never,
    onError,
    sessionId,
    recordedMentionTexts,
    t: ((key: string) => key) as never,
  });
  return null;
}

function mount(props: Parameters<typeof Probe>[0]) {
  const node = document.createElement('div');
  const root = createRoot(node);
  mounted.push({ root, node });
  act(() => root.render(<Probe {...props} />));
  return (next: Parameters<typeof Probe>[0]) =>
    act(() => root.render(<Probe {...next} />));
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

afterEach(() => {
  for (const { root, node } of mounted) {
    act(() => root.unmount());
    node.remove();
  }
  mounted.length = 0;
  createThreadsHttpApi.mockReset();
});

describe('mention parsing', () => {
  it('follows core: no word character before @, no path after', () => {
    expect(
      mentionTokens('请@迁移助手 看一下, mail a@b.dev, @Lead/x, @Rev'),
    ).toEqual(['迁移助手', 'rev']);
  });

  it('resolves the longest name a token starts with, and skips paused agents', () => {
    const agents = [
      agent('mar'),
      agent('迁移助手'),
      agent('alice'),
      agent('paused', { enabled: false }),
    ];
    expect(
      resolveMentionedAgents(
        mentionTokens('@maría @迁移助手看一下 @alice @paused @alice'),
        agents,
      ).map((entry) => (entry as { name: string }).name),
    ).toEqual(['迁移助手', 'alice']);
  });
});

it('is inert and delegates ordinary chat when collaboration is disabled', () => {
  const onSubmit = vi.fn(() => true);
  mount({
    enabled: false,
    onSubmit,
    onError: vi.fn(),
    ensureSession: vi.fn(),
    api: sessionApi(),
  });

  expect(latestEntry.providers).toEqual([]);
  expect(latestEntry.pending).toBe(false);
  expect(latestEntry.submit('@alice keep this as ordinary chat')).toBe(true);
  expect(createThreadsHttpApi).not.toHaveBeenCalled();
  expect(onSubmit).toHaveBeenCalledWith(
    '@alice keep this as ordinary chat',
    undefined,
    undefined,
    undefined,
    undefined,
  );
});

it('posts a resolvable @-mention to the current session, with no thread and no local echo', async () => {
  createThreadsHttpApi.mockReturnValue({
    listAgents: vi.fn().mockResolvedValue({ agents: [agent('reviewer')] }),
  });
  const api = sessionApi();
  const onSubmit = vi.fn();
  const onError = vi.fn();
  const ensureSession = vi.fn().mockResolvedValue('session-1');
  const commit = vi.fn();
  mount({ onSubmit, onError, ensureSession, api });
  await settle();

  act(() => {
    expect(
      latestEntry.submit('@reviewer check this', [], [], commit, undefined),
    ).toBe(false);
  });
  await settle();

  expect(ensureSession).toHaveBeenCalledTimes(1);
  expect(api.mention).toHaveBeenCalledWith('session-1', {
    text: '@reviewer check this',
    clientMessageId: expect.stringMatching(/^[A-Za-z0-9_.:-]{1,128}$/),
  });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(latestEntry.pending).toBe(false);
});

describe('a deferred @-mention', () => {
  const mentionBlock = (text: string, kind = 'agent_mention') =>
    ({
      kind: 'user',
      id: `block-${text}`,
      text,
      meta: { qwenAgentMessage: { kind, mentionedAgentIds: [] } },
    }) as never;

  it('reads recorded mentions from the transcript, and counts repeats', () => {
    const texts = recordedAgentMentionTexts([
      mentionBlock('@reviewer hi'),
      { kind: 'user', id: 'plain', text: '@reviewer hi' } as never,
      mentionBlock('@reviewer hi'),
    ]);
    expect(texts).toEqual(['@reviewer hi', '@reviewer hi']);
    const pending = {
      id: 'm1',
      sessionId: 's1',
      text: '@reviewer hi',
      recordedBefore: 2,
    };
    expect(isPendingMentionRecorded(pending, texts)).toBe(false);
    expect(isPendingMentionRecorded(pending, [...texts, '@reviewer hi '])).toBe(
      true,
    );
  });

  it('is shown as pending until its record lands', async () => {
    createThreadsHttpApi.mockReturnValue({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent('reviewer')] }),
    });
    const api = sessionApi();
    api.mention.mockResolvedValue({ recordId: '', deferred: true, runs: [] });
    const props = {
      onSubmit: vi.fn(),
      onError: vi.fn(),
      ensureSession: vi.fn().mockResolvedValue('session-1'),
      api,
      sessionId: 'session-1',
      // The same text was mentioned before: that record must not settle it.
      recordedMentionTexts: ['@reviewer hi'],
    };
    const rerender = mount(props);
    await settle();
    expect(latestEntry.pendingMentions).toEqual([]);

    act(() => {
      latestEntry.submit('@reviewer hi');
    });
    await settle();
    expect(latestEntry.pendingMentions).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        text: '@reviewer hi',
        id: api.mention.mock.calls[0][1].clientMessageId,
      }),
    ]);

    // Another session shows none of it.
    rerender({ ...props, sessionId: 'session-2', recordedMentionTexts: [] });
    expect(latestEntry.pendingMentions).toEqual([]);

    rerender({ ...props, recordedMentionTexts: ['@reviewer hi'] });
    expect(latestEntry.pendingMentions).toHaveLength(1);
    rerender({
      ...props,
      recordedMentionTexts: ['@reviewer hi', '@reviewer hi'],
    });
    expect(latestEntry.pendingMentions).toEqual([]);
  });

  it('is not echoed when the record was written at once', async () => {
    createThreadsHttpApi.mockReturnValue({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent('reviewer')] }),
    });
    mount({
      onSubmit: vi.fn(),
      onError: vi.fn(),
      ensureSession: vi.fn().mockResolvedValue('session-1'),
      api: sessionApi(),
      sessionId: 'session-1',
    });
    await settle();
    act(() => {
      latestEntry.submit('@reviewer hi');
    });
    await settle();
    expect(latestEntry.pendingMentions).toEqual([]);
  });
});

it('creates the session first in a new chat', async () => {
  createThreadsHttpApi.mockReturnValue({
    listAgents: vi.fn().mockResolvedValue({ agents: [agent('reviewer')] }),
  });
  const api = sessionApi();
  let created: string | undefined;
  const ensureSession = vi.fn(async () => {
    created = 'new-session';
    return created;
  });
  mount({ onSubmit: vi.fn(), onError: vi.fn(), ensureSession, api });
  await settle();

  act(() => {
    latestEntry.submit('@reviewer hi');
  });
  await settle();

  expect(created).toBe('new-session');
  expect(api.mention).toHaveBeenCalledWith(
    'new-session',
    expect.objectContaining({ text: '@reviewer hi' }),
  );
});

it("posts to the new session's own workspace when the picker chose another one", async () => {
  createThreadsHttpApi.mockReturnValue({
    listAgents: vi.fn().mockResolvedValue({ agents: [agent('reviewer')] }),
  });
  const api = sessionApi();
  const other = sessionApi();
  const sessionApiFor = vi.fn(() => other);
  const commit = vi.fn();
  mount({
    onSubmit: vi.fn(),
    onError: vi.fn(),
    ensureSession: vi
      .fn()
      .mockResolvedValue({ sessionId: 'new-session', workspaceCwd: '/other' }),
    api,
    sessionApiFor,
  });
  await settle();

  act(() => {
    latestEntry.submit('@reviewer hi', undefined, undefined, commit);
  });
  await settle();

  expect(sessionApiFor).toHaveBeenCalledWith('/other');
  expect(other.mention).toHaveBeenCalledWith(
    'new-session',
    expect.objectContaining({ text: '@reviewer hi' }),
  );
  expect(api.mention).not.toHaveBeenCalled();
  expect(commit).toHaveBeenCalledTimes(1);
});

it("keeps the hook's routes when the session lives in the same workspace", async () => {
  createThreadsHttpApi.mockReturnValue({
    listAgents: vi.fn().mockResolvedValue({ agents: [agent('reviewer')] }),
  });
  const api = sessionApi();
  const sessionApiFor = vi.fn(() => sessionApi());
  mount({
    onSubmit: vi.fn(),
    onError: vi.fn(),
    ensureSession: vi
      .fn()
      .mockResolvedValue({ sessionId: 'session-1', workspaceCwd: '/repo' }),
    api,
    sessionApiFor,
  });
  await settle();

  act(() => {
    latestEntry.submit('@reviewer hi');
  });
  await settle();

  expect(sessionApiFor).not.toHaveBeenCalled();
  expect(api.mention).toHaveBeenCalledWith(
    'session-1',
    expect.objectContaining({ text: '@reviewer hi' }),
  );
});

it('sends a message whose @ names no agent as an ordinary prompt', async () => {
  createThreadsHttpApi.mockReturnValue({
    listAgents: vi.fn().mockResolvedValue({ agents: [agent('reviewer')] }),
  });
  const api = sessionApi();
  const onSubmit = vi.fn(() => true);
  const commit = vi.fn();
  const ensureSession = vi.fn();
  mount({ onSubmit, onError: vi.fn(), ensureSession, api });
  await settle();

  act(() => {
    latestEntry.submit('@someone else', undefined, undefined, commit);
  });
  await settle();

  expect(onSubmit).toHaveBeenCalledWith(
    '@someone else',
    undefined,
    undefined,
    expect.any(Function),
    undefined,
  );
  expect(commit).toHaveBeenCalledTimes(1);
  expect(api.mention).not.toHaveBeenCalled();
  expect(ensureSession).not.toHaveBeenCalled();
});

it('refuses attachments on an @-mention and keeps the draft', async () => {
  createThreadsHttpApi.mockReturnValue({
    listAgents: vi.fn().mockResolvedValue({ agents: [agent('reviewer')] }),
  });
  const api = sessionApi();
  const onError = vi.fn();
  const commit = vi.fn();
  mount({ onSubmit: vi.fn(), onError, ensureSession: vi.fn(), api });
  await settle();

  act(() => {
    latestEntry.submit(
      '@reviewer look at this',
      [{ data: 'x', mimeType: 'image/png' }] as never,
      undefined,
      commit,
    );
  });
  await settle();

  expect(onError).toHaveBeenCalledWith('collab.mention.noAttachments');
  expect(api.mention).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
});

it('reports a rejected mention through onError and keeps the draft', async () => {
  createThreadsHttpApi.mockReturnValue({
    listAgents: vi.fn().mockResolvedValue({ agents: [agent('reviewer')] }),
  });
  const api = sessionApi();
  api.mention.mockRejectedValue(
    new Error('The message does not @-mention any available agent.'),
  );
  const onError = vi.fn();
  const commit = vi.fn();
  mount({
    onSubmit: vi.fn(),
    onError,
    ensureSession: vi.fn().mockResolvedValue('session-1'),
    api,
  });
  await settle();

  act(() => {
    latestEntry.submit('@reviewer go', undefined, undefined, commit);
  });
  await settle();

  expect(onError).toHaveBeenCalledWith(
    'The message does not @-mention any available agent.',
  );
  expect(commit).not.toHaveBeenCalled();
  expect(latestEntry.pending).toBe(false);
});

it('retries a failed mention with the same clientMessageId', async () => {
  createThreadsHttpApi.mockReturnValue({
    listAgents: vi.fn().mockResolvedValue({ agents: [agent('reviewer')] }),
  });
  const api = sessionApi();
  api.mention.mockRejectedValueOnce(new Error('502 Bad Gateway'));
  mount({
    onSubmit: vi.fn(),
    onError: vi.fn(),
    ensureSession: vi.fn().mockResolvedValue('session-1'),
    api,
  });
  await settle();

  act(() => {
    latestEntry.submit('@reviewer go', undefined, undefined, vi.fn());
  });
  await settle();
  act(() => {
    latestEntry.submit('@reviewer go', undefined, undefined, vi.fn());
  });
  await settle();
  act(() => {
    latestEntry.submit('@reviewer next', undefined, undefined, vi.fn());
  });
  await settle();

  const ids = api.mention.mock.calls.map(
    (call: unknown[]) =>
      (call[1] as { clientMessageId: string }).clientMessageId,
  );
  expect(ids).toHaveLength(3);
  // The retry replays the post whose outcome was unknown...
  expect(ids[1]).toBe(ids[0]);
  // ...and a different message after a success gets its own id.
  expect(ids[2]).not.toBe(ids[1]);
});

describe('squads', () => {
  const squad = (name: string, over: Record<string, unknown> = {}) =>
    ({
      id: `sq-${name}`,
      name,
      leaderAgentId: 'id-lead',
      leaderName: 'lead',
      members: [
        { agentId: 'id-a', name: 'alice' },
        { agentId: 'id-b', name: 'bob' },
      ],
      createdAt: 1,
      updatedAt: 1,
      ...over,
    }) as never;

  it('resolves only squads that can take work', () => {
    const squads = [
      squad('crew'),
      squad('old', { retiredAt: 2 }),
      squad('headless', { leaderIssue: 'retired' }),
    ];
    expect(
      resolveMentionedSquads(
        mentionTokens('@crew @old @headless @crewmate'),
        squads,
      ).map((entry) => (entry as { name: string }).name),
    ).toEqual(['crew']);
  });

  it('lists squads in the picker with their own icon, leader and member count', async () => {
    createThreadsHttpApi.mockReturnValue({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent('alice')] }),
      listSquads: vi.fn().mockResolvedValue({
        squads: [squad('crew'), squad('old', { retiredAt: 2 })],
      }),
    });
    mount({
      onSubmit: vi.fn(),
      onError: vi.fn(),
      ensureSession: vi.fn(),
      api: sessionApi(),
    });
    await settle();

    const provider = latestEntry.providers[0]!;
    // The typed query claims a squad name before any search.
    expect(provider.claimsTypedQuery?.('cr')).toBe(true);
    const items = await provider.search({
      query: '',
      signal: new AbortController().signal,
    });
    const alice = items.find((item) => item.label === 'alice')!;
    const crew = items.find((item) => item.label === 'crew')!;
    expect(alice.icon).toBeUndefined();
    expect(crew).toMatchObject({
      id: 'squad:sq-crew',
      icon: SQUAD_PICKER_ICON,
      iconMode: 'mask',
      subtitle: 'collab.squad.summary',
      description: 'collab.mention.squad',
      insertText: '@crew ',
    });
    expect(SQUAD_PICKER_ICON).toMatch(/^data:image\/png;base64,/);
    expect(items.some((item) => item.label === 'old')).toBe(false);
  });

  it('posts a message that addresses only a squad to the agents route', async () => {
    createThreadsHttpApi.mockReturnValue({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent('alice')] }),
      listSquads: vi.fn().mockResolvedValue({ squads: [squad('crew')] }),
    });
    const api = sessionApi();
    const onSubmit = vi.fn();
    mount({
      onSubmit,
      onError: vi.fn(),
      ensureSession: vi.fn().mockResolvedValue('session-1'),
      api,
    });
    await settle();

    act(() => {
      latestEntry.submit('@crew fix the build');
    });
    await settle();

    expect(api.mention).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ text: '@crew fix the build' }),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('reports a squad the daemon could not start beside agents it did', async () => {
    createThreadsHttpApi.mockReturnValue({
      listAgents: vi.fn().mockResolvedValue({ agents: [agent('alice')] }),
      listSquads: vi.fn().mockResolvedValue({ squads: [squad('crew')] }),
    });
    const api = sessionApi();
    api.mention.mockResolvedValue({
      recordId: 'r1',
      runs: [],
      squadError: 'Squad @crew was not started: its leader is paused.',
    });
    const onError = vi.fn();
    const commit = vi.fn();
    mount({
      onSubmit: vi.fn(),
      onError,
      ensureSession: vi.fn().mockResolvedValue('session-1'),
      api,
    });
    await settle();

    act(() => {
      latestEntry.submit('@crew and @alice go', [], [], commit);
    });
    await settle();

    expect(commit).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      'Squad @crew was not started: its leader is paused.',
    );
  });
});
