/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { CopyIcon, QrCodeIcon } from 'lucide-react';
import { useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../i18n';
import {
  warnClipboardWriteFailure,
  writeClipboardText,
} from '../utils/clipboard';
import {
  requestLocalControl,
  type LocalControlStatus,
} from './local-control-api';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Spinner } from './ui/spinner';

interface LocalControlQrButtonProps {
  onOpenSettings: () => void;
}

export function LocalControlQrButton({
  onOpenSettings,
}: LocalControlQrButtonProps) {
  const { t } = useI18n();
  const { baseUrl, token } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<LocalControlStatus>();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let ignore = false;
    setStatus(undefined);
    setError('');
    requestLocalControl(baseUrl, token, 'GET', '/workspace/local-control')
      .then((next) => {
        if (!ignore) setStatus(next);
      })
      .catch((failure: unknown) => {
        if (!ignore) {
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
        }
      });
    return () => {
      ignore = true;
    };
  }, [open, baseUrl, token]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('localControl.open')}
          title={t('localControl.open')}
        >
          <QrCodeIcon aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        {!status && !error && <Spinner />}
        {status?.active && status.url && (
          <div className="flex flex-col items-center gap-3">
            {status.qrText && (
              <pre
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
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
