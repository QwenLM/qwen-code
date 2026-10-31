import { useEffect, useRef, useState } from 'react';
import type { ContextCompressionControls } from '../../hooks/useContextUsageControls';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedContextCompressionOperation,
} from './managed-agent-provider';
import { managedRequestId } from './managed-session-storage';

interface CompressionIntent {
  sessionId: string;
  expectedCompactionRevision?: number;
  idempotencyKey?: string;
  operationId?: string;
}

function readIntent(
  key: string,
  sessionId?: string,
): CompressionIntent | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object') return undefined;
    const item = value as Record<string, unknown>;
    const hasOperation =
      typeof item['operationId'] === 'string' && Boolean(item['operationId']);
    const hasRequest =
      typeof item['idempotencyKey'] === 'string' &&
      Boolean(item['idempotencyKey']) &&
      Number.isSafeInteger(item['expectedCompactionRevision']) &&
      Number(item['expectedCompactionRevision']) >= 0;
    if (item['sessionId'] !== sessionId || (!hasOperation && !hasRequest))
      return undefined;
    return value as CompressionIntent;
  } catch {
    return undefined;
  }
}

function persist(key: string, intent?: CompressionIntent): boolean {
  try {
    if (intent) sessionStorage.setItem(key, JSON.stringify(intent));
    else sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function pause(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

export function useManagedContextCompression(
  provider: ManagedAgentProvider,
  clientId: string,
  sessionId: string | undefined,
  summary: ManagedAgentSessionSummary | undefined,
  refreshSummary: (
    signal?: AbortSignal,
  ) => Promise<ManagedAgentSessionSummary | undefined>,
  canStart: () => boolean,
) {
  const key = `qwen-managed-compression:${provider.storageKey}:${sessionId ?? ''}`;
  const [state, setState] = useState<{
    key: string;
    pending?: CompressionIntent;
    busy: boolean;
    errorCode?: string;
    result?: ContextCompressionControls['result'];
    invalidatedRevision?: number;
  }>({ key, pending: readIntent(key, sessionId), busy: false });
  const pendingRef = useRef(state.pending);
  const running = useRef(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const settledOperation = useRef<string | undefined>(undefined);
  const summaryRef = useRef(summary);
  summaryRef.current = summary?.sessionId === sessionId ? summary : undefined;
  const refreshRef = useRef(refreshSummary);
  refreshRef.current = refreshSummary;
  const availableRef = useRef(canStart);
  availableRef.current = canStart;
  const available = canStart();
  const supported =
    Boolean(provider.contextCompression) &&
    summaryRef.current?.capabilities.contextCompression === true;

  async function run(original: CompressionIntent) {
    const owner = lifetime.current;
    const api = provider.contextCompression;
    if (!owner || owner.signal.aborted || running.current || !api) return;
    let intent = original;
    let accepted = Boolean(intent.operationId);
    running.current = true;
    setState((current) => ({ ...current, busy: true, errorCode: undefined }));
    const abort = new AbortController();
    const stop = () => abort.abort();
    owner.signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, 60_000);
    const update = (pending?: CompressionIntent, errorCode?: string) => {
      if (owner.signal.aborted) return;
      pendingRef.current = pending;
      const saved = persist(key, pending);
      setState((current) => ({
        ...current,
        pending,
        errorCode: saved ? errorCode : 'storage_update_failed',
      }));
    };
    try {
      const options = { clientId, signal: abort.signal };
      let operation: ManagedContextCompressionOperation = intent.operationId
        ? await api.query(intent.sessionId, intent.operationId, options)
        : await api.submit(
            intent.sessionId,
            { expectedCompactionRevision: intent.expectedCompactionRevision! },
            { ...options, idempotencyKey: intent.idempotencyKey! },
          );
      accepted = true;
      let delay = 1_000;
      while (!owner.signal.aborted) {
        abort.signal.throwIfAborted();
        if (
          operation.type !== 'context_compression' ||
          operation.sessionId !== intent.sessionId ||
          !operation.operationId ||
          (intent.operationId &&
            operation.operationId !== intent.operationId) ||
          !Number.isSafeInteger(operation.expectedCompactionRevision) ||
          operation.expectedCompactionRevision < 0 ||
          (intent.expectedCompactionRevision !== undefined &&
            operation.expectedCompactionRevision !==
              intent.expectedCompactionRevision)
        )
          throw new Error('Context compression operation identity mismatch');
        intent = {
          ...intent,
          operationId: operation.operationId,
          expectedCompactionRevision: operation.expectedCompactionRevision,
        };
        update(
          intent,
          operation.status === 'recovery_blocked'
            ? 'recovery_blocked'
            : undefined,
        );
        if (operation.status === 'failed') {
          settledOperation.current = operation.operationId;
          update(undefined, operation.failureCode ?? 'unknown_failure');
          setState((current) => ({ ...current, result: { kind: 'failed' } }));
          try {
            await refreshRef.current(abort.signal);
          } catch {
            // The Session summary poll retries.
          }
          return;
        }
        if (operation.status === 'completed') {
          if (
            !['compressed', 'noop'].includes(operation.outcome ?? '') ||
            (operation.outcome === 'compressed' &&
              (!Number.isSafeInteger(operation.compactionRevision) ||
                operation.compactionRevision! <=
                  operation.expectedCompactionRevision)) ||
            (operation.outcome === 'noop' &&
              operation.compactionRevision != null &&
              operation.compactionRevision !==
                operation.expectedCompactionRevision)
          )
            throw new Error('Invalid context compression result');
          if (operation.outcome === 'compressed')
            setState((current) => ({
              ...current,
              invalidatedRevision: operation.compactionRevision!,
            }));
          const latest = await refreshRef.current(abort.signal);
          if (owner.signal.aborted) return;
          if (
            latest?.sessionId === intent.sessionId &&
            (latest.compactionRevision ?? 0) >=
              (operation.compactionRevision ??
                operation.expectedCompactionRevision)
          ) {
            settledOperation.current = operation.operationId;
            update();
            setState((current) => ({
              ...current,
              invalidatedRevision: undefined,
              result: {
                kind:
                  operation.outcome === 'compressed' ? 'compressed' : 'noop',
              },
            }));
            return;
          }
        } else if (
          !['pending', 'running', 'recovery_blocked'].includes(operation.status)
        )
          throw new Error('Unknown context compression operation status');
        await pause(abort.signal, delay);
        abort.signal.throwIfAborted();
        delay = Math.min(delay + 1_000, 3_000);
        operation = await api.query(
          intent.sessionId,
          intent.operationId!,
          options,
        );
      }
    } catch (failure) {
      if (owner.signal.aborted) return;
      const definitive =
        !accepted &&
        failure instanceof JavaManagedAgentHttpError &&
        failure.status >= 400 &&
        failure.status < 500 &&
        ![401, 404, 408, 429].includes(failure.status);
      if (definitive) {
        update(undefined, failure.code);
        setState((current) => ({ ...current, result: { kind: 'failed' } }));
        try {
          await refreshRef.current(abort.signal);
        } catch {
          // The Session summary poll retries.
        }
      } else update(intent, 'unconfirmed');
    } finally {
      clearTimeout(timer);
      owner.signal.removeEventListener('abort', stop);
      abort.abort();
      if (!owner.signal.aborted) {
        running.current = false;
        setState((current) => ({ ...current, busy: false }));
      }
    }
  }

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    running.current = false;
    settledOperation.current = undefined;
    const pending = readIntent(key, sessionId);
    pendingRef.current = pending;
    setState({ key, pending, busy: false });
    if (pending?.operationId) void run(pending);
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity defines the operation lifetime
  }, [key, provider, clientId]);

  useEffect(() => {
    const operationId = summaryRef.current?.contextCompressionOperationId;
    if (
      !operationId ||
      settledOperation.current === operationId ||
      pendingRef.current
    )
      return;
    const intent: CompressionIntent = { sessionId: sessionId!, operationId };
    pendingRef.current = intent;
    persist(key, intent);
    setState((current) => ({ ...current, pending: intent }));
    void run(intent);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- summary polling must not restart an existing query
  }, [key, provider, clientId, summary?.contextCompressionOperationId]);

  async function compress() {
    const current = summaryRef.current;
    if (
      !current ||
      current.sessionId !== sessionId ||
      current.capabilities.contextCompression !== true ||
      !provider.contextCompression ||
      !availableRef.current() ||
      isBlocked()
    )
      return;
    const intent: CompressionIntent = {
      sessionId: current.sessionId,
      expectedCompactionRevision: current.compactionRevision ?? 0,
      idempotencyKey: managedRequestId(),
    };
    if (!persist(key, intent)) {
      setState((value) => ({ ...value, errorCode: 'storage_unavailable' }));
      return;
    }
    pendingRef.current = intent;
    setState((value) => ({ ...value, pending: intent, result: undefined }));
    await run(intent);
  }

  function isBlocked() {
    const remote = summaryRef.current?.contextCompressionOperationId;
    return Boolean(
      pendingRef.current ||
        running.current ||
        (remote && remote !== settledOperation.current),
    );
  }

  const visible =
    state.key === key
      ? state
      : { key, pending: readIntent(key, sessionId), busy: false };
  const remote = summaryRef.current?.contextCompressionOperationId;
  const blocked = Boolean(
    visible.pending || (remote && remote !== settledOperation.current),
  );
  const controls: ContextCompressionControls | undefined =
    supported || blocked
      ? {
          canCompress: supported && available && !blocked && !visible.busy,
          compressing: blocked,
          result: visible.result,
          compress,
        }
      : undefined;
  return {
    ...visible,
    supported,
    blocked,
    controls,
    usageInvalidated: visible.invalidatedRevision !== undefined,
    isBlocked,
    confirm: async () => {
      if (pendingRef.current) await run(pendingRef.current);
    },
  };
}
