import { memo } from 'react';
import styles from './SystemMessage.module.css';

interface SystemMessageProps {
  content: string;
  variant: 'info' | 'error' | 'warning';
}

export const SystemMessage = memo(function SystemMessage({
  content,
  variant,
}: SystemMessageProps) {
  return (
    <div className={`${styles.message} ${styles[variant]}`}>
      <pre>{content}</pre>
    </div>
  );
});
