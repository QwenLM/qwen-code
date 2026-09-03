/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useState } from 'react';
import { FolderOpenIcon } from 'lucide-react';
import {
  useConnection,
  useWorkspace,
  useWorkspaceActions,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../i18n';
import type { LocalFilesBlocker } from '../local-files/capabilities';
import {
  useLocalFilesBridge,
  type LocalFilesPhase,
  type LocalFilesStatus,
} from '../local-files/useLocalFilesBridge';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Spinner } from './ui/spinner';
import { cn } from '@/lib/utils';

const STATUS_KEY: Record<LocalFilesPhase, string> = {
  unavailable: 'localFiles.status.unavailable',
  'needs-session': 'localFiles.status.needsSession',
  idle: 'localFiles.status.idle',
  'needs-gesture': 'localFiles.status.needsGesture',
  'held-elsewhere': 'localFiles.status.heldElsewhere',
  connecting: 'localFiles.status.connecting',
  registering: 'localFiles.status.registering',
  connected: 'localFiles.status.connected',
  reconnecting: 'localFiles.status.reconnecting',
  failed: 'localFiles.status.failed',
};

const BLOCKER_KEY: Record<NonNullable<LocalFilesBlocker>, string> = {
  'insecure-context': 'localFiles.blocker.insecureContext',
  'cross-origin-frame': 'localFiles.blocker.crossOriginFrame',
  'unsupported-browser': 'localFiles.blocker.unsupportedBrowser',
};

const BUSY: readonly LocalFilesPhase[] = [
  'connecting',
  'registering',
  'reconnecting',
];

export interface LocalFilesPanelProps {
  status: LocalFilesStatus;
  onConnect: () => void;
  onDisconnect: () => void;
  onOpenInNewTab: () => void;
}

/**
 * The popover body, kept prop-driven and free of hooks/portals so the phase →
 * affordance mapping is testable without a Radix portal or a daemon provider.
 */
export function LocalFilesPanel({
  status,
  onConnect,
  onDisconnect,
  onOpenInNewTab,
}: LocalFilesPanelProps) {
  const { t } = useI18n();
  const busy = BUSY.includes(status.phase);
  const active =
    status.phase === 'connected' || status.phase === 'held-elsewhere';
  // A grant worth releasing: a directory is bound, or a bridge is running.
  const granted = status.rootName !== undefined || busy || active;
  const canConnect = status.phase !== 'unavailable' && !busy && !active;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {busy ? <Spinner /> : null}
        <h2 className="text-sm font-medium">{t('localFiles.title')}</h2>
        <span className="ml-auto text-xs text-muted-foreground">
          {t(STATUS_KEY[status.phase])}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">{t('localFiles.hint')}</p>

      {status.rootName ? (
        <dl className="flex flex-col gap-1 text-xs">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">
              {t('localFiles.directory')}
            </dt>
            <dd className="ml-auto break-all font-mono">{status.rootName}</dd>
          </div>
          {status.toolCount === undefined ? null : (
            <p className="text-right text-muted-foreground">
              {t('localFiles.tools', { count: status.toolCount })}
            </p>
          )}
        </dl>
      ) : null}

      {status.phase === 'unavailable' && status.blocker ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            {t(BLOCKER_KEY[status.blocker])}
          </p>
          {status.blocker === 'cross-origin-frame' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenInNewTab}
            >
              {t('localFiles.openInNewTab')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {status.phase === 'needs-session' ? (
        <p className="text-xs text-muted-foreground">
          {t('localFiles.needsSessionHint')}
        </p>
      ) : null}

      {status.phase === 'failed' && status.message ? (
        <p className="text-xs text-destructive" role="alert">
          {status.message}
        </p>
      ) : null}

      <div className="flex gap-2">
        {canConnect ? (
          <Button type="button" variant="outline" size="sm" onClick={onConnect}>
            {status.phase === 'needs-gesture'
              ? t('localFiles.reconnect')
              : t('localFiles.connect')}
          </Button>
        ) : null}
        {granted ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDisconnect}
          >
            {t('localFiles.disconnect')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

interface LocalFilesControlProps {
  /**
   * Class for the trigger button. Required, and supplied by the host surface
   * (the sidebar passes its own footer-button class) so the entry matches its
   * neighbours instead of inventing a second button style.
   */
  triggerClassName: string;
}

export function LocalFilesControl({
  triggerClassName,
}: LocalFilesControlProps) {
  const { t } = useI18n();
  const { baseUrl, token } = useWorkspace();
  const actions = useWorkspaceActions();
  const { sessionId } = useConnection();
  const [open, setOpen] = useState(false);

  const rewarm = useCallback(async () => {
    await actions.preheatAcp(5_000);
  }, [actions]);

  const { status, connect, disconnect } = useLocalFilesBridge({
    sessionId,
    baseUrl,
    token,
    rewarm,
  });

  const active =
    status.phase === 'connected' || status.phase === 'held-elsewhere';
  const busy = BUSY.includes(status.phase);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn('relative', triggerClassName)}
          aria-label={t('localFiles.trigger')}
          title={t('localFiles.trigger')}
        >
          <FolderOpenIcon size={16} strokeWidth={1.2} aria-hidden="true" />
          {active || busy ? (
            <span
              aria-hidden="true"
              className={cn(
                'absolute right-1 bottom-1 h-1.5 w-1.5 rounded-full',
                status.phase === 'connected'
                  ? 'bg-primary'
                  : 'bg-muted-foreground',
              )}
            />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <LocalFilesPanel
          status={status}
          onConnect={() => void connect()}
          onDisconnect={disconnect}
          onOpenInNewTab={() => {
            // The picker cannot run in a cross-origin frame, but it can in the
            // top-level document this one is framed inside.
            window.open(window.location.href, '_blank', 'noopener');
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
