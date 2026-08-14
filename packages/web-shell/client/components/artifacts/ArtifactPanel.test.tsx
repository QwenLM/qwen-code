// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonSessionArtifact,
  DaemonSessionMonitorTaskStatus,
  DaemonSessionShellTaskStatus,
} from '@qwen-code/sdk/daemon';
import type {
  DaemonScheduledTask,
  DaemonSessionActions,
} from '@qwen-code/webui/daemon-react-sdk';
import { I18nProvider } from '../../i18n';
import { TOAST_REQUEST_EVENT, type ToastRequestDetail } from '../ToastHost';
import type { ArtifactWorkspaceTarget } from './useArtifactWorkspaceTarget';
import type { TurnOutputScheduledTask } from './TurnOutputs';

const {
  mockActions,
  mockWorkspace,
  mockWorkspaceActions,
  mockSecondaryWorkspaceActions,
} = vi.hoisted(() => {
  const mockSecondaryWorkspaceActions = {
    readWorkspaceFile: vi.fn(),
    readWorkspaceFileBytes: vi.fn(),
    fileStat: vi.fn(),
  };
  return {
    mockActions: {
      cancelTask: vi.fn(),
      getTasks: vi.fn(),
    },
    mockWorkspaceActions: {
      readFileBytes: vi.fn(),
      readWorkspaceFile: vi.fn(),
      stat: vi.fn(),
      listScheduledTasks: vi.fn(),
      updateScheduledTask: vi.fn(),
      deleteScheduledTask: vi.fn(),
    },
    mockSecondaryWorkspaceActions,
    mockWorkspace: {
      capabilities: {
        workspaceCwd: '/primary',
        workspaces: [
          {
            id: 'primary-id',
            cwd: '/primary',
            primary: true,
            trusted: true,
          },
          {
            id: 'secondary-id',
            cwd: '/secondary',
            primary: false,
            trusted: true,
          },
        ],
      },
      client: {
        workspaceByCwd: vi.fn(() => mockSecondaryWorkspaceActions),
      },
    },
  };
});

vi.mock(
  '@qwen-code/webui/daemon-react-sdk',
  async (importOriginal: () => Promise<Record<string, unknown>>) => ({
    ...(await importOriginal()),
    useActions: () => mockActions,
    useWorkspace: () => mockWorkspace,
    useWorkspaceActions: () => mockWorkspaceActions,
  }),
);

const { ArtifactPanel } = await import('./ArtifactPanel');
const { useArtifactWorkspaceTarget } = await import(
  './useArtifactWorkspaceTarget'
);

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
let latestArtifactWorkspaceTarget: ArtifactWorkspaceTarget | undefined;

function ArtifactWorkspaceTargetProbe({ revision }: { revision: number }) {
  latestArtifactWorkspaceTarget = useArtifactWorkspaceTarget('/secondary');
  return <span data-revision={revision} />;
}

function monitorPanel(
  task: DaemonSessionMonitorTaskStatus,
  sessionActions?: DaemonSessionActions,
) {
  return (
    <I18nProvider language="en">
      <ArtifactPanel
        artifacts={[]}
        tabs={[
          {
            id: 'monitor:monitor-1',
            kind: 'monitor',
            title: task.description,
            task,
            sessionActions,
          },
        ]}
        activeTabId="monitor:monitor-1"
        reviewChanges={[]}
        selectedReviewPath={null}
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onOpenFilePreview={() => {}}
        onClose={() => {}}
      />
    </I18nProvider>
  );
}

function shellPanel(task: DaemonSessionShellTaskStatus) {
  return (
    <I18nProvider language="en">
      <ArtifactPanel
        artifacts={[]}
        tabs={[
          {
            id: 'shell:shell-1',
            kind: 'shell',
            title: task.command,
            task,
          },
        ]}
        activeTabId="shell:shell-1"
        reviewChanges={[]}
        selectedReviewPath={null}
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onOpenFilePreview={() => {}}
        onClose={() => {}}
      />
    </I18nProvider>
  );
}

function codeReviewArtifact(
  patch: Partial<DaemonSessionArtifact> = {},
): DaemonSessionArtifact {
  return {
    id: 'review-artifact',
    kind: 'other',
    storage: 'workspace',
    source: 'tool',
    status: 'available',
    title: 'Code review result',
    workspacePath: '.qwen/reviews/review.json',
    metadata: { artifactType: 'code_review', schemaVersion: 1 },
    retention: 'ephemeral',
    clientRetained: false,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    ...patch,
  };
}

const validCodeReviewDocument = JSON.stringify({
  schemaVersion: 1,
  target: 'local',
  effort: 'high',
  verdict: {
    event: 'APPROVE',
    verdictLine: 'Verdict: Approve',
    baseEvent: 'APPROVE',
    cappedBy: [],
    downgraded: false,
    downgradedFrom: null,
  },
  findings: [],
  counts: {
    total: 0,
    bySeverity: {
      Critical: 0,
      Suggestion: 0,
      'Nice to have': 0,
    },
    byConfidence: { high: 0, low: 0 },
    held: 0,
  },
  outcomesRecorded: false,
  markdownReportPath: '.qwen/reviews/review.md',
});

function linkArtifact(): DaemonSessionArtifact {
  return {
    id: 'review-artifact',
    kind: 'link',
    storage: 'external_url',
    source: 'tool',
    status: 'available',
    title: 'Issue 9059',
    url: 'https://github.com/QwenLM/qwen-code/issues/9059',
    retention: 'ephemeral',
    clientRetained: false,
    createdAt: '2026-08-13T06:13:59.048Z',
    updatedAt: '2026-08-13T06:13:59.048Z',
  };
}

function artifactPanel(
  artifact: DaemonSessionArtifact,
  owner: { workspaceCwd: string; workspaceId: string } | null = {
    workspaceCwd: '/primary',
    workspaceId: 'primary-id',
  },
) {
  return (
    <I18nProvider language="en">
      <ArtifactPanel
        artifacts={[artifact]}
        tabs={[
          {
            id: 'artifact:review-artifact',
            kind: 'artifact',
            title: artifact.title,
            artifactId: artifact.id,
            ...(owner ?? {}),
          },
        ]}
        activeTabId="artifact:review-artifact"
        reviewChanges={[]}
        selectedReviewPath={null}
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onOpenFilePreview={() => {}}
        onClose={() => {}}
      />
    </I18nProvider>
  );
}

const secondaryScheduledTask: DaemonScheduledTask = {
  id: 'cron-secondary',
  name: 'Secondary task',
  cron: '0 9 * * *',
  prompt: 'secondary only',
  recurring: true,
  enabled: true,
  createdAt: 1_700_000_000_000,
  lastFiredAt: null,
  nextRunAt: null,
  sessionId: null,
  runs: [],
};

function scheduledTaskPanel(
  options: {
    workspaceCwd?: string;
    workspaceId?: string;
    task?: Partial<TurnOutputScheduledTask>;
  } = {},
) {
  const workspaceCwd = options.workspaceCwd ?? '/secondary';
  const workspaceId = Object.hasOwn(options, 'workspaceId')
    ? options.workspaceId
    : 'secondary-id';
  const taskPatch = options.task ?? {};
  const task: TurnOutputScheduledTask = {
    id: 'cron-secondary',
    toolCallId: 'cron-call',
    title: 'Secondary task',
    cron: '0 9 * * *',
    prompt: 'secondary only',
    recurring: true,
    durable: true,
    workspaceId,
    ...taskPatch,
  };
  return (
    <I18nProvider language="en">
      <ArtifactPanel
        artifacts={[]}
        tabs={[
          {
            id: 'scheduled-task:secondary:cron-call',
            kind: 'scheduled_task',
            title: 'Scheduled Tasks',
            workspaceCwd,
            workspaceId,
            task,
          },
        ]}
        activeTabId="scheduled-task:secondary:cron-call"
        reviewChanges={[]}
        selectedReviewPath={null}
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onOpenFilePreview={() => {}}
        onClose={() => {}}
      />
    </I18nProvider>
  );
}

afterEach(() => {
  delete (window as { __TAURI__?: unknown }).__TAURI__;
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted.length = 0;
  mockActions.cancelTask.mockReset();
  mockActions.getTasks.mockReset();
  mockWorkspaceActions.readFileBytes.mockReset();
  mockWorkspaceActions.readWorkspaceFile.mockReset();
  mockWorkspaceActions.stat.mockReset();
  mockWorkspaceActions.listScheduledTasks.mockReset();
  mockWorkspaceActions.updateScheduledTask.mockReset();
  mockWorkspaceActions.deleteScheduledTask.mockReset();
  mockSecondaryWorkspaceActions.readWorkspaceFile.mockReset();
  mockSecondaryWorkspaceActions.readWorkspaceFileBytes.mockReset();
  mockSecondaryWorkspaceActions.fileStat.mockReset();
  mockWorkspace.client.workspaceByCwd.mockClear();
  latestArtifactWorkspaceTarget = undefined;
  mockWorkspace.capabilities = {
    workspaceCwd: '/primary',
    workspaces: [
      {
        id: 'primary-id',
        cwd: '/primary',
        primary: true,
        trusted: true,
      },
      {
        id: 'secondary-id',
        cwd: '/secondary',
        primary: false,
        trusted: true,
      },
    ],
  };
});

describe('artifact workspace authority', () => {
  it('keeps an in-flight read across an equivalent capabilities refresh', async () => {
    let resolveRead:
      | ((file: { content: string; truncated: boolean }) => void)
      | undefined;
    mockSecondaryWorkspaceActions.readWorkspaceFile.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => root.render(<ArtifactWorkspaceTargetProbe revision={0} />));
    const initialActions = latestArtifactWorkspaceTarget?.actions;
    const read = initialActions?.readWorkspaceFile('report.json');

    mockWorkspace.capabilities = {
      ...mockWorkspace.capabilities,
      workspaces: mockWorkspace.capabilities.workspaces.map((entry) => ({
        ...entry,
      })),
    };
    act(() => root.render(<ArtifactWorkspaceTargetProbe revision={1} />));

    expect(latestArtifactWorkspaceTarget?.actions).toBe(initialActions);
    resolveRead?.({ content: 'still-owned', truncated: false });
    await expect(read).resolves.toEqual({
      content: 'still-owned',
      truncated: false,
    });
  });

  it('does not revive an old read after the same owner is removed and re-added', async () => {
    let resolveRead:
      | ((file: { content: string; truncated: boolean }) => void)
      | undefined;
    mockSecondaryWorkspaceActions.readWorkspaceFile.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => root.render(<ArtifactWorkspaceTargetProbe revision={0} />));
    const initialActions = latestArtifactWorkspaceTarget?.actions;
    const read = initialActions?.readWorkspaceFile('report.json');

    mockWorkspace.capabilities = {
      ...mockWorkspace.capabilities,
      workspaces: [mockWorkspace.capabilities.workspaces[0]!],
    };
    act(() => root.render(<ArtifactWorkspaceTargetProbe revision={1} />));
    expect(latestArtifactWorkspaceTarget).toBeUndefined();

    mockWorkspace.capabilities = {
      ...mockWorkspace.capabilities,
      workspaces: [
        mockWorkspace.capabilities.workspaces[0]!,
        {
          id: 'secondary-id',
          cwd: '/secondary',
          primary: false,
          trusted: true,
        },
      ],
    };
    act(() => root.render(<ArtifactWorkspaceTargetProbe revision={2} />));
    expect(latestArtifactWorkspaceTarget).toBeDefined();
    expect(latestArtifactWorkspaceTarget?.actions).not.toBe(initialActions);

    resolveRead?.({ content: 'stale-secret', truncated: false });
    await expect(read).rejects.toThrow(
      'Workspace artifact owner is no longer available',
    );
  });

  it('revokes every pending file read when its owner is removed', async () => {
    let resolveText:
      | ((file: { content: string; truncated: boolean }) => void)
      | undefined;
    let resolveBytes:
      | ((file: {
          contentBase64: string;
          offset: number;
          returnedBytes: number;
          sizeBytes: number;
        }) => void)
      | undefined;
    let resolveStat:
      | ((stat: { sizeBytes: number; modifiedMs: number }) => void)
      | undefined;
    mockSecondaryWorkspaceActions.readWorkspaceFile.mockReturnValue(
      new Promise((resolve) => {
        resolveText = resolve;
      }),
    );
    mockSecondaryWorkspaceActions.readWorkspaceFileBytes.mockReturnValue(
      new Promise((resolve) => {
        resolveBytes = resolve;
      }),
    );
    mockSecondaryWorkspaceActions.fileStat.mockReturnValue(
      new Promise((resolve) => {
        resolveStat = resolve;
      }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => root.render(<ArtifactWorkspaceTargetProbe revision={0} />));
    const actions = latestArtifactWorkspaceTarget?.actions;
    expect(actions).toBeDefined();
    const textRead = actions?.readWorkspaceFile('report.txt');
    const bytesRead = actions?.readFileBytes('report.bin', {
      offset: 0,
      maxBytes: 1024,
    });
    const statRead = actions?.stat('report.bin');

    mockWorkspace.capabilities = {
      ...mockWorkspace.capabilities,
      workspaces: [mockWorkspace.capabilities.workspaces[0]!],
    };
    act(() => root.render(<ArtifactWorkspaceTargetProbe revision={1} />));

    resolveText?.({ content: 'stale-text', truncated: false });
    resolveBytes?.({
      contentBase64: btoa('stale-bytes'),
      offset: 0,
      returnedBytes: 11,
      sizeBytes: 11,
    });
    resolveStat?.({ sizeBytes: 11, modifiedMs: 1 });
    await expect(textRead).rejects.toThrow(
      'Workspace artifact owner is no longer available',
    );
    await expect(bytesRead).rejects.toThrow(
      'Workspace artifact owner is no longer available',
    );
    await expect(statRead).rejects.toThrow(
      'Workspace artifact owner is no longer available',
    );
  });
});

function openAddMenu(container: HTMLElement) {
  const add = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Add panel"]',
  );
  act(() => {
    add?.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
    );
  });
  return add;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ArtifactPanel code review artifacts', () => {
  it('fails closed when an artifact tab has no workspace owner', async () => {
    mockWorkspaceActions.readWorkspaceFile.mockResolvedValue({
      content: 'PRIMARY_WORKSPACE_SECRET',
      truncated: false,
    });
    const artifact = codeReviewArtifact({ metadata: {} });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => root.render(artifactPanel(artifact, null)));
    await flush();

    expect(container.textContent).toContain(
      'This workspace may have been removed or the link is no longer valid.',
    );
    expect(mockWorkspaceActions.readWorkspaceFile).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('PRIMARY_WORKSPACE_SECRET');
  });

  it('fails closed when a file tab has no workspace owner', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[
              {
                id: 'file:missing-owner',
                kind: 'file',
                title: 'Missing owner',
                workspacePath: 'secret.txt',
                workspaceCwd: '/unknown',
                workspaceId: 'missing-id',
              },
            ]}
            activeTabId="file:missing-owner"
            reviewChanges={[]}
            selectedReviewPath={null}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      ),
    );
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'This workspace may have been removed',
    );
    expect(mockWorkspaceActions.readFileBytes).not.toHaveBeenCalled();
    expect(mockWorkspaceActions.stat).not.toHaveBeenCalled();
  });

  it('dispatches an available workspace artifact to the dedicated renderer', async () => {
    mockWorkspaceActions.readWorkspaceFile.mockResolvedValue({
      content: validCodeReviewDocument,
      truncated: false,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => root.render(artifactPanel(codeReviewArtifact())));
    await flush();

    expect(container.textContent).toContain('Authoritative verdict');
    expect(container.textContent).toContain('Verdict: Approve');
    expect(container.querySelector('.cm-editor')).toBeNull();
    expect(mockWorkspaceActions.readWorkspaceFile).toHaveBeenCalledWith(
      '.qwen/reviews/review.json',
    );
  });

  it('loads an artifact under StrictMode effect replay', async () => {
    mockWorkspaceActions.readWorkspaceFile.mockResolvedValue({
      content: validCodeReviewDocument,
      truncated: false,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        <StrictMode>{artifactPanel(codeReviewArtifact())}</StrictMode>,
      ),
    );
    await flush();

    expect(container.textContent).toContain('Authoritative verdict');
    expect(container.textContent).not.toContain(
      'Workspace artifact owner is no longer available',
    );
  });

  it.each(['changed', 'missing'] as const)(
    'does not render a %s artifact as authoritative',
    async (status) => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      mounted.push({ root, container });

      act(() => root.render(artifactPanel(codeReviewArtifact({ status }))));
      await flush();

      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        status,
      );
      expect(container.textContent).not.toContain('Authoritative verdict');
      expect(mockWorkspaceActions.readWorkspaceFile).not.toHaveBeenCalled();
    },
  );

  it('requires code review artifacts to use workspace storage', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        artifactPanel(
          codeReviewArtifact({
            storage: 'external_url',
            workspacePath: undefined,
          }),
        ),
      ),
    );
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'workspace files',
    );
    expect(mockWorkspaceActions.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('opens external_url link artifacts through the desktop opener', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => root.render(artifactPanel(linkArtifact())));
    await flush();

    const button = Array.from(container.querySelectorAll('a')).find(
      (el) => el.textContent === 'Open link',
    );
    expect(button).toBeTruthy();
    expect(button!.getAttribute('href')).toBe(
      'https://github.com/QwenLM/qwen-code/issues/9059',
    );
    expect(button!.getAttribute('target')).toBe('_blank');
    act(() => {
      button!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
      url: 'https://github.com/QwenLM/qwen-code/issues/9059',
    });
  });

  it('routes modified external_url link clicks through the desktop opener', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => root.render(artifactPanel(linkArtifact())));
    await flush();

    const button = Array.from(container.querySelectorAll('a')).find(
      (el) => el.textContent === 'Open link',
    );
    expect(button).toBeTruthy();
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 1,
      ctrlKey: true,
    });
    act(() => {
      button!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
      url: 'https://github.com/QwenLM/qwen-code/issues/9059',
    });
  });

  it('requests an error toast when opening a link artifact fails', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('no browser'));
    (window as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    const toasts: ToastRequestDetail[] = [];
    const onToast = (e: Event) =>
      toasts.push((e as CustomEvent<ToastRequestDetail>).detail);
    window.addEventListener(TOAST_REQUEST_EVENT, onToast);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => root.render(artifactPanel(linkArtifact())));
    await flush();

    const button = Array.from(container.querySelectorAll('a')).find(
      (el) => el.textContent === 'Open link',
    );
    expect(button).toBeTruthy();
    act(() => {
      button!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    await flush();
    window.removeEventListener(TOAST_REQUEST_EVENT, onToast);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].tone).toBe('error');
    expect(toasts[0].message).toContain('no browser');
  });

  it('keeps relative link artifacts on the native anchor path', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(artifactPanel({ ...linkArtifact(), url: '#artifact' })),
    );
    await flush();

    const button = Array.from(container.querySelectorAll('a')).find(
      (el) => el.textContent === 'Open link',
    );
    expect(button).toBeTruthy();
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    act(() => {
      button!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('still sends an ordinary JSON artifact to the generic editor', async () => {
    // The regression the early `return` in the dispatch can cause: an
    // artifact WITHOUT the code_review metadata must keep reaching the
    // generic file preview, not the dedicated renderer.
    mockWorkspaceActions.readWorkspaceFile.mockResolvedValue({
      content: '{}',
      truncated: false,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => root.render(artifactPanel(codeReviewArtifact({ metadata: {} }))));
    await flush();

    expect(container.querySelector('.cm-editor')).not.toBeNull();
    expect(container.textContent).not.toContain('Authoritative verdict');
    expect(mockWorkspaceActions.readWorkspaceFile).toHaveBeenCalledWith(
      '.qwen/reviews/review.json',
    );
  });

  it('discards a pending read when its workspace owner is replaced', async () => {
    let resolveRead:
      | ((file: { content: string; truncated: boolean }) => void)
      | undefined;
    mockSecondaryWorkspaceActions.readWorkspaceFile.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    const artifact = codeReviewArtifact({ metadata: {} });
    const owner = {
      workspaceCwd: '/secondary',
      workspaceId: 'secondary-id',
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => root.render(artifactPanel(artifact, owner)));
    await flush();
    expect(mockWorkspace.client.workspaceByCwd).toHaveBeenCalledWith(
      '/secondary',
    );

    mockWorkspace.capabilities = {
      ...mockWorkspace.capabilities,
      workspaces: [
        mockWorkspace.capabilities.workspaces[0]!,
        {
          id: 'secondary-replacement-id',
          cwd: '/secondary',
          primary: false,
          trusted: true,
        },
      ],
    };
    act(() => root.render(artifactPanel(artifact, owner)));
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'removed',
    );

    await act(async () => {
      resolveRead?.({ content: 'REMOVED_WORKSPACE_SECRET', truncated: false });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('REMOVED_WORKSPACE_SECRET');
    expect(mockWorkspaceActions.readWorkspaceFile).not.toHaveBeenCalled();
  });
});

describe('ArtifactPanel scheduled-task ownership', () => {
  it('loads a durable task through its secondary workspace route', async () => {
    mockWorkspaceActions.listScheduledTasks.mockResolvedValue([]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => root.render(scheduledTaskPanel()));
    await flush();

    expect(mockWorkspaceActions.listScheduledTasks).toHaveBeenCalledWith(
      'secondary-id',
    );
  });

  it('updates and deletes only through the task workspace id', async () => {
    mockWorkspaceActions.listScheduledTasks.mockResolvedValue([
      secondaryScheduledTask,
    ]);
    mockWorkspaceActions.updateScheduledTask.mockResolvedValue({
      ...secondaryScheduledTask,
      enabled: false,
    });
    mockWorkspaceActions.deleteScheduledTask.mockResolvedValue(undefined);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => root.render(scheduledTaskPanel()));
    await flush();

    const disable = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Disable',
    );
    await act(async () => {
      disable?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockWorkspaceActions.updateScheduledTask).toHaveBeenCalledWith(
      'cron-secondary',
      { enabled: false },
      'secondary-id',
    );

    const openDelete = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Delete',
    );
    act(() => openDelete?.click());
    const confirmDelete = Array.from(document.body.querySelectorAll('button'))
      .filter((button) => button.textContent?.trim() === 'Delete')
      .at(-1);
    await act(async () => {
      confirmDelete?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockWorkspaceActions.deleteScheduledTask).toHaveBeenCalledWith(
      'cron-secondary',
      'secondary-id',
    );
  });

  it('fails closed for a durable task whose workspace owner is unavailable', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        scheduledTaskPanel({
          workspaceCwd: '/unknown',
          workspaceId: 'missing-id',
          task: { workspaceId: 'missing-id' },
        }),
      ),
    );
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'This workspace may have been removed',
    );
    expect(mockWorkspaceActions.listScheduledTasks).not.toHaveBeenCalled();
    expect(mockWorkspaceActions.updateScheduledTask).not.toHaveBeenCalled();
    expect(mockWorkspaceActions.deleteScheduledTask).not.toHaveBeenCalled();
  });

  it('shows a session-scoped task snapshot without a workspace owner', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        scheduledTaskPanel({
          workspaceCwd: '/unknown',
          workspaceId: 'missing-id',
          task: {
            id: 'session-task',
            durable: false,
            prompt: 'local session snapshot',
            workspaceId: 'missing-id',
          },
        }),
      ),
    );
    await flush();

    expect(container.textContent).toContain('session-scoped scheduled task');
    expect(container.textContent).toContain('local session snapshot');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(mockWorkspaceActions.listScheduledTasks).not.toHaveBeenCalled();
  });

  it('keeps legacy single-workspace scheduled-task routes unqualified', async () => {
    mockWorkspace.capabilities = {
      workspaceCwd: '/primary',
    } as typeof mockWorkspace.capabilities;
    mockWorkspaceActions.listScheduledTasks.mockResolvedValue([
      secondaryScheduledTask,
    ]);
    mockWorkspaceActions.updateScheduledTask.mockResolvedValue({
      ...secondaryScheduledTask,
      enabled: false,
    });
    mockWorkspaceActions.deleteScheduledTask.mockResolvedValue(undefined);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        scheduledTaskPanel({
          workspaceCwd: '/primary',
          workspaceId: undefined,
          task: { workspaceId: undefined },
        }),
      ),
    );
    await flush();
    expect(mockWorkspaceActions.listScheduledTasks).toHaveBeenCalledWith(
      undefined,
    );

    const disable = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Disable',
    );
    await act(async () => {
      disable?.click();
      await Promise.resolve();
    });
    expect(mockWorkspaceActions.updateScheduledTask).toHaveBeenCalledWith(
      'cron-secondary',
      { enabled: false },
      undefined,
    );

    const openDelete = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Delete',
    );
    act(() => openDelete?.click());
    const confirmDelete = Array.from(document.body.querySelectorAll('button'))
      .filter((button) => button.textContent?.trim() === 'Delete')
      .at(-1);
    await act(async () => {
      confirmDelete?.click();
      await Promise.resolve();
    });
    expect(mockWorkspaceActions.deleteScheduledTask).toHaveBeenCalledWith(
      'cron-secondary',
      undefined,
    );
  });

  it.each(['save', 'toggle', 'delete'] as const)(
    'settles a pending reload after a %s mutation',
    async (mutation) => {
      let resolveReload: ((tasks: DaemonScheduledTask[]) => void) | undefined;
      mockWorkspaceActions.listScheduledTasks
        .mockResolvedValueOnce([secondaryScheduledTask])
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveReload = resolve;
          }),
        );
      const updatedTask = {
        ...secondaryScheduledTask,
        name: `${mutation} result`,
        enabled: false,
      };
      mockWorkspaceActions.updateScheduledTask.mockResolvedValue(updatedTask);
      mockWorkspaceActions.deleteScheduledTask.mockResolvedValue(undefined);
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      mounted.push({ root, container });

      act(() => root.render(scheduledTaskPanel()));
      await flush();
      act(() =>
        root.render(
          scheduledTaskPanel({ task: { prompt: `reload ${mutation}` } }),
        ),
      );
      await flush();
      expect(container.textContent).toContain('Loading…');

      if (mutation === 'save') {
        const edit = Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === 'Edit',
        );
        act(() => edit?.click());
        const save = Array.from(document.body.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === 'Save',
        );
        await act(async () => {
          save?.click();
          await Promise.resolve();
        });
        expect(mockWorkspaceActions.updateScheduledTask).toHaveBeenCalledWith(
          'cron-secondary',
          expect.objectContaining({ prompt: expect.any(String) }),
          'secondary-id',
        );
      } else if (mutation === 'toggle') {
        const disable = Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === 'Disable',
        );
        await act(async () => {
          disable?.click();
          await Promise.resolve();
        });
      } else {
        const openDelete = Array.from(
          container.querySelectorAll('button'),
        ).find((button) => button.textContent?.trim() === 'Delete');
        act(() => openDelete?.click());
        const confirmDelete = Array.from(
          document.body.querySelectorAll('button'),
        )
          .filter((button) => button.textContent?.trim() === 'Delete')
          .at(-1);
        await act(async () => {
          confirmDelete?.click();
          await Promise.resolve();
        });
      }

      await act(async () => {
        resolveReload?.([secondaryScheduledTask]);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.textContent).not.toContain('Loading…');
      if (mutation === 'delete') {
        expect(container.textContent).toContain('has been deleted');
      } else {
        expect(container.textContent).toContain(`${mutation} result`);
      }
    },
  );

  it('discards a pending mutation when the task scope changes', async () => {
    const replacementTask: DaemonScheduledTask = {
      ...secondaryScheduledTask,
      id: 'cron-replacement',
      name: 'Replacement task',
      prompt: 'replacement only',
    };
    let resolveStaleMutation: ((task: DaemonScheduledTask) => void) | undefined;
    mockWorkspaceActions.listScheduledTasks
      .mockResolvedValueOnce([secondaryScheduledTask])
      .mockResolvedValueOnce([replacementTask]);
    mockWorkspaceActions.updateScheduledTask.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStaleMutation = resolve;
      }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => root.render(scheduledTaskPanel()));
    await flush();
    const disable = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Disable',
    );
    act(() => disable?.click());
    await flush();

    act(() =>
      root.render(
        scheduledTaskPanel({
          task: {
            id: replacementTask.id,
            title: replacementTask.name ?? replacementTask.prompt,
            prompt: replacementTask.prompt,
          },
        }),
      ),
    );
    await flush();
    expect(container.textContent).toContain('Replacement task');

    await act(async () => {
      resolveStaleMutation?.({
        ...secondaryScheduledTask,
        name: 'Stale mutation result',
        enabled: false,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('Stale mutation result');
    expect(container.textContent).toContain('Replacement task');

    mockWorkspaceActions.updateScheduledTask.mockResolvedValueOnce({
      ...replacementTask,
      enabled: false,
    });
    const replacementDisable = Array.from(
      container.querySelectorAll('button'),
    ).find((button) => button.textContent?.trim() === 'Disable');
    await act(async () => {
      replacementDisable?.click();
      await Promise.resolve();
    });
    expect(mockWorkspaceActions.updateScheduledTask).toHaveBeenLastCalledWith(
      'cron-replacement',
      { enabled: false },
      'secondary-id',
    );
  });
});

describe('ArtifactPanel add menu', () => {
  it('keeps the disabled review action on the empty page and hides the add button', () => {
    const onClose = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[]}
            activeTabId={null}
            reviewChanges={[]}
            selectedReviewPath={null}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={onClose}
          />
        </I18nProvider>,
      );
    });

    const review = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="right-panel-empty-actions"] button',
      ),
    ).find((button) => button.textContent?.includes('Changes'));
    expect(review?.disabled).toBe(true);
    expect(review?.textContent).toContain('View recent file changes');
    expect(container.textContent).not.toContain('⌘');
    expect(
      container.querySelector('button[aria-label="Add panel"]'),
    ).toBeNull();

    const panelToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle right panel"]',
    );
    expect(panelToggle).not.toBeNull();
    act(() => panelToggle?.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('filters empty-page actions through right-panel items', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[]}
            activeTabId={null}
            reviewChanges={[]}
            selectedReviewPath={null}
            items={['sideTask']}
            sideTaskAvailable
            onCreateSideTask={vi.fn()}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });

    const emptyText = container.querySelector(
      '[data-testid="right-panel-empty-actions"]',
    )?.textContent;
    expect(emptyText).toContain('Side task');
    expect(emptyText).not.toContain('Review');
    expect(
      container.querySelector('button[aria-label="Add panel"]'),
    ).toBeNull();
  });

  it('supports opening an existing side task or creating one', () => {
    const onCreateSideTask = vi.fn();
    const onOpenSideTask = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[]}
            activeTabId={null}
            reviewChanges={[]}
            selectedReviewPath={null}
            sideTaskAvailable
            sideTasks={[
              {
                sessionId: 'side-1',
                title: 'Investigate flaky tests',
                workspaceCwd: '/work/project',
              },
            ]}
            onCreateSideTask={onCreateSideTask}
            onOpenSideTask={onOpenSideTask}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });

    const sideTask = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="right-panel-empty-actions"] button',
      ),
    ).find((button) => button.textContent?.includes('Side task'));
    act(() => {
      sideTask?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, cancelable: true }),
      );
    });

    const existing = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((button) => button.textContent === 'Investigate flaky tests');
    const create = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((button) => button.textContent === 'New');
    expect(existing).not.toBeUndefined();
    expect(create).not.toBeUndefined();

    act(() => existing?.click());
    expect(onOpenSideTask).toHaveBeenCalledWith({
      sessionId: 'side-1',
      title: 'Investigate flaky tests',
      workspaceCwd: '/work/project',
    });

    act(() => {
      sideTask?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, cancelable: true }),
      );
    });
    const reopenedCreate = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((button) => button.textContent === 'New');
    act(() => reopenedCreate?.click());
    expect(onCreateSideTask).toHaveBeenCalledOnce();
  });

  it('creates a side task directly from the empty page when there is no history', () => {
    const onCreateSideTask = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[]}
            activeTabId={null}
            reviewChanges={[]}
            selectedReviewPath={null}
            sideTaskAvailable
            onCreateSideTask={onCreateSideTask}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });

    const sideTask = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="right-panel-empty-actions"] button',
      ),
    ).find((button) => button.textContent?.includes('Side task'));
    act(() => sideTask?.click());
    expect(onCreateSideTask).toHaveBeenCalledOnce();
  });

  it('does not create a side task before its history finishes loading', () => {
    const onCreateSideTask = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[]}
            activeTabId={null}
            reviewChanges={[]}
            selectedReviewPath={null}
            sideTaskAvailable
            sideTasksLoading
            onCreateSideTask={onCreateSideTask}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });

    const sideTask = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="right-panel-empty-actions"] button',
      ),
    ).find((button) => button.textContent?.includes('Side task'));
    expect(sideTask?.disabled).toBe(true);
    act(() => sideTask?.click());
    expect(onCreateSideTask).not.toHaveBeenCalled();
  });

  it('opens the latest review from the empty page', () => {
    const onOpenLatestReview = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[]}
            activeTabId={null}
            reviewChanges={[]}
            selectedReviewPath={null}
            latestReviewAvailable
            onOpenLatestReview={onOpenLatestReview}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });

    const review = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="right-panel-empty-actions"] button',
      ),
    ).find((button) => button.textContent?.includes('Changes'));
    expect(review?.disabled).toBe(false);
    act(() => review?.click());
    expect(onOpenLatestReview).toHaveBeenCalledOnce();
  });

  it('hides review from the add menu when a review tab is already open', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[
              {
                id: 'review',
                kind: 'review',
                title: 'Review',
                workspaceCwd: '/primary',
                workspaceId: 'primary-id',
              },
            ]}
            activeTabId="review"
            reviewChanges={[]}
            selectedReviewPath={null}
            latestReviewAvailable
            sideTaskAvailable
            onOpenLatestReview={vi.fn()}
            onCreateSideTask={vi.fn()}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });

    openAddMenu(container);
    const menuText = document.body.querySelector('[role="menu"]')?.textContent;
    expect(menuText).not.toContain('Review');
    expect(menuText).toContain('New side task');
  });

  it('shows review and side-task actions in the add menu for a non-empty panel', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[
              {
                id: 'artifact',
                kind: 'artifact',
                title: 'Report',
                artifactId: 'report',
                workspaceCwd: '/primary',
                workspaceId: 'primary-id',
              },
            ]}
            activeTabId="artifact"
            reviewChanges={[]}
            selectedReviewPath={null}
            latestReviewAvailable
            sideTaskAvailable
            sideTasks={[
              {
                sessionId: 'side-1',
                title: 'Existing side task',
                workspaceCwd: '/work/project',
              },
            ]}
            onOpenLatestReview={vi.fn()}
            onCreateSideTask={vi.fn()}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });

    openAddMenu(container);
    const menuText = document.body.querySelector('[role="menu"]')?.textContent;
    expect(menuText).toContain('Changes');
    expect(menuText).toContain('New side task');
    expect(menuText).not.toContain('Existing side task');
  });
});

describe('ArtifactPanel review downloads', () => {
  it('shows the requested actions and reports download failures through toast', async () => {
    const changes = ['report.html', 'notes.md', 'image.png'].map((path) => ({
      path,
      status: 'modified' as const,
      toolCallId: `tool-${path}`,
      isArtifact: false,
      diffs: [],
    }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const onError = vi.fn();
    let rejectStat: ((error: Error) => void) | undefined;
    mockWorkspaceActions.stat.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectStat = reject;
      }),
    );

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[
              {
                id: 'review',
                kind: 'review',
                title: 'Review',
                changes,
                workspaceCwd: '/primary',
                workspaceId: 'primary-id',
              },
            ]}
            activeTabId="review"
            reviewChanges={changes}
            selectedReviewPath={null}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onError={onError}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });

    const actionLabels = Array.from(container.querySelectorAll('button')).map(
      (button) => button.textContent?.trim(),
    );
    expect(actionLabels.filter((label) => label === 'Preview')).toHaveLength(3);
    expect(actionLabels.filter((label) => label === 'Download')).toHaveLength(
      2,
    );

    const download = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Download',
    );
    act(() => download?.click());
    expect(download?.disabled).toBe(true);
    expect(download?.textContent).toContain('Downloading');
    act(() => download?.click());
    expect(mockWorkspaceActions.stat).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectStat?.(new Error('read denied'));
      await Promise.resolve();
    });
    expect(download?.disabled).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Download failed: read denied' }),
      'Download failed: read denied',
    );
  });

  it('keeps other rows downloadable while one review file downloads', () => {
    const changes = ['a.html', 'b.md'].map((path) => ({
      path,
      status: 'modified' as const,
      toolCallId: `tool-${path}`,
      isArtifact: false,
      diffs: [],
    }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    mockWorkspaceActions.stat.mockReturnValue(new Promise(() => {}));

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[
              {
                id: 'review',
                kind: 'review',
                title: 'Review',
                changes,
                workspaceCwd: '/primary',
                workspaceId: 'primary-id',
              },
            ]}
            activeTabId="review"
            reviewChanges={changes}
            selectedReviewPath={null}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });

    const downloads = Array.from(container.querySelectorAll('button')).filter(
      (button) => button.textContent?.trim() === 'Download',
    );
    expect(downloads).toHaveLength(2);

    act(() => downloads[0]?.click());
    expect(downloads[0]?.disabled).toBe(true);
    expect(downloads[0]?.textContent).toContain('Downloading');
    expect(downloads[1]?.disabled).toBe(false);
    expect(downloads[1]?.textContent?.trim()).toBe('Download');
  });

  it('cancels the download and skips the error toast when the panel unmounts mid-download', async () => {
    const changes = [
      {
        path: 'report.html',
        status: 'modified' as const,
        toolCallId: 'tool-report',
        isArtifact: false,
        diffs: [],
      },
    ];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const onError = vi.fn();
    let resolveStat: ((value: unknown) => void) | undefined;
    mockWorkspaceActions.stat.mockReturnValue(
      new Promise((resolve) => {
        resolveStat = resolve;
      }),
    );

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[
              {
                id: 'review',
                kind: 'review',
                title: 'Review',
                changes,
                workspaceCwd: '/primary',
                workspaceId: 'primary-id',
              },
            ]}
            activeTabId="review"
            reviewChanges={changes}
            selectedReviewPath={null}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onError={onError}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });

    const download = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Download',
    );
    act(() => download?.click());
    expect(mockWorkspaceActions.stat).toHaveBeenCalledTimes(1);

    act(() => root.unmount());

    await act(async () => {
      resolveStat?.({ sizeBytes: 3, modifiedMs: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onError).not.toHaveBeenCalled();
  });
});

describe('ArtifactPanel monitor tab', () => {
  it('uses the source pane actions for monitor controls', async () => {
    const task: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch pane logs',
      status: 'running',
      startTime: 1,
      runtimeMs: 10,
      command: 'tail -f pane.log',
      eventCount: 1,
      droppedLines: 0,
    };
    const paneActions = {
      cancelTask: vi.fn().mockResolvedValue({ cancelled: true }),
      getTasks: vi.fn().mockResolvedValue({
        v: 1,
        sessionId: 'pane-session',
        now: 11,
        tasks: [{ ...task, status: 'cancelled' }],
      }),
    } as unknown as DaemonSessionActions;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(monitorPanel(task, paneActions));
    });
    const stopButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Stop',
    );
    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });

    expect(paneActions.cancelTask).toHaveBeenCalledWith('monitor-1', 'monitor');
    expect(mockActions.cancelTask).not.toHaveBeenCalled();
  });

  it('shows the monitor snapshot in a dedicated right-panel tab', () => {
    const task: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch server log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f server.log',
      pid: 42,
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 2,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(monitorPanel(task));
    });

    expect(
      container.querySelector('svg.lucide-square-activity'),
    ).not.toBeNull();
    expect(container.textContent).toContain('watch server log');
    expect(
      container.querySelector('[data-status="running"]')?.textContent,
    ).toBe('Running');
    expect(container.textContent).toContain('PID');
    expect(container.textContent).toContain('42');
    expect(container.textContent).toContain('Events');
    expect(container.textContent).toContain('3');
    expect(container.textContent).toContain('Dropped');
    expect(container.textContent).toContain('2');
    expect(container.textContent).toContain('tail -f server.log');
  });

  it('stops a running monitor from its detail tab', async () => {
    const task: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch server log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f server.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
    };
    mockActions.cancelTask.mockResolvedValue({ cancelled: true });
    mockActions.getTasks.mockResolvedValue({
      v: 1,
      sessionId: 'session-1',
      now: 6_000,
      tasks: [{ ...task }],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(monitorPanel(task));
    });

    const stopButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Stop',
    );
    expect(stopButton).toBeDefined();
    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });

    expect(mockActions.cancelTask).toHaveBeenCalledWith('monitor-1', 'monitor');
    expect(container.textContent).toContain('Stopped');
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent === 'Stop',
      ),
    ).toBe(false);

    act(() => {
      root.render(monitorPanel({ ...task }));
    });

    expect(container.textContent).toContain('Stopped');
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent === 'Stop',
      ),
    ).toBe(false);
  });

  it('stays stopped when the post-cancel refresh fails', async () => {
    const task: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch server log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f server.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
    };
    mockActions.cancelTask.mockResolvedValue({ cancelled: true });
    mockActions.getTasks.mockRejectedValue(new Error('refresh failed'));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(monitorPanel(task));
    });
    const stopButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Stop',
    );
    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Stopped');
    expect(container.textContent).not.toContain('Failed to cancel task');
  });

  it('keeps an in-flight stop response scoped to its monitor tab', async () => {
    const firstTask: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'first-monitor',
      description: 'watch first log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f first.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
    };
    const secondTask: DaemonSessionMonitorTaskStatus = {
      ...firstTask,
      id: 'monitor-2',
      label: 'second-monitor',
      description: 'watch second log',
      status: 'running',
      command: 'tail -f second.log',
    };
    let resolveCancel: ((value: { cancelled: boolean }) => void) | undefined;
    mockActions.cancelTask.mockReturnValue(
      new Promise((resolve) => {
        resolveCancel = resolve;
      }),
    );
    mockActions.getTasks.mockResolvedValue({
      v: 1,
      sessionId: 'session-1',
      now: 6_000,
      tasks: [{ ...firstTask, status: 'cancelled' }],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const renderPanel = (activeTabId: string) => (
      <I18nProvider language="en">
        <ArtifactPanel
          artifacts={[]}
          tabs={[
            {
              id: 'monitor:monitor-1',
              kind: 'monitor',
              title: firstTask.description,
              task: firstTask,
            },
            {
              id: 'monitor:monitor-2',
              kind: 'monitor',
              title: secondTask.description,
              task: secondTask,
            },
          ]}
          activeTabId={activeTabId}
          reviewChanges={[]}
          selectedReviewPath={null}
          onSelectTab={() => {}}
          onCloseTab={() => {}}
          onOpenFilePreview={() => {}}
          onClose={() => {}}
        />
      </I18nProvider>
    );

    act(() => {
      root.render(renderPanel('monitor:monitor-1'));
    });
    const stopButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Stop',
    );
    act(() => {
      stopButton?.click();
      root.render(renderPanel('monitor:monitor-2'));
    });
    const secondStopButton = Array.from(
      container.querySelectorAll('button'),
    ).find((button) => button.textContent === 'Stop');
    expect(secondStopButton).toBeDefined();
    expect(secondStopButton?.disabled).toBe(false);

    await act(async () => {
      resolveCancel?.({ cancelled: true });
      await Promise.resolve();
    });

    expect(container.textContent).toContain('watch second log');
    expect(container.textContent).toContain('tail -f second.log');
    expect(container.textContent).not.toContain('tail -f first.log');
    expect(
      container.querySelector('[data-status="running"]')?.textContent,
    ).toBe('Running');
  });

  it('keeps a stop error across running snapshot refreshes', async () => {
    const task: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch server log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f server.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
    };
    mockActions.cancelTask.mockResolvedValue({ cancelled: false });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(monitorPanel(task));
    });
    const stopButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Stop',
    );
    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Task already stopped');

    act(() => {
      root.render(monitorPanel({ ...task, runtimeMs: 8_000 }));
    });

    expect(container.textContent).toContain('Task already stopped');
    expect(container.textContent).toContain('8s');
  });

  it('shows a cancel error when the stop request throws', async () => {
    const task: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch server log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f server.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
    };
    mockActions.cancelTask.mockRejectedValue(new Error('network'));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(monitorPanel(task));
    });
    const stopButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Stop',
    );
    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });

    expect(mockActions.cancelTask).toHaveBeenCalledWith('monitor-1', 'monitor');
    expect(container.textContent).toContain('Failed to cancel task');
    const stopButtonAfter = Array.from(
      container.querySelectorAll('button'),
    ).find((button) => button.textContent === 'Stop');
    expect(stopButtonAfter).toBeDefined();
    expect(stopButtonAfter?.disabled).toBe(false);
  });
});

describe('ArtifactPanel shell tab', () => {
  it('shows shell task details in a dedicated right-panel tab', () => {
    const task: DaemonSessionShellTaskStatus = {
      kind: 'shell',
      id: 'shell-1',
      label: 'Development server',
      description: 'Run the development server',
      status: 'failed',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'npm run dev',
      cwd: '/work/project',
      pid: 42,
      exitCode: 1,
      error: 'Command failed',
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(shellPanel(task));
    });

    expect(
      container.querySelector('svg.lucide-square-terminal'),
    ).not.toBeNull();
    expect(container.querySelector('[data-status="failed"]')?.textContent).toBe(
      'Failed',
    );
    expect(container.querySelector('pre')?.textContent).toBe('npm run dev');
    expect(container.textContent).toContain('npm run dev');
    expect(container.textContent).toContain('/work/project');
    expect(container.textContent).toContain('Exit code');
    expect(container.textContent).toContain('Command failed');
  });
});

describe('ArtifactPanel fullscreen toggle', () => {
  function renderPanel(props: {
    fullscreen?: boolean;
    onToggleFullscreen?: () => void;
  }) {
    const task: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch server log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f server.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[
              {
                id: 'monitor:monitor-1',
                kind: 'monitor',
                title: task.description,
                task,
              },
            ]}
            activeTabId="monitor:monitor-1"
            reviewChanges={[]}
            selectedReviewPath={null}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
            fullscreen={props.fullscreen}
            onToggleFullscreen={props.onToggleFullscreen}
          />
        </I18nProvider>,
      );
    });
    return container;
  }

  it('shows a fullscreen toggle and reports clicks', () => {
    const onToggleFullscreen = vi.fn();
    const container = renderPanel({ onToggleFullscreen });
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Fullscreen"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    act(() => {
      toggle?.click();
    });
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
  });

  it('marks the panel full-bleed and flips the toggle when fullscreen', () => {
    const container = renderPanel({
      fullscreen: true,
      onToggleFullscreen: () => {},
    });
    const aside = container.querySelector('aside');
    expect(aside?.className).toContain('panelFullscreen');
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Exit fullscreen"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
  });

  it('omits the toggle when fullscreen is unsupported', () => {
    const container = renderPanel({});
    expect(
      container.querySelector('button[aria-label="Fullscreen"]'),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Exit fullscreen"]'),
    ).toBeNull();
  });
});

describe('ArtifactPanel image preview tabs', () => {
  it('renders one preview tab per image and shows the active image', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[
              {
                id: 'image:a',
                kind: 'image',
                title: 'Image Preview',
                src: 'data:image/png;base64,aWFh',
                alt: 'Uploaded image 1',
              },
              {
                id: 'image:b',
                kind: 'image',
                title: 'Image Preview',
                src: 'data:image/png;base64,iWJi',
              },
            ]}
            activeTabId="image:a"
            reviewChanges={[]}
            selectedReviewPath={null}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      ),
    );

    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    const preview = container.querySelector(
      'img[class*="imagePreview"]',
    ) as HTMLImageElement;
    expect(preview).not.toBeNull();
    expect(preview.getAttribute('src')).toBe('data:image/png;base64,aWFh');
    expect(preview.getAttribute('alt')).toBe('Uploaded image 1');

    const download = container.querySelector(
      'a[class*="imageDownloadButton"]',
    ) as HTMLAnchorElement;
    expect(download).not.toBeNull();
    expect(download.getAttribute('href')).toBe('data:image/png;base64,aWFh');
    expect(download.getAttribute('download')).toBe('image.png');
  });
});
