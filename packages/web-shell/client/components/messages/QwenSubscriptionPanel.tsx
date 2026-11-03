/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { I18nProvider, useI18n, type WebShellLanguage } from '../../i18n';
import type { WebShellTheme } from '../../themeContext';
import appStyles from '../../App.module.css';
import { Button } from '../ui/button';
import type { ReactNode } from 'react';
import { DialogShell } from '../dialogs/DialogShell';
import {
  QwenSubscriptionStatus,
  type QwenSubscriptionStatusProps,
} from './QwenSubscriptionStatus';
import { QwenSubscriptionSidebarStatus } from './QwenSubscriptionSidebarStatus';
import styles from './AuthMessage.module.css';
import sidebarStyles from './QwenSubscriptionSidebarStatus.module.css';
import {
  useSubscription,
  type SubscriptionTransport,
} from './use-subscription';

function QwenSubscriptionView({
  dialog = false,
  hideReadyStatus = false,
  children,
  ...props
}: QwenSubscriptionStatusProps & {
  dialog?: boolean;
  hideReadyStatus?: boolean;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const purchase = props.state.status === 'purchase-required';
  const Status = dialog
    ? QwenSubscriptionStatus
    : QwenSubscriptionSidebarStatus;
  const content = (
    <div className={dialog ? styles.panel : sidebarStyles.content}>
      {dialog && !purchase && (
        <nav className={styles.steps} aria-label={t('auth.title')}>
          <button
            type="button"
            className={`${styles.stepPill} ${styles.stepPillDone}`}
            onClick={props.onCancel}
          >
            <span className={styles.stepNumber}>1</span>
            {t('auth.step.group')} · Qwen
          </button>
          <span
            className={`${styles.stepPill} ${styles.stepPillActive}`}
            aria-current="step"
          >
            <span className={styles.stepNumber}>2</span>
            {t('auth.step.authorization')}
          </span>
        </nav>
      )}
      {!(hideReadyStatus && props.state.status === 'ready') && (
        <Status {...props} />
      )}
      {children}
    </div>
  );
  return dialog ? (
    <DialogShell
      key={purchase ? 'membership' : 'authorization'}
      title={t(purchase ? 'subscription.title' : 'auth.title')}
      size="lg"
      onClose={props.onCancel}
    >
      {content}
    </DialogShell>
  ) : (
    content
  );
}

type FlowProps = {
  dialog?: boolean;
  desktopSuccess?: boolean;
  transport: SubscriptionTransport;
  onOpenExternal: (url: string) => void | Promise<void>;
  onClose: () => void;
  onSignedOut?: () => void;
  onOtherProviders: () => void;
  onActivate?: (signal: AbortSignal) => Promise<string | void>;
  onActivated?: (message?: string) => void;
  onModelsUnavailable?: () => void;
  onAuthError?: (message: string) => void;
};

export function QwenSubscriptionFlow(props: FlowProps) {
  const { t } = useI18n();
  const flow = useSubscription(props.transport, props.onOpenExternal);
  const expire = flow.expire;
  const mounted = useRef(true);
  const activation = useRef<AbortController | null>(null);
  const automaticAttempt = useRef<AbortSignal | undefined>(undefined);
  const callbacks = useRef(props);
  callbacks.current = props;
  useEffect(() => {
    if (flow.state.status === 'error')
      callbacks.current.onAuthError?.(flow.state.message);
  }, [flow.state]);
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string>();
  const [connectionRetryAt, setConnectionRetryAt] = useState(0);
  const [completed, setCompleted] = useState<{
    email: string;
    plan: string;
    model?: string;
    owner: AbortSignal;
  }>();
  const completionDelivered = useRef(false);
  useEffect(() => {
    if (!connectionRetryAt) return;
    const timer = setTimeout(
      () => setConnectionRetryAt(0),
      Math.max(0, connectionRetryAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [connectionRetryAt]);
  useEffect(() => {
    mounted.current = true;
    activation.current = null;
    setConnecting(false);
    setConnectionError(undefined);
    setConnectionRetryAt(0);
    setCompleted(undefined);
    completionDelivered.current = false;
    return () => {
      mounted.current = false;
      activation.current?.abort();
    };
  }, [props.transport]);
  const connect = useCallback(async () => {
    const onActivate = callbacks.current.onActivate;
    const owner = flow.readySignal;
    const account = flow.state;
    if (
      !onActivate ||
      account.status !== 'ready' ||
      !owner ||
      owner.aborted ||
      activation.current ||
      connectionRetryAt > Date.now() ||
      flow.working
    )
      return;
    const controller = new AbortController();
    activation.current = controller;
    setConnecting(true);
    setConnectionError(undefined);
    try {
      const signal = AbortSignal.any([owner, controller.signal]);
      const model = await onActivate(signal);
      if (!owner.aborted && !controller.signal.aborted && mounted.current) {
        const result = {
          email: account.email,
          plan: account.plan,
        };
        setCompleted({ ...result, model: model ?? undefined, owner });
        if (!callbacks.current.desktopSuccess)
          callbacks.current.onActivated?.(
            t('subscription.connected', {
              ...result,
              model: model ?? '',
              url: flow.authorizationUrl,
            }),
          );
      }
    } catch (error) {
      if (!owner.aborted && !controller.signal.aborted && mounted.current) {
        const body = (
          error as {
            status?: number;
            body?: {
              code?: string;
              message?: string;
              errorStatus?: number;
              errorStage?: string;
              retryAfterMs?: number;
            };
          } | null
        )?.body;
        const message =
          typeof body?.message === 'string' ? body.message : undefined;
        const status =
          body?.errorStatus ?? (error as { status?: number } | null)?.status;
        if (body?.retryAfterMs)
          setConnectionRetryAt(Date.now() + body.retryAfterMs);
        if (
          body?.code === 'session_changed' ||
          body?.code === 'invalid_token' ||
          status === 401 ||
          (body?.code === 'invalid_grant' && body.errorStage === 'refresh')
        ) {
          expire(message);
          return;
        }
        if (
          (body?.code === 'subscription_models_unavailable' ||
            body?.code === 'subscription_model_unavailable') &&
          callbacks.current.onModelsUnavailable
        ) {
          callbacks.current.onModelsUnavailable();
          return;
        }
        setConnectionError(
          message ??
            t(
              status === 429
                ? 'subscription.rateLimited'
                : body?.errorStage === 'credentials'
                  ? 'subscription.credentialsFailed'
                  : body?.code === 'network_error' ||
                      body?.code === 'request_timeout'
                    ? 'subscription.networkFailed'
                    : body?.errorStage === 'refresh'
                      ? 'subscription.refreshFailed'
                      : body?.code === 'subscription_models_unavailable'
                        ? 'subscription.modelsUnavailable'
                        : 'subscription.connectFailed',
            ),
        );
      }
    } finally {
      if (activation.current === controller) activation.current = null;
      if (!owner.aborted && !controller.signal.aborted && mounted.current)
        setConnecting(false);
    }
  }, [
    flow.readySignal,
    flow.state,
    flow.working,
    flow.authorizationUrl,
    expire,
    connectionRetryAt,
    t,
  ]);
  const canActivate = props.onActivate !== undefined;
  useEffect(() => {
    const owner = flow.readySignal;
    if (
      !canActivate ||
      !owner ||
      owner.aborted ||
      flow.working ||
      automaticAttempt.current === owner
    )
      return;
    automaticAttempt.current = owner;
    void connect();
  }, [canActivate, flow.readySignal, flow.working, connect]);
  const close = () => {
    activation.current?.abort();
    if (
      props.desktopSuccess &&
      completed &&
      completed.owner === flow.readySignal &&
      !completed.owner.aborted
    ) {
      if (!completionDelivered.current) {
        completionDelivered.current = true;
        props.onActivated?.();
      }
      return;
    }
    flow.cancel();
    props.onClose();
  };
  const signOut = async () => {
    if ((await flow.signOut()) && mounted.current) {
      props.onSignedOut?.();
      props.onClose();
    }
  };
  const activeCompletion =
    completed?.owner === flow.readySignal && !completed?.owner.aborted
      ? completed
      : undefined;
  return (
    <QwenSubscriptionView
      dialog={props.dialog}
      hideReadyStatus={props.desktopSuccess && !activeCompletion}
      state={
        flow.state.status === 'ready' && activeCompletion
          ? {
              ...flow.state,
              model: activeCompletion.model,
              authorizationUrl: flow.authorizationUrl,
              showCommonCommands: !props.desktopSuccess,
            }
          : flow.state
      }
      onOpenAuthorization={flow.openAuthorization}
      onOpenPurchase={flow.openPlans}
      onRetry={flow.retry}
      onUseAnotherAccount={() => {
        void flow.switchAccount();
      }}
      onSwitchProvider={() => {
        activation.current?.abort();
        flow.cancel();
        props.onOtherProviders();
      }}
      onCancel={close}
    >
      {flow.state.status === 'ready' && (
        <>
          {connectionError && <p role="alert">{connectionError}</p>}
          {(connecting ||
            (props.desktopSuccess &&
              !activeCompletion &&
              !connectionError)) && (
            <p role="status">{t('subscription.connecting')}</p>
          )}
          {connectionError && props.onActivate && (
            <div className={props.desktopSuccess ? styles.actions : 'contents'}>
              <Button
                variant={props.desktopSuccess ? 'ghost' : 'default'}
                className={
                  props.desktopSuccess ? styles.actionButton : undefined
                }
                disabled={
                  connecting || flow.working || connectionRetryAt > Date.now()
                }
                onClick={() => {
                  void connect();
                }}
              >
                {t('common.retry')}
              </Button>
            </div>
          )}
          {!props.desktopSuccess && (
            <>
              <Button
                variant="outline"
                disabled={flow.working || connecting}
                onClick={() => {
                  void signOut();
                }}
              >
                {t('subscription.signOut')}
              </Button>
              <Button variant="outline" onClick={close}>
                {t('subscription.cancel')}
              </Button>
            </>
          )}
        </>
      )}
    </QwenSubscriptionView>
  );
}

export function QwenSubscriptionPanel({
  language,
  theme = 'dark',
  style,
  ...props
}: FlowProps & {
  language: WebShellLanguage;
  theme?: WebShellTheme;
  style?: CSSProperties;
}) {
  return (
    <I18nProvider language={language}>
      <div
        data-web-shell-root
        data-web-shell-shadcn
        className={`${appStyles.app} ${theme === 'light' ? appStyles.themeLight : `${appStyles.themeDark} dark`}`}
        style={{ padding: 16, overflow: 'auto', ...style }}
      >
        <QwenSubscriptionFlow {...props} />
      </div>
    </I18nProvider>
  );
}
