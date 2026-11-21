/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DaemonClient,
  DaemonGoogleOAuthFlow,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { DialogShell } from '../dialogs/DialogShell';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import styles from './AuthMessage.module.css';

export type GoogleOAuthTransport = Pick<
  DaemonClient,
  | 'startGoogleOAuthLogin'
  | 'getGoogleOAuthLogin'
  | 'submitGoogleOAuthCode'
  | 'cancelGoogleOAuthLogin'
>;

type FlowView =
  | DaemonGoogleOAuthFlow
  | { id: string; status: 'starting'; authorizationUrl?: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useGoogleOAuthFlow(
  transport: GoogleOAuthTransport,
  workspace: string | undefined,
  onOpenExternal: (url: string) => void | Promise<void>,
) {
  const [flow, setFlow] = useState<FlowView>({ id: '', status: 'starting' });
  const [submitting, setSubmitting] = useState(false);
  const [openError, setOpenError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const activeId = useRef('');
  const generation = useRef(0);
  const mounted = useRef(true);
  const openedUrl = useRef('');
  const openRef = useRef(onOpenExternal);
  openRef.current = onOpenExternal;
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const controllerRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      controllerRef.current?.abort();
      const id = activeId.current;
      if (id && flowRef.current.status !== 'ready') {
        void transport.cancelGoogleOAuthLogin(id, { workspace }).catch(() => {
          /* Cleanup is best-effort during unmount. */
        });
      }
    };
  }, [transport, workspace]);

  const openAuthorization = useCallback(async (url: string) => {
    const current = generation.current;
    if (mounted.current) setOpenError('');
    try {
      await openRef.current(url);
      if (mounted.current && current === generation.current) {
        openedUrl.current = url;
      }
    } catch (error) {
      if (mounted.current && current === generation.current) {
        setOpenError(errorMessage(error));
      }
    }
  }, []);

  const deliverFlow = useCallback(
    (next: FlowView) => {
      if (
        next.authorizationUrl &&
        next.authorizationUrl !== openedUrl.current
      ) {
        // Preserve the first authorization URL even when the very next poll is ready.
        openedUrl.current = next.authorizationUrl;
        void openAuthorization(next.authorizationUrl);
      }
      setFlow(next);
    },
    [openAuthorization],
  );

  useEffect(() => {
    const current = ++generation.current;
    activeId.current = '';
    controllerRef.current = undefined;
    setFlow({ id: '', status: 'starting' });
    setSubmitting(false);
    setOpenError('');
    const start = async () => {
      // React StrictMode can setup, cleanup, and setup in one turn. Do not
      // create the first remote flow before that replay has been rejected.
      await Promise.resolve();
      if (!mounted.current || current !== generation.current) return;
      const started = await transport.startGoogleOAuthLogin({ workspace });
      if (!mounted.current || current !== generation.current) {
        await transport
          .cancelGoogleOAuthLogin(started.id, { workspace })
          .catch(() => undefined);
        return;
      }
      activeId.current = started.id;
      const controller = new AbortController();
      controllerRef.current = controller;
      deliverFlow(started);
      let done = false;
      while (!done && mounted.current && current === generation.current) {
        const next = await transport.getGoogleOAuthLogin(started.id, {
          workspace,
          signal: controller.signal,
        });
        if (!mounted.current || current !== generation.current) return;
        deliverFlow(next);
        done = next.status === 'ready' || next.status === 'error';
        if (!done) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        }
      }
    };
    void start().catch((error: unknown) => {
      if (mounted.current && current === generation.current) {
        setFlow((currentFlow: FlowView) => ({
          ...currentFlow,
          status: 'error',
          errorMessage: errorMessage(error),
          errorCode: 'request_failed',
        }));
      }
    });
    return () => controllerRef.current?.abort();
  }, [transport, workspace, attempt, deliverFlow]);

  const submitCode = useCallback(
    async (code: string) => {
      const id = activeId.current;
      const current = generation.current;
      setSubmitting(true);
      try {
        await transport.submitGoogleOAuthCode(id, code, { workspace });
        return (
          mounted.current &&
          current === generation.current &&
          id === activeId.current
        );
      } catch (error) {
        if (
          mounted.current &&
          current === generation.current &&
          id === activeId.current
        ) {
          throw error;
        }
        return false;
      } finally {
        if (mounted.current && current === generation.current) {
          setSubmitting(false);
        }
      }
    },
    [transport, workspace],
  );

  const cancel = useCallback(async () => {
    generation.current += 1;
    controllerRef.current?.abort();
    const id = activeId.current;
    if (!id) return;
    await transport.cancelGoogleOAuthLogin(id, { workspace });
    activeId.current = '';
  }, [transport, workspace]);

  const retry = useCallback(async () => {
    generation.current += 1;
    controllerRef.current?.abort();
    const id = activeId.current;
    if (id) await transport.cancelGoogleOAuthLogin(id, { workspace });
    activeId.current = '';
    openedUrl.current = '';
    setAttempt((value) => value + 1);
  }, [transport, workspace]);

  return {
    flow,
    submitting,
    openError,
    submitCode,
    cancel,
    retry,
    openAuthorization,
  };
}

export function GoogleOAuthFlowPanel({
  transport,
  workspace,
  onOpenExternal,
  onActivated,
  onClose,
}: {
  transport: GoogleOAuthTransport;
  workspace: string | undefined;
  onOpenExternal: (url: string) => void | Promise<void>;
  onActivated: (flow: DaemonGoogleOAuthFlow) => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const {
    flow,
    submitting,
    openError,
    submitCode,
    cancel,
    retry,
    openAuthorization,
  } = useGoogleOAuthFlow(transport, workspace, onOpenExternal);
  const [code, setCode] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [activationAttempt, setActivationAttempt] = useState(0);
  const [activating, setActivating] = useState(false);
  const readyDelivered = useRef(false);
  const activationOwner = useRef(0);

  useEffect(() => {
    if (flow.status !== 'ready') {
      readyDelivered.current = false;
      return;
    }
    if (readyDelivered.current) return;
    readyDelivered.current = true;
    const owner = ++activationOwner.current;
    setActivating(true);
    void Promise.resolve(onActivated(flow))
      .catch((error: unknown) => {
        if (activationOwner.current === owner) {
          setActionError(errorMessage(error));
        }
      })
      .finally(() => {
        if (activationOwner.current === owner) setActivating(false);
      });
  }, [flow, onActivated, activationAttempt]);

  const retryActivation = () => {
    if (activating) return;
    setActionError('');
    readyDelivered.current = false;
    setActivationAttempt((value) => value + 1);
  };

  const retryLogin = () => {
    if (actionBusy) return;
    setActionBusy(true);
    setCode('');
    setActionError('');
    void retry()
      .catch((error: unknown) => {
        setActionError(errorMessage(error));
      })
      .finally(() => setActionBusy(false));
  };

  const cancelLogin = () => {
    if (actionBusy || activating) return;
    setActionBusy(true);
    void cancel()
      .then(onClose)
      .catch((error: unknown) => {
        setActionError(errorMessage(error));
      })
      .finally(() => setActionBusy(false));
  };

  const busy = actionBusy || activating;
  return (
    <DialogShell
      title={t('auth.google.title')}
      size="lg"
      dismissible={!busy}
      aria-busy={activating}
      onClose={onClose}
    >
      <div className={styles.panel}>
        {flow.status === 'starting' && (
          <div className={styles.text}>{t('common.loading')}</div>
        )}
        {flow.status !== 'error' && flow.status !== 'starting' && (
          <div className={styles.text}>{t('auth.google.instructions')}</div>
        )}
        {flow.authorizationUrl && (
          <a
            className={styles.link}
            href={flow.authorizationUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              event.preventDefault();
              void openAuthorization(flow.authorizationUrl!);
            }}
          >
            {flow.authorizationUrl}
          </a>
        )}
        {flow.status === 'awaiting-code' && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!code.trim()) {
                setActionError(t('auth.google.codeRequired'));
                return;
              }
              setActionError('');
              void submitCode(code)
                .then((accepted) => {
                  if (accepted) setCode('');
                })
                .catch((error: unknown) => {
                  setActionError(errorMessage(error));
                });
            }}
          >
            <Input
              aria-label={t('auth.google.codeLabel')}
              value={code}
              disabled={submitting}
              autoComplete="off"
              onChange={(event) => setCode(event.target.value)}
            />
            <Button type="submit" disabled={submitting}>
              {t('auth.google.submitCode')}
            </Button>
          </form>
        )}
        {flow.status === 'error' && (
          <div className={styles.error} role="alert">
            {flow.errorMessage ?? t('auth.google.failed')}
          </div>
        )}
        {actionError && (
          <div className={styles.error} role="alert">
            {actionError}
          </div>
        )}
        {openError && (
          <div className={styles.error} role="alert">
            {openError}
          </div>
        )}
        <div className="mt-4 flex gap-2">
          {flow.status === 'error' && (
            <Button type="button" disabled={actionBusy} onClick={retryLogin}>
              {t('common.retry')}
            </Button>
          )}
          {flow.status === 'ready' && actionError && (
            <Button
              type="button"
              disabled={activating}
              onClick={retryActivation}
            >
              {t('common.retry')}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={cancelLogin}
          >
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}
