// @vitest-environment jsdom

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { ManagedWorkspaceNavigation } from './ManagedWorkspaceNavigation';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
} from './managed-agent-provider';

function session(
  sessionId: string,
  workspaceId?: string,
): ManagedAgentSessionSummary {
  return {
    sessionId,
    title: `Task ${sessionId}`,
    ...(workspaceId ? { workspace: { workspaceId, cwdRelative: '.' } } : {}),
    createdAt: 1,
    admittedAt: 1,
    updatedAt: 1,
    phase: 'completed',
    runtimeReady: true,
    runtimeState: 'ready',
    capabilities: { canSend: true, canCancel: false },
  };
}

const workspace = {
  workspaceId: 'a',
  displayName: 'Project',
  state: 'active',
  canCreateSession: true,
};

describe('Managed workspace navigation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let provider: ManagedAgentProvider;
  let props: ComponentProps<typeof ManagedWorkspaceNavigation>;
  const list = vi.fn();
  const selectSession = vi.fn();
  const selectWorkspace = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    list.mockResolvedValue({ data: [workspace], supported: true });
    provider = {
      storageKey: 'provider:a',
      canCancel: true,
      workspaceBinding: {
        agentId: 'agent',
        list,
        get: vi.fn(),
        createEmpty: vi.fn(),
      },
      listSessions: vi.fn(),
      getSession: vi.fn(),
      getTranscript: vi.fn(),
      createSession: vi.fn(),
      submitPrompt: vi.fn(),
      cancel: vi.fn(),
      queryCancelOperation: vi.fn(),
      async *subscribeEvents() {
        yield* [];
      },
    };
    props = {
      provider,
      clientId: 'client',
      sessions: [session('one', 'a')],
      sessionId: 'one',
      active: true,
      search: '',
      revision: 0,
      onSelectWorkspace: selectWorkspace,
      onSelectSession: selectSession,
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(overrides: Partial<typeof props> = {}) {
    props = { ...props, ...overrides };
    await act(async () =>
      root.render(
        <I18nProvider language="en">
          <ManagedWorkspaceNavigation {...props} />
        </I18nProvider>,
      ),
    );
  }

  function group(id: string) {
    return container.querySelector<HTMLElement>(
      `[data-managed-workspace="${id}"]`,
    )!;
  }

  it('groups by server identity, including empty, default, unpaged and unbound workspaces', async () => {
    list.mockResolvedValue({
      data: [workspace, { ...workspace, workspaceId: 'b' }],
      defaultWorkspace: {
        ...workspace,
        workspaceId: 'default',
        displayName: 'Default',
      },
      supported: true,
    });
    await render({
      sessions: [
        session('one', 'a'),
        session('outside', 'unpaged'),
        session('old'),
      ],
    });
    expect(group('a').textContent).toContain('Task one');
    expect(group('b').textContent).toContain('No sessions');
    expect(group('default').textContent).toContain('Default');
    expect(group('unpaged').textContent).toContain('Task outside');
    expect(group('').textContent).toContain('Task old');
    expect(container.querySelectorAll('[data-managed-workspace]')).toHaveLength(
      5,
    );
    expect(provider.listSessions).not.toHaveBeenCalled();
    await act(async () =>
      group('b')
        .querySelector<HTMLButtonElement>('button[title="New session"]')!
        .click(),
    );
    expect(selectWorkspace).toHaveBeenCalledWith('b');
    expect(
      group('unpaged').querySelector<HTMLButtonElement>(
        'button[title="New session"]',
      )!.disabled,
    ).toBe(true);
    await act(async () =>
      group('unpaged')
        .querySelector<HTMLElement>('[data-managed-session-id="outside"]')!
        .click(),
    );
    expect(selectSession).toHaveBeenCalledWith('outside', 'unpaged');
  });

  it('keeps background navigation clickable without marking a hidden conversation current', async () => {
    await render({ active: false });
    expect(container.querySelector('[aria-current]')).toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLElement>('[data-managed-session-id="one"]')!
        .click(),
    );
    expect(selectSession).toHaveBeenCalledWith('one', 'a');
    await render({ active: true });
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe(
      'Task one',
    );
  });

  it.each([
    ['created', false],
    ['admitted', true],
    ['runtime_starting', true],
    ['agent_running', true],
    ['waiting_runtime', true],
    ['tool_running', true],
    ['cancelling', true],
    ['completed', false],
    ['failed', false],
    ['cancelled', false],
  ] as const)(
    'uses daemon running indicators for %s',
    async (phase, running) => {
      await render({
        sessions: [{ ...session('one', 'a'), phase }],
        active: false,
      });
      const row = container.querySelector('[data-managed-session-id="one"]')!;
      expect(
        Boolean(row.querySelector('[data-web-shell-session-running]')),
      ).toBe(running);
      expect(
        Boolean(row.querySelector('[role="status"][aria-label="Running"]')),
      ).toBe(running);
      expect(row.getAttribute('aria-current')).toBeNull();
      await act(async () => (row as HTMLElement).click());
      expect(selectSession).toHaveBeenCalledWith('one', 'a');
    },
  );

  it('removes both running indicators when a task settles without changing selection', async () => {
    await render({
      sessions: [{ ...session('one', 'a'), phase: 'agent_running' }],
    });
    expect(
      group('a').querySelector('[data-web-shell-session-running]'),
    ).not.toBeNull();
    await render({ sessions: [session('one', 'a')] });
    expect(
      group('a').querySelector('[data-web-shell-session-running]'),
    ).toBeNull();
    expect(
      group('a').querySelector('[role="status"][aria-label="Running"]'),
    ).toBeNull();
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe(
      'Task one',
    );
  });

  it('keeps lifecycle actions independent from selecting a running session', async () => {
    const archive = vi.fn();
    await render({
      sessions: [{ ...session('one', 'a'), phase: 'agent_running' }],
      renderSessionActions: (item) => (
        <button onClick={archive} aria-label={`Archive ${item.sessionId}`}>
          Archive
        </button>
      ),
    });
    const row = container.querySelector<HTMLElement>(
      '[data-managed-session-id="one"]',
    )!;
    const action = container.querySelector<HTMLButtonElement>(
      '[aria-label="Archive one"]',
    )!;
    expect(
      row.querySelector('[data-web-shell-session-running]'),
    ).not.toBeNull();
    expect(row.contains(action)).toBe(true);
    await act(async () => action.click());
    expect(archive).toHaveBeenCalledOnce();
    expect(selectSession).not.toHaveBeenCalled();
    await act(async () => row.click());
    expect(selectSession).toHaveBeenCalledWith('one', 'a');
  });

  it('filters by common workspace or session search without reloading the catalog', async () => {
    list.mockResolvedValue({
      data: [
        workspace,
        { ...workspace, workspaceId: 'b', displayName: 'Other' },
      ],
      supported: true,
    });
    await render({
      sessions: [session('one', 'a'), session('two', 'b')],
      search: 'two',
    });
    expect(container.querySelector('[data-managed-workspace="a"]')).toBeNull();
    expect(group('b').textContent).toContain('Task two');
    await render({ search: 'project' });
    expect(group('a').textContent).toContain('Task one');
    expect(container.querySelector('[data-managed-workspace="b"]')).toBeNull();
    expect(list).toHaveBeenCalledOnce();
  });

  it('loads workspace pages explicitly and deduplicates IDs without fetching sessions again', async () => {
    const onWorkspacesChange = vi.fn();
    list
      .mockResolvedValueOnce({
        data: [workspace],
        nextCursor: 'next',
        supported: true,
      })
      .mockResolvedValueOnce({
        data: [
          { ...workspace, displayName: 'Updated' },
          { ...workspace, workspaceId: 'c', displayName: 'Third' },
        ],
        supported: true,
      });
    await render({ onWorkspacesChange });
    expect(container.querySelector('[data-managed-workspace="c"]')).toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Load more Workspace"]')!
        .click(),
    );
    expect(list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: 'next' }),
    );
    expect(group('a').textContent).toContain('Updated');
    expect(group('c').textContent).toContain('Third');
    expect(
      container.querySelectorAll('[data-managed-workspace="a"]'),
    ).toHaveLength(1);
    expect(provider.listSessions).not.toHaveBeenCalled();
    expect(onWorkspacesChange).toHaveBeenLastCalledWith([
      { ...workspace, displayName: 'Updated' },
      { ...workspace, workspaceId: 'c', displayName: 'Third' },
    ]);
  });

  it('projects the supported default catalog and removes task choices after discovery fails', async () => {
    const onWorkspacesChange = vi.fn();
    const defaultWorkspace = {
      ...workspace,
      workspaceId: 'default',
      displayName: 'Default',
    };
    list
      .mockResolvedValueOnce({
        data: [workspace],
        defaultWorkspace,
        supported: true,
      })
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce({ data: [workspace], supported: false });
    await render({ onWorkspacesChange });
    expect(onWorkspacesChange).toHaveBeenLastCalledWith([
      workspace,
      defaultWorkspace,
    ]);
    await render({ revision: 1 });
    expect(onWorkspacesChange).toHaveBeenLastCalledWith([]);
    await render({ revision: 2 });
    expect(onWorkspacesChange).toHaveBeenLastCalledWith([]);
  });

  it('retains reachable history when workspace discovery fails and refreshes after creation', async () => {
    list
      .mockRejectedValueOnce(new Error('Permission denied'))
      .mockResolvedValueOnce({
        data: [workspace, { ...workspace, workspaceId: 'new' }],
        supported: true,
      });
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Permission denied',
    );
    expect(group('a').textContent).toContain('Task one');
    expect(
      group('a').querySelector<HTMLButtonElement>(
        'button[title="New session"]',
      )!.disabled,
    ).toBe(true);
    await render({ revision: 1 });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(group('new')).not.toBeNull();
  });

  it('scopes expansion preferences to the provider even for the same workspace ID', async () => {
    await render({ active: false });
    await act(async () =>
      group('a').querySelector<HTMLButtonElement>('[aria-expanded]')!.click(),
    );
    expect(
      group('a')
        .querySelector('[aria-expanded]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');
    await render({ provider: { ...provider, storageKey: 'provider:b' } });
    expect(
      group('a')
        .querySelector('[aria-expanded]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
  });
});
