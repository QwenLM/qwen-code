/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';
import { runLogger } from './runLogger.js';
import { traceStartupStepAsync } from './startupTrace.js';

export interface StartupPhaseHandle {
  end(details?: Record<string, string | number | boolean>): void;
}

interface StartupPhase {
  name: string;
  ended: boolean;
}

export class StartupProfiler {
  private phases = new Map<string, StartupPhase>();
  private static instance: StartupProfiler;

  private constructor() {}

  static getInstance(): StartupProfiler {
    return (StartupProfiler.instance ??= new StartupProfiler());
  }

  traceAsync<T>(
    phaseName: string,
    action: () => Promise<T>,
    details?: Record<string, string | number | boolean>,
  ): Promise<T> {
    let handle: StartupPhaseHandle | undefined;
    try {
      handle = this.start(phaseName, details);
    } catch {}
    return traceStartupStepAsync(phaseName, action, (_duration, status) => {
      handle?.end({ status: status === 'rejected' ? 'error' : 'success' });
    });
  }

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
    performance.mark(`startup:${phaseName}:start`, { detail: details });
    const phase: StartupPhase = { name: phaseName, ended: false };
    this.phases.set(phaseName, phase);
    return { end: (endDetails) => this.end(phase, endDetails) };
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
    const startMarkName = `startup:${phase.name}:start`;
    const endMarkName = `startup:${phase.name}:end`;
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
