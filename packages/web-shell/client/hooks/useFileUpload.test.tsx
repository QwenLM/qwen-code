// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useFileUpload,
  type FileUploadClient,
  type UseFileUploadReturn,
} from './useFileUpload';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

interface ProbeProps {
  client: FileUploadClient | undefined;
  maxBytes: number;
  targetKey: string;
}

let latest: UseFileUploadReturn | undefined;

function Probe({ client, maxBytes, targetKey }: ProbeProps) {
  latest = useFileUpload({ client, maxBytes, targetKey });
  return null;
}

function render(props: ProbeProps) {
  act(() => root!.render(<Probe {...props} />));
}

function makeFile(name: string, size = 3): File {
  // jsdom's File honours the provided blob bytes; pad to the requested size.
  return new File([new Uint8Array(size)], name);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const MAX = 1024;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latest = undefined;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('useFileUpload', () => {
  it('uploads a batch sequentially in selection order', async () => {
    const calls: string[] = [];
    const gates: Array<
      Deferred<{
        kind: 'file_upload';
        path: string;
        sizeBytes: number;
        hash: `sha256:${string}`;
      }>
    > = [];
    const client: FileUploadClient = {
      uploadWorkspaceFile: vi.fn((req) => {
        calls.push(req.path);
        const gate =
          deferred<
            Awaited<ReturnType<FileUploadClient['uploadWorkspaceFile']>>
          >();
        gates.push(gate as never);
        return gate.promise;
      }),
    };
    render({ client, maxBytes: MAX, targetKey: 'ws:/a' });

    act(() => {
      latest!.uploadFiles([makeFile('one.txt'), makeFile('two.txt')], '.');
    });
    // Only the first item starts; the second stays pending.
    expect(calls).toEqual(['one.txt']);
    expect(latest!.uploads.map((u) => u.status)).toEqual([
      'uploading',
      'pending',
    ]);

    await act(async () => {
      gates[0].resolve({
        kind: 'file_upload',
        path: 'one.txt',
        sizeBytes: 3,
        hash: `sha256:${'a'.repeat(64)}`,
      });
    });
    expect(calls).toEqual(['one.txt', 'two.txt']);
    expect(latest!.uploads[0]).toMatchObject({
      status: 'done',
      resultPath: 'one.txt',
    });

    await act(async () => {
      gates[1].resolve({
        kind: 'file_upload',
        path: 'two.txt',
        sizeBytes: 3,
        hash: `sha256:${'b'.repeat(64)}`,
      });
    });
    expect(latest!.uploads.map((u) => u.status)).toEqual(['done', 'done']);
  });

  it('rejects an oversized file locally without an HTTP request', async () => {
    const uploadWorkspaceFile = vi.fn();
    const client: FileUploadClient = { uploadWorkspaceFile };
    render({ client, maxBytes: MAX, targetKey: 'ws:/a' });
    const onUploaded = vi.fn();

    act(() => {
      latest!.uploadFiles([makeFile('big.bin', MAX + 1)], '.', onUploaded);
    });
    await act(async () => {});
    expect(uploadWorkspaceFile).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(latest!.uploads).toHaveLength(1);
    expect(latest!.uploads[0].status).toBe('error');
    expect(latest!.uploads[0].errorCode).toBe('tooLarge');
    expect(latest!.uploads[0].error).toBeUndefined();
  });

  it('accepts a file at exactly the size limit', async () => {
    const uploadWorkspaceFile = vi.fn(async () => ({
      kind: 'file_upload' as const,
      path: 'exact.bin',
      sizeBytes: MAX,
      hash: `sha256:${'a'.repeat(64)}`,
    }));
    const client: FileUploadClient = { uploadWorkspaceFile };
    render({ client, maxBytes: MAX, targetKey: 'ws:/a' });

    act(() => {
      latest!.uploadFiles([makeFile('exact.bin', MAX)], '.');
    });
    await act(async () => {});
    expect(uploadWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(latest!.uploads[0]).toMatchObject({ status: 'done' });
  });

  it('continues the batch after a local oversize rejection', async () => {
    const uploadWorkspaceFile = vi.fn(
      async (
        req,
      ): Awaited<ReturnType<FileUploadClient['uploadWorkspaceFile']>> => ({
        kind: 'file_upload',
        path: req.path,
        sizeBytes: 3,
        hash: `sha256:${'b'.repeat(64)}`,
      }),
    );
    const client: FileUploadClient = { uploadWorkspaceFile };
    render({ client, maxBytes: MAX, targetKey: 'ws:/a' });

    act(() => {
      latest!.uploadFiles(
        [makeFile('big.bin', MAX + 1), makeFile('small.txt')],
        '.',
      );
    });
    await act(async () => {});
    expect(uploadWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(uploadWorkspaceFile.mock.calls[0][0].path).toBe('small.txt');
    expect(latest!.uploads.map((u) => u.status)).toEqual(['error', 'done']);
  });

  it('passes the file bytes through with no SDK timeout', async () => {
    let captured:
      | Parameters<FileUploadClient['uploadWorkspaceFile']>[0]
      | undefined;
    const client: FileUploadClient = {
      uploadWorkspaceFile: vi.fn(async (req) => {
        captured = req;
        return {
          kind: 'file_upload' as const,
          path: req.path,
          sizeBytes: 3,
          hash: `sha256:${'c'.repeat(64)}`,
        };
      }),
    };
    render({ client, maxBytes: MAX, targetKey: 'ws:/a' });
    const file = makeFile('payload.bin');

    act(() => {
      latest!.uploadFiles([file], '.');
    });
    await act(async () => {});
    expect(captured?.data).toBe(file);
    expect(captured?.timeoutMs).toBe(0);
  });

  it('clamps progress between 0 and 1', async () => {
    let onProgress:
      | ((event: { loaded: number; total: number }) => void)
      | undefined;
    const gate =
      deferred<Awaited<ReturnType<FileUploadClient['uploadWorkspaceFile']>>>();
    const client: FileUploadClient = {
      uploadWorkspaceFile: vi.fn((req) => {
        onProgress = req.onProgress;
        return gate.promise;
      }),
    };
    render({ client, maxBytes: MAX, targetKey: 'ws:/a' });

    act(() => {
      latest!.uploadFiles([makeFile('big.bin', MAX)], '.');
    });
    expect(latest!.uploads[0].status).toBe('uploading');
    expect(onProgress).toBeDefined();

    act(() => onProgress!({ loaded: 3, total: 2 }));
    expect(latest!.uploads[0].progress).toBe(1);
    act(() => onProgress!({ loaded: 5, total: 0 }));
    expect(latest!.uploads[0].progress).toBe(0);
    act(() => onProgress!({ loaded: 1, total: 4 }));
    expect(latest!.uploads[0].progress).toBe(0.25);

    await act(async () => {
      gate.resolve({
        kind: 'file_upload',
        path: 'big.bin',
        sizeBytes: MAX,
        hash: `sha256:${'d'.repeat(64)}`,
      });
    });
  });

  it('invokes onUploaded exactly once with the server-confirmed path', async () => {
    const client: FileUploadClient = {
      uploadWorkspaceFile: vi.fn(async () => ({
        kind: 'file_upload' as const,
        path: 'report (1).pdf',
        sizeBytes: 3,
        hash: `sha256:${'c'.repeat(64)}`,
      })),
    };
    render({ client, maxBytes: MAX, targetKey: 'ws:/a' });
    const onUploaded = vi.fn();

    act(() => {
      latest!.uploadFiles([makeFile('report.pdf')], '.', onUploaded);
    });
    await act(async () => {});
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(onUploaded).toHaveBeenCalledWith('report (1).pdf');
    expect(latest!.uploads[0].resultPath).toBe('report (1).pdf');
  });

  it('keeps a successful upload done when onUploaded throws', async () => {
    const client: FileUploadClient = {
      uploadWorkspaceFile: vi.fn(async () => ({
        kind: 'file_upload' as const,
        path: 'report.pdf',
        sizeBytes: 3,
        hash: `sha256:${'c'.repeat(64)}`,
      })),
    };
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    render({ client, maxBytes: MAX, targetKey: 'ws:/a' });

    act(() => {
      latest!.uploadFiles([makeFile('report.pdf')], '.', () => {
        throw new Error('insert failed');
      });
    });
    await act(async () => {});

    expect(latest!.uploads[0]).toMatchObject({
      status: 'done',
      resultPath: 'report.pdf',
    });
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to handle uploaded file',
      expect.objectContaining({ message: 'insert failed' }),
    );
    consoleError.mockRestore();
  });

  it('dismisses a successful upload after three seconds', async () => {
    vi.useFakeTimers();
    try {
      const client: FileUploadClient = {
        uploadWorkspaceFile: vi.fn(async () => ({
          kind: 'file_upload' as const,
          path: 'report.pdf',
          sizeBytes: 3,
          hash: `sha256:${'c'.repeat(64)}`,
        })),
      };
      render({ client, maxBytes: MAX, targetKey: 'ws:/a' });

      act(() => latest!.uploadFiles([makeFile('report.pdf')], '.'));
      await act(async () => {});
      expect(latest!.uploads[0]?.status).toBe('done');

      await act(async () => vi.advanceTimersByTimeAsync(2999));
      expect(latest!.uploads).toHaveLength(1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(latest!.uploads).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds the target path from the target directory', async () => {
    const seenPaths: string[] = [];
    const client: FileUploadClient = {
      uploadWorkspaceFile: vi.fn(async (req) => {
        seenPaths.push(req.path);
        return {
          kind: 'file_upload' as const,
          path: req.path,
          sizeBytes: 3,
          hash: `sha256:${'d'.repeat(64)}`,
        };
      }),
    };
    render({ client, maxBytes: MAX, targetKey: 'ws:/a' });

    act(() => {
      latest!.uploadFiles([makeFile('a.txt')], 'sub/dir');
    });
    await act(async () => {});
    expect(seenPaths).toEqual(['sub/dir/a.txt']);
  });

  it('removing a pending item prevents it from starting', async () => {
    const gate =
      deferred<Awaited<ReturnType<FileUploadClient['uploadWorkspaceFile']>>>();
    const uploadWorkspaceFile = vi.fn(() => gate.promise);
    const client: FileUploadClient = { uploadWorkspaceFile };
    render({ client, maxBytes: MAX, targetKey: 'ws:/a' });

    act(() => {
      latest!.uploadFiles([makeFile('first.txt'), makeFile('second.txt')], '.');
    });
    const pendingId = latest!.uploads[1].id;
    act(() => {
      latest!.removeUpload(pendingId);
    });
    await act(async () => {
      gate.resolve({
        kind: 'file_upload',
        path: 'first.txt',
        sizeBytes: 3,
        hash: `sha256:${'e'.repeat(64)}`,
      });
    });
    // first.txt uploaded; the removed second.txt never started or reappeared.
    expect(uploadWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(latest!.uploads.map((u) => u.targetPath)).toEqual(['first.txt']);
  });

  it('removing an active item aborts it and ignores a late completion', async () => {
    const gate =
      deferred<Awaited<ReturnType<FileUploadClient['uploadWorkspaceFile']>>>();
    let signal: AbortSignal | undefined;
    const client: FileUploadClient = {
      uploadWorkspaceFile: vi.fn((req) => {
        signal = req.signal;
        return gate.promise;
      }),
    };
    const onUploaded = vi.fn();
    render({ client, maxBytes: MAX, targetKey: 'ws:/a' });

    act(() => {
      latest!.uploadFiles([makeFile('active.txt')], '.', onUploaded);
    });
    const activeId = latest!.uploads[0].id;
    act(() => latest!.removeUpload(activeId));
    expect(signal?.aborted).toBe(true);
    expect(latest!.uploads).toHaveLength(0);

    await act(async () => {
      gate.resolve({
        kind: 'file_upload',
        path: 'active.txt',
        sizeBytes: 3,
        hash: `sha256:${'1'.repeat(64)}`,
      });
    });
    expect(onUploaded).not.toHaveBeenCalled();
    expect(latest!.uploads).toHaveLength(0);
  });

  it('a failed upload does not block the next item', async () => {
    let call = 0;
    const client: FileUploadClient = {
      uploadWorkspaceFile: vi.fn(async (req) => {
        call += 1;
        if (call === 1) throw new Error('boom');
        return {
          kind: 'file_upload' as const,
          path: req.path,
          sizeBytes: 3,
          hash: `sha256:${'f'.repeat(64)}`,
        };
      }),
    };
    render({ client, maxBytes: MAX, targetKey: 'ws:/a' });
    const onUploaded = vi.fn();

    act(() => {
      latest!.uploadFiles(
        [makeFile('bad.txt'), makeFile('good.txt')],
        '.',
        onUploaded,
      );
    });
    await act(async () => {});
    expect(latest!.uploads[0]).toMatchObject({
      status: 'error',
      error: 'boom',
    });
    expect(latest!.uploads[1]).toMatchObject({ status: 'done' });
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(onUploaded).toHaveBeenCalledWith('good.txt');
  });

  it('keeps a removed upload removed when its abort rejects', async () => {
    const gate =
      deferred<Awaited<ReturnType<FileUploadClient['uploadWorkspaceFile']>>>();
    const client: FileUploadClient = {
      uploadWorkspaceFile: vi.fn(() => gate.promise),
    };
    const onUploaded = vi.fn();
    render({ client, maxBytes: MAX, targetKey: 'ws:/a' });

    act(() => {
      latest!.uploadFiles([makeFile('a.txt')], '.', onUploaded);
    });
    act(() => {
      latest!.removeUpload(latest!.uploads[0].id);
    });
    await act(async () => {
      gate.reject(new DOMException('This operation was aborted', 'AbortError'));
    });
    expect(latest!.uploads).toHaveLength(0);
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('ignores a rejection from the aborted generation on workspace switch', async () => {
    const gate =
      deferred<Awaited<ReturnType<FileUploadClient['uploadWorkspaceFile']>>>();
    const client: FileUploadClient = {
      uploadWorkspaceFile: vi.fn(() => gate.promise),
    };
    const onUploaded = vi.fn();
    render({ client, maxBytes: MAX, targetKey: 'ws:/a' });

    act(() => {
      latest!.uploadFiles([makeFile('a.txt')], '.', onUploaded);
    });
    render({ client, maxBytes: MAX, targetKey: 'ws:/b' });
    await act(async () => {
      gate.reject(new DOMException('This operation was aborted', 'AbortError'));
    });
    expect(latest!.uploads).toHaveLength(0);
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('aborts in-flight uploads and clears the queue on unmount', async () => {
    const gate =
      deferred<Awaited<ReturnType<FileUploadClient['uploadWorkspaceFile']>>>();
    let signal: AbortSignal | undefined;
    const client: FileUploadClient = {
      uploadWorkspaceFile: vi.fn((req) => {
        signal = req.signal;
        return gate.promise;
      }),
    };
    const onUploaded = vi.fn();
    render({ client, maxBytes: MAX, targetKey: 'ws:/a' });

    act(() => {
      latest!.uploadFiles([makeFile('a.txt')], '.', onUploaded);
    });
    expect(latest!.uploads).toHaveLength(1);

    act(() => {
      root!.unmount();
      root = null;
    });
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      gate.resolve({
        kind: 'file_upload',
        path: 'a.txt',
        sizeBytes: 3,
        hash: `sha256:${'9'.repeat(64)}`,
      });
    });
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('changing the target workspace clears the queue and ignores late completions', async () => {
    const gate =
      deferred<Awaited<ReturnType<FileUploadClient['uploadWorkspaceFile']>>>();
    const onUploaded = vi.fn();
    let signal: AbortSignal | undefined;
    const client: FileUploadClient = {
      uploadWorkspaceFile: vi.fn((req) => {
        signal = req.signal;
        return gate.promise;
      }),
    };
    render({ client, maxBytes: MAX, targetKey: 'ws:/a' });

    act(() => {
      latest!.uploadFiles([makeFile('a.txt')], '.', onUploaded);
    });
    expect(latest!.uploads).toHaveLength(1);

    // Switch workspace: aborts the in-flight upload and clears the queue.
    render({ client, maxBytes: MAX, targetKey: 'ws:/b' });
    expect(latest!.uploads).toHaveLength(0);
    expect(signal?.aborted).toBe(true);

    // A late resolution from the previous generation must not surface.
    await act(async () => {
      gate.resolve({
        kind: 'file_upload',
        path: 'a.txt',
        sizeBytes: 3,
        hash: `sha256:${'0'.repeat(64)}`,
      });
    });
    expect(latest!.uploads).toHaveLength(0);
    expect(onUploaded).not.toHaveBeenCalled();
  });
});
