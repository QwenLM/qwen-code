// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider, type WebShellLanguage } from '../../i18n';
import { WebShellPortalRootContext } from '../../portalRoot';
import type { ManagedAgentProvider } from './managed-agent-provider';
import type { ManagedMcpManagementSnapshot } from './managed-mcp-management-types';
import { ManagedMcpManagerPage } from './ManagedMcpManagerPage';

let root: Root;
let container: HTMLDivElement;
let provider: ManagedAgentProvider;
let snapshot: ManagedMcpManagementSnapshot;
const pin = {
  serverId: 'docs',
  serverRevision: 1,
  definitionDigest: 'a'.repeat(64),
};
const nextPin = { ...pin, serverRevision: 2, definitionDigest: 'b'.repeat(64) };
const render = (
  language: WebShellLanguage = 'en',
  sessionId: string | null = 'session-a',
) =>
  act(async () =>
    root.render(
      <I18nProvider language={language}>
        <WebShellPortalRootContext.Provider value={container}>
          <ManagedMcpManagerPage
            provider={provider}
            sessionId={sessionId ?? undefined}
            workspaceId="workspace"
          />
        </WebShellPortalRootContext.Provider>
      </I18nProvider>,
    ),
  );
async function click(label: string) {
  const button = [
    ...container.querySelectorAll<HTMLButtonElement>('button'),
  ].find((entry) => entry.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  snapshot = {
    sessionId: 'session-a',
    revision: 0,
    supported: true,
    servers: [],
    availableServers: [
      { ...pin, transport: 'stdio' },
      { ...nextPin, transport: 'stdio' },
    ],
  };
  provider = {
    storageKey: 'tenant:actor',
    mcpManagement: {
      query: vi.fn().mockImplementation(async () => snapshot),
      submit: vi.fn().mockImplementation(async (_session, command) => {
        const chosen = command.server ?? snapshot.servers[0];
        snapshot = {
          ...snapshot,
          revision: snapshot.revision + 1,
          servers: [
            {
              serverId: chosen.serverId,
              serverRevision: chosen.serverRevision,
              definitionDigest: chosen.definitionDigest,
              state:
                command.action === 'remove'
                  ? 'removed'
                  : command.action === 'disable'
                    ? 'disabled'
                    : command.action === 'enable' || command.action === 'add'
                      ? 'enabled'
                      : (snapshot.servers[0]?.state ?? 'enabled'),
            },
          ],
          operation: {
            operationId: `op-${snapshot.revision + 1}`,
            action: command.action,
            serverId: command.serverId,
            revision: snapshot.revision + 1,
            state: 'settled',
          },
        };
        return { ...snapshot, availableServers: [] };
      }),
      operation: vi.fn(),
    },
    mcp: {
      list: vi.fn().mockResolvedValue({
        object: 'agent.mcp_catalog',
        session_id: 'session-a',
        servers: [
          {
            server_id: 'docs',
            server_revision: 1,
            catalog_revision: 1,
            tools: [
              {
                name: 'search',
                description: 'Search docs',
                input_schema: { type: 'object' },
              },
            ],
            resources: [
              { name: 'Guide', uri: 'docs://guide', mime_type: 'text/plain' },
            ],
            prompts: [
              {
                name: 'summarize',
                arguments: [{ name: 'topic', required: true }],
              },
            ],
            discovery: {
              tools: 'complete',
              resources: 'complete',
              prompts: 'complete',
            },
          },
        ],
      }),
    },
  } as unknown as ManagedAgentProvider;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('manages all seven actions in one Session using published pins, with shared metadata details', async () => {
  await render();
  await click('Add server');
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.querySelector('textarea')).toBeNull();
  await click('Apply');
  const card = container.querySelector<HTMLElement>(
    '[role="button"][aria-label="docs"]',
  );
  expect(card).not.toBeNull();
  await act(async () => card!.click());
  expect(container.textContent).toContain('Configured');
  expect(container.textContent).toContain('Search docs');
  expect(container.textContent).toContain('docs://guide');
  expect(container.textContent).toContain('/summarize');
  expect(container.textContent).not.toContain('Connected');
  expect(container.textContent).not.toContain(
    'Warning: This tool cannot be called by the LLM',
  );
  await click('Disable');
  expect(container.textContent).toContain('Drained');
  await click('Enable');
  await click('Reload');
  await click('Restart');
  await click('Change definition');
  const selector = container.querySelector<HTMLElement>(
    '#managed-mcp-definition',
  );
  expect(selector).not.toBeNull();
  await act(async () => selector!.click());
  const option = [
    ...container.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((entry) => entry.textContent?.includes('v2'));
  expect(option).toBeDefined();
  await act(async () => option!.click());
  await click('Apply');
  expect(container.textContent).toContain(nextPin.definitionDigest);
  await click('Remove');
  const calls = vi.mocked(provider.mcpManagement!.submit).mock.calls;
  expect(
    calls.map(([id, command]) => [
      id,
      command.action,
      command.expectedRevision,
    ]),
  ).toEqual([
    ['session-a', 'add', 0],
    ['session-a', 'disable', 1],
    ['session-a', 'enable', 2],
    ['session-a', 'reload', 3],
    ['session-a', 'restart', 4],
    ['session-a', 'edit', 5],
    ['session-a', 'remove', 6],
  ]);
  expect(calls[0][1].server).toEqual(pin);
  expect(calls[5][1].server).toEqual(nextPin);
  expect(
    new Set(calls.map(([, , options]) => options.idempotencyKey)).size,
  ).toBe(7);
  expect(container.textContent).toContain('Drained');
});

it('shows recovery honestly, blocks new changes, and queries the original operation', async () => {
  snapshot = {
    ...snapshot,
    servers: [{ ...pin, state: 'disabled' }],
    operation: {
      operationId: 'original',
      action: 'disable',
      serverId: pin.serverId,
      revision: 0,
      state: 'recovery_required',
      error: { code: 'original_owner_unavailable' },
    },
  };
  vi.mocked(provider.mcpManagement!.operation).mockResolvedValue(snapshot);
  await render('zh-CN');
  expect(container.textContent).toContain('需要恢复');
  expect(container.textContent).not.toContain('已排空');
  const add = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === '添加服务',
  );
  expect(add?.disabled).toBe(true);
  await click('查询原命令');
  expect(provider.mcpManagement!.operation).toHaveBeenCalledWith(
    'session-a',
    'original',
    expect.anything(),
  );
  expect(provider.mcpManagement!.submit).not.toHaveBeenCalled();
});

it('resumes a saved command only from an explicit retry using its original identity', async () => {
  snapshot = { ...snapshot, servers: [{ ...pin, state: 'enabled' }] };
  const recovery: ManagedMcpManagementSnapshot = {
    ...snapshot,
    revision: 1,
    operation: {
      operationId: 'original',
      action: 'restart',
      serverId: pin.serverId,
      revision: 1,
      state: 'recovery_required',
    },
  };
  vi.mocked(provider.mcpManagement!.submit)
    .mockResolvedValueOnce(recovery)
    .mockResolvedValueOnce({
      ...recovery,
      operation: { ...recovery.operation!, state: 'settled' },
    });
  vi.mocked(provider.mcpManagement!.operation).mockResolvedValue(recovery);
  await render();
  await act(async () =>
    container.querySelector<HTMLElement>('[aria-label="docs"]')!.click(),
  );
  await click('Restart');
  expect(container.textContent).toContain('Recovery required');
  expect(provider.mcpManagement!.submit).toHaveBeenCalledTimes(1);
  await click('Retry original command');
  expect(provider.mcpManagement!.operation).toHaveBeenCalledWith(
    'session-a',
    'original',
    expect.anything(),
  );
  const calls = vi.mocked(provider.mcpManagement!.submit).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[1][1]).toEqual(calls[0][1]);
  expect(calls[1][2].idempotencyKey).toBe(calls[0][2].idempotencyKey);
  expect(calls[1][2].requestId).toBe(calls[0][2].requestId);
  expect(container.textContent).toContain('Completed');
  expect(container.textContent).not.toContain('Retry original command');
});

it('keeps an edited disabled server disabled without sending an enable command', async () => {
  snapshot = { ...snapshot, servers: [{ ...pin, state: 'disabled' }] };
  await render();
  await act(async () =>
    container
      .querySelector<HTMLElement>('[role="button"][aria-label="docs"]')!
      .click(),
  );
  await click('Change definition');
  await click('Apply');
  expect(container.textContent).toContain('Disabled');
  expect(
    [...container.querySelectorAll<HTMLButtonElement>('button')].some(
      (button) => button.textContent === 'Enable',
    ),
  ).toBe(true);
  expect(
    vi
      .mocked(provider.mcpManagement!.submit)
      .mock.calls.map(([, command]) => command.action),
  ).toEqual(['edit']);
});

it('does not label current settings drained using an older completed command', async () => {
  snapshot = {
    ...snapshot,
    revision: 2,
    servers: [{ ...pin, state: 'enabled' }],
    operation: {
      operationId: 'old-disable',
      action: 'disable',
      serverId: pin.serverId,
      revision: 1,
      state: 'settled',
    },
  };
  await render();
  const card = container.querySelector<HTMLElement>(
    '[role="button"][aria-label="docs"]',
  )!;
  expect(card.textContent).toContain('Configured');
  expect(card.textContent).not.toContain('Drained');
});

it('shows a selection prompt without calling a daemon or management endpoint', async () => {
  await render('en', null);
  expect(container.textContent).toContain('Select a Managed Session');
  expect(provider.mcpManagement!.query).not.toHaveBeenCalled();
});
