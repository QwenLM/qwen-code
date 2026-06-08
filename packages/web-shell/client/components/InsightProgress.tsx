import { useState, useEffect } from 'react';
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

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];

export function InsightProgress({ progress }: InsightProgressProps) {
  const { stage, progress: percent, detail, isComplete, error } = progress;
  const [frame, setFrame] = useState(0);
  const width = 30;
  const completedWidth = Math.round((percent / 100) * width);
  const remainingWidth = width - completedWidth;
  const bar =
    '█'.repeat(Math.max(0, completedWidth)) +
    '░'.repeat(Math.max(0, remainingWidth));

  useEffect(() => {
    if (isComplete || error) return;
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 120);
    return () => clearInterval(id);
  }, [isComplete, error]);

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
      <span className={styles.spinner}>{SPINNER_FRAMES[frame]}</span>
      <span className={styles.bar}>{bar}</span>
      <span className={styles.stage}>
        {stage}
        {detail ? ` (${detail})` : ''}
      </span>
    </div>
  );
}
