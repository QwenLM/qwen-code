/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AlertCircleIcon, CheckCircle2Icon, QrCodeIcon } from 'lucide-react';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Spinner } from '../ui/spinner';
import { useI18n } from '../../i18n';
import {
  useChannelQrAuth,
  type ChannelQrAuthActions,
} from './useChannelQrAuth';

interface ChannelQrAuthDialogProps {
  open: boolean;
  identity: object;
  name: string;
  channelType: string;
  channelDisplayName: string;
  actions: ChannelQrAuthActions;
  onOpenChange: (open: boolean) => void;
}

const STATUS_KEYS = {
  requesting: 'channels.auth.status.requesting',
  awaiting_scan: 'channels.auth.status.awaitingScan',
  scanned: 'channels.auth.status.scanned',
  refreshing: 'channels.auth.status.refreshing',
  ready: 'channels.auth.status.ready',
  committed: 'channels.auth.status.committed',
  cancelled: 'channels.auth.status.cancelled',
  expired: 'channels.auth.status.expired',
  error: 'channels.auth.status.error',
} as const;

function countdown(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
}

export function ChannelQrAuthDialog({
  open,
  identity,
  name,
  channelType,
  channelDisplayName,
  actions,
  onOpenChange,
}: ChannelQrAuthDialogProps) {
  const { t } = useI18n();
  const auth = useChannelQrAuth({
    open,
    identity,
    name,
    channelType,
    actions,
  });
  const state = auth.session?.state;
  const status = auth.error
    ? auth.error
    : state
      ? t(STATUS_KEYS[state])
      : t('channels.auth.status.starting');
  const remaining = countdown(auth.remainingSeconds);
  const close = () => {
    auth.close();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
    >
      <DialogContent
        className="motion-reduce:animate-none motion-reduce:transition-none sm:max-w-md"
        overlayProps={{
          className: 'motion-reduce:animate-none motion-reduce:transition-none',
        }}
        showCloseButton={false}
        onEscapeKeyDown={() => auth.close()}
      >
        <DialogHeader>
          <DialogTitle>{t('channels.auth.title', { name })}</DialogTitle>
          <DialogDescription>
            {t('channels.auth.description', { type: channelDisplayName })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid justify-items-center gap-4 py-2">
          {auth.qrUrl ? (
            <div className="rounded-xl border bg-white p-3 shadow-sm motion-reduce:transition-none">
              <img
                src={auth.qrUrl}
                alt={t('channels.auth.qrAlt', {
                  type: channelDisplayName,
                  name,
                })}
                className="size-56 max-w-full object-contain"
              />
            </div>
          ) : state === 'committed' ? (
            <CheckCircle2Icon
              className="size-16 text-primary"
              aria-hidden="true"
            />
          ) : (
            <div className="grid size-56 place-items-center rounded-xl border bg-muted/40">
              {auth.busy ? (
                <Spinner className="size-8 motion-reduce:animate-none" />
              ) : (
                <QrCodeIcon
                  className="size-12 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
            </div>
          )}

          <div className="w-full text-center">
            <p className="font-medium" aria-live="polite" aria-atomic="true">
              {status}
            </p>
            {remaining !== undefined &&
            state !== 'committed' &&
            state !== 'cancelled' ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {t('channels.auth.remaining', { remaining })}
              </p>
            ) : null}
          </div>

          {auth.error ? (
            <Alert variant="destructive" className="w-full">
              <AlertCircleIcon />
              <AlertDescription>{auth.error}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={auth.busy === 'commit'}
            onClick={close}
          >
            {state === 'committed'
              ? t('channels.action.close')
              : t('channels.action.cancel')}
          </Button>
          {auth.canRetry || auth.busy === 'retry' ? (
            <Button
              type="button"
              disabled={auth.busy !== null}
              onClick={() => void auth.retry()}
            >
              {auth.busy === 'retry' ? <Spinner /> : null}
              {t('channels.action.retry')}
            </Button>
          ) : null}
          {state === 'ready' ? (
            <Button
              type="button"
              disabled={auth.busy !== null}
              onClick={() => void auth.commit()}
            >
              {auth.busy === 'commit' ? <Spinner /> : null}
              {t('channels.action.saveAuthentication')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
