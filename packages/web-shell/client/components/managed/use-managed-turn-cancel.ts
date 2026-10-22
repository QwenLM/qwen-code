import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { managedRequestId } from './managed-session-storage';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
} from './managed-agent-provider';

interface CancelIntent {
  sessionId: string;
  turnId: string;
  idempotencyKey: string;
  durable: boolean;
  operationId?: string;
  submitted?: boolean;
}

function load(key: string, sessionId?: string): CancelIntent | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object') return;
    const intent = value as Record<string, unknown>;
    if (
      intent['sessionId'] === sessionId &&
      typeof intent['turnId'] === 'string' &&
      typeof intent['idempotencyKey'] === 'string' &&
      intent['idempotencyKey'] &&
      typeof intent['durable'] === 'boolean' &&
      (intent['operationId'] === undefined ||
        typeof intent['operationId'] === 'string') &&
      (intent['submitted'] === undefined ||
        typeof intent['submitted'] === 'boolean')
    )
      return value as CancelIntent;
  } catch {
    /* Unreadable intent never authorizes another cancellation. */
  }
}

function save(key: string, intent?: CancelIntent): boolean {
  try {
    if (intent) sessionStorage.setItem(key, JSON.stringify(intent));
    else sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function useManagedTurnCancel(
  provider: ManagedAgentProvider,
  clientId: string,
  sessionId: string | undefined,
  summary: ManagedAgentSessionSummary | undefined,
  interactive: boolean,
  refreshSummary: () => Promise<ManagedAgentSessionSummary | undefined>,
) {
  const [, render] = useReducer((value: number) => value + 1, 0);
  const scope = useMemo(() => {
    const key = `qwen-managed-turn-cancel:${JSON.stringify([provider.storageKey, sessionId])}`;
    return {
      key,
      intent: load(key, sessionId),
      abort: new AbortController(),
      running: false,
      status: undefined as 'stopping' | 'unconfirmed' | 'failed' | undefined,
      error: undefined as string | undefined,
    };
  }, [provider, sessionId]);
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  const refreshRef = useRef(refreshSummary);
  refreshRef.current = refreshSummary;

  const run = useCallback(async () => {
    const abort = scope.abort;
    const original = scope.intent;
    if (!original || scope.running || abort.signal.aborted) return;
    scope.running = true;
    scope.status = 'stopping';
    scope.error = undefined;
    render();
    try {
      const options = { clientId, signal: abort.signal };
      if (!original.submitted) {
        const receipt = await provider.cancel(
          original.sessionId,
          original.turnId,
          {
            ...options,
            idempotencyKey: original.idempotencyKey,
            ...(original.durable
              ? { admissionProfile: 'java_durable' as const }
              : {}),
          },
        );
        if (abort.signal.aborted) return;
        if (original.durable && !receipt?.operationId)
          throw new Error('Cancellation operation identity missing');
        scope.intent = {
          ...original,
          submitted: true,
          operationId: receipt?.operationId,
        };
        if (!save(scope.key, scope.intent))
          throw new Error('Cancellation storage unavailable');
      }
      const intent = scope.intent!;
      let cancellationConfirmed = false;
      if (intent.operationId && provider.queryCancelOperation) {
        const operation = await provider.queryCancelOperation(
          intent.sessionId,
          intent.operationId,
          options,
        );
        if (abort.signal.aborted) return;
        if (
          operation.operationId !== intent.operationId ||
          operation.sessionId !== intent.sessionId ||
          operation.type !== 'cancel'
        )
          throw new Error('Cancellation identity mismatch');
        cancellationConfirmed = operation.status === 'completed';
        if (operation.status === 'failed' || operation.status === 'cancelled') {
          scope.status = 'failed';
          scope.error = operation.failureCode;
          scope.intent = undefined;
          save(scope.key);
        } else if (operation.status === 'recovery_blocked')
          scope.status = 'unconfirmed';
      }
      if (cancellationConfirmed) {
        scope.intent = undefined;
        scope.status = undefined;
        save(scope.key);
      }
      const latest = await refreshRef.current();
      if (abort.signal.aborted) return;
      // Retire an acknowledged delivery slot without claiming the original
      // execution stopped; its outcome and recovery still govern readiness.
      const compatibilityDelivery =
        intent.submitted === true &&
        !intent.durable &&
        !intent.operationId &&
        latest?.sessionId === intent.sessionId &&
        latest.updatedAt >= (summaryRef.current?.updatedAt ?? 0);
      const compatibilityTrackingRetired =
        compatibilityDelivery &&
        ((latest.activeTurnId && latest.activeTurnId !== intent.turnId) ||
          (latest.activeTurnId === intent.turnId &&
            latest.phase === 'failed' &&
            latest.recovery?.turnId === intent.turnId &&
            latest.recovery.state === 'ready' &&
            latest.recovery.nextTurnAllowed));
      if (
        cancellationConfirmed ||
        compatibilityTrackingRetired ||
        (latest?.sessionId === intent.sessionId &&
          latest.activeTurnId === intent.turnId &&
          (latest.phase === 'completed' || latest.phase === 'cancelled'))
      ) {
        scope.intent = undefined;
        scope.status = undefined;
        save(scope.key);
      }
    } catch (error) {
      if (!abort.signal.aborted && scope.intent) {
        scope.status = 'unconfirmed';
        scope.error = String(error);
      }
    } finally {
      scope.running = false;
      if (!abort.signal.aborted) render();
    }
  }, [provider, clientId, scope]);

  const hasPending = scope.intent !== undefined;
  useEffect(() => {
    const abort = new AbortController();
    scope.abort = abort;
    return () => abort.abort();
  }, [scope]);
  useEffect(() => {
    if (!interactive || !scope.intent) return;
    const tick = () => {
      if (document.visibilityState !== 'hidden') void run();
    };
    tick();
    const timer = setInterval(tick, 5_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [interactive, run, scope, hasPending]);

  async function request() {
    const current = summaryRef.current;
    if (
      !current?.activeTurnId ||
      current.sessionId !== sessionId ||
      scope.abort.signal.aborted
    )
      return;
    if (
      scope.intent?.submitted === true &&
      !scope.intent.durable &&
      !scope.intent.operationId &&
      scope.intent.turnId !== current.activeTurnId
    ) {
      await run();
      if (
        scope.intent ||
        scope.abort.signal.aborted ||
        summaryRef.current?.activeTurnId !== current.activeTurnId
      )
        return;
    }
    if (!scope.intent) {
      if (!current.capabilities.canCancel) return;
      const intent = {
        sessionId: current.sessionId,
        turnId: current.activeTurnId,
        idempotencyKey: managedRequestId(),
        durable: current.capabilities.durableOperations === true,
      };
      if (!save(scope.key, intent)) {
        scope.status = 'failed';
        scope.error = 'Cancellation storage unavailable';
        render();
        return;
      }
      scope.intent = intent;
    }
    await run();
  }

  return {
    request,
    retry: run,
    status: scope.status,
    error: scope.error,
    busy: scope.running,
    pending: scope.intent !== undefined,
  };
}
