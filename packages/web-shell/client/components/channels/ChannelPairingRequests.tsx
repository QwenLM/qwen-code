/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useId, useRef, useState } from 'react';
import {
  AlertCircleIcon,
  CheckIcon,
  InfoIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UsersRoundIcon,
} from 'lucide-react';
import type {
  DaemonChannelPairingApprovalResult,
  DaemonChannelPairingApprovalsSnapshot,
  DaemonChannelPairingRequest,
  DaemonChannelPairingRequestsSnapshot,
  DaemonChannelPairingRevocationRequest,
  DaemonChannelPairingRevocationResult,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { formatRelativeTime } from '../../utils/formatRelativeTime';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
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
  listApprovals: (
    name: string,
  ) => Promise<DaemonChannelPairingApprovalsSnapshot>;
  revokeApproval: (
    name: string,
    request: DaemonChannelPairingRevocationRequest,
  ) => Promise<DaemonChannelPairingRevocationResult>;
  staticAllowedUsers?: readonly string[];
}

type PairingApprovalTarget =
  | { type: 'user'; id: string }
  | { type: 'group'; id: string };

function senderLabel(request: DaemonChannelPairingRequest): string {
  return request.senderName.trim() || request.senderId;
}

function requestSubject(request: DaemonChannelPairingRequest) {
  return (
    request.subject ?? {
      type: 'user' as const,
      id: request.senderId,
      name: request.senderName,
    }
  );
}

function targetKey(target: PairingApprovalTarget): string {
  return `${target.type}:${target.id}`;
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
  listApprovals,
  revokeApproval,
  staticAllowedUsers = [],
}: ChannelPairingRequestsProps) {
  const { t } = useI18n();
  const headingId = useId();
  const approvalsHeadingId = useId();
  const mounted = useRef(false);
  const currentChannelName = useRef(channelName);
  currentChannelName.current = channelName;
  const [requests, setRequests] = useState<DaemonChannelPairingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [approvingCode, setApprovingCode] = useState<string>();
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [approvedSenderIds, setApprovedSenderIds] = useState<string[]>([]);
  const [approvedGroupIds, setApprovedGroupIds] = useState<string[]>([]);
  const [approvalsLoading, setApprovalsLoading] = useState(true);
  const [approvalsReloadToken, setApprovalsReloadToken] = useState(0);
  const [approvalsError, setApprovalsError] = useState<string>();
  const [revokeSuccess, setRevokeSuccess] = useState<string>();
  const [revokeTarget, setRevokeTarget] = useState<PairingApprovalTarget>();
  const [revokingTarget, setRevokingTarget] = useState<string>();

  const approvalLabel = (target: PairingApprovalTarget) =>
    target.type === 'group'
      ? t('channels.editor.pairing.subject.group', { name: target.id })
      : target.id;

  const approvedTargets: PairingApprovalTarget[] = [
    ...approvedSenderIds.map((id) => ({ type: 'user' as const, id })),
    ...approvedGroupIds.map((id) => ({ type: 'group' as const, id })),
  ];

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

  useEffect(() => {
    let active = true;
    setApprovalsLoading(true);
    setApprovedSenderIds([]);
    setApprovedGroupIds([]);
    setApprovalsError(undefined);
    setRevokeSuccess(undefined);
    setRevokeTarget(undefined);
    setRevokingTarget(undefined);
    void listApprovals(channelName).then(
      (snapshot) => {
        if (!active) return;
        setApprovedSenderIds(snapshot.senderIds);
        setApprovedGroupIds(snapshot.groupIds ?? []);
        setApprovalsLoading(false);
      },
      (loadError: unknown) => {
        if (!active) return;
        setApprovalsError(
          pairingErrorDetail(
            loadError,
            t('channels.editor.pairing.approvals.unavailable'),
          ),
        );
        setApprovalsLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [approvalsReloadToken, channelName, listApprovals, t]);

  const approve = async (request: DaemonChannelPairingRequest) => {
    if (approvingCode) return;
    const approvalChannel = channelName;
    setApprovingCode(request.code);
    setError(undefined);
    setSuccess(undefined);
    setRevokeSuccess(undefined);
    try {
      const result = await approveRequest(channelName, request.code);
      if (!mounted.current || currentChannelName.current !== approvalChannel) {
        return;
      }
      setRequests(result.requests);
      const subject = requestSubject(result.approved);
      setSuccess(
        t('channels.editor.pairing.approved', {
          sender:
            subject.type === 'group'
              ? t('channels.editor.pairing.subject.group', {
                  name: subject.name.trim() || subject.id,
                })
              : subject.name.trim() || subject.id,
        }),
      );
      setApprovalsReloadToken((current) => current + 1);
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

  const revoke = async (target: PairingApprovalTarget) => {
    if (revokingTarget) return;
    const revokeChannel = channelName;
    const key = targetKey(target);
    const label = approvalLabel(target);
    setRevokeTarget(undefined);
    setRevokingTarget(key);
    setApprovalsError(undefined);
    setRevokeSuccess(undefined);
    setSuccess(undefined);
    try {
      const result = await revokeApproval(
        channelName,
        target.type === 'group'
          ? { groupId: target.id }
          : { senderId: target.id },
      );
      if (!mounted.current || currentChannelName.current !== revokeChannel) {
        return;
      }
      setApprovedSenderIds(result.senderIds);
      setApprovedGroupIds(result.groupIds ?? []);
      setRevokeSuccess(
        t('channels.editor.pairing.approvals.revoked', { senderId: label }),
      );
    } catch (revokeError) {
      if (!mounted.current || currentChannelName.current !== revokeChannel) {
        return;
      }
      if (errorCode(revokeError) === 'channel_pairing_approval_not_found') {
        try {
          const snapshot = await listApprovals(revokeChannel);
          if (mounted.current && currentChannelName.current === revokeChannel) {
            setApprovedSenderIds(snapshot.senderIds);
            setApprovedGroupIds(snapshot.groupIds ?? []);
          }
          return;
        } catch (refreshError) {
          if (mounted.current && currentChannelName.current === revokeChannel) {
            setApprovalsError(
              pairingErrorDetail(
                refreshError,
                t('channels.editor.pairing.approvals.unavailable'),
              ),
            );
          }
          return;
        }
      }
      if (!mounted.current || currentChannelName.current !== revokeChannel) {
        return;
      }
      setApprovalsError(
        pairingErrorDetail(
          revokeError,
          t('channels.editor.pairing.approvals.unavailable'),
        ),
      );
    } finally {
      if (mounted.current && currentChannelName.current === revokeChannel) {
        setRevokingTarget(undefined);
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
            const subject = requestSubject(request);
            const label =
              subject.type === 'group'
                ? t('channels.editor.pairing.subject.group', {
                    name: subject.name.trim() || subject.id,
                  })
                : subject.name.trim() || subject.id;
            return (
              <li key={request.code} className={styles.request}>
                <div className={styles.requestIdentity}>
                  <span className={styles.senderName}>{label}</span>
                  {label !== subject.id ? (
                    <span className={styles.senderId}>{subject.id}</span>
                  ) : null}
                  {subject.type === 'group' ? (
                    <span className={styles.senderId}>
                      {t('channels.editor.pairing.requestedBy', {
                        sender: senderLabel(request),
                      })}
                    </span>
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
                  disabled={Boolean(approvingCode) || Boolean(revokingTarget)}
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

      <section aria-labelledby={approvalsHeadingId}>
        <div className={styles.divider} />

        <div className={styles.header}>
          <div>
            <h4 id={approvalsHeadingId} className={styles.title}>
              {t('channels.editor.pairing.approvals.title')}
            </h4>
            <p className={styles.description}>
              {t('channels.editor.pairing.approvals.description')}
            </p>
          </div>
          <div className={styles.headerActions}>
            <Badge variant="outline">{approvedTargets.length}</Badge>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              disabled={approvalsLoading || Boolean(revokingTarget)}
              aria-label={t('channels.editor.pairing.approvals.refresh')}
              onClick={() => {
                setRevokeSuccess(undefined);
                setApprovalsReloadToken((current) => current + 1);
              }}
            >
              {approvalsLoading ? <Spinner /> : <RefreshCwIcon />}
            </Button>
          </div>
        </div>

        {approvalsError ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>
              {t('channels.editor.pairing.approvals.error')}
            </AlertTitle>
            <AlertDescription>{approvalsError}</AlertDescription>
            <Button
              className="mt-2 w-fit"
              type="button"
              size="sm"
              variant="outline"
              disabled={approvalsLoading}
              onClick={() => setApprovalsReloadToken((current) => current + 1)}
            >
              {t('channels.editor.pairing.retry')}
            </Button>
          </Alert>
        ) : null}

        {revokeSuccess ? (
          <div role="status" className={styles.success}>
            <CheckIcon />
            {revokeSuccess}
          </div>
        ) : null}

        {!approvalsLoading &&
        !approvalsError &&
        approvedTargets.length === 0 ? (
          <div className={styles.empty}>
            <ShieldCheckIcon aria-hidden="true" />
            <div>
              <p className={styles.emptyTitle}>
                {t('channels.editor.pairing.approvals.empty.title')}
              </p>
              <p className={styles.emptyDescription}>
                {t('channels.editor.pairing.approvals.empty.description')}
              </p>
            </div>
          </div>
        ) : null}

        {approvedTargets.length > 0 ? (
          <ul className={styles.list}>
            {approvedTargets.map((target) => {
              const label = approvalLabel(target);
              const key = targetKey(target);
              return (
                <li key={key} className={styles.approval}>
                  <div className={styles.approvalIdentity}>
                    <ShieldCheckIcon aria-hidden="true" />
                    <code className={styles.approvalSenderId}>{label}</code>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={Boolean(revokingTarget) || Boolean(approvingCode)}
                    aria-label={t(
                      'channels.editor.pairing.approvals.revokeFor',
                      { senderId: label },
                    )}
                    onClick={() => setRevokeTarget(target)}
                  >
                    {revokingTarget === key ? <Spinner /> : <Trash2Icon />}
                    {t('channels.editor.pairing.approvals.revoke')}
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {staticAllowedUsers.length > 0 ? (
          <Alert>
            <InfoIcon />
            <AlertTitle>
              {t('channels.editor.pairing.allowlist.title')}
            </AlertTitle>
            <AlertDescription>
              <p>{t('channels.editor.pairing.allowlist.description')}</p>
              <code className={styles.allowlist}>
                {staticAllowedUsers.join(', ')}
              </code>
            </AlertDescription>
          </Alert>
        ) : null}
      </section>

      <AlertDialog
        open={Boolean(revokeTarget)}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('channels.editor.pairing.approvals.confirm.title', {
                senderId: revokeTarget ? approvalLabel(revokeTarget) : '',
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('channels.editor.pairing.approvals.confirm.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">
              {t('channels.editor.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              onClick={() => {
                if (revokeTarget) void revoke(revokeTarget);
              }}
            >
              {t('channels.editor.pairing.approvals.confirm.action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
