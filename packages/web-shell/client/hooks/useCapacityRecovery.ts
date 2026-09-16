import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { DaemonClient } from '@qwen-code/sdk/daemon';
import type {
  DaemonConnectionState,
  DaemonSessionActions,
} from '../daemon/session/types';
import { isRecoverableAcpCapacityError } from '../daemon/session/httpErrors';
import type { CapacityRecoveryIntent } from '../components/workspaces/CapacityRecoveryDialog';

export function useCapacityRecovery(
  client: DaemonClient | undefined,
  features: readonly string[] | undefined,
  connection: DaemonConnectionState,
  actions: Pick<DaemonSessionActions, 'loadSession' | 'resumeSession'>,
) {
  const [intent, setIntent] = useState<CapacityRecoveryIntent>();
  const owner = useRef({ client });
  if (owner.current.client !== client) owner.current = { client };
  const renderOwner = owner.current;
  const mounted = useRef(true);
  const latest = useRef({ connection, actions });
  latest.current = { connection, actions };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const supported = features?.includes('workspace_runtime_stop') === true;
  const offer = useCallback(
    (error: unknown, continuation: Omit<CapacityRecoveryIntent, 'client'>) => {
      if (
        !client ||
        owner.current !== renderOwner ||
        !supported ||
        !isRecoverableAcpCapacityError(error) ||
        !continuation.isCurrent()
      )
        return false;
      const capturedOwner = renderOwner;
      setIntent(
        (previous) =>
          previous ?? {
            ...continuation,
            client,
            isCurrent: () =>
              mounted.current &&
              owner.current === capturedOwner &&
              continuation.isCurrent(),
          },
      );
      return true;
    },
    [client, supported, renderOwner],
  );
  const offered = useRef<DaemonConnectionState['capacityRecovery']>(undefined);
  useEffect(() => {
    const recovery = connection.capacityRecovery;
    if (!recovery || offered.current === recovery) return;
    const accepted = offer(recovery.error, {
      requesterCwd:
        recovery.sessionContext?.kind === 'workspace'
          ? recovery.sessionContext.cwd
          : undefined,
      isCurrent: () =>
        latest.current.connection.capacityRecovery === recovery &&
        latest.current.connection.status === 'error',
      resume: () =>
        latest.current.actions[
          recovery.mode === 'load' ? 'loadSession' : 'resumeSession'
        ](recovery.sessionId, { sessionContext: recovery.sessionContext }),
    });
    if (accepted) offered.current = recovery;
  }, [connection.capacityRecovery, offer]);
  return { intent, offer, dismiss: () => setIntent(undefined) };
}
