import { useEffect, useRef, useState } from 'react';
import {
  useActions,
  useConnection,
  useDaemonSessionOwnerGuard,
  useStreamingState,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../i18n';
import { Button } from './ui/button';

export function SessionRecoveryBanner({
  blocked = false,
}: {
  blocked?: boolean;
}) {
  const connection = useConnection();
  const actions = useActions();
  const ownerGuard = useDaemonSessionOwnerGuard();
  const streamingState = useStreamingState();
  const { t } = useI18n();
  const pendingRef = useRef<ReturnType<typeof ownerGuard.capture> | null>(null);
  const [pending, setPending] = useState(false);
  const [failedOwner, setFailedOwner] = useState<ReturnType<
    typeof ownerGuard.capture
  > | null>(null);
  const failed = failedOwner?.isCurrent() === true;
  const recovery = connection.context?.recovery;

  useEffect(() => {
    pendingRef.current = null;
    setPending(false);
    setFailedOwner(null);
  }, [connection.sessionId, connection.workspaceCwd]);

  useEffect(() => {
    if (streamingState !== 'idle') setFailedOwner(null);
  }, [streamingState]);

  if (
    blocked ||
    connection.status !== 'connected' ||
    connection.loadingTranscript ||
    connection.catchingUp ||
    !connection.sessionId ||
    connection.context?.sessionId !== connection.sessionId ||
    streamingState !== 'idle' ||
    (!failed &&
      (!recovery ||
        recovery.kind === 'clean' ||
        (!recovery.canContinue && recovery.kind !== 'degraded_history')))
  ) {
    return null;
  }

  const continueSession = async () => {
    if (pendingRef.current) return;
    const owner = ownerGuard.capture();
    pendingRef.current = owner;
    setPending(true);
    setFailedOwner(null);
    try {
      await actions.continueSession();
    } catch {
      if (owner.isCurrent()) {
        setFailedOwner(ownerGuard.capture({ includeRecovery: true }));
      }
    } finally {
      if (pendingRef.current === owner) {
        pendingRef.current = null;
        setPending(false);
      }
    }
  };

  return (
    <div
      className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground"
      role="status"
      data-testid="session-recovery-banner"
    >
      <div>
        {recovery && recovery.kind !== 'clean' && (
          <p>{t(`session.recovery.${recovery.kind}`)}</p>
        )}
        {failed && <p role="alert">{t('session.recovery.failed')}</p>}
      </div>
      {recovery?.canContinue && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => void continueSession()}
        >
          {t(
            pending
              ? 'session.recovery.continuing'
              : 'session.recovery.continue',
          )}
        </Button>
      )}
    </div>
  );
}
