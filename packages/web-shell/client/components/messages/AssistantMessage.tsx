import { memo } from 'react';
import { Markdown } from './Markdown';
import styles from './AssistantMessage.module.css';

interface AssistantMessageProps {
  content: string;
  thinking?: string;
}

export const AssistantMessage = memo(function AssistantMessage({
  content,
  thinking,
}: AssistantMessageProps) {
  return (
    <div className={styles.message}>
      {thinking && (
        <div className={styles.thinking}>
          <span className={styles.prefix}>✦</span>
          <pre>{thinking}</pre>
        </div>
      )}

      {content && (
        <div className={styles.content}>
          <span className={styles.prefix}>✦</span>
          <div className={styles.contentBody}>
            <Markdown content={content} />
          </div>
        </div>
      )}
    </div>
  );
});
