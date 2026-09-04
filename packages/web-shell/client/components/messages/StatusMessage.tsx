import { useI18n } from '../../i18n';
import { createSentinelSerializer } from '../../utils/sentinelMessage';
import styles from './StatusMessage.module.css';

export interface StatusInfo {
  cliVersion: string;
  runtime: string;
  platform: string;
  auth: string;
  baseUrl: string;
  model: string;
  fastModel: string;
  sessionId: string;
  sandbox: string;
  proxy: string;
  memoryUsage: string;
}

const { serialize: serializeStatusMessage, parse: parseStatusMessage } =
  createSentinelSerializer<StatusInfo>('web-shell:status:v1:');

export { serializeStatusMessage, parseStatusMessage };

function Row({
  label,
  children,
  gap,
}: {
  label: string;
  children: React.ReactNode;
  gap?: boolean;
}) {
  return (
    <div className={`${styles.row}${gap ? ` ${styles.rowGap}` : ''}`}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{children}</span>
    </div>
  );
}

export function StatusMessage({ info }: { info: StatusInfo }) {
  const { t } = useI18n();

  return (
    <div className={styles.panel}>
      <div className={styles.title}>{t('about.title')}</div>
      {info.cliVersion && (
        <Row label={t('about.qwenCode')}>
          <span className={styles.accent}>{info.cliVersion}</span>
        </Row>
      )}
      {info.runtime && <Row label={t('about.runtime')}>{info.runtime}</Row>}
      {info.platform && <Row label={t('about.platform')}>{info.platform}</Row>}
      {info.auth && (
        <Row label={t('about.auth')} gap>
          {info.auth}
        </Row>
      )}
      {info.baseUrl && <Row label={t('about.baseUrl')}>{info.baseUrl}</Row>}
      {info.model && <Row label={t('about.model')}>{info.model}</Row>}
      {info.fastModel && info.fastModel !== info.model && (
        <Row label={t('about.fastModel')}>{info.fastModel}</Row>
      )}
      {info.sessionId && (
        <Row label={t('about.sessionId')}>{info.sessionId}</Row>
      )}
      <Row label={t('about.sandbox')}>
        {info.sandbox || t('about.noSandbox')}
      </Row>
      <Row label={t('about.proxy')}>{info.proxy || t('about.noProxy')}</Row>
      {info.memoryUsage && (
        <Row label={t('about.memoryUsage')}>{info.memoryUsage}</Row>
      )}
    </div>
  );
}
