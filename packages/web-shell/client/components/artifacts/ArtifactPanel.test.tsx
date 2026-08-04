// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonSessionArtifact,
  DaemonSessionMonitorTaskStatus,
  DaemonSessionShellTaskStatus,
} from '@qwen-code/sdk/daemon';
import type { DaemonSessionActions } from '@qwen-code/webui/daemon-react-sdk';
import { I18nProvider } from '../../i18n';

const { mockActions, mockWorkspaceActions } = vi.hoisted(() => ({
  mockActions: {
    cancelTask: vi.fn(),
    getTasks: vi.fn(),
  },
  mockWorkspaceActions: {
    readFileBytes: vi.fn(),
    readWorkspaceFile: vi.fn(),
    stat: vi.fn(),
  },
}));

vi.mock(
  '@qwen-code/webui/daemon-react-sdk',
  async (importOriginal: () => Promise<Record<string, unknown>>) => ({
    ...(await importOriginal()),
    useActions: () => mockActions,
    useWorkspaceActions: () => mockWorkspaceActions,
  }),
);

const { ArtifactPanel } = await import('./ArtifactPanel');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

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

function artifactPanel(artifact: DaemonSessionArtifact) {
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

afterEach(() => {
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
  it('dispatches an available workspace artifact to the dedicated renderer', async () => {
    mockWorkspaceActions.readWorkspaceFile.mockResolvedValue({
      content: JSON.stringify({
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
      }),
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
            tabs={[{ id: 'review', kind: 'review', title: 'Review' }]}
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
