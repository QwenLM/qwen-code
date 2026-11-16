import { useEffect, useRef, useState } from 'react';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
} from './managed-agent-provider';
import { managedRequestId } from './managed-session-storage';

export function useManagedSessionRename(
  provider: ManagedAgentProvider,
  clientId: string,
  sessionId: string | undefined,
  summary: ManagedAgentSessionSummary | undefined,
  interactive: boolean,
  onRenamed: (sessionId: string, displayName: string) => void,
) {
  const [editor, setEditor] = useState<{
    value: string;
    busy: boolean;
    error?: string;
  }>();
  const target = useRef<ManagedAgentSessionSummary | undefined>(undefined);
  const intent = useRef<
    | {
        displayName: string;
        idempotencyKey: string;
        busy: boolean;
      }
    | undefined
  >(undefined);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const currentTarget =
    target.current?.sessionId === sessionId ? summary : target.current;
  const supportsRename = (session: ManagedAgentSessionSummary | undefined) =>
    Boolean(
      interactive &&
        provider.renameSession &&
        session?.capabilities.canRename === true,
    );

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    intent.current = undefined;
    target.current = undefined;
    setEditor(undefined);
    return () => abort.abort();
  }, [provider, clientId, sessionId]);

  return {
    supported: summary?.sessionId === sessionId && supportsRename(summary),
    editor: supportsRename(currentTarget) ? editor : undefined,
    open(session = summary) {
      if (supportsRename(session) && session && !intent.current?.busy) {
        if (target.current?.sessionId !== session.sessionId) {
          intent.current = undefined;
        }
        target.current = session;
        setEditor({ value: session.title, busy: false });
      }
    },
    close() {
      setEditor(undefined);
    },
    setValue(value: string) {
      setEditor((current) =>
        current && !current.busy ? { value, busy: false } : current,
      );
    },
    async submit(displayName: string) {
      const abort = lifetime.current;
      if (
        !supportsRename(currentTarget) ||
        !currentTarget ||
        !provider.renameSession ||
        !abort ||
        abort.signal.aborted ||
        intent.current?.busy ||
        !displayName.trim() ||
        displayName.length > 256
      ) {
        return;
      }
      const attempt =
        intent.current?.displayName === displayName
          ? intent.current
          : {
              displayName,
              idempotencyKey: managedRequestId(),
              busy: false,
            };
      intent.current = attempt;
      attempt.busy = true;
      setEditor((current) =>
        current ? { value: displayName, busy: true } : undefined,
      );
      try {
        const result = await provider.renameSession(
          currentTarget.sessionId,
          displayName,
          {
            clientId,
            idempotencyKey: attempt.idempotencyKey,
            signal: abort.signal,
          },
        );
        if (abort.signal.aborted) return;
        onRenamed(currentTarget.sessionId, result.displayName);
        setEditor(undefined);
        intent.current = undefined;
      } catch (error) {
        if (abort.signal.aborted) return;
        setEditor((current) =>
          current
            ? {
                value: current.value,
                busy: false,
                error: error instanceof Error ? error.message : String(error),
              }
            : undefined,
        );
      } finally {
        attempt.busy = false;
      }
    },
  };
}
