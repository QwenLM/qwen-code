/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Post-render startup work for the OpenTUI entry (ink parity).
 *
 * The ink branch of `startInteractiveUI` calls `startPostRenderPrefetches`
 * immediately after `render()` returns — update check, deferred IDE connect,
 * deferred telemetry init and background housekeeping
 * (`startInteractiveUI.tsx:304-309`). The OpenTUI branch returned early, so
 * ALL of it was skipped (telemetry in particular was never initialised, so
 * every telemetry event was dropped). This module runs the same prefetches
 * and gives the update check a minimal consumption surface (a notice
 * callback the backend renders as a footer/toast hint), which the OpenTUI
 * tree previously lacked entirely.
 */

import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { startPostRenderPrefetches } from '../../startup/startup-prefetch.js';
import { MessageType, type HistoryItemWithoutId } from '../types.js';
import { setUpdateHandler } from '../../utils/handleAutoUpdate.js';

export interface PostRenderOptions {
  connectIde?: boolean;
  initializeTelemetry?: boolean;
}

/** Runs the same post-render prefetches the ink path does. */
export function startOpenTuiPostRenderPrefetches(
  config: Config,
  settings: LoadedSettings,
  options: PostRenderOptions = {},
): void {
  startPostRenderPrefetches(config, settings, {
    connectIde: options.connectIde ?? false,
    initializeTelemetry:
      options.initializeTelemetry ?? config.isTelemetryInitializationDeferred(),
  });
}

export interface UpdateNotificationHandle {
  /** Removes the update-event listeners. */
  dispose: () => void;
  /** Emits any notifications deferred while a turn was in flight. */
  flush: () => void;
}

/**
 * Subscribes to update-check notifications and surfaces them through
 * `onNotice` (the backend renders these as a footer/toast hint). This is the
 * minimal consumption surface the task requires — without it the startup
 * update check's result went nowhere in the OpenTUI tree.
 *
 * Uses the shared `setUpdateHandler` so message wording, the 60s
 * install-window suppression and severity mapping stay identical to ink.
 * Notifications arriving while `isIdleRef.current` is false are deferred and
 * released by calling the returned `flush()` (the backend does this when a
 * turn settles).
 */
export function setupUpdateNotifications(
  onNotice: (item: HistoryItemWithoutId) => void,
  isIdleRef: { current: boolean } = { current: true },
): UpdateNotificationHandle {
  const handler = setUpdateHandler(
    (item) => onNotice(item),
    // OpenTUI has no dedicated update-info footer slot; the transient state
    // is irrelevant because the notice itself carries the message.
    () => {},
    isIdleRef,
  );
  return { dispose: () => handler.cleanup(), flush: () => handler.flush() };
}

export { MessageType };
