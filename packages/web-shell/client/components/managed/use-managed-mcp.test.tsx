// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider, type WebShellLanguage } from '../../i18n';
import type {
  ManagedAgentProvider,
  ManagedSessionMcp,
} from './managed-agent-provider';
import { useManagedMcp } from './use-managed-mcp';

let root: Root;
let provider: ManagedAgentProvider;
let sessionId: string | undefined;
let clientId: string;
let language: WebShellLanguage;
let current: ReturnType<typeof useManagedMcp>;
const catalog = (id = 'session-a'): ManagedSessionMcp => ({
  object: 'agent.mcp_catalog',
  session_id: id,
  servers: [
    {
      server_id: 'docs',
      server_revision: 1,
      catalog_revision: 2,
      tools: [{ name: 'search', input_schema: {} }],
      resources: [{ name: 'guide', uri: 'docs://guide' }],
      prompts: [],
      discovery: { tools: 'partial', resources: 'failed', prompts: 'stale' },
    },
  ],
});

function Probe() {
  current = useManagedMcp(provider, clientId, sessionId);
  return null;
}
const render = () =>
  act(async () =>
    root.render(
      <StrictMode>
        <I18nProvider language={language}>
          <Probe />
        </I18nProvider>
      </StrictMode>,
    ),
  );

beforeEach(() => {
  root = createRoot(document.createElement('div'));
  sessionId = 'session-a';
  clientId = 'client';
  language = 'en';
  provider = {
    storageKey: 'tenant:actor',
    mcp: { list: vi.fn().mockResolvedValue(catalog()) },
  } as unknown as ManagedAgentProvider;
});
afterEach(async () => {
  await act(async () => root.unmount());
});

it('loads only on demand and preserves all discovery states without claiming connection health', async () => {
  await render();
  expect(provider.mcp!.list).not.toHaveBeenCalled();
  const result = await current!.loadMcpStatus!();
  expect(result.servers).toEqual([
    {
      kind: 'mcp_server',
      name: 'docs',
      disabled: false,
      resourceCount: 1,
      description:
        'Catalog snapshot: 1 tool (partial); 1 resource (failed); 0 prompts (stale)',
    },
  ]);
  expect(current!.loadMcpResources).toBeUndefined();
  expect(provider.mcp!.list).toHaveBeenCalledWith(
    'session-a',
    expect.objectContaining({
      clientId: 'client',
      signal: expect.any(AbortSignal),
    }),
  );
  language = 'zh-CN';
  await render();
  expect((await current!.loadMcpStatus!()).servers[0].description).toContain(
    '目录快照：1 个工具（部分完成）；1 个资源（失败）；0 个提示（已过期）',
  );
});

it('keeps failures distinct from empty catalogs and permits another query', async () => {
  vi.mocked(provider.mcp!.list)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ ...catalog(), servers: [] });
  await render();
  await expect(current!.loadMcpStatus!()).rejects.toThrow('offline');
  await expect(current!.loadMcpStatus!()).resolves.toEqual({ servers: [] });
});

it.each(['session', 'provider', 'client', 'unmount'] as const)(
  'aborts requests and rejects late results on %s changes',
  async (change) => {
    let release!: (value: ManagedSessionMcp) => void;
    vi.mocked(provider.mcp!.list).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await render();
    const old = current!;
    const pending = old.loadMcpStatus!().catch((error: unknown) => error);
    const signal = vi.mocked(provider.mcp!.list).mock.calls[0][1].signal!;
    if (change === 'session') sessionId = 'session-b';
    if (change === 'provider') provider = { ...provider };
    if (change === 'client') clientId = 'new-client';
    if (change === 'unmount') await act(async () => root.render(null));
    else await render();
    expect(signal.aborted).toBe(true);
    if (change !== 'unmount') expect(current!.scopeKey).not.toBe(old.scopeKey);
    release(catalog());
    expect(await pending).toMatchObject({ name: 'AbortError' });
    await expect(old.loadMcpStatus!()).rejects.toThrow('MCP Session changed');
  },
);

it('rejects a catalog for a different Session and disables actions without a selected Session or provider capability', async () => {
  vi.mocked(provider.mcp!.list).mockResolvedValue(catalog('session-b'));
  await render();
  await expect(current!.loadMcpStatus!()).rejects.toThrow('identity mismatch');
  sessionId = undefined;
  await render();
  expect(current).toBeUndefined();
  sessionId = 'session-a';
  provider = { ...provider, mcp: undefined };
  await render();
  expect(current).toBeUndefined();
});
