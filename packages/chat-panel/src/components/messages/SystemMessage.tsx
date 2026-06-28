import { memo } from 'react';
import { useI18n } from '../../i18n';
import { useChatPanelCustomization } from '../../customization';
import { Markdown } from '../../markdown';
import styles from './SystemMessage.module.css';

interface SystemMessageProps {
  content: string;
  variant: 'info' | 'error' | 'warning';
  source?: string;
  data?: unknown;
  /** Run /context detail, exactly like typing it (context-usage panels). */
  onShowContextDetail?: () => void;
  isLatest?: boolean;
  showRetryHint?: boolean;
  onRetryClick?: () => void;
}

function SystemMessageComponent({
  content,
  variant,
  source,
  data,
  onShowContextDetail,
  isLatest = false,
  showRetryHint = false,
  onRetryClick,
}: SystemMessageProps) {
  const { t } = useI18n();
  const { renderSystemMessage } = useChatPanelCustomization();

  // Slash-command / session-control panels (/stats, /mcp, context usage, …) are
  // host-specific and live outside the panel; the host renders them through this
  // seam, returning `null` for anything the panel should render generically.
  const hostRendered = renderSystemMessage?.({
    content,
    variant,
    source,
    data,
    isLatest,
    onShowContextDetail,
  });
  if (hostRendered != null) {
    return <div className={styles.flushMessage}>{hostRendered}</div>;
  }

  const preserveWhitespace =
    variant === 'info' && content.startsWith('● authType:');

  return (
    <div
      className={`${styles.message} ${styles[variant]} ${
        preserveWhitespace ? styles.modelSwitch : ''
      }`}
    >
      {preserveWhitespace ? (
        <pre>{content}</pre>
      ) : variant === 'info' ? (
        <Markdown content={content} />
      ) : (
        <pre>{content}</pre>
      )}
      {showRetryHint && onRetryClick && (
        <div className={styles.retryHint}>
          <button
            type="button"
            className={styles.retryButton}
            onClick={onRetryClick}
          >
            {t('retry.hint')}
          </button>
        </div>
      )}
    </div>
  );
}

export const SystemMessage = memo(SystemMessageComponent);
