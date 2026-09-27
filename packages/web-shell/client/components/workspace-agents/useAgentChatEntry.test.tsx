// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const createThreadsHttpApi = vi.hoisted(() => vi.fn());
vi.mock('./ThreadsRoute', () => ({ createThreadsHttpApi }));

const { useAgentChatEntry } = await import('./useAgentChatEntry');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let latestSubmit: ReturnType<typeof useAgentChatEntry>['submit'];
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
}: {
  baseUrl: string;
  getContext: () => string;
}) {
  latestSubmit = useAgentChatEntry({
    enabled: true,
    cwd: '/repo',
    baseUrl,
    onSubmit: vi.fn(),
    onOpen: vi.fn(),
    onError: vi.fn(),
    getContext,
    t: ((key: string) => key) as never,
  }).submit;
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
    expect(latestSubmit('@lead investigate')).toBe(false);
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
