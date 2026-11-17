import { useCallback, useEffect, useRef, useState } from 'react';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedSessionRecovery,
} from './managed-agent-provider';

const RECOVERY_POLL_MS = 5_000;
const RECOVERY_POLL_MAX_MS = 30_000;

export function useManagedRecovery(
  provider: ManagedAgentProvider,
  clientId: string,
  summary: ManagedAgentSessionSummary | undefined,
  interactive: boolean,
  refreshSummary: () => Promise<ManagedAgentSessionSummary | undefined>,
) {
  const sessionId = summary?.sessionId;
  const key = JSON.stringify([provider.storageKey, sessionId]);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    value?: ManagedSessionRecovery;
    error?: string;
    errorCode?: string;
    busy?: boolean;
  }>({ key });
  const [pending, setPending] = useState(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const refreshRef = useRef(refreshSummary);
  refreshRef.current = refreshSummary;
  const currentValue = useRef<ManagedSessionRecovery | undefined>(undefined);
  // canSend from the summary that produced the verdict the hook trusts; a held
  // verdict must not follow the raw summary's recovery-derived send gate.
  const trustedCanSend = useRef<boolean | undefined>(undefined);
  const stableReads = useRef(0);
  const suppressed = useRef<{ turnId?: string; count: number }>({
    count: 0,
  });
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  const value = snapshot.key === key ? snapshot.value : undefined;
  currentValue.current = value;

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    stableReads.current = 0;
    suppressed.current = { count: 0 };
    trustedCanSend.current = undefined;
    setPending(false);
    setSnapshot({ key });
    return () => abort.abort();
  }, [provider, key]);

  const publish = useCallback(
    (next?: ManagedSessionRecovery) => {
      const previous = currentValue.current;
      if (previous === next) return previous;
      stableReads.current =
        previous?.state === next?.state &&
        previous?.reasonCode === next?.reasonCode
          ? stableReads.current + 1
          : 0;
      currentValue.current = next;
      setSnapshot((current) => ({
        ...(current.key === key ? current : { key }),
        value: next,
      }));
      return previous;
    },
    [key],
  );

  const accept = useCallback(
    (
      incoming?: ManagedSessionRecovery,
    ): { value?: ManagedSessionRecovery; held: boolean } => {
      const current = currentValue.current;
      if (!incoming) {
        suppressed.current = { count: 0 };
        return { held: false };
      }
      const miss =
        incoming.state === 'operator_required' &&
        incoming.reasonCode === 'recovery_evidence_unavailable';
      if (!miss) {
        suppressed.current = { count: 0 };
        return { value: incoming, held: false };
      }
      const count =
        suppressed.current.turnId === incoming.turnId
          ? suppressed.current.count + 1
          : 1;
      suppressed.current = { turnId: incoming.turnId, count };
      // 多副本部署里没有 attachment 的副本会把 ready 读成 evidence unavailable；
      // 同一轮次连续两次读到缺失才接受，避免一次读就收回发送能力造成闪烁
      return count > 1
        ? { value: incoming, held: false }
        : { value: current, held: true };
    },
    [],
  );

  const pollRecovery =
    pending ||
    (value !== undefined &&
      value.state !== 'ready' &&
      value.reasonCode !== 'turn_active' &&
      value.reasonCode !== 'session_not_active');
  useEffect(() => {
    if (!summary) return;
    const decision = accept(summary.recovery);
    if (decision.held) {
      setPending(true);
      return;
    }
    setPending(false);
    trustedCanSend.current = summary.capabilities.canSend;
    publish(decision.value);
  }, [accept, publish, summary]);

  const read = useCallback(async () => {
    const api = provider.recovery;
    const abort = lifetime.current;
    if (!api || !sessionId || !abort || abort.signal.aborted) return;
    try {
      const next = await api.query(sessionId, {
        clientId,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      if (next.turnId !== summaryRef.current?.activeTurnId) {
        await refreshRef.current();
        return;
      }
      if (accept(next).held) {
        setPending(true);
        return;
      }
      setPending(false);
      const previous = publish(next);
      if (
        previous?.state !== next.state ||
        previous?.nextTurnAllowed !== next.nextTurnAllowed
      )
        await refreshRef.current();
    } catch (error) {
      if (!abort.signal.aborted)
        setSnapshot((current) => ({
          ...(current.key === key ? current : { key }),
          error: String(error),
          errorCode:
            error instanceof JavaManagedAgentHttpError ? error.code : undefined,
        }));
    }
  }, [accept, publish, provider, clientId, sessionId, key]);

  useEffect(() => {
    if (!interactive || !provider.recovery || !pollRecovery) return;
    let cancelled = false;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delay = () =>
      currentValue.current?.state === 'operator_required'
        ? Math.min(
            RECOVERY_POLL_MS * 2 ** Math.max(0, stableReads.current - 1),
            RECOVERY_POLL_MAX_MS,
          )
        : RECOVERY_POLL_MS;
    const schedule = () => {
      if (!cancelled) timer = setTimeout(tick, delay());
    };
    const tick = () => {
      if (cancelled) return;
      if (document.visibilityState === 'hidden' || reading) {
        schedule();
        return;
      }
      reading = true;
      void read().finally(() => {
        reading = false;
        schedule();
      });
    };
    tick();
    const onVisible = () => {
      if (document.visibilityState === 'hidden' || reading) return;
      if (timer !== undefined) clearTimeout(timer);
      tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [interactive, provider, read, pollRecovery]);

  async function recheck() {
    const api = provider.recovery;
    const abort = lifetime.current;
    if (
      !api ||
      !sessionId ||
      !value?.turnId ||
      !value.actions.recheck ||
      !abort ||
      abort.signal.aborted ||
      snapshot.busy
    )
      return;
    setSnapshot((current) => ({
      ...(current.key === key ? current : { key }),
      busy: true,
      error: undefined,
      errorCode: undefined,
    }));
    try {
      const next = await api.recheck(sessionId, value.turnId, {
        clientId,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      suppressed.current = { count: 0 };
      setPending(false);
      publish(next);
      setSnapshot((current) => ({
        ...(current.key === key ? current : { key }),
        busy: false,
      }));
      await refreshRef.current();
    } catch (error) {
      if (abort.signal.aborted) return;
      setSnapshot((current) => ({
        ...(current.key === key ? current : { key }),
        busy: false,
        error: String(error),
        errorCode:
          error instanceof JavaManagedAgentHttpError ? error.code : undefined,
      }));
      if (
        error instanceof JavaManagedAgentHttpError &&
        error.code === 'recovery_target_changed'
      )
        await refreshRef.current()?.catch(() => undefined);
    }
  }

  const summaryVerdict = summary?.recovery;
  const valueDiffersFromSummary =
    value !== undefined &&
    (summaryVerdict === undefined ||
      value.state !== summaryVerdict.state ||
      value.reasonCode !== summaryVerdict.reasonCode ||
      value.turnId !== summaryVerdict.turnId);
  return {
    value,
    // While the hook holds a verdict the raw summary disagrees with, the send
    // gate must follow the verdict and the authorization from the read that
    // produced it, not a canSend recomputed from the distrusted miss.
    canSend:
      pending || valueDiffersFromSummary
        ? (trustedCanSend.current ?? true)
        : undefined,
    busy: snapshot.key === key && snapshot.busy === true,
    error: snapshot.key === key ? snapshot.error : undefined,
    errorCode: snapshot.key === key ? snapshot.errorCode : undefined,
    recheck,
  };
}
