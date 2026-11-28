/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useI18n } from '../i18n';
import type { LocalFilesBlocker } from '../local-files/capabilities';
import type {
  LocalFilesPhase,
  LocalFilesStatus,
} from '../local-files/useLocalFilesBridge';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';

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
  'workspace-ineligible': 'localFiles.blocker.workspaceIneligible',
  'workspace-resolving': 'localFiles.blocker.workspaceResolving',
  'unsupported-daemon': 'localFiles.blocker.unsupportedDaemon',
};

const BUSY: readonly LocalFilesPhase[] = [
  'connecting',
  'registering',
  'reconnecting',
];

/** Concrete command that enables the reverse channel on the daemon. */
export const LOCAL_FILES_DAEMON_COMMAND =
  'QWEN_SERVE_CLIENT_MCP_OVER_WS=1 qwen serve';

/**
 * The startup command in the user's shell syntax: the POSIX env-prefix form
 * is not parseable by PowerShell, so on Windows the affordance must copy the
 * `$env:` form or the one action the blocker offers cannot enable the feature.
 * The variable name is the literal run-qwen-serve.ts reads.
 */
export function deriveLocalFilesDaemonCommand(
  platform: string | undefined,
): string {
  return /win/i.test(platform ?? '')
    ? '$env:QWEN_SERVE_CLIENT_MCP_OVER_WS=1; qwen serve'
    : LOCAL_FILES_DAEMON_COMMAND;
}

/**
 * Trigger dot color per phase. `null` means no dot. Failed and needs-gesture
 * get distinct colors so a broken or re-authorization-pending bridge is not
 * invisible the way a plain busy dot made it. `held-elsewhere` stays muted
 * (not primary): the bridge is live but owned by another tab, so this tab must
 * not read the dot as "I have a working bridge here". The warning states use
 * the theme-aware `--warning-color` token (App.module.css) rather than a fixed
 * palette color, so the dot keeps contrast in the light theme too.
 */
export function getLocalFilesDotClass(status: LocalFilesStatus): string | null {
  switch (status.phase) {
    case 'connected':
      return 'bg-primary';
    case 'held-elsewhere':
    case 'connecting':
    case 'registering':
      return 'bg-muted-foreground';
    case 'reconnecting':
    case 'needs-gesture':
      return 'bg-[var(--warning-color)]';
    case 'failed':
      return 'bg-destructive';
    default:
      return null;
  }
}

/** Tooltip naming the state (and directory) instead of the static label. */
export function getLocalFilesTooltip(
  status: LocalFilesStatus,
  t: (key: string) => string,
): string {
  const name = status.rootName ? ` (${status.rootName})` : '';
  // Mirror the panel's transient predicate: a resolving blip is "still
  // resolving", not the permanent "Unavailable here" the raw phase key names.
  const statusKey =
    status.blocker === 'workspace-resolving'
      ? 'localFiles.status.resolving'
      : STATUS_KEY[status.phase];
  return `${t('localFiles.trigger')} — ${t(statusKey)}${name}`;
}

export interface LocalFilesPanelProps {
  status: LocalFilesStatus;
  onConnect: () => void;
  onDisconnect: () => void;
  onOpenInNewTab: () => void;
  /** Offered only while connected; re-opens the picker for a new grant. */
  onChangeDirectory?: () => void;
  /** Bound session title, shown while connected when known. */
  sessionName?: string;
  /** Offered in needs-session when the host can create a session. */
  onNewSession?: () => void;
  /** Copies a concrete fix command; absent hosts render no copy buttons. */
  onCopyCommand?: (command: string) => void;
  /** SSH tunnel command for the insecure-context blocker, when derivable. */
  tunnelCommand?: string;
  /** Local port the tunnel binds; the blocker copy names the address to open. */
  tunnelLocalPort?: number;
  /** Daemon startup command in the user's shell syntax; defaults to POSIX. */
  daemonCommand?: string;
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
  onChangeDirectory,
  sessionName,
  onNewSession,
  onCopyCommand,
  tunnelCommand,
  tunnelLocalPort,
  daemonCommand,
}: LocalFilesPanelProps) {
  const { t } = useI18n();
  const busy = BUSY.includes(status.phase);
  const active =
    status.phase === 'connected' || status.phase === 'held-elsewhere';
  // A grant worth releasing: a directory is bound, or a bridge is running.
  const granted = status.rootName !== undefined || busy || active;
  const canConnect = status.phase !== 'unavailable' && !busy && !active;
  // The one transient blocker: pairing it with the permanent "Unavailable
  // here" header would assert impossibility next to a promise of progress.
  const resolving = status.blocker === 'workspace-resolving';
  const connectLabel =
    status.phase === 'needs-gesture'
      ? t('localFiles.reconnect')
      : status.phase === 'failed' && status.rootName !== undefined
        ? t('localFiles.retry')
        : t('localFiles.connect');

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {busy || resolving ? <Spinner /> : null}
        <h2 className="text-sm font-medium">{t('localFiles.title')}</h2>
        <span className="ml-auto text-xs text-muted-foreground">
          {resolving
            ? t('localFiles.status.resolving')
            : t(STATUS_KEY[status.phase])}
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
          {status.phase === 'connected' && sessionName ? (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">
                {t('localFiles.session')}
              </dt>
              <dd className="ml-auto break-all">{sessionName}</dd>
            </div>
          ) : null}
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
            {t(
              BLOCKER_KEY[status.blocker],
              status.blocker === 'insecure-context' &&
                tunnelLocalPort !== undefined
                ? { localPort: tunnelLocalPort }
                : undefined,
            )}
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
          {status.blocker === 'unsupported-daemon' && onCopyCommand ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                onCopyCommand(daemonCommand ?? LOCAL_FILES_DAEMON_COMMAND)
              }
            >
              {t('localFiles.copyStartupCommand')}
            </Button>
          ) : null}
          {status.blocker === 'insecure-context' &&
          onCopyCommand &&
          tunnelCommand ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onCopyCommand(tunnelCommand)}
            >
              {t('localFiles.copyTunnelCommand')}
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
            {connectLabel}
          </Button>
        ) : null}
        {status.phase === 'needs-session' && onNewSession ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onNewSession}
          >
            {t('localFiles.newSession')}
          </Button>
        ) : null}
        {status.phase === 'connected' && onChangeDirectory ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onChangeDirectory}
          >
            {t('localFiles.changeDirectory')}
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
