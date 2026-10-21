import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { isRecord } from '../../daemon/session/httpErrors';
import { useEffect, useRef, useState } from 'react';
import type {
  DaemonClient,
  DaemonRuntimeStopOptions,
  DaemonRuntimeStopResult,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { useInteractionBlocker } from '../../interactionBlockContext';
import { DialogShell } from '../dialogs/DialogShell';
import { Button } from '../ui/button';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group';

export interface CapacityRecoveryIntent {
  client: DaemonClient;
  requesterCwd?: string;
  isCurrent(): boolean;
  resume(): Promise<unknown>;
}

export function CapacityRecoveryDialog({
  intent,
  onClose,
}: {
  intent: CapacityRecoveryIntent;
  onClose(): void;
}) {
  const { t } = useI18n();
  const registerInteractionBlocker = useInteractionBlocker();
  useEffect(() => registerInteractionBlocker(), [registerInteractionBlocker]);
  const [options, setOptions] = useState<DaemonRuntimeStopOptions>();
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [outcome, setOutcome] = useState<DaemonRuntimeStopResult>();
  const [unknownOutcome, setUnknownOutcome] = useState(false);
  const [failedResponse, setFailedResponse] = useState(false);
  const [continued, setContinued] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const consumed = useRef(false);
  const target = useRef<{ workspaceId: string; token: string } | undefined>(
    undefined,
  );
  const releasePending = outcome?.state === 'failed' && !outcome.released;
  const remotePending =
    unknownOutcome || outcome?.state === 'stopping' || releasePending;
  const current = intent.isCurrent();
  const candidate = options?.workspaces.find(
    (workspace) => workspace.workspaceId === selected,
  );

  const refresh = async () => {
    setBusy(true);
    try {
      const next = await intent.client.runtimeStopOptions();
      if (!mounted.current) return;
      setError(undefined);
      setOptions(next);
      setSelected('');
      const receipt = next.workspaces.find(
        (workspace) => workspace.workspaceId === target.current?.workspaceId,
      )?.lastStop;
      if (receipt && receipt.stopToken === target.current?.token) {
        setOutcome(receipt);
        setUnknownOutcome(false);
      }
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
    // Each dialog instance belongs to one captured recovery intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent]);

  const resume = async () => {
    if (!mounted.current || consumed.current || !intent.isCurrent()) return;
    consumed.current = true;
    setContinued(true);
    try {
      await intent.resume();
      if (mounted.current) onClose();
    } catch (cause) {
      if (!mounted.current) return;
      // A rejected continuation never consumed the intent: release the latch
      // so Continue stays retryable instead of leaving an inert dialog.
      consumed.current = false;
      setContinued(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const stop = async () => {
    if (
      inFlight.current ||
      !candidate?.canStop ||
      !candidate.channelId ||
      !intent.isCurrent() ||
      candidate.cwd === intent.requesterCwd
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    setUnknownOutcome(true);
    setFailedResponse(false);
    setOutcome(undefined);
    target.current = {
      workspaceId: candidate.workspaceId,
      token: candidate.stopToken,
    };
    try {
      const result = await intent.client
        .workspaceById(candidate.workspaceId)
        .stopRuntime({
          confirmInterruptions: true,
          expectedChannelId: candidate.channelId,
          expectedRuntimeEpoch: candidate.runtimeEpoch,
          expectedStopToken: candidate.stopToken,
          expectedSessionIds: candidate.sessions.map(
            (session) => session.sessionId,
          ),
        });
      if (!mounted.current) return;
      setUnknownOutcome(false);
      setOutcome(result);
      if (result.stopped && result.released) await resume();
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setFailedResponse(
        cause instanceof DaemonHttpError &&
          isRecord(cause.body) &&
          cause.body.code === 'workspace_runtime_stop_failed',
      );
      if (
        cause instanceof DaemonHttpError &&
        ([401, 403, 404].includes(cause.status) ||
          (isRecord(cause.body) &&
            [
              'workspace_runtime_stop_stale',
              'workspace_runtime_stop_blocked',
              'invalid_runtime_stop_confirmation',
              'workspace_runtime_stop_not_supported',
              'workspace_runtime_unavailable',
              'workspace_mismatch',
            ].includes(String(cause.body.code))))
      ) {
        setUnknownOutcome(false);
      }
      await refresh();
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <DialogShell title={t('capacityChoice.title')} onClose={onClose}>
      <div
        className="flex flex-col gap-4"
        data-testid="capacity-recovery-dialog"
      >
        <p className="text-sm text-muted-foreground">
          {t('capacityChoice.description')}
        </p>
        {options && (
          <p className="text-sm">
            {t('capacityChoice.capacity', {
              used: options.committedAcpChildren,
              limit: options.maxConcurrentChildren ?? '?',
            })}
          </p>
        )}
        {!current && !continued && (
          <p role="alert">{t('capacityChoice.outdated')}</p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {outcome && (
          <p role="status" className="text-sm">
            {t('capacityChoice.outcome', {
              closed: outcome.closedSessionIds.length,
              remaining: outcome.remainingSessionIds.length,
            })}{' '}
            {outcome.error ?? ''}
          </p>
        )}
        {remotePending && (
          <p role="status">
            {t(
              releasePending
                ? 'capacityChoice.failedUnreleased'
                : failedResponse && unknownOutcome
                  ? 'capacityChoice.failedUnknownCleanup'
                  : 'capacityChoice.inProgress',
            )}
          </p>
        )}
        <RadioGroup
          value={selected}
          onValueChange={setSelected}
          disabled={busy || !current || continued || remotePending}
          aria-label={t('capacityChoice.workspaces')}
        >
          {options?.workspaces.map((workspace) => {
            const ownWorkspace = workspace.cwd === intent.requesterCwd;
            const disabled = !workspace.canStop || ownWorkspace;
            return (
              <label
                key={workspace.workspaceId}
                className="flex items-start gap-3 rounded-md border p-3"
              >
                <RadioGroupItem
                  value={workspace.workspaceId}
                  disabled={disabled}
                />
                <span className="min-w-0 flex-1 break-all text-sm">
                  <strong>
                    {workspace.displayName || workspace.cwd}
                    {workspace.primary
                      ? ` · ${t('channels.workspace.primary')}`
                      : ''}
                  </strong>
                  {workspace.displayName && (
                    <span className="block text-muted-foreground">
                      {workspace.cwd}
                    </span>
                  )}
                  <span className="block">
                    {t('capacityChoice.sessions', {
                      count: workspace.sessions?.length ?? 0,
                    })}
                  </span>
                  {disabled && (
                    <span className="block text-muted-foreground">
                      {ownWorkspace
                        ? t('capacityChoice.requester')
                        : workspace.blockedReasons
                            .map((reason) =>
                              t(`capacityChoice.blocked.${reason}`),
                            )
                            .join(', ')}
                    </span>
                  )}
                  {workspace.sessions?.map((session) => (
                    <span className="block" key={session.sessionId}>
                      {session.displayName || session.sessionId}
                      {session.hasActivePrompt
                        ? ` · ${t('capacityChoice.running')}`
                        : ''}
                      {session.queuedPrompts > 0
                        ? ` · ${t('capacityChoice.queued', { count: session.queuedPrompts })}`
                        : ''}
                      {session.isWaitingForPermission ||
                      session.isWaitingForUserQuestion
                        ? ` · ${t('capacityChoice.waiting')}`
                        : ''}
                      {session.hasRunningBackgroundTasks !== false
                        ? ` · ${t(session.hasRunningBackgroundTasks ? 'capacityChoice.background' : 'capacityChoice.backgroundUnknown')}`
                        : ''}
                    </span>
                  ))}
                </span>
              </label>
            );
          })}
        </RadioGroup>
        {options &&
          !options.workspaces.some(
            (workspace) =>
              workspace.canStop && workspace.cwd !== intent.requesterCwd,
          ) && <p className="text-sm">{t('capacityChoice.none')}</p>}
        <p className="text-sm">{t('capacityChoice.warning')}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {t('capacityChoice.refresh')}
          </Button>
          {outcome?.stopped && outcome.released ? (
            <Button
              disabled={!current || continued || busy}
              onClick={() => void resume()}
            >
              {t('capacityChoice.continue')}
            </Button>
          ) : (
            <Button
              disabled={
                busy ||
                !current ||
                continued ||
                remotePending ||
                !candidate?.canStop ||
                candidate.cwd === intent.requesterCwd
              }
              onClick={() => void stop()}
            >
              {t('capacityChoice.confirm')}
            </Button>
          )}
        </div>
      </div>
    </DialogShell>
  );
}
