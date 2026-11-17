import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedSessionRecovery,
} from './managed-agent-provider';

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
    busy?: boolean;
  }>({ key });
  const lifetime = useRef<AbortController | undefined>(undefined);
  const refreshRef = useRef(refreshSummary);
  refreshRef.current = refreshSummary;
  const currentValue = useRef(summary?.recovery);
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  const value =
    snapshot.key === key
      ? (snapshot.value ?? summary?.recovery)
      : summary?.recovery;
  currentValue.current = value;

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    setSnapshot({ key, value: currentValue.current });
    return () => abort.abort();
  }, [provider, key]);

  const pollRecovery =
    value !== undefined &&
    value.state !== 'ready' &&
    value.reasonCode !== 'turn_active';
  useEffect(() => {
    setSnapshot((current) => ({
      ...(current.key === key ? current : { key }),
      value: summary?.recovery,
    }));
  }, [key, summary?.recovery]);

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
      const previous = currentValue.current;
      currentValue.current = next;
      setSnapshot({ key, value: next });
      if (
        previous?.state !== next.state ||
        previous?.nextTurnAllowed !== next.nextTurnAllowed
      )
        await refreshRef.current();
    } catch (error) {
      if (!abort.signal.aborted)
        setSnapshot((current) => ({ ...current, key, error: String(error) }));
    }
  }, [provider, clientId, sessionId, key]);

  useEffect(() => {
    if (!interactive || !provider.recovery || !pollRecovery) return;
    let reading = false;
    const tick = () => {
      if (document.visibilityState === 'hidden' || reading) return;
      reading = true;
      void read().finally(() => {
        reading = false;
      });
    };
    tick();
    const timer = setInterval(tick, 5_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
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
    setSnapshot({ key, value, busy: true });
    try {
      const next = await api.recheck(sessionId, value.turnId, {
        clientId,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      setSnapshot({ key, value: next });
      await refreshRef.current();
    } catch (error) {
      if (!abort.signal.aborted)
        setSnapshot({ key, value, error: String(error) });
    }
  }

  return {
    value,
    busy: snapshot.key === key && snapshot.busy === true,
    error: snapshot.key === key ? snapshot.error : undefined,
    recheck,
  };
}
