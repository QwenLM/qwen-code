/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpenIcon } from 'lucide-react';
import type {
  DaemonCapabilities,
  DaemonClient,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import {
  useActions,
  useConnection,
  useWorkspace,
  useWorkspaceActions,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../i18n';
import type { LocalFilesBlocker } from '../local-files/capabilities';
import type { AcpWorkspaceSelector } from '../local-files/bridge-client';
import {
  useLocalFilesBridge,
  type LocalFilesPhase,
  type LocalFilesStatus,
} from '../local-files/useLocalFilesBridge';
import { resolveVoiceWorkspaceTarget } from '../voice/voice-workspace-target';
import { writeClipboardText } from '../utils/clipboard';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Spinner } from './ui/spinner';
import { requestToast } from './ToastHost';
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
 * Trigger dot color per phase. `null` means no dot. Failed and needs-gesture
 * get distinct colors so a broken or re-authorization-pending bridge is not
 * invisible the way a plain busy dot made it. `held-elsewhere` stays muted
 * (not primary): the bridge is live but owned by another tab, so this tab must
 * not read the dot as "I have a working bridge here".
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
      return 'bg-amber-500';
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
  return `${t('localFiles.trigger')} — ${t(STATUS_KEY[status.phase])}${name}`;
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
          {status.blocker === 'unsupported-daemon' && onCopyCommand ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onCopyCommand(LOCAL_FILES_DAEMON_COMMAND)}
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

interface LocalFilesControlProps {
  /**
   * Class for the trigger button. Required, and supplied by the host surface
   * (the sidebar passes its own footer-button class) so the entry matches its
   * neighbours instead of inventing a second button style.
   */
  triggerClassName: string;
  /** Keep the bridge mounted while its menu trigger is absent. */
  portalContainer?: HTMLElement | null;
  /**
   * The merged workspace list (capabilities snapshot plus a locked workspace
   * registered before the snapshot). The sidebar already holds it; resolving
   * on the bare snapshot alone would collapse a locked workspace's session
   * onto the primary mount.
   */
  workspaces?: readonly DaemonWorkspaceCapability[];
}

/**
 * Resolve how a session's bridge must dial, with the same rules voice uses
 * for the eligible cases (primary → legacy `/acp`, trusted secondary →
 * workspace-qualified route). Unlike voice, this surface also needs an
 * explicit "no bridge" outcome: an untrusted or live workspace must withhold
 * the entry instead of collapsing onto the primary mount, and
 * `{ kind: 'pending' }` is reserved for "cannot tell yet" (capabilities
 * snapshot or registry entry not landed). The resolver never returns
 * `undefined`; whether a resolved route may actually be offered also depends
 * on the daemon's client_mcp_over_ws feature gate, which the caller applies
 * separately.
 */
export type LocalFilesWorkspaceRoute =
  | { kind: 'legacy' }
  | { kind: 'qualified'; selector: AcpWorkspaceSelector }
  | { kind: 'none' }
  | { kind: 'pending' };

export function resolveLocalFilesWorkspaceRoute(options: {
  capabilities: DaemonCapabilities | undefined;
  workspaces?: readonly DaemonWorkspaceCapability[];
  workspaceCwd: string | undefined;
  sessionId: string | undefined;
}): LocalFilesWorkspaceRoute {
  // Until the snapshot lands no judgement is possible: starting the bridge
  // now would dial the bare /acp primary mount for a session the primary
  // mount does not own.
  if (options.capabilities === undefined) return { kind: 'pending' };
  const target = resolveVoiceWorkspaceTarget({
    capabilities: options.capabilities,
    ...(options.workspaces === undefined
      ? {}
      : { workspaces: options.workspaces }),
    intendedCwd: options.workspaceCwd,
    sessionId: options.sessionId,
  });
  if (target !== undefined) {
    if (target.route === 'workspace-qualified') {
      return { kind: 'qualified', selector: target.selector };
    }
    // The shared resolver exempts the primary workspace from its trust/live
    // test (voice gates that case behind its own feature flag), but this
    // surface must withhold: the bare /acp mount performs no trust check at
    // registration, so an untrusted or live primary would receive the granted
    // directory - write tool included.
    // The lookup keys on the target's cwd: with no session yet the shared
    // resolver matched the primary by the cwd it derived itself, so keying
    // on the undefined workspaceCwd would miss and fail open.
    const entryCwd = target.cwd ?? options.workspaceCwd;
    const entry = (
      options.workspaces ?? options.capabilities?.workspaces
    )?.find((w) => w.cwd === entryCwd);
    // `trusted !== true`, not `=== false`: a field absent on the wire must
    // withhold like an explicit false, as session-context does for the same
    // field. This surface fails closed.
    if (
      entry !== undefined &&
      (entry.kind === 'live' || entry.trusted !== true)
    ) {
      return { kind: 'none' };
    }
    return { kind: 'legacy' };
  }
  const list = options.workspaces ?? options.capabilities.workspaces;
  // A daemon that advertises dynamic registration but has published no
  // workspace entries yet is bootstrapping, not registry-less: its trust
  // verdict has not landed, so withhold rather than answer eligible for a
  // primary the bare mount would register without any trust check.
  if (list === undefined || list.length === 0) {
    return options.capabilities.features?.includes(
      'dynamic_workspace_registration',
    )
      ? { kind: 'pending' }
      : { kind: 'legacy' };
  }
  if (options.workspaceCwd === undefined) return { kind: 'none' };
  const matches = list.filter((entry) => entry.cwd === options.workspaceCwd);
  if (matches.length > 1) return { kind: 'none' };
  const entry = matches[0];
  // Registry lag: the session's workspace is not in the snapshot yet.
  if (entry === undefined) return { kind: 'pending' };
  if (entry.kind === 'live' || entry.trusted !== true) {
    return { kind: 'none' };
  }
  return { kind: 'legacy' };
}

/**
 * Registration retries must warm the runtime that owns the session: the
 * legacy preheat route is bound to the primary workspace, so a secondary
 * session's cold child would never warm and every attempt would fail.
 */
export function createLocalFilesRewarm(options: {
  client: DaemonClient;
  selector: AcpWorkspaceSelector | undefined;
  preheat: () => Promise<unknown>;
}): () => Promise<void> {
  return async () => {
    const selector = options.selector;
    if (selector === undefined) {
      await options.preheat();
      return;
    }
    try {
      const workspace =
        selector.kind === 'id'
          ? options.client.workspaceById(selector.value)
          : options.client.workspaceByCwd(selector.value);
      await workspace.ensureRuntime();
    } catch (err) {
      // Only a daemon without the qualified route justifies the legacy
      // preheat; any other failure (spawn, timeout, unknown workspace) must
      // surface — retryRegister tolerates a failed re-warm, and silently
      // preheating the primary runtime for a secondary session is the exact
      // failure this function exists to prevent.
      if (err instanceof DaemonHttpError && err.status === 404) {
        await options.preheat();
        return;
      }
      throw err;
    }
  };
}

export function LocalFilesControl({
  triggerClassName,
  portalContainer,
  workspaces,
}: LocalFilesControlProps) {
  const { t } = useI18n();
  const { baseUrl, token, capabilities, client } = useWorkspace();
  const actions = useWorkspaceActions();
  const sessionActions = useActions();
  const { sessionId, workspaceCwd, displayName } = useConnection();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (portalContainer === null) setOpen(false);
  }, [portalContainer]);

  // The bare /acp socket lands on the primary mount, where a secondary
  // runtime's session cannot register; and an untrusted or live workspace
  // must withhold the bridge entirely instead of collapsing onto that mount.
  const route = useMemo(
    () =>
      resolveLocalFilesWorkspaceRoute({
        capabilities,
        workspaces,
        workspaceCwd: workspaceCwd ?? undefined,
        sessionId: sessionId ?? undefined,
      }),
    [capabilities, workspaces, workspaceCwd, sessionId],
  );
  const workspaceSelector =
    route.kind === 'qualified' ? route.selector : undefined;
  // Preflight: a daemon that does not advertise the reverse channel cannot
  // host the bridge at all; pending snapshot and ineligible workspaces must
  // withhold instead of failing open onto the primary mount.
  const withheldBlocker =
    capabilities !== undefined &&
    !capabilities.features?.includes('client_mcp_over_ws')
      ? ('unsupported-daemon' as const)
      : route.kind === 'none'
        ? ('workspace-ineligible' as const)
        : route.kind === 'pending'
          ? ('workspace-resolving' as const)
          : undefined;

  const rewarm = useCallback(
    () =>
      createLocalFilesRewarm({
        client,
        selector: workspaceSelector,
        preheat: () => actions.preheatAcp(5_000),
      })(),
    [actions, client, workspaceSelector],
  );

  const { status, connect, disconnect } = useLocalFilesBridge({
    sessionId,
    baseUrl,
    token,
    rewarm,
    workspaceSelector,
    withheldBlocker,
  });

  // A grant that fell back to `prompt` (e.g. after a reload) parks the bridge
  // in needs-gesture. Nothing outside the popover would report it, so notify
  // once per transition; the amber trigger dot keeps it discoverable after
  // the toast dismisses.
  const prevPhaseRef = useRef<LocalFilesPhase | undefined>(undefined);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = status.phase;
    if (status.phase === 'needs-gesture' && prev !== 'needs-gesture') {
      requestToast(
        'warning',
        t('localFiles.gestureToast', { name: status.rootName ?? '' }),
      );
    }
  }, [status.phase, status.rootName, t]);

  const handleCopyCommand = useCallback(
    (command: string) => {
      void writeClipboardText(command).then(
        () => requestToast('success', t('localFiles.copied')),
        () => requestToast('error', t('localFiles.copyFailed')),
      );
    },
    [t],
  );

  // Concrete SSH tunnel for the insecure-context blocker, when the daemon URL
  // is absolute. A relative base (same-origin) yields no command.
  const tunnelCommand = useMemo(() => {
    try {
      const url = new URL(baseUrl);
      if (!url.hostname) return undefined;
      const port = url.port || (url.protocol === 'https:' ? '443' : '80');
      return `ssh -L ${port}:localhost:${port} ${url.hostname}`;
    } catch {
      return undefined;
    }
  }, [baseUrl]);

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
            // The picker cannot run in a cross-origin frame, but it can in the
            // top-level document this one is framed inside.
            window.open(window.location.href, '_blank', 'noopener');
          }}
          onChangeDirectory={() => void connect({ forcePicker: true })}
          sessionName={displayName}
          onNewSession={() => {
            // newSession reports its own failures through the notice system.
            void sessionActions.newSession().catch(() => {});
          }}
          onCopyCommand={handleCopyCommand}
          tunnelCommand={tunnelCommand}
        />
      </PopoverContent>
    </Popover>
  );
  return portalContainer === undefined
    ? control
    : portalContainer
      ? createPortal(control, portalContainer)
      : null;
}
