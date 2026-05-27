import { memo } from 'react';
import styles from './UserMessage.module.css';

interface UserMessageProps {
  content: string;
}

export const UserMessage = memo(function UserMessage({
  content,
}: UserMessageProps) {
  return (
    <div className={styles.message}>
      <span className={styles.prefix}>&gt;</span>
      <span className={styles.body}>{content}</span>
    </div>
  );
});
