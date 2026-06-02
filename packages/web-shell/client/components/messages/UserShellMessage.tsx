import { memo, useContext } from 'react';
import { CompactModeContext } from '../../App';
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
  const compactMode = useContext(CompactModeContext);
  const { t } = useI18n();

  return (
    <div
      className={
        compactMode ? `${styles.message} ${styles.compact}` : styles.message
      }
    >
      <div className={styles.header}>
        <span className={styles.status}>✓</span>
        <span className={styles.name}>Shell Command</span>
        {command && <span className={styles.command}>{command}</span>}
      </div>
      {compactMode ? (
        <div className={styles.compactHint}>{t('compact.hint')}</div>
      ) : (
        output && <pre className={styles.output}>{output}</pre>
      )}
    </div>
  );
});
