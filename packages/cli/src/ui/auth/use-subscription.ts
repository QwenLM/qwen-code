/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { QwenSubscriptionSession } from '@qwen-code/qwen-code-core/qwen/subscription-session.js';
import {
  SubscriptionOAuthError,
  subscriptionError,
  type SubscriptionDeviceAuthorization,
  type SubscriptionUserInfo,
} from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';
import {
  getQwenOAuthConfig,
  getQwenSubscriptionPlansUrl,
} from '@qwen-code/qwen-code-core/qwen/oauth-config.js';
import {
  SUBSCRIPTION_MODELS_UNAVAILABLE,
  SubscriptionModelSelectionError,
} from '@qwen-code/qwen-code-core/qwen/subscription-models.js';
import { openBrowserSecurely } from '@qwen-code/qwen-code-core/utils/secure-browser-launcher.js';
import { t } from '../../i18n/index.js';

export function isSubscriptionEntryEnabled(): boolean {
  return process.env['DEV'] === 'true';
}

export function subscriptionAuthorizationUrl(
  device: SubscriptionDeviceAuthorization,
): string {
  const url = new URL('/authorize', getQwenOAuthConfig().webOrigin);
  url.searchParams.set('user_code', device.user_code);
  url.searchParams.set('client', 'qwen-code');
  return url.toString();
}

export type SubscriptionState =
  | { status: 'waiting' }
  | { status: 'error' | 'timeout' | 'query-error'; message: string }
  | { status: 'ready'; plan: string }
  | {
      status: 'purchase-required';
      plan: string;
      message?: string;
      canCheckAgain?: boolean;
    };

function membershipState(info: SubscriptionUserInfo): SubscriptionState {
  const memberType = info.member_type.toLowerCase();
  const plan = memberType.charAt(0).toUpperCase() + memberType.slice(1);
  return {
    status:
      memberType === 'plus' || memberType === 'pro'
        ? 'ready'
        : 'purchase-required',
    plan,
  };
}

function authenticationError(
  error: unknown,
): Extract<SubscriptionState, { message: string }> {
  const failure = subscriptionError(error, 'exchange');
  if (failure.code === 'expired_token' && failure.stage === 'exchange') {
    return {
      status: 'timeout',
      message: t(
        'Authentication timed out. Please try again or select a different authentication method.',
      ),
    };
  }
  if (
    failure.code === 'session_changed' ||
    (failure.stage === 'refresh' && failure.code === 'invalid_grant') ||
    (failure.stage === 'userinfo' &&
      (failure.status === 401 || failure.code === 'invalid_token'))
  ) {
    return {
      status: 'error',
      message: t('Your Qwen session has expired. Run /auth to sign in again.'),
    };
  }
  const messages = {
    device: t(
      'Could not request an authorization link. Please try signing in again.',
    ),
    exchange: t(
      'Could not complete authorization. Please try signing in again.',
    ),
    credentials: t(
      'Could not read or save Qwen credentials. Check local file permissions and disk space.',
    ),
    userinfo: t("Couldn't check your subscription status. Please try again."),
    refresh: t('Could not refresh your Qwen session. Please try again.'),
    revoke: t(
      'You are signed out locally, but the remote session could not be revoked.',
    ),
    cleanup: t(
      'Could not remove local Qwen credentials. Check local file permissions.',
    ),
  };
  let message = messages[failure.stage ?? 'exchange'];
  if (failure.code === 'access_denied')
    message += ' ' + t('Authorization or access was denied.');
  else if (failure.status === 429)
    message += ' ' + t('Too many requests. Please try again later.');
  else if (
    [
      'invalid_grant',
      'invalid_client',
      'invalid_scope',
      'invalid_request',
      'unsupported_grant_type',
    ].includes(failure.code)
  )
    message += ` (${failure.code})`;
  else if (
    failure.code === 'network_error' ||
    failure.code === 'request_timeout'
  )
    message += ' ' + t('The network request failed or timed out.');
  else if (failure.code === 'invalid_response')
    message += ' ' + t('The service returned an invalid response.');
  return {
    status:
      failure.stage === 'userinfo' || failure.stage === 'refresh'
        ? 'query-error'
        : 'error',
    message,
  };
}

function waitForCheck(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, 5000);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function useSubscription({
  suppressBrowserLaunch = false,
  onActivate,
}: {
  suppressBrowserLaunch?: boolean;
  onActivate?: (signal: AbortSignal, modelId?: string) => Promise<void>;
} = {}) {
  const [state, setState] = useState<SubscriptionState>({ status: 'waiting' });
  const [email, setEmail] = useState('');
  const [deviceAuth, setDeviceAuth] =
    useState<SubscriptionDeviceAuthorization>();
  const [checking, setChecking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string>();
  const [modelSelectionRequired, setModelSelectionRequired] = useState(false);
  const activate = useRef(onActivate);
  activate.current = onActivate;
  const confirmedPaidOwner = useRef<AbortSignal | null>(null);
  const automaticAttempt = useRef<AbortSignal | null>(null);
  const activationOwner = useRef<AbortSignal | null>(null);
  const session = useRef<QwenSubscriptionSession | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const busy = useRef(false);
  const signingOut = useRef(false);
  const plansUrl = useRef('');
  const retryAt = useRef(0);
  const startPurchase = useRef<() => Promise<void>>(async () => {});
  const rememberRetry = (error: unknown) => {
    if (error instanceof SubscriptionOAuthError && error.retryAfterMs)
      retryAt.current = Date.now() + error.retryAfterMs;
  };
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    lifetime.current = controller;
    mounted.current = true;
    activationOwner.current = null;
    confirmedPaidOwner.current = null;
    busy.current = false;
    setState({ status: 'waiting' });
    setChecking(false);
    setConnecting(false);
    setConnectionError(undefined);
    setModelSelectionRequired(false);
    const applyInfo = (info: SubscriptionUserInfo) => {
      signal.throwIfAborted();
      const next = membershipState(info);
      confirmedPaidOwner.current = next.status === 'ready' ? signal : null;
      setEmail(info.email);
      setState(next);
      return next;
    };
    let authorizationStarted = false;
    startPurchase.current = async () => {
      if (!suppressBrowserLaunch && !authorizationStarted) {
        void openBrowserSecurely(plansUrl.current).catch(() => undefined);
      }
      const purchase = new AbortController();
      const deadline = setTimeout(() => purchase.abort(), 120_000);
      const purchaseSignal = AbortSignal.any([signal, purchase.signal]);
      try {
        while (true) {
          await waitForCheck(purchaseSignal);
          const updated = await session.current!.getUserInfo(purchaseSignal);
          purchaseSignal.throwIfAborted();
          if (!updated) throw new SubscriptionOAuthError('session_changed');
          if (applyInfo(updated).status === 'ready') return;
        }
      } catch (error) {
        if (signal.aborted) return;
        rememberRetry(error);
        const failure = authenticationError(
          subscriptionError(error, 'userinfo'),
        );
        if (failure.status === 'error') {
          setState(failure);
          return;
        }
        setState((current) =>
          current.status === 'purchase-required'
            ? {
                ...current,
                canCheckAgain: true,
                message: purchase.signal.aborted
                  ? t(
                      "Your subscription isn't active yet. If you've completed payment, please wait a moment and check again.",
                    )
                  : failure.message,
              }
            : current,
        );
      } finally {
        clearTimeout(deadline);
      }
    };
    const run = async () => {
      plansUrl.current = getQwenSubscriptionPlansUrl();
      const activeSession = new QwenSubscriptionSession();
      session.current = activeSession;
      const saved = await activeSession
        .getUserInfo(signal)
        .catch((error: unknown) => {
          throw subscriptionError(error, 'userinfo');
        });
      const info =
        saved ??
        (await activeSession.signIn((device) => {
          signal.throwIfAborted();
          authorizationStarted = true;
          const url = subscriptionAuthorizationUrl(device);
          setDeviceAuth({ ...device, verification_uri_complete: url });
          if (!suppressBrowserLaunch) {
            void openBrowserSecurely(url).catch(() => undefined);
          }
        }, signal));
      const next = applyInfo(info);
      if (next.status !== 'purchase-required') return;
      await startPurchase.current();
    };
    void run().catch((error: unknown) => {
      rememberRetry(error);
      if (!signal.aborted) setState(authenticationError(error));
    });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [suppressBrowserLaunch]);

  const checkAgain = () => {
    const current = stateRef.current;
    const signal = lifetime.current?.signal;
    if (
      busy.current ||
      Date.now() < retryAt.current ||
      !session.current ||
      !signal ||
      signal.aborted ||
      !(
        current.status === 'query-error' ||
        (current.status === 'purchase-required' && current.canCheckAgain)
      )
    )
      return;
    busy.current = true;
    setChecking(true);
    void session.current
      .getUserInfo(signal)
      .then((info) => {
        signal.throwIfAborted();
        if (!info) throw new SubscriptionOAuthError('session_changed');
        const next = membershipState(info);
        confirmedPaidOwner.current = next.status === 'ready' ? signal : null;
        setEmail(info.email);
        if (current.status === 'query-error') {
          setState(next);
          if (next.status === 'purchase-required') void startPurchase.current();
          return;
        }
        setState(
          next.status === 'purchase-required'
            ? {
                ...next,
                canCheckAgain: true,
                message: t(
                  "No active Plus or Pro subscription was found for this account. If you've already subscribed, make sure you used the same Qwen account.",
                ),
              }
            : next,
        );
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        rememberRetry(error);
        const failure = authenticationError(
          subscriptionError(error, 'userinfo'),
        );
        setState(
          failure.status === 'error' || current.status === 'query-error'
            ? failure
            : { ...current, message: failure.message },
        );
      })
      .finally(() => {
        if (lifetime.current?.signal !== signal) return;
        busy.current = false;
        if (!signal.aborted) setChecking(false);
      });
  };

  const connect = useCallback(async (modelId?: string) => {
    const signal = lifetime.current?.signal;
    if (
      !activate.current ||
      !signal ||
      signal.aborted ||
      activationOwner.current === signal ||
      signingOut.current ||
      stateRef.current.status !== 'ready' ||
      confirmedPaidOwner.current !== signal
    )
      return;
    activationOwner.current = signal;
    busy.current = true;
    setConnecting(true);
    setConnectionError(undefined);
    try {
      if (modelId) await activate.current(signal, modelId);
      else await activate.current(signal);
    } catch (error) {
      if (!signal.aborted && lifetime.current?.signal === signal) {
        setModelSelectionRequired(
          error instanceof SubscriptionModelSelectionError,
        );
        setConnectionError(
          error instanceof SubscriptionModelSelectionError
            ? error.message
            : error instanceof Error &&
                error.message.includes(SUBSCRIPTION_MODELS_UNAVAILABLE)
              ? SUBSCRIPTION_MODELS_UNAVAILABLE
              : t('Could not connect Qwen Subscription. Please try again.'),
        );
      }
    } finally {
      if (activationOwner.current === signal) {
        activationOwner.current = null;
        busy.current = false;
      }
      if (!signal.aborted && lifetime.current?.signal === signal)
        setConnecting(false);
    }
  }, []);

  const canActivate = Boolean(onActivate);
  useEffect(() => {
    const signal = lifetime.current?.signal;
    if (
      state.status !== 'ready' ||
      !canActivate ||
      !signal ||
      signal.aborted ||
      confirmedPaidOwner.current !== signal ||
      automaticAttempt.current === signal
    )
      return;
    automaticAttempt.current = signal;
    void connect();
  }, [state, canActivate, connect]);

  const signOut = async (): Promise<boolean> => {
    if (signingOut.current || !session.current) return false;
    signingOut.current = true;
    busy.current = true;
    lifetime.current?.abort();
    setChecking(true);
    try {
      await session.current.signOut();
      return true;
    } catch (error) {
      if (mounted.current)
        setState(authenticationError(subscriptionError(error, 'cleanup')));
      return false;
    } finally {
      signingOut.current = false;
      busy.current = false;
      if (mounted.current) setChecking(false);
    }
  };

  return {
    state,
    email,
    deviceAuth,
    checking,
    connecting,
    connectionError,
    modelSelectionRequired,
    connect,
    canCheckAgain:
      state.status === 'purchase-required' && !!state.canCheckAgain,
    openPlans: () => {
      if (
        plansUrl.current &&
        !busy.current &&
        !lifetime.current?.signal.aborted
      ) {
        void openBrowserSecurely(plansUrl.current).catch(() => undefined);
      }
    },
    checkAgain,
    signOut,
    cancel: () => lifetime.current?.abort(),
  };
}
