/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  initializeRuntimeProfiler,
  type RuntimeProfilerOptions,
} from './runtimeProfiler.js';
import { runLogger } from './runLogger.js';

let handlersRegistered = false;
let signalProfilerOptions: RuntimeProfilerOptions | undefined;
let sigUsr1InFlight = false;
let sigUsr2InFlight = false;

export function registerProfilingSignalHandlers(
  options?: RuntimeProfilerOptions,
): void {
  if (options) {
    signalProfilerOptions = options;
  }

  if (handlersRegistered) {
    return;
  }

  if (process.platform === 'win32') {
    runLogger.debug(
      '[runtime-profiler] Skipping SIGUSR signal handlers on Windows.',
    );
    return;
  }

  process.on('SIGUSR1', handleSigUsr1);
  process.on('SIGUSR2', handleSigUsr2);
  handlersRegistered = true;

  runLogger.debug(
    '[runtime-profiler] Signal handlers registered (SIGUSR1=toggle CPU, SIGUSR2=heap snapshot).',
  );
}

async function handleSigUsr1(): Promise<void> {
  if (sigUsr1InFlight) {
    runLogger.warn(
      '[runtime-profiler] SIGUSR1 ignored because the previous SIGUSR1 handler is still running.',
    );
    return;
  }

  sigUsr1InFlight = true;
  try {
    const profiler = initializeRuntimeProfiler(signalProfilerOptions);

    if (profiler.isCpuProfilingActive() || profiler.hasPendingCpuProfile()) {
      const result = await profiler.stopCpuProfiling();
      runLogger.log(
        `[runtime-profiler] SIGUSR1: Encrypted CPU profile saved: ${result.filePath}`,
      );
    } else {
      await profiler.startCpuProfiling();
      runLogger.log(
        '[runtime-profiler] SIGUSR1: CPU profiling started (send SIGUSR1 again to stop and save).',
      );
    }
  } catch (err) {
    runLogger.error(`[runtime-profiler] SIGUSR1 handler error: ${err}`);
  } finally {
    sigUsr1InFlight = false;
  }
}

async function handleSigUsr2(): Promise<void> {
  if (sigUsr2InFlight) {
    runLogger.warn(
      '[runtime-profiler] SIGUSR2 ignored because the previous SIGUSR2 handler is still running.',
    );
    return;
  }

  sigUsr2InFlight = true;
  try {
    const profiler = initializeRuntimeProfiler(signalProfilerOptions);
    const result = await profiler.takeHeapSnapshot();
    runLogger.log(
      `[runtime-profiler] SIGUSR2: Encrypted heap snapshot saved: ${result.filePath}`,
    );
  } catch (err) {
    runLogger.error(`[runtime-profiler] SIGUSR2 handler error: ${err}`);
  } finally {
    sigUsr2InFlight = false;
  }
}

export function _resetSignalHandlers(): void {
  if (handlersRegistered) {
    process.removeListener('SIGUSR1', handleSigUsr1);
    process.removeListener('SIGUSR2', handleSigUsr2);
  }

  handlersRegistered = false;
  signalProfilerOptions = undefined;
  sigUsr1InFlight = false;
  sigUsr2InFlight = false;
}
