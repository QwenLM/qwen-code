import { memo } from 'react';
import { useI18n } from '../../i18n';
import styles from './UserShellMessage.module.css';

interface UserShellMessageProps {
  command: string;
  output: string;
}

export const UserShellMessage = memo(function UserShellMessage({
  command,
  output,
}: UserShellMessageProps) {
  const { t } = useI18n();

  return (
    <div className={styles.message}>
      <div className={styles.header}>
        <span className={styles.status}>✓</span>
        <span className={styles.name}>{t('shell.command')}</span>
        {command && <span className={styles.command}>{command}</span>}
      </div>
      {output && <pre className={styles.output}>{output}</pre>}
    </div>
  );
});
