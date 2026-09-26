// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { ManagedAgentProvider } from './managed-agent-provider';
import { WorkspaceBindingCreator } from './WorkspaceBindingCreator';

const workspace = {
  workspaceId: 'ws-a',
  displayName: 'A',
  state: 'ACTIVE',
  canCreateSession: true,
};

describe('WorkspaceBindingCreator', () => {
  let container: HTMLDivElement;
  let root: Root;
  let createEmpty: ReturnType<typeof vi.fn>;
  let getSession: ReturnType<typeof vi.fn>;
  let onCreated: ReturnType<typeof vi.fn>;
  let provider: ManagedAgentProvider;

  async function flush() {
    for (let index = 0; index < 8; index++) await Promise.resolve();
  }

  async function render() {
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <WorkspaceBindingCreator
            provider={provider}
            clientId="client-a"
            onCreated={onCreated}
          />
        </I18nProvider>,
      );
      await flush();
    });
    await act(flush);
  }

  async function click(label: string) {
    const button = [...container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes(label),
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
      await flush();
    });
  }

  beforeEach(() => {
    sessionStorage.clear();
    createEmpty = vi.fn();
    getSession = vi.fn();
    onCreated = vi.fn();
    provider = {
      kind: 'java',
      storageKey: 'host:scope-a:agent-a:workspace-v1',
      canCancel: false,
      acceptsWorkspaceCwd: false,
      workspaceBinding: {
        agentId: 'agent-a',
        list: vi.fn().mockResolvedValue({
          data: [workspace],
          defaultWorkspace: workspace,
          supported: true,
        }),
        get: vi.fn().mockResolvedValue(workspace),
        createEmpty,
      },
      listSessions: vi.fn(),
      getSession,
      getTranscript: vi.fn(),
      createSession: vi.fn(),
      submitPrompt: vi.fn(),
      cancel: vi.fn(),
      async *subscribeEvents() {
        yield* [];
      },
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('retries the frozen request after a lost response and confirms binding', async () => {
    createEmpty
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce({ sessionId: 'session-a' });
    getSession.mockResolvedValue({
      sessionId: 'session-a',
      workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
    });
    await render();
    await click('Create session');
    const saved = sessionStorage.getItem(
      'qwen-managed-workspace-create:host:scope-a:agent-a:workspace-v1',
    );
    expect(saved).toContain('"input":[]');
    expect(saved).toContain('"clientId":"client-a"');
    expect(container.textContent).toContain('Creation is unconfirmed');

    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await click('Retry the same request');
    expect(createEmpty).toHaveBeenCalledTimes(2);
    expect(createEmpty.mock.calls[1][0]).toEqual(createEmpty.mock.calls[0][0]);
    expect(createEmpty.mock.calls[1][1].idempotencyKey).toBe(
      createEmpty.mock.calls[0][1].idempotencyKey,
    );
    expect(onCreated).toHaveBeenCalledWith('session-a');
    expect(sessionStorage.length).toBe(0);
  });

  it('only retries reading after creation is accepted', async () => {
    createEmpty.mockResolvedValue({ sessionId: 'session-a' });
    getSession
      .mockRejectedValueOnce(new TypeError('read failed'))
      .mockResolvedValueOnce({
        sessionId: 'session-a',
        workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
      });
    await render();
    await click('Create session');
    expect(container.textContent).toContain('Retry reading session');
    await click('Retry reading session');
    expect(createEmpty).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledWith('session-a');
  });

  it('keeps the returned Session ID when binding read-back is invalid', async () => {
    createEmpty.mockResolvedValue({ sessionId: 'session-a' });
    getSession
      .mockResolvedValueOnce({ sessionId: 'session-a' })
      .mockResolvedValueOnce({
        sessionId: 'other-session',
        workspace: { workspaceId: 'ws-a', cwdRelative: 'docs' },
      })
      .mockResolvedValueOnce({
        sessionId: 'session-a',
        workspace: { workspaceId: 'ws-a', cwdRelative: 'docs' },
      });
    await render();
    await click('Create session');
    expect(container.textContent).toContain('Session session-a was created');
    expect(
      sessionStorage.getItem(
        'qwen-managed-workspace-create:host:scope-a:agent-a:workspace-v1',
      ),
    ).toContain('"sessionId":"session-a"');
    await click('Retry reading session');
    expect(onCreated).not.toHaveBeenCalled();
    await click('Retry reading session');
    expect(createEmpty).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith('session-a');
  });

  it('ignores an old create response after the identity scope changes', async () => {
    let resolveCreate!: (value: { sessionId: string }) => void;
    createEmpty.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    await render();
    await click('Create session');
    await act(async () => root.unmount());
    root = createRoot(container);
    provider = { ...provider, storageKey: 'host:scope-b:agent-b:workspace-v1' };
    await render();
    await act(async () => {
      resolveCreate({ sessionId: 'old-session' });
      await flush();
    });
    expect(onCreated).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('old-session');
    expect(createEmpty).toHaveBeenCalledTimes(1);
  });

  it('keeps creation disabled when the service omits binding capability', async () => {
    vi.mocked(provider.workspaceBinding!.list).mockResolvedValue({
      data: [workspace],
      supported: false,
    });
    await render();
    const create = [...container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('Create session'),
    );
    expect(create?.disabled).toBe(true);
    expect(createEmpty).not.toHaveBeenCalled();
  });

  it('does not resend a pending create while binding capability is absent', async () => {
    sessionStorage.setItem(
      'qwen-managed-workspace-create:host:scope-a:agent-a:workspace-v1',
      JSON.stringify({
        agentId: 'agent-a',
        workspaceId: 'ws-a',
        cwdRelative: '.',
        input: [],
        clientId: 'client-a',
        idempotencyKey: 'key-a',
        uncertain: true,
      }),
    );
    vi.mocked(provider.workspaceBinding!.list).mockResolvedValue({
      data: [workspace],
      supported: false,
    });
    await render();
    const retry = [...container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('Retry the same request'),
    );
    expect(retry?.disabled).toBe(true);
    expect(createEmpty).not.toHaveBeenCalled();
  });

  it('does not send a create request when its recovery record cannot be saved', async () => {
    const storage = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('storage disabled');
      });
    try {
      await render();
      await click('Create session');
      expect(createEmpty).not.toHaveBeenCalled();
      expect(container.textContent).toContain('session storage is unavailable');
    } finally {
      storage.mockRestore();
    }
  });

  it('falls back to the new explicit default when a retained choice loses create access', async () => {
    const previous = { ...workspace, workspaceId: 'ws-b' };
    vi.mocked(provider.workspaceBinding!.list)
      .mockResolvedValueOnce({
        data: [previous, workspace],
        defaultWorkspace: previous,
        supported: true,
      })
      .mockResolvedValueOnce({
        data: [previous, workspace],
        defaultWorkspace: workspace,
        supported: true,
      });
    vi.mocked(provider.workspaceBinding!.get).mockResolvedValue({
      ...previous,
      canCreateSession: false,
    });
    createEmpty.mockResolvedValue({ sessionId: 'session-a' });
    getSession.mockResolvedValue({
      sessionId: 'session-a',
      workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
    });
    await render();
    await click('Refresh');
    await click('Create session');
    expect(createEmpty.mock.calls[0][0].workspaceId).toBe('ws-a');
  });
});
