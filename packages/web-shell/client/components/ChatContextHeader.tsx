import type { ReactNode } from 'react';
import { LayoutListIcon, PanelRightIcon } from 'lucide-react';
import { useI18n } from '../i18n';
import styles from './ChatContextHeader.module.css';

interface ChatContextHeaderProps {
  content: ReactNode;
  environmentOpen: boolean;
  environmentAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelAvailable: boolean;
  onToggleEnvironment: () => void;
  onToggleRightPanel: () => void;
}

export function ChatContextHeader({
  content,
  environmentOpen,
  environmentAvailable,
  rightPanelOpen,
  rightPanelAvailable,
  onToggleEnvironment,
  onToggleRightPanel,
}: ChatContextHeaderProps) {
  const { t } = useI18n();

  return (
    <header className={styles.header} data-testid="chat-context-header">
      <div className={styles.content}>{content}</div>
      <div className={styles.actions}>
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
