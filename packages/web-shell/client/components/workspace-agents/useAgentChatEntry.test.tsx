// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const createThreadsHttpApi = vi.hoisted(() => vi.fn());
vi.mock('./threads-api', () => ({ createThreadsHttpApi }));

const { useAgentChatEntry } = await import('./useAgentChatEntry');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let latestEntry: ReturnType<typeof useAgentChatEntry>;
const mounted: Array<{
  root: ReturnType<typeof createRoot>;
  node: HTMLElement;
}> = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function Probe({
  baseUrl,
  getContext,
  onSubmit = vi.fn(),
  enabled = true,
}: {
  baseUrl: string;
  getContext: () => string;
  onSubmit?: () => void;
  enabled?: boolean;
}) {
  latestEntry = useAgentChatEntry({
    enabled,
    cwd: '/repo',
    baseUrl,
    onSubmit,
    onOpen: vi.fn(),
    onError: vi.fn(),
    getContext,
    t: ((key: string) => key) as never,
  });
  return null;
}

afterEach(() => {
  for (const { root, node } of mounted) {
    act(() => root.unmount());
    node.remove();
  }
  mounted.length = 0;
  createThreadsHttpApi.mockReset();
});

it('is inert and delegates ordinary chat when collaboration is disabled', () => {
  const onSubmit = vi.fn(() => true);
  const node = document.createElement('div');
  const root = createRoot(node);
  mounted.push({ root, node });

  act(() =>
    root.render(
      <Probe
        baseUrl="server-a"
        enabled={false}
        getContext={() => 'existing conversation'}
        onSubmit={onSubmit}
      />,
    ),
  );

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

it('does not submit captured mentions after the workspace API changes', async () => {
  const roster = deferred<{
    agents: Array<{
      id: string;
      name: string;
      enabled: boolean;
      retiredAt: null;
    }>;
  }>();
  const oldApi = {
    listAgents: vi.fn(() => roster.promise),
    createThread: vi.fn(),
  };
  const newApi = {
    listAgents: vi.fn().mockResolvedValue({ agents: [] }),
    createThread: vi.fn(),
  };
  createThreadsHttpApi.mockImplementation((baseUrl: string) =>
    baseUrl === 'old' ? oldApi : newApi,
  );
  const oldContext = vi.fn(() => 'old context');
  const newContext = vi.fn(() => 'new context');
  const node = document.createElement('div');
  const root = createRoot(node);
  mounted.push({ root, node });

  act(() => root.render(<Probe baseUrl="old" getContext={oldContext} />));
  act(() => {
    expect(latestEntry.submit('@lead investigate')).toBe(false);
  });
  expect(oldContext).toHaveBeenCalledOnce();

  act(() => root.render(<Probe baseUrl="new" getContext={newContext} />));
  await act(async () => {
    roster.resolve({
      agents: [{ id: 'lead', name: 'lead', enabled: true, retiredAt: null }],
    });
    await roster.promise;
  });

  expect(oldApi.createThread).not.toHaveBeenCalled();
  expect(newApi.createThread).not.toHaveBeenCalled();
  expect(newContext).not.toHaveBeenCalled();
});

it('sends an @ message as ordinary chat when the roster cannot be read', async () => {
  const api = {
    listAgents: vi
      .fn()
      .mockRejectedValue(new Error('agent_collaboration_disabled')),
    createThread: vi.fn(),
  };
  createThreadsHttpApi.mockReturnValue(api);
  const onSubmit = vi.fn();
  const node = document.createElement('div');
  const root = createRoot(node);
  mounted.push({ root, node });

  act(() =>
    root.render(
      <Probe baseUrl="x" getContext={() => ''} onSubmit={onSubmit} />,
    ),
  );
  await act(async () => {
    expect(latestEntry.submit('see @README.md')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(api.createThread).not.toHaveBeenCalled();
  expect(onSubmit).toHaveBeenCalledWith(
    'see @README.md',
    undefined,
    undefined,
    expect.any(Function),
    undefined,
  );
});

it('does not read a longer Latin word as a shorter agent name', async () => {
  const api = {
    listAgents: vi.fn().mockResolvedValue({
      agents: [{ id: 'mar', name: 'mar', enabled: true, retiredAt: null }],
    }),
    createThread: vi.fn().mockResolvedValue({ id: 'thread-1' }),
  };
  createThreadsHttpApi.mockReturnValue(api);
  const onSubmit = vi.fn(() => true);
  const node = document.createElement('div');
  const root = createRoot(node);
  mounted.push({ root, node });

  act(() =>
    root.render(
      <Probe baseUrl="x" getContext={() => ''} onSubmit={onSubmit} />,
    ),
  );

  // Core's `agentForToken` refuses this token, and the server-side parser is
  // authoritative, so intercepting it here would silently turn an ordinary
  // chat message into work assigned to an agent nobody addressed.
  await act(async () => {
    expect(latestEntry.submit('ask @maría to review')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(api.createThread).not.toHaveBeenCalled();
  expect(onSubmit).toHaveBeenCalledWith(
    'ask @maría to review',
    undefined,
    undefined,
    expect.any(Function),
    undefined,
  );

  // Control: the exact name still leads, so the guard above is not refusing
  // every mention.
  await act(async () => {
    expect(latestEntry.submit('@mar take a look')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(api.createThread).toHaveBeenCalledWith(
    expect.objectContaining({ assignee: 'mar' }),
  );
});

it('matches an agent whose lowercase name has a different length', async () => {
  const api = {
    listAgents: vi.fn().mockResolvedValue({
      agents: [
        { id: 'reviewer', name: 'İnceleyici', enabled: true, retiredAt: null },
      ],
    }),
    createThread: vi.fn().mockResolvedValue({ id: 'thread-1' }),
  };
  createThreadsHttpApi.mockReturnValue(api);
  const node = document.createElement('div');
  const root = createRoot(node);
  mounted.push({ root, node });

  act(() => root.render(<Probe baseUrl="x" getContext={() => ''} />));
  await act(async () => {
    expect(latestEntry.submit('@İnceleyici review this')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(api.createThread).toHaveBeenCalledWith(
    expect.objectContaining({ assignee: 'İnceleyici' }),
  );
});
