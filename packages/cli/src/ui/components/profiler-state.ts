/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Profiler state extracted from DebugProfiler.tsx to break a circular dependency:
 *
 *   ink/components/App.tsx → DebugProfiler.tsx → ink (Text)
 *
 * By placing the `profiler` object (which App.tsx needs) in this standalone
 * module that does NOT import from 'ink', the cycle is broken. esbuild no
 * longer needs to emit `await` in the module initializer for DebugProfiler,
 * eliminating a known esbuild TLA codegen bug (non-async arrow with await).
 */

import { FixedDeque } from 'mnemonist';
import { debugState } from '../debug.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import { runLogger } from '@qwen-code/core';

// Frames that render at least this far before or after an action are considered
// idle frames.
const MIN_TIME_FROM_ACTION_TO_BE_IDLE = 500;

export const ACTION_TIMESTAMP_CAPACITY = 2048;
export const FRAME_TIMESTAMP_CAPACITY = 2048;

// Exported for testing purposes.
export const profiler = {
  profilersActive: 0,
  numFrames: 0,
  totalIdleFrames: 0,
  totalFlickerFrames: 0,
  hasLoggedFirstFlicker: false,
  lastFrameStartTime: 0,
  openedDebugConsole: false,
  lastActionTimestamp: 0,

  possiblyIdleFrameTimestamps: new FixedDeque<number>(
    Array,
    FRAME_TIMESTAMP_CAPACITY,
  ),
  actionTimestamps: new FixedDeque<number>(Array, ACTION_TIMESTAMP_CAPACITY),

  reportAction() {
    const now = Date.now();
    if (now - this.lastActionTimestamp > 16) {
      if (this.actionTimestamps.size >= ACTION_TIMESTAMP_CAPACITY) {
        this.actionTimestamps.shift();
      }
      this.actionTimestamps.push(now);
      this.lastActionTimestamp = now;
    }
  },

  reportFrameRendered() {
    if (this.profilersActive === 0) {
      return;
    }
    const now = Date.now();
    this.lastFrameStartTime = now;
    this.numFrames++;
    if (debugState.debugNumAnimatedComponents === 0) {
      if (this.possiblyIdleFrameTimestamps.size >= FRAME_TIMESTAMP_CAPACITY) {
        this.possiblyIdleFrameTimestamps.shift();
      }
      this.possiblyIdleFrameTimestamps.push(now);
    } else {
      // If a spinner is present, consider this an action that both prevents
      // this frame from being idle and also should prevent a follow on frame
      // from being considered idle.
      if (this.actionTimestamps.size >= ACTION_TIMESTAMP_CAPACITY) {
        this.actionTimestamps.shift();
      }
      this.actionTimestamps.push(now);
    }
  },

  checkForIdleFrames() {
    const now = Date.now();
    const judgementCutoff = now - MIN_TIME_FROM_ACTION_TO_BE_IDLE;
    const oneSecondIntervalFromJudgementCutoff = judgementCutoff - 1000;

    let idleInPastSecond = 0;

    while (
      this.possiblyIdleFrameTimestamps.size > 0 &&
      this.possiblyIdleFrameTimestamps.peekFirst()! <= judgementCutoff
    ) {
      const frameTime = this.possiblyIdleFrameTimestamps.shift()!;
      const start = frameTime - MIN_TIME_FROM_ACTION_TO_BE_IDLE;
      const end = frameTime + MIN_TIME_FROM_ACTION_TO_BE_IDLE;

      while (
        this.actionTimestamps.size > 0 &&
        this.actionTimestamps.peekFirst()! < start
      ) {
        this.actionTimestamps.shift();
      }

      const hasAction =
        this.actionTimestamps.size > 0 &&
        this.actionTimestamps.peekFirst()! <= end;

      if (!hasAction) {
        if (frameTime >= oneSecondIntervalFromJudgementCutoff) {
          idleInPastSecond++;
        }
        this.totalIdleFrames++;
      }
    }

    if (idleInPastSecond >= 5) {
      if (this.openedDebugConsole === false) {
        this.openedDebugConsole = true;
        appEvents.emit(AppEvent.OpenDebugConsole);
      }
      runLogger.error(
        `${idleInPastSecond} frames rendered while the app was ` +
          `idle in the past second. This likely indicates severe infinite loop ` +
          `React state management bugs.`,
      );
    }
  },

  registerFlickerHandler(constrainHeight: boolean) {
    const flickerHandler = () => {
      // If we are not constraining the height, we are intentionally
      // overflowing the screen.
      if (!constrainHeight) {
        return;
      }

      this.totalFlickerFrames++;
      this.reportAction();

      if (!this.hasLoggedFirstFlicker) {
        this.hasLoggedFirstFlicker = true;
        runLogger.error(
          'A flicker frame was detected. This will cause UI instability. Type `/profile` for more info.',
        );
      }
    };
    appEvents.on(AppEvent.Flicker, flickerHandler);
    return () => {
      appEvents.off(AppEvent.Flicker, flickerHandler);
    };
  },
};
