import { useEffect, useRef, useState } from 'react';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedModelSelection,
  ManagedSessionModels,
} from './managed-agent-provider';
import { managedRequestId } from './managed-session-storage';
import { withActionTimeout } from '../../daemon/timing';

function latestSelection(
  current: ManagedModelSelection | undefined,
  incoming: ManagedModelSelection | undefined,
): ManagedModelSelection | undefined {
  return incoming && (!current || incoming.revision > current.revision)
    ? incoming
    : current;
}

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
    busy: boolean;
    selection?: ManagedModelSelection;
    errorCode?: string;
  }>({ key, busy: false });
  const [optionsState, setOptionsState] = useState<{
    key: string;
    options?: ManagedSessionModels;
    loading: boolean;
    error: boolean;
  }>({ key, loading: false, error: false });
  const [optionsRevision, setOptionsRevision] = useState(0);
  const running = useRef(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  // The revision the failed write expected. A later read proving the Session
  // moved past it proves the write landed (or was superseded), so the failure
  // alert must not keep claiming the change did not happen.
  const failedRevision = useRef<number | undefined>(undefined);
  const summaryRef = useRef(summary);
  summaryRef.current = summary?.sessionId === sessionId ? summary : undefined;
  const refreshRef = useRef(refreshSummary);
  refreshRef.current = refreshSummary;
  const optionsRef = useRef<{
    key: string;
    value?: ManagedSessionModels;
  }>({ key });
  const visible = state.key === key ? state : { key, busy: false };
  const optionView =
    optionsState.key === key
      ? optionsState
      : { loading: false, error: false, options: undefined };
  const selectionRef = useRef<{
    key: string;
    value?: ManagedModelSelection;
  }>({ key });
  const selection = latestSelection(
    latestSelection(
      selectionRef.current.key === key ? selectionRef.current.value : undefined,
      visible.selection,
    ),
    latestSelection(
      summaryRef.current?.modelSelection,
      optionView.options?.modelSelection,
    ),
  );
  selectionRef.current = { key, value: selection };
  const selectionRevision = selection?.revision ?? 0;
  const supported =
    summaryRef.current?.capabilities.modelChange === true &&
    Boolean(provider.modelChange);

  useEffect(() => {
    const failed = failedRevision.current;
    if (visible.errorCode === undefined || failed === undefined) return;
    if (selectionRevision <= failed) return;
    failedRevision.current = undefined;
    setState((previous) => ({ ...previous, errorCode: undefined }));
  }, [selectionRevision, visible.errorCode]);

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    running.current = false;
    failedRevision.current = undefined;
    setState({ key, busy: false });
    // 旧版待确认记录不再阻塞模型设置；存储不可用也不影响正常切换。
    try {
      sessionStorage.removeItem(key);
    } catch {
      // 清理历史记录失败不改变服务端的模型设置。
    }
    return () => abort.abort();
  }, [key, provider, clientId, sessionId]);

  useEffect(() => {
    const abort = new AbortController();
    if (optionsRef.current.key !== key) optionsRef.current = { key };
    setOptionsState((current) => ({
      key,
      options: current.key === key ? current.options : undefined,
      loading: supported && interactive,
      error: false,
    }));
    if (supported && interactive && sessionId && provider.modelChange) {
      void provider.modelChange
        .queryOptions(sessionId, { clientId, signal: abort.signal })
        .then((options) => {
          if (abort.signal.aborted) return;
          optionsRef.current = { key, value: options };
          setOptionsState({ key, options, loading: false, error: false });
          if (
            options.modelSelection.revision >
            (summaryRef.current?.modelSelection?.revision ?? 0)
          ) {
            void refreshRef.current(abort.signal).catch(() => undefined);
          }
        })
        .catch(() => {
          if (!abort.signal.aborted)
            setOptionsState((current) => ({
              ...current,
              loading: false,
              error: true,
            }));
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

  async function submit(modelId: string) {
    const owner = lifetime.current;
    const api = provider.modelChange;
    const current = summaryRef.current;
    const options =
      optionsRef.current.key === key ? optionsRef.current.value : undefined;
    const selected =
      selectionRef.current.key === key ? selectionRef.current.value : undefined;
    if (
      !owner ||
      owner.signal.aborted ||
      running.current ||
      !interactive ||
      !api ||
      !current ||
      current.sessionId !== sessionId ||
      current.capabilities.modelChange !== true ||
      !options?.supported ||
      !options.models.some((model) => model.modelId === modelId) ||
      modelId === selected?.modelId
    )
      return;
    running.current = true;
    failedRevision.current = undefined;
    setState((previous) => ({
      ...previous,
      busy: true,
      errorCode: undefined,
    }));
    const abort = new AbortController();
    const stop = () => abort.abort();
    owner.signal.addEventListener('abort', stop, { once: true });
    const expectedRevision = selected?.revision ?? 0;
    try {
      const result = await withActionTimeout(
        api.submit(
          current.sessionId,
          { modelId, expectedRevision },
          {
            clientId,
            signal: abort.signal,
            idempotencyKey: managedRequestId(),
          },
        ),
        'Model change timed out',
      );
      if (owner.signal.aborted) return;
      if (
        result.sessionId !== current.sessionId ||
        result.modelSelection.modelId !== modelId ||
        !Number.isSafeInteger(result.modelSelection.revision) ||
        result.modelSelection.revision <= expectedRevision
      )
        throw new Error('Model change identity mismatch');
      // 与 DAC 一样以有效成功回执结束切换，后续刷新不能把成功重新变成待确认。
      const acknowledged = latestSelection(
        selectionRef.current.value,
        result.modelSelection,
      );
      selectionRef.current = { key, value: acknowledged };
      setState((previous) => ({
        ...previous,
        selection: acknowledged,
      }));
      return true;
    } catch (failure) {
      if (owner.signal.aborted) return;
      // A read that later reports a revision past this one retires the alert:
      // the write landed even though its response never arrived.
      failedRevision.current = expectedRevision;
      setState((previous) => ({
        ...previous,
        errorCode:
          failure instanceof JavaManagedAgentHttpError
            ? failure.code
            : 'failed',
      }));
      return false;
    } finally {
      owner.signal.removeEventListener('abort', stop);
      abort.abort();
      if (!owner.signal.aborted) {
        running.current = false;
        setState((previous) => ({ ...previous, busy: false }));
        setOptionsRevision((value) => value + 1);
        void refreshRef.current(owner.signal).catch(() => undefined);
      }
    }
  }

  return {
    ...visible,
    selection,
    options: optionView.options,
    optionsLoading: optionView.loading,
    optionsError: optionView.error,
    supported,
    blocked: visible.busy,
    submit,
    reloadOptions: () => setOptionsRevision((value) => value + 1),
    isBlocked: () => running.current,
  };
}
