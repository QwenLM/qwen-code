import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  McpAppMessageRequest,
  McpAppMessages,
} from '../mcpAppHostContext';
import type { DaemonSessionOwnerSnapshot } from '../daemon/session/types';
import {
  isMcpAppPromptAdmissionRejected,
  PromptDispatchCancelledError,
} from '../utils/promptAdmission';
import { useI18n } from '../i18n';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';

export interface McpAppPromptSubmission {
  signal: AbortSignal;
  isCurrent(): boolean;
  onDispatched(): void;
  onAdmitted(admission: { promptId: string }): void;
}

interface MessageHost {
  enabled: boolean;
  sessionId?: string;
  clientId?: string;
  captureOwner(): DaemonSessionOwnerSnapshot;
  submit(text: string, options: McpAppPromptSubmission): Promise<unknown>;
}

type Phase =
  | 'reviewing'
  | 'preparing'
  | 'dispatched'
  | 'accepted'
  | 'cancelled'
  | 'expired'
  | 'failed'
  | 'unknown';

interface Review extends McpAppMessageRequest {
  sessionId: string;
  clientId: string;
  phase: Phase;
  promptId?: string;
  error?: string;
}

interface Pending extends Review {
  controller: AbortController;
  owner: DaemonSessionOwnerSnapshot;
  finish(phase: Phase, error?: string): void;
  settle(): void;
  startTimeout(): void;
  cleanup(): void;
}

function isPending(phase: Phase): boolean {
  return ['reviewing', 'preparing', 'dispatched'].includes(phase);
}

export function useMcpAppMessages(host: MessageHost) {
  const hostRef = useRef(host);
  hostRef.current = host;
  const pendingRef = useRef<Pending | undefined>(undefined);
  const mountedRef = useRef(true);
  const [review, setReview] = useState<Review>();

  const isOwnerCurrent = useCallback((request: Pending) => {
    const current = hostRef.current;
    return (
      mountedRef.current &&
      current.enabled &&
      current.sessionId === request.sessionId &&
      current.clientId === request.clientId &&
      request.owner.isCurrent()
    );
  }, []);

  const requestMessage = useCallback(
    (
      input: McpAppMessageRequest,
    ): ReturnType<McpAppMessages['requestMessage']> => {
      const current = hostRef.current;
      const previous = pendingRef.current;
      if (
        !mountedRef.current ||
        !current.enabled ||
        !current.sessionId ||
        !current.clientId ||
        input.signal.aborted ||
        (previous &&
          (isPending(previous.phase) || previous.phase === 'unknown'))
      ) {
        return Promise.resolve({ isError: true });
      }
      return new Promise((resolve) => {
        const controller = new AbortController();
        const signal = AbortSignal.any([input.signal, controller.signal]);
        const abort = () => {
          request.finish(
            request.phase === 'dispatched' || request.phase === 'unknown'
              ? 'unknown'
              : 'cancelled',
          );
          request.settle();
        };
        let timeout: ReturnType<typeof setTimeout>;
        const request: Pending = {
          ...input,
          signal,
          controller,
          sessionId: current.sessionId!,
          clientId: current.clientId!,
          owner: current.captureOwner(),
          phase: 'reviewing',
          startTimeout: () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
              request.finish(
                request.phase === 'dispatched' ? 'unknown' : 'expired',
              );
              controller.abort();
            }, 90_000);
          },
          cleanup: () => {
            clearTimeout(timeout);
            input.signal.removeEventListener('abort', abort);
          },
          settle: () => {
            request.cleanup();
            resolve(request.phase === 'accepted' ? {} : { isError: true });
          },
          finish: (phase, error) => {
            if (!isPending(request.phase) && request.phase !== 'unknown')
              return;
            clearTimeout(timeout);
            request.phase = phase;
            request.error = error;
            if (mountedRef.current && pendingRef.current === request) {
              setReview({ ...request });
            }
            if (phase !== 'unknown') request.settle();
          },
        };
        pendingRef.current = request;
        request.startTimeout();
        input.signal.addEventListener('abort', abort, { once: true });
        if (!isOwnerCurrent(request)) {
          request.finish('cancelled');
          controller.abort();
          return;
        }
        setReview({ ...request });
      });
    },
    [isOwnerCurrent],
  );

  useEffect(() => {
    const request = pendingRef.current;
    if (request && isPending(request.phase) && !isOwnerCurrent(request)) {
      request.finish(request.phase === 'dispatched' ? 'unknown' : 'cancelled');
      request.controller.abort();
    }
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const request = pendingRef.current;
      if (request) {
        request.finish(
          request.phase === 'dispatched' || request.phase === 'unknown'
            ? 'unknown'
            : 'cancelled',
        );
        request.settle();
        request.controller.abort();
      }
    };
  }, []);

  const send = useCallback(() => {
    const request = pendingRef.current;
    if (!request || request.phase !== 'reviewing') return;
    const isCurrent = () =>
      pendingRef.current === request &&
      !request.signal.aborted &&
      isOwnerCurrent(request);
    if (!isCurrent()) {
      request.finish('cancelled');
      request.controller.abort();
      return;
    }
    request.phase = 'preparing';
    request.startTimeout();
    setReview({ ...request });
    void Promise.resolve()
      .then(() => {
        if (!isCurrent()) throw new DOMException('Cancelled', 'AbortError');
        return hostRef.current.submit(request.text, {
          signal: request.signal,
          isCurrent,
          onDispatched: () => {
            if (!isCurrent()) throw new DOMException('Cancelled', 'AbortError');
            request.phase = 'dispatched';
            if (mountedRef.current) setReview({ ...request });
          },
          onAdmitted: ({ promptId }) => {
            if (!promptId) return;
            request.promptId = promptId;
            request.finish('accepted');
          },
        });
      })
      .then(() => {
        if (isPending(request.phase)) {
          request.finish(
            request.phase === 'dispatched' ? 'unknown' : 'cancelled',
          );
        }
        request.settle();
      })
      .catch((error: unknown) => {
        request.finish(
          error instanceof PromptDispatchCancelledError ||
            (request.phase === 'preparing' &&
              error instanceof Error &&
              error.name === 'AbortError')
            ? 'cancelled'
            : (request.phase === 'dispatched' || request.phase === 'unknown') &&
                !isMcpAppPromptAdmissionRejected(error)
              ? 'unknown'
              : 'failed',
          error instanceof Error ? error.message : undefined,
        );
        request.settle();
      });
  }, [isOwnerCurrent]);

  const close = useCallback(() => {
    const request = pendingRef.current;
    if (request?.phase === 'dispatched') {
      request.finish('unknown');
      request.controller.abort();
      return;
    }
    if (request && isPending(request.phase)) {
      request.finish('cancelled');
      request.controller.abort();
    }
    pendingRef.current = undefined;
    setReview(undefined);
  }, []);

  const context = useMemo<McpAppMessages | undefined>(
    () =>
      host.sessionId && host.clientId
        ? { sessionId: host.sessionId, requestMessage }
        : undefined,
    [host.sessionId, host.clientId, requestMessage],
  );

  return {
    context,
    review: review ? (
      <McpAppMessageReview review={review} onSend={send} onClose={close} />
    ) : null,
  };
}

function McpAppMessageReview({
  review,
  onSend,
  onClose,
}: {
  review: Review;
  onSend(): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('mcpApp.message.title')}</DialogTitle>
          <DialogDescription>
            {t('mcpApp.message.description')}
          </DialogDescription>
        </DialogHeader>
        <dl className="grid gap-1 break-all text-xs text-muted-foreground">
          <div>
            {t('mcpApp.message.server')}: {review.serverName}
          </div>
          <div>
            {t('mcpApp.message.resource')}: {review.resourceUri}
          </div>
          <div>
            {t('mcpApp.message.session')}: {review.sessionId}
          </div>
        </dl>
        <pre
          className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted p-3 text-sm"
          tabIndex={0}
        >
          {review.text}
        </pre>
        <p role="status">{t(`mcpApp.message.${review.phase}`)}</p>
        {review.promptId && (
          <p className="break-all text-xs text-muted-foreground">
            {t('mcpApp.message.receipt')}: {review.promptId}
          </p>
        )}
        {review.error && review.phase === 'failed' && (
          <p className="break-words text-sm">{review.error}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t(
              review.phase === 'dispatched'
                ? 'mcpApp.message.stopWaiting'
                : isPending(review.phase)
                  ? 'common.cancel'
                  : 'common.close',
            )}
          </Button>
          {review.phase === 'reviewing' && (
            <Button onClick={onSend}>{t('mcpApp.message.send')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
