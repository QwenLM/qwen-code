// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';

const {
  readFileBytes,
  stat,
  secondaryReadFileBytes,
  secondaryReadWorkspaceFile,
  secondaryStat,
  workspaceByCwd,
  artifactPublishConfig,
  setupArtifactNetlify,
  publishArtifact,
  setWorkspaceSetting,
} = vi.hoisted(() => ({
  readFileBytes: vi.fn(),
  stat: vi.fn(),
  secondaryReadFileBytes: vi.fn(),
  secondaryReadWorkspaceFile: vi.fn(),
  secondaryStat: vi.fn(),
  workspaceByCwd: vi.fn(),
  artifactPublishConfig: vi.fn(),
  setupArtifactNetlify: vi.fn(),
  publishArtifact: vi.fn(),
  setWorkspaceSetting: vi.fn(),
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useWorkspaceActions: () => ({
    readFileBytes,
    stat,
    artifactPublishConfig,
    setupArtifactNetlify,
    setupArtifactProvider: setupArtifactNetlify,
    publishArtifact,
    setWorkspaceSetting,
  }),
  useWorkspace: () => ({
    actions: {
      readFileBytes,
      stat,
      artifactPublishConfig,
      setupArtifactNetlify,
      setupArtifactProvider: setupArtifactNetlify,
      publishArtifact,
      setWorkspaceSetting,
    },
    client: { workspaceByCwd },
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
  }),
}));

const { TurnOutputs } = await import('./TurnOutputs');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const createdBlobs: Blob[] = [];

beforeEach(() => {
  createdBlobs.length = 0;
  stat.mockResolvedValue({ sizeBytes: 3, modifiedMs: 1 });
  readFileBytes.mockResolvedValue({
    contentBase64: btoa('abc'),
    offset: 0,
    returnedBytes: 3,
    sizeBytes: 3,
  });
  secondaryStat.mockResolvedValue({ sizeBytes: 9, modifiedMs: 2 });
  secondaryReadFileBytes.mockResolvedValue({
    contentBase64: btoa('secondary'),
    offset: 0,
    returnedBytes: 9,
    sizeBytes: 9,
  });
  workspaceByCwd.mockReturnValue({
    readWorkspaceFile: secondaryReadWorkspaceFile,
    readWorkspaceFileBytes: secondaryReadFileBytes,
    fileStat: secondaryStat,
    setupArtifactNetlify,
    setupArtifactProvider: setupArtifactNetlify,
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      createdBlobs.push(blob);
      return 'blob:artifact';
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  readFileBytes.mockReset();
  stat.mockReset();
  secondaryReadFileBytes.mockReset();
  secondaryReadWorkspaceFile.mockReset();
  secondaryStat.mockReset();
  workspaceByCwd.mockReset();
  artifactPublishConfig.mockReset();
  setupArtifactNetlify.mockReset();
  publishArtifact.mockReset();
  setWorkspaceSetting.mockReset();
});

describe('TurnOutputs artifact downloads', () => {
  it('shows Download for every available workspace artifact kind', () => {
    const kinds = [
      'file',
      'link',
      'html',
      'image',
      'video',
      'audio',
      'pdf',
      'notebook',
      'document',
      'other',
    ];
    const artifacts = kinds.map(
      (kind, index) =>
        ({
          id: `artifact-${index}`,
          kind,
          storage: 'workspace',
          status: 'available',
          title: `${kind} artifact`,
          workspacePath: `output/${kind}`,
        }) as DaemonSessionArtifact,
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <I18nProvider language="en">
          <TurnOutputs
            turnId="turn-1"
            workspaceCwd="/primary"
            changes={[]}
            artifacts={artifacts}
            scheduledTasks={[]}
            onReviewChanges={() => {}}
            onOpenArtifact={() => {}}
            onOpenScheduledTask={() => {}}
          />
        </I18nProvider>,
      );
    });

    expect(
      Array.from(container.querySelectorAll('button')).filter(
        (button) => button.textContent?.trim() === 'Download',
      ),
    ).toHaveLength(3);

    const showMore = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('more artifacts'),
    );
    expect(showMore).toBeTruthy();
    act(() => {
      showMore?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(
      Array.from(container.querySelectorAll('button')).filter(
        (button) => button.textContent?.trim() === 'Download',
      ),
    ).toHaveLength(kinds.length);

    act(() => root.unmount());
  });

  it('downloads workspace bytes with the artifact basename', async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <I18nProvider language="en">
          <TurnOutputs
            turnId="turn-1"
            workspaceCwd="/primary"
            changes={[]}
            artifacts={[
              {
                id: 'artifact-1',
                kind: 'pdf',
                storage: 'workspace',
                status: 'available',
                title: 'Report',
                workspacePath: 'reports/report.pdf',
                mimeType: 'application/pdf',
              } as DaemonSessionArtifact,
            ]}
            scheduledTasks={[]}
            onReviewChanges={() => {}}
            onOpenArtifact={() => {}}
            onOpenScheduledTask={() => {}}
          />
        </I18nProvider>,
      );
    });

    await act(async () => {
      const download = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Download',
      );
      download?.click();
      await Promise.resolve();
    });

    expect(readFileBytes).toHaveBeenCalledWith('reports/report.pdf', {
      offset: 0,
      maxBytes: 100 * 1024,
    });
    expect(click).toHaveBeenCalledOnce();
    expect(click.mock.instances[0]?.download).toBe('report.pdf');
    expect(createdBlobs[0]?.type).toBe('application/pdf');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:artifact');

    act(() => root.unmount());
  });

  it('routes a secondary workspace download through its qualified client', async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <StrictMode>
          <I18nProvider language="en">
            <TurnOutputs
              turnId="turn-secondary"
              workspaceCwd="/secondary"
              changes={[]}
              artifacts={[
                {
                  id: 'secondary-artifact',
                  kind: 'file',
                  storage: 'workspace',
                  status: 'available',
                  title: 'Secondary report',
                  workspacePath: 'report.txt',
                } as DaemonSessionArtifact,
              ]}
              scheduledTasks={[]}
              onReviewChanges={() => {}}
              onOpenArtifact={() => {}}
              onOpenScheduledTask={() => {}}
            />
          </I18nProvider>
        </StrictMode>,
      );
    });

    await act(async () => {
      const download = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Download',
      );
      download?.click();
      await Promise.resolve();
    });

    expect(workspaceByCwd).toHaveBeenCalledWith('/secondary');
    expect(secondaryReadFileBytes).toHaveBeenCalledWith('report.txt', {
      offset: 0,
      maxBytes: 100 * 1024,
    });
    expect(readFileBytes).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledOnce();

    act(() => root.unmount());
  });

  it('hides Download when the artifact workspace cannot be resolved', () => {
    workspaceByCwd.mockReturnValue(undefined);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <I18nProvider language="en">
          <TurnOutputs
            turnId="turn-unknown"
            workspaceCwd="/unknown"
            changes={[]}
            artifacts={[
              {
                id: 'unknown-artifact',
                kind: 'file',
                storage: 'workspace',
                status: 'available',
                title: 'Unknown report',
                workspacePath: 'report.txt',
              } as DaemonSessionArtifact,
            ]}
            scheduledTasks={[]}
            onReviewChanges={() => {}}
            onOpenArtifact={() => {}}
            onOpenScheduledTask={() => {}}
          />
        </I18nProvider>,
      );
    });

    expect(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Download',
      ),
    ).toBeUndefined();
    expect(readFileBytes).not.toHaveBeenCalled();
    expect(secondaryReadFileBytes).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it('stamps secondary ownership onto every panel open request', () => {
    const onOpenRequest = vi.fn();
    const artifact = {
      id: 'secondary-artifact',
      kind: 'file',
      storage: 'workspace',
      status: 'available',
      title: 'Secondary artifact',
      workspacePath: 'report.txt',
    } as DaemonSessionArtifact;
    const scheduledTask = {
      id: 'secondary-task',
      toolCallId: 'task-call',
      title: 'Secondary schedule',
      cron: '0 9 * * *',
      prompt: 'secondary only',
      recurring: true,
      durable: true,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <I18nProvider language="en">
          <TurnOutputs
            turnId="turn-secondary"
            workspaceCwd="/secondary"
            changes={[
              {
                path: 'changed.ts',
                status: 'modified',
                toolCallId: 'change-call',
                isArtifact: false,
                diffs: [],
              },
            ]}
            artifacts={[artifact]}
            scheduledTasks={[scheduledTask]}
            onOpenRequest={onOpenRequest}
            onReviewChanges={() => {}}
            onOpenArtifact={() => {}}
            onOpenScheduledTask={() => {}}
          />
        </I18nProvider>,
      );
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[title="changed.ts"]')
        ?.click();
      container
        .querySelector<HTMLButtonElement>('button[title="Secondary artifact"]')
        ?.click();
      container
        .querySelector<HTMLButtonElement>('button[title="Secondary schedule"]')
        ?.click();
    });

    expect(onOpenRequest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: 'review',
        workspaceCwd: '/secondary',
        workspaceId: 'secondary-id',
      }),
    );
    expect(onOpenRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: 'artifact',
        artifact,
        workspaceCwd: '/secondary',
        workspaceId: 'secondary-id',
      }),
    );
    expect(onOpenRequest).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        kind: 'scheduled_task',
        task: expect.objectContaining({
          id: 'secondary-task',
          workspaceId: 'secondary-id',
        }),
        workspaceCwd: '/secondary',
        workspaceId: 'secondary-id',
      }),
    );

    act(() => root.unmount());
  });

  it('disables repeated downloads and reports failures through the toast callback', async () => {
    let rejectStat: ((error: Error) => void) | undefined;
    stat.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectStat = reject;
      }),
    );
    const onError = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <I18nProvider language="en">
          <TurnOutputs
            turnId="turn-1"
            workspaceCwd="/primary"
            changes={[]}
            artifacts={[
              {
                id: 'artifact-1',
                kind: 'file',
                storage: 'workspace',
                status: 'available',
                title: 'Report',
                workspacePath: 'report.txt',
              } as DaemonSessionArtifact,
            ]}
            scheduledTasks={[]}
            onReviewChanges={() => {}}
            onOpenArtifact={() => {}}
            onOpenScheduledTask={() => {}}
            onError={onError}
          />
        </I18nProvider>,
      );
    });

    const download = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Download',
    );
    act(() => download?.click());
    expect(download?.disabled).toBe(true);
    expect(download?.textContent).toContain('Downloading');

    act(() => download?.click());
    expect(stat).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectStat?.(new Error('read denied'));
      await Promise.resolve();
    });
    expect(download?.disabled).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Download failed: read denied' }),
      'Download failed: read denied',
    );

    act(() => root.unmount());
  });

  it('does not show Download for managed, pending, or pathless artifacts', () => {
    const artifacts = [
      {
        id: 'workspace-1',
        kind: 'file',
        storage: 'workspace',
        status: 'available',
        title: 'workspace artifact',
        workspacePath: 'output/file.txt',
      },
      {
        id: 'managed-1',
        kind: 'file',
        storage: 'managed',
        status: 'available',
        title: 'managed artifact',
        workspacePath: 'output/managed.txt',
      },
      {
        id: 'pending-1',
        kind: 'file',
        storage: 'workspace',
        status: 'pending',
        title: 'pending artifact',
        workspacePath: 'output/pending.txt',
      },
      {
        id: 'pathless-1',
        kind: 'file',
        storage: 'workspace',
        status: 'available',
        title: 'pathless artifact',
      },
    ] as DaemonSessionArtifact[];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <I18nProvider language="en">
          <TurnOutputs
            turnId="turn-1"
            workspaceCwd="/primary"
            changes={[]}
            artifacts={artifacts}
            scheduledTasks={[]}
            onReviewChanges={() => {}}
            onOpenArtifact={() => {}}
            onOpenScheduledTask={() => {}}
          />
        </I18nProvider>,
      );
    });

    const showMore = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('more artifacts'),
    );
    expect(showMore).toBeTruthy();
    act(() => {
      showMore?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(
      Array.from(container.querySelectorAll('button')).filter(
        (button) => button.textContent?.trim() === 'Download',
      ),
    ).toHaveLength(1);

    act(() => root.unmount());
  });

  it('cancels the read and skips the save when the card unmounts mid-download', async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    let resolveRead: ((value: unknown) => void) | undefined;
    readFileBytes.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <I18nProvider language="en">
          <TurnOutputs
            turnId="turn-1"
            workspaceCwd="/primary"
            changes={[]}
            artifacts={[
              {
                id: 'artifact-1',
                kind: 'file',
                storage: 'workspace',
                status: 'available',
                title: 'Report',
                workspacePath: 'report.txt',
              } as DaemonSessionArtifact,
            ]}
            scheduledTasks={[]}
            onReviewChanges={() => {}}
            onOpenArtifact={() => {}}
            onOpenScheduledTask={() => {}}
          />
        </I18nProvider>,
      );
    });

    const download = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Download',
    );
    act(() => download?.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readFileBytes).toHaveBeenCalledTimes(1);

    act(() => root.unmount());

    await act(async () => {
      resolveRead?.({
        contentBase64: btoa('abc'),
        offset: 0,
        returnedBytes: 3,
        sizeBytes: 3,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(click).not.toHaveBeenCalled();
  });

  it('disables Open for a missing workspace artifact and shows the recorded path', () => {
    const onOpenArtifact = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <I18nProvider language="en">
          <TurnOutputs
            turnId="turn-missing"
            workspaceCwd="/primary"
            changes={[]}
            artifacts={[
              {
                id: 'missing-artifact',
                kind: 'file',
                storage: 'workspace',
                status: 'missing',
                title: 'Missing report',
                workspacePath: 'w/agent/report.csv',
              } as DaemonSessionArtifact,
            ]}
            scheduledTasks={[]}
            onReviewChanges={() => {}}
            onOpenArtifact={onOpenArtifact}
            onOpenScheduledTask={() => {}}
          />
        </I18nProvider>,
      );
    });

    const open = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Open',
    );
    expect(open?.disabled).toBe(true);
    expect(container.textContent).toContain(
      'File not found in the workspace · w/agent/report.csv',
    );

    act(() => open?.click());
    expect(onOpenArtifact).not.toHaveBeenCalled();

    act(() => root.unmount());
  });
});

describe('TurnOutputs artifact sharing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const renderArtifacts = (
    artifacts: DaemonSessionArtifact[],
    artifactSharingEnabled = true,
  ) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (enabled: boolean) => {
      root.render(
        <I18nProvider language="en">
          <TurnOutputs
            turnId="turn-1"
            workspaceCwd="/primary"
            artifactSharingEnabled={enabled}
            changes={[]}
            artifacts={artifacts}
            scheduledTasks={[]}
            onReviewChanges={() => {}}
            onOpenArtifact={() => {}}
            onOpenScheduledTask={() => {}}
          />
        </I18nProvider>,
      );
    };
    act(() => {
      render(artifactSharingEnabled);
    });
    return {
      container,
      root,
      rerender: (enabled: boolean) => act(() => render(enabled)),
    };
  };

  const shareButtons = (scope: ParentNode) =>
    Array.from(scope.querySelectorAll('button')).filter(
      (button) => button.textContent?.trim() === 'Share',
    );

  it.each([
    [{ kind: 'html', workspacePath: 'output/report' }, true],
    [{ kind: 'file', workspacePath: 'output/page.html' }, true],
    [{ kind: 'file', workspacePath: 'output/page.HTML' }, true],
    [{ kind: 'file', workspacePath: 'output/page.htm' }, true],
    [
      { kind: 'file', workspacePath: 'output/notes', mimeType: 'text/html' },
      true,
    ],
    [
      {
        kind: 'file',
        workspacePath: 'output/notes',
        mimeType: 'text/html; charset=utf-8',
      },
      true,
    ],
    [{ kind: 'file', workspacePath: 'output/notes.md' }, false],
    [{ kind: 'file', workspacePath: 'output/htmlish.txt' }, false],
    [{ kind: 'image', workspacePath: 'output/chart.png' }, false],
    [
      { kind: 'file', workspacePath: 'output/data', mimeType: 'text/plain' },
      false,
    ],
  ])('offers Share for %o only when it is HTML', (fields, shareable) => {
    const { container, root } = renderArtifacts([
      {
        id: 'artifact-0',
        storage: 'workspace',
        status: 'available',
        title: 'artifact',
        ...fields,
      } as DaemonSessionArtifact,
    ]);

    expect(shareButtons(container)).toHaveLength(shareable ? 1 : 0);

    act(() => root.unmount());
  });

  it('hides Share for an artifact that is not readable from the workspace', () => {
    const { container, root } = renderArtifacts([
      {
        id: 'artifact-pending',
        kind: 'html',
        storage: 'workspace',
        status: 'pending',
        title: 'pending report',
        workspacePath: 'output/report.html',
      } as DaemonSessionArtifact,
    ]);

    expect(shareButtons(container)).toHaveLength(0);

    act(() => root.unmount());
  });

  it('hides Share when artifact sharing is disabled in Settings', () => {
    const { container, root } = renderArtifacts(
      [
        {
          id: 'artifact-html',
          kind: 'html',
          storage: 'workspace',
          status: 'available',
          title: 'report',
          workspacePath: 'output/report.html',
        } as DaemonSessionArtifact,
      ],
      false,
    );

    expect(shareButtons(container)).toHaveLength(0);
    expect(artifactPublishConfig).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it('closes an open Share dialog when artifact sharing is disabled', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [],
    });
    const { container, root, rerender } = renderHtmlArtifact();

    await act(async () => shareButtons(container)[0]?.click());
    expect(document.body.querySelector('[data-share-provider]')).not.toBeNull();

    rerender(false);

    expect(document.body.querySelector('[data-share-provider]')).toBeNull();
    expect(shareButtons(container)).toHaveLength(0);

    act(() => root.unmount());
  });

  const renderHtmlArtifact = () =>
    renderArtifacts([
      {
        id: 'artifact-html',
        kind: 'html',
        storage: 'workspace',
        status: 'available',
        title: 'report',
        workspacePath: 'output/report.html',
      } as DaemonSessionArtifact,
    ]);

  const openShareDialog = async (container: ParentNode) => {
    await act(async () => {
      shareButtons(container)[0]?.click();
    });
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-share-provider="netlify"]')
        ?.click();
    });
  };

  const submitShare = async () => {
    const form = document.body.querySelector('form');
    await act(async () => {
      form?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
  };

  it('orders providers with Cloudflare selected by default', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [
        { kind: 'cloudflare', configured: false },
        { kind: 'vercel', configured: false },
        { kind: 'netlify', configured: false },
      ],
    });
    const { container, root } = renderHtmlArtifact();
    await act(async () => shareButtons(container)[0]?.click());

    const providers = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(
        '[data-share-provider]',
      ),
    );
    expect(providers.map((button) => button.dataset['shareProvider'])).toEqual([
      'cloudflare',
      'vercel',
      'netlify',
      'oss',
    ]);
    expect(providers[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(providers[1]?.getAttribute('aria-pressed')).toBe('false');

    const details = document.body.querySelector<HTMLDetailsElement>(
      '[data-share-details]',
    );
    expect(details?.open).toBe(false);
    await act(async () => details?.querySelector('summary')?.click());
    expect(details?.open).toBe(true);
    expect(details?.textContent).toContain('Wrangler CLI');
    expect(details?.textContent).toContain(
      'Dedicated Cloudflare Pages project',
    );
    expect(details?.textContent).toContain(
      'without changing the current project dependencies',
    );
    expect(details?.textContent).toContain(
      'tokens remain managed by the official CLI',
    );

    await act(async () => providers[1]?.click());
    expect(providers[0]?.getAttribute('aria-pressed')).toBe('false');
    expect(providers[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(details?.open).toBe(true);
    expect(details?.textContent).toContain('Vercel CLI');
    expect(details?.textContent).toContain('Dedicated Vercel project');
    expect(details?.textContent).toContain(
      'Vercel project ID, project name, and scope',
    );
    expect(artifactPublishConfig).toHaveBeenCalledTimes(1);
    expect(artifactPublishConfig).toHaveBeenCalledWith('output/report.html');

    act(() => root.unmount());
  });

  it('configures Aliyun OSS as custom hosting without requiring a CLI', async () => {
    const ossSetup = {
      provider: 'oss' as const,
      stage: 'authenticate' as const,
      cliInstalled: true,
      authenticated: false,
      linked: true,
      configured: false,
      oss: {
        endpoint: 'oss-cn-hangzhou.aliyuncs.com',
        bucket: 'my-artifacts',
        publicBaseUrl: 'https://artifacts.example.com',
        keyPrefix: 'qwen-artifacts',
        credentialsSource: 'none' as const,
      },
    };
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [{ kind: 'oss', configured: false }],
      setups: { oss: ossSetup },
    });
    setupArtifactNetlify.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [{ kind: 'oss', configured: true }],
      setups: {
        oss: { ...ossSetup, stage: 'ready', authenticated: true },
      },
      provider: 'oss',
      setup: { ...ossSetup, stage: 'ready', authenticated: true },
    });

    const { container, root } = renderHtmlArtifact();
    await act(async () => shareButtons(container)[0]?.click());
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-share-provider="oss"]')
        ?.click();
    });

    expect(
      document.body.querySelector<HTMLInputElement>('#share-oss-endpoint')
        ?.value,
    ).toBe('oss-cn-hangzhou.aliyuncs.com');
    expect(
      document.body.querySelector<HTMLInputElement>('#share-oss-bucket')?.value,
    ).toBe('my-artifacts');
    expect(
      document.body.querySelector<HTMLInputElement>(
        '#share-oss-public-base-url',
      )?.value,
    ).toBe('https://artifacts.example.com');
    expect(
      document.body.querySelector<HTMLInputElement>(
        '#share-oss-access-key-secret',
      )?.type,
    ).toBe('password');
    expect(document.body.textContent).toContain('Native OSS API');
    expect(document.body.textContent).toContain(
      'Domain binding, DNS, and HTTPS certificates',
    );

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-share-action="configure-oss"]')
        ?.click();
    });

    expect(setupArtifactNetlify).toHaveBeenCalledWith(
      'oss',
      {
        action: 'connect',
        endpoint: 'oss-cn-hangzhou.aliyuncs.com',
        bucket: 'my-artifacts',
        publicBaseUrl: 'https://artifacts.example.com',
        keyPrefix: 'qwen-artifacts',
      },
      { signal: expect.anything() },
    );

    act(() => root.unmount());
  });

  it('publishes through configured Cloudflare by default', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [
        { kind: 'cloudflare', configured: true },
        { kind: 'vercel', configured: false },
        { kind: 'netlify', configured: false },
      ],
      setups: {
        cloudflare: {
          provider: 'cloudflare',
          stage: 'ready',
          cliInstalled: true,
          authenticated: true,
          linked: true,
          configured: true,
          project: { id: 'pages-project', name: 'Artifact pages' },
        },
      },
    });
    publishArtifact.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      id: 'abc123',
      url: 'https://abc.artifact.pages.dev',
      provider: 'cloudflare',
    });
    const { container, root } = renderHtmlArtifact();
    await act(async () => shareButtons(container)[0]?.click());
    expect(
      document.body.querySelector(
        '[data-share-provider="cloudflare"] [data-share-provider-ready]',
      ),
    ).toBeTruthy();
    await submitShare();

    expect(publishArtifact).toHaveBeenCalledWith(
      {
        path: 'output/report.html',
        title: 'report',
        provider: 'cloudflare',
      },
      { signal: expect.anything() },
    );
    expect(
      document.body.querySelector<HTMLInputElement>('#share-result-url')?.value,
    ).toBe('https://abc.artifact.pages.dev');
    expect(document.body.textContent).toContain('Artifact published');
    expect(
      document.body.querySelector<HTMLAnchorElement>(
        'a[href="https://abc.artifact.pages.dev"]',
      )?.target,
    ).toBe('_blank');

    act(() => root.unmount());
  });

  it('opens an unchanged publication without deploying again', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [{ kind: 'cloudflare', configured: true }],
      setups: {
        cloudflare: {
          provider: 'cloudflare',
          stage: 'ready',
          cliInstalled: true,
          authenticated: true,
          linked: true,
          configured: true,
          project: { id: 'pages-project', name: 'Artifact pages' },
        },
      },
      publications: {
        cloudflare: {
          provider: 'cloudflare',
          id: 'abc123',
          url: 'https://abc.artifact.pages.dev',
          publishedAt: '2026-08-25T07:00:00.000Z',
          upToDate: true,
        },
      },
    });
    publishArtifact.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      id: 'abc123',
      url: 'https://new.artifact.pages.dev',
      provider: 'cloudflare',
      reused: false,
      recorded: true,
    });

    const { container, root } = renderHtmlArtifact();
    await act(async () => shareButtons(container)[0]?.click());

    expect(
      document.body.querySelector('[data-share-publication-state]')
        ?.textContent,
    ).toContain('Current version is published');
    expect(publishArtifact).not.toHaveBeenCalled();
    expect(
      document.body.querySelector<HTMLAnchorElement>(
        'a[href="https://abc.artifact.pages.dev"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-share-action="republish"]')
        ?.click();
    });
    expect(publishArtifact).toHaveBeenCalledWith(
      {
        path: 'output/report.html',
        title: 'report',
        provider: 'cloudflare',
        force: true,
      },
      { signal: expect.anything() },
    );

    act(() => root.unmount());
  });

  it('labels changed content and publishes a new version', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [{ kind: 'cloudflare', configured: true }],
      setups: {
        cloudflare: {
          provider: 'cloudflare',
          stage: 'ready',
          cliInstalled: true,
          authenticated: true,
          linked: true,
          configured: true,
        },
      },
      publications: {
        cloudflare: {
          provider: 'cloudflare',
          id: 'abc123',
          url: 'https://old.artifact.pages.dev',
          publishedAt: '2026-08-25T07:00:00.000Z',
          upToDate: false,
        },
      },
    });
    publishArtifact.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      id: 'abc123',
      url: 'https://new.artifact.pages.dev',
      provider: 'cloudflare',
    });

    const { container, root } = renderHtmlArtifact();
    await act(async () => shareButtons(container)[0]?.click());

    expect(
      document.body.querySelector('[data-share-publication-state="stale"]')
        ?.textContent,
    ).toContain('New changes are ready');
    expect(
      document.body.querySelector<HTMLButtonElement>(
        '[data-share-action="publish"]',
      )?.textContent,
    ).toContain('Publish new version');

    await submitShare();
    expect(publishArtifact).toHaveBeenCalledWith(
      {
        path: 'output/report.html',
        title: 'report',
        provider: 'cloudflare',
      },
      { signal: expect.anything() },
    );

    act(() => root.unmount());
  });

  it('publishes through configured Netlify and shows its link', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [{ kind: 'netlify', configured: true }],
      setup: {
        stage: 'ready',
        cliInstalled: true,
        authenticated: true,
        linked: true,
        configured: true,
        linkedSite: { id: 'site-id', name: 'Report site' },
      },
    });
    publishArtifact.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      id: 'abc123',
      url: 'https://preview.example.com/report',
      provider: 'netlify',
    });

    const { container, root } = renderHtmlArtifact();
    await openShareDialog(container);
    expect(
      document.body.querySelector('[data-share-netlify-status]')?.textContent,
    ).toContain('Publish this artifact once');
    expect(
      document.body.querySelector('[data-share-storage-note]')?.textContent,
    ).toContain('Anyone with the link can view it');
    expect(document.body.querySelector('#share-provider')).toBeNull();
    await submitShare();

    expect(publishArtifact).toHaveBeenCalledTimes(1);
    expect(publishArtifact.mock.calls[0][0]).toEqual({
      path: 'output/report.html',
      title: 'report',
      provider: 'netlify',
    });
    expect(setWorkspaceSetting).not.toHaveBeenCalled();
    expect(
      document.body.querySelector<HTMLInputElement>('#share-result-url')?.value,
    ).toBe('https://preview.example.com/report');

    act(() => root.unmount());
  });

  it('keeps credentials out of the Netlify dialog', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [
        {
          kind: 'netlify',
          configured: false,
          unavailableReason: 'netlify_cli_missing',
        },
      ],
      setup: {
        stage: 'install',
        cliInstalled: false,
        authenticated: false,
        linked: false,
        configured: false,
      },
    });

    const { container, root } = renderHtmlArtifact();
    await openShareDialog(container);

    expect(document.body.querySelector('#share-endpoint')).toBeNull();
    expect(document.body.querySelector('#share-access-key-id')).toBeNull();
    expect(document.body.querySelector('#share-public-base-url')).toBeNull();
    expect(
      document.body.querySelector('[data-share-storage-note]')?.textContent,
    ).toContain('securely by Netlify');
    expect(document.body.textContent).not.toContain('npm install');
    expect(document.body.textContent).not.toContain('netlify login');
    expect(document.body.textContent).not.toContain('daemon');
    expect(document.body.textContent).not.toContain('Auth Token');

    act(() => root.unmount());
  });

  it('treats the legacy v1 publish shape as not configured', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      publisher: 'local',
      endpoint: '',
      bucket: '',
      keyPrefix: 'artifacts',
      publicBaseUrl: '',
      credentialsSource: 'none',
    } as never);

    const { container, root } = renderHtmlArtifact();
    await openShareDialog(container);

    expect(
      document.body.querySelector('[data-share-netlify-status]')?.textContent,
    ).toContain('prepare Netlify sharing');
    expect(
      document.body.querySelector('[data-share-netlify-action="prepare"]'),
    ).not.toBeNull();

    act(() => root.unmount());
  });

  it('stops publishing in progress and unlocks the dialog', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [{ kind: 'netlify', configured: true }],
      setup: {
        stage: 'ready',
        cliInstalled: true,
        authenticated: true,
        linked: true,
        configured: true,
      },
    });
    let publishSignal: AbortSignal | undefined;
    publishArtifact.mockImplementation(
      async (_request, options?: { signal?: AbortSignal }) => {
        publishSignal = options?.signal;
        await new Promise<never>((_resolve, reject) => {
          publishSignal?.addEventListener(
            'abort',
            () => reject(publishSignal?.reason),
            { once: true },
          );
        });
      },
    );

    const { container, root } = renderHtmlArtifact();
    await openShareDialog(container);
    await submitShare();

    expect(document.body.querySelector('[data-dialog-close]')).not.toBeNull();
    const stopButton = document.body.querySelector<HTMLButtonElement>(
      '[data-share-action="stop"]',
    );
    expect(stopButton?.disabled).toBe(false);

    await act(async () => stopButton?.click());

    expect(publishSignal?.aborted).toBe(true);
    expect(
      document.body.querySelector<HTMLButtonElement>(
        '[data-share-action="publish"]',
      )?.disabled,
    ).toBe(false);

    act(() => root.unmount());
  });

  it('guides Netlify setup in order and prevents publishing until ready', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [
        {
          kind: 'netlify',
          configured: false,
          unavailableReason: 'netlify_cli_missing',
        },
      ],
      setup: {
        stage: 'install',
        cliInstalled: false,
        authenticated: false,
        linked: false,
        configured: false,
      },
    });

    const { container, root } = renderHtmlArtifact();
    await openShareDialog(container);

    const steps = Array.from(
      document.body.querySelectorAll('[data-share-netlify-step]'),
    );
    expect(
      steps.map((step) => step.getAttribute('data-share-netlify-step')),
    ).toEqual(['install', 'authenticate', 'connect', 'ready']);
    expect(steps[0]?.getAttribute('data-state')).toBe('active');
    expect(steps[1]?.getAttribute('data-state')).toBe('pending');
    expect(document.body.textContent).not.toContain('npm install');
    expect(document.body.textContent).not.toContain('netlify deploy');

    const publish = document.body.querySelector<HTMLButtonElement>(
      '[data-share-action="publish"]',
    );
    expect(publish?.disabled).toBe(true);
    await submitShare();

    expect(publishArtifact).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it('marks the current setup step as failed and offers a retry', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [
        {
          kind: 'netlify',
          configured: false,
          unavailableReason: 'netlify_cli_missing',
        },
      ],
      setup: {
        stage: 'install',
        cliInstalled: false,
        authenticated: false,
        linked: false,
        configured: false,
      },
    });
    setupArtifactNetlify.mockRejectedValue(new Error('permission denied'));
    const authWindow = {
      close: vi.fn(),
      location: { href: '' },
      opener: window,
    };
    vi.spyOn(window, 'open').mockReturnValue(authWindow as unknown as Window);
    const { container, root } = renderHtmlArtifact();

    await openShareDialog(container);
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>(
          '[data-share-netlify-action="prepare"]',
        )
        ?.click();
    });

    expect(
      document.body
        .querySelector('[data-share-netlify-step="install"]')
        ?.getAttribute('data-state'),
    ).toBe('error');
    expect(
      document.body.querySelector('[data-share-netlify-action="prepare"]')
        ?.textContent,
    ).toContain('Try again');
    expect(document.body.textContent).toContain(
      'Sharing setup could not be completed',
    );
    expect(document.body.textContent).not.toContain('permission denied');
    expect(authWindow.close).toHaveBeenCalled();
    expect(authWindow.opener).toBeNull();

    act(() => root.unmount());
  });

  it('prepares Netlify and receives a ready dedicated project in one call', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [
        {
          kind: 'netlify',
          configured: false,
          unavailableReason: 'netlify_cli_missing',
        },
      ],
      setup: {
        stage: 'install',
        cliInstalled: false,
        authenticated: false,
        linked: false,
        configured: false,
      },
    });
    setupArtifactNetlify.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [{ kind: 'netlify', configured: true }],
      setup: {
        stage: 'ready',
        cliInstalled: true,
        authenticated: true,
        linked: true,
        configured: true,
        linkedSite: { id: 'dedicated-site', name: 'Artifact site' },
      },
    });
    const authWindow = {
      close: vi.fn(),
      location: { href: '' },
      opener: window,
    };
    vi.spyOn(window, 'open').mockReturnValue(authWindow as unknown as Window);
    const { container, root } = renderHtmlArtifact();

    await openShareDialog(container);
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>(
          '[data-share-netlify-action="prepare"]',
        )
        ?.click();
    });

    expect(setupArtifactNetlify).toHaveBeenCalledTimes(1);
    expect(setupArtifactNetlify).toHaveBeenCalledWith(
      'netlify',
      { action: 'prepare' },
      { signal: expect.anything() },
    );
    expect(authWindow.close).toHaveBeenCalled();
    expect(authWindow.opener).toBeNull();
    expect(
      document.body.querySelector('[data-share-netlify-status]')?.textContent,
    ).toContain('Publish this artifact once');
    const publish = document.body.querySelector<HTMLButtonElement>(
      '[data-share-action="publish"]',
    );
    expect(publish?.disabled).toBe(false);

    act(() => root.unmount());
  });

  it('waits for a click before replacing a linked project with a dedicated target', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [
        {
          kind: 'netlify',
          configured: false,
          unavailableReason: 'netlify_site_unlinked',
        },
      ],
      setup: {
        stage: 'connect',
        cliInstalled: true,
        authenticated: true,
        linked: true,
        configured: false,
        linkedSite: { id: 'existing-site', name: 'Existing site' },
      },
    });
    setupArtifactNetlify.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [{ kind: 'netlify', configured: true }],
      setup: {
        stage: 'ready',
        cliInstalled: true,
        authenticated: true,
        linked: true,
        configured: true,
        linkedSite: { id: 'dedicated-site', name: 'Artifact site' },
      },
    });
    const { container, root } = renderHtmlArtifact();

    await openShareDialog(container);

    expect(setupArtifactNetlify).not.toHaveBeenCalled();
    const connectButton = document.body.querySelector<HTMLButtonElement>(
      '[data-share-netlify-action="connect"]',
    );
    expect(connectButton?.disabled).toBe(false);
    await act(async () => connectButton?.click());
    expect(setupArtifactNetlify).toHaveBeenCalledWith(
      'netlify',
      { action: 'prepare' },
      { signal: expect.anything() },
    );

    act(() => root.unmount());
  });

  it('continues setup without reopening authorization when no project exists', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [
        {
          kind: 'netlify',
          configured: false,
          unavailableReason: 'netlify_site_unlinked',
        },
      ],
      setup: {
        stage: 'connect',
        cliInstalled: true,
        authenticated: true,
        linked: false,
        configured: false,
        sites: [],
      },
    });
    setupArtifactNetlify.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [{ kind: 'netlify', configured: true }],
      setup: {
        stage: 'ready',
        cliInstalled: true,
        authenticated: true,
        linked: true,
        configured: true,
        linkedSite: { id: 'created-site', name: 'Created site' },
      },
    });
    const openWindow = vi.spyOn(window, 'open');
    const { container, root } = renderHtmlArtifact();

    await openShareDialog(container);
    const continueButton = document.body.querySelector<HTMLButtonElement>(
      '[data-share-netlify-action="connect"]',
    );
    expect(continueButton?.textContent).toContain('Connect project');
    expect(setupArtifactNetlify).not.toHaveBeenCalled();
    await act(async () => continueButton?.click());

    expect(setupArtifactNetlify).toHaveBeenCalledWith(
      'netlify',
      { action: 'prepare' },
      { signal: expect.anything() },
    );
    expect(openWindow).not.toHaveBeenCalled();
    expect(
      document.body.querySelector('[data-share-netlify-status]')?.textContent,
    ).toContain('Publish this artifact once');

    act(() => root.unmount());
  });

  it('can reopen an authorization page after the dialog is reopened', async () => {
    const authorizationUrl =
      'https://app.netlify.com/authorize?ticket=pending-ticket';
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [
        {
          kind: 'netlify',
          configured: false,
          unavailableReason: 'netlify_auth_required',
        },
      ],
      setup: {
        stage: 'authenticate',
        cliInstalled: true,
        authenticated: false,
        linked: false,
        configured: false,
        authorizationPending: true,
      },
    });
    setupArtifactNetlify.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [
        {
          kind: 'netlify',
          configured: false,
          unavailableReason: 'netlify_auth_required',
        },
      ],
      setup: {
        stage: 'authenticate',
        cliInstalled: true,
        authenticated: false,
        linked: false,
        configured: false,
        authorizationPending: true,
      },
      authorizationUrl,
    });
    const authWindow = {
      close: vi.fn(),
      location: { href: '' },
      opener: window,
    };
    vi.spyOn(window, 'open').mockReturnValue(authWindow as unknown as Window);
    const { container, root } = renderHtmlArtifact();

    await openShareDialog(container);

    const authorizeButton = document.body.querySelector<HTMLButtonElement>(
      '[data-share-netlify-action="prepare"]',
    );
    expect(authorizeButton?.disabled).toBe(false);
    expect(setupArtifactNetlify).not.toHaveBeenCalled();
    await act(async () => authorizeButton?.click());
    expect(setupArtifactNetlify).toHaveBeenCalledWith(
      'netlify',
      { action: 'prepare' },
      { signal: expect.anything() },
    );
    expect(authWindow.location.href).toBe(authorizationUrl);
    expect(authWindow.opener).toBeNull();

    act(() => root.unmount());
  });

  it('stops a pending provider authorization and unlocks the dialog', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [
        {
          kind: 'vercel',
          configured: false,
          unavailableReason: 'vercel_auth_required',
        },
      ],
      setups: {
        vercel: {
          provider: 'vercel',
          stage: 'authenticate',
          cliInstalled: true,
          authenticated: false,
          linked: false,
          configured: false,
        },
      },
    });
    let setupSignal: AbortSignal | undefined;
    setupArtifactNetlify.mockImplementation(
      async (
        _provider: string,
        _request: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        setupSignal = options?.signal;
        await new Promise<never>((_resolve, reject) => {
          setupSignal?.addEventListener(
            'abort',
            () => reject(setupSignal?.reason),
            { once: true },
          );
        });
      },
    );
    const { container, root } = renderHtmlArtifact();

    await openShareDialog(container);
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-share-provider="vercel"]')
        ?.click();
    });
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-share-action="prepare"]')
        ?.click();
    });

    const stopButton = document.body.querySelector<HTMLButtonElement>(
      '[data-share-action="stop"]',
    );
    expect(stopButton?.disabled).toBe(false);
    expect(
      document.body.querySelector<HTMLButtonElement>('[data-dialog-close]')
        ?.disabled,
    ).toBe(false);

    await act(async () => stopButton?.click());

    expect(setupSignal?.aborted).toBe(true);
    expect(
      document.body.querySelector<HTMLButtonElement>(
        '[data-share-action="prepare"]',
      )?.disabled,
    ).toBe(false);

    act(() => root.unmount());
  });

  it('never offers account projects as artifact targets', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [
        {
          kind: 'netlify',
          configured: false,
          unavailableReason: 'netlify_site_unlinked',
        },
      ],
      setup: {
        stage: 'connect',
        cliInstalled: true,
        authenticated: true,
        linked: false,
        configured: false,
        sites: [
          { id: 'site-a', name: 'Site A' },
          { id: 'site-b', name: 'Site B' },
        ],
      },
    });
    setupArtifactNetlify.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      providers: [{ kind: 'netlify', configured: true }],
      setup: {
        stage: 'ready',
        cliInstalled: true,
        authenticated: true,
        linked: true,
        configured: true,
        linkedSite: { id: 'dedicated-site', name: 'Artifact site' },
      },
    });
    const { container, root } = renderHtmlArtifact();

    await openShareDialog(container);
    expect(
      document.body.querySelector('[data-share-netlify-site-picker]'),
    ).toBeNull();
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>(
          '[data-share-netlify-action="connect"]',
        )
        ?.click();
    });

    expect(setupArtifactNetlify).toHaveBeenCalledWith(
      'netlify',
      { action: 'prepare' },
      { signal: expect.anything() },
    );
    act(() => root.unmount());
  });
});
