/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createDebugLogger,
  IdeClient,
  initializeTelemetry,
  type Config,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import { preconnectApi } from '../utils/apiPreconnect.js';
import { AppEvent, appEvents } from '../utils/events.js';
import { recordStartupEvent } from '../utils/startupProfiler.js';
import {
  CUSTOM_SANDBOX_IMAGE_ENV_VAR,
  HOST_UPDATE_RELAUNCH_ENV_VAR,
  SKIP_UPDATE_CHECK_ENV_VAR,
  requestUpdateOnExit,
} from '../utils/processUtils.js';

const debugLogger = createDebugLogger('STARTUP_PREFETCH');

const DEFERRED_IDE_CONNECT_TIMEOUT_MS = 15_000;

const earlyStarted = new WeakSet<Config>();
const postRenderStarted = new WeakSet<Config>();

/**
 * Bounds optional startup work without cancelling the underlying promise.
 *
 * The original promise can still complete after the timeout branch wins the
 * race. We keep observing that late result so a late IDE success can be cleaned
 * up and a late rejection does not become an unhandled rejection.
 */
function withTimeout<T>(
  promise: Promise<T>,
  name: string,
  timeoutMs: number,
  onTimeout: () => Promise<void> | void = () => {},
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const runTimeoutCleanup = () => {
    void Promise.resolve()
      .then(onTimeout)
      .catch((err) => {
        debugLogger.debug(`${name} timeout cleanup failed:`, err);
      });
  };
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      runTimeoutCleanup();
      reject(new Error(`${name} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutId.unref?.();
  });

  // This rejection handler intentionally mirrors `catch()`: it handles the
  // underlying promise if it rejects after the timeout has already been reported.
  void promise.then(
    () => {
      if (timedOut) {
        runTimeoutCleanup();
      }
    },
    (err) => {
      if (timedOut) {
        debugLogger.debug(`${name} underlying error after timeout:`, err);
      }
    },
  );

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

/**
 * Starts a best-effort startup task without adding it to the caller's
 * critical path. Failures are recorded for diagnostics and otherwise
 * swallowed so optional prefetch work cannot break REPL startup.
 */
function runDeferredTask(name: string, task: () => Promise<void> | void): void {
  recordStartupEvent('startup_prefetch_started', { name });
  void Promise.resolve()
    .then(task)
    .then(() => {
      recordStartupEvent('startup_prefetch_completed', { name });
    })
    .catch((err) => {
      recordStartupEvent('startup_prefetch_failed', { name });
      debugLogger.warn(`${name} failed:`, err);
    });
}

/**
 * Keeps deferred IDE timeout semantics consistent with the visible failure UI.
 *
 * A deferred IDE connection cannot be aborted directly, so on timeout we close
 * the singleton client. If the original connect later succeeds, `withTimeout`
 * invokes this cleanup again to avoid leaving an active IDE connection behind a
 * stale startup failure state.
 */
async function disconnectIdeAfterDeferredTimeout(): Promise<void> {
  const ideClient = await IdeClient.getInstance();
  await ideClient.disconnect();
}

/**
 * Starts pre-render startup prefetches that benefit from maximum lead time.
 *
 * This runs after `loadCliConfig()` has produced a Config, but before
 * `initializeApp()` and UI rendering. Keep this phase limited to work that is
 * cheap to start, independent of Ink/React, and safe to ignore on failure.
 */
export function startEarlyStartupPrefetches(config: Config): void {
  if (earlyStarted.has(config)) return;
  earlyStarted.add(config);

  try {
    const modelsConfig = config.getModelsConfig();
    const authType = modelsConfig.getCurrentAuthType();
    const resolvedBaseUrl = modelsConfig.getGenerationConfig().baseUrl;
    const proxy = config.getProxy();
    preconnectApi(authType, { resolvedBaseUrl, proxy });
  } catch (error) {
    debugLogger.debug(
      `Preconnect skipped due to error getting authType: ${error}`,
    );
  }
}

/**
 * Starts post-render startup prefetches for ordinary interactive TUI sessions.
 *
 * This runs immediately after Ink's `render()` returns (`first_paint`). Tasks
 * here may load heavier modules or perform network/IPC work, but they must not
 * affect `startInteractiveUI()` success. `connectIde` is opt-in so headless,
 * stream-json, and ACP/Zed paths can keep their awaited IDE startup semantics.
 */
export function startPostRenderPrefetches(
  config: Config,
  settings: LoadedSettings,
  options: { connectIde?: boolean; initializeTelemetry?: boolean } = {},
): void {
  if (postRenderStarted.has(config)) return;
  postRenderStarted.add(config);

  if (
    settings.merged.general?.enableAutoUpdate !== false &&
    process.env[SKIP_UPDATE_CHECK_ENV_VAR] !== 'true' &&
    !process.env[CUSTOM_SANDBOX_IMAGE_ENV_VAR]
  ) {
    runDeferredTask('update_check', async () => {
      const [
        { checkForUpdatesDetailed },
        { handleAutoUpdate },
        { getInstallationInfo },
        { updateEventEmitter },
        { t },
      ] = await Promise.all([
        import('../ui/utils/updateCheck.js'),
        import('../utils/handleAutoUpdate.js'),
        import('../utils/installationInfo.js'),
        import('../utils/updateEventEmitter.js'),
        import('../i18n/index.js'),
      ]);
      const updateFailedMessage = t(
        'Failed to check for updates. Please check your network or registry configuration.',
      );
      try {
        const result = await checkForUpdatesDetailed();
        if (result.status === 'update') {
          const projectRoot = config.getProjectRoot();
          const hostUpdateRelaunch = process.env[HOST_UPDATE_RELAUNCH_ENV_VAR];
          if (hostUpdateRelaunch === 'true') {
            updateEventEmitter.emit('update-info', {
              message: `${result.info.message}\n${t(
                'Run /update to install the update on the host.',
              )}`,
            });
            return;
          }
          if (hostUpdateRelaunch === 'false') {
            updateEventEmitter.emit('update-info', {
              message: `${result.info.message}\n${t(
                'Update Qwen Code on the host, then restart the sandbox.',
              )}`,
            });
            return;
          }
          const installationInfo = getInstallationInfo(projectRoot, true);
          if (installationInfo.packageManager === 'npm') {
            void handleAutoUpdate(result.info, settings, projectRoot);
            return;
          }
          if (
            installationInfo.updateCommand ||
            (installationInfo.isStandalone && installationInfo.standaloneDir)
          ) {
            if (requestUpdateOnExit()) {
              updateEventEmitter.emit('update-info', {
                message: `${result.info.message}\n${t(
                  'The update will be installed after you exit this session.',
                )}`,
              });
            } else {
              updateEventEmitter.emit('update-info', {
                message: `${result.info.message}\n${t(
                  'Run /update to install the update.',
                )}`,
              });
            }
          } else {
            void handleAutoUpdate(result.info, settings, projectRoot);
          }
        } else if (result.status === 'error') {
          updateEventEmitter.emit('update-failed', {
            message: updateFailedMessage,
          });
        }
      } catch (error) {
        updateEventEmitter.emit('update-failed', {
          message: updateFailedMessage,
        });
        throw error;
      }
    });
  }

  if (options.connectIde && config.getIdeMode()) {
    runDeferredTask('ide_connect', async () => {
      appEvents.emit(AppEvent.StartupIdeConnectionStatusChanged, {
        state: 'connecting',
      });
      try {
        const { connectIdeForStartup } = await import('../core/initializer.js');
        await withTimeout(
          connectIdeForStartup(config),
          'ide_connect',
          DEFERRED_IDE_CONNECT_TIMEOUT_MS,
          disconnectIdeAfterDeferredTimeout,
        );
        appEvents.emit(AppEvent.StartupIdeConnectionStatusChanged, {
          state: 'connected',
        });
      } catch (err) {
        appEvents.emit(AppEvent.StartupIdeConnectionStatusChanged, {
          state: 'failed',
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });
  }

  if (options.initializeTelemetry) {
    runDeferredTask('telemetry_init', () => {
      initializeTelemetry(config);
    });
  }

  if (config.isInteractive()) {
    runDeferredTask('background_housekeeping', async () => {
      const { startBackgroundHousekeeping } = await import(
        '../utils/housekeeping/scheduler.js'
      );
      startBackgroundHousekeeping(config, settings);
    });
  }
}
