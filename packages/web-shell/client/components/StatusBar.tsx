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
  escapeHint?: boolean;
  /** Open the approval-mode picker so the mode can be chosen with the mouse. */
  onSelectMode: () => void;
  /** Open the model picker so the model can be chosen with the mouse. */
  onSelectModel: () => void;
  /** Show the context-usage breakdown, exactly like typing /context. */
  onShowContext: () => void;
  /** Open the inline settings panel so settings are reachable with the mouse. */
  onOpenSettings: () => void;
}

// Feather "settings" gear, stroke-based like PromptChevron so it inherits
// the button's currentColor.
function GearIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function StatusBar({
  escapeHint,
  onSelectMode,
  onSelectModel,
  onShowContext,
  onOpenSettings,
}: StatusBarProps) {
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
        {connected && (
          // Anchored at the corner, outside the escape-hint swap below, so
          // the settings entry never moves. Hidden while disconnected like
          // every other control here — the panel needs the daemon to load
          // settings. Same stopPropagation contract as the mode button: the
          // settings panel dismisses on outside mousedown/touchstart, so the
          // opening press must not reach the window or clicking the gear
          // again could never toggle the panel closed.
          <button
            type="button"
            className={styles.settingsButton}
            onClick={onOpenSettings}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            title={t('settings.title')}
            aria-label={t('settings.title')}
            aria-haspopup="dialog"
          >
            <GearIcon />
          </button>
        )}
        {escapeHint ? (
          <span className={styles.escapeHint}>{t('editor.escClearHint')}</span>
        ) : modeIndicator ? (
          // The hint advertises "click to switch", so the indicator is always
          // a real button — never a non-interactive label. stopPropagation on
          // both mousedown and touchstart keeps the trigger from counting as an
          // "outside" press for the picker's own dismiss handler (it listens on
          // exactly those two), so re-activating toggles cleanly on mouse and
          // touch alike.
          <button
            type="button"
            className={styles.modeButton}
            onClick={onSelectMode}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            title={t('mode.select')}
            aria-haspopup="listbox"
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
        {currentModel && (
          // Mirrors the mode indicator on the left: the model label is a
          // button that opens the existing model picker. stopPropagation on
          // mousedown/touchstart keeps the opening press from counting as an
          // "outside" press for the picker's own dismiss handler.
          <button
            type="button"
            className={styles.modelButton}
            onClick={onSelectModel}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            title={t('model.select')}
            aria-haspopup="listbox"
          >
            <span className={styles.model}>{currentModel}</span>
          </button>
        )}
        {contextWindow > 0 && tokenCount > 0 && (
          // Clicking the percentage runs the same flow as typing /context:
          // it echoes the command and appends the usage breakdown to the
          // transcript. No stopPropagation here — unlike the mode/model
          // buttons this opens no picker, and if one is open the press
          // should dismiss it like any other outside press.
          <button
            type="button"
            className={styles.contextButton}
            onClick={onShowContext}
            title={t('contextUsage.title')}
          >
            <span className={styles.context}>
              {t('status.contextUsed', { pct: pctDisplay })}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
