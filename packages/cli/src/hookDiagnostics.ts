/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CoreEvent,
  coreEvents,
  runLogger,
  createHookConfigurationRef,
  type Config,
  type HookDiagnosticsSnapshot,
} from '@qwen-code/core';
import { originalHookSettingsPath } from '@qwen-code/resource';
import type { LoadedSettings } from './config/settings.js';

/** Project existing diagnostics only. This does not read files or run hooks. */
export function buildHookDiagnostics(
  config: Config,
  settings: LoadedSettings,
  failed = false,
): HookDiagnosticsSnapshot {
  const reference = (
    source: string,
    event: string,
    groupIndex: number,
    hookIndex: number,
    runtimePosition = false,
  ): string | undefined => {
    if (!['user', 'project', 'local', 'flag'].includes(source))
      return undefined;
    const file = settings[source as 'user' | 'project' | 'local' | 'flag'];
    if (runtimePosition) {
      const originalPath = originalHookSettingsPath(file.settings, [
        'hooks',
        event,
        groupIndex,
        'hooks',
        hookIndex,
      ]);
      groupIndex = originalPath[2] as number;
      hookIndex = originalPath[4] as number;
    }
    const groups: unknown = (
      file.originalSettings.hooks as Record<string, unknown> | undefined
    )?.[event];
    const group: unknown = Array.isArray(groups)
      ? groups[groupIndex]
      : undefined;
    const hooks =
      group && typeof group === 'object' && 'hooks' in group
        ? group.hooks
        : undefined;
    const hook: unknown = Array.isArray(hooks) ? hooks[hookIndex] : undefined;
    return hook === undefined
      ? undefined
      : createHookConfigurationRef(
          `settings:${source}`,
          event,
          groupIndex,
          hookIndex,
          hook,
        );
  };
  const diagnostics =
    config
      .getHookSystem()
      ?.getRegistry()
      .getDiagnostics((source, event, groupIndex, hookIndex) =>
        reference(source, event, groupIndex, hookIndex, true),
      ) ?? [];
  let incomplete = false;
  for (const source of ['user', 'project', 'local', 'flag'] as const) {
    if (!config.isSettingSourceAllowed(source)) continue;
    if (
      (source === 'project' || source === 'local') &&
      !config.isTrustedFolder()
    )
      continue;
    const file = settings[source];
    if (file.loadRejected) {
      incomplete = true;
      diagnostics.push({
        code: 'settings_load_error',
        message:
          'Could not read or parse settings containing Hook configuration.',
      });
      continue;
    }
    for (const error of settings.errors.filter(
      (error) => error.path === file.path,
    )) {
      // Recoverable settings validation already supplies the affected field.
      // Never forward raw parser errors, paths, plugin identities or stack traces.
      const match =
        /^Ignored invalid setting "(hooks(?:\.[\w]+|\[\d+\])*)": (.+)$/s.exec(
          error.message,
        );
      if (match) {
        const target = /^hooks\.(\w+)\[(\d+)\]\.hooks\[(\d+)\](?:\.|$)/.exec(
          match[1],
        );
        const hookRef = target
          ? reference(source, target[1], Number(target[2]), Number(target[3]))
          : undefined;
        diagnostics.push({
          ...(hookRef ? { hook_ref: hookRef, event: target![1] } : {}),
          code: 'settings_load_error',
          field: match[1],
          message: match[2],
        });
      }
    }
  }
  if (config.isSettingSourceAllowed('plugin')) {
    for (const error of config.getPluginErrors()) {
      if (
        error.type === 'hook-load-failed' ||
        (error.type === 'component-load-failed' && error.component === 'hooks')
      ) {
        incomplete = true;
        diagnostics.push({
          code: 'plugin_hook_load_error',
          message:
            'Could not load Hook configuration. Check its format and readability.',
        });
      }
    }
  }
  if (failed) {
    diagnostics.push({
      code: 'hook_reload_error',
      message:
        'Could not refresh Hook diagnostics. Previous results may be out of date.',
    });
  }
  return {
    readStatus: failed ? 'failed' : incomplete ? 'partial' : 'complete',
    checkedAt: new Date().toISOString(),
    diagnostics,
  };
}

/** Session-local subscription; initial publication is deferred until SDK init. */
export function createHookDiagnosticsPublisher(options: {
  config: Config;
  getSettings: () => LoadedSettings;
  publish: (snapshot: HookDiagnosticsSnapshot) => void;
}): { start(): void; dispose(): void } {
  let started = false;
  let disposed = false;
  let pending: ReturnType<typeof setImmediate> | undefined;
  let latestFailed = false;
  const schedule = (failed = false) => {
    if (!started || disposed) return;
    latestFailed = failed;
    if (pending) return;
    // Yield to the event loop, not a microtask: initialization/reload callers
    // never build, serialize or wait for this optional diagnostic snapshot.
    // Coalesce a burst into the latest state, including successful repairs.
    pending = setImmediate(() => {
      pending = undefined;
      if (disposed) return;
      try {
        options.publish(
          buildHookDiagnostics(
            options.config,
            options.getSettings(),
            latestFailed,
          ),
        );
      } catch {
        // Diagnostics are best-effort. Never fail the session or leak config
        // contents through an exception; the next refresh can try again.
        runLogger.warn(
          '[HookDiagnostics] Background snapshot publication failed',
        );
      }
    });
  };
  const unsubscribe = coreEvents.onSessionEvent(
    CoreEvent.HookDiagnosticsChanged,
    options.config.getSessionId(),
    ({ failed }) => schedule(failed),
  );
  return {
    start() {
      if (started || disposed) return;
      started = true;
      schedule();
    },
    dispose() {
      disposed = true;
      if (pending) clearImmediate(pending);
      pending = undefined;
      unsubscribe();
    },
  };
}
