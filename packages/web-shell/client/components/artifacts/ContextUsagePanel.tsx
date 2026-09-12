import { useEffect, useRef, useState } from 'react';
import { RefreshCwIcon } from 'lucide-react';
import type {
  DaemonSessionActions,
  DaemonSessionContextUsageStatus,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { isTransientSessionReadError } from '../../utils/sessionErrors';
import { ContextUsageMessage } from '../messages/ContextUsageMessage';
import { Button } from '../ui/button';
import type { ContextUsageControls } from '../../hooks/useContextUsageControls';
import styles from './ContextUsagePanel.module.css';

interface InFlightRead {
  getContextUsage: DaemonSessionActions['getContextUsage'];
  sessionId: string;
  promise: Promise<DaemonSessionContextUsageStatus>;
}

export function ContextUsagePanel({
  sessionActions,
  sessionId,
  controls,
}: {
  sessionActions?: DaemonSessionActions;
  sessionId: string;
  controls?: ContextUsageControls;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<DaemonSessionContextUsageStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const compressionRevision = useRef(0);
  const refreshRef = useRef<() => void>(() => {});
  // Outlives the effect closure so a StrictMode-replayed mount reuses the
  // in-flight request instead of issuing a second identical collection.
  const inFlightRef = useRef<InFlightRead | null>(null);
  const liveControls = controls?.sessionId === sessionId ? controls : undefined;
  const getContextUsage =
    liveControls?.getContextUsage ?? sessionActions?.getContextUsage;
  const controlsRef = useRef(liveControls);
  controlsRef.current = liveControls;
  const compressionResult = liveControls?.result;
  const [dismissedResult, setDismissedResult] = useState(compressionResult);
  const showCompressionResult = Boolean(
    compressionResult && compressionResult !== dismissedResult,
  );

  useEffect(() => {
    if (compressionResult?.kind === 'completed') {
      compressionRevision.current++;
      setStatus(compressionResult.usage);
      setError(false);
    }
  }, [compressionResult]);

  useEffect(() => {
    let active = true;
    let pending = false;
    setStatus(null);
    setError(false);
    setLoading(Boolean(getContextUsage));

    const refresh = async () => {
      if (!active || pending || !getContextUsage) return;
      pending = true;
      setLoading(true);
      setError(false);
      const revision = compressionRevision.current;
      const inFlight = inFlightRef.current;
      const entry =
        inFlight &&
        inFlight.getContextUsage === getContextUsage &&
        inFlight.sessionId === sessionId
          ? inFlight
          : {
              getContextUsage,
              sessionId,
              promise: getContextUsage({
                detail: true,
                silent: true,
                ...(controlsRef.current?.result?.kind === 'refreshFailed' ||
                controlsRef.current?.result?.kind === 'cancelled'
                  ? { syncCounters: true }
                  : {}),
              }),
            };
      inFlightRef.current = entry;
      try {
        const snapshot = await entry.promise;
        if (!active || revision !== compressionRevision.current) return;
        setStatus(
          snapshot.sessionId === sessionId &&
            snapshot.usage.contextWindowSize > 0
            ? snapshot
            : null,
        );
      } catch (err) {
        if (!active || revision !== compressionRevision.current) return;
        // A failed refresh keeps the last good reading. Transient failures
        // (disconnect, transport close, network blip) are requested silently
        // and stay silent here too, leaving the unavailable copy plus the
        // enabled Refresh as the retry affordance.
        setError(!isTransientSessionReadError(err));
      } finally {
        pending = false;
        if (inFlightRef.current === entry) inFlightRef.current = null;
        if (active) setLoading(false);
      }
    };
    refreshRef.current = () => void refresh();
    void refresh();
    return () => {
      active = false;
    };
  }, [getContextUsage, sessionId]);

  return (
    <div className={styles.panel} aria-busy={loading}>
      <div className={styles.toolbar}>
        <span>{t('contextUsage.title')}</span>
        <div className={styles.actions}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('contextUsage.refresh')}
            title={t('contextUsage.refresh')}
            disabled={!getContextUsage || loading || liveControls?.compressing}
            onClick={() => {
              setDismissedResult(compressionResult);
              refreshRef.current();
            }}
          >
            <RefreshCwIcon aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!liveControls?.canCompress || loading}
            title={
              !liveControls?.canCompress
                ? t('contextUsage.compressUnavailable')
                : undefined
            }
            onClick={() => void liveControls?.compress()}
          >
            {t(
              liveControls?.compressing
                ? 'contextUsage.compressing'
                : 'contextUsage.compress',
            )}
          </Button>
        </div>
      </div>
      {(liveControls?.compressing || showCompressionResult) && (
        <div
          className={styles.feedback}
          role={
            compressionResult?.kind === 'failed' ||
            compressionResult?.kind === 'refreshFailed'
              ? 'alert'
              : 'status'
          }
        >
          {t(
            liveControls?.compressing
              ? 'contextUsage.compressing'
              : compressionResult?.kind === 'completed'
                ? 'contextUsage.compressed'
                : compressionResult?.kind === 'cancelled'
                  ? 'contextUsage.compressCancelled'
                  : compressionResult?.kind === 'refreshFailed'
                    ? 'contextUsage.compressRefreshFailed'
                    : 'contextUsage.compressFailed',
          )}
        </div>
      )}
      {error ? (
        <div className={styles.state} role="alert">
          <span>{t('contextUsage.loadError')}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => refreshRef.current()}
          >
            {t('contextUsage.retry')}
          </Button>
        </div>
      ) : !getContextUsage ? (
        <div className={styles.state}>{t('contextUsage.unavailable')}</div>
      ) : loading && !status ? (
        <div className={styles.state} role="status">
          {t('common.loading')}
        </div>
      ) : status ? (
        <ContextUsageMessage status={status} compact />
      ) : (
        <div className={styles.state}>{t('contextUsage.unavailable')}</div>
      )}
    </div>
  );
}
