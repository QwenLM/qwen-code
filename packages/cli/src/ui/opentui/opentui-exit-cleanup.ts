/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Exit-cleanup registration for the OpenTUI entry (ink parity).
 *
 * The ink branch of `startInteractiveUI` registers a `registerCleanup` that
 * unmounts the tree, restores the terminal and echoes the `qwen --resume
 * <id>` hint to stdout so it survives the alternate-screen teardown. The
 * OpenTUI branch returned early and registered nothing, so every exit path
 * skipped the whole drain. This module registers the OpenTUI equivalents:
 *
 *  1. destroy the renderer (restores the terminal / pops keyboard state);
 *  2. echo the `/quit` farewell + resume hint to stdout so they survive the
 *     renderer teardown (the renderer owns the screen, so anything only
 *     drawn into it is discarded on destroy).
 *
 * Cleanups run in registration order, and `gemini.tsx` registers
 * `config.shutdown()` (chat-recording flush) before the UI starts, so the
 * transcript is flushed by the time the resume hint checks its size — the
 * same ordering guarantee ink relies on.
 */

import { stat } from 'node:fs/promises';
import type { Config } from '@qwen-code/qwen-code-core';
import { uiTelemetryService } from '@qwen-code/qwen-code-core';
import { registerCleanup } from '../../utils/cleanup.js';
import { isValidSessionId } from '../../config/config.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { buildQuitFarewellForConfig } from './quit-farewell.js';

/** Minimal structural type so tests can pass a stub without FFI. */
export interface DestroyableRenderer {
  destroy(): void;
}

export interface OpenTuiExitCleanupOptions {
  renderer: DestroyableRenderer;
  config?: Config;
}

/**
 * Registers the OpenTUI exit cleanups and returns their deregister handles.
 * The farewell echo reads the session start time at exit time so the
 * wall-clock duration is correct even after `/clear`.
 */
export function registerOpenTuiExitCleanup(
  options: OpenTuiExitCleanupOptions,
): Array<() => void> {
  const { renderer, config } = options;

  const destroyRenderer = () => {
    try {
      renderer.destroy();
    } catch {
      // Best-effort: a failing teardown must not block the exit chain.
    }
  };

  const echoFarewell = async () => {
    if (!config) return;
    try {
      const sessionId = config.getSessionId();
      const recording = Boolean(config.getChatRecordingService());
      // Only echo the resume hint when there is actually something to
      // resume: the recorder creates the transcript file before the first
      // record lands, and `--resume` refuses to load an empty one.
      let resumable = false;
      if (recording && isValidSessionId(sessionId)) {
        try {
          const sessionFile = config.getTranscriptPath();
          resumable = (await stat(sessionFile)).size > 0;
        } catch {
          resumable = false;
        }
      }
      const lines = buildQuitFarewellForConfig(
        config,
        resumable,
        uiTelemetryService.getSessionStartTime(),
      );
      if (!lines) return;
      // When there is nothing to resume, drop the trailing resume hint but
      // keep the goodbye + duration.
      writeStdoutLine(`\n${lines.join('\n')}`);
    } catch {
      // Best-effort: the farewell must never block or break exit.
    }
  };

  const handles = [registerCleanup(destroyRenderer)];
  if (config) handles.push(registerCleanup(echoFarewell));
  return handles;
}
