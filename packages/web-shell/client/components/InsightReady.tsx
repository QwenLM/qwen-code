import styles from './InsightProgress.module.css';
import { useI18n } from '../i18n';

interface InsightReadyProps {
  path: string;
  onInsightReportOpen?: (path: string) => void;
}

export function InsightReady({ path, onInsightReportOpen }: InsightReadyProps) {
  const { t } = useI18n();
  return (
    <div className={`${styles.progress} ${styles.done}`}>
      <span className={styles.icon}>✓</span>
      <span className={styles.stage}>{t('insight.ready')}</span>
      {onInsightReportOpen ? (
        <button
          type="button"
          className={`${styles.path} ${styles.pathButton}`}
          onClick={() => onInsightReportOpen(path)}
        >
          {path}
        </button>
      ) : (
        <span className={styles.path}>{path}</span>
      )}
    </div>
  );
}
