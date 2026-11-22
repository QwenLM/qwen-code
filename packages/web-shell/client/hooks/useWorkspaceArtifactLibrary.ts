import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DaemonHttpError,
  type DaemonArtifactLibraryMemberError,
  type DaemonArtifactLibrarySessionEnvelope,
  type DaemonArtifactLibrarySessionMetadata,
  type DaemonSessionArtifact,
  type DaemonWorkspaceArtifactLibraryResult,
  type DaemonWorkspaceArtifactLibraryStreamEvent,
} from '@qwen-code/sdk/daemon';

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
  succeeded?: number;
  failed?: number;
  skipped?: number;
}

export interface WorkspaceArtifactLibraryRequestError {
  status?: number;
  code?: string;
  message: string;
}

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
  enabled?: boolean;
}

export interface WorkspaceArtifactLibraryState {
  supported: boolean;
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
    if (leftTs !== rightTs) return rightTs.localeCompare(leftTs);
    if (left.sessionId !== right.sessionId) {
      return left.sessionId.localeCompare(right.sessionId);
    }
    return left.artifact.id.localeCompare(right.artifact.id);
  });
  return rows;
}

function readHttpErrorRecord(
  error: DaemonHttpError,
): Record<string, unknown> | undefined {
  return typeof error.body === 'object' &&
    error.body !== null &&
    !Array.isArray(error.body)
    ? (error.body as Record<string, unknown>)
    : undefined;
}

export function isSseAdmissionRefusal(error: unknown): boolean {
  if (!(error instanceof DaemonHttpError) || error.status !== 503) return false;
  const body = readHttpErrorRecord(error);
  const code = body?.['code'] ?? body?.['error'];
  return code === 'sse_connection_limit_exceeded';
}

export function extractArtifactLibraryRequestError(
  error: unknown,
): WorkspaceArtifactLibraryRequestError {
  if (error instanceof DaemonHttpError) {
    const body = readHttpErrorRecord(error);
    const code =
      typeof body?.['code'] === 'string'
        ? body['code']
        : typeof body?.['error'] === 'string'
          ? body['error']
          : undefined;
    const message =
      typeof body?.['message'] === 'string' && body['message'].length > 0
        ? body['message']
        : typeof body?.['error'] === 'string' && body['error'].length > 0
          ? body['error']
          : error.message;
    return {
      status: error.status,
      ...(code ? { code } : {}),
      message,
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
  };
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
  enabled = true,
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

    if (!enabled || !supported || !workspaceSelector) {
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
    let flushScheduled = false;
    let currentRows: readonly WorkspaceArtifactLibraryRow[] = EMPTY_ROWS;

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

    const scheduleBatchCommit = () => {
      if (flushScheduled) return;
      flushScheduled = true;
      queueMicrotask(() => {
        flushScheduled = false;
        commitProgress();
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
      flushProjectionNow();
      const total = result.sessions.length + result.errors.length;
      setState({
        owner,
        scanning: false,
        complete: true,
        partial: false,
        rows: currentRows,
        sessionErrors:
          sessionErrors.length === 0 ? EMPTY_ERRORS : [...sessionErrors],
        requestError: undefined,
        progress: {
          received: total,
          total,
          succeeded: result.sessions.length,
          failed: result.errors.length,
          skipped: 0,
        },
      });
    };

    const runStreamScan = async () => {
      let sawComplete = false;
      let terminalError: WorkspaceArtifactLibraryRequestError | undefined;
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
            sawComplete = true;
            progress = {
              received: event.succeeded + event.failed + event.skipped,
              total: event.total,
              succeeded: event.succeeded,
              failed: event.failed,
              skipped: event.skipped,
            };
            break;
          case 'error':
            terminalError = {
              status: event.status,
              code: event.code,
              message: event.message,
            };
            break;
        }
      }
      if (!isOwnerCurrent()) return;
      flushProjectionNow();
      if (sawComplete && !terminalError) {
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
      } else {
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
      }
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
            if (isSseAdmissionRefusal(error) && envelopes.size === 0) {
              await runJsonScan();
              return;
            }
            throw error;
          }
        } else {
          await runJsonScan();
        }
      } catch (error) {
        if (!isOwnerCurrent()) return;
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
      controller.abort();
    };
  }, [enabled, refreshTick, streamSupported, supported, workspaceSelector]);

  return {
    supported,
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
