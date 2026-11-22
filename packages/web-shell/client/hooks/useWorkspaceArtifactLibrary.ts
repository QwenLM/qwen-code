import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DaemonArtifactLibraryMemberError,
  DaemonArtifactLibrarySessionEnvelope,
  DaemonArtifactLibrarySessionMetadata,
  DaemonSessionArtifact,
  DaemonWorkspaceArtifactLibraryResult,
  DaemonWorkspaceArtifactLibraryStreamEvent,
} from '@qwen-code/sdk/daemon';
import {
  readDaemonHttpErrorInfo,
  type DaemonHttpErrorInfo,
} from '../components/artifacts/artifactUtils';

export const WORKSPACE_ARTIFACT_LIBRARY_FEATURE = 'workspace_artifact_library';
export const WORKSPACE_ARTIFACT_LIBRARY_STREAM_FEATURE =
  'workspace_artifact_library_stream';

export interface WorkspaceArtifactLibraryRow {
  key: string;
  sessionId: string;
  session: DaemonArtifactLibrarySessionMetadata;
  artifact: DaemonSessionArtifact;
}

export interface WorkspaceArtifactLibraryProgress {
  received: number;
  total: number | undefined;
}

export type WorkspaceArtifactLibraryRequestError = DaemonHttpErrorInfo;

export interface ScanOwner {
  readonly workspaceKey: string;
  readonly generation: number;
}

export interface WorkspaceArtifactLibraryReader {
  artifactLibrary(
    workspaceSelector: string,
    options?: { signal?: AbortSignal },
  ): Promise<DaemonWorkspaceArtifactLibraryResult>;
  artifactLibraryStream(
    workspaceSelector: string,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<DaemonWorkspaceArtifactLibraryStreamEvent>;
}

export interface UseWorkspaceArtifactLibraryOptions {
  workspaceSelector: string | undefined;
  reader: WorkspaceArtifactLibraryReader;
  features: readonly string[] | undefined;
}

export interface WorkspaceArtifactLibraryState {
  scanning: boolean;
  complete: boolean;
  partial: boolean;
  rows: readonly WorkspaceArtifactLibraryRow[];
  sessionErrors: readonly DaemonArtifactLibraryMemberError[];
  requestError: WorkspaceArtifactLibraryRequestError | undefined;
  progress: WorkspaceArtifactLibraryProgress;
  owner: ScanOwner | undefined;
  refresh: () => void;
}

function artifactSortTimestamp(artifact: DaemonSessionArtifact): string {
  return artifact.updatedAt || artifact.createdAt || '';
}

export function flattenAndSortWorkspaceArtifacts(
  envelopes: Iterable<DaemonArtifactLibrarySessionEnvelope>,
): WorkspaceArtifactLibraryRow[] {
  const rows: WorkspaceArtifactLibraryRow[] = [];
  for (const envelope of envelopes) {
    for (const artifact of envelope.artifacts) {
      rows.push({
        key: `${envelope.sessionId}\0${artifact.id}`,
        sessionId: envelope.sessionId,
        session: envelope.session,
        artifact,
      });
    }
  }
  rows.sort((left, right) => {
    const leftTs = artifactSortTimestamp(left.artifact);
    const rightTs = artifactSortTimestamp(right.artifact);
    if (leftTs !== rightTs) return rightTs < leftTs ? -1 : 1;
    if (left.sessionId !== right.sessionId) {
      return left.sessionId < right.sessionId ? -1 : 1;
    }
    return left.artifact.id < right.artifact.id
      ? -1
      : left.artifact.id > right.artifact.id
        ? 1
        : 0;
  });
  return rows;
}

export function isSseAdmissionRefusal(error: unknown): boolean {
  const info = readDaemonHttpErrorInfo(error);
  return info.status === 503 && info.code === 'sse_connection_limit_exceeded';
}

export function extractArtifactLibraryRequestError(
  error: unknown,
): WorkspaceArtifactLibraryRequestError {
  return readDaemonHttpErrorInfo(error);
}

const EMPTY_ROWS: readonly WorkspaceArtifactLibraryRow[] = [];
const EMPTY_ERRORS: readonly DaemonArtifactLibraryMemberError[] = [];
const INITIAL_PROGRESS: WorkspaceArtifactLibraryProgress = {
  received: 0,
  total: undefined,
};

export function useWorkspaceArtifactLibrary({
  workspaceSelector,
  reader,
  features,
}: UseWorkspaceArtifactLibraryOptions): WorkspaceArtifactLibraryState {
  const supported =
    features?.includes(WORKSPACE_ARTIFACT_LIBRARY_FEATURE) === true;
  const streamSupported =
    features?.includes(WORKSPACE_ARTIFACT_LIBRARY_STREAM_FEATURE) === true;

  const generationRef = useRef(0);
  const ownerRef = useRef<ScanOwner | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const readerRef = useRef(reader);
  readerRef.current = reader;

  const [state, setState] = useState<{
    owner: ScanOwner | undefined;
    scanning: boolean;
    complete: boolean;
    partial: boolean;
    rows: readonly WorkspaceArtifactLibraryRow[];
    sessionErrors: readonly DaemonArtifactLibraryMemberError[];
    requestError: WorkspaceArtifactLibraryRequestError | undefined;
    progress: WorkspaceArtifactLibraryProgress;
  }>({
    owner: undefined,
    scanning: false,
    complete: false,
    partial: false,
    rows: EMPTY_ROWS,
    sessionErrors: EMPTY_ERRORS,
    requestError: undefined,
    progress: INITIAL_PROGRESS,
  });

  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(() => {
    setRefreshTick((value) => value + 1);
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = undefined;

    if (!supported || !workspaceSelector) {
      ownerRef.current = undefined;
      setState({
        owner: undefined,
        scanning: false,
        complete: false,
        partial: false,
        rows: EMPTY_ROWS,
        sessionErrors: EMPTY_ERRORS,
        requestError: undefined,
        progress: INITIAL_PROGRESS,
      });
      return;
    }

    const generation = ++generationRef.current;
    const owner: ScanOwner = {
      workspaceKey: workspaceSelector,
      generation,
    };
    ownerRef.current = owner;
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    // Abort alone is not ownership proof: a transport may still deliver queued
    // events after abort. Every event and terminal commit checks signal +
    // workspaceKey + monotonic generation.
    const isOwnerCurrent = (): boolean =>
      !signal.aborted &&
      ownerRef.current?.workspaceKey === owner.workspaceKey &&
      ownerRef.current?.generation === owner.generation;

    const envelopes = new Map<string, DaemonArtifactLibrarySessionEnvelope>();
    const sessionErrors: DaemonArtifactLibraryMemberError[] = [];
    let progress: WorkspaceArtifactLibraryProgress = {
      received: 0,
      total: undefined,
    };
    let projectionDirty = false;
    let batchTimer: ReturnType<typeof setTimeout> | undefined;
    let currentRows: readonly WorkspaceArtifactLibraryRow[] = EMPTY_ROWS;
    let sawComplete = false;
    let terminalError: WorkspaceArtifactLibraryRequestError | undefined;

    const cancelBatchTimer = () => {
      if (batchTimer !== undefined) {
        clearTimeout(batchTimer);
        batchTimer = undefined;
      }
    };

    const flushProjectionNow = () => {
      if (!projectionDirty) return;
      projectionDirty = false;
      currentRows =
        envelopes.size === 0
          ? EMPTY_ROWS
          : flattenAndSortWorkspaceArtifacts(envelopes.values());
    };

    const commitProgress = () => {
      if (!isOwnerCurrent()) return;
      flushProjectionNow();
      setState({
        owner,
        scanning: true,
        complete: false,
        partial: false,
        rows: currentRows,
        sessionErrors:
          sessionErrors.length === 0 ? EMPTY_ERRORS : [...sessionErrors],
        requestError: undefined,
        progress: { ...progress },
      });
    };

    // Coalesce across the macrotask checkpoint so a burst of session events
    // yielded across microtask turns triggers one projection sort rather than
    // one sort per event.
    const scheduleBatchCommit = () => {
      if (batchTimer !== undefined) return;
      batchTimer = setTimeout(() => {
        batchTimer = undefined;
        commitProgress();
      }, 0);
    };

    const commitCompletedState = () => {
      cancelBatchTimer();
      flushProjectionNow();
      setState({
        owner,
        scanning: false,
        complete: true,
        partial: false,
        rows: currentRows,
        sessionErrors:
          sessionErrors.length === 0 ? EMPTY_ERRORS : [...sessionErrors],
        requestError: undefined,
        progress: { ...progress },
      });
    };

    setState({
      owner,
      scanning: true,
      complete: false,
      partial: false,
      rows: EMPTY_ROWS,
      sessionErrors: EMPTY_ERRORS,
      requestError: undefined,
      progress: INITIAL_PROGRESS,
    });

    const runJsonScan = async () => {
      const result = await readerRef.current.artifactLibrary(
        workspaceSelector,
        { signal },
      );
      if (!isOwnerCurrent()) return;
      envelopes.clear();
      sessionErrors.length = 0;
      for (const envelope of result.sessions) {
        envelopes.set(envelope.sessionId, envelope);
      }
      sessionErrors.push(...result.errors);
      projectionDirty = true;
      const total = result.sessions.length + result.errors.length;
      progress = {
        received: total,
        total,
      };
      sawComplete = true;
      commitCompletedState();
    };

    const runStreamScan = async () => {
      for await (const event of readerRef.current.artifactLibraryStream(
        workspaceSelector,
        { signal },
      )) {
        if (!isOwnerCurrent()) return;
        switch (event.type) {
          case 'start':
            progress = { ...progress, total: event.total };
            scheduleBatchCommit();
            break;
          case 'session':
            envelopes.set(event.sessionId, event);
            progress = { ...progress, received: progress.received + 1 };
            projectionDirty = true;
            scheduleBatchCommit();
            break;
          case 'session_error':
            sessionErrors.push({
              sessionId: event.sessionId,
              status: event.status,
              code: event.code,
              message: event.message,
            });
            progress = { ...progress, received: progress.received + 1 };
            scheduleBatchCommit();
            break;
          case 'complete':
            progress = {
              received: event.succeeded + event.failed + event.skipped,
              total: event.total,
            };
            if (!terminalError) {
              sawComplete = true;
            }
            break;
          case 'error':
            if (!sawComplete) {
              terminalError = {
                status: event.status,
                code: event.code,
                message: event.message,
              };
            }
            break;
        }
      }
      cancelBatchTimer();
      if (!isOwnerCurrent()) return;
      if (sawComplete) {
        commitCompletedState();
        return;
      }
      flushProjectionNow();
      // Only `complete` terminates a scan: a disconnect or terminal `error`
      // without `complete` is partial, never silently complete.
      setState({
        owner,
        scanning: false,
        complete: false,
        partial: true,
        rows: currentRows,
        sessionErrors:
          sessionErrors.length === 0 ? EMPTY_ERRORS : [...sessionErrors],
        requestError: terminalError,
        progress: { ...progress },
      });
    };

    void (async () => {
      try {
        if (streamSupported) {
          try {
            await runStreamScan();
          } catch (error) {
            if (!isOwnerCurrent()) return;
            // SSE admission refusal is sent as a plain HTTP 503 before the
            // stream starts; retry the same scan as JSON within the same
            // generation.
            if (
              isSseAdmissionRefusal(error) &&
              !sawComplete &&
              envelopes.size === 0
            ) {
              await runJsonScan();
              return;
            }
            throw error;
          }
        } else {
          await runJsonScan();
        }
      } catch (error) {
        cancelBatchTimer();
        if (!isOwnerCurrent()) return;
        if (sawComplete) {
          commitCompletedState();
          return;
        }
        flushProjectionNow();
        const hasPartialData =
          envelopes.size > 0 ||
          sessionErrors.length > 0 ||
          progress.total !== undefined;
        setState({
          owner,
          scanning: false,
          complete: false,
          partial: hasPartialData,
          rows: currentRows,
          sessionErrors:
            sessionErrors.length === 0 ? EMPTY_ERRORS : [...sessionErrors],
          requestError: extractArtifactLibraryRequestError(error),
          progress: { ...progress },
        });
      }
    })();

    return () => {
      cancelBatchTimer();
      controller.abort();
    };
  }, [refreshTick, streamSupported, supported, workspaceSelector]);

  return {
    scanning: state.scanning,
    complete: state.complete,
    partial: state.partial,
    rows: state.rows,
    sessionErrors: state.sessionErrors,
    requestError: state.requestError,
    progress: state.progress,
    owner: state.owner,
    refresh,
  };
}
