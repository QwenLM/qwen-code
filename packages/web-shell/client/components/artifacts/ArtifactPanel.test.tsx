// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, StrictMode } from 'react';
import { Blob as NodeBlob } from 'node:buffer';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView } from 'codemirror';
import type {
  DaemonSessionArtifact,
  DaemonSessionMonitorTaskStatus,
  DaemonSessionShellTaskStatus,
} from '@qwen-code/sdk/daemon';
import type {
  DaemonScheduledTask,
  DaemonSessionActions,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { I18nProvider } from '../../i18n';
import { TOAST_REQUEST_EVENT, type ToastRequestDetail } from '../ToastHost';
import type { WebShellRightPanelItem } from '../../customization';
import type { ArtifactWorkspaceTarget } from './useArtifactWorkspaceTarget';
import type { TurnOutputScheduledTask } from './TurnOutputs';

const originalCreateObjectURL = Object.getOwnPropertyDescriptor(
  URL,
  'createObjectURL',
);
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(
  URL,
  'revokeObjectURL',
);

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
        readSessionArtifactContent: vi.fn(),
      },
    },
  };
});

vi.mock(
  '@qwen-code/web-shell/daemon-react-sdk',
  async (importOriginal: () => Promise<Record<string, unknown>>) => ({
    ...(await importOriginal()),
    useActions: () => mockActions,
    useWorkspace: () => mockWorkspace,
    useConnection: () => ({
      sessionId: 'active-session',
      clientId: 'active-viewer',
    }),
    useWorkspaceActions: () => mockWorkspaceActions,
  }),
);

vi.mock('../terminal/TerminalPanel', () => ({
  TerminalPanel: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="terminal-panel" data-terminal-id={terminalId} />
  ),
}));

const { ArtifactPanel } = await import('./ArtifactPanel');
type ArtifactPanelTab = Parameters<typeof ArtifactPanel>[0]['tabs'][number];
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
  owner: {
    workspaceCwd: string;
    workspaceId: string;
    sourceSessionId?: string;
  } | null = {
    workspaceCwd: '/primary',
    workspaceId: 'primary-id',
  },
  language: 'en' | 'zh-CN' = 'en',
) {
  return (
    <I18nProvider language={language}>
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
  vi.unstubAllGlobals();
  // The boundary matrix spies on DOMParser.prototype per row; restore it so
  // the leak cannot skew call-count assertions in later tests.
  vi.restoreAllMocks();
  delete (window as { __TAURI__?: unknown }).__TAURI__;
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted.length = 0;
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
  } else {
    Reflect.deleteProperty(URL, 'createObjectURL');
  }
  if (originalRevokeObjectURL) {
    Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
  } else {
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  }
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

describe('ArtifactPanel context usage tabs', () => {
  it('loads only the selected usage panel with its own actions', async () => {
    const getContextUsage = vi.fn().mockResolvedValue({});
    const getStats = vi.fn().mockResolvedValue({});
    const contextActions = {
      getContextUsage,
    } as unknown as DaemonSessionActions;
    const tokenActions = { getStats } as unknown as DaemonSessionActions;
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
              id: 'context',
              kind: 'context_usage',
              title: 'Context Usage',
              sessionId: 'secondary',
              sessionActions: contextActions,
            },
            {
              id: 'token',
              kind: 'token_usage',
              title: 'Token Usage',
              sessionId: 'primary',
              sessionActions: tokenActions,
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
    await act(async () => root.render(renderPanel('token')));
    expect(getStats).toHaveBeenCalledOnce();
    expect(getContextUsage).not.toHaveBeenCalled();
    await act(async () => root.render(renderPanel('context')));
    expect(getContextUsage).toHaveBeenCalledWith({
      detail: true,
      silent: true,
    });
    expect(getStats).toHaveBeenCalledOnce();
    expect(
      container.querySelector('button[title="Token Usage"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[title="Context Usage"]'),
    ).not.toBeNull();
  });
});

describe('ArtifactPanel terminal tabs', () => {
  const renderPanel = (activeTabId: string, restoring = false) => (
    <I18nProvider language="en">
      <ArtifactPanel
        artifacts={[]}
        tabs={[
          { id: 'terminal-one', kind: 'terminal', title: 'Terminal' },
          { id: 'terminal-two', kind: 'terminal', title: 'Terminal (2)' },
        ]}
        activeTabId={activeTabId}
        restoring={restoring}
        reviewChanges={[]}
        selectedReviewPath={null}
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onOpenFilePreview={() => {}}
        onClose={() => {}}
      />
    </I18nProvider>
  );

  it('keeps terminal instances mounted while switching tabs', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => root.render(renderPanel('terminal-one')));
    const first = container.querySelector('[data-terminal-id="terminal-one"]');
    expect(
      container.querySelectorAll('[data-testid="terminal-panel"]'),
    ).toHaveLength(2);

    act(() => root.render(renderPanel('terminal-two')));

    expect(container.querySelector('[data-terminal-id="terminal-one"]')).toBe(
      first,
    );
    expect(
      container.querySelectorAll('[data-testid="terminal-panel"]'),
    ).toHaveLength(2);
  });

  it('keeps an active terminal visible while restoring', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => root.render(renderPanel('terminal-one', true)));

    expect(
      container.querySelector('[data-terminal-id="terminal-one"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="right-panel-loading-skeleton"]'),
    ).toBeNull();
  });
});

describe('ArtifactPanel web previews', () => {
  it('keeps the application frame mounted across tab and viewport changes', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const renderPanel = (
      activeTabId: string,
      viewport: 'desktop' | 'mobile' = 'desktop',
    ) => (
      <I18nProvider language="en">
        <ArtifactPanel
          artifacts={[]}
          tabs={[
            {
              id: 'preview',
              kind: 'web_preview',
              title: 'Web preview',
              url: 'http://localhost:6543',
              viewport,
            },
            { id: 'terminal', kind: 'terminal', title: 'Terminal' },
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
    act(() => root.render(renderPanel('preview')));
    const frame = container.querySelector('iframe');
    expect(frame).not.toBeNull();
    act(() => root.render(renderPanel('terminal')));
    expect(container.querySelector('iframe')).toBe(frame);
    expect(frame?.closest('[hidden]')).not.toBeNull();
    act(() => root.render(renderPanel('preview', 'mobile')));
    expect(container.querySelector('iframe')).toBe(frame);
    expect(frame?.closest('[hidden]')).toBeNull();
    expect(frame?.style.width).toBe('390px');
  });
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

// jsdom completes FileReader reads via setImmediate, a macrotask the
// microtask-only flush() never drains.
async function flushPreview() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
}

describe('ArtifactPanel code review artifacts', () => {
  it('reads a saved artifact from the panel tab source session', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    mounted.push({ root, container });
    mockWorkspace.client.readSessionArtifactContent.mockResolvedValue(
      '<h1>Source session</h1>',
    );
    await act(async () =>
      root.render(
        artifactPanel(
          {
            ...linkArtifact(),
            kind: 'html',
            storage: 'published',
            metadata: { artifactType: 'web_preview_snapshot' },
          },
          {
            workspaceCwd: '/primary',
            workspaceId: 'primary-id',
            sourceSessionId: 'original-session',
          },
        ),
      ),
    );
    expect(
      mockWorkspace.client.readSessionArtifactContent,
    ).toHaveBeenCalledWith('original-session', linkArtifact().id, {
      clientId: undefined,
      signal: expect.any(AbortSignal),
    });
    expect(
      container
        .querySelector('iframe[title="Saved webpage version"]')
        ?.getAttribute('srcdoc'),
    ).toContain('Source session');
  });

  it('uses the artifact format icon in the panel tab', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => root.render(artifactPanel(linkArtifact())));

    expect(
      container.querySelector('[role="tab"] [data-artifact-icon="link"]'),
    ).not.toBeNull();
  });

  it('marks overflowing panel tab titles for hover scrolling', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => root.render(artifactPanel(linkArtifact())));

    const tab = container.querySelector<HTMLElement>('[role="tab"]')!;
    const title = tab.querySelector<HTMLElement>(
      '[data-web-shell-session-title]',
    )!;
    Object.defineProperty(title, 'clientWidth', { value: 80 });
    Object.defineProperty(title.firstElementChild, 'scrollWidth', {
      value: 180,
    });
    act(() =>
      tab.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
    );

    expect(title.hasAttribute('data-web-shell-title-overflow')).toBe(true);
    expect(
      title.style.getPropertyValue('--session-title-scroll-distance'),
    ).toBe('100px');
  });

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

  it('renders a saved webpage version without a workspace owner', async () => {
    mockWorkspace.client.readSessionArtifactContent.mockResolvedValue(
      '<h1>Saved version</h1>',
    );
    const artifact = {
      ...linkArtifact(),
      kind: 'html',
      storage: 'published',
      metadata: { artifactType: 'web_preview_snapshot' },
    } as DaemonSessionArtifact;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    await act(async () => root.render(artifactPanel(artifact, null)));
    await flush();

    expect(
      container.querySelector('[data-web-shell-saved-preview]'),
    ).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain(
      'This workspace may have been removed',
    );
    expect(
      container
        .querySelector('iframe[title="Saved webpage version"]')
        ?.getAttribute('srcdoc'),
    ).toContain('Saved version');
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

  it('switches supplied Markdown attachments from source to preview without reading the workspace', async () => {
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
                id: 'attachment:notes.md',
                kind: 'file',
                title: 'notes.md',
                workspacePath: 'notes.md',
                workspaceCwd: '/removed',
                workspaceId: 'removed-id',
                previewData: new Blob(['# Hello attachment'], {
                  type: 'text/markdown',
                }),
                previewMimeType: 'text/markdown',
                previewOnly: true,
              },
            ]}
            activeTabId="attachment:notes.md"
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

    expect(
      container.querySelector('[role="tab"] [data-file-type-icon="md"]'),
    ).not.toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('.cm-content')?.textContent).toContain(
      '# Hello attachment',
    );
    act(() => {
      (
        container.querySelector(
          'button[aria-label="Preview"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flush();
    expect(container.querySelector('h1')?.textContent).toBe('Hello attachment');
    expect(mockWorkspaceActions.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('switches supplied HTML text from source to preview', async () => {
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
                id: 'attachment:page.html',
                kind: 'file',
                title: 'page.html',
                workspacePath: 'page.html',
                attachmentId: 'page.html',
                previewContent: '<h1>Attachment page</h1>',
                previewMimeType: 'text/html',
                previewOnly: true,
              },
            ]}
            activeTabId="attachment:page.html"
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

    expect(container.querySelector('.cm-content')?.textContent).toContain(
      '<h1>Attachment page</h1>',
    );
    act(() => {
      (
        container.querySelector(
          'button[aria-label="Preview"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flush();
    expect(
      new DOMParser()
        .parseFromString(container.querySelector('iframe')!.srcdoc, 'text/html')
        .querySelector('iframe')!.srcdoc,
    ).toContain('<h1>Attachment page</h1>');
    expect(mockWorkspaceActions.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('keeps HTML source attachments in text mode without an executable preview', async () => {
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
                id: 'attachment:page.html',
                kind: 'file',
                title: 'page.html',
                workspacePath: 'page.html',
                attachmentId: 'page.html',
                previewContent: '<h1>Attachment page</h1>',
                previewMimeType: 'text/html',
                previewOnly: true,
                sourcePreview: true,
              },
            ]}
            activeTabId="attachment:page.html"
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

    expect(container.querySelector('.cm-content')?.textContent).toContain(
      '<h1>Attachment page</h1>',
    );
    expect(container.querySelector('button[aria-label="Preview"]')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(mockWorkspaceActions.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('shows a clear unsupported state for binary attachments', async () => {
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
                id: 'attachment:report.xlsx',
                kind: 'file',
                title: 'report.xlsx',
                workspacePath: 'report.xlsx',
                previewData: new Blob(['PK'], {
                  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                }),
                previewMimeType:
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                previewOnly: true,
              },
            ]}
            activeTabId="attachment:report.xlsx"
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

    expect(container.textContent).toContain(
      'Preview is not available for this file type.',
    );
    expect(container.querySelector('.cm-content')).toBeNull();
    expect(mockWorkspaceActions.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('downloads binary source attachments and releases their blob URL', async () => {
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:source-binary'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revoke,
    });
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
                id: 'attachment:report.xlsx',
                kind: 'file',
                title: 'report.xlsx',
                workspacePath: 'report.xlsx',
                previewData: new Blob(['PK'], {
                  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                }),
                previewMimeType:
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                previewOnly: true,
                sourcePreview: true,
              },
            ]}
            activeTabId="attachment:report.xlsx"
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

    expect(container.textContent).toContain(
      'Preview is not available for this file type.',
    );
    expect(container.querySelector('.cm-content')).toBeNull();
    expect(mockWorkspaceActions.readWorkspaceFile).not.toHaveBeenCalled();
    const download = container.querySelector<HTMLAnchorElement>(
      'a[download="report.xlsx"]',
    );
    expect(download?.href).toBe('blob:source-binary');
    act(() => root.render(null));
    expect(revoke).toHaveBeenCalledWith('blob:source-binary');
  });

  it('opens PDF attachments in the browser PDF preview', async () => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:attachment-pdf'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
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
                id: 'attachment:report.pdf',
                kind: 'file',
                title: 'report.pdf',
                workspacePath: 'report.pdf',
                previewData: new Blob(['%PDF-1.7'], {
                  type: 'application/pdf',
                }),
                previewMimeType: 'application/pdf',
                previewOnly: true,
              },
            ]}
            activeTabId="attachment:report.pdf"
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

    expect(container.querySelector<HTMLIFrameElement>('iframe')?.src).toContain(
      'blob:attachment-pdf',
    );
    expect(container.querySelector('.cm-content')).toBeNull();
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
    // The dedicated renderer reads the whole document, so it passes no window.
    expect(mockWorkspaceActions.readWorkspaceFile).toHaveBeenCalledWith(
      '.qwen/reviews/review.json',
      undefined,
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
    mockWorkspaceActions.stat.mockResolvedValue({
      kind: 'stat',
      path: '.qwen/reviews/review.json',
      type: 'file',
      sizeBytes: 2,
      modifiedMs: 1,
    });
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
      { maxBytes: 256 * 1024 },
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
  it('opens terminals without forwarding UI events as terminal ids', () => {
    const onOpenTerminal = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const renderPanel = (withTab: boolean) => (
      <I18nProvider language="en">
        <ArtifactPanel
          artifacts={[]}
          tabs={
            withTab
              ? [{ id: 'terminal-one', kind: 'terminal', title: 'Terminal' }]
              : []
          }
          activeTabId={withTab ? 'terminal-one' : null}
          reviewChanges={[]}
          selectedReviewPath={null}
          onOpenTerminal={onOpenTerminal}
          onSelectTab={() => {}}
          onCloseTab={() => {}}
          onOpenFilePreview={() => {}}
          onClose={() => {}}
        />
      </I18nProvider>
    );

    act(() => root.render(renderPanel(false)));
    const emptyAction = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="right-panel-empty-actions"] button',
      ),
    ).find((button) => button.textContent?.includes('Terminal'));
    act(() => emptyAction?.click());
    expect(onOpenTerminal).toHaveBeenLastCalledWith();

    act(() => root.render(renderPanel(true)));
    openAddMenu(container);
    const menuAction = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent === 'Terminal');
    act(() => menuAction?.click());
    expect(onOpenTerminal).toHaveBeenLastCalledWith();
    expect(onOpenTerminal).toHaveBeenCalledTimes(2);
  });

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
  it('renders a saved unified patch without full file bodies', () => {
    const fileDiff =
      '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new';
    const changes = [
      {
        path: 'src/app.ts',
        status: 'modified' as const,
        toolCallId: 'tool-app',
        isArtifact: false,
        diffs: [{ oldText: '', newText: '', fileDiff }],
      },
    ];
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

    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="src/app.ts"]')
        ?.click();
    });

    expect(container.textContent).toContain('old');
    expect(container.textContent).toContain('new');
    expect(container.textContent).not.toContain('No diff available.');
  });

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
    expect(toggle?.querySelector('.lucide-expand')).not.toBeNull();
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
    expect(toggle?.querySelector('.lucide-shrink')).not.toBeNull();
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

describe('ArtifactPanel workspace artifact previews', () => {
  it.each([
    ['html', 'en', -1, false],
    ['html', 'en', 0, false],
    ['html', 'en', 1, false],
    ['md', 'zh-CN', -1, false],
    ['md', 'zh-CN', 0, false],
    ['md', 'zh-CN', 1, false],
    ['html', 'en', 1, true],
    ['md', 'zh-CN', 1, true],
  ] as const)(
    'previews %s in %s at 1 MiB plus %i bytes (truncated: %s)',
    async (extension, language, extraBytes, truncated) => {
      const parseHtml = vi.spyOn(DOMParser.prototype, 'parseFromString');
      const heading =
        extension === 'html'
          ? '<h1>Large document</h1>\n'
          : '# Large document\n';
      const paddingBytes =
        1024 * 1024 + extraBytes - Buffer.byteLength(heading + '<!---->');
      const content =
        heading +
        '<!--' +
        '中'.repeat(Math.floor(paddingBytes / 3)) +
        ' '.repeat(paddingBytes % 3) +
        '-->';
      mockWorkspaceActions.stat.mockResolvedValue({
        type: 'file',
        sizeBytes: Buffer.byteLength(content),
        modifiedMs: 1,
      });
      mockWorkspaceActions.readWorkspaceFile.mockResolvedValue({
        content: truncated ? content.slice(0, 100) : content,
        encoding: 'utf-8',
        sizeBytes: Buffer.byteLength(content),
        truncated,
      });
      if (truncated) {
        vi.stubGlobal('Blob', NodeBlob);
        const bytes = Buffer.from(content);
        mockWorkspaceActions.readFileBytes.mockImplementation(
          async (_path, { offset, maxBytes }) => {
            const chunk = bytes.subarray(offset, offset + maxBytes);
            return {
              contentBase64: chunk.toString('base64'),
              offset,
              returnedBytes: chunk.length,
              sizeBytes: bytes.length,
            };
          },
        );
      }
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      mounted.push({ root, container });
      act(() =>
        root.render(
          artifactPanel(
            {
              id: 'large-document',
              kind: extension === 'html' ? 'html' : 'file',
              storage: 'workspace',
              source: 'tool',
              status: 'available',
              title: 'Large document',
              workspacePath: `large.${extension}`,
              retention: 'ephemeral',
              clientRetained: false,
              createdAt: '2026-09-16T00:00:00.000Z',
              updatedAt: '2026-09-16T00:00:00.000Z',
            },
            undefined,
            language,
          ),
        ),
      );
      await flush();
      if (truncated)
        expect(mockWorkspaceActions.readFileBytes).toHaveBeenCalledTimes(5);
      if (extraBytes <= 0) {
        expect(container.querySelector('.cm-editor')).toBeNull();
        expect(
          container.querySelector(extension === 'html' ? 'iframe' : 'h1'),
        ).not.toBeNull();
        return;
      }
      expect(container.querySelector('iframe, h1')).toBeNull();
      expect(parseHtml).not.toHaveBeenCalled();
      const editor = container.querySelector('.cm-editor')!;
      expect(EditorView.findFromDOM(editor)?.state.doc.toString()).toBe(
        content,
      );
      const toggle = Array.from(container.querySelectorAll('button')).find(
        (button) =>
          button.textContent ===
          (language === 'en' ? 'Render full preview' : '完整排版预览'),
      )!;
      expect(container.textContent).toContain(
        language === 'en'
          ? 'File is large. Source is shown by default.'
          : '文件过大，默认展示源码。',
      );
      expect(toggle).toBeTruthy();
      act(() => toggle.click());
      await flush();
      expect(
        container.querySelector(extension === 'html' ? 'iframe' : 'h1'),
      ).not.toBeNull();
      if (extension === 'md') {
        expect(container.querySelector('iframe')).toBeNull();
      }
      expect(container.querySelector('.cm-editor')).toBeNull();
      act(() => toggle.click());
      await flush();
      expect(
        EditorView.findFromDOM(
          container.querySelector('.cm-editor')!,
        )?.state.doc.toString(),
      ).toBe(content);
    },
  );

  it('restores the DOMParser spy after the boundary matrix', () => {
    expect(vi.isMockFunction(DOMParser.prototype.parseFromString)).toBe(false);
  });

  it('localizes the export preview loading placeholder', async () => {
    vi.stubGlobal('__WEB_SHELL_VERSION__', '0.23.4');
    const base = 'https://unpkg.com/@qwen-code/qwen-code@0.23.4/';
    const integrity = `sha384-${'a'.repeat(64)}`;
    const content = `<script id="transcript-document" type="application/json">{}</script><script id="transcript-renderer" integrity="${integrity}" src="${base}export-transcript-document.js"></script><link id="transcript-stylesheet" rel="stylesheet" integrity="${integrity}" href="${base}export-transcript-document.css">`;
    mockWorkspaceActions.stat.mockResolvedValue({
      type: 'file',
      sizeBytes: content.length,
      modifiedMs: 1,
    });
    mockWorkspaceActions.readWorkspaceFile.mockResolvedValue({
      content,
      encoding: 'utf-8',
      truncated: false,
    });
    // The renderer fetch never settles, so the placeholder stays on screen.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        artifactPanel(
          {
            id: 'export-preview',
            kind: 'html',
            storage: 'workspace',
            source: 'client',
            status: 'available',
            title: 'export.html',
            workspacePath: 'export.html',
            mimeType: 'text/html; charset=utf-8',
            clientRetained: false,
            createdAt: '2026-09-16T00:00:00.000Z',
            updatedAt: '2026-09-16T00:00:00.000Z',
          },
          undefined,
          'zh-CN',
        ),
      ),
    );
    await flush();

    expect(container.textContent).toContain('正在加载预览...');
    expect(container.textContent).not.toContain('Loading preview...');
  });

  it('surfaces a failed export preview instead of loading forever', async () => {
    vi.stubGlobal('__WEB_SHELL_VERSION__', '0.23.4');
    const base = 'https://unpkg.com/@qwen-code/qwen-code@0.23.4/';
    const integrity = `sha384-${'a'.repeat(64)}`;
    const content = `<script id="transcript-document" type="application/json">{}</script><script id="transcript-renderer" integrity="${integrity}" src="${base}export-transcript-document.js"></script><link id="transcript-stylesheet" rel="stylesheet" integrity="${integrity}" href="${base}export-transcript-document.css">`;
    mockWorkspaceActions.stat.mockResolvedValue({
      type: 'file',
      sizeBytes: content.length,
      modifiedMs: 1,
    });
    mockWorkspaceActions.readWorkspaceFile.mockResolvedValue({
      content,
      encoding: 'utf-8',
      truncated: false,
    });
    // An SRI mismatch rejects the renderer fetch; the panel must surface that
    // failure rather than leaving the placeholder up forever.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Integrity mismatch')),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        artifactPanel({
          id: 'export-preview',
          kind: 'html',
          storage: 'workspace',
          source: 'client',
          status: 'available',
          title: 'export.html',
          workspacePath: 'export.html',
          mimeType: 'text/html; charset=utf-8',
          clientRetained: false,
          createdAt: '2026-09-16T00:00:00.000Z',
          updatedAt: '2026-09-16T00:00:00.000Z',
        }),
      ),
    );
    await flushPreview();

    expect(container.textContent).toContain(
      'Could not load preview: Integrity mismatch',
    );
    expect(container.textContent).not.toContain('Loading preview...');
  });

  it('reuses the built export preview when toggling between source and rendered views', async () => {
    vi.stubGlobal('__WEB_SHELL_VERSION__', '0.23.4');
    const base = 'https://unpkg.com/@qwen-code/qwen-code@0.23.4/';
    const integrity = `sha384-${'a'.repeat(64)}`;
    const padding = 'x'.repeat(1024 * 1024 + 512);
    const content = `<script id="transcript-document" type="application/json">{"padding":"${padding}"}</script><script id="transcript-renderer" integrity="${integrity}" src="${base}export-transcript-document.js"></script><link id="transcript-stylesheet" rel="stylesheet" integrity="${integrity}" href="${base}export-transcript-document.css">`;
    mockWorkspaceActions.stat.mockResolvedValue({
      type: 'file',
      sizeBytes: Buffer.byteLength(content),
      modifiedMs: 1,
    });
    mockWorkspaceActions.readWorkspaceFile.mockResolvedValue({
      content,
      encoding: 'utf-8',
      truncated: false,
    });
    const fetchMock = vi.fn(async () => new Response('verified bytes'));
    vi.stubGlobal('fetch', fetchMock);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        artifactPanel({
          id: 'export-preview-toggle',
          kind: 'html',
          storage: 'workspace',
          source: 'client',
          status: 'available',
          title: 'export-toggle.html',
          workspacePath: 'export-toggle.html',
          mimeType: 'text/html; charset=utf-8',
          clientRetained: false,
          createdAt: '2026-09-16T00:00:00.000Z',
          updatedAt: '2026-09-16T00:00:00.000Z',
        }),
      ),
    );
    await flushPreview();

    const clickToggle = (label: string) => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === label,
      );
      expect(button?.textContent).toBe(label);
      act(() => button!.click());
    };
    // Large documents open in source view; nothing is fetched until the user
    // asks for the rendered preview.
    expect(container.querySelector('.cm-editor')).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    clickToggle('Render full preview');
    await flushPreview();
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    clickToggle('Show source');
    await flushPreview();
    expect(container.querySelector('.cm-editor')).not.toBeNull();

    clickToggle('Render full preview');
    await flushPreview();
    expect(container.querySelector('iframe')).not.toBeNull();
    // The remount must not re-fetch and re-encode the renderer assets.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gates a large preview without copying the content into a Blob when no size is known', async () => {
    const content = `<h1>Large document</h1>\n<!--${'中'.repeat(400_000)}-->`;
    // The stat never resolves, so neither the reader's sizeBytes nor a
    // catalog size is available: the 1 MiB gate must measure the seeded
    // preview content without allocating a Blob copy of it.
    mockWorkspaceActions.stat.mockReturnValue(new Promise(() => {}));
    const blobSpy = vi.fn();
    const OriginalBlob = globalThis.Blob;
    vi.stubGlobal(
      'Blob',
      class extends OriginalBlob {
        constructor(...args: ConstructorParameters<typeof Blob>) {
          blobSpy(...args);
          super(...args);
        }
      },
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[
              {
                id: 'large-export',
                kind: 'html',
                storage: 'workspace',
                source: 'client',
                status: 'available',
                title: 'large-export.html',
                workspacePath: 'large-export.html',
                mimeType: 'text/html; charset=utf-8',
                retention: 'ephemeral',
                clientRetained: false,
                createdAt: '2026-09-16T00:00:00.000Z',
                updatedAt: '2026-09-16T00:00:00.000Z',
              },
            ]}
            tabs={[
              {
                id: 'artifact:large-export',
                kind: 'artifact',
                title: 'large-export.html',
                artifactId: 'large-export',
                workspaceCwd: '/primary',
                workspaceId: 'primary-id',
                previewContent: content,
              },
            ]}
            activeTabId="artifact:large-export"
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

    // The gate decided from the seeded content alone: source view first.
    expect(container.textContent).toContain(
      'File is large. Source is shown by default.',
    );
    expect(
      blobSpy.mock.calls.some(
        ([parts]) => Array.isArray(parts) && parts.includes(content),
      ),
    ).toBe(false);
  });

  it('uses the catalog sizeBytes for the large-document gate before the file is read', async () => {
    const content = '<h1>Small export</h1>';
    // The stat never resolves, so only the catalog sizeBytes threaded from
    // the artifact detail can drive the 1 MiB gate.
    mockWorkspaceActions.stat.mockReturnValue(new Promise(() => {}));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[
              {
                id: 'catalog-sized-export',
                kind: 'html',
                storage: 'workspace',
                source: 'client',
                status: 'available',
                title: 'catalog-sized.html',
                workspacePath: 'catalog-sized.html',
                mimeType: 'text/html; charset=utf-8',
                sizeBytes: 2 * 1024 * 1024,
                retention: 'ephemeral',
                clientRetained: false,
                createdAt: '2026-09-16T00:00:00.000Z',
                updatedAt: '2026-09-16T00:00:00.000Z',
              },
            ]}
            tabs={[
              {
                id: 'artifact:catalog-sized-export',
                kind: 'artifact',
                title: 'catalog-sized.html',
                artifactId: 'catalog-sized-export',
                workspaceCwd: '/primary',
                workspaceId: 'primary-id',
                previewContent: content,
              },
            ]}
            activeTabId="artifact:catalog-sized-export"
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

    // Tiny content, large catalog size: the gate proves the threaded
    // sizeBytes won over measuring the content.
    expect(container.textContent).toContain(
      'File is large. Source is shown by default.',
    );
  });

  it('reads a secondary-workspace file through the capped preview window', async () => {
    mockSecondaryWorkspaceActions.fileStat.mockResolvedValue({
      type: 'file',
      sizeBytes: 2,
      modifiedMs: 1,
    });
    mockSecondaryWorkspaceActions.readWorkspaceFile.mockResolvedValue({
      content: '{}',
      truncated: false,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        artifactPanel(
          {
            id: 'secondary-file',
            kind: 'file',
            storage: 'workspace',
            source: 'tool',
            status: 'available',
            title: 'report.json',
            workspacePath: 'report.json',
            retention: 'ephemeral',
            clientRetained: false,
            createdAt: '2026-09-16T00:00:00.000Z',
            updatedAt: '2026-09-16T00:00:00.000Z',
          },
          { workspaceCwd: '/secondary', workspaceId: 'secondary-id' },
        ),
      ),
    );
    await flush();

    expect(
      mockSecondaryWorkspaceActions.readWorkspaceFile,
    ).toHaveBeenCalledWith('report.json', { maxBytes: 256 * 1024 });
  });

  it.each([
    {
      label: 'Markdown',
      mimeType: 'text/markdown; charset=utf-8',
      content: '# Charset Markdown',
    },
    {
      label: 'HTML',
      mimeType: 'text/html; charset=utf-8',
      content: '<h1>Charset HTML</h1>',
    },
  ])('previews document-classified $label MIME types', async (testCase) => {
    mockWorkspaceActions.stat.mockResolvedValue({
      type: 'file',
      sizeBytes: testCase.content.length,
      modifiedMs: 1,
    });
    mockWorkspaceActions.readWorkspaceFile.mockResolvedValue({
      content: testCase.content,
      truncated: false,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        artifactPanel({
          id: 'review-artifact',
          kind: 'document',
          storage: 'workspace',
          source: 'tool',
          status: 'available',
          title: `${testCase.label} preview`,
          workspacePath: 'reports/preview',
          mimeType: testCase.mimeType,
          retention: 'ephemeral',
          clientRetained: false,
          createdAt: '2026-08-23T00:00:00.000Z',
          updatedAt: '2026-08-23T00:00:00.000Z',
        }),
      ),
    );
    await flush();

    expect(mockWorkspaceActions.readWorkspaceFile).toHaveBeenCalledWith(
      'reports/preview',
      { maxBytes: 256 * 1024 },
    );
    if (testCase.label === 'Markdown') {
      expect(container.querySelector('h1')?.textContent).toBe(
        'Charset Markdown',
      );
    } else {
      expect(
        new DOMParser()
          .parseFromString(
            container.querySelector('iframe')!.srcdoc,
            'text/html',
          )
          .querySelector('iframe')!.srcdoc,
      ).toContain(testCase.content);
    }
  });

  it('loads the complete bytes when a text read is truncated without a cursor', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    const content =
      '# Exported session\n\n' + '中'.repeat(100_000) + '\n\n## Later turn';
    const bytes = Buffer.from(content);
    mockWorkspaceActions.stat.mockResolvedValue({
      type: 'file',
      sizeBytes: bytes.length,
      modifiedMs: 1,
    });
    mockWorkspaceActions.readWorkspaceFile.mockResolvedValue({
      content: content.slice(0, 100),
      encoding: 'utf-8',
      truncated: true,
      hasMore: true,
      nextCursor: null,
    });
    mockWorkspaceActions.readFileBytes.mockImplementation(
      async (_path, { offset, maxBytes }) => {
        const chunk = bytes.subarray(offset, offset + maxBytes);
        return {
          contentBase64: chunk.toString('base64'),
          offset,
          returnedBytes: chunk.length,
          sizeBytes: bytes.length,
        };
      },
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        artifactPanel({
          id: 'review-artifact',
          kind: 'file',
          storage: 'workspace',
          source: 'client',
          status: 'available',
          title: 'qwen-code-export-2026-09-16T00-00-00-000Z.md',
          workspacePath: 'qwen-code-export-2026-09-16T00-00-00-000Z.md',
          mimeType: 'text/markdown; charset=utf-8',
          retention: 'ephemeral',
          clientRetained: false,
          createdAt: '2026-09-16T00:00:00.000Z',
          updatedAt: '2026-09-16T00:00:00.000Z',
        }),
      ),
    );
    await flush();

    expect(mockWorkspaceActions.readWorkspaceFile).toHaveBeenNthCalledWith(
      1,
      'qwen-code-export-2026-09-16T00-00-00-000Z.md',
      { maxBytes: 256 * 1024 },
    );
    expect(mockWorkspaceActions.readFileBytes).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Exported session');
    expect(container.textContent).toContain('Later turn');
    expect(container.textContent).not.toContain(
      'Preview is truncated because the file is too large.',
    );
  });

  it.each(['html', 'md', 'txt'])(
    'stops showing loading when a %s file read fails',
    async (extension) => {
      mockWorkspaceActions.stat.mockResolvedValue({
        type: 'file',
        sizeBytes: 200,
        modifiedMs: 1,
      });
      mockWorkspaceActions.readWorkspaceFile.mockRejectedValue(
        new Error('File changed while loading.'),
      );
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      mounted.push({ root, container });
      act(() =>
        root.render(
          artifactPanel({
            id: 'failed-preview',
            kind: extension === 'html' ? 'html' : 'file',
            storage: 'workspace',
            source: 'client',
            status: 'available',
            title: `failed.${extension}`,
            workspacePath: `failed.${extension}`,
            clientRetained: false,
            createdAt: '2026-09-16',
            updatedAt: '2026-09-16',
          }),
        ),
      );
      await flush();
      expect(container.textContent).toContain('File changed while loading.');
      expect(container.textContent).not.toMatch(/Loading (?:preview|file)/);
      expect(container.querySelector('iframe, .cm-editor')).toBeNull();
    },
  );

  it('rejects a full preview above the existing download size ceiling', async () => {
    mockWorkspaceActions.stat.mockResolvedValue({
      type: 'file',
      sizeBytes: 200 * 1024 * 1024,
      modifiedMs: 1,
    });
    mockWorkspaceActions.readWorkspaceFile.mockImplementation(async () => ({
      content: 'x',
      truncated: true,
      hasMore: true,
      nextCursor: null,
      returnedBytes: 256 * 1024,
    }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        artifactPanel({
          id: 'review-artifact',
          kind: 'file',
          storage: 'workspace',
          source: 'client',
          status: 'available',
          title: 'qwen-code-export-2026-09-16T00-00-00-000Z.md',
          workspacePath: 'qwen-code-export-2026-09-16T00-00-00-000Z.md',
          mimeType: 'text/markdown; charset=utf-8',
          retention: 'ephemeral',
          clientRetained: false,
          createdAt: '2026-09-16T00:00:00.000Z',
          updatedAt: '2026-09-16T00:00:00.000Z',
        }),
      ),
    );
    await flush();

    expect(container.textContent).toContain(
      'File is too large to preview or download.',
    );
    expect(container.textContent).not.toMatch(/Loading (?:preview|file)/);
  });

  it('renders a document artifact as download-only and does not preview it', async () => {
    mockWorkspaceActions.stat.mockResolvedValue({
      type: 'file',
      sizeBytes: 12,
      modifiedMs: 1,
    });
    mockWorkspaceActions.readWorkspaceFile.mockResolvedValue({
      content: 'PK\u0003\u0004',
      truncated: false,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        artifactPanel({
          id: 'review-artifact',
          kind: 'document',
          storage: 'workspace',
          source: 'tool',
          status: 'available',
          title: 'Q3 workbook',
          workspacePath: 'reports/q3.xlsx',
          retention: 'ephemeral',
          clientRetained: false,
          createdAt: '2026-08-18T00:00:00.000Z',
          updatedAt: '2026-08-18T00:00:00.000Z',
        }),
      ),
    );
    await flush();

    expect(container.textContent).toMatch(/Download/i);
    expect(container.querySelector('.cm-editor')).toBeNull();
    expect(mockWorkspaceActions.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('shows status and disables download for a missing document artifact', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        artifactPanel({
          id: 'review-artifact',
          kind: 'document',
          storage: 'workspace',
          source: 'tool',
          status: 'missing',
          title: 'Q3 workbook',
          workspacePath: 'reports/q3.xlsx',
          retention: 'ephemeral',
          clientRetained: false,
          createdAt: '2026-08-18T00:00:00.000Z',
          updatedAt: '2026-08-18T00:00:00.000Z',
        }),
      ),
    );
    await flush();

    expect(container.textContent).toMatch(/missing/i);
    const download = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Download'),
    );
    expect(download).toBeTruthy();
    expect(download).toHaveProperty('disabled', true);
  });

  it('does not read workspace bytes when stat says the path is a directory', async () => {
    mockWorkspaceActions.stat.mockResolvedValue({
      type: 'directory',
      sizeBytes: 0,
      modifiedMs: 1,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() =>
      root.render(
        artifactPanel({
          id: 'review-artifact',
          kind: 'file',
          storage: 'workspace',
          source: 'tool',
          status: 'available',
          title: 'Legacy folder',
          workspacePath: 'exports',
          retention: 'ephemeral',
          clientRetained: false,
          createdAt: '2026-08-18T00:00:00.000Z',
          updatedAt: '2026-08-18T00:00:00.000Z',
        }),
      ),
    );
    await flush();

    expect(container.textContent).toMatch(/director/i);
    expect(mockWorkspaceActions.readWorkspaceFile).not.toHaveBeenCalled();
  });
});

describe('ArtifactPanel trajectory entry', () => {
  function renderPanel(props: {
    items?: readonly WebShellRightPanelItem[];
    onOpenTrajectory?: () => void;
    tabs?: ArtifactPanelTab[];
    activeTabId?: string | null;
  }) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={props.tabs ?? []}
            activeTabId={props.activeTabId ?? null}
            reviewChanges={[]}
            selectedReviewPath={null}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
            {...(props.items ? { items: props.items } : {})}
            {...(props.onOpenTrajectory
              ? { onOpenTrajectory: props.onOpenTrajectory }
              : {})}
          />
        </I18nProvider>,
      );
    });
    return container;
  }

  const entry = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>(
      '[data-testid="right-panel-open-trajectory"]',
    );

  it('stays hidden for a host that did not ask for it', () => {
    // The default item set is unchanged by this feature, so a shell that
    // never mentions the trajectory looks exactly as it did before.
    const container = renderPanel({ onOpenTrajectory: () => {} });
    expect(entry(container)).toBeNull();
  });

  it('stays hidden when the host has no handler to open it with', () => {
    const container = renderPanel({ items: ['trajectory'] });
    expect(entry(container)).toBeNull();
  });

  it('opens the trajectory from the empty state', () => {
    const onOpenTrajectory = vi.fn();
    const container = renderPanel({ items: ['trajectory'], onOpenTrajectory });
    const button = entry(container);
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(onOpenTrajectory).toHaveBeenCalledTimes(1);
  });

  it('drops the entry once the session already has a trajectory tab', () => {
    const container = renderPanel({
      items: ['trajectory'],
      onOpenTrajectory: () => {},
      tabs: [
        {
          id: 'trajectory:s-1',
          kind: 'trajectory',
          title: 'Trajectory',
          sessionId: 's-1',
        },
      ],
      activeTabId: 'trajectory:s-1',
    });
    expect(entry(container)).toBeNull();
  });

  it('renders the trajectory tab body', () => {
    const container = renderPanel({
      items: ['trajectory'],
      onOpenTrajectory: () => {},
      tabs: [
        {
          id: 'trajectory:s-1',
          kind: 'trajectory',
          title: 'Trajectory',
          sessionId: 's-1',
        },
      ],
      activeTabId: 'trajectory:s-1',
    });
    expect(
      container.querySelector('[data-testid="trajectory-panel"]'),
    ).not.toBeNull();
  });
});
