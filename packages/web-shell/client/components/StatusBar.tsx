import { useI18n } from '../i18n';
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
  t: ReturnType<typeof useI18n>['t'],
): { label: string; className: string } | null {
  switch (mode) {
    case 'plan':
      return { label: t('mode.plan'), className: styles.modePlan };
    case 'auto-edit':
      return { label: t('mode.auto-edit'), className: styles.modeAutoEdit };
    case 'yolo':
      return { label: t('mode.yolo'), className: styles.modeYolo };
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
  const { t } = useI18n();
  const pct = contextWindow > 0 ? (tokenCount / contextWindow) * 100 : 0;
  const pctDisplay = pct.toFixed(1);
  const modeIndicator = getModeIndicator(currentMode, t);

  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        {modeIndicator ? (
          <>
            <span className={`${styles.modeLabel} ${modeIndicator.className}`}>
              {modeIndicator.label}
            </span>
            <span className={styles.modeHint}>{t('status.modeHint')}</span>
          </>
        ) : (
          <span>{t('status.shortcuts')}</span>
        )}
      </div>

      <div className={styles.right}>
        {!connected && (
          <span className={styles.disconnected}>
            {t('status.disconnected')}
          </span>
        )}
        {currentModel && <span className={styles.model}>{currentModel}</span>}
        {contextWindow > 0 && tokenCount > 0 && (
          <span className={styles.context}>
            {t('status.contextUsed', { pct: pctDisplay })}
          </span>
        )}
      </div>
    </div>
  );
}
