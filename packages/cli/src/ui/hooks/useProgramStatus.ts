/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Writes OSC 7501 program status reports for this session.
 *
 * Keeps the last sequence sent per record and writes only what changed, so a
 * render that does not move the state writes nothing. Records that disappear
 * are cleared by id; unmount clears everything. After SIGCONT the cache is
 * dropped and every record is sent again, since the terminal may have
 * discarded them while the process was stopped.
 */

import { useEffect, useReducer, useRef, useSyncExternalStore } from 'react';
import { useStdout } from 'ink';
import {
  hasReportedProgramStatus,
  isProgramStatusEnabled,
  markProgramStatusReported,
  subscribeProgramStatus,
} from '../../ink/program-status.js';
import {
  CLEAR_PROGRAM_STATUS,
  clearProgramStatusRecord,
  type ProgramStatus,
} from '../../ink/termio/programStatus.js';
import {
  encodeProgramStatusRecords,
  ROOT_RECORD_KEY,
} from '../utils/programStatus.js';
import { StreamingState } from '../types.js';
import type { TurnEnd } from './localSession.shared.js';

/**
 * Computes the bytes to write to move the terminal from `sent` to `wanted`,
 * updating `sent` in place. Returns '' when nothing changed.
 */
export function diffProgramStatusRecords(
  sent: Map<string, string>,
  wanted: ReadonlyMap<string, string>,
): string {
  let out = '';
  for (const [key, seq] of wanted) {
    if (sent.get(key) === seq) continue;
    sent.set(key, seq);
    out += seq;
  }
  for (const key of [...sent.keys()]) {
    if (wanted.has(key)) continue;
    sent.delete(key);
    if (key !== ROOT_RECORD_KEY) out += clearProgramStatusRecord(key);
  }
  return out;
}

function serialize(records: ReadonlyMap<string, string>): string {
  return [...records].map(([key, seq]) => `${key}\t${seq}`).join('\n');
}

function deserialize(serialized: string): Map<string, string> {
  return new Map(
    serialized.split('\n').map((line) => {
      const tab = line.indexOf('\t');
      return [line.slice(0, tab), line.slice(tab + 1)] as [string, string];
    }),
  );
}

export function useProgramStatus(
  main: ProgramStatus,
  subagents: ReadonlyArray<ProgramStatus & { id: string }>,
): void {
  const { stdout } = useStdout();
  const enabled = useSyncExternalStore(
    subscribeProgramStatus,
    () => isProgramStatusEnabled(),
    () => false,
  );
  const sentRef = useRef(new Map<string, string>());
  const [epoch, bumpEpoch] = useReducer((n: number) => n + 1, 0);

  // A string dependency keeps the effect quiet across renders that rebuild
  // equal status objects.
  const wanted = serialize(encodeProgramStatusRecords(main, subagents));

  useEffect(() => {
    const onContinue = () => {
      sentRef.current.clear();
      bumpEpoch();
    };
    process.on('SIGCONT', onContinue);
    return () => {
      process.off('SIGCONT', onContinue);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const out = diffProgramStatusRecords(sentRef.current, deserialize(wanted));
    if (out === '') return;
    stdout.write(out);
    markProgramStatusReported(true);
  }, [enabled, wanted, epoch, stdout]);

  useEffect(
    () => () => {
      const hadRecords = sentRef.current.size > 0;
      sentRef.current.clear();
      // Ink's exit cleanup clears synchronously before React unmounts; only
      // clear here when that has not happened (e.g. the hook unmounts alone).
      if (!hadRecords || !hasReportedProgramStatus()) return;
      stdout.write(CLEAR_PROGRAM_STATUS);
      markProgramStatusReported(false);
    },
    [stdout],
  );
}

/**
 * Turn outcome for a session this TUI only observes (a bound remote or worker
 * session). Its error outcome is not visible here, so a turn that settles back
 * to idle counts as completed.
 */
export function useObservedTurnEnd(
  streamingState: StreamingState,
  observing: boolean,
): TurnEnd {
  const previousRef = useRef(streamingState);
  const [turnEnd, settle] = useReducer(
    (_state: TurnEnd, next: TurnEnd) => next,
    null,
  );
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = streamingState;
    if (
      observing &&
      previous !== StreamingState.Idle &&
      streamingState === StreamingState.Idle
    ) {
      settle('completed');
    }
  }, [observing, streamingState]);
  return turnEnd;
}
