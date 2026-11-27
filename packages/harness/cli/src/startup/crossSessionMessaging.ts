/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Startup wiring for cross-session peer messaging.
 *
 * Binds this session's socket, publishes its registry entry, and connects the
 * inbound gate to the CLI's settings and permission mode. Every failure here is
 * non-fatal: a session that cannot bind simply has no peers.
 */

import {
  CoreEvent,
  PEER_PROTOCOL_VERSION,
  coreEvents,
  getDefaultUdsSocketPath,
  getProcessStartMs,
  currentModeClass,
  isCrossSessionMessagingEnabled,
  probeSocket,
  reevaluateHeldMessages,
  refreshSessionRegistryEntry,
  removeSessionRegistryEntry,
  runLogger,
  setCrossSessionInboundResolver,
  setPermissionModeGetter,
  setReviewSurfaceAvailable,
  settleHeldMessagesOnShutdown,
  startUdsMessaging,
  writeSessionRegistryEntry,
  type Config,
  type UdsMessagingHandle,
} from '@qwen-code/core';
import { resolveCrossSessionInbound } from '../config/crossSessionInbound.js';
import type { LoadedSettings } from '../config/settings.js';

export interface StartCrossSessionMessagingParams {
  config: Config;
  settings: LoadedSettings;
  /** Explicit socket path from `--messaging-socket-path`. */
  explicitSocketPath?: string;
}

/** Undo function, or undefined when nothing was started. */
export type StopCrossSessionMessaging = () => Promise<void>;

/**
 * Only long-lived sessions are worth advertising. A one-shot headless run exits
 * before a peer could plausibly reach it, and binding would leave a registry
 * entry behind for a process that is already gone.
 */
function shouldBind(config: Config, explicitSocketPath?: string): boolean {
  return explicitSocketPath !== undefined || config.isInteractive();
}

/**
 * Warns a session that will refuse every peer message it receives.
 *
 * A non-interactive session cannot show an approval prompt, so a parity hold
 * there is resolved to a refusal rather than parked where nobody will find it.
 * With no sender declaring a mode class — the default — a bypass-class headless
 * session therefore refuses everything, which is correct but silent enough to
 * look like a transport failure.
 *
 * Logged rather than surfaced through `coreEvents.emitFeedback`, because the
 * defining property of this session is that no one is reading its history. The
 * sending model is told separately: a refusal sends a `denied` receipt.
 */
function warnIfInboundRefusesEverything(
  config: Config,
  settings: LoadedSettings,
): void {
  if (config.isInteractive()) return;
  if (resolveCrossSessionInbound(settings) !== undefined) return;
  if (currentModeClass() !== 'bypass') return;

  runLogger.warn(
    '[uds-messaging] This session bypasses permission checks and has no way to ' +
      'show an approval prompt, so inbound peer messages will be refused. Set ' +
      'security.crossSessionInbound to "accept" in your user settings to allow them.',
  );
}

export async function startCrossSessionMessaging(
  params: StartCrossSessionMessagingParams,
): Promise<StopCrossSessionMessaging | undefined> {
  const { config, settings, explicitSocketPath } = params;

  if (!isCrossSessionMessagingEnabled()) return undefined;
  if (!shouldBind(config, explicitSocketPath)) {
    runLogger.debug('[uds-messaging] Skipped: session is not long-lived');
    return undefined;
  }

  // Wire the gate before binding so a message arriving during startup is judged
  // against real settings rather than defaults.
  setCrossSessionInboundResolver(() => {
    const resolved = resolveCrossSessionInbound(settings);
    return resolved
      ? { policy: resolved.policy, source: resolved.source }
      : undefined;
  });
  setPermissionModeGetter(() => config.getPermissionMode());
  // A non-interactive session bound only via an explicit socket path has no one
  // to work through /peers, so parity holds there are refused instead.
  setReviewSurfaceAvailable(config.isInteractive());
  warnIfInboundRefusesEverything(config, settings);

  // The gate is wired before the bind so a message arriving during startup is
  // judged against real settings — which makes every path out of here, including
  // the ones that never bind, responsible for putting it back. Without this a
  // failed bind left three process globals holding a closure over this session's
  // config, with no way for them to answer anything they went on to judge.
  const unwireInboundGate = () => {
    setCrossSessionInboundResolver(undefined);
    setPermissionModeGetter(undefined);
    setReviewSurfaceAvailable(true);
  };

  const startedAt = Date.now();
  const socketPath = explicitSocketPath ?? getDefaultUdsSocketPath();

  if (explicitSocketPath !== undefined && (await probeSocket(socketPath))) {
    runLogger.error(
      `[uds-messaging] --messaging-socket-path points at a live socket: ${socketPath}`,
    );
    unwireInboundGate();
    return undefined;
  }

  let handle: UdsMessagingHandle | undefined;
  try {
    handle = await startUdsMessaging(socketPath, {
      isExplicit: explicitSocketPath !== undefined,
      getSessionId: () => config.getSessionId(),
    });
  } catch (error) {
    runLogger.error(`[uds-messaging] Bind threw: ${error}`);
  }

  if (!handle) {
    unwireInboundGate();
    return undefined;
  }

  const topic = config.topicState?.getTopic();
  await writeSessionRegistryEntry({
    pid: process.pid,
    procStart: getProcessStartMs(),
    startedAt,
    cwd: process.cwd(),
    sessionId: config.getSessionId(),
    ...(topic ? { name: topic } : {}),
    kind: config.isInteractive() ? 'interactive' : 'bg',
    status: 'idle',
    messagingSocketPath: handle.socketPath,
    peerProtocol: PEER_PROTOCOL_VERSION,
  });

  // A mode change can turn a held message into a deliverable one (or into a
  // refusal), so the queue is re-judged rather than left stale.
  const onPermissionModeChanged = () => reevaluateHeldMessages();
  coreEvents.on(CoreEvent.PermissionModeChanged, onPermissionModeChanged);

  // So can a settings change, and this is the more direct route: a user who
  // sees a held message and decides the sender is trustworthy sets
  // crossSessionInbound to accept. Without this the setting that exists to
  // control the queue would not act on what is already in it.
  const onSettingsChanged = () => reevaluateHeldMessages();
  coreEvents.on(CoreEvent.SettingsChanged, onSettingsChanged);

  // The registry entry above is a snapshot, and at bind time the topic is
  // usually still unset: `--name`, a resumed title and the model's own
  // `SetTopic` all land after this point. Republishing on every title change
  // covers all of them, and is what keeps a peer's address book current when a
  // session is renamed mid-run.
  const onSessionTitleChanged = ({ title }: { title: string }) =>
    refreshSessionRegistryEntry({ name: title });
  coreEvents.on(CoreEvent.SessionTitleChanged, onSessionTitleChanged);

  return async () => {
    coreEvents.off(CoreEvent.PermissionModeChanged, onPermissionModeChanged);
    coreEvents.off(CoreEvent.SettingsChanged, onSettingsChanged);
    coreEvents.off(CoreEvent.SessionTitleChanged, onSessionTitleChanged);
    // Settle before closing: a peer told its message is "awaiting approval"
    // would otherwise never hear that this session went away. Bounded, so an
    // unreachable peer cannot hold up exit.
    await settleHeldMessagesOnShutdown();
    unwireInboundGate();
    await handle.close();
    // Cancels any coalesced refresh and drops the published entry, so nothing
    // still in flight can re-create a file for a session that is now gone.
    await removeSessionRegistryEntry();
  };
}
