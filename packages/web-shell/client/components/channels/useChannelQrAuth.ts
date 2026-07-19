/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DaemonHttpError,
  type DaemonChannelAuthBeginRequest,
  type DaemonChannelAuthCancelResult,
  type DaemonChannelAuthCommitRequest,
  type DaemonChannelAuthSession,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';

export interface ChannelQrAuthActions {
  begin: (
    name: string,
    request: DaemonChannelAuthBeginRequest,
  ) => Promise<DaemonChannelAuthSession>;
  status: (
    name: string,
    sessionId: string,
  ) => Promise<DaemonChannelAuthSession>;
  qr: (name: string, sessionId: string) => Promise<Blob>;
  cancel: (
    name: string,
    sessionId: string,
  ) => Promise<DaemonChannelAuthCancelResult>;
  commit: (
    name: string,
    sessionId: string,
    request: DaemonChannelAuthCommitRequest,
  ) => Promise<unknown>;
}

interface UseChannelQrAuthOptions {
  open: boolean;
  identity: object;
  name: string;
  channelType: string;
  actions: ChannelQrAuthActions;
}

interface ActiveOperation {
  generation: number;
  actions: ChannelQrAuthActions;
  name: string;
  channelType: string;
  session?: DaemonChannelAuthSession;
  cancelled: boolean;
  committed: boolean;
}

export interface UseChannelQrAuthResult {
  session?: DaemonChannelAuthSession;
  qrUrl?: string;
  error?: string;
  unavailable: boolean;
  busy: 'begin' | 'commit' | 'retry' | null;
  remainingSeconds?: number;
  canRetry: boolean;
  retry: () => Promise<void>;
  commit: () => Promise<void>;
  close: () => void;
}

const POLL_INTERVAL_MS = 1_000;
const MAX_COUNTDOWN_SECONDS = 10 * 60;

function isPollingState(state: DaemonChannelAuthSession['state']): boolean {
  return (
    state === 'requesting' ||
    state === 'awaiting_scan' ||
    state === 'scanned' ||
    state === 'refreshing'
  );
}

function requiresQr(state: DaemonChannelAuthSession['state']): boolean {
  return (
    state === 'awaiting_scan' || state === 'scanned' || state === 'refreshing'
  );
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof DaemonHttpError)) return undefined;
  const body = error.body as { code?: unknown } | undefined;
  return typeof body?.code === 'string' ? body.code : undefined;
}

function isUnavailable(error: unknown): boolean {
  return (
    (error instanceof DaemonHttpError && error.status === 404) ||
    errorCode(error) === 'channel_auth_session_not_found' ||
    errorCode(error) === 'channel_auth_client_required' ||
    errorCode(error) === 'invalid_client_id'
  );
}

function isRetryableFailure(error: unknown): boolean {
  if (isUnavailable(error)) return false;
  if (!(error instanceof DaemonHttpError)) return true;
  const code = errorCode(error);
  if (
    code === 'channel_auth_unsupported' ||
    code === 'channel_auth_instance_mismatch' ||
    code === 'channel_auth_in_progress' ||
    code === 'channel_auth_not_ready' ||
    code === 'channel_auth_already_committed'
  ) {
    return false;
  }
  return error.status >= 500 || code === 'channel_auth_qr_unavailable';
}

function secondsUntil(expiresAt: string): number | undefined {
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(
    0,
    Math.min(MAX_COUNTDOWN_SECONDS, Math.ceil((timestamp - Date.now()) / 1000)),
  );
}

export function useChannelQrAuth({
  open,
  identity,
  name,
  channelType,
  actions,
}: UseChannelQrAuthOptions): UseChannelQrAuthResult {
  const { t } = useI18n();
  const [session, setSession] = useState<DaemonChannelAuthSession | undefined>(
    undefined,
  );
  const [qrUrl, setQrUrl] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [unavailable, setUnavailable] = useState(false);
  const [retryableFailure, setRetryableFailure] = useState(false);
  const [busy, setBusy] = useState<UseChannelQrAuthResult['busy']>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number | undefined>(
    undefined,
  );
  const [attempt, setAttempt] = useState(0);
  const generationRef = useRef(0);
  const operationRef = useRef<ActiveOperation | undefined>(undefined);
  const objectUrlRef = useRef<string | undefined>(undefined);
  const mountedRef = useRef(true);

  const revokeQr = useCallback((updateState = true) => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = undefined;
    }
    if (updateState && mountedRef.current) setQrUrl(undefined);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      revokeQr(false);
    };
  }, [revokeQr]);

  useEffect(() => {
    if (!open) {
      setRemainingSeconds(undefined);
      return;
    }
    const expiresAt = session?.expiresAt;
    if (!expiresAt) {
      setRemainingSeconds(undefined);
      return;
    }
    const update = () => setRemainingSeconds(secondsUntil(expiresAt));
    update();
    const timer = window.setInterval(update, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [open, session?.expiresAt]);

  useEffect(() => {
    const generation = ++generationRef.current;
    let disposed = false;
    let pollTimer: number | undefined;
    let loadedQrRevision: number | undefined;
    const operation: ActiveOperation = {
      generation,
      actions,
      name,
      channelType,
      cancelled: false,
      committed: false,
    };
    operationRef.current = operation;

    const current = () =>
      !disposed &&
      mountedRef.current &&
      generationRef.current === generation &&
      operationRef.current === operation;

    const cancel = () => {
      if (
        !operation.session ||
        operation.cancelled ||
        operation.committed ||
        operation.session.state === 'committed' ||
        operation.session.state === 'cancelled'
      ) {
        return;
      }
      operation.cancelled = true;
      void operation.actions
        .cancel(operation.name, operation.session.id)
        .catch(() => undefined);
    };

    const fail = (cause: unknown, fallback: string) => {
      if (!current()) return;
      revokeQr();
      setUnavailable(isUnavailable(cause));
      setRetryableFailure(isRetryableFailure(cause));
      setError(
        isUnavailable(cause) ? t('channels.auth.error.unavailable') : fallback,
      );
      setBusy(null);
    };

    const loadQr = async (next: DaemonChannelAuthSession) => {
      if (!requiresQr(next.state) || next.qrRevision <= 0) {
        revokeQr();
        loadedQrRevision = undefined;
        return true;
      }
      if (loadedQrRevision === next.qrRevision) return true;
      revokeQr();
      loadedQrRevision = next.qrRevision;
      try {
        const blob = await operation.actions.qr(operation.name, next.id);
        if (!current()) return false;
        if (!blob.type.toLowerCase().startsWith('image/')) {
          fail(undefined, t('channels.auth.error.qrLoad'));
          return false;
        }
        const url = URL.createObjectURL(blob);
        if (!current()) {
          URL.revokeObjectURL(url);
          return false;
        }
        objectUrlRef.current = url;
        setQrUrl(url);
        return true;
      } catch (cause) {
        fail(cause, t('channels.auth.error.qrLoad'));
        return false;
      }
    };

    const schedulePoll = (next: DaemonChannelAuthSession) => {
      if (!current() || !isPollingState(next.state)) return;
      pollTimer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };

    const accept = async (next: DaemonChannelAuthSession) => {
      if (!current()) return;
      operation.session = next;
      setSession(next);
      setError(undefined);
      setUnavailable(false);
      setRetryableFailure(false);
      setBusy(null);
      if (await loadQr(next)) schedulePoll(next);
    };

    const poll = async () => {
      const activeSession = operation.session;
      if (!current() || !activeSession || !isPollingState(activeSession.state))
        return;
      try {
        await accept(
          await operation.actions.status(operation.name, activeSession.id),
        );
      } catch (cause) {
        fail(cause, t('channels.auth.error.statusRefresh'));
      }
    };

    const begin = async () => {
      await Promise.resolve();
      if (!current()) return;
      try {
        const next = await operation.actions.begin(operation.name, {
          channelType: operation.channelType,
        });
        if (!current()) {
          if (next.state !== 'committed' && next.state !== 'cancelled') {
            void operation.actions
              .cancel(operation.name, next.id)
              .catch(() => undefined);
          }
          return;
        }
        await accept(next);
      } catch (cause) {
        fail(cause, t('channels.auth.error.start'));
      }
    };

    if (open) {
      revokeQr();
      setSession(undefined);
      setError(undefined);
      setUnavailable(false);
      setRetryableFailure(false);
      setBusy(attempt === 0 ? 'begin' : 'retry');
      void begin();
    } else {
      revokeQr();
      setSession(undefined);
      setError(undefined);
      setUnavailable(false);
      setRetryableFailure(false);
      setBusy(null);
    }

    return () => {
      disposed = true;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      cancel();
      revokeQr(false);
    };
  }, [actions, attempt, channelType, identity, name, open, revokeQr, t]);

  const close = useCallback(() => {
    const operation = operationRef.current;
    if (
      operation?.session &&
      !operation.cancelled &&
      !operation.committed &&
      operation.session.state !== 'committed' &&
      operation.session.state !== 'cancelled'
    ) {
      operation.cancelled = true;
      void operation.actions
        .cancel(operation.name, operation.session.id)
        .catch(() => undefined);
    }
    revokeQr();
  }, [revokeQr]);

  const retry = useCallback(async () => {
    const operation = operationRef.current;
    if (!operation || busy !== null) return;
    const retryable =
      retryableFailure ||
      operation.session?.state === 'requesting' ||
      operation.session?.state === 'expired' ||
      operation.session?.state === 'error';
    if (!retryable) return;
    setBusy('retry');
    if (operation.session && !operation.cancelled && !operation.committed) {
      operation.cancelled = true;
      try {
        await operation.actions.cancel(operation.name, operation.session.id);
      } catch {
        // Cancellation is an idempotent tombstone attempt; begin decides
        // whether a replacement session can safely start.
      }
    }
    if (
      mountedRef.current &&
      operationRef.current === operation &&
      generationRef.current === operation.generation
    ) {
      setAttempt((value) => value + 1);
    }
  }, [busy, retryableFailure]);

  const commit = useCallback(async () => {
    const operation = operationRef.current;
    if (
      !operation?.session ||
      operation.session.state !== 'ready' ||
      operation.committed ||
      busy !== null
    ) {
      return;
    }
    setBusy('commit');
    try {
      await operation.actions.commit(operation.name, operation.session.id, {
        channelType: operation.channelType,
      });
      if (
        !mountedRef.current ||
        operationRef.current !== operation ||
        generationRef.current !== operation.generation
      ) {
        return;
      }
      operation.committed = true;
      operation.session = { ...operation.session, state: 'committed' };
      setSession(operation.session);
      revokeQr();
      setError(undefined);
    } catch (cause) {
      if (
        mountedRef.current &&
        operationRef.current === operation &&
        generationRef.current === operation.generation
      ) {
        setUnavailable(isUnavailable(cause));
        setRetryableFailure(isRetryableFailure(cause));
        setError(
          isUnavailable(cause)
            ? t('channels.auth.error.unavailable')
            : t('channels.auth.error.save'),
        );
      }
    } finally {
      if (
        mountedRef.current &&
        operationRef.current === operation &&
        generationRef.current === operation.generation
      ) {
        setBusy(null);
      }
    }
  }, [busy, revokeQr, t]);

  const canRetry =
    !unavailable &&
    busy === null &&
    (retryableFailure ||
      session?.state === 'requesting' ||
      session?.state === 'expired' ||
      session?.state === 'error');

  return {
    session,
    qrUrl,
    error,
    unavailable,
    busy,
    remainingSeconds,
    canRetry,
    retry,
    commit,
    close,
  };
}
