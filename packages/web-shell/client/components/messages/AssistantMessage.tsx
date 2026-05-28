import { memo, useContext } from 'react';
import { Markdown } from './Markdown';
import { CompactModeContext } from '../../App';
import styles from './AssistantMessage.module.css';

interface AssistantMessageProps {
  content: string;
  thinking?: string;
}

export const AssistantMessage = memo(function AssistantMessage({
  content,
  thinking,
}: AssistantMessageProps) {
  const compactMode = useContext(CompactModeContext);
  return (
    <div className={styles.message}>
      {thinking && !compactMode && (
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
