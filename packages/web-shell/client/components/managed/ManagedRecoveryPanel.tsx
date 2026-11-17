import {
  useManagedRecoveryText,
  type ManagedRecoveryMessageKey,
} from './managed-recovery-messages';
import { Button } from '../ui/button';
import type { ManagedSessionRecovery } from './managed-agent-provider';

export function ManagedRecoveryPanel({
  recovery,
  busy,
  error,
  errorCode,
  onRecheck,
  onCancel,
  onHandoff,
}: {
  recovery: ManagedSessionRecovery;
  busy: boolean;
  error?: string;
  errorCode?: string;
  onRecheck: () => void;
  onCancel?: () => void;
  onHandoff?: () => void;
}) {
  const t = useManagedRecoveryText();
  if (recovery.state === 'ready' || recovery.reasonCode === 'turn_active')
    return null;
  const ended = recovery.reasonCode === 'session_not_active';
  const state: ManagedRecoveryMessageKey = ended
    ? 'managed.recovery.state.ended'
    : `managed.recovery.state.${recovery.state}`;
  const explanation: ManagedRecoveryMessageKey = ended
    ? 'managed.recovery.explanation.ended'
    : `managed.recovery.explanation.${recovery.state}`;
  return (
    <section
      className="space-y-2 rounded-md border p-3"
      aria-label={t('managed.recovery.title')}
    >
      <p role="status" className="font-medium">
        {t(state)}
      </p>
      <p className="text-sm text-muted-foreground">{t(explanation)}</p>
      <details className="text-sm">
        <summary>{t('managed.recovery.diagnostics')}</summary>
        <p>{recovery.reasonCode}</p>
        {recovery.turnId && <p>{recovery.turnId}</p>}
      </details>
      {error && <p role="alert">{t(errorMessage(errorCode))}</p>}
      <div className="flex flex-wrap gap-2">
        {recovery.actions.recheck && (
          <Button variant="outline" disabled={busy} onClick={onRecheck}>
            {t('managed.recovery.recheck')}
          </Button>
        )}
        {recovery.actions.cancel && onCancel && (
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            {t('managed.recovery.endTurn')}
          </Button>
        )}
        {recovery.actions.continueInNewSession && onHandoff && (
          <Button variant="outline" disabled={busy} onClick={onHandoff}>
            {t('managed.recovery.handoff')}
          </Button>
        )}
      </div>
    </section>
  );
}

function errorMessage(errorCode?: string): ManagedRecoveryMessageKey {
  if (errorCode === 'recovery_recheck_unavailable')
    return 'managed.recovery.recheckUnavailable';
  if (errorCode === 'recovery_target_changed')
    return 'managed.recovery.targetChanged';
  return 'managed.recovery.requestFailed';
}
