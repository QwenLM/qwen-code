/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import type { AcpWorkspaceSelector } from '../local-files/bridge-client';
import {
  useLocalFilesBridge,
  type LocalFilesPhase,
} from '../local-files/useLocalFilesBridge';
import { resolveVoiceWorkspaceTarget } from '../voice/voice-workspace-target';
import { writeClipboardText } from '../utils/clipboard';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { requestToast } from './ToastHost';
import { useWebShellPortalRoot } from '../portalRoot';
import {
  LOCAL_FILES_DAEMON_COMMAND,
  LocalFilesPanel,
  deriveLocalFilesDaemonCommand,
  getLocalFilesDotClass,
  getLocalFilesTooltip,
  type LocalFilesPanelProps,
} from './LocalFilesPanel';
import { cn } from '@/lib/utils';

export {
  LOCAL_FILES_DAEMON_COMMAND,
  LocalFilesPanel,
  deriveLocalFilesDaemonCommand,
  getLocalFilesDotClass,
  getLocalFilesTooltip,
  type LocalFilesPanelProps,
};

interface LocalFilesTunnelTarget {
  host: string;
  remotePort: number;
  localPort: number;
}

/**
 * Parse the daemon URL into an SSH tunnel target. The local bind port is
 * always DIFFERENT from the daemon's port: in the same-machine LAN case (the
 * browser runs on the daemon host and the page was opened via the LAN IP)
 * the daemon already holds that port, so an identity forward cannot bind.
 * The offset also keeps the bind unprivileged (a non-root user cannot bind
 * 80/443); it wraps down for ports near the top of the range. The remote
 * port stays the daemon's. IPv6 hostnames are unbracketed because ssh takes
 * a bare host.
 *
 * The host is allowlisted because the command is pasted into a shell: the
 * WHATWG URL parser preserves shell metacharacters in the host (`http://a;b/`
 * parses with hostname `a;b`), and a leading `-` would reach ssh's own option
 * parser. `:` stays allowed for bare IPv6 addresses. Returns undefined for a
 * relative/base-less URL or a host outside the allowlist (no safe tunnel).
 */
function parseLocalFilesTunnelTarget(
  baseUrl: string,
): LocalFilesTunnelTarget | undefined {
  try {
    const url = new URL(baseUrl);
    if (!url.hostname) return undefined;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!/^[A-Za-z0-9._:-]+$/.test(host) || host.startsWith('-')) {
      return undefined;
    }
    const remotePort = Number(
      url.port || (url.protocol === 'https:' ? '443' : '80'),
    );
    const localPort =
      remotePort + 8000 <= 65535 ? remotePort + 8000 : remotePort - 8000;
    return { host, remotePort, localPort };
  } catch {
    return undefined;
  }
}

/** Derive the SSH tunnel command for the insecure-context blocker. */
export function deriveLocalFilesTunnelCommand(
  baseUrl: string,
): string | undefined {
  const target = parseLocalFilesTunnelTarget(baseUrl);
  if (target === undefined) return undefined;
  return `ssh -L ${target.localPort}:localhost:${target.remotePort} ${target.host}`;
}

/** The local port the copied tunnel binds — the address the user must open. */
export function deriveLocalFilesTunnelLocalPort(
  baseUrl: string,
): number | undefined {
  return parseLocalFilesTunnelTarget(baseUrl)?.localPort;
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
  // Own the toast dispatch scope: ownership must not be inferred from focus,
  // which can sit in a co-mounted shell or nowhere at all.
  const toastScope = useWebShellPortalRoot();
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
        toastScope,
      );
    }
  }, [status.phase, status.rootName, t, toastScope]);

  const handleCopyCommand = useCallback(
    (command: string) => {
      void writeClipboardText(command).then(
        () => requestToast('success', t('localFiles.copied'), toastScope),
        () => requestToast('error', t('localFiles.copyFailed'), toastScope),
      );
    },
    [t, toastScope],
  );

  // Concrete SSH tunnel for the insecure-context blocker, when the daemon URL
  // is absolute. A relative base (same-origin) yields no command.
  const tunnelCommand = useMemo(
    () => deriveLocalFilesTunnelCommand(baseUrl),
    [baseUrl],
  );
  const tunnelLocalPort = useMemo(
    () => deriveLocalFilesTunnelLocalPort(baseUrl),
    [baseUrl],
  );
  // PowerShell cannot parse the POSIX env-prefix form; copy the syntax the
  // user's shell actually accepts.
  const daemonCommand = useMemo(() => {
    const nav = navigator as Navigator & {
      userAgentData?: { platform?: string };
    };
    return deriveLocalFilesDaemonCommand(
      nav.userAgentData?.platform ?? nav.platform,
    );
  }, []);

  const dotClass = getLocalFilesDotClass(status);
  // The state is colour + a native tooltip, both invisible to assistive tech.
  // Expose it as a description (the accessible name stays the stable trigger
  // label so name-based queries and screen-reader naming are unchanged).
  const stateDescription = getLocalFilesTooltip(status, t);
  const stateDescriptionId = useId();

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
            // The picker cannot run in a cross-origin frame, but it can in the
            // top-level document this one is framed inside.
            window.open(window.location.href, '_blank', 'noopener');
          }}
          onChangeDirectory={() => {
            void connect({ forcePicker: true }).then((result) => {
              // A failed re-pick keeps the running bridge connected, but the
              // click must not be silent (R1-5).
              if (result?.kind === 'repick-failed') {
                requestToast(
                  'error',
                  t('localFiles.changeDirectoryFailed'),
                  toastScope,
                );
              } else if (result?.kind === 'change-deferred') {
                // The grant is saved but the live bridge keeps serving the old
                // directory until the workspace verdict settles; say so.
                requestToast(
                  'info',
                  t('localFiles.changeDirectoryDeferred'),
                  toastScope,
                );
              }
            });
          }}
          sessionName={displayName}
          onNewSession={() => {
            // newSession reports its own failures through the notice system.
            void sessionActions.newSession().catch(() => {});
          }}
          onCopyCommand={handleCopyCommand}
          tunnelCommand={tunnelCommand}
          tunnelLocalPort={tunnelLocalPort}
          daemonCommand={daemonCommand}
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
