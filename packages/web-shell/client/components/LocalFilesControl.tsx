/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo, useState } from 'react';
import { FolderOpenIcon } from 'lucide-react';
import type {
  DaemonCapabilities,
  DaemonClient,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import {
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
  'workspace-ineligible': 'localFiles.blocker.workspaceIneligible',
  'workspace-resolving': 'localFiles.blocker.workspaceResolving',
  'unsupported-daemon': 'localFiles.blocker.unsupportedDaemon',
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
  // The one transient blocker: pairing it with the permanent "Unavailable
  // here" header would assert impossibility next to a promise of progress.
  const resolving = status.blocker === 'workspace-resolving';

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
  workspaces,
}: LocalFilesControlProps) {
  const { t } = useI18n();
  const { baseUrl, token, capabilities, client } = useWorkspace();
  const actions = useWorkspaceActions();
  const { sessionId, workspaceCwd } = useConnection();
  const [open, setOpen] = useState(false);

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
