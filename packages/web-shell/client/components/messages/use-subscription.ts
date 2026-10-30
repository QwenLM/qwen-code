/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DaemonClient,
  DaemonSubscriptionFlow,
  DaemonSubscriptionUserInfo,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import type { QwenSubscriptionState } from './QwenSubscriptionStatus';

export type SubscriptionTransport = Pick<
  DaemonClient,
  | 'getSubscriptionConfig'
  | 'startSubscriptionLogin'
  | 'getSubscriptionLogin'
  | 'cancelSubscriptionLogin'
  | 'getSubscriptionUserInfo'
  | 'signOutSubscription'
>;

const COPY = {
  en: {
    device:
      'Could not request an authorization link. Please try signing in again.',
    exchange: 'Could not complete authorization. Please try signing in again.',
    credentials:
      'Could not read or save Qwen credentials. Check local file permissions and disk space.',
    refresh: 'Could not refresh your Qwen session. Please try again.',
    revoke:
      'You are signed out locally, but the remote session could not be revoked.',
    cleanup:
      'Could not remove local Qwen credentials. Check local file permissions.',
    denied: 'Authorization or access was denied.',
    rateLimited: 'Too many requests. Please try again later.',
    network: 'The network request failed or timed out.',
    invalidResponse: 'The service returned an invalid response.',
    expired: 'Your Qwen session has expired. Please sign in again.',
    timeout:
      'Authentication timed out. Please try again or select a different authentication method.',
    queryFailed: "Couldn't check your subscription status. Please try again.",
    purchaseTimeout:
      "Your subscription isn't active yet. If you've completed payment, please wait a moment and check again.",
    notActive:
      "No active Plus or Pro subscription was found for this account. If you've already subscribed, make sure you used the same Qwen account.",
  },
  'zh-CN': {
    device: '无法申请授权链接，请重新登录。',
    exchange: '无法完成授权，请重新登录。',
    credentials: '无法读取或保存 Qwen 凭证，请检查本地文件权限和磁盘空间。',
    refresh: '无法刷新 Qwen 登录凭证，请重试。',
    revoke: '本地已退出登录，但未能撤销远端会话。',
    cleanup: '无法清除本地 Qwen 凭证，请检查本地文件权限。',
    denied: '授权或访问被拒绝。',
    rateLimited: '请求过多，请稍后重试。',
    network: '网络请求失败或超时。',
    invalidResponse: '服务返回的数据格式无效。',
    expired: '你的 Qwen 登录已过期，请重新登录。',
    timeout: '身份验证超时，请重试或选择其他身份验证方式。',
    queryFailed: '无法查询你的订阅状态，请重试。',
    purchaseTimeout: '你的订阅尚未生效。如果已完成付款，请稍等片刻后再次检查。',
    notActive:
      '此账号未找到有效的 Plus 或 Pro 订阅。如果已经订阅，请确认使用的是同一个 Qwen 账号。',
  },
};

function membership(info: DaemonSubscriptionUserInfo): QwenSubscriptionState {
  const memberType = info.member_type.toLowerCase();
  return {
    status:
      memberType === 'plus' || memberType === 'pro'
        ? 'ready'
        : 'purchase-required',
    email: info.email,
    plan: memberType.charAt(0).toUpperCase() + memberType.slice(1),
  };
}

function errorDetails(error: unknown): {
  code?: string;
  errorStage?: DaemonSubscriptionFlow['errorStage'];
  errorStatus?: number;
  retryAfterMs?: number;
} {
  if (typeof error !== 'object' || error === null) return {};
  const body = (error as { body?: unknown }).body;
  return typeof body === 'object' && body !== null ? body : {};
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function useSubscription(
  transport: SubscriptionTransport,
  onOpenExternal: (url: string) => void | Promise<void>,
) {
  const { language } = useI18n();
  const copy = useRef(COPY[language]);
  copy.current = COPY[language];
  const open = useRef(onOpenExternal);
  open.current = onOpenExternal;
  const [state, setState] = useState<QwenSubscriptionState>({
    status: 'waiting',
    authorizationUrl: '',
  });
  const [attempt, setAttempt] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const lifetime = useRef<AbortController | null>(null);
  const confirmedMembership = useRef<
    | {
        transport: SubscriptionTransport;
        signal: AbortSignal;
      }
    | undefined
  >(undefined);
  const confirmMembership = useCallback(
    (info: DaemonSubscriptionUserInfo, signal: AbortSignal) => {
      const next = membership(info);
      confirmedMembership.current =
        next.status === 'ready' ? { transport, signal } : undefined;
      return next;
    },
    [transport],
  );
  const plansUrl = useRef('');
  const busy = useRef(false);
  const signingOut = useRef(false);
  const mounted = useRef(false);
  const [working, setWorking] = useState(false);
  const retryAt = useRef(0);
  const retryOwner = useRef(transport);
  const startPurchase = useRef<() => Promise<void>>(async () => {});
  const showError = useCallback(
    (
      code?: string,
      stage: DaemonSubscriptionFlow['errorStage'] = 'exchange',
      status?: number,
      retryAfterMs?: number,
    ) => {
      if (retryAfterMs) retryAt.current = Date.now() + retryAfterMs;
      const sessionExpired =
        code === 'session_changed' ||
        (stage === 'refresh' && code === 'invalid_grant') ||
        (stage === 'userinfo' && (status === 401 || code === 'invalid_token'));
      const querying = stage === 'userinfo' || stage === 'refresh';
      let message = sessionExpired
        ? copy.current.expired
        : code === 'expired_token' && stage === 'exchange'
          ? copy.current.timeout
          : stage === 'userinfo'
            ? copy.current.queryFailed
            : copy.current[stage];
      if (!sessionExpired) {
        if (code === 'access_denied') message += ' ' + copy.current.denied;
        else if (status === 429) message += ' ' + copy.current.rateLimited;
        else if (
          code &&
          [
            'invalid_grant',
            'invalid_client',
            'invalid_scope',
            'invalid_request',
            'unsupported_grant_type',
          ].includes(code)
        )
          message += ` (${code})`;
        else if (code === 'network_error' || code === 'request_timeout')
          message += ' ' + copy.current.network;
        else if (code === 'invalid_response')
          message += ' ' + copy.current.invalidResponse;
      }
      setState(
        querying && !sessionExpired
          ? { status: 'query-error', message }
          : {
              status: 'error',
              message,
              retry:
                stage === 'credentials' ||
                stage === 'cleanup' ||
                stage === 'revoke'
                  ? undefined
                  : 'authorization',
            },
      );
    },
    [],
  );
  const showFailure = useCallback(
    (error: unknown, stage?: DaemonSubscriptionFlow['errorStage']) => {
      const details = errorDetails(error);
      showError(
        details.code,
        details.errorStage ?? stage,
        details.errorStatus,
        details.retryAfterMs,
      );
    },
    [showError],
  );
  const openUrl = (url: string) => {
    if (!url) return;
    try {
      void Promise.resolve(open.current(url)).catch(() => undefined);
    } catch {
      /* The authorization URL remains available for manual opening. */
    }
  };

  useEffect(() => {
    if (retryOwner.current !== transport) {
      retryAt.current = 0;
      retryOwner.current = transport;
    }
    const controller = new AbortController();
    const signal = controller.signal;
    lifetime.current = controller;
    confirmedMembership.current = undefined;
    mounted.current = true;
    busy.current = false;
    signingOut.current = false;
    setWorking(false);
    setState({ status: 'waiting', authorizationUrl: '' });
    let flowId: string | undefined;
    const cancelFlow = (id: string) => {
      void transport.cancelSubscriptionLogin(id).catch(() => undefined);
    };
    let openedUrl = '';
    startPurchase.current = async () => {
      if (!openedUrl) openUrl(plansUrl.current);
      const purchase = new AbortController();
      const deadline = setTimeout(() => purchase.abort(), 120_000);
      const purchaseSignal = AbortSignal.any([signal, purchase.signal]);
      try {
        while (true) {
          await delay(5000, purchaseSignal);
          const info = await transport.getSubscriptionUserInfo({
            signal: purchaseSignal,
          });
          purchaseSignal.throwIfAborted();
          if (!info) {
            showError('session_changed');
            return;
          }
          const updated = confirmMembership(info, signal);
          setState(updated);
          if (updated.status === 'ready') return;
        }
      } catch (error) {
        if (signal.aborted) return;
        const details = errorDetails(error);
        if (details.retryAfterMs)
          retryAt.current = Date.now() + details.retryAfterMs;
        if (details.errorStage === 'credentials') {
          showFailure(error, 'userinfo');
          return;
        }
        if (
          details.code === 'session_changed' ||
          (details.code === 'invalid_grant' &&
            details.errorStage === 'refresh') ||
          details.errorStatus === 401
        ) {
          showError('session_changed');
          return;
        }
        setState((current) =>
          current.status === 'purchase-required'
            ? {
                ...current,
                canCheckAgain: true,
                message: purchase.signal.aborted
                  ? copy.current.purchaseTimeout
                  : (details.errorStage === 'refresh'
                      ? copy.current.refresh
                      : copy.current.queryFailed) +
                    (details.errorStatus === 429
                      ? ' ' + copy.current.rateLimited
                      : ''),
              }
            : current,
        );
      } finally {
        clearTimeout(deadline);
      }
    };
    const run = async () => {
      const config = await transport.getSubscriptionConfig({ signal });
      signal.throwIfAborted();
      if (!config.enabled || !config.plansUrl) throw new Error('disabled');
      plansUrl.current = config.plansUrl;
      let flow = await transport.startSubscriptionLogin();
      if (signal.aborted) {
        cancelFlow(flow.id);
        return;
      }
      flowId = flow.id;
      while (flow.status === 'waiting') {
        if (flow.authorizationUrl) {
          setState({
            status: 'waiting',
            authorizationUrl: flow.authorizationUrl,
          });
          if (openedUrl !== flow.authorizationUrl) {
            openedUrl = flow.authorizationUrl;
            openUrl(openedUrl);
          }
        }
        await delay(1000, signal);
        flow = await transport.getSubscriptionLogin(flowId, { signal });
        signal.throwIfAborted();
      }
      if (flow.status !== 'ready' || !flow.userInfo) {
        showError(
          flow.errorCode,
          flow.errorStage,
          flow.errorStatus,
          flow.retryAfterMs,
        );
        return;
      }
      const next = confirmMembership(flow.userInfo, signal);
      setState(next);
      if (next.status !== 'purchase-required') return;
      await startPurchase.current();
    };
    void run().catch((error: unknown) => {
      if (!signal.aborted) showFailure(error);
    });
    return () => {
      mounted.current = false;
      controller.abort();
      if (flowId) cancelFlow(flowId);
    };
  }, [transport, attempt, showError, showFailure, confirmMembership]);

  const retry = () => {
    if (busy.current || signingOut.current || Date.now() < retryAt.current)
      return;
    const current = stateRef.current;
    if (current.status === 'error' && current.retry === 'authorization') {
      setAttempt((value) => value + 1);
      return;
    }
    const signal = lifetime.current?.signal;
    if (
      !(
        current.status === 'query-error' ||
        (current.status === 'purchase-required' && current.canCheckAgain)
      ) ||
      !signal ||
      signal.aborted
    )
      return;
    busy.current = true;
    setState({ ...current, checking: true });
    void transport
      .getSubscriptionUserInfo({ signal })
      .then((info) => {
        signal.throwIfAborted();
        if (!info) {
          showError('session_changed');
          return;
        }
        const next = confirmMembership(info, signal);
        if (current.status === 'query-error') {
          setState(next);
          if (next.status === 'purchase-required') void startPurchase.current();
          return;
        }
        setState(
          next.status === 'purchase-required'
            ? { ...next, canCheckAgain: true, message: copy.current.notActive }
            : next,
        );
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        const details = errorDetails(error);
        if (details.retryAfterMs)
          retryAt.current = Date.now() + details.retryAfterMs;
        if (
          current.status === 'query-error' ||
          details.errorStage === 'credentials' ||
          details.code === 'session_changed' ||
          (details.code === 'invalid_grant' &&
            details.errorStage === 'refresh') ||
          details.errorStatus === 401
        )
          showFailure(error, 'userinfo');
        else
          setState({
            ...current,
            checking: false,
            message:
              (details.errorStage === 'refresh'
                ? copy.current.refresh
                : copy.current.queryFailed) +
              (details.errorStatus === 429
                ? ' ' + copy.current.rateLimited
                : ''),
          });
      })
      .finally(() => {
        if (lifetime.current?.signal === signal) busy.current = false;
      });
  };

  const signOut = async (): Promise<boolean> => {
    if (signingOut.current) return false;
    const owner = lifetime.current;
    signingOut.current = true;
    owner?.abort();
    setWorking(true);
    try {
      await transport.signOutSubscription();
      return mounted.current && lifetime.current === owner;
    } catch (error) {
      if (mounted.current && lifetime.current === owner)
        showFailure(error, 'cleanup');
      return false;
    } finally {
      if (lifetime.current === owner) {
        signingOut.current = false;
        if (mounted.current) setWorking(false);
      }
    }
  };

  const expire = useCallback((message?: string) => {
    lifetime.current?.abort();
    confirmedMembership.current = undefined;
    setState({
      status: 'error',
      message: message ?? copy.current.expired,
      retry: 'authorization',
    });
  }, []);

  return {
    state,
    readySignal:
      state.status === 'ready' &&
      confirmedMembership.current?.transport === transport &&
      !confirmedMembership.current.signal.aborted
        ? confirmedMembership.current.signal
        : undefined,
    working,
    expire,
    retry,
    signOut,
    openAuthorization: openUrl,
    openPlans: () => openUrl(plansUrl.current),
  };
}
