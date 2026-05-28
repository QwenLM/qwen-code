import { memo } from 'react';
import { PromptChevron } from '../PromptChevron';
import styles from './UserMessage.module.css';

interface UserMessageProps {
  content: string;
}

export const UserMessage = memo(function UserMessage({
  content,
}: UserMessageProps) {
  return (
    <div className={styles.message}>
      <span className={styles.prefix}>
        <PromptChevron />
      </span>
      <span className={styles.body}>{content}</span>
    </div>
  );
});
