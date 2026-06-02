import { useI18n } from '../../i18n';
import styles from './StatusMessage.module.css';

const SENTINEL = 'web-shell:status:v1:';

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

export function serializeStatusMessage(info: StatusInfo): string {
  return `${SENTINEL}${JSON.stringify(info)}`;
}

export function parseStatusMessage(content: string): StatusInfo | null {
  if (!content.startsWith(SENTINEL)) return null;
  try {
    const parsed = JSON.parse(content.slice(SENTINEL.length));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as StatusInfo;
  } catch {
    return null;
  }
}

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
      {info.fastModel && (
        <Row label={t('about.fastModel')}>{info.fastModel}</Row>
      )}
      {info.sessionId && (
        <Row label={t('about.sessionId')}>{info.sessionId}</Row>
      )}
      {info.sandbox && <Row label={t('about.sandbox')}>{info.sandbox}</Row>}
      {info.proxy && <Row label={t('about.proxy')}>{info.proxy}</Row>}
      {info.memoryUsage && (
        <Row label={t('about.memoryUsage')}>{info.memoryUsage}</Row>
      )}
    </div>
  );
}
