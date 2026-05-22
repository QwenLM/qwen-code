import styles from './StatusBar.module.css';

interface StatusBarProps {
  connected: boolean;
  streamingState: 'idle' | 'waiting' | 'responding' | 'thinking';
  currentModel: string;
  currentMode: string;
  tokenCount: number;
  contextWindow: number;
}

function getModeIndicator(
  mode: string,
): { label: string; className: string } | null {
  switch (mode) {
    case 'plan':
      return { label: 'plan mode', className: styles.modePlan };
    case 'auto-edit':
      return { label: 'auto-accept edits', className: styles.modeAutoEdit };
    case 'yolo':
      return { label: 'YOLO mode', className: styles.modeYolo };
    default:
      return null;
  }
}

export function StatusBar({
  connected,
  currentModel,
  currentMode,
  tokenCount,
  contextWindow,
}: StatusBarProps) {
  const pct = contextWindow > 0 ? (tokenCount / contextWindow) * 100 : 0;
  const pctDisplay = pct.toFixed(1);
  const modeIndicator = getModeIndicator(currentMode);

  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        {modeIndicator ? (
          <>
            <span className={`${styles.modeLabel} ${modeIndicator.className}`}>
              {modeIndicator.label}
            </span>
            <span className={styles.modeHint}>(shift + tab to cycle)</span>
          </>
        ) : (
          <span>? for shortcuts</span>
        )}
      </div>

      <div className={styles.right}>
        {!connected && <span className={styles.disconnected}>断开连接</span>}
        {currentModel && <span className={styles.model}>{currentModel}</span>}
        {contextWindow > 0 && tokenCount > 0 && (
          <span className={styles.context}>{pctDisplay}% 上下文已用</span>
        )}
      </div>
    </div>
  );
}
