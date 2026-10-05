// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionAgentsApi } from './session-agents-api';

const createThreadsHttpApi = vi.hoisted(() => vi.fn());
vi.mock('./threads-api', () => ({ createThreadsHttpApi }));

const { mentionTokens, resolveMentionedAgents, useAgentChatEntry } =
  await import('./useAgentChatEntry');

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
}: {
  enabled?: boolean;
  onSubmit: (...args: unknown[]) => boolean | void;
  onError: (message: string) => void;
  ensureSession: () => Promise<string | undefined>;
  api?: SessionAgentsApi;
}) {
  latestEntry = useAgentChatEntry({
    enabled,
    cwd: '/repo',
    baseUrl: 'http://daemon',
    sessionApi: api,
    ensureSession,
    onSubmit: onSubmit as never,
    onError,
    t: ((key: string) => key) as never,
  });
  return null;
}

function mount(props: Parameters<typeof Probe>[0]) {
  const node = document.createElement('div');
  const root = createRoot(node);
  mounted.push({ root, node });
  act(() => root.render(<Probe {...props} />));
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
