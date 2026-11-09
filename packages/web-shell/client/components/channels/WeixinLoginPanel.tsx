/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DaemonWeixinAccountStatus,
  DaemonWeixinLoginFlow,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { extractErrorDetail } from '../../utils/errorDetail';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import styles from './ChannelEditorDialog.module.css';

/** Injected so the editor stays testable without a workspace provider. */
export interface WeixinLoginApi {
  status: () => Promise<DaemonWeixinAccountStatus | undefined>;
  start: () => Promise<DaemonWeixinLoginFlow | undefined>;
  poll: (id: string) => Promise<DaemonWeixinLoginFlow | undefined>;
  cancel: (id: string) => Promise<void>;
  revoke: () => Promise<void>;
}

const POLL_INTERVAL_MS = 1500;

function isTerminal(status: DaemonWeixinLoginFlow['status']): boolean {
  return status === 'ready' || status === 'expired' || status === 'error';
}

const STATUS_KEYS: Record<DaemonWeixinLoginFlow['status'], string> = {
  waiting: 'channels.weixin.waiting',
  scanned: 'channels.weixin.scanned',
  ready: 'channels.weixin.ready',
  expired: 'channels.weixin.expired',
  error: 'channels.weixin.error',
};

export function WeixinLoginPanel({ api }: { api: WeixinLoginApi }) {
  const { t } = useI18n();
  const [account, setAccount] = useState<DaemonWeixinAccountStatus>();
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [flow, setFlow] = useState<DaemonWeixinLoginFlow>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The panel unmounts when the editor closes; a poll in flight must not set
  // state on a dead component, and must not keep the interval alive.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // The poll timer must not depend on the api object's identity: the host
  // rebuilds it on re-render, and an effect keyed on it would clear and
  // restart the timer every time, so the poll could never fire.
  const apiRef = useRef(api);
  apiRef.current = api;
  // The daemon keeps a flow alive on its own: it holds a slot and polls the
  // upstream whether or not this panel is on screen. Closing the editor must
  // therefore drop the flow explicitly, or four abandoned attempts exhaust the
  // cap and real logins get 429 until those flows time out.
  const liveFlowRef = useRef<string | undefined>(undefined);
  liveFlowRef.current = flow && !isTerminal(flow.status) ? flow.id : undefined;
  useEffect(
    () => () => {
      const id = liveFlowRef.current;
      // Nobody is left to show a failure to; the flow expires on its own.
      if (id) void apiRef.current.cancel(id).catch(() => undefined);
    },
    [],
  );

  const reloadAccount = useCallback(async () => {
    try {
      const status = await apiRef.current.status();
      if (!mountedRef.current) return;
      setUnsupported(status === undefined);
      setAccount(status);
    } catch (failure) {
      if (mountedRef.current) setError(extractErrorDetail(failure));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadAccount();
  }, [reloadAccount]);

  const flowId = flow?.id;
  useEffect(() => {
    if (!flowId) return;
    let ignore = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Self-rescheduling, and keyed on the flow id only. A one-shot timer keyed
    // on the status would stop after the first poll whenever the daemon
    // reports the same status twice — which is the normal case while the
    // operator has not scanned yet.
    const tick = () => {
      timer = setTimeout(() => {
        void apiRef.current
          .poll(flowId)
          .then((next) => {
            if (ignore || !mountedRef.current) return;
            // A 404 means the daemon dropped the flow (cancel, revoke, restart).
            if (!next) {
              setFlow(undefined);
              void reloadAccount();
              return;
            }
            setFlow(next);
            setError(undefined);
            if (isTerminal(next.status)) {
              if (next.status === 'ready') void reloadAccount();
              return;
            }
            tick();
          })
          .catch((failure: unknown) => {
            if (ignore || !mountedRef.current) return;
            setError(extractErrorDetail(failure));
            // Keep trying: a transient failure must not strand the panel. The
            // flow is still non-terminal, so no refresh button is rendered,
            // and stopping here would leave the operator no way to retry.
            // The daemon drops finished flows, so this ends in a 404 above.
            tick();
          });
      }, POLL_INTERVAL_MS);
    };
    tick();
    return () => {
      ignore = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [flowId, reloadAccount]);

  const startLogin = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await apiRef.current.start();
      if (!mountedRef.current) return;
      if (!next) {
        setUnsupported(true);
        return;
      }
      setFlow(next);
    } catch (failure) {
      if (mountedRef.current) setError(extractErrorDetail(failure));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, []);

  const logout = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      await apiRef.current.revoke();
      if (!mountedRef.current) return;
      setFlow(undefined);
      await reloadAccount();
    } catch (failure) {
      if (mountedRef.current) setError(extractErrorDetail(failure));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [reloadAccount]);

  if (loading) {
    return (
      <div role="status" aria-label={t('channels.weixin.title')}>
        <Spinner />
      </div>
    );
  }

  if (unsupported) {
    return (
      <Alert>
        <AlertDescription>{t('channels.weixin.unsupported')}</AlertDescription>
      </Alert>
    );
  }

  const showQr = flow !== undefined && !isTerminal(flow.status);
  const needsRetry =
    flow !== undefined &&
    (flow.status === 'expired' || flow.status === 'error');

  return (
    <div className={styles.weixinPanel} data-testid="weixin-login-panel">
      <div className={styles.weixinStatusRow}>
        <span className={styles.weixinStatusLabel}>
          {t(
            account?.configured
              ? 'channels.weixin.loggedIn'
              : 'channels.weixin.loggedOut',
          )}
        </span>
        {account?.configured && account.userId ? (
          <span className={styles.weixinStatusMeta}>
            {t('channels.weixin.userId', { id: account.userId })}
          </span>
        ) : null}
        {account?.configured && account.savedAt ? (
          <span className={styles.weixinStatusMeta}>
            {t('channels.weixin.savedAt', { time: account.savedAt })}
          </span>
        ) : null}
      </div>

      <p className={styles.weixinHint}>{t('channels.weixin.description')}</p>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {flow ? (
        <p role="status" className={styles.weixinHint}>
          {t(STATUS_KEYS[flow.status])}
        </p>
      ) : null}

      {showQr && flow?.qrText ? (
        <pre
          // CJK font fallback gives block glyphs a different width than spaces.
          lang="en"
          aria-label={t('channels.weixin.qrAlt')}
          className="w-fit overflow-hidden rounded-lg bg-white p-3 font-mono text-[7px] leading-[7px] tracking-normal text-black select-none"
        >
          {flow.qrText}
        </pre>
      ) : null}

      {showQr && !flow?.qrText && flow?.qrcodeUrl ? (
        // The encoder can fail on an over-capacity URL; the raw link still
        // completes the login.
        <a
          href={flow.qrcodeUrl}
          target="_blank"
          rel="noreferrer"
          className={styles.weixinLink}
        >
          {t('channels.weixin.openUrl')}
        </a>
      ) : null}

      {account?.configured ? (
        <p className={styles.weixinHint}>{t('channels.weixin.restartHint')}</p>
      ) : null}

      <div className={styles.weixinActions}>
        {showQr ? null : needsRetry ? (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void startLogin()}
          >
            {busy ? <Spinner /> : null}
            {t('channels.weixin.refresh')}
          </Button>
        ) : account?.configured ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void startLogin()}
            >
              {busy ? <Spinner /> : null}
              {t('channels.weixin.relogin')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void logout()}
            >
              {t('channels.weixin.logout')}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void startLogin()}
          >
            {busy ? <Spinner /> : null}
            {t('channels.weixin.login')}
          </Button>
        )}
      </div>
    </div>
  );
}
