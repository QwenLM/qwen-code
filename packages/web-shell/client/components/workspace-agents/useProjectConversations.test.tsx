// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const mockWorkspace = vi.hoisted(() => ({
  baseUrl: 'server-a',
  token: 'token-a' as string | undefined,
  capabilities: { features: ['agent_collaboration_v1'] },
}));
const createThreadsHttpApi = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => mockWorkspace,
}));
vi.mock('./threads-api', () => ({ createThreadsHttpApi }));

const { useProjectConversations } = await import('./useProjectConversations');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let latest: ReturnType<typeof useProjectConversations>;
const mounted: Array<{
  root: ReturnType<typeof createRoot>;
  node: HTMLElement;
}> = [];

function Probe() {
  latest = useProjectConversations(['/repo']);
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  for (const { root, node } of mounted) {
    act(() => root.unmount());
    node.remove();
  }
  mounted.length = 0;
  createThreadsHttpApi.mockReset();
  mockWorkspace.baseUrl = 'server-a';
  mockWorkspace.token = 'token-a';
  mockWorkspace.capabilities = { features: ['agent_collaboration_v1'] };
});

it('does not create an API or stream when the capability is absent', async () => {
  mockWorkspace.capabilities = { features: [] };
  const node = document.createElement('div');
  const root = createRoot(node);
  mounted.push({ root, node });

  act(() => root.render(<Probe />));
  await flush();

  expect(latest).toEqual({ sessions: [], error: undefined });
  expect(createThreadsHttpApi).not.toHaveBeenCalled();
});

it('does not reuse conversations across daemon credentials', async () => {
  createThreadsHttpApi.mockImplementation((baseUrl: string, token: string) => ({
    listThreads:
      baseUrl === 'server-a' && token === 'token-a'
        ? vi.fn().mockResolvedValue({
            threads: [
              {
                id: 'thread-a',
                title: 'Server A thread',
                parentThreadId: null,
                updatedAt: 1,
                liveRunCount: 0,
              },
            ],
          })
        : vi.fn().mockRejectedValue(new Error('unavailable')),
    subscribe: vi.fn(() => () => {}),
  }));
  const node = document.createElement('div');
  const root = createRoot(node);
  mounted.push({ root, node });

  act(() => root.render(<Probe />));
  await flush();
  expect(latest.sessions.map((session) => session.displayName)).toEqual([
    'Server A thread',
  ]);

  mockWorkspace.baseUrl = 'server-b';
  mockWorkspace.token = 'token-b';
  act(() => root.render(<Probe />));
  await flush();

  expect(latest.sessions).toEqual([]);
  expect(latest.error).toBe('repo');
});

it('leaves a workspace with collaboration off alone', async () => {
  const subscribe = vi.fn(() => () => {});
  createThreadsHttpApi.mockImplementation(() => ({
    listThreads: vi
      .fn()
      .mockRejectedValue(new Error('agent_collaboration_disabled')),
    subscribe,
  }));
  const node = document.createElement('div');
  const root = createRoot(node);
  mounted.push({ root, node });

  act(() => root.render(<Probe />));
  await flush();

  expect(latest.sessions).toEqual([]);
  expect(latest.error).toBeUndefined();
  expect(subscribe).not.toHaveBeenCalled();
});
