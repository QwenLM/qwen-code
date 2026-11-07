import { useManagedRecoveryText } from './managed-recovery-messages';
import { Button } from '../ui/button';
import type { ManagedSessionRecovery } from './managed-agent-provider';

export function ManagedRecoveryPanel({
  recovery,
  busy,
  error,
  onRecheck,
  onCancel,
  onHandoff,
  attention = true,
}: {
  recovery: ManagedSessionRecovery;
  busy: boolean;
  error?: string;
  onRecheck: () => void;
  onCancel?: () => void;
  onHandoff?: () => void;
  attention?: boolean;
}) {
  const t = useManagedRecoveryText();
  if (recovery.state === 'ready' || recovery.reasonCode === 'turn_active')
    return null;
  return (
    <section
      className="space-y-2 rounded-md border p-3"
      aria-label={t('managed.recovery.title')}
    >
      {attention && (
        <p role="status" className="font-medium">
          {t(`managed.recovery.state.${recovery.state}`)}
        </p>
      )}
      {attention && (
        <p className="text-sm text-muted-foreground">
          {t(`managed.recovery.explanation.${recovery.state}`)}
        </p>
      )}
      <details className="text-sm">
        <summary>{t('managed.recovery.diagnostics')}</summary>
        <p>{recovery.reasonCode}</p>
        {recovery.turnId && <p>{recovery.turnId}</p>}
      </details>
      {error && <p role="alert">{t('managed.recovery.requestFailed')}</p>}
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
