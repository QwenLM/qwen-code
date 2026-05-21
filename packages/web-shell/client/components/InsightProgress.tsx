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
      <div className="insight-progress insight-progress-error">
        <span className="insight-progress-icon">✕</span>
        <span className="insight-progress-stage">{stage}</span>
        <div className="insight-progress-detail">{error}</div>
      </div>
    );
  }

  if (isComplete) {
    return (
      <div className="insight-progress insight-progress-done">
        <span className="insight-progress-icon">✓</span>
        <span className="insight-progress-stage">{stage}</span>
      </div>
    );
  }

  return (
    <div className="insight-progress">
      <span className="insight-progress-spinner">⠋</span>
      <span className="insight-progress-bar">{bar}</span>
      <span className="insight-progress-stage">
        {stage}
        {detail ? ` (${detail})` : ''}
      </span>
    </div>
  );
}
