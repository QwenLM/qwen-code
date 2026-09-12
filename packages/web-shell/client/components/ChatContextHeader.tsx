import type { ReactNode } from 'react';
import {
  GaugeIcon,
  LayoutListIcon,
  LayersIcon,
  PanelRightIcon,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { LocalControlQrButton } from './LocalControlQrButton';
import styles from './ChatContextHeader.module.css';

interface ChatContextHeaderProps {
  content: ReactNode;
  environmentOpen: boolean;
  environmentAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelAvailable: boolean;
  onToggleEnvironment: () => void;
  onToggleRightPanel: () => void;
  /** Opens the session token-usage panel; hidden when omitted. */
  onOpenTokenUsage?: () => void;
  /** Opens the session context panel; hidden when omitted. */
  onOpenContextUsage?: () => void;
  /** Shows the Local Control QR entry; hidden when omitted. */
  onOpenLocalControlSettings?: () => void;
}

export function ChatContextHeader({
  content,
  environmentOpen,
  environmentAvailable,
  rightPanelOpen,
  rightPanelAvailable,
  onToggleEnvironment,
  onToggleRightPanel,
  onOpenTokenUsage,
  onOpenContextUsage,
  onOpenLocalControlSettings,
}: ChatContextHeaderProps) {
  const { t } = useI18n();

  return (
    <header className={styles.header} data-testid="chat-context-header">
      <div className={styles.content}>{content}</div>
      <div className={styles.actions}>
        {onOpenLocalControlSettings && (
          <LocalControlQrButton
            onOpenSettings={onOpenLocalControlSettings}
            className={styles.action}
          />
        )}
        {environmentAvailable && (
          <button
            type="button"
            className={styles.action}
            data-web-shell-environment-toggle
            aria-label={t('chatHeader.toggleEnvironment')}
            aria-pressed={environmentOpen}
            title={t('chatHeader.toggleEnvironment')}
            onClick={onToggleEnvironment}
          >
            <LayoutListIcon />
          </button>
        )}
        {onOpenContextUsage && (
          <button
            type="button"
            className={styles.action}
            aria-label={t('contextUsage.title')}
            title={t('contextUsage.title')}
            onClick={onOpenContextUsage}
          >
            <LayersIcon />
          </button>
        )}
        {onOpenTokenUsage && (
          <button
            type="button"
            className={styles.action}
            aria-label={t('tokenUsage.open')}
            title={t('tokenUsage.open')}
            onClick={onOpenTokenUsage}
          >
            <GaugeIcon />
          </button>
        )}
        {rightPanelAvailable && (
          <button
            type="button"
            className={styles.action}
            aria-label={t('chatHeader.toggleRightPanel')}
            aria-pressed={rightPanelOpen}
            title={t('chatHeader.toggleRightPanel')}
            onClick={onToggleRightPanel}
          >
            <PanelRightIcon />
          </button>
        )}
      </div>
    </header>
  );
}
