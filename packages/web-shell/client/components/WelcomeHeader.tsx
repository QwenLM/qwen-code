import { useI18n } from '../i18n';
import styles from './WelcomeHeader.module.css';

export interface WelcomeHeaderProps {
  version: string;
  cwd: string;
  currentModel: string;
  currentMode: string;
  hideTips?: boolean;
}

export function WelcomeHeader(props: WelcomeHeaderProps) {
  void props;
  const { t } = useI18n();

  return (
    <div className={styles.header}>
      <div className={styles.titleRow}>
        <span>{t('welcome.titlePrefix')}</span>
        <span className={styles.title}>Qwen Code</span>
      </div>
      <div className={styles.subtitle}>{t('welcome.prompt')}</div>
    </div>
  );
}
