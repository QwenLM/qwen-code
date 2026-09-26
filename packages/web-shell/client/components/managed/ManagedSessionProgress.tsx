import type { ManagedAgentSessionSummary } from './managed-agent-provider';
import { useSharedNow } from '../../hooks/useSharedNow';
import { useI18n } from '../../i18n';
import { Spinner } from '../ui/spinner';

export function ManagedSessionProgress({
  summary,
  submitting,
  loading,
}: {
  summary?: ManagedAgentSessionSummary;
  submitting: boolean;
  loading: boolean;
}) {
  const { t } = useI18n();
  const active =
    summary && !['completed', 'failed', 'cancelled'].includes(summary.phase);
  const now = useSharedNow(Boolean(active));
  if (!submitting && !loading && !active) return null;

  return (
    <div
      className="shrink-0 rounded-md border bg-muted/40 px-3 py-2 text-sm"
      data-managed-progress
    >
      <div className="flex items-center gap-2">
        <Spinner aria-hidden="true" />
        <span role="status">
          {submitting
            ? t('managed.sending')
            : loading
              ? t('managed.loading')
              : t(`managed.phase.${summary!.phase}`)}
        </span>
        {active && !submitting && !loading && (
          <span className="text-muted-foreground">
            {t('managed.elapsed', {
              seconds: Math.max(
                0,
                Math.floor((now - summary.admittedAt) / 1000),
              ),
            })}
          </span>
        )}
      </div>
      {active && !submitting && !loading && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('managed.runningHint')}
        </p>
      )}
    </div>
  );
}
