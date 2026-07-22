/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2Icon, RefreshCwIcon } from 'lucide-react';
import type {
  DaemonChannelPairingApprovalResult,
  DaemonChannelPairingRequest,
  DaemonChannelPairingRequestsSnapshot,
} from '@qwen-code/sdk/daemon';
import { extractErrorDetail } from '../../utils/errorDetail';
import { useI18n } from '../../i18n';
import { Alert, AlertDescription } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import styles from './ChannelsManagerPage.module.css';

export interface ChannelPairingManagerProps {
  channelName: string;
  canManage: boolean;
  list: (name: string) => Promise<DaemonChannelPairingRequestsSnapshot>;
  approve: (
    name: string,
    code: string,
  ) => Promise<DaemonChannelPairingApprovalResult>;
}

function ageInMinutes(createdAt: number): number {
  return Math.max(0, Math.floor((Date.now() - createdAt) / 60_000));
}

export function ChannelPairingManager({
  channelName,
  canManage,
  list,
  approve,
}: ChannelPairingManagerProps) {
  const { t } = useI18n();
  const [requests, setRequests] = useState<DaemonChannelPairingRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [approvingCode, setApprovingCode] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [approvedSender, setApprovedSender] = useState<string>();
  const loadSequence = useRef(0);

  const refresh = useCallback(async () => {
    if (!canManage) return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await list(channelName);
      if (sequence === loadSequence.current) setRequests(result.requests);
    } catch (loadError) {
      if (sequence === loadSequence.current) {
        setError(extractErrorDetail(loadError));
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [canManage, channelName, list]);

  useEffect(() => {
    setRequests([]);
    setApprovingCode(null);
    setApprovedSender(undefined);
    setError(undefined);
    void refresh();
    return () => {
      loadSequence.current += 1;
    };
  }, [refresh]);

  const allow = async (request: DaemonChannelPairingRequest) => {
    if (!canManage || approvingCode) return;
    const sequence = ++loadSequence.current;
    setApprovingCode(request.code);
    setApprovedSender(undefined);
    setError(undefined);
    try {
      const result = await approve(channelName, request.code);
      if (sequence !== loadSequence.current) return;
      setRequests(result.requests);
      setApprovedSender(request.senderName || request.senderId);
    } catch (approveError) {
      if (sequence === loadSequence.current) {
        setError(extractErrorDetail(approveError));
      }
    } finally {
      if (sequence === loadSequence.current) setApprovingCode(null);
    }
  };

  return (
    <section className={styles.pairingSection} aria-labelledby="pairing-title">
      <div className={styles.sectionHeader}>
        <div className="flex items-center gap-2">
          <h3 id="pairing-title" className="text-sm font-semibold">
            {t('channels.pairing.title')}
          </h3>
          <Badge variant="outline">{requests.length}</Badge>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!canManage || loading || approvingCode !== null}
          aria-label={t('channels.pairing.refresh')}
          onClick={() => void refresh()}
        >
          {loading ? <Spinner /> : <RefreshCwIcon />}
        </Button>
      </div>

      {!canManage ? (
        <p className="text-xs text-muted-foreground">
          {t('channels.pairing.tokenRequired')}
        </p>
      ) : null}
      {canManage && !loading && requests.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('channels.pairing.empty')}
        </p>
      ) : null}
      {requests.map((request) => (
        <div key={request.code} className={styles.pairingRequest}>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {request.senderName || request.senderId}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {request.senderId}
            </p>
            <div className="mt-1 flex items-center gap-2">
              <code className={styles.pairingCode}>{request.code}</code>
              <span className="text-xs text-muted-foreground">
                {t('channels.pairing.ageMinutes', {
                  count: ageInMinutes(request.createdAt),
                })}
              </span>
            </div>
          </div>
          <Button
            size="sm"
            disabled={approvingCode !== null}
            aria-label={t('channels.pairing.allowNamed', {
              name: request.senderName || request.senderId,
            })}
            onClick={() => void allow(request)}
          >
            {approvingCode === request.code ? <Spinner /> : null}
            {t('channels.pairing.allow')}
          </Button>
        </div>
      ))}
      {approvedSender ? (
        <Alert>
          <CheckCircle2Icon />
          <AlertDescription>
            {t('channels.pairing.approved', { name: approvedSender })}
          </AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
