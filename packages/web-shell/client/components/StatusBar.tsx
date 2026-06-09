import { useConnection } from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../i18n';
import styles from './StatusBar.module.css';

function getModeIndicator(
  mode: string,
  t: ReturnType<typeof useI18n>['t'],
): { label: string; className: string } | null {
  switch (mode) {
    case 'default':
      return { label: t('mode.default'), className: styles.modeDefault };
    case 'plan':
      return { label: t('mode.plan'), className: styles.modePlan };
    case 'auto-edit':
      return { label: t('mode.auto-edit'), className: styles.modeAutoEdit };
    case 'auto':
      return { label: t('mode.auto'), className: styles.modeAuto };
    case 'yolo':
      return { label: t('mode.yolo'), className: styles.modeYolo };
    default:
      // Only reached before a mode is known (e.g. while disconnected).
      return null;
  }
}

interface StatusBarProps {
  /** Open the approval-mode picker so the mode can be chosen with the mouse. */
  onSelectMode: () => void;
}

export function StatusBar({ onSelectMode }: StatusBarProps) {
  const connection = useConnection();
  const connected = connection.status === 'connected';
  const currentModel = connection.currentModel ?? '';
  const currentMode = connection.currentMode ?? '';
  const tokenCount = connection.tokenCount ?? 0;
  const contextWindow = connection.contextWindow ?? 0;
  const { t } = useI18n();
  const pct = contextWindow > 0 ? (tokenCount / contextWindow) * 100 : 0;
  const pctDisplay = pct.toFixed(1);
  const modeIndicator = getModeIndicator(currentMode, t);

  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        {modeIndicator ? (
          // The hint advertises "click to switch", so the indicator is always
          // a real button — never a non-interactive label. stopPropagation on
          // mousedown keeps the trigger from counting as an "outside" press for
          // the picker's own dismiss handler, so re-clicking toggles cleanly.
          <button
            type="button"
            className={styles.modeButton}
            onClick={onSelectMode}
            onMouseDown={(e) => e.stopPropagation()}
            title={t('mode.select')}
          >
            <span className={`${styles.modeLabel} ${modeIndicator.className}`}>
              {modeIndicator.label}
            </span>
            <span className={styles.modeHint}>{t('status.modeHint')}</span>
          </button>
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
