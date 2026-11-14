import { useBrandName } from '../brandContext';
import { useI18n } from '../i18n';
import styles from './WelcomeHeader.module.css';

export interface WelcomeHeaderProps {
  version: string;
  /**
   * Workspace directory shown to the user. The ordinary shell fills this with
   * the daemon's absolute `connection.workspaceCwd`; managed surfaces only
   * have a workspace-relative path (`summary.workspace.cwdRelative`, `''`
   * before a session exists), so host renderers must not assume an absolute
   * value on every surface.
   */
  cwd: string;
  currentModel: string;
  currentMode: string;
  /** Ordinary shell only; managed surfaces never set this flag. */
  hideTips?: boolean;
}

export function WelcomeHeader(props: WelcomeHeaderProps) {
  void props;
  const { t } = useI18n();
  const brandName = useBrandName();

  return (
    <div className={styles.header} data-welcome-header="">
      <div className={styles.titleRow}>
        <span>{t('welcome.titlePrefix')}</span>
        <span className={styles.title}>{brandName}</span>
      </div>
      <div className={styles.subtitle}>{t('welcome.prompt')}</div>
    </div>
  );
}
