// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  DaemonHttpError,
  type DaemonArtifactLibrarySessionEnvelope,
  type DaemonSessionArtifact,
  type DaemonWorkspaceArtifactLibraryResult,
  type DaemonWorkspaceArtifactLibraryStreamEvent,
} from '@qwen-code/sdk/daemon';
import {
  flattenAndSortWorkspaceArtifacts,
  useWorkspaceArtifactLibrary,
  WORKSPACE_ARTIFACT_LIBRARY_FEATURE,
  WORKSPACE_ARTIFACT_LIBRARY_STREAM_FEATURE,
  type WorkspaceArtifactLibraryReader,
} from './useWorkspaceArtifactLibrary';

function makeArtifact(
  id: string,
  overrides: Partial<DaemonSessionArtifact> = {},
): DaemonSessionArtifact {
  return {
    id,
    title: `${id}.md`,
    kind: 'document',
    storage: 'workspace',
    workspacePath: `docs/${id}.md`,
    status: 'available',
    source: 'tool',
    retention: 'restorable',
    clientRetained: false,
    createdAt: '2026-11-21T08:00:00.000Z',
    updatedAt: '2026-11-21T09:00:00.000Z',
    ...overrides,
  };
}

function makeEnvelope(
  sessionId: string,
  artifacts: DaemonSessionArtifact[],
  archiveState: 'active' | 'archived' = 'active',
  displayName?: string,
): DaemonArtifactLibrarySessionEnvelope {
  return {
    v: 1,
    sessionId,
    generatedAt: '2026-11-21T10:00:00.000Z',
    limits: { maxArtifacts: 100 },
    session: {
      ...(displayName !== undefined ? { displayName } : {}),
      createdAt: '2026-11-20T00:00:00.000Z',
      archiveState,
      sourceType: 'web',
    },
    artifacts,
  };
}

function createControlledStream() {
  const queue: DaemonWorkspaceArtifactLibraryStreamEvent[] = [];
  let notify: (() => void) | undefined;
  let closed = false;
  let failure: unknown;

  const push = (event: DaemonWorkspaceArtifactLibraryStreamEvent) => {
    queue.push(event);
    const fn = notify;
    notify = undefined;
    fn?.();
  };
  const close = () => {
    closed = true;
    const fn = notify;
    notify = undefined;
    fn?.();
  };
  const fail = (err: unknown) => {
    failure = err;
    closed = true;
    const fn = notify;
    notify = undefined;
    fn?.();
  };
  async function* iterable(): AsyncGenerator<DaemonWorkspaceArtifactLibraryStreamEvent> {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (failure !== undefined) throw failure;
      if (closed) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  }
  return { push, close, fail, iterable };
}

async function flushBatch() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

describe('flattenAndSortWorkspaceArtifacts', () => {
  it('sorts newest-first by updatedAt with createdAt fallback and stable (sessionId, artifactId) tiebreak, omitting empty sessions', () => {
    const rows = flattenAndSortWorkspaceArtifacts([
      makeEnvelope('sess-empty', []),
      makeEnvelope('sess-b', [
        makeArtifact('art-2', {
          updatedAt: '2026-11-21T10:00:00.000Z',
        }),
        makeArtifact('art-1', {
          updatedAt: '2026-11-21T10:00:00.000Z',
        }),
      ]),
      makeEnvelope('sess-a', [
        makeArtifact('art-tie', {
          updatedAt: '2026-11-21T10:00:00.000Z',
        }),
        makeArtifact('art-fallback', {
          updatedAt: '',
          createdAt: '2026-11-21T11:00:00.000Z',
        }),
      ]),
    ]);

    expect(rows.map((r) => `${r.sessionId}:${r.artifact.id}`)).toEqual([
      'sess-a:art-fallback',
      'sess-a:art-tie',
      'sess-b:art-1',
      'sess-b:art-2',
    ]);
  });
});

describe('useWorkspaceArtifactLibrary', () => {
  const bothFeatures = [
    WORKSPACE_ARTIFACT_LIBRARY_FEATURE,
    WORKSPACE_ARTIFACT_LIBRARY_STREAM_FEATURE,
  ];

  it('does not query when workspace_artifact_library capability is absent', async () => {
    const reader: WorkspaceArtifactLibraryReader = {
      artifactLibrary: vi.fn(),
      artifactLibraryStream: vi.fn(),
    };
    const { result } = renderHook(() =>
      useWorkspaceArtifactLibrary({
        workspaceSelector: '/work/a',
        reader,
        features: ['session_artifacts'],
      }),
    );
    await flushBatch();
    expect(result.current.scanning).toBe(false);
    expect(result.current.complete).toBe(false);
    expect(reader.artifactLibrary).not.toHaveBeenCalled();
    expect(reader.artifactLibraryStream).not.toHaveBeenCalled();
  });

  it('accumulates SSE envelopes in batches, counts zero-artifact sessions toward progress, forwards full session_error records, and reconciles terminal counters on complete', async () => {
    const stream = createControlledStream();
    const reader: WorkspaceArtifactLibraryReader = {
      artifactLibrary: vi.fn(),
      artifactLibraryStream: vi.fn(() => stream.iterable()),
    };

    const { result } = renderHook(() =>
      useWorkspaceArtifactLibrary({
        workspaceSelector: '/work/a',
        reader,
        features: bothFeatures,
      }),
    );

    stream.push({ type: 'start', v: 1, total: 4 });
    stream.push({
      type: 'session',
      ...makeEnvelope('sess-empty', []),
    });
    stream.push({
      type: 'session',
      ...makeEnvelope(
        'sess-archived',
        [makeArtifact('art-arch')],
        'archived',
        'Archived audit',
      ),
    });
    stream.push({
      type: 'session_error',
      v: 1,
      sessionId: 'sess-big',
      status: 413,
      code: 'transcript_too_large',
      message: 'Transcript too large',
    });
    await flushBatch();

    expect(result.current.scanning).toBe(true);
    expect(result.current.progress).toEqual({ received: 3, total: 4 });
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows[0]?.session.archiveState).toBe('archived');
    expect(result.current.sessionErrors).toEqual([
      {
        sessionId: 'sess-big',
        status: 413,
        code: 'transcript_too_large',
        message: 'Transcript too large',
      },
    ]);

    // One candidate was silently skipped mid-scan (no event emitted);
    // `complete` reconciles terminal progress to 2 + 1 + 1 = 4.
    stream.push({
      type: 'complete',
      v: 1,
      total: 4,
      succeeded: 2,
      failed: 1,
      skipped: 1,
    });
    stream.close();
    await flushBatch();

    expect(result.current.scanning).toBe(false);
    expect(result.current.complete).toBe(true);
    expect(result.current.partial).toBe(false);
    expect(result.current.progress).toEqual({
      received: 4,
      total: 4,
    });
  });

  it('coalesces a burst of arriving session events into a single projection sort across a macrotask checkpoint', async () => {
    const stream = createControlledStream();
    const reader: WorkspaceArtifactLibraryReader = {
      artifactLibrary: vi.fn(),
      artifactLibraryStream: vi.fn(() => stream.iterable()),
    };
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      const { result } = renderHook(() =>
        useWorkspaceArtifactLibrary({
          workspaceSelector: '/work/a',
          reader,
          features: bothFeatures,
        }),
      );

      stream.push({ type: 'start', v: 1, total: 20 });
      for (let i = 0; i < 20; i += 1) {
        stream.push({
          type: 'session',
          ...makeEnvelope(`sess-${i}`, [
            makeArtifact(`art-${i}`, {
              updatedAt: `2026-11-21T10:${String(i).padStart(2, '0')}:00.000Z`,
            }),
          ]),
        });
      }
      await flushBatch();

      expect(result.current.rows).toHaveLength(20);
      expect(sortSpy.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('marks the result partial when the stream disconnects without complete or emits a terminal error frame', async () => {
    const stream = createControlledStream();
    const reader: WorkspaceArtifactLibraryReader = {
      artifactLibrary: vi.fn(),
      artifactLibraryStream: vi.fn(() => stream.iterable()),
    };

    const { result } = renderHook(() =>
      useWorkspaceArtifactLibrary({
        workspaceSelector: '/work/a',
        reader,
        features: bothFeatures,
      }),
    );

    stream.push({ type: 'start', v: 1, total: 3 });
    stream.push({
      type: 'session',
      ...makeEnvelope('sess-1', [makeArtifact('art-1')]),
    });
    stream.close();
    await flushBatch();

    expect(result.current.scanning).toBe(false);
    expect(result.current.complete).toBe(false);
    expect(result.current.partial).toBe(true);
    expect(result.current.rows).toHaveLength(1);

    // Refresh into a stream that emits a terminal `error` frame
    const streamErr = createControlledStream();
    vi.mocked(reader.artifactLibraryStream).mockReturnValueOnce(
      streamErr.iterable(),
    );
    act(() => {
      result.current.refresh();
    });
    streamErr.push({ type: 'start', v: 1, total: 2 });
    streamErr.push({
      type: 'error',
      v: 1,
      status: 503,
      code: 'workspace_runtime_unavailable',
      message: 'Runtime down',
    });
    streamErr.close();
    await flushBatch();

    expect(result.current.complete).toBe(false);
    expect(result.current.partial).toBe(true);
    expect(result.current.requestError).toEqual({
      status: 503,
      code: 'workspace_runtime_unavailable',
      message: 'Runtime down',
    });
  });

  it('keeps complete sticky when a transport error occurs after the complete frame', async () => {
    const stream = createControlledStream();
    const reader: WorkspaceArtifactLibraryReader = {
      artifactLibrary: vi.fn(),
      artifactLibraryStream: vi.fn(() => stream.iterable()),
    };

    const { result } = renderHook(() =>
      useWorkspaceArtifactLibrary({
        workspaceSelector: '/work/a',
        reader,
        features: bothFeatures,
      }),
    );

    stream.push({ type: 'start', v: 1, total: 1 });
    stream.push({
      type: 'session',
      ...makeEnvelope('sess-1', [makeArtifact('art-1')]),
    });
    stream.push({
      type: 'complete',
      v: 1,
      total: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    stream.fail(new TypeError('terminated after complete'));
    await flushBatch();

    expect(result.current.scanning).toBe(false);
    expect(result.current.complete).toBe(true);
    expect(result.current.partial).toBe(false);
    expect(result.current.requestError).toBeUndefined();
    expect(result.current.rows.map((r) => r.artifact.id)).toEqual(['art-1']);
  });

  it('preserves delivered rows on mid-scan transport rejection and aborts options.signal on refresh, workspace change, and unmount', async () => {
    const stream1 = createControlledStream();
    const stream2 = createControlledStream();
    const stream3 = createControlledStream();
    const capturedSignals: Array<AbortSignal | undefined> = [];
    let call = 0;
    const reader: WorkspaceArtifactLibraryReader = {
      artifactLibrary: vi.fn(),
      artifactLibraryStream: vi.fn((_ws, opts) => {
        capturedSignals.push(opts?.signal);
        call += 1;
        if (call === 1) return stream1.iterable();
        if (call === 2) return stream2.iterable();
        return stream3.iterable();
      }),
    };

    const { result, rerender, unmount } = renderHook(
      ({ ws }: { ws: string }) =>
        useWorkspaceArtifactLibrary({
          workspaceSelector: ws,
          reader,
          features: bothFeatures,
        }),
      { initialProps: { ws: '/work/a' } },
    );

    stream1.push({ type: 'start', v: 1, total: 3 });
    stream1.push({
      type: 'session',
      ...makeEnvelope('sess-1', [makeArtifact('art-1')]),
    });
    stream1.push({
      type: 'session',
      ...makeEnvelope('sess-2', [makeArtifact('art-2')]),
    });
    stream1.fail(
      new DaemonHttpError(
        500,
        { code: 'internal_error', message: 'Stream dropped' },
        'HTTP 500',
      ),
    );
    await flushBatch();

    expect(result.current.scanning).toBe(false);
    expect(result.current.complete).toBe(false);
    expect(result.current.partial).toBe(true);
    expect(result.current.rows.map((r) => r.artifact.id)).toEqual([
      'art-1',
      'art-2',
    ]);
    expect(result.current.requestError?.status).toBe(500);
    expect(capturedSignals[0]?.aborted).toBe(false);

    // Refresh aborts signal 0
    act(() => {
      result.current.refresh();
    });
    expect(capturedSignals[0]?.aborted).toBe(true);
    expect(capturedSignals[1]?.aborted).toBe(false);

    // Workspace change aborts signal 1
    rerender({ ws: '/work/b' });
    expect(capturedSignals[1]?.aborted).toBe(true);
    expect(capturedSignals[2]?.aborted).toBe(false);

    // Unmount aborts signal 2
    unmount();
    expect(capturedSignals[2]?.aborted).toBe(true);
  });

  it('falls back to JSON within the same generation on 503 sse_connection_limit_exceeded', async () => {
    const reader: WorkspaceArtifactLibraryReader = {
      artifactLibraryStream: vi.fn(
        (): AsyncIterable<DaemonWorkspaceArtifactLibraryStreamEvent> => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              Promise.reject(
                new DaemonHttpError(
                  503,
                  {
                    code: 'sse_connection_limit_exceeded',
                    error: 'Limit exceeded',
                  },
                  'HTTP 503',
                  '5',
                ),
              ),
          }),
        }),
      ),
      artifactLibrary: vi.fn().mockResolvedValue({
        v: 1,
        sessions: [makeEnvelope('sess-json', [makeArtifact('art-json')])],
        errors: [],
      }),
    };

    const { result } = renderHook(() =>
      useWorkspaceArtifactLibrary({
        workspaceSelector: '/work/a',
        reader,
        features: bothFeatures,
      }),
    );
    await flushBatch();

    expect(reader.artifactLibraryStream).toHaveBeenCalledTimes(1);
    expect(reader.artifactLibrary).toHaveBeenCalledTimes(1);
    expect(result.current.complete).toBe(true);
    expect(result.current.partial).toBe(false);
    expect(result.current.owner?.generation).toBe(1);
    expect(result.current.rows.map((r) => r.artifact.id)).toEqual(['art-json']);
  });

  it('interleaving witness (negative): same-workspace overlapping refresh ignores delayed session(A) and complete(A) even when delivered after abort', async () => {
    const streamA = createControlledStream();
    const streamB = createControlledStream();
    let call = 0;
    // Transport ignores abort and keeps delivering queued events from A after B settles.
    const reader: WorkspaceArtifactLibraryReader = {
      artifactLibrary: vi.fn(),
      artifactLibraryStream: vi.fn(() => {
        call += 1;
        return call === 1 ? streamA.iterable() : streamB.iterable();
      }),
    };

    const { result } = renderHook(() =>
      useWorkspaceArtifactLibrary({
        workspaceSelector: '/work/a',
        reader,
        features: bothFeatures,
      }),
    );

    // Scan A emits an older envelope for session S
    streamA.push({ type: 'start', v: 1, total: 2 });
    streamA.push({
      type: 'session',
      ...makeEnvelope('sess-s', [
        makeArtifact('art-old-from-a', {
          updatedAt: '2026-11-21T08:00:00.000Z',
        }),
      ]),
    });
    await flushBatch();
    expect(result.current.rows.map((r) => r.artifact.id)).toEqual([
      'art-old-from-a',
    ]);

    // User triggers refresh -> Scan B starts
    act(() => {
      result.current.refresh();
    });
    streamB.push({ type: 'start', v: 1, total: 1 });
    streamB.push({
      type: 'session',
      ...makeEnvelope('sess-s', [
        makeArtifact('art-new-from-b', {
          updatedAt: '2026-11-21T11:00:00.000Z',
        }),
      ]),
    });
    streamB.push({
      type: 'complete',
      v: 1,
      total: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    streamB.close();
    await flushBatch();

    expect(result.current.complete).toBe(true);
    expect(result.current.rows.map((r) => r.artifact.id)).toEqual([
      'art-new-from-b',
    ]);

    // Delayed events from superseded scan A arrive after B completed
    streamA.push({
      type: 'session',
      ...makeEnvelope('sess-s', [makeArtifact('art-stale-late-a')]),
    });
    streamA.push({
      type: 'complete',
      v: 1,
      total: 2,
      succeeded: 2,
      failed: 0,
      skipped: 0,
    });
    streamA.close();
    await flushBatch();

    // Final view, progress, and generation must reflect only B
    expect(result.current.owner?.generation).toBe(2);
    expect(result.current.rows.map((r) => r.artifact.id)).toEqual([
      'art-new-from-b',
    ]);
    expect(result.current.progress.total).toBe(1);
  });

  it('interleaving witness (negative): A -> B -> A workspace round-trip does not revive old A scan on workspace-key equality', async () => {
    const streamA1 = createControlledStream();
    const streamB = createControlledStream();
    const streamA2 = createControlledStream();
    let call = 0;
    const reader: WorkspaceArtifactLibraryReader = {
      artifactLibrary: vi.fn(),
      artifactLibraryStream: vi.fn(() => {
        call += 1;
        if (call === 1) return streamA1.iterable();
        if (call === 2) return streamB.iterable();
        return streamA2.iterable();
      }),
    };

    const { result, rerender } = renderHook(
      ({ ws }: { ws: string }) =>
        useWorkspaceArtifactLibrary({
          workspaceSelector: ws,
          reader,
          features: bothFeatures,
        }),
      { initialProps: { ws: '/work/a' } },
    );

    // Switch A -> B -> A before A1 settles
    rerender({ ws: '/work/b' });
    rerender({ ws: '/work/a' });

    // Now old A1 emits an envelope and complete (workspaceKey '/work/a' matches current!)
    streamA1.push({
      type: 'session',
      ...makeEnvelope('sess-zombie-a1', [makeArtifact('art-zombie-a1')]),
    });
    streamA1.push({
      type: 'complete',
      v: 1,
      total: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    streamA1.close();
    await flushBatch();

    expect(result.current.rows).toHaveLength(0);
    expect(result.current.complete).toBe(false);

    // Current A2 settles
    streamA2.push({
      type: 'session',
      ...makeEnvelope('sess-a2', [makeArtifact('art-a2')]),
    });
    streamA2.push({
      type: 'complete',
      v: 1,
      total: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    streamA2.close();
    await flushBatch();

    expect(result.current.owner).toEqual({
      workspaceKey: '/work/a',
      generation: 3,
    });
    expect(result.current.complete).toBe(true);
    expect(result.current.rows.map((r) => r.artifact.id)).toEqual(['art-a2']);
  });

  it('terminal-commit ownership witness: a superseded stream or JSON scan closing with no further events after B settles does not overwrite B', async () => {
    const streamA = createControlledStream();
    const streamB = createControlledStream();
    let call = 0;
    const reader: WorkspaceArtifactLibraryReader = {
      artifactLibrary: vi.fn(),
      artifactLibraryStream: vi.fn(() => {
        call += 1;
        return call === 1 ? streamA.iterable() : streamB.iterable();
      }),
    };

    const { result } = renderHook(() =>
      useWorkspaceArtifactLibrary({
        workspaceSelector: '/work/a',
        reader,
        features: bothFeatures,
      }),
    );

    streamA.push({ type: 'start', v: 1, total: 5 });
    await flushBatch();
    act(() => {
      result.current.refresh();
    });
    streamB.push({ type: 'start', v: 1, total: 1 });
    streamB.push({
      type: 'session',
      ...makeEnvelope('sess-b', [makeArtifact('art-b')]),
    });
    streamB.push({
      type: 'complete',
      v: 1,
      total: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    streamB.close();
    await flushBatch();

    // Superseded stream A closes cleanly with no further queued events
    streamA.close();
    await flushBatch();

    expect(result.current.rows.map((r) => r.artifact.id)).toEqual(['art-b']);
    expect(result.current.complete).toBe(true);
    expect(result.current.partial).toBe(false);
    expect(result.current.progress.total).toBe(1);

    // JSON arm: stale promise resolves after the refreshed scan completed
    let resolveStale!: (val: DaemonWorkspaceArtifactLibraryResult) => void;
    let jsonCall = 0;
    const jsonReader: WorkspaceArtifactLibraryReader = {
      artifactLibraryStream: vi.fn(),
      artifactLibrary: vi.fn(() => {
        jsonCall += 1;
        if (jsonCall === 1) {
          return new Promise<DaemonWorkspaceArtifactLibraryResult>(
            (resolve) => {
              resolveStale = resolve;
            },
          );
        }
        return Promise.resolve({
          v: 1 as const,
          sessions: [makeEnvelope('sess-b-json', [makeArtifact('art-b-json')])],
          errors: [],
        });
      }),
    };

    const jsonHook = renderHook(() =>
      useWorkspaceArtifactLibrary({
        workspaceSelector: '/work/a',
        reader: jsonReader,
        features: [WORKSPACE_ARTIFACT_LIBRARY_FEATURE],
      }),
    );
    act(() => {
      jsonHook.result.current.refresh();
    });
    await flushBatch();
    expect(jsonHook.result.current.rows.map((r) => r.artifact.id)).toEqual([
      'art-b-json',
    ]);

    resolveStale({
      v: 1,
      sessions: [makeEnvelope('sess-a-json', [makeArtifact('art-a-json')])],
      errors: [],
    });
    await flushBatch();
    expect(jsonHook.result.current.rows.map((r) => r.artifact.id)).toEqual([
      'art-b-json',
    ]);
  });
});
