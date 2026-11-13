/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { cn } from '@/lib/utils';

export interface ManagedLocalFilesControlProps {
  provider: ManagedAgentProvider;
  sessionId: string | undefined;
  triggerClassName: string;
  portalContainer?: HTMLElement | null;
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
  portalContainer,
  sessionName,
}: ManagedLocalFilesControlProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (portalContainer === null) setOpen(false);
  }, [portalContainer]);

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

  const control = (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn('relative', triggerClassName)}
          aria-label={t('localFiles.trigger')}
          title={getLocalFilesTooltip(status, t)}
        >
          <FolderOpenIcon size={16} strokeWidth={1.2} aria-hidden="true" />
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
          onChangeDirectory={() => void connect({ forcePicker: true })}
          sessionName={sessionName}
        />
      </PopoverContent>
    </Popover>
  );

  if (portalContainer) {
    return createPortal(control, portalContainer);
  }
  return control;
}
