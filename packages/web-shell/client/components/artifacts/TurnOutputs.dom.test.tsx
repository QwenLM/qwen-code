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
  publishArtifact: vi.fn(),
  setWorkspaceSetting: vi.fn(),
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useWorkspaceActions: () => ({
    readFileBytes,
    stat,
    artifactPublishConfig,
    publishArtifact,
    setWorkspaceSetting,
  }),
  useWorkspace: () => ({
    actions: {
      readFileBytes,
      stat,
      artifactPublishConfig,
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
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  const renderArtifacts = (artifacts: DaemonSessionArtifact[]) => {
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
    return { container, root };
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
  };

  const setInput = (selector: string, value: string) => {
    const input = document.body.querySelector<HTMLInputElement>(selector);
    if (!input) throw new Error(`missing input ${selector}`);
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const submitShare = async () => {
    const form = document.body.querySelector('form');
    await act(async () => {
      form?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
  };

  it('publishes through the daemon and shows the returned link', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      publisher: 'local',
      endpoint: 'oss-cn-hangzhou.aliyuncs.com',
      bucket: 'my-bucket',
      keyPrefix: 'artifacts',
      publicBaseUrl: '',
      credentialsSource: 'env',
    });
    publishArtifact.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      id: 'abc123',
      url: 'https://my-bucket.oss-cn-hangzhou.aliyuncs.com/artifacts/abc123/index.html',
      reachable: true,
      reachableStatus: 200,
    });

    const { container, root } = renderHtmlArtifact();
    await openShareDialog(container);
    await submitShare();

    expect(publishArtifact).toHaveBeenCalledTimes(1);
    expect(publishArtifact.mock.calls[0][0]).toMatchObject({
      path: 'output/report.html',
      remember: 'memory',
      config: { endpoint: 'oss-cn-hangzhou.aliyuncs.com', bucket: 'my-bucket' },
    });
    // Key prefix and public base URL are no longer part of the dialog.
    expect(publishArtifact.mock.calls[0][0].config).not.toHaveProperty(
      'keyPrefix',
    );
    // Credentials came from the daemon environment, so none are sent.
    expect(publishArtifact.mock.calls[0][0].config).not.toHaveProperty(
      'accessKeyId',
    );
    // 'memory' must never touch the settings file.
    expect(setWorkspaceSetting).not.toHaveBeenCalled();
    expect(
      document.body.querySelector<HTMLInputElement>('#share-result-url')?.value,
    ).toBe(
      'https://my-bucket.oss-cn-hangzhou.aliyuncs.com/artifacts/abc123/index.html',
    );
    expect(
      document.body.querySelector('[data-share-reachability]')?.textContent,
    ).toContain('publicly reachable');

    act(() => root.unmount());
  });

  it('reports an upload whose link is not publicly reachable', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      publisher: 'local',
      endpoint: 'oss-cn-hangzhou.aliyuncs.com',
      bucket: 'my-bucket',
      keyPrefix: 'artifacts',
      publicBaseUrl: '',
      credentialsSource: 'env',
    });
    publishArtifact.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      id: 'abc123',
      url: 'https://my-bucket.oss-cn-hangzhou.aliyuncs.com/artifacts/abc123/index.html',
      reachable: false,
      reachableStatus: 403,
    });

    const { container, root } = renderHtmlArtifact();
    await openShareDialog(container);
    await submitShare();

    const note = document.body.querySelector(
      '[data-share-reachability]',
    )?.textContent;
    expect(note).toContain('403');
    expect(note).toContain('blocks public access');

    act(() => root.unmount());
  });

  it('refuses to upload without any credential source', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      publisher: 'local',
      endpoint: 'oss-cn-hangzhou.aliyuncs.com',
      bucket: 'my-bucket',
      keyPrefix: 'artifacts',
      publicBaseUrl: '',
      credentialsSource: 'none',
    });

    const { container, root } = renderHtmlArtifact();
    await openShareDialog(container);
    await submitShare();

    expect(publishArtifact).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('No credentials available');

    act(() => root.unmount());
  });

  it('sends typed credentials and keeps them out of any settings write', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      publisher: 'local',
      endpoint: '',
      bucket: '',
      keyPrefix: 'artifacts',
      publicBaseUrl: '',
      credentialsSource: 'none',
    });
    publishArtifact.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      id: 'abc123',
      url: 'https://typed-bucket.example.com/artifacts/abc123/index.html',
      reachable: true,
      reachableStatus: 200,
    });

    const { container, root } = renderHtmlArtifact();
    await openShareDialog(container);

    setInput('#share-endpoint', 'oss-cn-beijing.aliyuncs.com');
    setInput('#share-bucket', 'typed-bucket');
    setInput('#share-access-key-id', 'ak-id');
    setInput('#share-access-key-secret', 'ak-secret');
    await submitShare();

    expect(publishArtifact).toHaveBeenCalledTimes(1);
    expect(publishArtifact.mock.calls[0][0]).toMatchObject({
      remember: 'memory',
      config: {
        endpoint: 'oss-cn-beijing.aliyuncs.com',
        bucket: 'typed-bucket',
        accessKeyId: 'ak-id',
        accessKeySecret: 'ak-secret',
      },
    });
    // Sharing never writes settings; the daemon holds this for its lifetime.
    expect(setWorkspaceSetting).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it('sends the public domain so the link is not the default OSS one', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      publisher: 'local',
      endpoint: 'oss-cn-beijing.aliyuncs.com',
      bucket: 'qqqys',
      keyPrefix: 'artifacts',
      publicBaseUrl: '',
      credentialsSource: 'env',
    });
    publishArtifact.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      id: 'abc123',
      url: 'https://cdn.example.com/artifacts/abc123/index.html',
      reachable: true,
      reachableStatus: 200,
    });

    const { container, root } = renderHtmlArtifact();
    await openShareDialog(container);

    setInput('#share-public-base-url', 'https://cdn.example.com');
    await submitShare();

    expect(publishArtifact.mock.calls[0][0].config.publicBaseUrl).toBe(
      'https://cdn.example.com',
    );

    act(() => root.unmount());
  });

  it('prefills the public domain the daemon already resolves', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      publisher: 'local',
      endpoint: 'oss-cn-beijing.aliyuncs.com',
      bucket: 'qqqys',
      keyPrefix: 'artifacts',
      publicBaseUrl: 'https://cdn.example.com',
      credentialsSource: 'env',
    });

    const { container, root } = renderHtmlArtifact();
    await openShareDialog(container);

    expect(
      document.body.querySelector<HTMLInputElement>('#share-public-base-url')
        ?.value,
    ).toBe('https://cdn.example.com');
    expect(
      document.body.querySelector('[data-share-public-base-url-hint]')
        ?.textContent,
    ).toContain('download the page instead of opening it');

    act(() => root.unmount());
  });

  it('tells the user the destination is only kept for this run', async () => {
    artifactPublishConfig.mockResolvedValue({
      v: 1,
      workspaceCwd: '/primary',
      publisher: 'local',
      endpoint: 'oss-cn-hangzhou.aliyuncs.com',
      bucket: 'my-bucket',
      keyPrefix: 'artifacts',
      publicBaseUrl: '',
      credentialsSource: 'env',
    });

    const { container, root } = renderHtmlArtifact();
    await openShareDialog(container);

    expect(
      document.body.querySelector('[data-share-storage-note]')?.textContent,
    ).toContain('forgotten when it exits');

    act(() => root.unmount());
  });
});
