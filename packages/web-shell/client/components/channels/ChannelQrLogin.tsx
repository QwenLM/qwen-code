/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircleIcon,
  CheckIcon,
  QrCodeIcon,
  RefreshCwIcon,
} from 'lucide-react';
import type { DaemonChannelQrLoginView } from '@qwen-code/sdk/daemon';
import type { DaemonChannelQrLoginActions } from '../../daemon/workspace/types';
import { useI18n } from '../../i18n';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import styles from './ChannelQrLogin.module.css';

/** How often the panel asks the daemon for the session state. */
const POLL_INTERVAL_MS = 2_000;

export interface ChannelQrLoginProps {
  channelName: string;
  actions: DaemonChannelQrLoginActions;
  /** Called once a bind succeeds so the editor can reload the channel. */
  onBound: () => void;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const body = (error as { body?: unknown }).body;
  if (!body || typeof body !== 'object') return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function ChannelQrLogin({
  channelName,
  actions,
  onBound,
}: ChannelQrLoginProps) {
  const { t } = useI18n();
  const [view, setView] = useState<DaemonChannelQrLoginView | undefined>(
    undefined,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  const boundFor = useRef<string | undefined>(undefined);
  const ownedLoginRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A different channel must not inherit the previous session's code.
  useEffect(() => {
    setView(undefined);
    setError(undefined);
    boundFor.current = undefined;
    ownedLoginRef.current = undefined;
  }, [channelName]);

  const loginId = view?.status === 'pending' ? view.loginId : undefined;

  // The daemon keeps a login alive on its own: it holds one of the workspace's
  // four slots and polls Tencent whether or not this panel is on screen.
  // Closing the editor must therefore drop the session explicitly, or four
  // abandoned attempts reject every real bind until those sessions time out.
  //
  // Only a login this panel CREATED is ours to drop. The web shell sends no
  // client id on these routes, so the daemon reattaches across tabs and
  // browsers (`undefined === undefined`) and hands back a peer's `loginId`
  // with `attached: true`; cancelling that would pull the code out from under
  // another operator. Ownership is recorded where the id is learned, not
  // derived from what is on screen.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const pendingLoginRef = useRef<string | undefined>(undefined);
  pendingLoginRef.current = loginId;
  // The refs keep the unmount-only cleanup off the render-time identities: an
  // effect keyed on `actions` or the id would also fire on every change and
  // cancel a login the operator is still waiting on. Both conditions matter —
  // still pending, so a finished bind is left alone, and created here, so a
  // peer's reattached login is left alone.
  useEffect(
    () => () => {
      const id = pendingLoginRef.current;
      // Nobody is left to show a failure to; the session expires on its own.
      if (id && id === ownedLoginRef.current) {
        void actionsRef.current.cancel(id).catch(() => undefined);
      }
    },
    [],
  );

  useEffect(() => {
    if (!loginId) return;
    let active = true;
    const timer = setInterval(() => {
      void actions.state(loginId).then(
        (next) => {
          if (active && mounted.current) setView(next);
        },
        (pollError: unknown) => {
          if (!active || !mounted.current) return;
          // Only a genuinely missing session is terminal. A transient failure
          // must not report 'expired' for a login the daemon still holds, or
          // one network blip would kill a live binding.
          if (errorCode(pollError) === 'channel_qr_login_not_found') {
            setView((current) =>
              current ? { ...current, status: 'expired' } : current,
            );
            return;
          }
          setError(t('channels.qrLogin.error'));
        },
      );
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [actions, loginId, t]);

  useEffect(() => {
    if (view?.status !== 'succeeded') return;
    if (boundFor.current === view.loginId) return;
    boundFor.current = view.loginId;
    onBound();
  }, [onBound, view]);

  const start = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // The daemon reattaches a pending login for the same channel and returns
      // the identical view, so asking again without cancelling would leave the
      // stale code and its original deadline on screen. Cancel first so a retry
      // really produces a new code, and so it does not consume a second slot.
      if (loginId) await actions.cancel(loginId);
      const result = await actions.start(channelName);
      // Ownership is learned here, where the daemon says whether it minted a
      // login or reattached a peer's — never inferred from what is on screen.
      const owned = !result.attached && result.status === 'pending';
      ownedLoginRef.current = owned ? result.loginId : undefined;
      if (mounted.current) {
        setView(result);
      } else if (owned) {
        // The login was created after the panel went away, so the unmount
        // cleanup never saw its id and it would hold a slot and poll Tencent
        // for its whole deadline with nobody watching — the same leak, in the
        // window a user hits by pressing Scan and immediately closing the
        // editor. Cancel is a no-op for a terminal entry, so this cannot undo
        // a bind the daemon already committed.
        void actions.cancel(result.loginId).catch(() => undefined);
      }
    } catch (startError) {
      if (mounted.current) {
        setError(
          startError instanceof Error
            ? startError.message
            : t('channels.qrLogin.error'),
        );
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [actions, busy, channelName, loginId, t]);

  const cancel = useCallback(async () => {
    if (!loginId || busy) return;
    setBusy(true);
    try {
      const next = await actions.cancel(loginId);
      if (mounted.current) setView(next);
    } catch {
      if (mounted.current) setError(t('channels.qrLogin.error'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [actions, busy, loginId, t]);

  const status = view?.status;

  return (
    <section className={styles.panel} aria-label={t('channels.qrLogin.title')}>
      <div className={styles.header}>
        <div>
          <h4 className={styles.title}>{t('channels.qrLogin.title')}</h4>
          <p className={styles.description}>
            {t('channels.qrLogin.description')}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant={status === 'pending' ? 'outline' : 'default'}
          disabled={busy}
          onClick={() => void start()}
        >
          {busy ? <Spinner /> : <QrCodeIcon />}
          {status === 'pending'
            ? t('channels.qrLogin.refresh')
            : t('channels.qrLogin.start')}
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>{t('channels.qrLogin.error')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {status === 'pending' ? (
        <div className={styles.codeArea}>
          {view?.qrCodeDataUrl ? (
            <img
              className={styles.code}
              src={view.qrCodeDataUrl}
              alt={t('channels.qrLogin.imageAlt')}
              width={240}
              height={240}
            />
          ) : (
            <div className={styles.waiting}>
              <Spinner />
              {t('channels.qrLogin.waiting')}
            </div>
          )}
          <p className={styles.hint}>{t('channels.qrLogin.scanHint')}</p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void cancel()}
          >
            {t('channels.editor.cancel')}
          </Button>
        </div>
      ) : null}

      {status === 'succeeded' ? (
        <div role="status" className={styles.success}>
          <CheckIcon />
          {t('channels.qrLogin.bound')}
        </div>
      ) : null}

      {status === 'failed' ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>{t('channels.qrLogin.failed')}</AlertTitle>
          <AlertDescription>
            {view?.error ?? t('channels.qrLogin.error')}
          </AlertDescription>
        </Alert>
      ) : null}

      {status === 'expired' || status === 'cancelled' ? (
        <div className={styles.notice}>
          <RefreshCwIcon />
          {status === 'expired'
            ? t('channels.qrLogin.expired')
            : t('channels.qrLogin.cancelled')}
        </div>
      ) : null}
    </section>
  );
}
