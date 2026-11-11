/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';
import { runLogger } from './runLogger.js';
import { traceStartupStepAsync } from './startupTrace.js';

/**
 * Handle returned by start() that allows ending the phase without repeating the phase name.
 */
export interface StartupPhaseHandle {
  end(details?: Record<string, string | number | boolean>): void;
}

interface StartupPhase {
  name: string;
  ended: boolean;
}

/**
 * Marks startup phases on the process `performance` timeline.
 *
 * Local only: the marks and measures are what the startup trace recorder
 * captures into `startup-trace.json`; nothing is aggregated or reported.
 */
export class StartupProfiler {
  private phases: Map<string, StartupPhase> = new Map();
  private static instance: StartupProfiler;

  private constructor() {}

  static getInstance(): StartupProfiler {
    if (!StartupProfiler.instance) {
      StartupProfiler.instance = new StartupProfiler();
    }
    return StartupProfiler.instance;
  }

  /** Keep the step log and the timeline mark on the same operation; timing never changes the result. */
  traceAsync<T>(
    phaseName: string,
    action: () => Promise<T>,
    details?: Record<string, string | number | boolean>,
  ): Promise<T> {
    let handle: StartupPhaseHandle | undefined;
    try {
      handle = this.start(phaseName, details);
    } catch {
      // Timing is best effort; initialization must still run.
    }
    return traceStartupStepAsync(phaseName, action, (_duration, status) => {
      handle?.end({ status: status === 'rejected' ? 'error' : 'success' });
    });
  }

  private getStartMarkName(phaseName: string): string {
    return `startup:${phaseName}:start`;
  }

  private getEndMarkName(phaseName: string): string {
    return `startup:${phaseName}:end`;
  }

  /**
   * Marks the start of a phase and returns a handle to end it.
   *
   * If a phase with the same name is already active (started but not ended),
   * this method logs a warning and returns `undefined`, so callers use
   * optional chaining: `handle?.end()`.
   */
  start(
    phaseName: string,
    details?: Record<string, string | number | boolean>,
  ): StartupPhaseHandle | undefined {
    const existingPhase = this.phases.get(phaseName);
    if (existingPhase && !existingPhase.ended) {
      runLogger.warn(
        `[STARTUP] Cannot start phase '${phaseName}': phase is already active. Call end() before starting again.`,
      );
      return undefined;
    }

    performance.mark(this.getStartMarkName(phaseName), { detail: details });
    const phase: StartupPhase = { name: phaseName, ended: false };
    this.phases.set(phaseName, phase);

    return {
      end: (endDetails?: Record<string, string | number | boolean>) => {
        this.end(phase, endDetails);
      },
    };
  }

  private end(
    phase: StartupPhase,
    details?: Record<string, string | number | boolean>,
  ): void {
    if (phase.ended) {
      runLogger.warn(
        `[STARTUP] Cannot end phase '${phase.name}': phase was already ended.`,
      );
      return;
    }
    phase.ended = true;

    const startMarkName = this.getStartMarkName(phase.name);
    const endMarkName = this.getEndMarkName(phase.name);
    if (performance.getEntriesByName(startMarkName).length === 0) {
      runLogger.warn(
        `[STARTUP] Cannot measure phase '${phase.name}': start mark '${startMarkName}' not found.`,
      );
      return;
    }

    performance.mark(endMarkName, { detail: details });
    performance.measure(phase.name, startMarkName, endMarkName);
  }
}

export const startupProfiler = StartupProfiler.getInstance();
