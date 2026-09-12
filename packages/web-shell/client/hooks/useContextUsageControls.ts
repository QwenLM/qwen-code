import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DaemonConnectionState,
  DaemonSessionActions,
  DaemonSessionContextUsageStatus,
  DaemonSessionOwnerGuard,
  DaemonSessionOwnerSnapshot,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { isGoalGateBlocked } from '../utils/goalGate';

type CompressionResult =
  | { kind: 'completed'; usage: DaemonSessionContextUsageStatus }
  | { kind: 'failed' | 'cancelled' | 'refreshFailed' };

export interface ContextUsageControls {
  sessionId: string;
  canCompress: boolean;
  compressing: boolean;
  result?: CompressionResult;
  compress(): Promise<void>;
  captureOwner(): DaemonSessionOwnerSnapshot;
  getContextUsage: DaemonSessionActions['getContextUsage'];
}

export type RegisterContextUsageControls = (
  controls: ContextUsageControls,
) => () => void;

export function useContextUsageControls({
  connection,
  actions,
  ownerGuard,
  busy,
  writeBlocked,
  onBeforeCompress,
}: {
  connection: DaemonConnectionState;
  actions: DaemonSessionActions;
  ownerGuard: DaemonSessionOwnerGuard;
  busy: boolean;
  writeBlocked: boolean;
  onBeforeCompress: () => void;
}): ContextUsageControls | undefined {
  const available =
    Boolean(connection.sessionId) &&
    connection.status === 'connected' &&
    !connection.loadingTranscript &&
    !connection.catchingUp &&
    !busy &&
    !writeBlocked &&
    !isGoalGateBlocked(connection) &&
    connection.commands?.some(
      (command) =>
        command.name === 'compress' && command.source === 'builtin-command',
    ) === true;
  const latest = useRef({ available, connection });
  latest.current = { available, connection };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const pending = useRef<DaemonSessionOwnerSnapshot | undefined>(undefined);
  const [operation, setOperation] = useState<{
    owner: DaemonSessionOwnerSnapshot;
    result?: CompressionResult;
  }>();
  const currentOperation = operation?.owner.isCurrent() ? operation : undefined;
  const sessionId = connection.sessionId;
  const workspaceCwd = connection.workspaceCwd;
  const compress = useCallback(async () => {
    if (
      !mounted.current ||
      !latest.current.available ||
      latest.current.connection.sessionId !== sessionId ||
      latest.current.connection.workspaceCwd !== workspaceCwd ||
      pending.current?.isCurrent()
    ) {
      return;
    }
    const owner = ownerGuard.capture();
    pending.current = owner;
    setOperation({ owner });
    const isCurrent = () => mounted.current && owner.isCurrent();
    try {
      onBeforeCompress();
      const result = await actions.sendPrompt('/compress');
      if (!isCurrent()) return;
      if (result.stopReason === 'cancelled') {
        setOperation({ owner, result: { kind: 'cancelled' } });
        return;
      }
      try {
        const usage = await actions.getContextUsage({
          detail: true,
          silent: true,
          syncCounters: true,
        });
        if (!isCurrent()) return;
        setOperation({
          owner,
          result:
            usage.sessionId === sessionId && usage.usage.contextWindowSize > 0
              ? { kind: 'completed', usage }
              : { kind: 'refreshFailed' },
        });
      } catch {
        if (isCurrent()) {
          setOperation({ owner, result: { kind: 'refreshFailed' } });
        }
      }
    } catch {
      if (isCurrent()) setOperation({ owner, result: { kind: 'failed' } });
    } finally {
      if (pending.current === owner) pending.current = undefined;
    }
  }, [actions, onBeforeCompress, ownerGuard, sessionId, workspaceCwd]);

  const compressing = Boolean(currentOperation && !currentOperation.result);
  const result = currentOperation?.result;
  return useMemo(
    () =>
      sessionId
        ? {
            sessionId,
            canCompress: available && !compressing,
            compressing,
            result,
            compress,
            getContextUsage: actions.getContextUsage,
            captureOwner: () => ownerGuard.capture({ includeRecovery: true }),
          }
        : undefined,
    [sessionId, available, compressing, result, compress, actions, ownerGuard],
  );
}
