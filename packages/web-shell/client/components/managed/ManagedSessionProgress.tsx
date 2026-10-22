import type { ManagedAgentSessionSummary } from './managed-agent-provider';
import { useSharedNow } from '../../hooks/useSharedNow';
import { useI18n } from '../../i18n';
import { Spinner } from '../ui/spinner';
import styles from '../StreamingStatus.module.css';

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
    summary &&
    !['created', 'completed', 'failed', 'cancelled'].includes(summary.phase);
  const now = useSharedNow(Boolean(active));
  if (!submitting && !loading && !active) return null;

  return (
    <div className={styles.status} data-managed-progress>
      <Spinner className={styles.spinner} aria-hidden="true" />
      <span className={styles.label} role="status">
        {submitting
          ? t('managed.sending')
          : loading
            ? t('managed.loading')
            : t(`managed.phase.${summary!.phase}`)}
      </span>
      {active && !submitting && !loading && (
        <span className={styles.meta}>
          {t('managed.elapsed', {
            seconds: Math.max(0, Math.floor((now - summary.admittedAt) / 1000)),
          })}
        </span>
      )}
      {active && !submitting && !loading && (
        <span className="sr-only">{t('managed.runningHint')}</span>
      )}
    </div>
  );
}
