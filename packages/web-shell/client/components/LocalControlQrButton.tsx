/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { CopyIcon, QrCodeIcon } from 'lucide-react';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../i18n';
import {
  warnClipboardWriteFailure,
  writeClipboardText,
} from '../utils/clipboard';
import {
  LocalControlRequestError,
  requestLocalControl,
  type LocalControlStatus,
} from './local-control-api';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Spinner } from './ui/spinner';
import { cn } from '@/lib/utils';

interface LocalControlQrButtonProps {
  onOpenSettings: () => void;
  /** Extra classes for the trigger, e.g. to match a host header's action style. */
  className?: string;
}

export function LocalControlQrButton({
  onOpenSettings,
  className,
}: LocalControlQrButtonProps) {
  const { t } = useI18n();
  const { baseUrl, token } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<
    LocalControlStatus & { expiresAt?: number; dynamic?: boolean }
  >();
  const [error, setError] = useState('');
  const [address, setAddress] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!open) return;
    let ignore = false;
    let refreshTimer: ReturnType<typeof setTimeout>;
    let emptyReplies = 0;
    setStatus(undefined);
    setError('');
    const refresh = async () => {
      try {
        let next: LocalControlStatus;
        let dynamic = false;
        try {
          next = await requestLocalControl(
            baseUrl,
            token,
            'POST',
            '/web-shell/pairing',
            address ? { address } : undefined,
          );
          dynamic = next.active;
        } catch (failure) {
          if (
            !(failure instanceof LocalControlRequestError) ||
            failure.status !== 404
          )
            throw failure;
          next = { active: false };
        }
        if (!next.active) {
          dynamic = false;
          next = await requestLocalControl(
            baseUrl,
            token,
            'GET',
            '/workspace/local-control',
          );
        }
        if (ignore) return;
        const expiresAt =
          next.expiresInMs === undefined
            ? undefined
            : Date.now() + next.expiresInMs;
        setStatus({ ...next, expiresAt, dynamic });
        setNow(Date.now());
        setError('');
        if (expiresAt) {
          refreshTimer = setTimeout(
            () => void refresh(),
            Math.max(1000, expiresAt - Date.now() - 15_000),
          );
        } else if (
          next.active &&
          !next.url &&
          !next.urlRedacted &&
          !next.interfaces?.length
        ) {
          // A wildcard bind can find no LAN candidate for a while (an
          // interface flapping down/up); poll again rather than sticking on
          // the empty choice until the popover is reopened. A populated
          // choice list advances only through `setAddress`, so re-polling it
          // would just spend mutation-tier requests. The cadence widens
          // after the first empty replies: each poll is a mutation-tier POST
          // on a per-IP bucket the operator can tighten, and an idle popover
          // holding this terminal empty state must not drain it.
          emptyReplies += 1;
          refreshTimer = setTimeout(
            () => void refresh(),
            emptyReplies < 3 ? 5000 : 30_000,
          );
        }
      } catch (failure) {
        if (ignore) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        refreshTimer = setTimeout(() => void refresh(), 5000);
      }
    };
    void refresh();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      ignore = true;
      clearTimeout(refreshTimer);
      clearInterval(clock);
    };
  }, [open, baseUrl, token, address, attempt]);

  const remaining =
    status?.expiresAt === undefined
      ? undefined
      : Math.max(0, Math.ceil((status.expiresAt - now) / 1000));

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setStatus(undefined);
          setError('');
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(className)}
          aria-label={t('localControl.open')}
          title={t('localControl.open')}
        >
          <QrCodeIcon aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        {!status && !error && <Spinner />}
        {status?.active && status.url && remaining !== 0 && (
          <div className="flex flex-col items-center gap-3">
            {remaining !== undefined && (
              <p className="text-sm text-muted-foreground">
                {t('localControl.expires', { seconds: remaining })}
              </p>
            )}
            {status.qrText && (
              <pre
                // CJK font fallback gives block glyphs a different width than spaces.
                lang="en"
                aria-label={t('settings.localControl.qr')}
                className="w-fit overflow-hidden rounded-lg bg-white p-3 font-mono text-[7px] leading-[7px] tracking-normal text-black select-none"
              >
                {status.qrText}
              </pre>
            )}
            <div className="w-full break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
              {status.url}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                void writeClipboardText(status.url!).catch(
                  warnClipboardWriteFailure,
                )
              }
            >
              <CopyIcon aria-hidden="true" />
              {t('common.copy')}
            </Button>
            {status.encrypted !== undefined && (
              <p className="text-xs text-muted-foreground">
                {t(
                  status.dynamic
                    ? status.encrypted
                      ? 'localControl.securePairingDynamic'
                      : 'localControl.insecurePairingDynamic'
                    : status.encrypted
                      ? 'localControl.securePairing'
                      : 'localControl.insecurePairing',
                )}
              </p>
            )}
          </div>
        )}
        {remaining === 0 && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-muted-foreground">
              {t('localControl.expired')}
            </p>
            {!error && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAttempt((value) => value + 1)}
              >
                {t('localControl.retry')}
              </Button>
            )}
          </div>
        )}
        {status?.active &&
          !status.url &&
          !status.urlRedacted &&
          status.interfaces && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                {t(
                  status.interfaces.length
                    ? 'settings.localControl.selectNetwork'
                    : 'localControl.noNetwork',
                )}
              </p>
              {status.interfaces.map((candidate) => (
                <Button
                  key={candidate.address}
                  variant="outline"
                  size="sm"
                  onClick={() => setAddress(candidate.address)}
                >
                  {candidate.interfaceName}: {candidate.address}
                </Button>
              ))}
            </div>
          )}
        {status?.active && !status.url && status.urlRedacted && (
          <p className="text-sm text-muted-foreground">
            {t('settings.localControl.urlRedacted')}
          </p>
        )}
        {status && !status.active && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              {t('localControl.disabledHint')}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              {t('localControl.openSettings')}
            </Button>
          </div>
        )}
        {error && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAttempt((value) => value + 1)}
            >
              {t('localControl.retry')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
