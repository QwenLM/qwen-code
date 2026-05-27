import { memo } from 'react';
import {
  ContextUsageMessage,
  parseContextUsageMessage,
} from './ContextUsageMessage';
import { Markdown } from './Markdown';
import styles from './SystemMessage.module.css';

interface SystemMessageProps {
  content: string;
  variant: 'info' | 'error' | 'warning';
}

export const SystemMessage = memo(function SystemMessage({
  content,
  variant,
}: SystemMessageProps) {
  const contextUsage =
    variant === 'info' ? parseContextUsageMessage(content) : null;
  if (contextUsage) {
    return (
      <div className={styles.flushMessage}>
        <ContextUsageMessage status={contextUsage} />
      </div>
    );
  }

  return (
    <div className={`${styles.message} ${styles[variant]}`}>
      {variant === 'info' ? (
        <Markdown content={content} />
      ) : (
        <pre>{content}</pre>
      )}
    </div>
  );
});
