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

export function programStatusBlockedKind(input: {
  auth: boolean;
  question: boolean;
  permission: boolean;
  dialog: boolean;
}): ProgramStatusBlockKind | undefined {
  if (input.auth) return 'auth';
  if (input.question) return 'question';
  if (input.permission) return 'permission';
  return input.dialog ? 'question' : undefined;
}

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
  const reportedState = useRef('idle');
  const lastReport = useRef('');
  const lastWritten = useRef('');
  const released = useRef(false);

  useEffect(() => {
    if (!process.stdout.isTTY) return;

    if (previousCancellation.current !== cancellationRevision) {
      previousCancellation.current = cancellationRevision;
      cancelled.current = true;
      result.current = 'idle';
    }
    let state: string;
    if (cancelled.current) {
      state = blockedKind ? 'blocked' : 'idle';
      if (streamingState === StreamingState.Idle) {
        turnActive.current = false;
        cancelled.current = false;
      }
    } else {
      if (streamingState !== StreamingState.Idle) {
        turnActive.current = true;
        result.current = 'idle';
      } else if (
        turnActive.current ||
        (hasError && result.current === 'done')
      ) {
        result.current = hasError ? 'error' : 'done';
        turnActive.current = false;
      }
      state = blockedKind
        ? 'blocked'
        : streamingState === StreamingState.Responding
          ? 'working'
          : result.current;
    }
    const kind = state === 'blocked' ? `:kind=${blockedKind}` : '';
    const report = wrapForMultiplexer(
      osc(OSC.PROGRAM_STATUS, `state=${state}${kind}:app=qwen-code`),
    );
    reportedState.current = state;
    lastReport.current = report;
    if (!released.current && report !== lastWritten.current) {
      // Bypass Ink's rendering pipeline, which can corrupt OSC/DCS bytes.
      process.stdout.write(report);
      lastWritten.current = report;
    }
  }, [streamingState, blockedKind, hasError, cancellationRevision]);

  useEffect(() => {
    if (!process.stdout.isTTY) return;
    const clear = () => {
      const sequence = wrapForMultiplexer(
        osc(OSC.PROGRAM_STATUS, 'state=clear'),
      );
      process.stdout.write(sequence);
      lastWritten.current = sequence;
    };
    const clearUnlessResult = () => {
      if (
        reportedState.current !== 'done' &&
        reportedState.current !== 'error'
      ) {
        clear();
      }
    };
    const restore = () => {
      if (!released.current && lastReport.current) {
        process.stdout.write(lastReport.current);
        lastWritten.current = lastReport.current;
      }
    };
    const release = () => {
      released.current = true;
      clear();
    };
    const acquire = () => {
      released.current = false;
      restore();
    };
    appEvents.on(AppEvent.TerminalReleased, release);
    appEvents.on(AppEvent.TerminalAcquired, acquire);
    process.on('SIGCONT', restore);
    process.on('exit', clearUnlessResult);
    return () => {
      appEvents.removeListener(AppEvent.TerminalReleased, release);
      appEvents.removeListener(AppEvent.TerminalAcquired, acquire);
      process.removeListener('SIGCONT', restore);
      process.removeListener('exit', clearUnlessResult);
      clearUnlessResult();
    };
  }, []);
}
