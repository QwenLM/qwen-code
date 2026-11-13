// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonWorkspaceMemoryFile,
  DaemonWorkspaceMemoryStatus,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const harness = vi.hoisted(() => ({
  availability: 'available',
  memoryVersion: 0,
  loadMemoryStatus: vi.fn(),
  readWorkspaceFile: vi.fn(),
  writeMemory: vi.fn(),
  onMessage: vi.fn(),
  outcomes: [] as Array<{
    data: DaemonWorkspaceMemoryStatus | undefined;
    superseded: boolean;
    error?: Error;
  }>,
}));

vi.mock('../../daemon/availability-context.js', () => ({
  useDaemonAvailability: () => harness.availability,
  useDaemonAvailabilityController: () => undefined,
}));
vi.mock('../../daemon/workspace/DaemonWorkspaceProvider.js', () => ({
  useDaemonWorkspaceActions: () => harness,
}));
vi.mock('../../daemon/session/DaemonSessionProvider.js', () => ({
  useDaemonWorkspaceEventSignals: () => ({
    memoryVersion: harness.memoryVersion,
  }),
}));
vi.mock('@qwen-code/web-shell/daemon-react-sdk', async () => {
  const { useDaemonMemory } = await import(
    '../../daemon/workspace/hooks/useDaemonMemory.js'
  );
  return {
    useMemory: (options: Parameters<typeof useDaemonMemory>[0]) => {
      const result = useDaemonMemory(options);
      const reload = result.reloadWithOutcome;
      const reloadWithOutcome = useCallback(async () => {
        const outcome = await reload();
        harness.outcomes.push(outcome);
        return outcome;
      }, [reload]);
      return { ...result, reloadWithOutcome };
    },
  };
});

const { MemoryMessage } = await import('./MemoryMessage');

const workspaceFile: DaemonWorkspaceMemoryFile = {
  kind: 'memory_file',
  path: '/workspace/QWEN.md',
  scope: 'workspace',
  bytes: 17,
  content: 'existing memory\n',
};

function statusWith(
  files: DaemonWorkspaceMemoryFile[],
): DaemonWorkspaceMemoryStatus {
  return {
    v: 1,
    workspaceCwd: '/workspace',
    initialized: true,
    files,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    fileCount: files.length,
    ruleCount: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;

async function renderPanel() {
  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <MemoryMessage onMessage={harness.onMessage} />
      </I18nProvider>,
    );
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function refresh() {
  act(() => {
    const button = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'Refresh',
    );
    expect(button?.disabled).toBe(false);
    button!.click();
  });
  await flush();
}

function contentReads() {
  return harness.loadMemoryStatus.mock.calls.filter(
    ([options]) => options?.includeContent === true,
  ).length;
}

beforeEach(() => {
  harness.availability = 'available';
  harness.memoryVersion = 0;
  harness.outcomes = [];
  harness.onMessage.mockReset();
  harness.readWorkspaceFile.mockReset();
  harness.writeMemory.mockReset();
  harness.loadMemoryStatus
    .mockReset()
    .mockResolvedValue(statusWith([workspaceFile]));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('MemoryMessage refresh with the resource hook', () => {
  it('reports an unavailable refresh even when the hook has no error', async () => {
    await renderPanel();
    harness.availability = 'unavailable';
    await renderPanel();
    const readsBefore = contentReads();

    await refresh();

    expect(container.textContent).toContain(
      'Could not refresh memory. Please try again.',
    );
    expect(harness.onMessage).toHaveBeenCalledWith(
      'Could not refresh memory. Please try again.',
      'error',
    );
    expect(harness.outcomes).toEqual([{ data: undefined, superseded: false }]);
    expect(contentReads()).toBe(readsBefore);
    expect(harness.writeMemory).not.toHaveBeenCalled();
  });

  it('reports a list-load error to both the panel and transcript', async () => {
    await renderPanel();
    const readsBefore = contentReads();
    const failure = new Error('workspace not trusted');
    harness.loadMemoryStatus.mockRejectedValue(failure);

    await refresh();

    expect(container.textContent).toContain('workspace not trusted');
    expect(harness.onMessage).toHaveBeenCalledWith(
      'workspace not trusted',
      'error',
    );
    expect(harness.outcomes).toEqual([
      { data: undefined, superseded: false, error: failure },
    ]);
    expect(contentReads()).toBe(readsBefore);
    expect(harness.writeMemory).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)(
    'reports a retryable refresh that %ss after a same-path workspace event',
    async (completion) => {
      await renderPanel();
      const oldRefresh = deferred<DaemonWorkspaceMemoryStatus>();
      const eventRefresh = deferred<DaemonWorkspaceMemoryStatus>();
      harness.loadMemoryStatus
        .mockImplementationOnce(() => oldRefresh.promise)
        .mockImplementationOnce(() => eventRefresh.promise);
      const readsBefore = contentReads();
      await refresh();

      harness.memoryVersion++;
      await renderPanel();
      await act(async () => {
        eventRefresh.resolve(
          statusWith([
            { ...workspaceFile, bytes: 30, content: 'newer status\n' },
          ]),
        );
      });
      await act(async () => {
        if (completion === 'resolve') {
          oldRefresh.resolve(
            statusWith([{ ...workspaceFile, content: 'obsolete status\n' }]),
          );
        } else {
          oldRefresh.reject(new Error('obsolete failure'));
        }
      });
      await flush();

      expect(harness.outcomes).toEqual([{ data: undefined, superseded: true }]);
      expect(contentReads()).toBe(readsBefore);
      expect(container.textContent).toContain(
        'Could not refresh memory. Please try again.',
      );
      expect(container.textContent).not.toContain('obsolete');
      expect(container.textContent).not.toContain('Memory refreshed.');
      expect(harness.onMessage).toHaveBeenCalledWith(
        'Could not refresh memory. Please try again.',
        'error',
      );
      expect(harness.writeMemory).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'confirms one completed content read when the file already existed: %s',
    async (alreadyExists) => {
      harness.loadMemoryStatus.mockResolvedValue(
        statusWith(alreadyExists ? [workspaceFile] : []),
      );
      await renderPanel();
      const readsBefore = contentReads();
      const read = deferred<DaemonWorkspaceMemoryStatus>();
      harness.loadMemoryStatus.mockImplementation(
        (options?: { includeContent?: boolean }) =>
          options?.includeContent
            ? read.promise
            : Promise.resolve(statusWith([workspaceFile])),
      );

      await refresh();

      expect(contentReads()).toBe(readsBefore + 1);
      expect(container.textContent).toContain('Loading memory file');
      expect(container.textContent).not.toContain('Memory refreshed.');
      await act(async () => {
        read.resolve(
          statusWith([{ ...workspaceFile, content: 'refreshed memory\n' }]),
        );
      });
      await flush();

      expect(contentReads()).toBe(readsBefore + 1);
      expect(container.textContent).toContain('refreshed memory');
      expect(container.textContent).toContain('Memory refreshed.');
      expect(harness.writeMemory).not.toHaveBeenCalled();
    },
  );

  it('confirms file removal without reading again or restoring stale content', async () => {
    const originalRead = deferred<DaemonWorkspaceMemoryStatus>();
    harness.loadMemoryStatus.mockImplementation(
      (options?: { includeContent?: boolean }) =>
        options?.includeContent
          ? originalRead.promise
          : Promise.resolve(statusWith([workspaceFile])),
    );
    await renderPanel();
    expect(contentReads()).toBe(1);
    expect(container.textContent).toContain('Loading memory file');
    harness.loadMemoryStatus.mockResolvedValue(statusWith([]));

    await refresh();

    expect(contentReads()).toBe(1);
    expect(container.textContent).not.toContain('Loading memory file');
    expect(container.textContent).toContain('Memory refreshed.');
    await act(async () => {
      originalRead.resolve(
        statusWith([{ ...workspaceFile, content: 'removed content\n' }]),
      );
    });
    expect(container.textContent).not.toContain('removed content');
    expect(container.textContent).toContain('Memory refreshed.');
    expect(harness.writeMemory).not.toHaveBeenCalled();
  });

  it('keeps a newer failed refresh visible when an earlier content read finishes', async () => {
    await renderPanel();
    const read = deferred<DaemonWorkspaceMemoryStatus>();
    harness.loadMemoryStatus.mockImplementation(
      (options?: { includeContent?: boolean }) =>
        options?.includeContent
          ? read.promise
          : Promise.resolve(statusWith([workspaceFile])),
    );
    await refresh();
    expect(container.textContent).toContain('Loading memory file');

    harness.availability = 'unavailable';
    await renderPanel();
    await refresh();
    expect(container.textContent).toContain(
      'Could not refresh memory. Please try again.',
    );

    await act(async () => {
      read.resolve(
        statusWith([
          { ...workspaceFile, content: 'earlier refresh content\n' },
        ]),
      );
    });
    await flush();

    expect(container.textContent).not.toContain('Loading memory file');
    expect(container.textContent).toContain(
      'Could not refresh memory. Please try again.',
    );
    expect(container.textContent).not.toContain('Memory refreshed.');
    expect(harness.onMessage).toHaveBeenCalledTimes(1);
    expect(harness.writeMemory).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'truncated'] as const)(
    'keeps a %s read warning instead of reporting refresh success',
    async (failure) => {
      await renderPanel();
      harness.loadMemoryStatus.mockImplementation(
        (options?: { includeContent?: boolean }) => {
          if (!options?.includeContent) {
            return Promise.resolve(statusWith([workspaceFile]));
          }
          return failure === 'rejected'
            ? Promise.reject(new Error('content unavailable'))
            : Promise.resolve(
                statusWith([
                  { ...workspaceFile, content: 'partial', truncated: true },
                ]),
              );
        },
      );

      await refresh();

      expect(container.textContent).not.toContain('Memory refreshed.');
      expect(container.textContent).toContain(
        failure === 'rejected' ? 'content unavailable' : 'truncated',
      );
      const edit = Array.from(container.querySelectorAll('button')).find(
        (item) => item.textContent === 'Edit',
      );
      expect(edit?.disabled).toBe(true);
      expect(harness.writeMemory).not.toHaveBeenCalled();
    },
  );
});
