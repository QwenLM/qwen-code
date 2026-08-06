// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';

const { readFileBytes, stat } = vi.hoisted(() => ({
  readFileBytes: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useWorkspaceActions: () => ({
    readFileBytes,
    stat,
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
});
