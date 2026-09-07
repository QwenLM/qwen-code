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
import styles from './ContextUsagePanel.module.css';

interface InFlightRead {
  actions: DaemonSessionActions;
  sessionId: string;
  promise: Promise<DaemonSessionContextUsageStatus>;
}

export function ContextUsagePanel({
  sessionActions,
  sessionId,
}: {
  sessionActions?: DaemonSessionActions;
  sessionId: string;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<DaemonSessionContextUsageStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const refreshRef = useRef<() => void>(() => {});
  // Outlives the effect closure so a StrictMode-replayed mount reuses the
  // in-flight request instead of issuing a second identical collection.
  const inFlightRef = useRef<InFlightRead | null>(null);

  useEffect(() => {
    let active = true;
    let pending = false;
    setStatus(null);
    setError(false);
    setLoading(Boolean(sessionActions));

    const refresh = async () => {
      if (!active || pending || !sessionActions) return;
      pending = true;
      setLoading(true);
      setError(false);
      const inFlight = inFlightRef.current;
      const entry =
        inFlight &&
        inFlight.actions === sessionActions &&
        inFlight.sessionId === sessionId
          ? inFlight
          : {
              actions: sessionActions,
              sessionId,
              promise: sessionActions.getContextUsage({
                detail: true,
                silent: true,
              }),
            };
      inFlightRef.current = entry;
      try {
        const snapshot = await entry.promise;
        if (!active) return;
        setStatus(
          snapshot.sessionId === sessionId &&
            snapshot.usage.contextWindowSize > 0
            ? snapshot
            : null,
        );
      } catch (err) {
        if (!active) return;
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
  }, [sessionActions, sessionId]);

  return (
    <div className={styles.panel} aria-busy={loading}>
      <div className={styles.toolbar}>
        <span>{t('contextUsage.title')}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('contextUsage.refresh')}
          title={t('contextUsage.refresh')}
          disabled={!sessionActions || loading}
          onClick={() => refreshRef.current()}
        >
          <RefreshCwIcon aria-hidden="true" />
        </Button>
      </div>
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
      ) : !sessionActions ? (
        <div className={styles.state}>{t('contextUsage.unavailable')}</div>
      ) : loading && !status ? (
        <div className={styles.state} role="status">
          {t('common.loading')}
        </div>
      ) : status ? (
        <ContextUsageMessage
          status={status}
          compact
          detailNameMaxLen={Infinity}
        />
      ) : (
        <div className={styles.state}>{t('contextUsage.unavailable')}</div>
      )}
    </div>
  );
}
