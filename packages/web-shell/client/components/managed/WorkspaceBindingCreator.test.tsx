// @vitest-environment jsdom

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { EditorHandle } from '../../hooks/useComposerCore';
import { I18nProvider } from '../../i18n';
import { WebShellPortalRootContext } from '../../portalRoot';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type {
  ManagedAgentProvider,
  ManagedSessionOptions,
} from './managed-agent-provider';
import { WorkspaceBindingCreator } from './WorkspaceBindingCreator';

const editorMocks = vi.hoisted(() => ({
  props: undefined as
    | ComponentProps<(typeof import('../ChatEditor'))['ChatEditor']>
    | undefined,
  clearText: vi.fn(),
  setText: vi.fn(),
}));

vi.mock('../ChatEditor', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    ChatEditor: forwardRef<
      EditorHandle,
      ComponentProps<(typeof import('../ChatEditor'))['ChatEditor']>
    >((props, ref) => {
      editorMocks.props = props;
      useImperativeHandle(
        ref,
        () =>
          ({
            clearText: editorMocks.clearText,
            setText: editorMocks.setText,
          }) as EditorHandle,
      );
      return <div data-testid="shared-editor" />;
    }),
  };
});

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
  let onAbandoned: ReturnType<typeof vi.fn>;
  let provider: ManagedAgentProvider;

  async function flush() {
    for (let index = 0; index < 8; index++) await Promise.resolve();
  }

  async function render(interactive = true, strict = false) {
    await act(async () => {
      const content = (
        <I18nProvider language="en">
          <WorkspaceBindingCreator
            provider={provider}
            clientId="client-a"
            onCreated={onCreated}
            onAbandoned={onAbandoned}
            interactive={interactive}
          />
        </I18nProvider>
      );
      root.render(strict ? <StrictMode>{content}</StrictMode> : content);
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
      container
        .querySelector<HTMLElement>('#managed-workspace-select')!
        .click();
    });
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((item) => item.textContent === label);
    expect(option).toBeDefined();
    await act(async () => option!.click());
  }

  beforeEach(() => {
    vi.clearAllMocks();
    editorMocks.props = undefined;
    sessionStorage.clear();
    createEmpty = vi.fn();
    getSession = vi.fn();
    onCreated = vi.fn();
    onAbandoned = vi.fn();
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
    vi.useRealTimers();
  });

  const remoteWorkspace = {
    ...workspace,
    workspaceId: 'ws-remote',
    displayName: 'Remote project',
  };

  function enableRegistration() {
    const registration = {
      listNodes: vi.fn().mockResolvedValue({
        supported: true,
        data: [{ nodeId: 'mac', displayName: 'Remote Mac' }],
      }),
      checkDirectory: vi.fn().mockResolvedValue({
        nodeId: 'mac',
        canonicalPath: '/projects/example',
        platform: 'darwin',
      }),
      create: vi.fn().mockResolvedValue({
        operationId: 'registration-a',
        type: 'workspace_create',
        status: 'completed',
        workspaceId: 'ws-remote',
        replayed: false,
      }),
      query: vi.fn().mockResolvedValue({
        operationId: 'registration-a',
        type: 'workspace_create',
        status: 'completed',
        workspaceId: 'ws-remote',
        replayed: false,
      }),
    };
    provider.workspaceBinding = {
      ...provider.workspaceBinding!,
      registration,
    };
    vi.mocked(provider.workspaceBinding.get).mockResolvedValue(remoteWorkspace);
    return registration;
  }

  async function typeInput(id: string, value: string) {
    await act(async () => {
      const input = document.getElementById(id) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function openRegistration(direct = false) {
    if (direct)
      await act(async () => editorMocks.props!.onOpenExistingWorkspace!());
    else await click('Add Workspace');
    await act(async () =>
      document.getElementById('managed-runtime-node')!.click(),
    );
    const machine = [...document.querySelectorAll('[role="option"]')].find(
      (item) => item.textContent === 'Remote Mac',
    );
    expect(machine).toBeDefined();
    await act(async () => (machine as HTMLElement).click());
    await typeInput('managed-runtime-directory', '/projects/link');
    await typeInput('managed-runtime-name', 'Remote project');
    await click('Check directory');
  }

  it.each([401, 403, 404])(
    'hides remote registration when node discovery returns %s',
    async (status) => {
      const registration = enableRegistration();
      registration.listNodes.mockRejectedValue(
        new JavaManagedAgentHttpError(status, 'unavailable', 'Unavailable'),
      );
      directCreation();
      await render();
      expect(editorMocks.props!.existingFolderWorkspaceSupported).toBe(false);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(registration.create).not.toHaveBeenCalled();
    },
  );

  it('keeps the registration entry hidden when disabled or no nodes are authorized', async () => {
    const registration = enableRegistration();
    registration.listNodes.mockResolvedValue({ supported: false, data: [] });
    await render();
    expect(container.textContent).not.toContain('Add Workspace');
    expect(registration.create).not.toHaveBeenCalled();
  });

  it('registers and selects a remote Workspace without creating a Session', async () => {
    const registration = enableRegistration();
    const createSession = directCreation();
    vi.mocked(provider.workspaceBinding!.get).mockResolvedValue({
      ...remoteWorkspace,
      defaultCwdRelative: 'remote-project',
    });
    await render();
    await typeInput('managed-workspace-cwd', 'local-project');
    expect(editorMocks.props!.existingFolderWorkspaceSupported).toBe(true);
    await openRegistration(true);
    expect(registration.checkDirectory).toHaveBeenCalledWith(
      { nodeId: 'mac', path: '/projects/link' },
      expect.objectContaining({ clientId: 'client-a' }),
    );
    await click('Register Workspace');
    expect(registration.create).toHaveBeenCalledWith(
      {
        nodeId: 'mac',
        path: '/projects/example',
        displayName: 'Remote project',
      },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(provider.workspaceBinding!.get).toHaveBeenCalledWith(
      'ws-remote',
      expect.objectContaining({ clientId: 'client-a' }),
    );
    expect(editorMocks.props!.selectedWorkspaceCwd).toBe('ws-remote');
    expect(
      (document.getElementById('managed-workspace-cwd') as HTMLInputElement)
        .value,
    ).toBe('remote-project');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(createEmpty).not.toHaveBeenCalled();
  });

  it('requires a new directory check after changing the machine path', async () => {
    const registration = enableRegistration();
    await render();
    await openRegistration();
    await typeInput('managed-runtime-directory', '/different/path');
    const register = [...document.querySelectorAll('button')].find(
      (item) => item.textContent === 'Register Workspace',
    );
    expect(register!.disabled).toBe(true);
    await click('Register Workspace');
    expect(registration.create).not.toHaveBeenCalled();
  });

  it('does not register a directory rejected by server authorization', async () => {
    const registration = enableRegistration();
    registration.checkDirectory.mockRejectedValue(
      new JavaManagedAgentHttpError(403, 'forbidden', 'Forbidden'),
    );
    await render();
    await openRegistration();
    expect(
      document.querySelector('[role="dialog"] [role="alert"]')?.textContent,
    ).toContain('does not have permission');
    await click('Register Workspace');
    expect(registration.create).not.toHaveBeenCalled();
  });

  it('replays a lost registration response using the frozen key after a refresh', async () => {
    const registration = enableRegistration();
    registration.create.mockRejectedValueOnce(new TypeError('Lost response'));
    await render();
    await openRegistration();
    await click('Register Workspace');
    const original = registration.create.mock.calls[0];
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(
      (document.getElementById('managed-runtime-directory') as HTMLInputElement)
        .disabled,
    ).toBe(true);
    await click('Continue confirming registration');
    expect(registration.create).toHaveBeenCalledTimes(2);
    expect(registration.create.mock.calls[1][0]).toEqual(original[0]);
    expect(registration.create.mock.calls[1][1].idempotencyKey).toBe(
      original[1].idempotencyKey,
    );
    expect(provider.workspaceBinding!.get).toHaveBeenCalledWith(
      'ws-remote',
      expect.objectContaining({ clientId: 'client-a' }),
    );
  });

  it('polls only the accepted operation after a lost read, including when new registrations are disabled', async () => {
    vi.useFakeTimers();
    const registration = enableRegistration();
    registration.create.mockResolvedValue({
      operationId: 'registration-a',
      type: 'workspace_create',
      status: 'running',
      replayed: false,
    });
    registration.query.mockRejectedValueOnce(new TypeError('Lost read'));
    await render();
    await openRegistration();
    await click('Register Workspace');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'unconfirmed',
    );
    await act(async () => root.unmount());
    registration.listNodes.mockResolvedValue({ supported: false, data: [] });
    root = createRoot(container);
    await render();
    expect(registration.create).toHaveBeenCalledOnce();
    expect(registration.query).toHaveBeenCalledTimes(2);
    expect(registration.query.mock.calls[1][0]).toBe('registration-a');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps the original operation when completed Workspace read-back denies access', async () => {
    const registration = enableRegistration();
    vi.mocked(provider.workspaceBinding!.get).mockResolvedValue({
      ...remoteWorkspace,
      canCreateSession: false,
    });
    await render();
    await openRegistration();
    await click('Register Workspace');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(
      document.querySelector('[role="dialog"] [role="alert"]')?.textContent,
    ).toContain('does not have permission');
    vi.mocked(provider.workspaceBinding!.get).mockResolvedValue(
      remoteWorkspace,
    );
    await click('Continue confirming registration');
    expect(registration.create).toHaveBeenCalledOnce();
    expect(registration.query).toHaveBeenCalledWith(
      'registration-a',
      expect.objectContaining({ clientId: 'client-a' }),
    );
  });

  // The server reconciles a blocked registration from its machine (D7-2),
  // so the dialog keeps querying it: a button while it stays open, and a
  // fresh query each time it opens, without remounting or a discarded draft.
  it('completes a blocked registration from a later query without remounting', async () => {
    const registration = enableRegistration();
    const blocked = {
      operationId: 'registration-blocked',
      type: 'workspace_create',
      status: 'recovery_blocked',
      failureCode: 'workspace_registration_failed',
      replayed: false,
    };
    registration.create.mockResolvedValueOnce(blocked);
    registration.query.mockResolvedValueOnce({
      ...blocked,
      status: 'completed',
      workspaceId: 'ws-remote',
    });
    const storageKey = `qwen-managed-ssh-workspace-registration:${provider.storageKey}`;
    await render();
    await openRegistration();
    await click('Register Workspace');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'has not confirmed',
    );
    await click('Continue confirming registration');
    expect(registration.query).toHaveBeenCalledWith(
      'registration-blocked',
      expect.objectContaining({ clientId: 'client-a' }),
    );
    expect(provider.workspaceBinding!.get).toHaveBeenCalledWith(
      'ws-remote',
      expect.objectContaining({ clientId: 'client-a' }),
    );
    expect(sessionStorage.getItem(storageKey)).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('queries a blocked registration again when the dialog reopens', async () => {
    const registration = enableRegistration();
    const blocked = {
      operationId: 'registration-blocked',
      type: 'workspace_create',
      status: 'recovery_blocked',
      failureCode: 'workspace_registration_failed',
      replayed: false,
    };
    registration.create.mockResolvedValueOnce(blocked);
    registration.query.mockResolvedValueOnce({ ...blocked, status: 'failed' });
    const storageKey = `qwen-managed-ssh-workspace-registration:${provider.storageKey}`;
    await render();
    await openRegistration();
    await click('Register Workspace');
    await click('Close');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(registration.query).not.toHaveBeenCalled();
    await click('Add Workspace');
    expect(registration.query).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Registration failed',
    );
    expect(sessionStorage.getItem(storageKey)).toBeNull();
    expect(
      (document.getElementById('managed-runtime-directory') as HTMLInputElement)
        .disabled,
    ).toBe(false);
  });

  it('clears only a confirmed blocked browser draft before starting another registration', async () => {
    const registration = enableRegistration();
    const blocked = {
      operationId: 'registration-blocked',
      type: 'workspace_create',
      status: 'recovery_blocked',
      failureCode: 'ssh_runtime_version_conflict',
      replayed: false,
    };
    registration.create.mockResolvedValueOnce(blocked);
    registration.query.mockResolvedValueOnce(blocked);
    const storageKey = `qwen-managed-ssh-workspace-registration:${provider.storageKey}`;
    await render();
    await openRegistration();
    await click('Register Workspace');
    const originalKey = registration.create.mock.calls[0][1].idempotencyKey;
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'administrator review',
    );
    expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toMatchObject({
      operationId: 'registration-blocked',
      idempotencyKey: originalKey,
    });
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(registration.query).toHaveBeenCalledWith(
      'registration-blocked',
      expect.objectContaining({ clientId: 'client-a' }),
    );
    expect(
      (document.getElementById('managed-runtime-directory') as HTMLInputElement)
        .disabled,
    ).toBe(true);
    await click('Start another registration');
    expect(sessionStorage.getItem(storageKey)).toBeNull();
    expect(registration.create).toHaveBeenCalledOnce();
    expect(registration.query).toHaveBeenCalledOnce();
    expect(provider.workspaceBinding!.get).not.toHaveBeenCalledWith(
      'ws-remote',
      expect.anything(),
    );
    expect(
      (document.getElementById('managed-runtime-directory') as HTMLInputElement)
        .disabled,
    ).toBe(false);
    await typeInput('managed-runtime-directory', '/projects/another');
    registration.checkDirectory.mockResolvedValue({
      nodeId: 'mac',
      canonicalPath: '/projects/another',
      platform: 'darwin',
    });
    await click('Check directory');
    await click('Register Workspace');
    expect(registration.create).toHaveBeenCalledTimes(2);
    expect(registration.create.mock.calls[1][0].path).toBe('/projects/another');
    expect(registration.create.mock.calls[1][1].idempotencyKey).not.toBe(
      originalKey,
    );
    expect(registration.query).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(storageKey)).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('recovers the original registration under React StrictMode effect replay', async () => {
    const registration = enableRegistration();
    sessionStorage.setItem(
      `qwen-managed-ssh-workspace-registration:${provider.storageKey}`,
      JSON.stringify({
        nodeId: 'mac',
        path: '/projects/example',
        displayName: 'Remote project',
        idempotencyKey: 'original',
        operationId: 'registration-a',
      }),
    );
    directCreation();
    await render(true, true);
    expect(registration.create).not.toHaveBeenCalled();
    expect(registration.query).toHaveBeenCalled();
    expect(editorMocks.props!.selectedWorkspaceCwd).toBe('ws-remote');
    expect(editorMocks.props!.existingFolderWorkspaceSupported).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('does not send a registration when its recovery record cannot be persisted', async () => {
    const registration = enableRegistration();
    await render();
    await openRegistration();
    const storage = vi
      .spyOn(Object.getPrototypeOf(sessionStorage) as Storage, 'setItem')
      .mockImplementation(() => {
        throw new Error('Storage unavailable');
      });
    try {
      await click('Register Workspace');
      expect(registration.create).not.toHaveBeenCalled();
      expect(
        document.querySelector('[role="dialog"] [role="alert"]')?.textContent,
      ).toContain('session storage is unavailable');
    } finally {
      storage.mockRestore();
    }
  });

  function directCreation() {
    const createSession = vi.fn().mockResolvedValue({ sessionId: 'session-a' });
    provider.workspaceBinding = {
      ...provider.workspaceBinding!,
      createSession,
      modelPresets: [
        { agentId: 'agent-a', label: 'Model A' },
        { agentId: 'agent-b', label: 'Model B' },
      ],
    };
    getSession.mockResolvedValue({
      sessionId: 'session-a',
      agentId: 'agent-a',
      workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
    });
    return createSession;
  }

  async function sendInitial(text: string) {
    const commit = vi.fn();
    await act(async () => {
      expect(
        editorMocks.props!.onSubmit(text, undefined, undefined, commit),
      ).toBe(false);
      await flush();
    });
    return commit;
  }

  function workspaceCreation() {
    directCreation();
    const createWorkspace = vi.fn().mockResolvedValue({
      ...workspace,
      workspaceId: 'ws-created',
      displayName: 'Created',
    });
    provider.workspaceBinding = {
      ...provider.workspaceBinding!,
      createWorkspace,
      list: vi.fn().mockResolvedValue({
        data: [workspace],
        defaultWorkspace: workspace,
        supported: true,
        canCreateWorkspace: true,
      }),
    };
    return createWorkspace;
  }

  async function openWorkspaceCreation() {
    await act(async () => {
      editorMocks.props!.onCreateScratchWorkspace!();
    });
  }

  async function nameWorkspace(name: string) {
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>(
        '#managed-new-workspace-name',
      )!;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, name);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function submitDirectory(path: string) {
    await click('Choose existing directory');
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>(
        '#add-workspace-path',
      )!;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, path);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      document
        .querySelector('[role="dialog"] form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
      await flush();
    });
  }

  function approvalSelection() {
    const createSession = directCreation();
    const getSessionOptions = vi.fn().mockResolvedValue({
      approvalMode: 'default',
      availableApprovalModes: ['default', 'auto-edit'],
    });
    provider.workspaceBinding = {
      ...provider.workspaceBinding!,
      getSessionOptions,
      list: vi.fn().mockResolvedValue({
        data: [workspace],
        defaultWorkspace: workspace,
        supported: true,
        supportsApprovalModeSelection: true,
      }),
    };
    getSession.mockResolvedValue({
      sessionId: 'session-a',
      agentId: 'agent-a',
      approvalMode: 'default',
      workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
    });
    return { createSession, getSessionOptions };
  }

  it('loads actual policy options and selects a mode without changing model, Workspace or draft', async () => {
    const { createSession, getSessionOptions } = approvalSelection();
    await render();
    const scope = editorMocks.props?.composerScopeKey;
    expect(getSessionOptions).toHaveBeenCalledWith(
      'agent-a',
      expect.objectContaining({ clientId: 'client-a' }),
    );
    expect(editorMocks.props?.availableModes).toEqual(['default', 'auto-edit']);
    expect(editorMocks.props?.currentMode).toBe('default');
    expect(editorMocks.props?.modeControlsDisabled).toBe(false);
    await act(async () => editorMocks.props!.onSelectMode!('auto-edit'));
    expect(editorMocks.props?.currentModel).toBe('agent-a');
    expect(editorMocks.props?.selectedWorkspaceCwd).toBe('ws-a');
    expect(editorMocks.props?.composerScopeKey).toBe(scope);
    expect(editorMocks.clearText).not.toHaveBeenCalled();
    getSession.mockResolvedValue({
      sessionId: 'session-a',
      agentId: 'agent-a',
      approvalMode: 'auto-edit',
      workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
    });
    const commit = await sendInitial('Write a file');
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalMode: 'auto-edit',
        text: 'Write a file',
      }),
      expect.any(Object),
    );
    expect(commit).toHaveBeenCalledOnce();
  });

  it('freezes attachment-only input and Plan before asynchronous file reading', async () => {
    const { createSession, getSessionOptions } = approvalSelection();
    getSessionOptions.mockResolvedValue({
      approvalMode: 'default',
      availableApprovalModes: ['default', 'auto-edit'],
      planModeSupported: true,
      inputAttachments: true,
    });
    let finishReading!: (value: ArrayBuffer) => void;
    const arrayBuffer = vi.fn(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          finishReading = resolve;
        }),
    );
    await render();
    expect(editorMocks.props?.attachmentsEnabled).toBe(true);
    expect(editorMocks.props?.visibleToolbarActions).toContain('plan');
    await act(async () => editorMocks.props!.onTogglePlan!());
    const commit = vi.fn();
    await act(async () => {
      editorMocks.props!.onSubmit(
        '',
        undefined,
        [
          {
            name: 'notes.md',
            media_type: 'text/markdown',
            data: { size: 12, arrayBuffer } as Blob,
          },
        ],
        commit,
      );
      editorMocks.props!.onSelectModel!('agent-b');
      editorMocks.props!.onSelectMode!('auto-edit');
      editorMocks.props!.onTogglePlan!();
      await flush();
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(editorMocks.props?.currentModel).toBe('agent-a');
    expect(editorMocks.props?.planMode).toBe(true);
    await act(async () => {
      finishReading(new TextEncoder().encode('你好\nnotes').buffer);
      await flush();
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-a',
        approvalMode: 'default',
        planMode: true,
        text: '',
        input: [
          {
            type: 'input_file',
            name: 'notes.md',
            mime_type: 'text/markdown',
            text: '你好\nnotes',
          },
        ],
      }),
      expect.any(Object),
    );
    expect(arrayBuffer).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('reuses every attachment byte and the request key after an unknown creation and remount', async () => {
    const { createSession, getSessionOptions } = approvalSelection();
    getSessionOptions.mockResolvedValue({
      approvalMode: 'default',
      availableApprovalModes: ['default'],
      inputAttachments: true,
    });
    createSession.mockRejectedValueOnce(new Error('Delivery unknown'));
    await render();
    await act(async () => {
      editorMocks.props!.onSubmit(
        'Review',
        undefined,
        [{ name: 'notes.txt', media_type: 'text/plain', text: '原始内容' }],
        vi.fn(),
      );
      await flush();
    });
    const [request, options] = createSession.mock.calls[0];
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await act(async () => {
      editorMocks.props!.onSubmit(
        'Changed draft',
        undefined,
        [{ name: 'other.txt', media_type: 'text/plain', text: 'different' }],
        vi.fn(),
      );
      await flush();
    });
    expect(createSession).toHaveBeenLastCalledWith(
      request,
      expect.objectContaining({ idempotencyKey: options.idempotencyKey }),
    );
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(request.input).toEqual([
      { type: 'input_text', text: 'Review' },
      {
        type: 'input_file',
        name: 'notes.txt',
        mime_type: 'text/plain',
        text: '原始内容',
      },
    ]);
    expect(onCreated).toHaveBeenCalledWith('session-a');
  });

  it('blocks creation until supported policy options are loaded and ignores stale Agent replies', async () => {
    const { createSession, getSessionOptions } = approvalSelection();
    let resolveA!: (options: ManagedSessionOptions) => void;
    let resolveB!: (options: ManagedSessionOptions) => void;
    getSessionOptions.mockImplementation(
      (id) =>
        new Promise<ManagedSessionOptions>((resolve) => {
          if (id === 'agent-a') resolveA = resolve;
          else resolveB = resolve;
        }),
    );
    await render();
    expect(editorMocks.props?.disabled).toBe(true);
    await sendInitial('keep draft');
    expect(createSession).not.toHaveBeenCalled();
    await act(async () => editorMocks.props!.onSelectModel!('agent-b'));
    await act(async () => {
      resolveB({
        approvalMode: 'auto-edit',
        availableApprovalModes: ['auto-edit'],
      });
      await flush();
    });
    await act(async () => {
      resolveA({
        approvalMode: 'default',
        availableApprovalModes: ['default', 'auto-edit'],
      });
      await flush();
    });
    expect(editorMocks.props?.currentModel).toBe('agent-b');
    expect(editorMocks.props?.currentMode).toBe('auto-edit');
    expect(editorMocks.props?.availableModes).toEqual(['auto-edit']);
    expect(editorMocks.props?.modeControlsDisabled).toBe(true);
    expect(editorMocks.props?.disabled).toBe(false);
    expect(editorMocks.clearText).not.toHaveBeenCalled();
  });

  it.each([
    { approvalMode: 'auto', availableApprovalModes: ['auto'] },
    { approvalMode: 'default', availableApprovalModes: ['default', 'plan'] },
    { approvalMode: 'auto-edit', availableApprovalModes: ['default'] },
    { approvalMode: 'default', availableApprovalModes: [] },
  ])('blocks invalid server policy options (%j)', async (options) => {
    const { createSession, getSessionOptions } = approvalSelection();
    getSessionOptions.mockResolvedValue(options);
    await render();
    expect(editorMocks.props?.disabled).toBe(true);
    expect(editorMocks.props?.visibleToolbarActions).not.toContain(
      'approvalMode',
    );
    await sendInitial('must not send');
    expect(createSession).not.toHaveBeenCalled();
    expect(container.textContent).toContain('unsupported approval modes');
  });

  it('refreshes changed policy options after a definite rejection without resubmitting the prompt', async () => {
    const { createSession, getSessionOptions } = approvalSelection();
    createSession.mockRejectedValueOnce(
      new JavaManagedAgentHttpError(
        400,
        'unsupported_approval_mode',
        'Policy changed',
      ),
    );
    await render();
    getSessionOptions.mockResolvedValue({
      approvalMode: 'auto-edit',
      availableApprovalModes: ['auto-edit'],
    });
    const commit = await sendInitial('Keep this prompt');
    expect(createSession).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(getSessionOptions).toHaveBeenCalledTimes(2);
    expect(editorMocks.props?.currentMode).toBe('auto-edit');
    expect(editorMocks.props?.modeControlsDisabled).toBe(true);
    expect(editorMocks.props?.disabled).toBe(false);
    expect(
      sessionStorage.getItem(
        `qwen-managed-workspace-create:${provider.storageKey}`,
      ),
    ).toBeNull();
  });

  it('hides the selector and omits explicit policy on older servers', async () => {
    const { createSession, getSessionOptions } = approvalSelection();
    vi.mocked(provider.workspaceBinding!.list).mockResolvedValue({
      data: [workspace],
      defaultWorkspace: workspace,
      supported: true,
    });
    await render();
    expect(getSessionOptions).not.toHaveBeenCalled();
    expect(editorMocks.props?.visibleToolbarActions).not.toContain(
      'approvalMode',
    );
    await sendInitial('Legacy request');
    expect(createSession.mock.calls[0][0]).not.toHaveProperty('approvalMode');
  });

  it('freezes selected policy on lost response and restores the exact mode after refresh', async () => {
    const { createSession } = approvalSelection();
    createSession.mockRejectedValueOnce(new Error('lost response'));
    await render();
    await act(async () => editorMocks.props!.onSelectMode!('auto-edit'));
    await sendInitial('Frozen prompt');
    const saved = JSON.parse(
      sessionStorage.getItem(
        `qwen-managed-workspace-create:${provider.storageKey}`,
      )!,
    );
    expect(saved.approvalMode).toBe('auto-edit');
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(editorMocks.props?.currentMode).toBe('auto-edit');
    expect(editorMocks.props?.availableModes).toEqual(['auto-edit']);
    expect(editorMocks.props?.modeControlsDisabled).toBe(true);
    getSession.mockResolvedValue({
      sessionId: 'session-a',
      agentId: 'agent-a',
      approvalMode: 'auto-edit',
      workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
    });
    await click('Retry the same request');
    expect(createSession.mock.calls[1][0]).toEqual(
      createSession.mock.calls[0][0],
    );
    expect(createSession.mock.calls[1][1].idempotencyKey).toBe(
      saved.idempotencyKey,
    );
    expect(onCreated).toHaveBeenCalledWith('session-a');
  });

  it('keeps legacy pending policy unknown and omits it on retry even with the new capability', async () => {
    const { createSession } = approvalSelection();
    sessionStorage.setItem(
      `qwen-managed-workspace-create:${provider.storageKey}`,
      JSON.stringify({
        agentId: 'agent-a',
        workspaceId: 'ws-a',
        cwdRelative: '.',
        input: [{ type: 'input_text', text: 'Legacy prompt' }],
        clientId: 'client-a',
        idempotencyKey: 'legacy-key',
      }),
    );
    await render();
    expect(editorMocks.props?.visibleToolbarActions).not.toContain(
      'approvalMode',
    );
    expect(editorMocks.props?.currentMode).toBe('');
    await click('Retry the same request');
    expect(createSession.mock.calls[0][0]).not.toHaveProperty('approvalMode');
    expect(createSession.mock.calls[0][1].idempotencyKey).toBe('legacy-key');
  });

  it.each([undefined, 'session-a'])(
    'refuses explicit pending resubmission without capability but allows known Session read-back (%s)',
    async (sessionId) => {
      const { createSession } = approvalSelection();
      vi.mocked(provider.workspaceBinding!.list).mockResolvedValue({
        data: [workspace],
        defaultWorkspace: workspace,
        supported: true,
      });
      sessionStorage.setItem(
        `qwen-managed-workspace-create:${provider.storageKey}`,
        JSON.stringify({
          agentId: 'agent-a',
          workspaceId: 'ws-a',
          cwdRelative: '.',
          input: [{ type: 'input_text', text: 'Frozen prompt' }],
          approvalMode: 'default',
          clientId: 'client-a',
          idempotencyKey: 'frozen-key',
          ...(sessionId ? { sessionId } : {}),
        }),
      );
      await render();
      if (sessionId) {
        await click('Retry reading session');
        expect(getSession).toHaveBeenCalledWith(sessionId, expect.any(Object));
        expect(onCreated).toHaveBeenCalledWith(sessionId);
      } else {
        const retry = [...container.querySelectorAll('button')].find(
          (item) => item.textContent === 'Retry the same request',
        )!;
        expect(retry.disabled).toBe(true);
        await sendInitial('must not create another Session');
        expect(onCreated).not.toHaveBeenCalled();
        expect(getSession).not.toHaveBeenCalled();
      }
      expect(createSession).not.toHaveBeenCalled();
    },
  );

  it('hides Managed policy controls during a Local switch while preserving the selection', async () => {
    approvalSelection();
    await render();
    await act(async () => editorMocks.props!.onSelectMode!('auto-edit'));
    await render(false);
    expect(editorMocks.props?.visibleToolbarActions).toEqual([]);
    expect(editorMocks.props?.disabled).toBe(true);
    await render();
    expect(editorMocks.props?.currentMode).toBe('auto-edit');
    expect(editorMocks.props?.visibleToolbarActions).toContain('approvalMode');
  });

  it('confirms creation against the immutable initial policy after a later switch', async () => {
    approvalSelection();
    getSession.mockResolvedValue({
      sessionId: 'session-a',
      agentId: 'agent-a',
      approvalMode: 'yolo',
      initialApprovalMode: 'default',
      approvalRevision: 2,
      workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
    });
    await render();
    const commit = await sendInitial('Preserve the initial selection');
    expect(onCreated).toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('keeps explicit policy frozen when Session read-back reports another mode', async () => {
    const { createSession } = approvalSelection();
    getSession.mockResolvedValue({
      sessionId: 'session-a',
      agentId: 'agent-a',
      approvalMode: 'auto-edit',
      workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
    });
    await render();
    const commit = await sendInitial('Do not silently change policy');
    expect(onCreated).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(container.textContent).toContain('could not be confirmed');
    expect(createSession).toHaveBeenCalledOnce();
    const saved = JSON.parse(
      sessionStorage.getItem(
        `qwen-managed-workspace-create:${provider.storageKey}`,
      )!,
    );
    expect(saved.approvalMode).toBe('default');
    expect(saved.sessionId).toBe('session-a');
  });

  it('sends the selected policy for an empty creation and hides its controls in Local mode', async () => {
    approvalSelection();
    provider.workspaceBinding = {
      ...provider.workspaceBinding!,
      createSession: undefined,
    };
    createEmpty.mockResolvedValue({ sessionId: 'session-a' });
    await render(false);
    expect(container.querySelector('#managed-approval-select')).toBeNull();
    await render();
    expect(container.querySelector('#managed-approval-select')).not.toBeNull();
    await click('Create session');
    expect(createEmpty).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'default' }),
      expect.any(Object),
    );
  });

  it.each([undefined, 'registration-a'])(
    'keeps an SSH draft out of local creation when its operation is %s',
    async (operationId) => {
      const createWorkspace = workspaceCreation();
      const registration = enableRegistration();
      registration.query.mockImplementation(() => new Promise(() => {}));
      const key = `qwen-managed-ssh-workspace-registration:${provider.storageKey}`;
      const saved = JSON.stringify({
        nodeId: 'mac',
        path: '/projects/example',
        displayName: 'Remote project',
        idempotencyKey: 'remote-original',
        operationId,
      });
      sessionStorage.setItem(key, saved);
      await render();
      expect(document.getElementById('managed-new-workspace-name')).toBeNull();
      expect(createWorkspace).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(key)).toBe(saved);
      expect(
        sessionStorage.getItem(
          `qwen-managed-workspace-registration:${provider.storageKey}`,
        ),
      ).toBeNull();
    },
  );

  it('does not consume a remote preview receipt from the local draft key', async () => {
    const createWorkspace = workspaceCreation();
    enableRegistration();
    const key = `qwen-managed-workspace-registration:${provider.storageKey}`;
    const saved = JSON.stringify({
      nodeId: 'mac',
      path: '/projects/example',
      displayName: 'Remote project',
      idempotencyKey: 'remote-original',
      operationId: 'registration-a',
    });
    sessionStorage.setItem(key, saved);
    await render();
    expect(document.getElementById('managed-new-workspace-name')).toBeNull();
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBe(saved);
  });

  it('retains a hidden SSH operation until Managed mode becomes interactive', async () => {
    workspaceCreation();
    const registration = enableRegistration();
    registration.query.mockImplementation(() => new Promise(() => {}));
    const key = `qwen-managed-ssh-workspace-registration:${provider.storageKey}`;
    const saved = JSON.stringify({
      nodeId: 'mac',
      path: '/projects/example',
      displayName: 'Remote project',
      idempotencyKey: 'remote-original',
      operationId: 'registration-a',
    });
    sessionStorage.setItem(key, saved);
    await render(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(registration.query).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBe(saved);
    await render();
    expect(registration.query).toHaveBeenCalledWith(
      'registration-a',
      expect.objectContaining({ clientId: 'client-a' }),
    );
    expect(document.getElementById('managed-new-workspace-name')).toBeNull();
    expect(sessionStorage.getItem(key)).toBe(saved);
  });

  it('offers empty Workspace creation only with server capability and a provider method', async () => {
    workspaceCreation();
    vi.mocked(provider.workspaceBinding!.list).mockResolvedValue({
      data: [workspace],
      supported: true,
    });
    await render();
    expect(editorMocks.props?.scratchWorkspaceSupported).toBe(false);
    provider.workspaceBinding = {
      ...provider.workspaceBinding!,
      createWorkspace: undefined,
      list: vi.fn().mockResolvedValue({
        data: [workspace],
        supported: true,
        canCreateWorkspace: true,
      }),
    };
    await render();
    expect(editorMocks.props?.scratchWorkspaceSupported).toBe(false);
  });

  it('selects the created Workspace while retaining the composer draft and model', async () => {
    const createWorkspace = workspaceCreation();
    await render();
    const composerScope = editorMocks.props?.composerScopeKey;
    await act(async () => editorMocks.props!.onSelectModel!('agent-b'));
    await openWorkspaceCreation();
    await nameWorkspace('  Created  ');
    await click('Create workspace');
    expect(createWorkspace).toHaveBeenCalledWith(
      { displayName: 'Created' },
      expect.objectContaining({
        clientId: 'client-a',
        idempotencyKey: expect.any(String),
      }),
    );
    expect(editorMocks.props?.selectedWorkspaceCwd).toBe('ws-created');
    expect(editorMocks.props?.currentModel).toBe('agent-b');
    expect(editorMocks.props?.composerScopeKey).toBe(composerScope);
    expect(editorMocks.clearText).not.toHaveBeenCalled();
    expect(editorMocks.setText).not.toHaveBeenCalled();
    expect(provider.workspaceBinding?.createEmpty).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(
      sessionStorage.getItem(
        `qwen-managed-workspace-registration:${provider.storageKey}`,
      ),
    ).toBeNull();
  });

  it('selects an existing Linux project and restores its directory after reload', async () => {
    const created = {
      ...workspace,
      workspaceId: 'ws-project',
      displayName: 'Project',
      defaultCwdRelative: 'project',
    };
    const createWorkspace = workspaceCreation().mockResolvedValue(created);
    provider.workspaceBinding = {
      ...provider.workspaceBinding!,
      directories: vi.fn().mockResolvedValue({
        root: '/linux/projects',
        cwdRelative: '.',
        directories: [{ name: 'project', cwdRelative: 'project' }],
        truncated: false,
      }),
      list: vi.fn().mockResolvedValue({
        data: [{ ...workspace, canSelectDirectory: true }],
        defaultWorkspace: { ...workspace, canSelectDirectory: true },
        supported: true,
        canCreateWorkspace: true,
        canSelectDirectory: true,
      }),
      get: vi.fn().mockResolvedValue(created),
    };
    await render();
    await openWorkspaceCreation();
    await click('Choose existing directory');
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>(
        '#add-workspace-path',
      )!;
      expect(input).not.toBeNull();
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, '/linux/projects/project');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      document
        .querySelector('[role="dialog"] form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
      await flush();
    });
    expect(createWorkspace).toHaveBeenCalledWith(
      {
        displayName: 'project',
        sourceWorkspaceId: 'ws-a',
        cwdRelative: 'project',
      },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(
      container.querySelector<HTMLInputElement>('#managed-workspace-cwd')
        ?.value,
    ).toBe('project');
    expect(editorMocks.clearText).not.toHaveBeenCalled();
    await act(async () => root.render(null));
    await render();
    expect(provider.workspaceBinding.get).toHaveBeenCalledWith(
      'ws-project',
      expect.any(Object),
    );
    expect(
      container.querySelector<HTMLInputElement>('#managed-workspace-cwd')
        ?.value,
    ).toBe('project');
  });

  it('retries a persisted existing-directory creation without changing source or path', async () => {
    const createWorkspace = workspaceCreation().mockResolvedValue({
      ...workspace,
      workspaceId: 'ws-project',
      defaultCwdRelative: 'old/project',
    });
    vi.mocked(provider.workspaceBinding!.list).mockResolvedValue({
      data: [workspace],
      supported: true,
      canSelectDirectory: true,
    });
    sessionStorage.setItem(
      `qwen-managed-workspace-registration:${provider.storageKey}`,
      JSON.stringify({
        displayName: 'Project',
        sourceWorkspaceId: 'ws-a',
        cwdRelative: 'old/project',
        idempotencyKey: 'frozen-directory-key',
      }),
    );
    await render();
    await click('Retry the same request');
    expect(createWorkspace).toHaveBeenCalledWith(
      {
        displayName: 'Project',
        sourceWorkspaceId: 'ws-a',
        cwdRelative: 'old/project',
      },
      expect.objectContaining({ idempotencyKey: 'frozen-directory-key' }),
    );
    expect(
      container.querySelector<HTMLInputElement>('#managed-workspace-cwd')
        ?.value,
    ).toBe('old/project');
  });

  it.each([false, true])(
    'allows correcting a refused directory after abandoning local confirmation (refresh %s)',
    async (refresh) => {
      const createWorkspace = workspaceCreation()
        .mockRejectedValueOnce(
          new JavaManagedAgentHttpError(
            409,
            'workspace_unavailable',
            'Missing directory',
          ),
        )
        .mockResolvedValueOnce({
          ...workspace,
          workspaceId: 'ws-project',
          defaultCwdRelative: 'project',
        });
      provider.workspaceBinding = {
        ...provider.workspaceBinding!,
        directories: vi.fn().mockResolvedValue({
          root: '/linux/projects',
          cwdRelative: '.',
          directories: [{ name: 'project', cwdRelative: 'project' }],
          truncated: false,
        }),
        list: vi.fn().mockResolvedValue({
          data: [{ ...workspace, canSelectDirectory: true }],
          supported: true,
          canCreateWorkspace: true,
          canSelectDirectory: true,
        }),
      };
      await render();
      await openWorkspaceCreation();
      await submitDirectory('/linux/projects/missing');
      const key = `qwen-managed-workspace-registration:${provider.storageKey}`;
      const original = JSON.parse(sessionStorage.getItem(key)!);
      if (refresh) {
        await act(async () => root.render(null));
        await render();
      }
      expect(
        document.querySelector<HTMLInputElement>('#managed-new-workspace-name')
          ?.disabled,
      ).toBe(true);
      await click('Abandon local confirmation');
      expect(sessionStorage.getItem(key)).toBeNull();
      expect(
        document.querySelector<HTMLInputElement>('#managed-new-workspace-name')
          ?.disabled,
      ).toBe(false);
      await submitDirectory('/linux/projects/project');
      expect(createWorkspace).toHaveBeenCalledTimes(2);
      expect(createWorkspace.mock.calls[1][0]).toMatchObject({
        sourceWorkspaceId: 'ws-a',
        cwdRelative: 'project',
      });
      expect(createWorkspace.mock.calls[1][1].idempotencyKey).not.toBe(
        original.idempotencyKey,
      );
      expect(editorMocks.clearText).not.toHaveBeenCalled();
    },
  );

  it('allows empty Workspace creation after abandoning a persisted directory selection', async () => {
    const createWorkspace = workspaceCreation();
    sessionStorage.setItem(
      `qwen-managed-workspace-registration:${provider.storageKey}`,
      JSON.stringify({
        displayName: 'Missing',
        sourceWorkspaceId: 'ws-a',
        cwdRelative: 'missing',
        idempotencyKey: 'refused-directory',
      }),
    );
    await render();
    await click('Abandon local confirmation');
    expect(createWorkspace).not.toHaveBeenCalled();
    await nameWorkspace('New empty');
    await click('Create workspace');
    expect(createWorkspace).toHaveBeenCalledWith(
      { displayName: 'New empty' },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(createWorkspace.mock.calls[0][1].idempotencyKey).not.toBe(
      'refused-directory',
    );
  });

  it('freezes an uncertain creation across close and retry without issuing another operation', async () => {
    const createWorkspace = workspaceCreation()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ ...workspace, workspaceId: 'ws-created' });
    await render();
    await openWorkspaceCreation();
    await nameWorkspace('Created');
    await click('Create workspace');
    const saved = sessionStorage.getItem(
      `qwen-managed-workspace-registration:${provider.storageKey}`,
    );
    expect(JSON.parse(saved!)).toEqual({
      displayName: 'Created',
      idempotencyKey: expect.any(String),
    });
    expect(
      document.querySelector<HTMLInputElement>('#managed-new-workspace-name')
        ?.disabled,
    ).toBe(true);
    await click('Close');
    expect(createWorkspace).toHaveBeenCalledOnce();
    await click('Resume workspace creation');
    await click('Retry the same request');
    expect(createWorkspace).toHaveBeenCalledTimes(2);
    expect(createWorkspace.mock.calls[1][0]).toEqual(
      createWorkspace.mock.calls[0][0],
    );
    expect(createWorkspace.mock.calls[1][1].idempotencyKey).toBe(
      createWorkspace.mock.calls[0][1].idempotencyKey,
    );
    expect(editorMocks.props?.selectedWorkspaceCwd).toBe('ws-created');
  });

  it('resumes a persisted creation after refresh and hides its portal in Local mode', async () => {
    const createWorkspace = workspaceCreation();
    sessionStorage.setItem(
      `qwen-managed-workspace-registration:${provider.storageKey}`,
      JSON.stringify({ displayName: 'Saved', idempotencyKey: 'saved-key' }),
    );
    await render(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(createWorkspace).not.toHaveBeenCalled();
    await render();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(
      document.querySelector<HTMLInputElement>('#managed-new-workspace-name')
        ?.value,
    ).toBe('Saved');
    await click('Retry the same request');
    expect(createWorkspace).toHaveBeenCalledWith(
      { displayName: 'Saved' },
      expect.objectContaining({ idempotencyKey: 'saved-key' }),
    );
  });

  it.each(['workspace_unavailable', 'idempotency_conflict'])(
    'retains the same pending operation after a %s conflict',
    async (code) => {
      const createWorkspace = workspaceCreation().mockRejectedValueOnce(
        new JavaManagedAgentHttpError(409, code, 'Not yet confirmed'),
      );
      await render();
      await openWorkspaceCreation();
      await nameWorkspace('Created');
      await click('Create workspace');
      const saved = sessionStorage.getItem(
        `qwen-managed-workspace-registration:${provider.storageKey}`,
      );
      expect(saved).not.toBeNull();
      await click('Retry the same request');
      expect(createWorkspace.mock.calls[1][1].idempotencyKey).toBe(
        JSON.parse(saved!).idempotencyKey,
      );
    },
  );

  it('uses the WebShell portal root for the creation dialog', async () => {
    workspaceCreation();
    const portal = document.createElement('div');
    document.body.appendChild(portal);
    try {
      await act(async () => {
        root.render(
          <WebShellPortalRootContext.Provider value={portal}>
            <I18nProvider language="en">
              <WorkspaceBindingCreator
                provider={provider}
                clientId="client-a"
                onCreated={onCreated}
              />
            </I18nProvider>
          </WebShellPortalRootContext.Provider>,
        );
        await flush();
      });
      await openWorkspaceCreation();
      expect(portal.querySelector('[role="dialog"]')).not.toBeNull();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await act(async () => root.render(null));
      portal.remove();
    }
  });

  it.each(['   ', 'control\u0001name', 'a'.repeat(129)])(
    'rejects an invalid Workspace name before sending (%j)',
    async (name) => {
      const createWorkspace = workspaceCreation();
      await render();
      await openWorkspaceCreation();
      await nameWorkspace(name);
      const form = document.querySelector('[role="dialog"] form')!;
      await act(async () => {
        form.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
        await flush();
      });
      expect(createWorkspace).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        '1–128 characters',
      );
    },
  );

  it('serializes creation while keeping the composer blocked until read-back', async () => {
    let complete!: (value: typeof workspace) => void;
    const createWorkspace = workspaceCreation().mockReturnValue(
      new Promise<typeof workspace>((resolve) => {
        complete = resolve;
      }),
    );
    await render();
    await openWorkspaceCreation();
    await nameWorkspace('Created');
    await click('Create workspace');
    expect(editorMocks.props?.disabled).toBe(true);
    await click('Close');
    const sessionCommit = await sendInitial('keep my draft');
    expect(sessionCommit).not.toHaveBeenCalled();
    expect(provider.workspaceBinding?.createSession).not.toHaveBeenCalled();
    await act(async () => {
      complete({ ...workspace, workspaceId: 'ws-created' });
      await flush();
    });
    expect(createWorkspace).toHaveBeenCalledOnce();
    expect(editorMocks.props?.disabled).toBe(false);
  });

  it('allows correcting a definite initial rejection with a fresh key', async () => {
    const createWorkspace = workspaceCreation().mockRejectedValueOnce(
      new JavaManagedAgentHttpError(
        400,
        'invalid_workspace_name',
        'Name refused',
      ),
    );
    await render();
    await openWorkspaceCreation();
    await nameWorkspace('Refused');
    await click('Create workspace');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Name refused',
    );
    expect(
      document.querySelector<HTMLInputElement>('#managed-new-workspace-name')
        ?.disabled,
    ).toBe(false);
    await nameWorkspace('Corrected');
    await click('Create workspace');
    expect(createWorkspace.mock.calls[1][0]).toEqual({
      displayName: 'Corrected',
    });
    expect(createWorkspace.mock.calls[1][1].idempotencyKey).not.toBe(
      createWorkspace.mock.calls[0][1].idempotencyKey,
    );
  });

  it('does not send a creation unless the frozen request can be persisted', async () => {
    const createWorkspace = workspaceCreation();
    await render();
    await openWorkspaceCreation();
    await nameWorkspace('Created');
    const write = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('unavailable');
      });
    try {
      await click('Create workspace');
      expect(createWorkspace).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'Browser session storage',
      );
    } finally {
      write.mockRestore();
    }
  });

  it('blocks a hidden composer while keeping its Workspace selection and owner', async () => {
    directCreation();
    await render();
    await act(async () => editorMocks.props!.onSelectWorkspace!('ws-a'));
    const editorNode = container.querySelector('[data-testid="shared-editor"]');
    await render(false);
    expect(editorMocks.props?.disabled).toBe(true);
    expect(editorMocks.props?.dialogOpen).toBe(true);
    expect(editorMocks.props?.visibleToolbarActions).toEqual([]);
    expect(container.querySelector('[data-testid="shared-editor"]')).toBe(
      editorNode,
    );
    await render();
    expect(editorMocks.props?.disabled).toBe(false);
    expect(editorMocks.props?.dialogOpen).toBe(false);
    expect(editorMocks.props?.selectedWorkspaceCwd).toBe('ws-a');
    expect(provider.workspaceBinding?.list).toHaveBeenCalledOnce();
  });

  it('asks for a Workspace instead of sending a first input without one', async () => {
    const createSession = directCreation();
    provider.workspaceBinding = {
      ...provider.workspaceBinding!,
      list: vi.fn().mockResolvedValue({
        data: [
          workspace,
          { ...workspace, workspaceId: 'ws-b', displayName: 'B' },
        ],
        supported: true,
      }),
    };
    await render();
    const commit = await sendInitial('Read README');
    expect(createSession).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Choose a Workspace',
    );
  });

  it('reuses the standard welcome and native editor controls for direct initial admission', async () => {
    const createSession = directCreation();
    await render();
    expect(container.textContent).toContain('Welcome to');
    expect(container.textContent).not.toContain('Create a Workspace session');
    expect(editorMocks.props).toEqual(
      expect.objectContaining({
        contextChipPlacement: 'below',
        visibleToolbarActions: ['model', 'workspace'],
        workspaceSelectorAlwaysVisible: true,
        shellModeEnabled: false,
        disableLegacyHistoryFallback: true,
        workspaceFeaturesEnabled: false,
      }),
    );
    const commit = await sendInitial('Read README');
    expect(createSession).toHaveBeenCalledExactlyOnceWith(
      {
        agentId: 'agent-a',
        workspaceId: 'ws-a',
        cwdRelative: '.',
        text: 'Read README',
      },
      expect.objectContaining({
        clientId: 'client-a',
        idempotencyKey: expect.any(String),
      }),
    );
    expect(createEmpty).not.toHaveBeenCalled();
    expect(provider.submitPrompt).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledExactlyOnceWith('session-a');
  });

  it('freezes the initial prompt and choices, then retries only read-back after creation', async () => {
    const createSession = directCreation();
    createSession.mockRejectedValueOnce(new TypeError('Lost response'));
    getSession.mockRejectedValueOnce(new TypeError('Read failed'));
    await render();
    const commit = await sendInitial('Frozen input');
    await act(async () => {
      editorMocks.props!.onSelectModel!('agent-b');
      editorMocks.props!.onSelectWorkspace!('ws-other');
    });
    expect(editorMocks.props!.currentModel).toBe('agent-a');
    expect(editorMocks.props!.selectedWorkspaceCwd).toBe('ws-a');
    expect(commit).not.toHaveBeenCalled();
    await click('Retry the same request');
    expect(createSession.mock.calls[1]).toEqual(createSession.mock.calls[0]);
    expect(commit).not.toHaveBeenCalled();
    await click('Retry reading session');
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(provider.submitPrompt).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledExactlyOnceWith('session-a');
  });

  it('does not silently pick a sole Workspace when the server has no default', async () => {
    const createSession = directCreation();
    vi.mocked(provider.workspaceBinding!.list).mockResolvedValue({
      data: [workspace],
      supported: true,
    });
    await render();
    expect(editorMocks.props!.selectedWorkspaceCwd).toBe('');
    expect(editorMocks.props!.workspaceSelectorAlwaysVisible).toBe(true);
    const rejectedCommit = await sendInitial('Read');
    expect(createSession).not.toHaveBeenCalled();
    expect(rejectedCommit).not.toHaveBeenCalled();
    await act(async () => editorMocks.props!.onSelectWorkspace!('ws-a'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await sendInitial('Read');
    expect(createSession).toHaveBeenCalledOnce();
  });

  it('shows a rejected directory above the collapsed controls without committing the draft', async () => {
    const createSession = directCreation();
    createSession.mockRejectedValue(
      new JavaManagedAgentHttpError(400, 'invalid_cwd', 'Invalid directory'),
    );
    await render();
    const commit = await sendInitial('Keep this input');
    expect(container.querySelector('details')?.open).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Invalid directory',
    );
    expect(container.querySelector('details [role="alert"]')).toBeNull();
    expect(commit).not.toHaveBeenCalled();
    expect(editorMocks.clearText).not.toHaveBeenCalled();
  });

  it('recovers frozen initial input and restores it after abandoning an uncertain request', async () => {
    const createSession = directCreation();
    createSession.mockRejectedValue(new TypeError('Lost response'));
    await render();
    await sendInitial('Keep my draft');
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(editorMocks.props!.composerInput).toEqual({ text: 'Keep my draft' });
    expect(container.textContent).toContain(
      'A session with this input may already exist or be running.',
    );
    expect(container.textContent).toContain('may repeat its effects');
    await click('Abandon local confirmation');
    expect(onAbandoned).toHaveBeenCalledOnce();
    expect(editorMocks.setText).toHaveBeenCalledExactlyOnceWith(
      'Keep my draft',
    );
    expect(editorMocks.clearText).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledOnce();
  });

  it('replays an older empty creation as empty even when direct input is supported', async () => {
    const createSession = directCreation();
    sessionStorage.setItem(
      `qwen-managed-workspace-create:${provider.storageKey}`,
      JSON.stringify({
        agentId: 'agent-a',
        workspaceId: 'ws-a',
        cwdRelative: '.',
        input: [],
        clientId: 'old-client',
        idempotencyKey: 'old-key',
      }),
    );
    createEmpty.mockResolvedValue({ sessionId: 'session-a' });
    await render();
    await click('Retry the same request');
    expect(createSession).not.toHaveBeenCalled();
    expect(createEmpty).toHaveBeenCalledWith(
      { agentId: 'agent-a', workspaceId: 'ws-a', cwdRelative: '.' },
      expect.objectContaining({
        clientId: 'old-client',
        idempotencyKey: 'old-key',
      }),
    );
    expect(editorMocks.clearText).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledExactlyOnceWith('session-a');
  });

  it('freezes the selected model across an unconfirmed create and checks the returned Agent identity', async () => {
    provider = {
      ...provider,
      workspaceBinding: {
        ...provider.workspaceBinding!,
        modelPresets: [
          { agentId: 'agent-a', label: 'Model A' },
          { agentId: 'agent-b', label: 'Model B' },
        ],
      },
    };
    createEmpty
      .mockRejectedValueOnce(new TypeError('Lost response'))
      .mockResolvedValue({ sessionId: 'session-b' });
    getSession.mockResolvedValue({
      sessionId: 'session-b',
      agentId: 'wrong-agent',
      workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
    });
    await render();
    await act(async () =>
      container.querySelector<HTMLElement>('#managed-model-select')!.click(),
    );
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((item) => item.textContent === 'Model B')!
        .click(),
    );
    await click('Create session');
    expect(container.querySelector('#managed-model-select')).toBeNull();
    provider = {
      ...provider,
      workspaceBinding: { ...provider.workspaceBinding!, modelPresets: [] },
    };
    await render();
    await click('Retry the same request');
    expect(createEmpty.mock.calls[0][0].agentId).toBe('agent-b');
    expect(createEmpty.mock.calls[1][0]).toEqual(createEmpty.mock.calls[0][0]);
    expect(createEmpty.mock.calls[1][1].idempotencyKey).toBe(
      createEmpty.mock.calls[0][1].idempotencyKey,
    );
    expect(onCreated).not.toHaveBeenCalled();
    getSession.mockResolvedValue({
      sessionId: 'session-b',
      agentId: 'agent-b',
      workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
    });
    await click('Retry reading session');
    expect(createEmpty).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledWith('session-b');
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
        buttons.some((item) => item.textContent?.startsWith('Retry')),
      ).toBe(false);
      expect(
        buttons.some(
          (item) => item.textContent === 'Abandon local confirmation',
        ),
      ).toBe(false);
      expect(container.textContent).not.toContain('Creation is unconfirmed');
      await act(async () => {
        resolveCommand(session);
        await flush();
      });
      expect(createEmpty).toHaveBeenCalledTimes(1);
      expect(getSession).toHaveBeenCalledTimes(1);
      expect(onCreated).toHaveBeenCalledExactlyOnceWith('session-a');
      expect(
        sessionStorage.getItem(
          `qwen-managed-workspace-create:${provider.storageKey}`,
        ),
      ).toBeNull();
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
    expect(
      sessionStorage.getItem(
        `qwen-managed-workspace-create:${provider.storageKey}`,
      ),
    ).toBeNull();
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
      expect(
        sessionStorage.getItem(
          `qwen-managed-workspace-create:${provider.storageKey}`,
        ),
      ).not.toBeNull();
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
    expect(
      sessionStorage.getItem(
        `qwen-managed-workspace-create:${provider.storageKey}`,
      ),
    ).toBeNull();
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
      .spyOn(Object.getPrototypeOf(sessionStorage) as Storage, 'setItem')
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
