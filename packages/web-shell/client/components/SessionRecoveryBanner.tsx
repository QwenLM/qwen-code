import { isDaemonTurnError } from '@qwen-code/sdk/daemon';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useActions,
  useConnection,
  useDaemonSessionOwnerGuard,
  useStreamingState,
  useTranscriptBlocks,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../i18n';
import {
  isRecoveryRateLimit,
  recoveryRetryAt,
} from '../utils/session-recovery-rate-limit';
import { Button } from './ui/button';

const MAX_WAIT_MS = 6 * 60 * 60 * 1000;
const MAX_DELAY_MS = 5 * 60 * 1000;

export function SessionRecoveryBanner({
  blocked = false,
}: {
  blocked?: boolean;
}) {
  const connection = useConnection();
  const actions = useActions();
  const ownerGuard = useDaemonSessionOwnerGuard();
  const streamingState = useStreamingState();
  const blocks = useTranscriptBlocks();
  const { t } = useI18n();
  const pendingRef = useRef<ReturnType<typeof ownerGuard.capture> | null>(null);
  const [pending, setPending] = useState(false);
  const [failedOwner, setFailedOwner] = useState<ReturnType<
    typeof ownerGuard.capture
  > | null>(null);
  const failed = failedOwner?.isCurrent() === true;
  const recovery = connection.context?.recovery;
  const rateLimit = useMemo(() => {
    for (let index = blocks.length - 1; index >= 0; index--) {
      const block = blocks[index];
      if (block.kind === 'debug' || block.kind === 'status') continue;
      return block.kind === 'error' &&
        block.source === 'turn_error' &&
        isRecoveryRateLimit(block.text, block.code)
        ? block
        : undefined;
    }
    return undefined;
  }, [blocks]);
  type Wait = {
    owner: ReturnType<typeof ownerGuard.capture>;
    recoveryOwner: ReturnType<typeof ownerGuard.capture>;
    model: string | undefined;
    deadline: number;
    delay: number;
    retryAt: number;
    errorId: string;
    phase: 'scheduled' | 'attempting' | 'recovering';
  };
  const waitRef = useRef<Wait | null>(null);
  const [wait, setWait] = useState<Wait | null>(null);
  const [expired, setExpired] = useState(false);
  const updateWait = useCallback((value: Wait | null) => {
    waitRef.current = value;
    setWait(value);
  }, []);
  const ready =
    !blocked &&
    connection.status === 'connected' &&
    !connection.loadingTranscript &&
    !connection.catchingUp &&
    !!connection.sessionId &&
    connection.context?.sessionId === connection.sessionId &&
    streamingState === 'idle';

  const continueSession = useCallback(
    async (automatic = false) => {
      if (pendingRef.current) return;
      if (!automatic) updateWait(null);
      const attempt = waitRef.current;
      const owner = ownerGuard.capture();
      pendingRef.current = owner;
      setPending(true);
      setFailedOwner(null);
      setExpired(false);
      try {
        await actions.continueSession();
        if (waitRef.current === attempt) updateWait(null);
      } catch (error) {
        if (
          automatic &&
          attempt &&
          waitRef.current === attempt &&
          owner.isCurrent() &&
          isDaemonTurnError(error) &&
          isRecoveryRateLimit(
            error.message,
            typeof error.body === 'string' ? error.body : undefined,
          )
        ) {
          const delay = Math.min(attempt.delay * 2, MAX_DELAY_MS);
          updateWait({
            ...attempt,
            phase: 'recovering',
            recoveryOwner: ownerGuard.capture({ includeRecovery: true }),
            delay,
            retryAt: recoveryRetryAt(error.message, Date.now(), delay),
          });
          return;
        }
        if (waitRef.current === attempt) updateWait(null);
        if (isDaemonTurnError(error)) return;
        if (owner.isCurrent()) {
          setFailedOwner(ownerGuard.capture({ includeRecovery: true }));
        }
      } finally {
        if (pendingRef.current === owner) {
          pendingRef.current = null;
          setPending(false);
        }
      }
    },
    [actions, ownerGuard, updateWait],
  );

  useEffect(() => {
    pendingRef.current = null;
    setPending(false);
    setFailedOwner(null);
    updateWait(null);
    setExpired(false);
  }, [connection.sessionId, connection.workspaceCwd, updateWait]);

  useEffect(
    () => () => {
      waitRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (streamingState !== 'idle') setFailedOwner(null);
  }, [streamingState]);

  useEffect(() => {
    if (!wait) return;
    if (
      !wait.owner.isCurrent() ||
      wait.model !== connection.currentModel ||
      connection.status !== 'connected' ||
      recovery?.kind === 'clean' ||
      recovery?.kind === 'degraded_history' ||
      (wait.phase === 'recovering' && !wait.recoveryOwner.isCurrent()) ||
      (wait.phase !== 'attempting' && !ready)
    ) {
      updateWait(null);
      return;
    }
    if (Date.now() >= wait.deadline) {
      updateWait(null);
      setExpired(true);
      return;
    }
    if (wait.phase === 'scheduled') {
      if (
        !wait.recoveryOwner.isCurrent() ||
        !recovery?.canContinue ||
        rateLimit?.id !== wait.errorId
      ) {
        updateWait(null);
        return;
      }
    } else if (wait.phase === 'recovering' && recovery?.canContinue) {
      if (!rateLimit || rateLimit.id === wait.errorId) {
        updateWait(null);
        return;
      }
      updateWait({
        ...wait,
        phase: 'scheduled',
        errorId: rateLimit.id,
        recoveryOwner: ownerGuard.capture({ includeRecovery: true }),
      });
      return;
    }
    const timer = setTimeout(
      () => {
        if (waitRef.current !== wait) return;
        if (Date.now() >= wait.deadline) {
          updateWait(null);
          setExpired(true);
        } else if (wait.phase === 'scheduled') {
          if (!wait.recoveryOwner.isCurrent()) {
            updateWait(null);
            return;
          }
          updateWait({ ...wait, phase: 'attempting' });
          void continueSession(true);
        }
      },
      Math.max(
        0,
        Math.min(
          wait.phase === 'scheduled' ? wait.retryAt : wait.deadline,
          wait.deadline,
        ) - Date.now(),
      ),
    );
    return () => clearTimeout(timer);
  }, [
    wait,
    connection,
    ready,
    recovery,
    rateLimit,
    ownerGuard,
    continueSession,
    updateWait,
  ]);

  if (
    !ready ||
    (!failed &&
      !wait &&
      (!recovery ||
        recovery.kind === 'clean' ||
        (!recovery.canContinue && recovery.kind !== 'degraded_history')))
  ) {
    return null;
  }

  return (
    <div
      className="mb-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground"
      role="status"
      data-testid="session-recovery-banner"
    >
      <div>
        {recovery && recovery.kind !== 'clean' && (
          <p>{t(`session.recovery.${recovery.kind}`)}</p>
        )}
        {failed && <p role="alert">{t('session.recovery.failed')}</p>}
        {wait && (
          <p>
            {t('session.recovery.waiting', {
              time: new Date(wait.retryAt).toLocaleString(),
            })}
          </p>
        )}
        {expired && <p role="alert">{t('session.recovery.waitExpired')}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
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
        {(wait || (rateLimit && recovery?.canContinue)) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => {
              if (waitRef.current) {
                updateWait(null);
                return;
              }
              const now = Date.now();
              if (!rateLimit || !recovery?.canContinue || pendingRef.current)
                return;
              setExpired(false);
              updateWait({
                owner: ownerGuard.capture(),
                recoveryOwner: ownerGuard.capture({ includeRecovery: true }),
                model: connection.currentModel,
                deadline: now + MAX_WAIT_MS,
                delay: 60_000,
                retryAt: recoveryRetryAt(rateLimit.text, now, 60_000),
                errorId: rateLimit.id,
                phase: 'scheduled',
              });
            }}
          >
            {t(
              wait
                ? 'session.recovery.cancelWait'
                : 'session.recovery.resumeWhenAvailable',
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
