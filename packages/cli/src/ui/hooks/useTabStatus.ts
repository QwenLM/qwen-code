/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * React hook that emits OSC 21337 tab-status sequences to set the
 * colored indicator dot in cmux's sidebar, based on streaming state.
 *
 * States:
 * - 🟢 Green (idle)   — waiting for user input
 * - 🟠 Orange (busy)  — processing / streaming
 * - 🔵 Blue (waiting) — waiting for user confirmation (tool approval)
 *
 * The indicator is cleared on process exit so the tab doesn't stay
 * colored after qwen terminates.
 */

import { useEffect, useCallback } from 'react';
import { StreamingState } from '../types.js';
import {
  tabStatus,
  CLEAR_TAB_STATUS,
  TAB_COLORS,
  wrapForMultiplexer,
} from '../../utils/osc.js';

type WriteRaw = ((data: string) => void) | null;

export function useTabStatus(
  streamingState: StreamingState,
  writeRaw: WriteRaw,
): void {
  const writeStatus = useCallback(
    (seq: string) => {
      writeRaw?.(wrapForMultiplexer(seq));
    },
    [writeRaw],
  );

  useEffect(() => {
    if (!writeRaw) return;

    switch (streamingState) {
      case StreamingState.Idle:
        writeStatus(tabStatus({ indicator: TAB_COLORS.IDLE, status: 'idle' }));
        break;
      case StreamingState.Responding:
        writeStatus(tabStatus({ indicator: TAB_COLORS.BUSY, status: 'busy' }));
        break;
      case StreamingState.WaitingForConfirmation:
        writeStatus(
          tabStatus({
            indicator: TAB_COLORS.WAITING,
            status: 'waiting',
          }),
        );
        break;
      default:
        break;
    }
  }, [streamingState, writeStatus, writeRaw]);

  // Clear on process exit
  useEffect(() => {
    if (!writeRaw) return;
    const clearOnExit = () => {
      writeRaw(wrapForMultiplexer(CLEAR_TAB_STATUS));
    };
    process.on('exit', clearOnExit);
    return () => {
      process.removeListener('exit', clearOnExit);
    };
  }, [writeRaw]);
}
