import styles from './InsightProgress.module.css';

export interface InsightProgressData {
  stage: string;
  progress: number;
  detail?: string;
  isComplete?: boolean;
  error?: string;
}

interface InsightProgressProps {
  progress: InsightProgressData;
}

export function InsightProgress({ progress }: InsightProgressProps) {
  const { stage, progress: percent, detail, isComplete, error } = progress;
  const width = 30;
  const completedWidth = Math.round((percent / 100) * width);
  const remainingWidth = width - completedWidth;
  const bar =
    '█'.repeat(Math.max(0, completedWidth)) +
    '░'.repeat(Math.max(0, remainingWidth));

  if (error) {
    return (
      <div className={`${styles.progress} ${styles.error}`}>
        <span className={styles.icon}>✕</span>
        <span className={styles.stage}>{stage}</span>
        <div className={styles.detail}>{error}</div>
      </div>
    );
  }

  if (isComplete) {
    return (
      <div className={`${styles.progress} ${styles.done}`}>
        <span className={styles.icon}>✓</span>
        <span className={styles.stage}>{stage}</span>
      </div>
    );
  }

  return (
    <div className={styles.progress}>
      <span className={styles.spinner}>⠋</span>
      <span className={styles.bar}>{bar}</span>
      <span className={styles.stage}>
        {stage}
        {detail ? ` (${detail})` : ''}
      </span>
    </div>
  );
}
