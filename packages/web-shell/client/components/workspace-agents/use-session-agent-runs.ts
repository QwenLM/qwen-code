/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  parseQwenAgentMessageMeta,
  QWEN_AGENT_MESSAGE_META_KEY,
  type DaemonTranscriptBlock,
  type SessionAgentRunFrame,
  type SessionAgentRunStatus,
} from '@qwen-code/sdk/daemon';
import type { AgentStreamState } from './agent-events';
import type { SessionAgentsApi } from './session-agents-api';

/** Snapshot polling cadence while the live stream is down. */
const POLL_MS = 5_000;

const TERMINAL: ReadonlySet<SessionAgentRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'offline',
]);

export function isTerminalRunStatus(status: SessionAgentRunStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * The runs whose `agent_message` is already in the transcript, as one string
 * (run ids joined by newlines) so a caller can memoize a Set on it: the blocks
 * change on every streamed delta, the answer almost never.
 */
export function settledAgentRunKey(
  blocks: readonly DaemonTranscriptBlock[],
): string {
  const ids: string[] = [];
  for (const block of blocks) {
    if (block.kind !== 'assistant') continue;
    const meta = (block as { meta?: Record<string, unknown> }).meta;
    const value = meta?.[QWEN_AGENT_MESSAGE_META_KEY];
    if (value === undefined) continue;
    const parsed = parseQwenAgentMessageMeta(value);
    if (parsed?.kind === 'agent_message' && parsed.runId) {
      ids.push(parsed.runId);
    }
  }
  return ids.sort().join('\n');
}

interface TrackedFrame {
  frame: SessionAgentRunFrame;
  /** Arrival order, so the list does not reshuffle as frames update. */
  order: number;
  /**
   * The run is off the screen for good: its record is in the transcript, or
   * none will be written. Kept, slimmed, so that a stale snapshot cannot put
   * the card back.
   */
  settled?: true;
}

export type RunFrameMap = ReadonlyMap<string, TrackedFrame>;

/**
 * Whether a frame ends the run's card (contract `recorded`): a terminal frame
 * keeps it only while `recorded` is `false` (record pending, or the run is
 * retryable). `true` means the record now renders; absent means none will be
 * written (cancelled while queued, dismissed, retried).
 */
export function isSettledRunFrame(frame: SessionAgentRunFrame): boolean {
  return isTerminalRunStatus(frame.status) && frame.recorded !== false;
}

function settledEntry(tracked: TrackedFrame): TrackedFrame {
  const { frame } = tracked;
  return {
    order: tracked.order,
    settled: true,
    frame: {
      type: 'run',
      sessionId: frame.sessionId,
      runId: frame.runId,
      author: frame.author,
      status: frame.status,
      activityAt: frame.activityAt,
    },
  };
}

/**
 * Folds one frame into the map. A frame seen twice (the stream opens with a
 * snapshot that a GET may already have delivered) is harmless; an older frame
 * never overwrites a newer one, a terminal run never comes back to life, and
 * a settled run stays settled (a snapshot polled before the record landed can
 * arrive after the frame that settled it).
 */
export function applyRunFrame(
  current: RunFrameMap,
  frame: SessionAgentRunFrame,
  order: number,
): RunFrameMap {
  const existing = current.get(frame.runId);
  if (existing) {
    if (existing.settled) return current;
    const wasTerminal = isTerminalRunStatus(existing.frame.status);
    if (wasTerminal && !isTerminalRunStatus(frame.status)) return current;
    // A snapshot fetched before a streamed frame can arrive after it.
    if (
      frame.activityAt < existing.frame.activityAt &&
      !isTerminalRunStatus(frame.status)
    ) {
      return current;
    }
  }
  const tracked: TrackedFrame = { frame, order: existing?.order ?? order };
  const next = new Map(current);
  next.set(
    frame.runId,
    isSettledRunFrame(frame) ? settledEntry(tracked) : tracked,
  );
  return next;
}

/**
 * Settles runs whose `agent_message` the transcript already shows (it can
 * land before the frame that says so). Returns `current` when nothing
 * changed.
 */
export function pruneRunFrames(
  current: RunFrameMap,
  settledRunIds: ReadonlySet<string>,
): RunFrameMap {
  let next: Map<string, TrackedFrame> | undefined;
  for (const [runId, tracked] of current) {
    if (tracked.settled || !settledRunIds.has(runId)) continue;
    next ??= new Map(current);
    next.set(runId, settledEntry(tracked));
  }
  return next ?? current;
}

/**
 * Live agent runs of one chat session: the `runs` snapshot, then the
 * `session-events` stream. A run keeps its card, finished or not, until a
 * frame settles it (see {@link isSettledRunFrame}) or its `agent_message`
 * shows up in the transcript (`settledRunIds`), which is what replaces it on
 * screen. A finished run whose record waits behind a main-model turn, or a
 * run a daemon restart cut short, stays until then.
 */
export function useSessionAgentRuns({
  api,
  sessionId,
  settledRunIds,
}: {
  api: SessionAgentsApi | undefined;
  sessionId: string | undefined;
  settledRunIds: ReadonlySet<string>;
}): {
  runs: SessionAgentRunFrame[];
  anyLive: boolean;
  /** Runs a `retryable` run again; rejects when the daemon refuses. */
  retry: (runId: string) => Promise<void>;
} {
  const [state, setState] = useState<{
    key: string | undefined;
    frames: RunFrameMap;
  }>({ key: undefined, frames: new Map() });
  const key = api && sessionId ? sessionId : undefined;

  useEffect(() => {
    setState({ key, frames: new Map() });
    if (!api || !sessionId) return;
    let disposed = false;
    let order = 0;
    const apply = (frames: readonly SessionAgentRunFrame[]) => {
      if (disposed || frames.length === 0) return;
      setState((current) => {
        if (current.key !== sessionId) return current;
        let next = current.frames;
        for (const frame of frames) {
          if (frame.sessionId && frame.sessionId !== sessionId) continue;
          next = applyRunFrame(next, frame, order++);
        }
        return next === current.frames ? current : { ...current, frames: next };
      });
    };
    const loadSnapshot = () => {
      api.listRuns(sessionId).then(
        (result) => apply(result.frames ?? []),
        () => {
          // The stream (or the next poll) retries.
        },
      );
    };
    let poll: ReturnType<typeof setInterval> | undefined;
    const stopPolling = () => {
      if (poll !== undefined) clearInterval(poll);
      poll = undefined;
    };
    loadSnapshot();
    const unsubscribe = api.subscribe(
      sessionId,
      (event) => {
        if (event?.type === 'run') apply([event]);
      },
      (streamState: AgentStreamState) => {
        if (disposed) return;
        if (streamState === 'open') {
          stopPolling();
        } else if (poll === undefined) {
          poll = setInterval(loadSnapshot, POLL_MS);
        }
      },
    );
    return () => {
      disposed = true;
      stopPolling();
      unsubscribe();
    };
  }, [api, sessionId, key]);

  // Settle runs the transcript has caught up with.
  const frames = state.key === key ? state.frames : undefined;
  useEffect(() => {
    if (!frames || frames.size === 0) return;
    setState((current) => {
      const next = pruneRunFrames(current.frames, settledRunIds);
      return next === current.frames ? current : { ...current, frames: next };
    });
  }, [frames, settledRunIds]);

  const retry = useCallback(
    async (runId: string) => {
      if (!api || !sessionId) return;
      await api.retryRun(sessionId, runId);
      // The retry is a new run with its own card; this one is done. The
      // daemon's final frame says so too, but a snapshot polled before it
      // must not bring the card back meanwhile.
      setState((current) => {
        const tracked = current.frames.get(runId);
        if (current.key !== sessionId || !tracked || tracked.settled) {
          return current;
        }
        const next = new Map(current.frames);
        next.set(runId, settledEntry(tracked));
        return { ...current, frames: next };
      });
    },
    [api, sessionId],
  );

  return useMemo(() => {
    const runs = frames
      ? [...frames.values()]
          .filter(
            (tracked) =>
              !tracked.settled && !settledRunIds.has(tracked.frame.runId),
          )
          .sort((a, b) => a.order - b.order)
          .map((tracked) => tracked.frame)
      : [];
    return {
      runs,
      anyLive: runs.some((run) => !isTerminalRunStatus(run.status)),
      retry,
    };
  }, [frames, settledRunIds, retry]);
}
