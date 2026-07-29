/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useId, useRef, useState } from 'react';
import {
  AlertCircleIcon,
  CheckIcon,
  RefreshCwIcon,
  UsersRoundIcon,
} from 'lucide-react';
import type {
  DaemonChannelPairingApprovalResult,
  DaemonChannelPairingRequest,
  DaemonChannelPairingRequestsSnapshot,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { formatRelativeTime } from '../../utils/formatRelativeTime';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import styles from './ChannelPairingRequests.module.css';

export interface ChannelPairingRequestsProps {
  channelName: string;
  listRequests: (name: string) => Promise<DaemonChannelPairingRequestsSnapshot>;
  approveRequest: (
    name: string,
    code: string,
  ) => Promise<DaemonChannelPairingApprovalResult>;
}

function senderLabel(request: DaemonChannelPairingRequest): string {
  return request.senderName.trim() || request.senderId;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const body = (error as { body?: unknown }).body;
  if (!body || typeof body !== 'object') return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function pairingErrorDetail(error: unknown, unavailable: string): string {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return unavailable;
  }
  const body = (error as { body?: unknown }).body;
  const message =
    body && typeof body === 'object'
      ? (body as { error?: unknown }).error
      : undefined;
  return typeof message === 'string' && message ? message : unavailable;
}

export function ChannelPairingRequests({
  channelName,
  listRequests,
  approveRequest,
}: ChannelPairingRequestsProps) {
  const { t } = useI18n();
  const headingId = useId();
  const mounted = useRef(false);
  const currentChannelName = useRef(channelName);
  currentChannelName.current = channelName;
  const [requests, setRequests] = useState<DaemonChannelPairingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [approvingCode, setApprovingCode] = useState<string>();
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setRequests([]);
    setError(undefined);
    setSuccess(undefined);
    setApprovingCode(undefined);
    void listRequests(channelName).then(
      (snapshot) => {
        if (!active) return;
        setRequests(snapshot.requests);
        setLoading(false);
      },
      (loadError: unknown) => {
        if (!active) return;
        setError(
          pairingErrorDetail(
            loadError,
            t('channels.editor.pairing.unavailable'),
          ),
        );
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [channelName, listRequests, reloadToken, t]);

  const approve = async (request: DaemonChannelPairingRequest) => {
    if (approvingCode) return;
    const approvalChannel = channelName;
    setApprovingCode(request.code);
    setError(undefined);
    setSuccess(undefined);
    try {
      const result = await approveRequest(channelName, request.code);
      if (!mounted.current || currentChannelName.current !== approvalChannel) {
        return;
      }
      setRequests(result.requests);
      setSuccess(
        t('channels.editor.pairing.approved', {
          sender: senderLabel(result.approved),
        }),
      );
    } catch (approvalError) {
      if (!mounted.current || currentChannelName.current !== approvalChannel) {
        return;
      }
      if (errorCode(approvalError) === 'channel_pairing_request_not_found') {
        try {
          const snapshot = await listRequests(approvalChannel);
          if (
            mounted.current &&
            currentChannelName.current === approvalChannel
          ) {
            setRequests(snapshot.requests);
          }
        } catch (refreshError) {
          if (
            mounted.current &&
            currentChannelName.current === approvalChannel
          ) {
            setError(
              pairingErrorDetail(
                refreshError,
                t('channels.editor.pairing.unavailable'),
              ),
            );
          }
          return;
        }
      }
      if (!mounted.current || currentChannelName.current !== approvalChannel) {
        return;
      }
      setError(
        pairingErrorDetail(
          approvalError,
          t('channels.editor.pairing.unavailable'),
        ),
      );
    } finally {
      if (mounted.current && currentChannelName.current === approvalChannel) {
        setApprovingCode(undefined);
      }
    }
  };

  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <div className={styles.header}>
        <div>
          <h4 id={headingId} className={styles.title}>
            {t('channels.editor.pairing.title')}
          </h4>
          <p className={styles.description}>
            {t('channels.editor.pairing.description')}
          </p>
        </div>
        <div className={styles.headerActions}>
          <Badge variant="outline">{requests.length}</Badge>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={loading || Boolean(approvingCode)}
            aria-label={t('channels.editor.pairing.refresh')}
            onClick={() => {
              setSuccess(undefined);
              setReloadToken((current) => current + 1);
            }}
          >
            {loading ? <Spinner /> : <RefreshCwIcon />}
          </Button>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>{t('channels.editor.pairing.error')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
          <Button
            className="mt-2 w-fit"
            type="button"
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => setReloadToken((current) => current + 1)}
          >
            {t('channels.editor.pairing.retry')}
          </Button>
        </Alert>
      ) : null}

      {success ? (
        <div role="status" className={styles.success}>
          <CheckIcon />
          {success}
        </div>
      ) : null}

      {!loading && !error && requests.length === 0 ? (
        <div className={styles.empty}>
          <UsersRoundIcon aria-hidden="true" />
          <div>
            <p className={styles.emptyTitle}>
              {t('channels.editor.pairing.empty.title')}
            </p>
            <p className={styles.emptyDescription}>
              {t('channels.editor.pairing.empty.description')}
            </p>
          </div>
        </div>
      ) : null}

      {requests.length > 0 ? (
        <ul className={styles.list}>
          {requests.map((request) => {
            const label = senderLabel(request);
            return (
              <li key={request.code} className={styles.request}>
                <div className={styles.requestIdentity}>
                  <span className={styles.senderName}>{label}</span>
                  {label !== request.senderId ? (
                    <span className={styles.senderId}>{request.senderId}</span>
                  ) : null}
                  <span className={styles.requestTime}>
                    {formatRelativeTime(
                      new Date(request.createdAt).toISOString(),
                      t,
                    )}
                  </span>
                </div>
                <code className={styles.code}>{request.code}</code>
                <Button
                  type="button"
                  size="sm"
                  disabled={Boolean(approvingCode)}
                  aria-label={t('channels.editor.pairing.approveFor', {
                    sender: label,
                    code: request.code,
                  })}
                  onClick={() => void approve(request)}
                >
                  {approvingCode === request.code ? <Spinner /> : null}
                  {t('channels.editor.pairing.approve')}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
