/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useState } from 'react';
import {
  parseQwenAgentMessageMeta,
  QWEN_AGENT_MESSAGE_META_KEY,
  type DaemonTranscriptBlock,
  type SessionAgentRunFrame,
  type SessionAgentRunStatus,
} from '@qwen-code/sdk/daemon';
import type { AgentStreamState } from './agent-events';
import type { SessionAgentsApi } from './session-agents-api';

/**
 * How long a finished run keeps showing its live frame when the transcript has
 * not caught up. The daemon defers an agent's record while a main-model turn
 * is running, so the `agent_message` can land well after the terminal frame;
 * dropping the frame on arrival would make the reply vanish until then.
 * TODO(multi-agent): a main-model turn longer than this still hides a finished
 * reply until its record lands; the frame could carry a "recorded" flag.
 */
export const TERMINAL_FRAME_GRACE_MS = 5 * 60_000;
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
  /** Local clock when the run was first seen terminal. */
  terminalAt?: number;
}

export type RunFrameMap = ReadonlyMap<string, TrackedFrame>;

/**
 * Folds one frame into the map. A frame seen twice (the stream opens with a
 * snapshot that a GET may already have delivered) is harmless; an older frame
 * never overwrites a newer one, and a terminal run never comes back to life.
 */
export function applyRunFrame(
  current: RunFrameMap,
  frame: SessionAgentRunFrame,
  now: number,
  order: number,
): RunFrameMap {
  const existing = current.get(frame.runId);
  if (existing) {
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
  const next = new Map(current);
  next.set(frame.runId, {
    frame,
    order: existing?.order ?? order,
    ...(isTerminalRunStatus(frame.status)
      ? { terminalAt: existing?.terminalAt ?? now }
      : {}),
  });
  return next;
}

/**
 * Drops runs whose reply is already in the transcript, and finished runs past
 * the grace period. Returns `current` when nothing changed.
 */
export function pruneRunFrames(
  current: RunFrameMap,
  settledRunIds: ReadonlySet<string>,
  now: number,
): RunFrameMap {
  let next: Map<string, TrackedFrame> | undefined;
  for (const [runId, tracked] of current) {
    const expired =
      tracked.terminalAt !== undefined &&
      now - tracked.terminalAt >= TERMINAL_FRAME_GRACE_MS;
    if (settledRunIds.has(runId) || expired) {
      next ??= new Map(current);
      next.delete(runId);
    }
  }
  return next ?? current;
}

/**
 * Live agent runs of one chat session: the `runs` snapshot, then the
 * `session-events` stream. A run disappears once its `agent_message` is in
 * the transcript (`settledRunIds`), which is what replaces it on screen.
 */
export function useSessionAgentRuns({
  api,
  sessionId,
  settledRunIds,
}: {
  api: SessionAgentsApi | undefined;
  sessionId: string | undefined;
  settledRunIds: ReadonlySet<string>;
}): { runs: SessionAgentRunFrame[]; anyLive: boolean } {
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
          next = applyRunFrame(next, frame, Date.now(), order++);
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

  // Drop runs the transcript has caught up with, and expire finished ones.
  const frames = state.key === key ? state.frames : undefined;
  useEffect(() => {
    if (!frames || frames.size === 0) return;
    const prune = () =>
      setState((current) => {
        const next = pruneRunFrames(current.frames, settledRunIds, Date.now());
        return next === current.frames ? current : { ...current, frames: next };
      });
    prune();
    const nextExpiry = [...frames.values()].reduce<number | undefined>(
      (soonest, tracked) =>
        tracked.terminalAt === undefined
          ? soonest
          : Math.min(
              soonest ?? Infinity,
              tracked.terminalAt + TERMINAL_FRAME_GRACE_MS,
            ),
      undefined,
    );
    if (nextExpiry === undefined) return;
    const timer = setTimeout(prune, Math.max(0, nextExpiry - Date.now()));
    return () => clearTimeout(timer);
  }, [frames, settledRunIds]);

  return useMemo(() => {
    const runs = frames
      ? [...frames.values()]
          .filter((tracked) => !settledRunIds.has(tracked.frame.runId))
          .sort((a, b) => a.order - b.order)
          .map((tracked) => tracked.frame)
      : [];
    return {
      runs,
      anyLive: runs.some((run) => !isTerminalRunStatus(run.status)),
    };
  }, [frames, settledRunIds]);
}
