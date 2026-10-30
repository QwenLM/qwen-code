import { useEffect, useRef, useState } from 'react';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedSessionModels,
} from './managed-agent-provider';
import { managedRequestId } from './managed-session-storage';

interface ModelIntent {
  sessionId: string;
  modelId: string;
  expectedRevision: number;
  idempotencyKey: string;
}

function readIntent(
  key: string,
  sessionId: string | undefined,
): ModelIntent | undefined {
  try {
    const item: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!item || typeof item !== 'object') return undefined;
    const value = item as Record<string, unknown>;
    if (
      value['sessionId'] !== sessionId ||
      typeof value['modelId'] !== 'string' ||
      !value['modelId'].trim() ||
      typeof value['idempotencyKey'] !== 'string' ||
      !value['idempotencyKey'] ||
      !Number.isSafeInteger(value['expectedRevision']) ||
      Number(value['expectedRevision']) < 0
    )
      return undefined;
    return item as ModelIntent;
  } catch {
    return undefined;
  }
}

function persist(key: string, intent?: ModelIntent): boolean {
  try {
    if (intent) sessionStorage.setItem(key, JSON.stringify(intent));
    else sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

const DEFINITIVE_ERRORS = new Set([
  'unsupported_model',
  'model_selection_conflict',
  'turn_active',
  'session_context_busy',
  'session_operation_forbidden',
  'unsupported_feature',
]);

export function useManagedModelChange(
  provider: ManagedAgentProvider,
  clientId: string,
  sessionId: string | undefined,
  summary: ManagedAgentSessionSummary | undefined,
  refreshSummary: (
    signal?: AbortSignal,
  ) => Promise<ManagedAgentSessionSummary | undefined>,
  interactive: boolean,
) {
  const key = `qwen-managed-model:${provider.storageKey}:${sessionId ?? ''}`;
  const [state, setState] = useState<{
    key: string;
    pending?: ModelIntent;
    busy: boolean;
    errorCode?: string;
  }>({ key, pending: readIntent(key, sessionId), busy: false });
  const [optionsState, setOptionsState] = useState<{
    key: string;
    options?: ManagedSessionModels;
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
  const optionsRef = useRef<ManagedSessionModels | undefined>(undefined);
  const supported =
    summaryRef.current?.capabilities.modelChange === true &&
    Boolean(provider.modelChange);

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
    if (supported && interactive && sessionId && provider.modelChange) {
      void provider.modelChange
        .queryOptions(sessionId, { clientId, signal: abort.signal })
        .then(async (options) => {
          if (abort.signal.aborted) return;
          optionsRef.current = options;
          setOptionsState({ key, options, loading: false, error: false });
          if (
            options.modelSelection.revision >
            (summaryRef.current?.modelSelection?.revision ?? 0)
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
    summary?.modelSelection?.revision,
  ]);

  async function run(intent: ModelIntent) {
    const owner = lifetime.current;
    const api = provider.modelChange;
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
    const update = (pending?: ModelIntent, errorCode?: string) => {
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
          modelId: intent.modelId,
          expectedRevision: intent.expectedRevision,
        },
        {
          clientId,
          signal: abort.signal,
          idempotencyKey: intent.idempotencyKey,
        },
      );
      accepted = true;
      if (owner.signal.aborted) return;
      if (
        result.sessionId !== intent.sessionId ||
        result.modelSelection.modelId !== intent.modelId ||
        !Number.isSafeInteger(result.modelSelection.revision) ||
        result.modelSelection.revision <= intent.expectedRevision
      )
        throw new Error('Model change identity mismatch');
      const latest = await refreshRef.current(abort.signal);
      if (owner.signal.aborted) return;
      const revision = latest?.modelSelection?.revision ?? 0;
      if (
        latest?.sessionId !== intent.sessionId ||
        revision < result.modelSelection.revision ||
        (revision === result.modelSelection.revision &&
          latest.modelSelection?.modelId !== intent.modelId)
      )
        throw new Error('Model selection is not confirmed');
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

  async function submit(modelId: string) {
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
      current.capabilities.modelChange !== true ||
      !provider.modelChange ||
      !options?.supported ||
      !options.models.some((model) => model.modelId === modelId) ||
      !['created', 'completed', 'failed', 'cancelled'].includes(
        current.phase,
      ) ||
      options.modelSelection.revision !==
        (current.modelSelection?.revision ?? 0) ||
      modelId === current.modelSelection?.modelId
    )
      return;
    const intent: ModelIntent = {
      sessionId: current.sessionId,
      modelId,
      expectedRevision: options.modelSelection.revision,
      idempotencyKey: managedRequestId(),
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
