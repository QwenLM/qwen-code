/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { I18nProvider, useI18n, type WebShellLanguage } from '../../i18n';
import type { WebShellTheme } from '../../themeContext';
import appStyles from '../../App.module.css';
import styles from './AuthMessage.module.css';
import { Button } from '../ui/button';
import { QwenSubscriptionEntry } from './QwenSubscriptionEntry';
import { QwenSubscriptionStatus } from './QwenSubscriptionStatus';
import {
  useSubscription,
  type SubscriptionTransport,
} from './use-subscription';

type FlowProps = {
  transport: SubscriptionTransport;
  onOpenExternal: (url: string) => void | Promise<void>;
  onClose: () => void;
  onModelSelectionRequired?: (message: string, signal: AbortSignal) => void;
  onOtherProviders: () => void;
  onActivate?: (signal: AbortSignal, modelId?: string) => Promise<void>;
  onActivated?: () => void;
};

export function QwenSubscriptionFlow(props: FlowProps) {
  const { t } = useI18n();
  const flow = useSubscription(props.transport, props.onOpenExternal);
  const mounted = useRef(true);
  const activation = useRef<AbortController | null>(null);
  const automaticAttempt = useRef<AbortSignal | undefined>(undefined);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string>();
  const [modelSelectionRequired, setModelSelectionRequired] = useState(false);
  useEffect(() => {
    mounted.current = true;
    activation.current = null;
    setConnecting(false);
    setConnectionError(undefined);
    setModelSelectionRequired(false);
    return () => {
      mounted.current = false;
      activation.current?.abort();
    };
  }, [props.transport]);
  const connect = useCallback(
    async (modelId?: string) => {
      const onActivate = callbacks.current.onActivate;
      const owner = flow.readySignal;
      if (
        !onActivate ||
        !owner ||
        owner.aborted ||
        activation.current ||
        flow.working
      )
        return;
      const controller = new AbortController();
      activation.current = controller;
      setConnecting(true);
      setConnectionError(undefined);
      try {
        const signal = AbortSignal.any([owner, controller.signal]);
        if (modelId) await onActivate(signal, modelId);
        else await onActivate(signal);
        if (!owner.aborted && !controller.signal.aborted && mounted.current)
          callbacks.current.onActivated?.();
      } catch (error) {
        if (!owner.aborted && !controller.signal.aborted && mounted.current) {
          const body = (
            error as {
              body?: { code?: string; modelId?: string; models?: unknown };
            } | null
          )?.body;
          if (
            body?.code === 'subscription_model_unavailable' &&
            typeof body.modelId === 'string'
          ) {
            setConnectionError(
              t('subscription.modelUnavailable', { model: body.modelId }),
            );
            setModelSelectionRequired(true);
          } else {
            setModelSelectionRequired(false);
            setConnectionError(
              t(
                body?.code === 'subscription_models_unavailable'
                  ? 'subscription.modelsUnavailable'
                  : 'subscription.connectFailed',
              ),
            );
          }
        }
      } finally {
        if (activation.current === controller) activation.current = null;
        if (!owner.aborted && !controller.signal.aborted && mounted.current)
          setConnecting(false);
      }
    },
    [flow.readySignal, flow.working, t],
  );
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
      modelSelectionRequired &&
      flow.state.status === 'ready' &&
      flow.readySignal &&
      !flow.readySignal.aborted &&
      connectionError &&
      props.onModelSelectionRequired
    )
      props.onModelSelectionRequired(connectionError, flow.readySignal);
    else props.onClose();
  };
  const signOut = async () => {
    if ((await flow.signOut()) && mounted.current) props.onClose();
  };
  return (
    <div className={styles.panel}>
      <QwenSubscriptionStatus
        state={flow.state}
        onOpenAuthorization={flow.openAuthorization}
        onOpenPurchase={flow.openPlans}
        onRetry={flow.retry}
        onSwitchProvider={() => {
          activation.current?.abort();
          props.onOtherProviders();
        }}
        onSignOut={() => {
          void signOut();
        }}
        onCancel={close}
      />
      {flow.state.status === 'ready' && (
        <>
          {connectionError && <p role="alert">{connectionError}</p>}
          {connecting && <p role="status">{t('subscription.connecting')}</p>}
          {connectionError && !modelSelectionRequired && props.onActivate && (
            <Button
              disabled={connecting || flow.working}
              onClick={() => {
                void connect();
              }}
            >
              {t('common.retry')}
            </Button>
          )}
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
    </div>
  );
}

export function QwenSubscriptionPanel({
  language,
  theme = 'dark',
  ...props
}: FlowProps & { language: WebShellLanguage; theme?: WebShellTheme }) {
  return (
    <I18nProvider language={language}>
      <div
        data-web-shell-root
        data-web-shell-shadcn
        className={`${appStyles.app} ${theme === 'light' ? appStyles.themeLight : `${appStyles.themeDark} dark`}`}
        style={{ padding: 16, overflow: 'auto' }}
      >
        <SubscriptionMenu {...props} />
      </div>
    </I18nProvider>
  );
}

function SubscriptionMenu(props: FlowProps) {
  const { t, language } = useI18n();
  const [started, setStarted] = useState(false);
  return started ? (
    <QwenSubscriptionFlow {...props} onClose={() => setStarted(false)} />
  ) : (
    <div className={styles.panel}>
      <h2>{t('auth.title')}</h2>
      <QwenSubscriptionEntry onClick={() => setStarted(true)} />
      <Button variant="outline" onClick={props.onOtherProviders}>
        {language === 'en' ? 'Other providers' : '其他提供商'}
      </Button>
      <Button variant="outline" onClick={props.onClose}>
        {t('subscription.cancel')}
      </Button>
    </div>
  );
}
