import { useEffect, useRef, useState } from 'react';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedCwdOperation,
} from './managed-agent-provider';
import { managedRequestId } from './managed-session-storage';

interface CwdIntent {
  sessionId: string;
  workspaceId: string;
  cwdRelative: string;
  expectedContextRevision: number;
  idempotencyKey: string;
  operationId?: string;
}

function readIntent(
  key: string,
  sessionId: string | undefined,
): CwdIntent | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object') return undefined;
    const item = value as Record<string, unknown>;
    if (
      item['sessionId'] !== sessionId ||
      typeof item['workspaceId'] !== 'string' ||
      typeof item['cwdRelative'] !== 'string' ||
      typeof item['idempotencyKey'] !== 'string' ||
      !item['idempotencyKey'] ||
      !Number.isSafeInteger(item['expectedContextRevision']) ||
      Number(item['expectedContextRevision']) < 1 ||
      (item['operationId'] !== undefined &&
        typeof item['operationId'] !== 'string')
    )
      return undefined;
    return value as CwdIntent;
  } catch {
    return undefined;
  }
}

function persist(key: string, intent?: CwdIntent): boolean {
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

export function useManagedCwdChange(
  provider: ManagedAgentProvider,
  clientId: string,
  sessionId: string | undefined,
  summary: ManagedAgentSessionSummary | undefined,
  refreshSummary: (
    signal?: AbortSignal,
  ) => Promise<ManagedAgentSessionSummary | undefined>,
) {
  const key = `qwen-managed-cwd:${provider.storageKey}:${sessionId ?? ''}`;
  const [state, setState] = useState<{
    key: string;
    pending?: CwdIntent;
    busy: boolean;
    errorCode?: string;
    target?: string;
  }>({ key, pending: readIntent(key, sessionId), busy: false });
  const pendingRef = useRef(state.pending);
  const running = useRef(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  const refreshRef = useRef(refreshSummary);
  refreshRef.current = refreshSummary;

  async function run(
    intent: CwdIntent,
    replay: boolean,
    initialSubmission = false,
  ) {
    const owner = lifetime.current;
    const api = provider.cwdChange;
    if (!owner || owner.signal.aborted || running.current || !api) return;
    running.current = true;
    setState((current) => ({ ...current, busy: true, errorCode: undefined }));
    const abort = new AbortController();
    const stop = () => abort.abort();
    owner.signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, 30_000);
    let accepted = !replay;
    const update = (pending?: CwdIntent, errorCode?: string) => {
      if (owner.signal.aborted) return;
      pendingRef.current = pending;
      const saved = persist(key, pending);
      setState((current) => ({
        ...current,
        pending,
        target: intent.cwdRelative,
        errorCode: saved ? errorCode : 'storage_unavailable',
      }));
    };
    try {
      const options = { clientId, signal: abort.signal };
      let operation: ManagedCwdOperation = replay
        ? await api.submit(
            intent.sessionId,
            {
              cwdRelative: intent.cwdRelative,
              expectedContextRevision: intent.expectedContextRevision,
            },
            { ...options, idempotencyKey: intent.idempotencyKey },
          )
        : await api.query(intent.sessionId, intent.operationId!, options);
      accepted = true;
      if (owner.signal.aborted) return;
      if (
        operation.sessionId !== intent.sessionId ||
        operation.type !== 'cwd_change' ||
        operation.expectedContextRevision !== intent.expectedContextRevision ||
        (intent.operationId && operation.operationId !== intent.operationId)
      )
        throw new Error('Cwd operation identity mismatch');
      intent = { ...intent, operationId: operation.operationId };
      update(intent);
      let delay = 1_000;
      while (true) {
        abort.signal.throwIfAborted();
        if (operation.status === 'failed') {
          update(undefined, operation.failureCode ?? 'unknown_failure');
          return;
        }
        if (operation.status === 'completed') {
          if (
            !Number.isSafeInteger(operation.resultContextRevision) ||
            operation.resultContextRevision! <= intent.expectedContextRevision
          )
            throw new Error('Invalid cwd result revision');
          const latest = await refreshRef.current(abort.signal);
          if (owner.signal.aborted) return;
          if (
            latest?.sessionId === intent.sessionId &&
            latest.workspace?.workspaceId === intent.workspaceId &&
            (latest.workspace.contextRevision ?? 0) >=
              operation.resultContextRevision!
          ) {
            update();
            return true;
          }
        } else if (
          operation.status !== 'pending' &&
          operation.status !== 'installing'
        )
          throw new Error('Unknown cwd operation status');
        await pause(abort.signal, delay);
        abort.signal.throwIfAborted();
        delay = Math.min(delay + 1_000, 3_000);
        operation = await api.query(
          intent.sessionId,
          intent.operationId!,
          options,
        );
        if (
          operation.operationId !== intent.operationId ||
          operation.sessionId !== intent.sessionId ||
          operation.expectedContextRevision !== intent.expectedContextRevision
        )
          throw new Error('Cwd operation identity mismatch');
      }
    } catch (failure) {
      if (owner.signal.aborted) return;
      const definitive =
        initialSubmission &&
        !accepted &&
        failure instanceof JavaManagedAgentHttpError &&
        failure.status >= 400 &&
        failure.status < 500 &&
        ![408, 429].includes(failure.status);
      if (definitive) {
        update(undefined, failure.code);
        if (failure.code === 'context_revision_conflict') {
          try {
            await refreshRef.current(abort.signal);
          } catch {
            /* The existing summary poll will retry. */
          }
        }
      } else {
        update(
          intent,
          failure instanceof JavaManagedAgentHttpError && failure.status === 403
            ? 'unconfirmed_forbidden'
            : 'unconfirmed',
        );
      }
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
    const pending = readIntent(key, sessionId);
    pendingRef.current = pending;
    setState({ key, pending, target: pending?.cwdRelative, busy: false });
    if (pending?.operationId) void run(pending, false);
    return () => abort.abort();
    // Identity and Session define a request lifetime; summary polling must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, provider, clientId]);

  async function submit(cwdRelative: string, expectedContextRevision: number) {
    const current = summaryRef.current;
    if (
      running.current ||
      pendingRef.current ||
      !provider.cwdChange ||
      !current?.capabilities.cwdChange ||
      !current.workspace ||
      !cwdRelative ||
      cwdRelative === current.workspace.cwdRelative
    )
      return;
    if (current.workspace.contextRevision !== expectedContextRevision) {
      setState((value) => ({
        ...value,
        target: cwdRelative,
        errorCode: 'context_revision_conflict',
      }));
      return;
    }
    const intent: CwdIntent = {
      sessionId: current.sessionId,
      workspaceId: current.workspace.workspaceId,
      cwdRelative,
      expectedContextRevision,
      idempotencyKey: managedRequestId(),
    };
    if (!persist(key, intent)) {
      setState((value) => ({ ...value, errorCode: 'storage_unavailable' }));
      return;
    }
    pendingRef.current = intent;
    setState((value) => ({ ...value, pending: intent, target: cwdRelative }));
    return run(intent, true, true);
  }

  async function confirm() {
    const pending = pendingRef.current;
    if (pending) await run(pending, !pending.operationId);
  }
  const visible =
    state.key === key
      ? state
      : { key, busy: false, pending: readIntent(key, sessionId) };
  return {
    ...visible,
    blocked: Boolean(visible.pending),
    submit,
    confirm,
    isBlocked: () => Boolean(pendingRef.current) || running.current,
  };
}
