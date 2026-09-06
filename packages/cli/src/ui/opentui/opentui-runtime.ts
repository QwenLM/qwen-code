/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI runtime sidecar — the framework-neutral, out-of-React-tree
 * infrastructure that `startInteractiveUI.tsx` sets up before and after it
 * renders the ink tree. Batch 5 extracts ONLY the pieces the OpenTUI backend
 * reuses as-is (dual-output bridge, remote input watcher, runtime.json sidecar,
 * periodic memory-pressure monitor) so the composition root does not depend on
 * the ink entry point. Peer-messaging bootstrap, kitty negotiation, terminal
 * optimizer install/restore, session registration and the exit-echo teardown
 * stay with the Batch 6 entry wiring that owns the real terminal.
 */

import {
  createDebugLogger,
  writeRuntimeStatus,
  type Config,
} from '@qwen-code/qwen-code-core';
import { DualOutputBridge } from '../../dualOutput/DualOutputBridge.js';
import { RemoteInputWatcher } from '../../remoteInput/RemoteInputWatcher.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

const debugLogger = createDebugLogger('OPEN_TUI_RUNTIME');

// The tool scheduler only runs a pressure check after a tool call, so a long
// conversation with no tool calls could grow toward the V8 heap limit. This
// interval closes that gap. Mirrors startInteractiveUI.tsx.
const PRESSURE_CHECK_INTERVAL_MS = 30_000;

export interface OpenTuiRuntimeOptions {
  config: Config;
  version: string;
}

/**
 * Owns the non-React infrastructure shared by every OpenTUI screen. Created
 * once by the entry wiring (Batch 6), passed down through the app shell, and
 * torn down via {@link shutdown} on exit.
 */
export class OpenTuiRuntime {
  readonly dualOutputBridge: DualOutputBridge | null;
  readonly remoteInputWatcher: RemoteInputWatcher | null;

  private pressureCheckTimer: NodeJS.Timeout | undefined;

  private constructor(
    private readonly config: Config,
    private readonly version: string,
    dualOutputBridge: DualOutputBridge | null,
    remoteInputWatcher: RemoteInputWatcher | null,
  ) {
    this.dualOutputBridge = dualOutputBridge;
    this.remoteInputWatcher = remoteInputWatcher;
  }

  /**
   * Builds the optional bridges, degrading gracefully: a bad `--json-fd` /
   * `--json-file` / `--input-file` must warn on stderr, not prevent startup.
   */
  static create(options: OpenTuiRuntimeOptions): OpenTuiRuntime {
    const { config, version } = options;

    let dualOutputBridge: DualOutputBridge | null = null;
    const jsonFd = config.getJsonFd?.();
    const jsonFile = config.getJsonFile?.();
    try {
      if (jsonFd != null) {
        dualOutputBridge = new DualOutputBridge(
          config,
          { fd: jsonFd },
          { version },
        );
      } else if (jsonFile != null) {
        dualOutputBridge = new DualOutputBridge(
          config,
          { filePath: jsonFile },
          { version },
        );
      }
    } catch (err) {
      debugLogger.error('Failed to initialize dual output bridge:', err);
      writeStderrLine(
        `Warning: dual output disabled — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let remoteInputWatcher: RemoteInputWatcher | null = null;
    const inputFile = config.getInputFile?.();
    if (inputFile) {
      try {
        remoteInputWatcher = new RemoteInputWatcher(inputFile);
      } catch (err) {
        debugLogger.error('Failed to initialize remote input watcher:', err);
        writeStderrLine(
          `Warning: remote input disabled — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return new OpenTuiRuntime(
      config,
      version,
      dualOutputBridge,
      remoteInputWatcher,
    );
  }

  /**
   * Writes the runtime.json sidecar next to the chat log so external tools can
   * map the PID back to its session id and working directory, then arms the
   * session-swap refresh in `Config.refreshSessionId()`. Best-effort: a
   * read-only filesystem must never block startup.
   */
  async writeRuntimeSidecar(): Promise<void> {
    try {
      const sessionId = this.config.getSessionId();
      const runtimeStatusPath =
        this.config.storage.getRuntimeStatusPath(sessionId);
      await writeRuntimeStatus(runtimeStatusPath, {
        sessionId,
        workDir: this.config.getTargetDir(),
        qwenVersion: this.version,
      });
      this.config.markRuntimeStatusEnabled();
    } catch {
      // ignored: best-effort, never block startup.
    }
  }

  /**
   * Arms the periodic memory-pressure check. Returns the interval handle (or
   * undefined when no monitor is configured) and is idempotent — a second call
   * returns the already-running timer rather than stacking intervals.
   */
  startPressureMonitor(): NodeJS.Timeout | undefined {
    if (this.pressureCheckTimer) {
      return this.pressureCheckTimer;
    }
    const monitor = this.config.getMemoryPressureMonitor?.();
    if (!monitor) {
      return undefined;
    }
    const timer = setInterval(() => {
      try {
        monitor.performCheck();
      } catch {
        // Best-effort: a failing pressure check must not break the UI loop.
      }
    }, PRESSURE_CHECK_INTERVAL_MS);
    timer.unref?.();
    this.pressureCheckTimer = timer;
    return timer;
  }

  /**
   * Aggregate teardown, ordered to mirror the ink cleanup chain: stop the
   * timer, do a final best-effort reclaim, then shut the watchers down (the
   * dual-output bridge is awaited; the remote input watcher is not).
   */
  async shutdown(): Promise<void> {
    if (this.pressureCheckTimer) {
      clearInterval(this.pressureCheckTimer);
      this.pressureCheckTimer = undefined;
    }
    try {
      this.config.getMemoryPressureMonitor?.()?.performCheck();
    } catch {
      // Best-effort: ignore.
    }
    this.remoteInputWatcher?.shutdown();
    await this.dualOutputBridge?.shutdown();
  }
}
