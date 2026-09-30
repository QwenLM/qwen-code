// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type { ManagedAgentProvider } from './managed-agent-provider';
import { WorkspaceBindingCreator } from './WorkspaceBindingCreator';

const workspace = {
  workspaceId: 'ws-a',
  displayName: 'A',
  state: 'active',
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
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
      await flush();
    });
  }

  async function chooseWorkspace(label: string) {
    await act(async () => {
      container.querySelector<HTMLElement>('[role="combobox"]')!.click();
    });
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((item) => item.textContent === label);
    expect(option).toBeDefined();
    await act(async () => option!.click());
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

  it.each(['create', 'read'])(
    'finishes an in-flight %s after a same-identity provider refresh',
    async (stage) => {
      const session = {
        sessionId: 'session-a',
        workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
      };
      let resolveCommand!: (value: typeof session) => void;
      createEmpty.mockResolvedValue({ sessionId: 'session-a' });
      getSession.mockResolvedValue(session);
      const command = stage === 'create' ? createEmpty : getSession;
      command.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCommand = resolve;
          }),
      );
      await render();
      await click('Create session');
      const signal = command.mock.calls[0][1].signal as AbortSignal;
      provider = {
        ...provider,
        workspaceBinding: { ...provider.workspaceBinding! },
      };
      await render();
      expect(signal.aborted).toBe(false);
      const buttons = [...container.querySelectorAll('button')];
      expect(
        buttons.find((item) => item.textContent?.startsWith('Retry'))?.disabled,
      ).toBe(true);
      expect(
        buttons.find(
          (item) => item.textContent === 'Abandon local confirmation',
        )?.disabled,
      ).toBe(true);
      await act(async () => {
        resolveCommand(session);
        await flush();
      });
      expect(createEmpty).toHaveBeenCalledTimes(1);
      expect(getSession).toHaveBeenCalledTimes(1);
      expect(onCreated).toHaveBeenCalledExactlyOnceWith('session-a');
      expect(sessionStorage.length).toBe(0);
    },
  );

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

  it.each([
    new TypeError('read failed'),
    new JavaManagedAgentHttpError(403, 'workspace_forbidden', 'denied'),
  ])('only retries reading after creation is accepted: %s', async (error) => {
    createEmpty.mockResolvedValue({ sessionId: 'session-a' });
    getSession.mockRejectedValueOnce(error).mockResolvedValueOnce({
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

  it('keeps the recovery record when an aborted create is later denied', async () => {
    let rejectFirst!: (error: Error) => void;
    createEmpty
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockRejectedValueOnce(
        new JavaManagedAgentHttpError(403, 'workspace_forbidden', 'denied'),
      );
    await render();
    await click('Create session');
    const key =
      'qwen-managed-workspace-create:host:scope-a:agent-a:workspace-v1';
    const saved = sessionStorage.getItem(key);
    expect(createEmpty).toHaveBeenCalledTimes(1);
    expect(saved).not.toBeNull();

    await act(async () => root.unmount());
    await act(async () => {
      rejectFirst(new Error('aborted'));
      await flush();
    });
    root = createRoot(container);
    await render();
    await click('Retry the same request');
    expect(createEmpty).toHaveBeenCalledTimes(2);
    expect(createEmpty.mock.calls[1][0]).toEqual(createEmpty.mock.calls[0][0]);
    expect(createEmpty.mock.calls[1][1].idempotencyKey).toBe(
      createEmpty.mock.calls[0][1].idempotencyKey,
    );
    expect(sessionStorage.getItem(key)).toBe(saved);
    expect(container.textContent).toContain('Creation is unconfirmed');
  });

  it.each([408, 429])(
    'retains the frozen create after HTTP %s',
    async (status) => {
      createEmpty
        .mockRejectedValueOnce(
          new JavaManagedAgentHttpError(status, 'retry', 'retry'),
        )
        .mockResolvedValueOnce({ sessionId: 'session-a' });
      getSession.mockResolvedValue({
        sessionId: 'session-a',
        workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
      });
      await render();
      await click('Create session');
      expect(sessionStorage.length).toBe(1);
      await click('Retry the same request');
      expect(createEmpty).toHaveBeenCalledTimes(2);
      expect(createEmpty.mock.calls[1]).toEqual(createEmpty.mock.calls[0]);
      expect(onCreated).toHaveBeenCalledWith('session-a');
    },
  );

  it('requires an explicit selection when no default is configured', async () => {
    vi.mocked(provider.workspaceBinding!.list).mockResolvedValue({
      data: [workspace],
      supported: true,
    });
    await render();
    await click('Create session');
    expect(createEmpty).not.toHaveBeenCalled();
  });

  it('selects the explicit default outside the first page and deduplicates it', async () => {
    vi.mocked(provider.workspaceBinding!.list)
      .mockResolvedValueOnce({
        data: [{ ...workspace, workspaceId: 'ws-b', displayName: 'B' }],
        defaultWorkspace: workspace,
        nextCursor: 'page-2',
        supported: true,
      })
      .mockResolvedValueOnce({ data: [workspace], supported: true });
    createEmpty.mockResolvedValue({ sessionId: 'session-a' });
    getSession.mockResolvedValue({
      sessionId: 'session-a',
      workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
    });
    await render();
    expect(container.querySelector('[role="combobox"]')?.textContent).toBe(
      'A (ws-a)',
    );
    await click('Load more');
    await act(async () => {
      container.querySelector<HTMLElement>('[role="combobox"]')!.click();
    });
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(
      options.filter((item) => item.textContent === 'A (ws-a)'),
    ).toHaveLength(1);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await click('Create session');
    expect(createEmpty.mock.calls[0][0].workspaceId).toBe('ws-a');
    expect(onCreated).toHaveBeenCalledWith('session-a');
  });

  it('requires confirmation before switching an edited directory', async () => {
    vi.mocked(provider.workspaceBinding!.list).mockResolvedValue({
      data: [
        workspace,
        { ...workspace, workspaceId: 'ws-b', displayName: 'B' },
      ],
      defaultWorkspace: workspace,
      supported: true,
    });
    await render();
    const directory = container.querySelector<HTMLInputElement>(
      '#managed-workspace-cwd',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(directory, 'services/api');
      directory.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await chooseWorkspace('B (ws-b)');
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(directory.value).toBe('services/api');
    await click('Keep selection');
    expect(container.querySelector('[role="combobox"]')?.textContent).toBe(
      'A (ws-a)',
    );
    expect(directory.value).toBe('services/api');
    await chooseWorkspace('B (ws-b)');
    await click('Switch');
    expect(container.querySelector('[role="combobox"]')?.textContent).toBe(
      'B (ws-b)',
    );
    expect(directory.value).toBe('.');
    expect(createEmpty).not.toHaveBeenCalled();
  });

  it('does not allow a non-creatable workspace to be selected', async () => {
    vi.mocked(provider.workspaceBinding!.list).mockResolvedValue({
      data: [
        workspace,
        {
          ...workspace,
          workspaceId: 'ws-b',
          displayName: 'Restricted',
          canCreateSession: false,
        },
      ],
      defaultWorkspace: workspace,
      supported: true,
    });
    await render();
    await chooseWorkspace('Restricted (ws-b)');
    const option = document.querySelector(
      '[role="option"][aria-disabled="true"]',
    );
    expect(option?.textContent).toBe('Restricted (ws-b)');
    expect(container.querySelector('[role="combobox"]')?.textContent).toBe(
      'A (ws-a)',
    );
    expect(createEmpty).not.toHaveBeenCalled();
  });

  it('restores editing after the first create is definitively rejected', async () => {
    createEmpty.mockRejectedValue(
      new JavaManagedAgentHttpError(400, 'invalid_cwd', 'invalid directory'),
    );
    await render();
    await click('Create session');
    expect(sessionStorage.length).toBe(0);
    expect(container.querySelector('#managed-workspace-cwd')).not.toBeNull();
    expect(container.textContent).toContain('invalid directory');
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
        workspace: { workspaceId: 'wrong-workspace', cwdRelative: 'docs' },
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

  it('disables creation when a retained choice cannot be rechecked', async () => {
    const previous = { ...workspace, workspaceId: 'ws-b' };
    vi.mocked(provider.workspaceBinding!.list)
      .mockResolvedValueOnce({
        data: [previous],
        defaultWorkspace: previous,
        supported: true,
      })
      .mockResolvedValueOnce({
        data: [workspace],
        supported: true,
      });
    vi.mocked(provider.workspaceBinding!.get).mockRejectedValue(
      new Error('temporary failure'),
    );
    await render();
    await click('Refresh');
    expect(container.textContent).toContain('temporary failure');
    const create = [...container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('Create session'),
    );
    expect(create?.disabled).toBe(true);
    expect(createEmpty).not.toHaveBeenCalled();
  });
});
