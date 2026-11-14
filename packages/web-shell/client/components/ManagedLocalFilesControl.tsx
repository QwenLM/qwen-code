/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useId, useState } from 'react';
import { FolderOpenIcon } from 'lucide-react';
import { useI18n } from '../i18n';
import { useManagedLocalFilesBridge } from '../local-files/useManagedLocalFilesBridge';
import type { ManagedFetch } from '../local-files/managed-client-files-bridge';
import type { ManagedAgentProvider } from './managed/managed-agent-provider';
import {
  LocalFilesPanel,
  getLocalFilesDotClass,
  getLocalFilesTooltip,
} from './LocalFilesControl';
import { requestToast } from './ToastHost';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { cn } from '@/lib/utils';

export interface ManagedLocalFilesControlProps {
  provider: ManagedAgentProvider;
  sessionId: string | undefined;
  triggerClassName: string;
  /** Bound session title, shown while connected when known. */
  sessionName?: string;
}

/**
 * The Managed-mode local files entry. Unlike the daemon control it has no
 * workspace route or ACP re-warm: the provider supplies an authenticated
 * HTTP/SSE transport, and the entry is withheld entirely when the deployment
 * does not expose client files.
 */
export function ManagedLocalFilesControl({
  provider,
  sessionId,
  triggerClassName,
  sessionName,
}: ManagedLocalFilesControlProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const stateDescriptionId = useId();

  const transport = provider.clientFiles?.transport();
  const unavailableFetch = (async () =>
    new Response(null, { status: 503 })) as unknown as ManagedFetch;
  const { status, connect, disconnect } = useManagedLocalFilesBridge({
    sessionId,
    baseUrl: transport?.baseUrl ?? '',
    fetch: transport?.fetch ?? unavailableFetch,
  });

  if (!transport) return null;

  const dotClass = getLocalFilesDotClass(status);
  const stateDescription = getLocalFilesTooltip(status, t);

  const control = (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn('relative', triggerClassName)}
          aria-label={t('localFiles.trigger')}
          aria-describedby={stateDescriptionId}
          title={stateDescription}
        >
          <FolderOpenIcon size={16} strokeWidth={1.2} aria-hidden="true" />
          <span id={stateDescriptionId} className="sr-only">
            {stateDescription}
          </span>
          {dotClass ? (
            <span
              aria-hidden="true"
              className={cn(
                'absolute right-1 bottom-1 h-1.5 w-1.5 rounded-full',
                dotClass,
              )}
            />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80"
        data-web-shell-local-files-panel
      >
        <LocalFilesPanel
          status={status}
          onConnect={() => void connect()}
          onDisconnect={disconnect}
          onOpenInNewTab={() => {
            window.open(window.location.href, '_blank', 'noopener');
          }}
          onChangeDirectory={() => {
            void connect({ forcePicker: true }).then((result) => {
              // A failed re-pick keeps the running bridge connected, but the
              // click must not be silent (R1-5).
              if (result?.kind === 'repick-failed') {
                requestToast('error', t('localFiles.changeDirectoryFailed'));
              }
            });
          }}
          sessionName={sessionName}
        />
      </PopoverContent>
    </Popover>
  );

  return control;
}
