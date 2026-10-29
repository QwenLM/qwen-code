import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MCP_APP_MESSAGE_REVIEW_META,
  type McpAppMessageRequest,
  type McpAppMessages,
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
        // Refused before review: nothing was sent.
        return Promise.resolve({
          isError: true,
          _meta: {
            [MCP_APP_MESSAGE_REVIEW_META]: input.signal.aborted
              ? 'cancelled'
              : 'failed',
          },
        });
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
            resolve(
              request.phase === 'accepted'
                ? {}
                : request.phase === 'cancelled' ||
                    request.phase === 'expired' ||
                    request.phase === 'failed'
                  ? // None reached the session, so the App can say nothing was sent.
                    {
                      isError: true,
                      _meta: { [MCP_APP_MESSAGE_REVIEW_META]: request.phase },
                    }
                  : { isError: true },
            );
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

interface GeneratedUiParameters {
  title: string;
  inputs: Array<{ id: string; value: string; checked: boolean }>;
  rejectedEvents: number;
}

/**
 * Reads the parameter message the built-in Generated UI App sends, so the
 * review can show the values first. Anything else keeps the generic layout:
 * the table folds the message text away, so only the bundled server counts,
 * not any App that claims its resource URI.
 */
export function readGeneratedUiParameters(
  review: Pick<McpAppMessageRequest, 'requiredFeature' | 'text'>,
): GeneratedUiParameters | undefined {
  if (review.requiredFeature !== 'generated-ui') return undefined;
  const start = review.text.indexOf('\n{');
  if (start < 0) return undefined;
  let message: unknown;
  try {
    message = JSON.parse(review.text.slice(start + 1));
  } catch {
    return undefined;
  }
  if (!message || typeof message !== 'object') return undefined;
  const { kind, title, snapshot, rejectedEvents } = message as Record<
    string,
    unknown
  >;
  const inputs =
    snapshot && typeof snapshot === 'object'
      ? (snapshot as Record<string, unknown>)['inputs']
      : undefined;
  if (
    kind !== 'qwen.generated-ui.parameters' ||
    typeof title !== 'string' ||
    typeof rejectedEvents !== 'number' ||
    !Number.isSafeInteger(rejectedEvents) ||
    rejectedEvents < 0 ||
    !inputs ||
    typeof inputs !== 'object'
  ) {
    return undefined;
  }
  const rows: GeneratedUiParameters['inputs'] = [];
  for (const [id, input] of Object.entries(inputs)) {
    if (
      !input ||
      typeof input !== 'object' ||
      typeof (input as Record<string, unknown>)['value'] !== 'string' ||
      typeof (input as Record<string, unknown>)['checked'] !== 'boolean'
    ) {
      return undefined;
    }
    const { value, checked } = input as { value: string; checked: boolean };
    rows.push({ id, value, checked });
  }
  return { title, inputs: rows, rejectedEvents };
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
  const parameters = readGeneratedUiParameters(review);
  const details = (
    <>
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
    </>
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {t(
              parameters
                ? 'mcpApp.generatedUi.reviewTitle'
                : 'mcpApp.message.title',
            )}
          </DialogTitle>
          <DialogDescription>
            {parameters
              ? t('mcpApp.generatedUi.reviewDescription', {
                  title: parameters.title,
                })
              : t('mcpApp.message.description')}
          </DialogDescription>
        </DialogHeader>
        {parameters ? (
          <>
            {parameters.rejectedEvents > 0 && (
              <p className="text-sm text-destructive">
                {t('mcpApp.generatedUi.rejectedEvents', {
                  count: parameters.rejectedEvents,
                })}
              </p>
            )}
            {parameters.inputs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('mcpApp.generatedUi.noParameters')}
              </p>
            ) : (
              <div className="max-h-[40vh] overflow-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">
                        {t('mcpApp.generatedUi.parameter')}
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        {t('mcpApp.generatedUi.value')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {parameters.inputs.map((input) => (
                      <tr key={input.id} className="border-t">
                        <td className="px-3 py-1.5 font-mono text-xs break-all">
                          {input.id}
                        </td>
                        <td className="px-3 py-1.5 break-all">
                          {input.checked ? '✓ ' : ''}
                          {input.value}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                {t('mcpApp.generatedUi.fullMessage')}
              </summary>
              <div className="mt-2 grid gap-2">{details}</div>
            </details>
          </>
        ) : (
          details
        )}
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
            <Button onClick={onSend}>
              {t(
                parameters ? 'mcpApp.generatedUi.send' : 'mcpApp.message.send',
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
