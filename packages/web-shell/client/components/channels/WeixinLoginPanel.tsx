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
import { useExternalLinkOpener } from '../../hooks/useExternalLinkOpener';
import { extractErrorDetail } from '../../utils/errorDetail';
import { formatDateTime } from '../../utils/formatDateTime';
import { isSafeHref } from '../messages/Markdown';
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

/** Pinned against the daemon's abandonment bound by `weixin-auth.test.ts`. */
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
  const openExternalLink = useExternalLinkOpener();
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

  // Account reads race each other: the `ready` poll fires one without awaiting
  // it, so a GET that read the credential before a logout can resolve after
  // the logout's own refresh and paint "Logged in" over a revoked account.
  // Only the newest read may write.
  const accountReadRef = useRef(0);
  const reloadAccount = useCallback(async () => {
    const generation = ++accountReadRef.current;
    try {
      const status = await apiRef.current.status();
      if (!mountedRef.current || generation !== accountReadRef.current) return;
      setUnsupported(status === undefined);
      setAccount(status);
    } catch (failure) {
      if (mountedRef.current && generation === accountReadRef.current) {
        setError(extractErrorDetail(failure));
      }
    } finally {
      if (mountedRef.current && generation === accountReadRef.current) {
        setLoading(false);
      }
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
              // The alert names a flow that no longer exists; leaving it up
              // would contradict the healthy account view underneath it.
              setError(undefined);
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
    // Retrying from the re-mint window replaces a flow that is still live. The
    // daemon keeps polling the one it replaces, so drop it explicitly.
    const previous = liveFlowRef.current;
    setBusy(true);
    setError(undefined);
    try {
      const next = await apiRef.current.start();
      if (!mountedRef.current) {
        // The flow was created after the panel went away, so the unmount
        // cleanup never saw its id and it would poll the upstream for its whole
        // deadline with nobody watching — the same leak, in the window a user
        // hits by clicking login and immediately closing the dialog.
        if (next && !isTerminal(next.status)) {
          void apiRef.current.cancel(next.id).catch(() => undefined);
        }
        return;
      }
      if (!next) {
        setUnsupported(true);
        return;
      }
      setFlow(next);
      if (previous && previous !== next.id) {
        void apiRef.current.cancel(previous).catch(() => undefined);
      }
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
      // The credential is gone as of the 204. Paint that known state before
      // re-reading, so a failed refresh cannot leave "Logged in" on screen
      // over an account that no longer exists.
      setAccount({ enabled: true, configured: false });
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

  const safeQrUrl =
    flow?.qrcodeUrl && isSafeHref(flow.qrcodeUrl) ? flow.qrcodeUrl : undefined;
  const live = flow !== undefined && !isTerminal(flow.status);
  // "Non-terminal" is not "scannable": after an expiry the daemon publishes a
  // QR-less view while it mints the replacement. Showing the scan prompt there
  // would ask the operator to scan nothing, with no control to act on.
  const showQr = live && Boolean(flow?.qrText || safeQrUrl);
  const preparing = live && !showQr;
  // A credential the daemon could not write is a local fault, so it gets its
  // own copy rather than the generic upstream-failure wording. It still offers
  // the primary action: the flow is terminal and occupies no slot, so a retry
  // after the operator fixes the directory costs nothing.
  const credentialsFailure = flow?.errorCode === 'credentials_error';
  const needsRetry =
    flow !== undefined &&
    !credentialsFailure &&
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
            {t('channels.weixin.savedAt', {
              time: formatDateTime(account.savedAt),
            })}
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
          {t(
            credentialsFailure
              ? 'channels.weixin.credentialsError'
              : preparing
                ? 'channels.weixin.preparing'
                : STATUS_KEYS[flow.status],
          )}
        </p>
      ) : null}

      {showQr && flow?.qrText ? (
        <pre
          // CJK font fallback gives block glyphs a different width than spaces.
          lang="en"
          // A bare <pre> maps to the generic role, whose accessible name is
          // prohibited — without role="img" the label is dropped and a screen
          // reader reads out every block glyph instead.
          role="img"
          aria-label={t('channels.weixin.qrAlt')}
          className="w-fit overflow-hidden rounded-lg bg-white p-3 font-mono text-[7px] leading-[7px] tracking-normal text-black select-none"
        >
          {flow.qrText}
        </pre>
      ) : null}

      {showQr && !flow?.qrText && safeQrUrl ? (
        // The encoder can fail on an over-capacity URL; the raw link still
        // completes the login. This is exactly the branch a pathological
        // upstream value lands in, so it is gated like every other
        // daemon-supplied URL in this client.
        <a
          href={safeQrUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.weixinLink}
          onClick={(click) => openExternalLink(click, safeQrUrl)}
        >
          {t('channels.weixin.openUrl')}
        </a>
      ) : null}

      {account?.configured ? (
        <p className={styles.weixinHint}>{t('channels.weixin.restartHint')}</p>
      ) : null}

      <div className={styles.weixinActions}>
        {showQr ? null : needsRetry || preparing ? (
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
        {/* Outside the retry ternary on purpose: a relogin that ends in
            expiry or error must not take away the only control that can
            revoke a credential that is still installed. */}
        {account?.configured ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void logout()}
          >
            {t('channels.weixin.logout')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
