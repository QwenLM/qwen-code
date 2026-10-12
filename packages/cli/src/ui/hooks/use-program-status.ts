/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import { StreamingState } from '../types.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import { OSC, osc, wrapForMultiplexer } from '../../utils/osc.js';

export type ProgramStatusBlockKind = 'permission' | 'question' | 'auth';

export function useProgramStatus(
  streamingState: StreamingState,
  blockedKind: ProgramStatusBlockKind | undefined,
  hasError: boolean,
  cancellationRevision: number,
): void {
  const turnActive = useRef(false);
  const cancelled = useRef(false);
  const previousCancellation = useRef(cancellationRevision);
  const result = useRef<'idle' | 'done' | 'error'>('idle');
  const lastReport = useRef('');

  useEffect(() => {
    if (!process.stdout.isTTY) return;

    if (previousCancellation.current !== cancellationRevision) {
      previousCancellation.current = cancellationRevision;
      cancelled.current = true;
      result.current = 'idle';
    }
    let state: string;
    if (cancelled.current) {
      state = 'idle';
      if (streamingState === StreamingState.Idle) {
        turnActive.current = false;
        cancelled.current = false;
      }
    } else {
      if (streamingState !== StreamingState.Idle) {
        turnActive.current = true;
        result.current = 'idle';
      } else if (turnActive.current) {
        result.current = hasError ? 'error' : 'done';
        turnActive.current = false;
      }
      state = blockedKind
        ? 'blocked'
        : streamingState === StreamingState.Responding
          ? 'working'
          : streamingState === StreamingState.WaitingForConfirmation
            ? 'blocked'
            : result.current;
    }
    const kind =
      state === 'blocked' ? `:kind=${blockedKind ?? 'permission'}` : '';
    const report = wrapForMultiplexer(
      osc(OSC.PROGRAM_STATUS, `state=${state}${kind}:app=qwen-code`),
    );
    if (report !== lastReport.current) {
      // Bypass Ink's rendering pipeline, which can corrupt OSC/DCS bytes.
      process.stdout.write(report);
      lastReport.current = report;
    }
  }, [streamingState, blockedKind, hasError, cancellationRevision]);

  useEffect(() => {
    if (!process.stdout.isTTY) return;
    const clear = () => {
      process.stdout.write(
        wrapForMultiplexer(osc(OSC.PROGRAM_STATUS, 'state=clear')),
      );
    };
    const restore = () => {
      if (lastReport.current) process.stdout.write(lastReport.current);
    };
    appEvents.on(AppEvent.TerminalReleased, clear);
    appEvents.on(AppEvent.TerminalAcquired, restore);
    process.on('SIGCONT', restore);
    process.on('exit', clear);
    return () => {
      appEvents.removeListener(AppEvent.TerminalReleased, clear);
      appEvents.removeListener(AppEvent.TerminalAcquired, restore);
      process.removeListener('SIGCONT', restore);
      process.removeListener('exit', clear);
      clear();
    };
  }, []);
}
