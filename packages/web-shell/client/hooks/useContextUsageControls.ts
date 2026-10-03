import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  DaemonConnectionState,
  DaemonSessionActions,
  DaemonSessionContextUsageStatus,
  DaemonSessionOwnerGuard,
  DaemonSessionOwnerSnapshot,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { isGoalGateBlocked } from '../utils/goalGate';
import {
  ContextCompressionAnnouncementContext,
  type CompressionAnnouncement,
} from '../components/ContextCompressionAnnouncer';

type CompressionResult =
  | { kind: 'completed'; usage: DaemonSessionContextUsageStatus }
  | { kind: 'failed' | 'cancelled' | 'refreshFailed' | 'interrupted' };

export interface ContextUsageControls {
  sessionId: string;
  workspaceCwd?: string;
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
  onAnnouncement,
}: {
  connection: DaemonConnectionState;
  actions: DaemonSessionActions;
  ownerGuard: DaemonSessionOwnerGuard;
  busy: boolean;
  writeBlocked: boolean;
  onBeforeCompress: () => void;
  onAnnouncement?: (announcement: CompressionAnnouncement) => void;
}): ContextUsageControls | undefined {
  const inheritedAnnounce = useContext(ContextCompressionAnnouncementContext);
  const announce = onAnnouncement ?? inheritedAnnounce;
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
  const sessionId = connection.sessionId;
  const workspaceCwd = connection.workspaceCwd;
  const scope = useMemo(
    () => ({ sessionId, workspaceCwd }),
    [sessionId, workspaceCwd],
  );
  const latest = useRef({ available, scope });
  latest.current = { available, scope };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const pending = useRef<typeof scope | undefined>(undefined);
  const [operation, setOperation] = useState<{
    scope: typeof scope;
    result?: CompressionResult;
  }>();
  const currentOperation = operation?.scope === scope ? operation : undefined;
  const compress = useCallback(async () => {
    if (
      !mounted.current ||
      !latest.current.available ||
      latest.current.scope !== scope ||
      pending.current === scope
    ) {
      return;
    }
    const owner = ownerGuard.capture();
    pending.current = scope;
    setOperation({ scope });
    const operation = {};
    const notify = (phase: CompressionAnnouncement['phase']) => {
      if (sessionId) announce?.({ operation, sessionId, workspaceCwd, phase });
    };
    notify('pending');
    const isCurrent = () => mounted.current && latest.current.scope === scope;
    const settle = (result: CompressionResult) => {
      if (isCurrent()) {
        const settled = owner.isCurrent()
          ? result
          : { kind: 'interrupted' as const };
        setOperation({
          scope,
          result: settled,
        });
        notify(settled.kind);
      }
    };
    try {
      onBeforeCompress();
      const result = await actions.sendPrompt('/compress');
      if (!isCurrent()) return;
      if (!owner.isCurrent()) {
        settle({ kind: 'interrupted' });
        return;
      }
      if (result.stopReason === 'cancelled') {
        settle({ kind: 'cancelled' });
        return;
      }
      try {
        const usage = await actions.getContextUsage({
          detail: true,
          silent: true,
          syncCounters: true,
        });
        settle(
          usage.sessionId === sessionId && usage.usage.contextWindowSize > 0
            ? { kind: 'completed', usage }
            : { kind: 'refreshFailed' },
        );
      } catch {
        settle({ kind: 'refreshFailed' });
      }
    } catch {
      settle({ kind: 'failed' });
    } finally {
      if (pending.current === scope) pending.current = undefined;
    }
  }, [
    actions,
    onBeforeCompress,
    ownerGuard,
    sessionId,
    scope,
    workspaceCwd,
    announce,
  ]);

  const compressing = Boolean(currentOperation && !currentOperation.result);
  const result = currentOperation?.result;
  return useMemo(
    () =>
      sessionId
        ? {
            sessionId,
            workspaceCwd,
            canCompress: available && !compressing,
            compressing,
            result,
            compress,
            getContextUsage: actions.getContextUsage,
            captureOwner: () => ownerGuard.capture({ includeRecovery: true }),
          }
        : undefined,
    [
      sessionId,
      workspaceCwd,
      available,
      compressing,
      result,
      compress,
      actions,
      ownerGuard,
    ],
  );
}
