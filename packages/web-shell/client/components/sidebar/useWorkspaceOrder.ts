import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonClient } from '@qwen-code/sdk/daemon';
import { readWorkspaceOrder, writeWorkspaceOrder } from './workspaceOrder';

export function useWorkspaceOrder({
  client,
  scope,
  primaryWorkspaceCwd,
  serverEnabled,
  onError,
}: {
  client: Pick<DaemonClient, 'getWorkspaceOrder' | 'setWorkspaceOrder'>;
  scope: string;
  primaryWorkspaceCwd: string | undefined;
  serverEnabled: boolean;
  onError: (error: unknown) => void;
}) {
  const serverScope = serverEnabled ? primaryWorkspaceCwd : undefined;
  const owner = useMemo(
    () => ({ client, scope, serverEnabled, serverScope }),
    [client, scope, serverEnabled, serverScope],
  );
  const activeOwner = useRef<typeof owner | undefined>(owner);
  activeOwner.current = owner;
  const pendingOwner = useRef<typeof owner | undefined>(undefined);
  const reportError = useRef(onError);
  reportError.current = onError;
  const [state, setState] = useState(() => ({
    owner,
    order: serverEnabled ? ([] as string[]) : readWorkspaceOrder(scope),
    ready: !serverEnabled,
    saving: false,
  }));

  useEffect(() => {
    activeOwner.current = owner;
    const initial = {
      owner,
      order: serverEnabled ? ([] as string[]) : readWorkspaceOrder(scope),
      ready: !serverEnabled,
      saving: false,
    };
    setState(initial);
    let cancelled = false;
    if (serverEnabled) {
      void client
        .getWorkspaceOrder()
        .then(({ cwds }) => {
          if (!cancelled) setState({ ...initial, order: cwds, ready: true });
        })
        .catch((error: unknown) => {
          if (!cancelled) reportError.current(error);
        });
    }
    return () => {
      cancelled = true;
      if (activeOwner.current === owner) activeOwner.current = undefined;
    };
  }, [client, scope, serverEnabled, owner]);

  const canReorder = state.owner === owner && state.ready && !state.saving;
  const order = state.owner === owner ? state.order : [];
  const saveOrder = useCallback(
    async (next: string[]) => {
      if (!canReorder || pendingOwner.current === owner) return;
      pendingOwner.current = owner;
      const previous = state.order;
      setState({ owner, order: next, ready: true, saving: true });
      try {
        if (serverEnabled) await client.setWorkspaceOrder(next);
        else writeWorkspaceOrder(scope, next);
      } catch (error) {
        if (activeOwner.current === owner) {
          setState({ owner, order: previous, ready: true, saving: false });
          reportError.current(error);
        }
      } finally {
        if (pendingOwner.current === owner) pendingOwner.current = undefined;
        if (activeOwner.current === owner)
          setState((current) => ({ ...current, saving: false }));
      }
    },
    [canReorder, owner, state.order, serverEnabled, client, scope],
  );

  return { order, canReorder, saveOrder };
}
