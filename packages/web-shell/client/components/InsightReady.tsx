import styles from './InsightProgress.module.css';
import { useI18n } from '../i18n';

interface InsightReadyProps {
  path: string;
}

export function InsightReady({ path }: InsightReadyProps) {
  const { t } = useI18n();
  return (
    <div className={`${styles.progress} ${styles.done}`}>
      <span className={styles.icon}>✓</span>
      <span className={styles.stage}>{t('insight.ready')}</span>
      <span className={styles.path}>{path}</span>
    </div>
  );
}
