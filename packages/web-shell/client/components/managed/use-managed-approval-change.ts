import { useEffect, useRef, useState } from 'react';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type {
  ManagedAgentProvider,
  ManagedApprovalMode,
  ManagedAgentSessionSummary,
  ManagedSessionApproval,
} from './managed-agent-provider';
import { isManagedApprovalMode } from './managed-agent-provider';
import { managedRequestId } from './managed-session-storage';

interface ApprovalIntent {
  sessionId: string;
  approvalMode: ManagedApprovalMode;
  expectedRevision: number;
  idempotencyKey: string;
  requestId: string;
}

function readIntent(
  key: string,
  sessionId: string | undefined,
): ApprovalIntent | undefined {
  try {
    const item: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!item || typeof item !== 'object') return undefined;
    const value = item as Record<string, unknown>;
    if (
      value['sessionId'] !== sessionId ||
      !isManagedApprovalMode(value['approvalMode']) ||
      typeof value['idempotencyKey'] !== 'string' ||
      !value['idempotencyKey'] ||
      typeof value['requestId'] !== 'string' ||
      !value['requestId'] ||
      !Number.isSafeInteger(value['expectedRevision']) ||
      Number(value['expectedRevision']) < 0
    )
      return undefined;
    return item as ApprovalIntent;
  } catch {
    return undefined;
  }
}

function persist(key: string, intent?: ApprovalIntent): boolean {
  try {
    if (intent) sessionStorage.setItem(key, JSON.stringify(intent));
    else sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

const DEFINITIVE_ERRORS = new Set([
  'unsupported_approval_mode',
  'approval_selection_conflict',
  'turn_active',
  'session_context_busy',
  'session_operation_forbidden',
  'unsupported_feature',
]);

export function useManagedApprovalChange(
  provider: ManagedAgentProvider,
  clientId: string,
  sessionId: string | undefined,
  summary: ManagedAgentSessionSummary | undefined,
  refreshSummary: (
    signal?: AbortSignal,
  ) => Promise<ManagedAgentSessionSummary | undefined>,
  interactive: boolean,
) {
  const key = `qwen-managed-approval:${provider.storageKey}:${sessionId ?? ''}`;
  const [state, setState] = useState<{
    key: string;
    pending?: ApprovalIntent;
    busy: boolean;
    errorCode?: string;
  }>({ key, pending: readIntent(key, sessionId), busy: false });
  const [optionsState, setOptionsState] = useState<{
    key: string;
    options?: ManagedSessionApproval;
    loading: boolean;
    error: boolean;
  }>({ key, loading: false, error: false });
  const [optionsRevision, setOptionsRevision] = useState(0);
  const pendingRef = useRef(state.pending);
  const running = useRef(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const summaryRef = useRef(summary);
  summaryRef.current = summary?.sessionId === sessionId ? summary : undefined;
  const refreshRef = useRef(refreshSummary);
  refreshRef.current = refreshSummary;
  const optionsRef = useRef<ManagedSessionApproval | undefined>(undefined);
  const supported =
    summaryRef.current?.capabilities.approvalModeChange === true &&
    Boolean(provider.approvalChange);

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    running.current = false;
    const pending = readIntent(key, sessionId);
    pendingRef.current = pending;
    setState({ key, pending, busy: false });
    return () => abort.abort();
  }, [key, provider, clientId, sessionId]);

  useEffect(() => {
    const abort = new AbortController();
    optionsRef.current = undefined;
    setOptionsState({ key, loading: supported && interactive, error: false });
    if (supported && interactive && sessionId && provider.approvalChange) {
      void provider.approvalChange
        .queryOptions(sessionId, { clientId, signal: abort.signal })
        .then(async (options) => {
          if (abort.signal.aborted) return;
          optionsRef.current = options;
          setOptionsState({ key, options, loading: false, error: false });
          if (
            options.approvalRevision >
            (summaryRef.current?.approvalRevision ?? 0)
          ) {
            try {
              await refreshRef.current(abort.signal);
            } catch {
              /* The summary poll retries. */
            }
          }
        })
        .catch(() => {
          if (!abort.signal.aborted)
            setOptionsState({ key, loading: false, error: true });
        });
    }
    return () => abort.abort();
  }, [
    key,
    provider,
    clientId,
    sessionId,
    supported,
    interactive,
    optionsRevision,
    summary?.approvalRevision,
  ]);

  async function run(intent: ApprovalIntent) {
    const owner = lifetime.current;
    const api = provider.approvalChange;
    if (
      !owner ||
      owner.signal.aborted ||
      running.current ||
      !interactive ||
      !api ||
      intent.sessionId !== sessionId ||
      summaryRef.current?.sessionId !== sessionId
    )
      return;
    running.current = true;
    setState((current) => ({ ...current, busy: true, errorCode: undefined }));
    const abort = new AbortController();
    const stop = () => abort.abort();
    owner.signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, 30_000);
    let accepted = false;
    const update = (pending?: ApprovalIntent, errorCode?: string) => {
      if (owner.signal.aborted) return;
      pendingRef.current = pending;
      const saved = persist(key, pending);
      setState((current) => ({
        ...current,
        pending,
        errorCode: saved ? errorCode : 'storage_unavailable',
      }));
    };
    try {
      const result = await api.submit(
        intent.sessionId,
        {
          approvalMode: intent.approvalMode,
          expectedRevision: intent.expectedRevision,
        },
        {
          clientId,
          signal: abort.signal,
          idempotencyKey: intent.idempotencyKey,
          requestId: intent.requestId,
        },
      );
      accepted = true;
      if (owner.signal.aborted) return;
      if (
        result.sessionId !== intent.sessionId ||
        result.approvalMode !== intent.approvalMode ||
        !Number.isSafeInteger(result.approvalRevision) ||
        result.approvalRevision <= intent.expectedRevision
      )
        throw new Error('Approval change identity mismatch');
      const latest = await refreshRef.current(abort.signal);
      if (owner.signal.aborted) return;
      const revision = latest?.approvalRevision ?? 0;
      if (
        latest?.sessionId !== intent.sessionId ||
        revision < result.approvalRevision ||
        (revision === result.approvalRevision &&
          latest.approvalMode !== intent.approvalMode)
      )
        throw new Error('Approval selection is not confirmed');
      update();
      setOptionsRevision((value) => value + 1);
      return true;
    } catch (failure) {
      if (owner.signal.aborted) return;
      const definitive =
        !accepted &&
        failure instanceof JavaManagedAgentHttpError &&
        [400, 403, 409].includes(failure.status) &&
        DEFINITIVE_ERRORS.has(failure.code);
      if (definitive) {
        update(undefined, failure.code);
        setOptionsRevision((value) => value + 1);
        try {
          await refreshRef.current(abort.signal);
        } catch {
          /* The summary poll retries. */
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

  async function submit(approvalMode: ManagedApprovalMode) {
    const current = summaryRef.current;
    const options = optionsRef.current;
    if (
      !lifetime.current ||
      lifetime.current.signal.aborted ||
      running.current ||
      pendingRef.current ||
      !interactive ||
      !current ||
      current.sessionId !== sessionId ||
      current.capabilities.approvalModeChange !== true ||
      !provider.approvalChange ||
      !options?.supported ||
      !options.availableApprovalModes.includes(approvalMode) ||
      !['created', 'completed', 'failed', 'cancelled'].includes(
        current.phase,
      ) ||
      options.approvalRevision !== (current.approvalRevision ?? 0) ||
      approvalMode === current.approvalMode
    )
      return;
    const intent: ApprovalIntent = {
      sessionId: current.sessionId,
      approvalMode,
      expectedRevision: options.approvalRevision,
      idempotencyKey: managedRequestId(),
      requestId: managedRequestId(),
    };
    if (!persist(key, intent)) {
      setState((value) => ({ ...value, errorCode: 'storage_unavailable' }));
      return;
    }
    pendingRef.current = intent;
    setState((value) => ({ ...value, pending: intent }));
    return run(intent);
  }

  const visible =
    state.key === key
      ? state
      : { key, pending: readIntent(key, sessionId), busy: false };
  const optionView =
    optionsState.key === key
      ? optionsState
      : { key, loading: supported, error: false };
  return {
    ...visible,
    options: optionView.options,
    optionsLoading: optionView.loading,
    optionsError: optionView.error,
    supported,
    blocked: Boolean(visible.pending),
    submit,
    confirm: () =>
      pendingRef.current ? run(pendingRef.current) : Promise.resolve(undefined),
    reloadOptions: () => setOptionsRevision((value) => value + 1),
    isBlocked: () => Boolean(pendingRef.current) || running.current,
  };
}
